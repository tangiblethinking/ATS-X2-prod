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

// NOTE: Full modular implementation with single-purpose steps is being applied.
// The human English pass is the critical new step.

export const grammarAndNaturalEnglish = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: resumeSchema }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey,
      json: true,
      maxTokens: 8192,
      temperature: 0.3,
      user: `HUMAN R\u00c9SUM\u00c9 ENGLISH PASS ONLY.\n\nYou are rewriting r\u00e9sum\u00e9 bullets so they sound like a real person wrote them.\n\nInput:\n${data.html}\n\nRules (do only this):\n- Rewrite every bullet into short, plain English that a person would actually say or write on a r\u00e9sum\u00e9.\n- Prefer simple sentences. One idea per bullet when possible.\n- Remove template language.\n- Bad: \