export const PIPELINE_STEPS = [
  {
    id: 1,
    key: "scraper",
    title: "Job Spec Scraper",
    blurb: "Collect the full job description text.",
  },
  {
    id: 2,
    key: "intent",
    title: "Intent & Analysis",
    blurb: "Describe what the job is actually looking for in the candidate.",
  },
  {
    id: 3,
    key: "keywords",
    title: "Keyword & Phrase Extraction",
    blurb: "Extract the keywords and phrases needed for the resume.",
  },
  {
    id: 4,
    key: "resume-analysis",
    title: "Resume Analysis",
    blurb: "Extract all information from the existing resume.",
  },
  {
    id: 5,
    key: "rewrite",
    title: "Keyword Injection Rewrite",
    blurb: "Rewrite existing language to inject keywords and phrases without falsifying.",
  },
  {
    id: 6,
    key: "terminology",
    title: "Terminology Accuracy Pass",
    blurb: "Ensure technical language is accurate and makes real-world sense.",
  },
  {
    id: 7,
    key: "natural",
    title: "Human Natural Language Pass",
    blurb: "Rewrite into natural language a person would write.",
  },
  {
    id: 8,
    key: "scannability",
    title: "Human Scannability Pass",
    blurb: "Ensure the most important points are quickly scannable by a human.",
  },
  {
    id: 9,
    key: "inject",
    title: "Inject into Original Layout",
    blurb: "Place the rewritten text back into the original HTML structure.",
  },
  {
    id: 10,
    key: "audit",
    title: "Audit & QA",
    blurb: "Full content and code quality check.",
  },
  {
    id: 11,
    key: "final",
    title: "Final HTML",
    blurb: "Deliver the cleaned final resume HTML.",
  },
] as const;

export type StepId = (typeof PIPELINE_STEPS)[number]["id"];
export type StepStatus = "idle" | "running" | "done" | "error";

export type KeywordSet = {
  keywords: string[];
  phrases: string[];
  must_have: string[];
  nice_to_have: string[];
  hard_skills?: string[];
  soft_skills?: string[];
  rubric?: Record<string, number>;
};

export type AuditFlag = {
  issue: string;
  fix: string;
};

export type AuditResult = {
  flags: AuditFlag[];
  keyword_counts: Record<string, number>;
  match_percentage?: number;
  skill_gaps?: string[];
};

export const API_KEY_STORAGE = "ats-align.gemini-api-key";
export const SEARCH_API_KEY_STORAGE = "ats-align.search-api-key";
export const DRAFT_STORAGE = "ats-align.draft";

export const MAX_RESUME_CHARS = 80_000;
export const MAX_JOB_CHARS = 40_000;
