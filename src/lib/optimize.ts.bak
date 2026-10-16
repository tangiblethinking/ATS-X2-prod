import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { finalizeCleanHtml, stripMarkdownFences } from "@/lib/html-clean";
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
      user: `STEP 1 — Exhaustively extract EVERY ATS-relevant keyword and phrase from this job description.\n\nBe completely thorough. Do not stop at a short list. Scrape the entire posting and return the maximum useful signal an ATS and a recruiter would care about.\n\nReturn JSON only, shape:\n{\n  \"keywords\": string[],\n  \"phrases\": string[],\n  \"must_have\": string[],\n  \"nice_to_have\": string[]\n}\n\nExtraction rules (mandatory):\n- Extract as many distinct items as the posting contains.\n- Prefer the employer's exact wording and casing.\n- Include synonyms and near-variants that appear in the text.\n- Capture action-oriented capability phrases.\n- Capture every tool, technology, platform, language, framework, methodology, certification, and domain term.\n- Capture soft-skill and leadership phrases when written as requirements.\n- Deduplicate exact duplicates only.\n- Do not invent terms not present or strongly implied.\n- No prose, no explanations, JSON only.\n\nJOB DESCRIPTION:\n${data.jobText}`,
    });
    if (!result.ok) return result;
    try {
      const { parseJsonObject } = await import("./gemini.server");
      const keywords = asKeywords(parseJsonObject(result.text));
      if (keywords.keywords.length + keywords.phrases.length === 0) {
        return { ok: false as const, error: "No keywords were extracted. Try a fuller job description." };
      }
      return { ok: true as const, keywords };
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
    const mustHave = data.keywords.must_have.filter(Boolean).join(", ");
    const phrases = data.keywords.phrases.filter(Boolean).join(", ");
    const keywords = data.keywords.keywords.filter(Boolean).join(", ");
    const niceToHave = data.keywords.nice_to_have.filter(Boolean).join(", ");
    const result = await chat({
      apiKey: data.apiKey,
      maxTokens: 8192,
      temperature: 0.2,
      user: `STEP 2 — Completely rewrite the WHOLE resume for strict syntactic + deep semantic ATS dual-alignment.\n\nGoal: Conform the existing resume to the target role. The output must read as if the candidate wrote it specifically for this posting, while remaining 100% truthful to the source content.\n\nLayout lock (mandatory):\n- Keep every tag, attribute, class, id, inline style, <style> block, table, and document structure from the original HTML.\n- Change TEXT CONTENT only. Do not restyle. Do not add or remove sections, columns, or wrappers.\n- Return ONLY HTML. No markdown, no commentary.\n- Do not change any location at any part of the resume.\n\n### SYNTACTIC ALIGNMENT (Exact Keyword Matching)\n- Integrate extracted keywords, acronyms, and multi-word phrases VERBATIM.\n- Density: every high-priority must_have keyword must appear at least once in the professional summary or core competencies AND naturally inside experience bullets.\n\n### SEMANTIC ALIGNMENT (Contextual Relevance)\n- Reframe historical experience to map to the problem domains emphasized in the JD.\n- Every experience bullet MUST follow the PAR formula with only metrics supported by the source.\n\n### CONTEXTUAL BOUNDARY & POLLUTION FILTER (mandatory)\n- NEVER inject job titles, company names, seniorities into technical skills lists.\n\n### Zero Hallucination\n- Do not fabricate employers, titles, dates, degrees, certifications, tools, metrics, or achievements.\n\nMUST_HAVE:\n${mustHave || "(none extracted)"}\n\nPHRASES:\n${phrases || "(none extracted)"}\n\nKEYWORDS:\n${keywords || "(none extracted)"}\n\nNICE_TO_HAVE:\n${niceToHave || "(none extracted)"}\n\nORIGINAL RESUME HTML:\n${data.resumeHtml}`,
    });
    if (!result.ok) return result;
    const html = stripMarkdownFences(result.text);
    if (html.length < 40) {
      return { ok: false as const, error: "The rewrite returned almost no HTML." };
    }
    return { ok: true as const, html };
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
    const result = await chat({
      apiKey: data.apiKey,
      maxTokens: 8192,
      temperature: 0.1,
      user: `STEP 5 — Follow the exact layout and styling of the original HTML.\n\nTake ORIGINAL as structural source of truth and CURRENT as wording source.\nReturn ONLY the full HTML.\n\nORIGINAL HTML:\n${data.originalHtml}\n\nCURRENT HTML:\n${data.currentHtml}`,
    });
    if (!result.ok) return result;
    const html = stripMarkdownFences(result.text);
    if (html.length < 40) {
      return { ok: false as const, error: "The layout pass returned almost no HTML." };
    }
    return { ok: true as const, html };
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
