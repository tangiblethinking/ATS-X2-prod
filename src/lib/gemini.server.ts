type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatResult =
  | { ok: true; text: string }
  | { ok: false; error: string; status?: number };

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Free-tier-friendly Flash / Flash-Lite models (Google AI Studio).
 * Tried in order until one succeeds (404 / not-found / quota → next).
 * Prefer Flash-Lite first for higher free RPM, then full Flash.
 */
const FREE_TIER_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash",
] as const;

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
    return "Google free-tier rate limit hit. Wait a minute and run again (Flash-Lite has higher free RPM)."
  }
  if (status >= 500) {
    return "The Gemini service is unavailable. Try again shortly.";
  }
  return `The API returned an error (${status}).`;
}

async function parseGenerateBody(res: Response): Promise<string> {
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

  if (!text) {
    const reason = body.candidates?.[0]?.finishReason;
    throw new Error(
      reason
        ? `The model returned an empty response (${reason}).`
        : "The model returned an empty response.",
    );
  }
  return text;
}

function buildPayload(opts: {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  json?: boolean;
}): Record<string, unknown> {
  const systemParts = opts.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter(Boolean);
  const contents = opts.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

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

  return payload;
}

export async function geminiChat(opts: {
  apiKey: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  json?: boolean;
}): Promise<ChatResult> {
  const payload = buildPayload(opts);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": opts.apiKey,
  };

  let lastError = "Could not reach the model service.";
  let lastStatus: number | undefined;

  for (const model of FREE_TIER_MODELS) {
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

    if (res.ok) {
      try {
        const text = await parseGenerateBody(res);
        return { ok: true, text };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "The model response could not be read.",
        };
      }
    }

    lastStatus = res.status;
    lastError = statusError(res.status);

    // Auth failures are not model-specific — stop trying
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: lastError, status: res.status };
    }

    // 404 / 400 (model unavailable) or 429 (quota on this model) → try next free model
    if (res.status === 404 || res.status === 400 || res.status === 429) {
      continue;
    }

    return { ok: false, error: lastError, status: res.status };
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

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": opts.apiKey,
  };

  let lastError = "Could not reach the model service.";
  let lastStatus: number | undefined;

  for (const model of FREE_TIER_MODELS) {
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
        const text = await parseGenerateBody(res);
        return { ok: true, text };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "The model response could not be read.",
        };
      }
    }

    lastStatus = res.status;
    lastError = statusError(res.status);

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: lastError, status: res.status };
    }

    if (res.status === 404 || res.status === 400 || res.status === 429) {
      continue;
    }

    return { ok: false, error: lastError, status: res.status };
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
  return { ok: true, text: "ok" };
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(fenced);
}
