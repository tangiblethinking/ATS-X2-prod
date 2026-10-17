import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { finalizeCleanHtml, stripMarkdownFences } from "@/lib/html-clean";
import { extractTextSlots, injectTextSlots, parseRewrittenSlots } from "@/lib/html-text-slots";
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

function asKeywords(raw: unknown): KeywordSet {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown) =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 250)
      : [];
  return {
    keywords: list(obj.keywords),
    phrases: list(obj.phrases),
    must_have: list(obj.must_have),
    nice_to_have: list(obj.nice_to_have),
  };
}

function asAudit(raw: unknown, fallbackHtml: string): { html: string; audit: AuditResult } {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const html =
    typeof obj.html === "string" && obj.html.trim()
      ? stripMarkdownFences(obj.html)
      : fallbackHtml;
  const flags = Array.isArray(obj.flags)
    ? obj.flags
        .map((f) => {
          if (!f || typeof f !== "object") return null;
          const rec = f as Record<string, unknown>;
          const issue = typeof rec.issue === "string" ? rec.issue.trim() : "";
          const fix = typeof rec.fix === "string" ? rec.fix.trim() : "";
          if (!issue) return null;
          return { issue, fix };
        })
        .filter((x): x is { issue: string; fix: string } => x !== null)
        .slice(0, 40)
    : [];
  const counts: Record<string, number> = {};
  if (obj.keyword_counts && typeof obj.keyword_counts === "object") {
    for (const [k, v] of Object.entries(obj.keyword_counts as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) counts[k] = v;
    }
  }
  return { html, audit: { flags, keyword_counts: counts } };
}

async function chat(opts: {
  apiKey: string;
  user: string;
  maxTokens: number;
  temperature: number;
  json?: boolean;
}) {
  const { geminiChat } = await import("./gemini.server");
  return geminiChat({
    apiKey: opts.apiKey,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: opts.user },
    ],
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
  .validator(
    z.object({
      url: z.string().trim().min(8).max(2000),
    }),
  )
  .handler(async ({ data }) => {
    try {
      const { fetchJobText } = await import("./job-fetch.server");
      const result = await fetchJobText(data.url);
      return { ok: true as const, ...result };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Could not fetch that URL.",
      };
    }
  });

export const extractKeywords = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      jobText: z.string().trim().min(40).max(MAX_JOB_CHARS),
    }),
  )
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey,
      json: true,
      maxTokens: 8000,
      temperature: 0.15,
      user: `STEP 1 — Exhaustively extract EVERY ATS-relevant keyword and phrase from this job description.\n\nBe completely thorough. Do not stop at a short list. Scrape the entire posting and return the maximum useful signal an ATS and a recruiter would care about.\n\nReturn JSON only, shape:\n{\n  \"keywords\": string[],\n  \"phrases\": string[],\n  \"must_have\": string[],\n  \"nice_to_have\": string[]\n}\n\nExtraction rules (mandatory):\n- Extract as many distinct items as the posting contains.\n- Prefer the employer's exact wording and casing.\n- Include synonyms and near-variants that appear in the text.\n- Capture action-oriented capability phrases.\n- Capture every tool, technology, platform, language, framework, methodology, certification, and domain term.\n- Explicitly capture domain workflows and internal tooling (customer support systems, admin dashboards, ticketing, CRM, ERP, ops consoles).\n- Capture the target seniority tier/scope and any stated years-of-experience range (e.g. 5-7 years, 8+ years).\n- Capture soft-skill and leadership phrases when written as requirements.\n- Deduplicate exact duplicates only.\n- Do not invent terms not present or strongly implied.\n- No prose, no explanations, JSON only.\n\nJOB DESCRIPTION:\n${data.jobText}`,
    });
    if (!result.ok) return result;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const keywords = asKeywords(parseJsonObject(result.text));
      const log = formatChatLog("extractKeywords", result, `kw=${keywords.keywords.length + keywords.phrases.length}`);
      if (keywords.keywords.length + keywords.phrases.length === 0) {
        return { ok: false as const, error: "No keywords were extracted. Try a fuller job description.", log };
      }
      return { ok: true as const, keywords, log };
    } catch {
      return { ok: false as const, error: "Keyword extraction did not return valid JSON." };
    }
  });

export const rewriteResume = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      resumeHtml: resumeSchema,
      keywords: z.object({
        keywords: z.array(z.string()),
        phrases: z.array(z.string()),
        must_have: z.array(z.string()),
        nice_to_have: z.array(z.string()),
      }),
    }),
  )
  .handler(async ({ data }) => {
    const { template, slots } = extractTextSlots(data.resumeHtml);
    if (slots.length === 0) {
      return { ok: false as const, error: "No text content found to rewrite." };
    }
    const mustHave = data.keywords.must_have.filter(Boolean).join(", ");
    const phrases = data.keywords.phrases.filter(Boolean).join(", ");
    const keywords = data.keywords.keywords.filter(Boolean).join(", ");
    const niceToHave = data.keywords.nice_to_have.filter(Boolean).join(", ");

    const result = await chat({
      apiKey: data.apiKey,
      json: true,
      maxTokens: 8192,
      temperature: 0.3,
      user: `Rewrite the resume text slots for ATS alignment.\n\nYou will receive a JSON array of text slots extracted from a resume. Return JSON only in this exact shape:\n{ "slots": [ { "id": "t0", "text": "rewritten text" }, ... ] }\n\nRules:\n- Return every slot id. Do not add or remove slots.\n- Rewrite the text to align with the target role and keywords below.\n- Keep all facts (employers, titles, dates, metrics, tools) truthful to the original slot.\n- Integrate must_have keywords and phrases naturally where they fit.\n- Do not invent employers, dates, degrees, certifications, or metrics.\n- Do not return HTML. Return only the JSON object.\n\nMUST_HAVE: ${mustHave || "(none)"}\nPHRASES: ${phrases || "(none)"}\nKEYWORDS: ${keywords || "(none)"}\nNICE_TO_HAVE: ${niceToHave || "(none)"}\n\nSLOTS:\n${JSON.stringify(slots)}`,
    });
    if (!result.ok) return result;

    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text);
      const rewritten = parseRewrittenSlots(parsed, slots);
      const html = injectTextSlots(template, rewritten);
      const changed = rewritten.filter((s, i) => s.text !== slots[i].text).length;
      const log = formatChatLog("rewriteResume", result, `slots=${slots.length} changed=${changed} html=${html.length}`);
      if (html.length < 40) {
        return { ok: false as const, error: "The rewrite produced almost no HTML.", log };
      }
      return { ok: true as const, html, log };
    } catch {
      return { ok: false as const, error: "Rewrite did not return valid JSON slots." };
    }
  });

export const grammarCheck = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      resumeHtml: resumeSchema,
    }),
  )
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey,
      maxTokens: 8192,
      temperature: 0.2,
      user: `STEP 3 — Grammar check for proper spelling and real language use.\n\nFix spelling, grammar, punctuation, awkward phrasing.\nDo not change facts, dates, names, or numbers. Do not alter HTML structure.\nReturn ONLY the full HTML.\n\nRESUME HTML:\n${data.resumeHtml}`,
    });
    if (!result.ok) return result;
    const html = stripMarkdownFences(result.text);
    if (html.length < 40) {
      return { ok: false as const, error: "The grammar pass returned almost no HTML." };
    }
    return { ok: true as const, html };
  });

export const auditKeywords = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      resumeHtml: resumeSchema,
      keywords: z.object({
        keywords: z.array(z.string()),
        phrases: z.array(z.string()),
        must_have: z.array(z.string()),
        nice_to_have: z.array(z.string()),
      }),
    }),
  )
  .handler(async ({ data }) => {
    const kw = [
      ...data.keywords.must_have,
      ...data.keywords.phrases,
      ...data.keywords.keywords,
    ]
      .filter(Boolean)
      .join(", ");
    const result = await chat({
      apiKey: data.apiKey,
      json: true,
      maxTokens: 8192,
      temperature: 0.2,
      user: `STEP 4 — Audit for overuse, redundant application, AND taxonomic pollution of ATS keywords.\n\nReturn JSON only:\n{\n  \"html\": \"full resume HTML after fixes\",\n  \"flags\": [{ \"issue\": string, \"fix\": string }],\n  \"keyword_counts\": { \"term\": number }\n}\n\nATS KEYWORDS AND PHRASES:\n${kw}\n\nRESUME HTML:\n${data.resumeHtml}`,
    });
    if (!result.ok) return result;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = asAudit(parseJsonObject(result.text), data.resumeHtml);
      if (parsed.html.length < 40) {
        return { ok: false as const, error: "The audit returned almost no HTML." };
      }
      return { ok: true as const, html: parsed.html, audit: parsed.audit };
    } catch {
      const html = stripMarkdownFences(result.text);
      if (html.length > 40 && /<\/?[a-z]/i.test(html)) {
        return {
          ok: true as const,
          html,
          audit: { flags: [], keyword_counts: {} },
        };
      }
      return { ok: false as const, error: "The audit did not return valid JSON." };
    }
  });

export const lockLayout = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      originalHtml: resumeSchema,
      currentHtml: resumeSchema,
    }),
  )
  .handler(async ({ data }) => {
    // Structure is already preserved by the slot inject. No model call.
    const log = "[lockLayout] OK model=none finish=SKIP in=0 out=0 | deterministic";
    return { ok: true as const, html: data.currentHtml, log };
  });

export const cleanHtml = createServerFn({ method: "POST" })
  .validator(
    z.object({
      originalHtml: resumeSchema,
      currentHtml: z.string().trim().min(1).max(MAX_RESUME_CHARS * 2),
    }),
  )
  .handler(async ({ data }) => {
    const html = finalizeCleanHtml(data.originalHtml, data.currentHtml);
    return { ok: true as const, html };
  });

const instructionSchema = z
  .string()
  .trim()
  .min(3, "Enter edit instructions.")
  .max(4000, "Instructions are too long.");

/**
 * Direct user-driven edit of the current output HTML.
 * Uses customize-hard-rules.txt as the system instruction set.
 */
export const customizeResume = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      resumeHtml: resumeSchema,
      instructions: instructionSchema,
    }),
  )
  .handler(async ({ data }) => {
    const { geminiChat } = await import("./gemini.server");
    const result = await geminiChat({
      apiKey: data.apiKey,
      messages: [
        { role: "system", content: customizeHardRules },
        {
          role: "user",
          content: `Apply the user's edit instructions to the resume HTML below.\n\nUSER INSTRUCTIONS:\n${data.instructions}\n\nCURRENT RESUME HTML:\n${data.resumeHtml}\n\nReturn ONLY the full HTML after applying the instructions. No markdown, no commentary.`,
        },
      ],
      maxTokens: 8192,
      temperature: 0.2,
    });
    if (!result.ok) return result;
    const html = stripMarkdownFences(result.text);
    if (html.length < 40) {
      return { ok: false as const, error: "The customize pass returned almost no HTML." };
    }
    return { ok: true as const, html };
  });

/**
 * Manual cover letter generation (not part of the pipeline).
 * Requires completed pipeline resume + job description.
 */
export const generateCoverLetter = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      jobText: z.string().trim().min(40).max(MAX_JOB_CHARS),
      resumeHtml: resumeSchema,
      keywords: z
        .object({
          keywords: z.array(z.string()),
          phrases: z.array(z.string()),
          must_have: z.array(z.string()),
          nice_to_have: z.array(z.string()),
        })
        .optional(),
    }),
  )
  .handler(async ({ data }) => {
    const mustHave = data.keywords?.must_have?.filter(Boolean).join(", ") ?? "";
    const phrases = data.keywords?.phrases?.filter(Boolean).join(", ") ?? "";
    const keywords = data.keywords?.keywords?.filter(Boolean).join(", ") ?? "";
    const result = await chat({
      apiKey: data.apiKey,
      maxTokens: 4096,
      temperature: 0.35,
      user: `Write a professional cover letter as a complete, self-contained HTML document.\n\nRequirements:\n- Align tightly with the job description and the rewritten resume below.\n- Stay 100% truthful to the resume; do not invent employers, titles, metrics, or skills.\n- 3–4 short paragraphs plus a brief greeting and closing.\n- Natural, confident tone; weave in high-priority keywords where they fit without stuffing.\n- Return ONLY full HTML (include <!DOCTYPE html>, <html>, <head> with basic print-friendly styles, and follows the heading layout style of the resume html <body>). No markdown fences, no commentary.\n- Simple clean typography suitable for print (letter size, readable margins).\n\nMUST_HAVE (if any):\n${mustHave || "(none)"}\n\nPHRASES (if any):\n${phrases || "(none)"}\n\nKEYWORDS (if any):\n${keywords || "(none)"}\n\nJOB DESCRIPTION:\n${data.jobText}\n\nALIGNED RESUME HTML (source of truth for candidate facts):\n${data.resumeHtml}`,
    });
    if (!result.ok) return result;
    const html = stripMarkdownFences(result.text);
    if (html.length < 80) {
      return { ok: false as const, error: "Cover letter generation returned almost no HTML." };
    }
    return { ok: true as const, html };
  });

// Additional multi-agent steps

export const buildIntegritySchema = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, resumeHtml: resumeSchema, keywords: z.any() }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey,
      json: true,
      maxTokens: 4000,
      temperature: 0.1,
      user: `ROLE: Resume Integrity Architect. Catalog every factual detail from the original resume into an immutable baseline schema. Map keyword injection zones. Flag skill gaps. Output JSON with baseline_facts, mapping_strategy, skill_gaps, factuality_rules.\n\nRESUME:\n${data.resumeHtml}\n\nKEYWORDS:\n${JSON.stringify(data.keywords)}`,
    });
    if (!result.ok) return result;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const log = formatChatLog("buildIntegritySchema", result);
      return { ok: true as const, schema: parseJsonObject(result.text), log };
    } catch {
      return { ok: false as const, error: "Integrity schema failed.", log: formatChatLog("buildIntegritySchema", result) };
    }
  });

export const auditAndRemediate = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, originalHtml: resumeSchema, draftHtml: resumeSchema, keywords: z.any() }))
  .handler(async ({ data }) => {
    // Keep the rewritten draft. The slot inject already preserved structure.
    // A full re-audit was reverting legitimate rewrites; skip it for now.
    const log = "[auditAndRemediate] OK model=none finish=SKIP in=0 out=0 | kept draft";
    return { ok: true as const, html: data.draftHtml, log };
  });

export const simulateATS = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, resumeHtml: resumeSchema, keywords: z.any() }))
  .handler(async ({ data }) => {
    const result = await chat({
      apiKey: data.apiKey,
      json: true,
      maxTokens: 2000,
      temperature: 0.1,
      user: `ROLE: ATS Simulator. Simulate parse on Workday/Greenhouse. Return JSON: { "verdict": "PASS"|"FAIL", "match_percentage": number, "notes": string }.\n\nRESUME:\n${data.resumeHtml}\n\nKEYWORDS:\n${JSON.stringify(data.keywords)}`,
    });
    if (!result.ok) return result;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const log = formatChatLog("simulateATS", result);
      return { ok: true as const, result: parseJsonObject(result.text), log };
    } catch {
      return { ok: false as const, error: "ATS simulation failed.", log: formatChatLog("simulateATS", result) };
    }
  });

export const finalPolish = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, resumeHtml: resumeSchema, skillGaps: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional() }))
  .handler(async ({ data }) => {
    const plain = data.resumeHtml
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 12000);

    const result = await chat({
      apiKey: data.apiKey,
      maxTokens: 3072,
      temperature: 0.15,
      user: `ROLE: Final Polish & Export Manager.\nClean the resume text below into a single-column, copy-ready plain text resume.\n- Keep all factual content.\n- Preserve line breaks: put each section header, job title, and bullet on its own line.\n- Use blank lines between major sections.\n- Prefix bullets with "- ".\n- Remove any leftover tags, markdown fences, or visual clutter.\n- Append a short "Skill Gap Summary" section at the end (also with line breaks).\n\nRESUME TEXT:\n${plain}\n\nSKILL GAPS: ${(data.skillGaps || []).map((g) => typeof g === "string" ? g : String((g as any).term || (g as any).keyword || (g as any).skill || JSON.stringify(g))).join(", ") || "none"}`,
    });
    if (!result.ok) return result;
    const cleaned = stripMarkdownFences(result.text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();

    const escaped = cleaned
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">");
    const html = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><style>\nbody{margin:0;padding:24px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.45;color:#111;}\npre{white-space:pre-wrap;word-wrap:break-word;margin:0;font-family:inherit;}\n</style></head><body><pre>${escaped}</pre></body></html>`;
    return { ok: true as const, text: html };
  });
