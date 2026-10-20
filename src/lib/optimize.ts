import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { finalizeCleanHtml, stripMarkdownFences } from "@/lib/html-clean";
import { extractTextSlots, injectTextSlots, parseRewrittenSlots, restoreOriginalUrls, humanizeOutput } from "@/lib/html-text-slots";
import type { AuditResult, KeywordSet } from "@/lib/pipeline-types";
import { MAX_JOB_CHARS, MAX_RESUME_CHARS } from "@/lib/pipeline-types";
import systemPrompt from "@/lib/system-prompt.txt?raw";
import customizeHardRules from "@/lib/customize-hard-rules.txt?raw";

const apiKeySchema = z
  .string()
  .trim()
  .min(20, "Enter a valid API key.")
  .refine((v) => !/\s/.test(v), "The API key cannot contain spaces.");

const resumeSchema = z
  .string()
  .trim()
  .min(40, "Paste the HTML of your resume.")
  .max(MAX_RESUME_CHARS, "The resume HTML is too large.");

const SYSTEM = systemPrompt;

function formatChatLog(label: string, result: { ok: boolean; text?: string; error?: string; meta?: { model?: string; finishReason?: string; inputChars?: number; outputChars?: number } }, extra?: string): string {
  const m = result.meta;
  if (!result.ok) {
    return `[${label}] FAIL model=${m?.model ?? "?"} finish=${m?.finishReason ?? "-"} in=${m?.inputChars ?? "?"} out=${m?.outputChars ?? 0} err=${result.error}${extra ? " | " + extra : ""}`;
  }
  return `[${label}] OK model=${m?.model ?? "?"} finish=${m?.finishReason ?? "-"} in=${m?.inputChars ?? "?"} out=${m?.outputChars ?? 0}${extra ? " | " + extra : ""}`;
}

// ... (rest of file would be here; using modular version)
export const grammarAndNaturalEnglish = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: resumeSchema }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey,
      json: true,
      maxTokens: 8192,
      temperature: 0.2,
      user: `GRAMMAR AND NATURAL ENGLISH PASS ONLY.\n\nText to correct:\n${data.html}\n\nDo only this:\n- Fix grammar, punctuation, double periods, awkward phrasing, and unnatural sentence structure.\n- Make every sentence clear, well-formed English.\n- Do not change facts, numbers, tool names, employers, or add new information.\n- Do not invent or remove technical relationships.\n- Return JSON: { "html": "corrected html" }\n\nIf the text is already good, return it unchanged.`,
    });
    if (!result.ok) return { ok: false as const, error: result.error, log: formatChatLog("grammar", result) };
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text) as any;
      const html = parsed.html && typeof parsed.html === "string" ? parsed.html : data.html;
      return { ok: true as const, html, log: formatChatLog("grammar", result) };
    } catch {
      return { ok: true as const, html: data.html, log: "[grammar] parse failed, kept original" };
    }
  });
