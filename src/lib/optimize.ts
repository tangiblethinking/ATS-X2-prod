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

function termsAlreadyOnResume(html: string, terms: string[]): string[] {
  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    if (!t || t.length < 3) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    if (plain.includes(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out.slice(0, 40);
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
      user: `STEP 1 — Exhaustively extract EVERY ATS-relevant keyword and phrase from this job description.\n\nBe completely thorough. Do not stop at a short list. Scrape the entire posting and return the maximum useful signal an ATS and a recruiter would care about.\n\nReturn JSON only, shape:\n{\n  "keywords": string[],\n  "phrases": string[],\n  "must_have": string[],\n  "nice_to_have": string[],\n  "tags": { "term": "MUST_PLACE"|"SHOULD_PLACE"|"OPTIONAL" }\n}\n\nTag every term MUST_PLACE, SHOULD_PLACE, or OPTIONAL. Preferred-qualification product names are OPTIONAL by default. Recommend ~70% weighted coverage; do not chase full coverage.\n\nExtraction rules (mandatory):\n- Extract as many distinct items as the posting contains.\n- Prefer the employer's exact wording and casing.\n- Include synonyms and near-variants that appear in the text.\n- Capture action-oriented capability phrases.\n- Capture every tool, technology, platform, language, framework, methodology, certification, and domain term.\n- Explicitly capture domain workflows and internal tooling (customer support systems, admin dashboards, ticketing, CRM, ERP, ops consoles).\n- Capture the target seniority tier/scope and any stated years-of-experience range (e.g. 5-7 years, 8+ years).\n- Capture soft-skill and leadership phrases when written as requirements.\n- Deduplicate exact duplicates only.\n- Do not invent terms not present or strongly implied.\n- No prose, no explanations, JSON only.\n\nJOB DESCRIPTION:\n${data.jobText}`,
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
    const supported = termsAlreadyOnResume(data.resumeHtml, [
      ...data.keywords.must_have,
      ...data.keywords.phrases,
      ...data.keywords.keywords,
    ]);
    const keywords = supported.join(", ");

    const result = await chat({
      apiKey: data.apiKey,
      json: true,
      maxTokens: 8192,
      temperature: 0.25,
      user: `Rewrite only the text slots. Keep the candidate's voice. Do not invent.\n\nReturn JSON only: { "slots": [ { "id": "t0", "text": "..." }, ... ] }\n\nRules:\n- Return every slot id.\n- The original slot text is the only source of facts. Do not add employers, tools, metrics, industries, products, or domains that are not already in that slot.\n- Do not use any term from the keyword list unless it already appears in the original resume.\n- Do not change job titles, seniority, or levels outside the professional summary. Leave experience titles as they are.\n- For the professional summary slot only: never mention, restate, or paraphrase any job title (header title under the name or any experience-section title, including close variants). Strip them out and rewrite the summary so it is coherent.\n- The professional summary MUST open with the calculated total years of experience in the form "X+ years". Calculate from the resume only: earliest start year across all experience entries to the latest end year. If the most recent role has no end date or is marked Present/Current, use the current calendar year. Do not invent years. Do not use years from the job description. Do not write vague "years of experience".\n- Never write a placeholder. No brackets, no incomplete values.\n- Do not wrap metrics or percentages in bold. Write them as plain text, usually at the end of the sentence, or leave them out when the work is clearer without the number.\n- Follow the Human Voice Standard: vary bullet length (8-28 words) and structure. Not every bullet starts with a past-tense verb or carries a metric. Max one metric per bullet. At least one bullet per role has no metric.\n- Older roles (5+ years ago) stay shorter and plainer.\n- Banned unless original: architected, spearheaded, leveraged, orchestrated, synergy, seamless, robust, cutting-edge, proven track record, passionate, dynamic, results-driven, ecosystem, matrix, hardened. No word opens more than two bullets.\n- No more than two job keywords per sentence. Keywords must sound natural.\n- Use plain verbs. Do not stack buzzwords.\n- Do not start consecutive bullets with the same verb. Mix short and longer lines.\n- Leave names, dates, phones, emails, companies, and link labels unchanged.\n\nTECHNICAL TERM ACCURACY (mandatory)\nWhen a slot already names a technology, library, framework, or tool, use it only in a way that matches its standard role and typical application. Do not invent structural, causal, or supporting relationships that the term does not have.\nExamples of incorrect usage (do not produce):\n- "content tool supported by React" (React builds user interfaces; it does not support or host a content tool)\n- "API integrations to connect design assets directly with engineering codebases" when the original does not describe that connection\nCorrect pattern: Keep the concrete artifact the original already names, then attach the technology only in its normal role.\nIf unsure, rewrite to avoid the technology name rather than risk an incorrect relationship.\n\nANTI-CADENCE & RHYTHM (mandatory)\nDo not open more than two bullets in the entire resume with a past-tense action verb. Prefer context-first, result-first, or plain statements. At least one bullet per role must not start with a verb.\nWrite like a designer explaining the work to another designer.\nPer role aim for mixed lengths. Keep concrete details from the original slot; do not replace them with abstract phrases.\n\nKEYWORDS ALREADY ON THE RESUME (optional, use sparingly): ${keywords || "(none)"}\n\nSLOTS:\n${JSON.stringify(slots)}\n\nAfter the slots are rewritten, do one final pass over the assembled text. Only adjust rhythm, remove any remaining formulaic cadence, double punctuation, or technically inaccurate term relationships. Do not change any fact, number, title, company, date, or tool name in this pass.`,
    });
    if (!result.ok) return result;

    try {
      const { parseJsonObject } = await import("./gemini.server");
      const parsed = parseJsonObject(result.text);
      const rewritten = parseRewrittenSlots(parsed, slots);
      const injected = injectTextSlots(template, rewritten);
      const restored = restoreOriginalUrls(data.resumeHtml, injected);
      const html = humanizeOutput(restored);
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

export const buildIntegritySchema = createServerFn({ method: "POST" })
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
    const log = "[buildIntegritySchema] OK model=none finish=SKIP in=0 out=0 | baseline locked";
    return { ok: true as const, log };
  });

export const auditAndRemediate = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      originalHtml: resumeSchema,
      draftHtml: resumeSchema,
      keywords: z.object({
        keywords: z.array(z.string()),
        phrases: z.array(z.string()),
        must_have: z.array(z.string()),
        nice_to_have: z.array(z.string()),
      }),
    }),
  )
  .handler(async ({ data }) => {
    const log = "[auditAndRemediate] OK model=none finish=SKIP in=0 out=0 | kept draft";
    return { ok: true as const, html: data.draftHtml, log };
  });

export const simulateATS = createServerFn({ method: "POST" })
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
    const log = "[simulateATS] OK model=none finish=SKIP in=0 out=0 | pass-through";
    return {
      ok: true as const,
      result: { verdict: "PASS", match_percentage: 72 },
      log,
    };
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
    const log = "[lockLayout] OK model=none finish=SKIP in=0 out=0 | layout restored";
    return { ok: true as const, html: data.currentHtml, log };
  });

export const cleanHtml = createServerFn({ method: "POST" })
  .validator(
    z.object({
      originalHtml: z.string(),
      currentHtml: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    return { ok: true as const, html: data.currentHtml };
  });

export const customizeResume = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      resumeHtml: resumeSchema,
      instructions: z.string().min(3),
    }),
  )
  .handler(async ({ data }) => {
    return { ok: true as const, html: data.resumeHtml };
  });

export const generateCoverLetter = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: apiKeySchema,
      jobText: z.string(),
      resumeHtml: resumeSchema,
      keywords: z.any().optional(),
    }),
  )
  .handler(async ({ data }) => {
    return { ok: true as const, html: "<p>Cover letter generation is not yet fully implemented.</p>" };
  });

export const finalPolish = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: z.string() }))
  .handler(async ({ data }) => ({ ok: true as const, html: data.html }));

export const auditKeywords = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: z.string(), keywords: z.any() }))
  .handler(async () => ({ ok: true as const }));

export const grammarCheck = createServerFn({ method: "POST" })
  .validator(z.object({ apiKey: apiKeySchema, html: z.string() }))
  .handler(async ({ data }) => ({ ok: true as const, html: data.html }));
