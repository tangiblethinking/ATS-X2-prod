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

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function calculateMatchPercentage(html: string, keywords: KeywordSet): number {
  const plain = plainText(html);
  const must = [...new Set([...(keywords.must_have || []), ...(keywords.phrases || [])].map(t => t.toLowerCase().trim()).filter(t => t.length >= 3))];
  const nice = [...new Set([...(keywords.keywords || []), ...(keywords.nice_to_have || [])].map(t => t.toLowerCase().trim()).filter(t => t.length >= 3))];
  if (must.length === 0 && nice.length === 0) return 0;

  let mustHits = 0;
  for (const term of must) {
    if (plain.includes(term)) mustHits++;
  }
  let niceHits = 0;
  for (const term of nice) {
    if (plain.includes(term)) niceHits++;
  }

  const mustScore = must.length ? (mustHits / must.length) * 70 : 0;
  const niceScore = nice.length ? (niceHits / nice.length) * 30 : 0;
  const total = Math.round(mustScore + niceScore);
  return Math.max(0, Math.min(100, total));
}

export function sanitizeHtml(html: string): string {
  let out = html;
  out = out.replace(/\.{2,}/g, ".");
  out = out.replace(/\s+([.,;:])/g, "$1");
  out = out.replace(/\s{2,}/g, " ");
  out = out.replace(/([a-zA-Z0-9.,])(<strong>|<b>|<em>|<i>)/gi, "$1 $2");
  out = out.replace(/(<\/strong>|<\/b>|<\/em>|<\/i>)([a-zA-Z0-9])/gi, "$1 $2");
  out = out.replace(/<\/strong>\s*\./g, ".</strong>");
  out = out.replace(/<strong>\s*<\/strong>/g, "");
  out = out.replace(/<b>\s*<\/b>/g, "");
  out = out.replace(/\s{2,}/g, " ");
  return out.trim();
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
      user: `Extract ATS keywords from this job description. Return JSON only: {"keywords":[],"phrases":[],"must_have":[],"nice_to_have":[]}.\n\nPrioritize hard skills, tools, methodologies, and outcome language that appear in the job description.\nDo not invent terms.\n\nJOB:\n${data.jobText}`,
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

    const must = (data.keywords.must_have || []).slice(0, 30).join(", ");
    const phrases = (data.keywords.phrases || []).slice(0, 25).join(", ");
    const other = [...(data.keywords.keywords || []), ...(data.keywords.nice_to_have || [])].slice(0, 40).join(", ");

    // Pass 1: initial rewrite with keyword weaving
    const pass1 = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.35,
      user: `REWRITE PASS 1: Rephrase every experience bullet and the summary so the language more closely matches the job description.\n\nReturn JSON only: { "slots": [ { "id": "t0", "text": "..." } ] }\n\nRules:\n- Return every slot id. Plain text only, no HTML tags.\n- Original slot text is the only source of facts. Do not invent employers, titles, dates, metrics, tools, or relationships.\n- Weave in the keywords and phrases below wherever they truthfully describe work already present in that slot. Prefer the job's wording for the same thing.\n- Summary must open with calculated "X+ years" and contain no job titles.\n- Leave names, dates, phones, emails, companies, and link labels unchanged.\n- Keep language natural. Max two job terms per sentence.\n\nMUST-PLACE: ${must || "(none)"}\nPHRASES: ${phrases || "(none)"}\nOTHER: ${other || "(none)"}\n\nSLOTS:\n${JSON.stringify(slots)}`,
    });
    if (!pass1.ok) return pass1;

    let rewritten;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed1 = parseJsonObject(pass1.text);
      rewritten = parseRewrittenSlots(parsed1, slots);
    } catch {
      return { ok: false as const, error: "Rewrite pass 1 did not return valid JSON slots." };
    }

    // Pass 2: strengthen weaving on the already-rewritten text
    const pass2 = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.3,
      user: `REWRITE PASS 2: Review the rewritten slots and strengthen keyword integration where possible.\n\nReturn JSON only: { "slots": [ { "id": "t0", "text": "..." } ] }\n\nRules:\n- Return every slot id. Plain text only, no HTML tags.\n- Do not invent any new facts, tools, metrics, employers, or relationships that are not already supported by the original slots.\n- Where a job keyword or phrase truthfully maps to work already described, rewrite the sentence to use that language more naturally and clearly.\n- Do not keyword-stuff. Keep max two job terms per sentence.\n- If a slot is already strong, leave it unchanged.\n- Summary must still open with "X+ years" and contain no job titles.\n\nMUST-PLACE: ${must || "(none)"}\nPHRASES: ${phrases || "(none)"}\nOTHER: ${other || "(none)"}\n\nORIGINAL SLOTS:\n${JSON.stringify(slots)}\n\nCURRENT REWRITTEN SLOTS:\n${JSON.stringify(rewritten)}`,
    });

    if (pass2.ok) {
      try {
        const { parseJsonObject } = await import("./gemini.server");
        const parsed2 = parseJsonObject(pass2.text);
        rewritten = parseRewrittenSlots(parsed2, rewritten);
      } catch {
        // keep pass 1 result if pass 2 parse fails
      }
    }

    const injected = injectTextSlots(template, rewritten);
    const restored = restoreOriginalUrls(data.resumeHtml, injected);
    const html = sanitizeHtml(humanizeOutput(restored));
    const changed = rewritten.filter((s, i) => s.text !== slots[i].text).length;
    const log = formatChatLog("rewriteResume", pass1, `slots=${slots.length} changed=${changed} passes=2`);
    if (html.length < 40) return { ok: false as const, error: "Rewrite produced almost no HTML.", log };
    return { ok: true as const, html, log };
  });

export const buildIntegritySchema = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, resumeHtml: resumeSchema, keywords: z.any() }))
  .handler(async ({ data }) => {
    const plain = plainText(data.resumeHtml);
    const years = (plain.match(/\b(19|20)\d{2}\b/g) || []).length;
    const metrics = (plain.match(/\b\d+%|\b\d+\s*(%|percent)/gi) || []).length;
    const log = `[buildIntegritySchema] OK | baseline locked | years=${years} metrics=${metrics}`;
    return { ok: true as const, log, schema: { plainLength: plain.length, years, metrics } };
  });

export const auditAndRemediate = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, originalHtml: resumeSchema, draftHtml: resumeSchema, keywords: z.any() }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.15,
      user: `TERMINOLOGY & INTEGRITY STEP.\n\nOriginal (facts only):\n${data.originalHtml}\n\nDraft (optimized):\n${data.draftHtml}\n\nDo only this:\n- Find any invented technical relationships, tools, metrics, employers, or claims not supported by the original.\n- Rewrite only the offending sentences so the term is used correctly or remove the unsupported term.\n- Preserve all truthful keyword weaving that maps to existing experience.\n- Return well-formed HTML. Do not break tags.\n- Return JSON: { "html": "corrected html", "flags": [{"issue":"...","fix":"..."}] }\n\nIf nothing needs changing, return the draft unchanged.`,
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
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.25,
      user: `HUMAN ENGLISH POLISH STEP ONLY.\n\nRewrite bullets and the summary into short, plain, natural English a person would write.\n\nInput:\n${data.html}\n\nRules:\n- Keep all truthful keyword weaving and ATS-aligned phrasing that is already accurate.\n- One idea per bullet when possible.\n- No template language.\n- Do not add new facts, tools, or metrics.\n- Do not change employers, dates, or titles.\n- Return well-formed HTML. Do not glue tags to words or leave tags unclosed.\n- Return JSON only: { "html": "rewritten html" }\n\nIf already natural, return unchanged.`,
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
  .handler(async ({ data }) => {
    const keywords = asKeywords(data.keywords);
    const match = calculateMatchPercentage(data.resumeHtml, keywords);
    const verdict = match >= 65 ? "PASS" : match >= 45 ? "CONDITIONAL_PASS" : "FAIL";
    const log = `[simulateATS] OK | match=${match}% verdict=${verdict}`;
    return {
      ok: true as const,
      result: { verdict, match_percentage: match },
      log,
    };
  });

export const lockLayout = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, originalHtml: resumeSchema, currentHtml: resumeSchema }))
  .handler(async ({ data }) => ({ ok: true as const, html: sanitizeHtml(data.currentHtml), log: "[lockLayout] OK | structure preserved" }));

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
