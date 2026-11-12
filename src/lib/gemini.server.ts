type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatMeta = {
  model: string;
  finishReason?: string;
  inputChars: number;
  outputChars: number;
};

export type ChatResult =
  | { ok: true; text: string; meta: ChatMeta }
  | { ok: false; error: string; status?: number; meta?: Partial<ChatMeta> };

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const MODEL_CACHE: { models: string[]; expires: number; keyHash: string } = { models: [], expires: 0, keyHash: "" };
const CALL_TIMESTAMPS: number[] = [];
const BAD_MODELS = new Set<string>();
const SAFE_RPM = 8;

function hashKey(key: string): string {
  return key.slice(-8);
}

export async function discoverAvailableModels(apiKey: string): Promise<{ ok: true; models: string[]; primary: string } | { ok: false; error: string }> {
  const now = Date.now();
  const keyHash = hashKey(apiKey);
  if (MODEL_CACHE.models.length && MODEL_CACHE.expires > now && MODEL_CACHE.keyHash === keyHash) {
    return { ok: true, models: MODEL_CACHE.models, primary: MODEL_CACHE.models[0] };
  }

  const url = `${GEMINI_BASE}/models?pageSize=100`;
  try {
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    if (!res.ok) return { ok: false, error: statusError(res.status) };
    const data = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const raw = data.models ?? [];
    const usable = raw
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((id) => {
        const lower = id.toLowerCase();
        if (!lower.includes("flash")) return false;
        if (lower.includes("image") || lower.includes("tts") || lower.includes("live") || lower.includes("omni") || lower.includes("pro") || lower.includes("carbon") || lower.includes("argon")) return false;
        return true;
      })
      .sort((a, b) => {
        const aLite = a.includes("flash-lite") ? 0 : 1;
        const bLite = b.includes("flash-lite") ? 0 : 1;
        return aLite - bLite || a.localeCompare(b);
      });

    const models = usable.length ? usable : EMERGENCY_MODELS;
    MODEL_CACHE.models = models;
    MODEL_CACHE.expires = now + 10 * 60 * 1000;
    MODEL_CACHE.keyHash = keyHash;
    BAD_MODELS.clear();
    return { ok: true, models, primary: models[0] };
  } catch {
    return { ok: false, error: "Could not list available models. Using emergency list." };
  }
}

async function paceForRateLimit(): Promise<void> {
  const now = Date.now();
  const oneMinAgo = now - 60_000;
  while (CALL_TIMESTAMPS.length && CALL_TIMESTAMPS[0] < oneMinAgo) CALL_TIMESTAMPS.shift();
  if (CALL_TIMESTAMPS.length >= SAFE_RPM) {
    const wait = Math.max(0, CALL_TIMESTAMPS[0] + 60_000 - now + 800);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  CALL_TIMESTAMPS.push(Date.now());
}

function getUsableModels(): string[] {
  const list = MODEL_CACHE.models.length ? MODEL_CACHE.models : EMERGENCY_MODELS;
  return list.filter((m) => !BAD_MODELS.has(m));
}

function markModelBad(model: string) {
  BAD_MODELS.add(model);
}

/**
 * Models are discovered dynamically via List Models at pipeline start.
 * Preference: Flash-Lite (higher free RPM) then Flash. Emergency fallback used if discovery fails.
 * See discoverAvailableModels().
 */
const EMERGENCY_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];

function statusError(status: number): string {
  if (status === 400) {
    return "The request was rejected. Check the API key and try again.";
  }
  if (status === 401 || status === 403) {
    return "The Google API key was rejected. Create a free key at aistudio.google.com/apikey.";
  }
  if (status === 404) {
    return "That Gemini model is not available on this key. Try another free Flash model or create a new key.";
  }
  if (status === 429) {
    return "Google free-tier rate limit hit. Wait a minute and run again (Flash-Lite has higher free RPM).";
  }
  if (status >= 500) {
    return "The Gemini service is unavailable. Try again shortly.";
  }
  return `The API returned an error (${status}).`;
}

async function parseGenerateBody(res: Response): Promise<{ text: string; finishReason?: string }> {
  const body = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      finishReason?: string;
    }[];
    error?: { message?: string; status?: string };
  };

  if (body.error?.message) {
    throw new Error(body.error.message);
  }

  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

  const finishReason = body.candidates?.[0]?.finishReason;

  if (!text) {
    throw new Error(
      finishReason
        ? `The model returned an empty response (${finishReason}).`
        : "The model returned an empty response.",
    );
  }
  return { text, finishReason };
}

function buildPayload(opts: {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  json?: boolean;
  urlContext?: boolean;
  images?: { mimeType: string; data: string }[];
}): Record<string, unknown> {
  const systemParts = opts.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter(Boolean);
  const contents = opts.messages
    .filter((m) => m.role !== "system")
    .map((m, idx, arr) => {
      const parts: Record<string, unknown>[] = [{ text: m.content }];
      const isLastUser = m.role === "user" && idx === arr.length - 1;
      if (isLastUser && opts.images?.length) {
        for (const img of opts.images) {
          parts.push({
            inline_data: { mime_type: img.mimeType, data: img.data },
          });
        }
      }
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts,
      };
    });

  const payload: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: opts.maxTokens,
      temperature: opts.temperature,
      ...(opts.json
        ? { responseMimeType: "application/json" as const }
        : {}),
    },
  };

  if (systemParts.length > 0) {
    payload.systemInstruction = {
      parts: systemParts.map((text) => ({ text })),
    };
  }

  if (opts.urlContext) {
    payload.tools = [{ url_context: {} }];
  }

  return payload;
}

function estimateInputChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
}

export async function geminiChat(opts: {
  apiKey: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  json?: boolean;
  urlContext?: boolean;
  images?: { mimeType: string; data: string }[];
}): Promise<ChatResult> {
  const payload = buildPayload(opts);
  const inputChars = estimateInputChars(opts.messages);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": opts.apiKey,
  };

  await paceForRateLimit();
  const models = getUsableModels();
  if (!models.length) {
    return { ok: false, error: "No usable free-tier models available right now. Try again in a minute." };
  }

  let lastError = "Could not reach the model service.";
  let lastStatus: number | undefined;

  for (const model of models) {
    const url = `${GEMINI_BASE}/models/${model}:generateContent`;
    let res: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        lastError = "The model took too long to respond. Try again.";
        continue;
      }
      lastError = "Could not reach the model service.";
      continue;
    }

    // Retry with backoff on 5xx or 429 (free-tier overload / rate limit)
    const retryable = !res.ok && (res.status >= 500 || res.status === 429);
    if (retryable) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        try {
          res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
          if (res.ok) break;
          if (res.status < 500 && res.status !== 429) break;
        } catch {
          lastError = "Could not reach the model service.";
        }
      }
    }

    clearTimeout(timeoutId);
    if (res.ok) {
      try {
        const { text, finishReason } = await parseGenerateBody(res);
        return {
          ok: true,
          text,
          meta: {
            model,
            finishReason,
            inputChars,
            outputChars: text.length,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "The model response could not be read.",
          meta: { model, inputChars, outputChars: 0 },
        };
      }
    }

    lastStatus = res.status;
    lastError = statusError(res.status);

    // Auth failures are not model-specific — stop trying
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: lastError, status: res.status, meta: { model, inputChars, outputChars: 0 } };
    }

    // Mark model bad and try next on 404/400/429/5xx
    if (res.status === 404 || res.status === 400 || res.status === 429 || res.status >= 500) {
      markModelBad(model);
      continue;
    }

    return { ok: false, error: lastError, status: res.status, meta: { model, inputChars, outputChars: 0 } };
  }

  return { ok: false, error: lastError, status: lastStatus };
}

/**
 * Multimodal chat: text + optional PDF (base64) for document understanding.
 */
export async function geminiChatWithPdf(opts: {
  apiKey: string;
  system: string;
  userText: string;
  pdfBase64: string;
  maxTokens: number;
  temperature: number;
}): Promise<ChatResult> {
  const payload: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: opts.system }],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: "application/pdf",
              data: opts.pdfBase64,
            },
          },
          { text: opts.userText },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: opts.maxTokens,
      temperature: opts.temperature,
    },
  };

  const inputChars = (opts.system?.length ?? 0) + (opts.userText?.length ?? 0);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": opts.apiKey,
  };

  await paceForRateLimit();
  const models = getUsableModels();
  if (!models.length) {
    return { ok: false, error: "No usable free-tier models available right now. Try again in a minute." };
  }

  let lastError = "Could not reach the model service.";
  let lastStatus: number | undefined;

  for (const model of models) {
    const url = `${GEMINI_BASE}/models/${model}:generateContent`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch {
      lastError = "Could not reach the model service.";
      continue;
    }

    if (!res.ok && res.status >= 500) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
      } catch {
        lastError = "Could not reach the model service.";
        continue;
      }
    }

    if (res.ok) {
      try {
        const { text, finishReason } = await parseGenerateBody(res);
        return {
          ok: true,
          text,
          meta: {
            model,
            finishReason,
            inputChars,
            outputChars: text.length,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "The model response could not be read.",
          meta: { model, inputChars, outputChars: 0 },
        };
      }
    }

    lastStatus = res.status;
    lastError = statusError(res.status);

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: lastError, status: res.status, meta: { model, inputChars, outputChars: 0 } };
    }

    if (res.status === 404 || res.status === 400 || res.status === 429 || res.status >= 500) {
      markModelBad(model);
      continue;
    }

    return { ok: false, error: lastError, status: res.status, meta: { model, inputChars, outputChars: 0 } };
  }

  return { ok: false, error: lastError, status: lastStatus };
}

export async function verifyGeminiKey(apiKey: string): Promise<ChatResult> {
  // List models is the lightest way to validate a Google AI Studio key
  const url = `${GEMINI_BASE}/models?pageSize=5`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-goog-api-key": apiKey },
    });
  } catch {
    return { ok: false, error: "Could not reach the model service." };
  }
  if (!res.ok) {
    return { ok: false, error: statusError(res.status), status: res.status };
  }
  return { ok: true, text: "ok", meta: { model: "list", inputChars: 0, outputChars: 2 } };
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(fenced);
}

export function formatChatLog(label: string, result: ChatResult, extra?: string): string {
  if (!result.ok) {
    const m = result.meta;
    return `[${label}] FAIL model=${m?.model ?? "?"} finish=${m?.finishReason ?? "-"} in=${m?.inputChars ?? "?"} out=${m?.outputChars ?? 0} err=${result.error}${extra ? " | " + extra : ""}`;
  }
  const m = result.meta;
  return `[${label}] OK model=${m.model} finish=${m.finishReason ?? "-"} in=${m.inputChars} out=${m.outputChars}${extra ? " | " + extra : ""}`;
}
