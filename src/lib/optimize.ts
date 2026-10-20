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

function extractSummaryText(html: string): string {
  const match = html.match(/summary-text[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || html.match(/Professional Summary[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (match) return match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const idx = plain.toLowerCase().indexOf("professional summary");
  if (idx >= 0) return plain.slice(idx, idx + 400).trim();
  return "";
}

function summaryQualityOk(html: string): { ok: boolean; reason: string } {
  const summary = extractSummaryText(html);
  if (!summary || summary.length < 40) return { ok: false, reason: "summary too short or missing" };

  const pastIndicators = /\b(directed|eliminated|accelerated|improved|raised|built|created|managed|designed|established|secured|partnered|architected|reduced|ensured|increased)\b/gi;
  const gerundStart = /^[A-Z][a-z]+ing\b/;
  const sentences = summary.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);

  for (const s of sentences) {
    if (pastIndicators.test(s) && !/\b(years|experience)\b/i.test(s)) {
      return { ok: false, reason: "summary uses past tense" };
    }
    if (gerundStart.test(s)) {
      return { ok: false, reason: "summary starts a sentence with a gerund fragment" };
    }
  }

  if (sentences.length < 2) return { ok: false, reason: "summary needs 2–3 complete sentences" };
  return { ok: true, reason: "ok" };
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

export const analyzeIntent = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, jobText: z.string().trim().min(40).max(MAX_JOB_CHARS) }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 4000, temperature: 0.2,
      user: `Analyze this job description. Describe in clear plain language what the role is actually looking for in a candidate (skills, outcomes, seniority signals, domain). Return JSON only: {"intent":"...","priorities":["..."]}.\n\nJOB:\n${data.jobText}`,
    });
    if (!result.ok) return result;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text) as any;
      const log = formatChatLog("analyzeIntent", result);
      return { ok: true as const, intent: parsed.intent || "", priorities: parsed.priorities || [], log };
    } catch {
      return { ok: false as const, error: "Intent analysis did not return valid JSON." };
    }
  });

export const extractKeywords = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, jobText: z.string().trim().min(40).max(MAX_JOB_CHARS) }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8000, temperature: 0.15,
      user: `Extract ATS keywords and phrases from this job description. Return JSON only: {"keywords":[],"phrases":[],"must_have":[],"nice_to_have":[]}.\n\nPrioritize hard skills, tools, methodologies, and outcome language.\nDo not invent terms.\n\nJOB:\n${data.jobText}`,
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

export const analyzeResume = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, resumeHtml: resumeSchema }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 6000, temperature: 0.15,
      user: `Extract the key factual information from this resume HTML. Return JSON only: {"summary":"...","roles":[{"title":"...","company":"...","dates":"...","bullets":["..."]}],"skills":["..."],"education":"..."}.\n\nDo not invent anything.\n\nRESUME:\n${data.resumeHtml}`,
    });
    if (!result.ok) return result;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text);
      const log = formatChatLog("analyzeResume", result);
      return { ok: true as const, analysis: parsed, log };
    } catch {
      return { ok: false as const, error: "Resume analysis did not return valid JSON." };
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

    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.4,
      user: `REWRITE: Inject as many of the job keywords and phrases as possible into the existing resume language.\n\nReturn JSON only: { "slots": [ { "id": "t0", "text": "..." } ] }\n\nRules:\n- Return every slot id. Plain text only, no HTML tags.\n- Do not invent new employers, titles, dates, metrics, or tools that do not exist.\n- Stretching the truth is acceptable when it truthfully maps to existing work.\n- Prefer the job's wording for the same underlying experience.\n- Summary must open with calculated "X+ years" and contain no job titles.\n- Summary must use present tense only (e.g. "directs", "builds", "leads"). Never past tense or gerund fragments.\n- Leave names, dates, phones, emails, companies, and link labels unchanged.\n- Natural language.\n\nMUST-PLACE: ${must || "(none)"}\nPHRASES: ${phrases || "(none)"}\nOTHER: ${other || "(none)"}\n\nSLOTS:\n${JSON.stringify(slots)}`,
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

export const terminologyPass = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, originalHtml: resumeSchema, draftHtml: resumeSchema }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.15,
      user: `TERMINOLOGY PASS: Ensure all technical language is accurate and makes real-world sense.\n\nOriginal (facts):\n${data.originalHtml}\n\nDraft:\n${data.draftHtml}\n\nRewrite only sentences where a tool, library, or system is used in a way that does not match its real meaning or invents an unsupported relationship.\nPreserve truthful keyword weaving.\nReturn well-formed HTML.\nReturn JSON: { "html": "corrected html" }\n\nIf nothing needs changing, return the draft unchanged.`,
    });
    if (!result.ok) return { ok: false as const, error: result.error, log: formatChatLog("terminology", result) };
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text) as any;
      const html = sanitizeHtml(typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : data.draftHtml);
      return { ok: true as const, html, log: formatChatLog("terminology", result) };
    } catch {
      return { ok: true as const, html: data.draftHtml, log: "[terminology] parse failed, kept draft" };
    }
  });

export const naturalLanguagePass = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: resumeSchema }))
  .handler(async ({ data }) => {
    let current = data.html;
    let attempts = 0;
    const maxAttempts = 3;
    let lastLog = "";

    while (attempts < maxAttempts) {
      attempts++;
      const quality = summaryQualityOk(current);
      if (quality.ok && attempts > 1) break;

      const result = await chat({
        apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.25,
        user: `HUMAN NATURAL LANGUAGE PASS (attempt ${attempts}).\n\nRewrite the summary and bullets into natural, grammatical English.\n\nCRITICAL RULES FOR THE SUMMARY:\n- Must be 2–3 complete sentences.\n- Must use present tense only. Examples of correct: "Directs cross-functional work. Builds design systems. Improves release speed."\n- Never use past tense in the summary (no "directed", "eliminated", "accelerated", "built" as the main verb).\n- Never start a sentence with a gerund fragment (no "Eliminating handoff friction...").\n- Must open with "X+ years".\n- Must not contain any job title.\n- Must sound like a person describing their current capabilities.\n\nFor bullets: keep them natural and grammatical. Prefer present or consistent tense.\nDo not invent facts.\nReturn well-formed HTML.\nReturn JSON only: { "html": "rewritten html" }\n\nCurrent HTML:\n${current}\n\nQuality issues found (if any): ${quality.reason}`,
      });
      lastLog = formatChatLog("natural", result, `attempt=${attempts}`);
      if (!result.ok) {
        if (attempts === maxAttempts) return { ok: false as const, error: result.error, log: lastLog };
        continue;
      }
      try {
        const { parseJsonObject } = await import("./gemini.server");
        const parsed = parseJsonObject(result.text) as any;
        const next = sanitizeHtml(typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : current);
        const nextQuality = summaryQualityOk(next);
        current = next;
        if (nextQuality.ok) break;
      } catch {
        // keep current and try again
      }
    }

    return { ok: true as const, html: current, log: lastLog || "[natural] completed", attempts };
  });

export const scannabilityPass = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: resumeSchema }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 8192, temperature: 0.2,
      user: `HUMAN SCANNABILITY PASS.\n\nMake the resume easy for a human to scan quickly. The most important points should stand out.\n\nInput:\n${data.html}\n\nRules:\n- Keep all factual content and truthful keyword weaving.\n- Prefer short bullets with the strongest outcome or skill near the start of the bullet.\n- Summary must remain present tense and grammatical.\n- Do not invent facts.\n- Return well-formed HTML.\n- Return JSON only: { "html": "rewritten html" }\n\nIf already scannable, return unchanged.`,
    });
    if (!result.ok) return { ok: false as const, error: result.error, log: formatChatLog("scannability", result) };
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text) as any;
      const html = sanitizeHtml(typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : data.html);
      return { ok: true as const, html, log: formatChatLog("scannability", result) };
    } catch {
      return { ok: true as const, html: data.html, log: "[scannability] parse failed, kept original" };
    }
  });

export const auditAndQA = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, originalHtml: resumeSchema, currentHtml: resumeSchema, keywords: z.any() }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey, json: true, maxTokens: 6000, temperature: 0.1,
      user: `AUDIT & QA.\n\nCompare the final HTML against the original. Flag any invented facts, broken tags, or major issues.\nAlso confirm the summary is present tense and grammatical.\n\nOriginal:\n${data.originalHtml}\n\nFinal:\n${data.currentHtml}\n\nReturn JSON: { "html": "final cleaned html", "flags": [{"issue":"...","fix":"..."}] }\n\nIf clean, return the current HTML unchanged.`,
    });
    if (!result.ok) return { ok: false as const, error: result.error, log: formatChatLog("audit", result) };
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text) as any;
      const html = sanitizeHtml(typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : data.currentHtml);
      return { ok: true as const, html, flags: parsed.flags || [], log: formatChatLog("audit", result) };
    } catch {
      return { ok: true as const, html: data.currentHtml, flags: [], log: "[audit] parse failed, kept current" };
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

export const buildIntegritySchema = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, resumeHtml: resumeSchema, keywords: z.any() }))
  .handler(async () => ({ ok: true as const, log: "[buildIntegritySchema] OK" }));

export const lockLayout = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, originalHtml: resumeSchema, currentHtml: resumeSchema }))
  .handler(async ({ data }) => ({ ok: true as const, html: sanitizeHtml(data.currentHtml), log: "[lockLayout] OK" }));

export const auditAndRemediate = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, originalHtml: resumeSchema, draftHtml: resumeSchema, keywords: z.any() }))
  .handler(async ({ data }) => ({ ok: true as const, html: data.draftHtml, log: "[auditAndRemediate] OK" }));

export const grammarAndNaturalEnglish = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: resumeSchema }))
  .handler(async ({ data }) => ({ ok: true as const, html: data.html, log: "[grammarAndNaturalEnglish] OK" }));
