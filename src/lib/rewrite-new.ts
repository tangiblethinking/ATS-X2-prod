/**
 * New, independent Rewrite function for the Rewrite button.
 *
 * Sends TierNull's saved prompt (src/lib/rewrite-prompt.txt) plus the current
 * resume HTML to Gemini in ONE call, and nothing else: no shared system prompt,
 * no JSON mode, no keyword lists, no post-processing. The final HTML block is
 * returned exactly as the model wrote it so bolding is preserved.
 *
 * It has its own fetch helper (same endpoint and model order as geminiChat in
 * gemini.server.ts, which is not modified) so it can use a longer per-attempt
 * timeout and the model's full output limit, while capping total time under
 * Vercel's 300 s default function duration.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { MAX_RESUME_CHARS } from "@/lib/pipeline-types";
import rewritePrompt from "@/lib/rewrite-prompt.txt?raw";
import { buildRewriteMessage, extractRewriteOutput } from "@/lib/rewrite-new-extract";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Same models, same order as FREE_TIER_MODELS in gemini.server.ts. */
const REWRITE_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash",
] as const;

/** Output token limit for gemini-3.5-flash-lite (ai.google.dev model page: 65,536). */
export const REWRITE_MAX_OUTPUT_TOKENS = 65536;
/** Per-attempt timeout. */
export const REWRITE_ATTEMPT_TIMEOUT_MS = 240_000;
/** Total budget across all attempts; stays under Vercel's 300 s default. */
export const REWRITE_TOTAL_BUDGET_MS = 270_000;
/** Do not start an attempt with less time than this left. */
const MIN_ATTEMPT_MS = 5_000;

type RewriteCallResult =
  | { ok: true; text: string; model: string; finishReason?: string }
  | { ok: false; error: string; status?: number; model?: string };

function statusError(status: number): string {
  if (status === 400) return "The request was rejected. Check the API key and try again.";
  if (status === 401 || status === 403) return "The Google API key was rejected. Create a free key at aistudio.google.com/apikey.";
  if (status === 404) return "That Gemini model is not available on this key.";
  if (status === 429) return "Google free-tier rate limit hit. Wait a minute and try Rewrite again.";
  if (status >= 500) return "The Gemini service is unavailable. Try again shortly.";
  return `The API returned an error (${status}).`;
}

async function readText(res: Response): Promise<{ text: string; finishReason?: string }> {
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    error?: { message?: string };
  };
  if (body.error?.message) throw new Error(body.error.message);
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => !p.thought).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  const finishReason = body.candidates?.[0]?.finishReason;
  if (!text.trim()) {
    throw new Error(finishReason ? `The model returned an empty response (${finishReason}).` : "The model returned an empty response.");
  }
  return { text, finishReason };
}

/**
 * One prompt, one user message, model fallback in geminiChat's order.
 * Exported with injectable fetch/clock for tests.
 */
export async function callRewriteModel(opts: {
  apiKey: string;
  userText: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  attemptTimeoutMs?: number;
  totalBudgetMs?: number;
}): Promise<RewriteCallResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const attemptTimeout = opts.attemptTimeoutMs ?? REWRITE_ATTEMPT_TIMEOUT_MS;
  const deadline = now() + (opts.totalBudgetMs ?? REWRITE_TOTAL_BUDGET_MS);
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: opts.userText }] }],
    generationConfig: { maxOutputTokens: REWRITE_MAX_OUTPUT_TOKENS },
  });
  const headers = { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey };

  let lastError = "Could not reach the model service.";
  let lastStatus: number | undefined;

  const attempt = async (url: string): Promise<Response | "timeout" | "network" | "budget"> => {
    const remaining = deadline - now();
    if (remaining < MIN_ATTEMPT_MS) return "budget";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(attemptTimeout, remaining));
    try {
      return await doFetch(url, { method: "POST", headers, body, signal: controller.signal });
    } catch (err) {
      return err instanceof Error && err.name === "AbortError" ? "timeout" : "network";
    } finally {
      clearTimeout(timer);
    }
  };

  for (const model of REWRITE_MODELS) {
    const url = `${GEMINI_BASE}/models/${model}:generateContent`;
    let res = await attempt(url);
    if (res === "budget") break;
    if (res === "timeout") { lastError = "The model took too long to respond. Try again."; continue; }
    if (res === "network") { lastError = "Could not reach the model service."; continue; }

    // Same backoff as geminiChat on 5xx / 429, within the time budget.
    if (!res.ok && (res.status >= 500 || res.status === 429)) {
      for (let i = 1; i <= 2; i++) {
        if (deadline - now() < 1200 * i + MIN_ATTEMPT_MS) break;
        await new Promise((r) => setTimeout(r, 1200 * i));
        const retry = await attempt(url);
        if (typeof retry === "string") break;
        res = retry;
        if (res.ok || (res.status < 500 && res.status !== 429)) break;
      }
    }

    if (res.ok) {
      try {
        const { text, finishReason } = await readText(res);
        return { ok: true, text, model, finishReason };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "The model response could not be read.", model };
      }
    }

    lastStatus = res.status;
    lastError = statusError(res.status);
    if (res.status === 401 || res.status === 403) return { ok: false, error: lastError, status: res.status, model };
    if (res.status === 404 || res.status === 400 || res.status === 429) continue;
    return { ok: false, error: lastError, status: res.status, model };
  }

  if (deadline - now() < MIN_ATTEMPT_MS) {
    return { ok: false, error: "Rewrite ran out of time (about 4.5 minutes) before a model finished. Try again.", status: lastStatus };
  }
  return { ok: false, error: lastError, status: lastStatus };
}

/** Prompt + HTML in, HTML (unaltered) + scores/recommendations text out. */
export async function runNewRewrite(
  apiKey: string,
  resumeHtml: string,
  deps?: { fetchImpl?: typeof fetch; now?: () => number; prompt?: string },
) {
  const userText = buildRewriteMessage(deps?.prompt ?? rewritePrompt, resumeHtml);
  const result = await callRewriteModel({ apiKey, userText, fetchImpl: deps?.fetchImpl, now: deps?.now });
  if (!result.ok) {
    return { ok: false as const, error: result.error, log: `[rewriteNew] FAIL model=${result.model ?? "?"} err=${result.error}` };
  }
  if (result.finishReason === "MAX_TOKENS") {
    return {
      ok: false as const,
      error: "The model hit its output limit before finishing the HTML. Nothing was changed.",
      log: `[rewriteNew] FAIL model=${result.model} finish=MAX_TOKENS out=${result.text.length}`,
    };
  }
  const extracted = extractRewriteOutput(result.text);
  if (!extracted.ok) {
    return { ok: false as const, error: extracted.error, log: `[rewriteNew] FAIL model=${result.model} finish=${result.finishReason ?? "-"} err=${extracted.error}` };
  }
  return {
    ok: true as const,
    html: extracted.html,
    report: extracted.report,
    log: `[rewriteNew] OK model=${result.model} finish=${result.finishReason ?? "-"} in=${userText.length} out=${result.text.length} html=${extracted.html.length}`,
  };
}

export const rewriteNew = createServerFn({ method: "POST" })
  .validator(z.object({
    apiKey: z.string().trim().min(20, "Enter a valid API key.").refine((v) => !/\s/.test(v), "The API key cannot contain spaces."),
    resumeHtml: z.string().trim().min(40, "There is no HTML to rewrite.").max(MAX_RESUME_CHARS, "The resume HTML is too large."),
  }))
  .handler(async ({ data }) => runNewRewrite(data.apiKey, data.resumeHtml));
