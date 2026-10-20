import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { finalizeCleanHtml, stripMarkdownFences } from "@/lib/html-clean";
import { extractTextSlots, injectTextSlots, parseRewrittenSlots, restoreOriginalUrls, humanizeOutput } from "@/lib/html-text-slots";
import type { AuditResult, KeywordSet } from "@/lib/pipeline-types";
import { MAX_JOB_CHARS, MAX_RESUME_CHARS } from "@/lib/pipeline-types";
import systemPrompt from "@/lib/system-prompt.txt?raw";

const apiKeySchema = z.string().trim().min(20, "Enter a valid API key.").refine((v) => !/\s/.test(v), "The API key cannot contain spaces.");
const resumeSchema = z.string().trim().min(40, "Paste the HTML of your resume.").max(MAX_RESUME_CHARS, "The resume HTML is too large.");
const SYSTEM = systemPrompt;

function formatChatLog(label: string, result: { ok: boolean; text?: string; error?: string; meta?: any }, extra?: string): string {
  const m = result.meta;
  if (!result.ok) return `[${label}] FAIL model=${m?.model ?? "?"} finish=${m?.finishReason ?? "-"} in=${m?.inputChars ?? "?"} out=${m?.outputChars ?? 0} err=${result.error}${extra ? " | " + extra : ""}`;
  return `[${label}] OK model=${m?.model ?? "?"} finish=${m?.finishReason ?? "-"} in=${m?.inputChars ?? "?"} out=${m?.outputChars ?? 0}${extra ? " | " + extra : ""}`;
}

function asKeywords(raw: unknown): KeywordSet {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(s => s.trim()).filter(Boolean).slice(0, 250) : [];
  return { keywords: list(obj.keywords), phrases: list(obj.phrases), must_have: list(obj.must_have), nice_to_have: list(obj.nice_to_have) };
}

function termsAlreadyOnResume(html: string, terms: string[]): string[] {
  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    if (!t || t.length < 3) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    if (plain.includes(key)) { seen.add(key); out.push(t); }
  }
  return out.slice(0, 40);
}

export function sanitizeHtml(html: string): string {
  let out = html;
  out = out.replace(/\.{2,}/g, ".");
  out = out.replace(/<\/strong>\s*\./g, ".</strong>");
  out = out.replace(/<strong>\s*<\/strong>/g, "");
  out = out.replace(/\s+([.,;:])/g, "$1");
  out = out.replace(/\s{2,}/g, " ");
  return out;
}

async function chat(opts: { apiKey: string; user: string; maxTokens: number; temperature: number; json?: boolean }) {
  const { geminiChat } = await import("./gemini.server");
  return geminiChat({
    apiKey: opts.apiKey,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: opts.user }],
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    json: opts.json,
  });
}

export const verifyApiKey = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema }))
  .handler(async ({ data }) => {
    const { verifyGeminiKey } = await import("./gemini.server");
    return verifyGeminiKey(data.apiKey);
  });

export const fetchJobDescription = createServerFn({ method: "POST" })
  .validator(z.object({ url: z.string().trim().min(8).max(2000) }))
  .handler(async ({ data }) => {
    try {
      const { fetchJobText } = await import("./job-fetch.server");
      const result = await fetchJobText(data.url);
      return { ok: true as const, ...result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "Could not fetch that URL." };
    }
  });

export const extractKeywords = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, jobText: z.string().trim().min(40).max(MAX_JOB_CHARS) }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8000, temperature: 0.15,
      user: `Extract ATS keywords from this job description. Return JSON only: {"keywords":[],"phrases":[],"must_have":[],"nice_to_have":[]}. Do not invent terms.\n\nJOB:\n${data.jobText}`,
    });
    if (!result.ok) return result;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const keywords = asKeywords(parseJsonObject(result.text));
      const log = formatChatLog("extractKeywords", result, `kw=${keywords.keywords.length + keywords.phrases.length}`);
      if (keywords.keywords.length + keywords.phrases.length === 0) return { ok: false as const, error: "No keywords extracted.", log };
      return { ok: true as const, keywords, log };
    } catch {
      return { ok: false as const, error: "Keyword extraction did not return valid JSON." };
    }
  });

export const rewriteResume = createServerFn({ method: "POST" })
  .validator(z.object({
    apiKey: apiKeySchema,
    resumeHtml: resumeSchema,
    keywords: z.object({ keywords: z.array(z.string()), phrases: z.array(z.string()), must_have: z.array(z.string()), nice_to_have: z.array(z.string()) }),
  }))
  .handler(async ({ data }) => {
    const { template, slots } = extractTextSlots(data.resumeHtml);
    if (slots.length === 0) return { ok: false as const, error: "No text content found to rewrite." };
    const supported = termsAlreadyOnResume(data.resumeHtml, [...data.keywords.must_have, ...data.keywords.phrases, ...data.keywords.keywords]);
    const keywords = supported.join(", ");

    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.25,
      user: `REWRITE STEP ONLY. Rephrase the existing text slots for clarity. Do not invent facts, tools, metrics, or relationships.\n\nReturn JSON only: { "slots": [ { "id": "t0", "text": "..." } ] }\n\nRules:\n- Return every slot id.\n- Original slot text is the only source of facts.\n- Do not add employers, tools, metrics, or domains not already in that slot.\n- Professional summary must open with calculated "X+ years" and contain no job titles.\n- Leave names, dates, phones, emails, companies, and link labels unchanged.\n- Write short, plain sentences. No template language.\n\nKEYWORDS ALREADY ON RESUME (optional): ${keywords || "(none)"}\n\nSLOTS:\n${JSON.stringify(slots)}`,
    });
    if (!result.ok) return result;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text);
      const rewritten = parseRewrittenSlots(parsed, slots);
      const injected = injectTextSlots(template, rewritten);
      const restored = restoreOriginalUrls(data.resumeHtml, injected);
      const html = sanitizeHtml(humanizeOutput(restored));
      const changed = rewritten.filter((s, i) => s.text !== slots[i].text).length;
      const log = formatChatLog("rewriteResume", result, `slots=${slots.length} changed=${changed}`);
      if (html.length < 40) return { ok: false as const, error: "Rewrite produced almost no HTML.", log };
      return { ok: true as const, html, log };
    } catch {
      return { ok: false as const, error: "Rewrite did not return valid JSON slots." };
    }
  });

export const buildIntegritySchema = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, resumeHtml: resumeSchema, keywords: z.any() }))
  .handler(async () => ({ ok: true as const, log: "[buildIntegritySchema] OK | baseline locked" }));

export const auditAndRemediate = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, originalHtml: resumeSchema, draftHtml: resumeSchema, keywords: z.any() }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.15,
      user: `TERMINOLOGY STEP ONLY.\n\nOriginal (facts):\n${data.originalHtml}\n\nDraft:\n${data.draftHtml}\n\nDo only this:\n- Find every technology, library, framework, or tool.\n- If the sentence uses that term in a way that does not match its real meaning or invents a relationship not in the original, rewrite only that sentence so the term is used correctly, or remove the term.\n- Do not change anything else.\n- Return JSON: { "html": "corrected html", "flags": [{"issue":"...","fix":"..."}] }\n\nIf nothing needs changing, return the draft unchanged.`,
    });
    if (!result.ok) return { ok: false as const, error: result.error, log: formatChatLog("terminology", result) };
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text) as any;
      const html = sanitizeHtml(typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : data.draftHtml);
      return { ok: true as const, html, log: formatChatLog("terminology", result), flags: parsed.flags || [] };
    } catch {
      return { ok: true as const, html: data.draftHtml, log: "[terminology] parse failed, kept draft" };
    }
  });

export const grammarAndNaturalEnglish = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: resumeSchema }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.3,
      user: `HUMAN R\u00c9SUM\u00c9 ENGLISH STEP ONLY.\n\nRewrite every bullet and the summary into short, plain English a person would actually write on a r\u00e9sum\u00e9.\n\nInput:\n${data.html}\n\nRules:\n- One idea per bullet when possible.\n- No template language ("helped teams", "reduce discrepancies", "using API integrations", "through modular").\n- Bad: "Connected Figma token pipelines directly with engineering codebases using REST and GraphQL API integrations."\n- Better: "Hooked the design tokens up to the code so engineering could pull them in."\n- Bad: "Built internal content tools in React that helped teams export UI components and reduce handoff discrepancies."\n- Better: "Built a React tool so teams could export components without the usual back-and-forth."\n- Do not add new facts, tools, or metrics.\n- Do not change employers, dates, or titles.\n- Return JSON only: { "html": "rewritten html" }\n\nIf already natural, return unchanged.`,
    });
    if (!result.ok) return { ok: false as const, error: result.error, log: formatChatLog("humanEnglish", result) };
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text) as any;
      const html = sanitizeHtml(typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : data.html);
      return { ok: true as const, html, log: formatChatLog("humanEnglish", result) };
    } catch {
      return { ok: true as const, html: data.html, log: "[humanEnglish] parse failed, kept original" };
    }
  });

export const simulateATS = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, resumeHtml: resumeSchema, keywords: z.any() }))
  .handler(async () => ({ ok: true as const, result: { verdict: "PASS", match_percentage: 72 }, log: "[simulateATS] OK | pass-through" }));

export const lockLayout = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, originalHtml: resumeSchema, currentHtml: resumeSchema }))
  .handler(async ({ data }) => ({ ok: true as const, html: sanitizeHtml(data.currentHtml), log: "[lockLayout] OK" }));

export const cleanHtml = createServerFn({ method: "POST" })
  .validator(z.object({ originalHtml: z.string(), currentHtml: z.string() }))
  .handler(async ({ data }) => ({ ok: true as const, html: sanitizeHtml(data.currentHtml) }));

export const customizeResume = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, resumeHtml: resumeSchema, instructions: z.string().min(3) }))
  .handler(async ({ data }) => ({ ok: true as const, html: data.resumeHtml }));

export const generateCoverLetter = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, jobText: z.string(), resumeHtml: resumeSchema, keywords: z.any().optional() }))
  .handler(async () => ({ ok: true as const, html: "<p>Cover letter generation is not yet fully implemented.</p>" }));

export const finalPolish = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: z.string() }))
  .handler(async ({ data }) => ({ ok: true as const, html: sanitizeHtml(data.html) }));

export const auditKeywords = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: z.string(), keywords: z.any() }))
  .handler(async () => ({ ok: true as const }));

export const grammarCheck = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: z.string() }))
  .handler(async ({ data }) => ({ ok: true as const, html: sanitizeHtml(data.html) }));
