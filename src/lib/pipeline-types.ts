export const PIPELINE_STEPS = [
  {
    id: 1,
    key: "scraper",
    title: "Job Spec Scraper & Intent Analyst",
    blurb: "Ingest URL or text, extract ATS keywords, hard/soft skills, rubric, diagnostic log.",
  },
  {
    id: 2,
    key: "integrity",
    title: "Resume Integrity Architect",
    blurb: "Lock baseline facts, map keyword zones, identify skill gaps, enforce factuality matrix.",
  },
  {
    id: 3,
    key: "coordinator",
    title: "Task & Pipeline Coordinator",
    blurb: "Decompose into atomic sections, orchestrate parallel work packages, manage retries.",
  },
  {
    id: 4,
    key: "optimizer",
    title: "Content Optimizer / Writer",
    blurb: "Rewrite isolated sections with natural keyword integration, strong verbs, factual constraints.",
  },
  {
    id: 5,
    key: "auditor",
    title: "Fact-Check & Hallucination Auditor",
    blurb: "Detect and remediate hallucinations, restore 100% factual fidelity.",
  },
  {
    id: 6,
    key: "ats-sim",
    title: "ATS Simulator & Formatting Validator",
    blurb: "Simulate ATS parse (Workday etc.), keyword match %, formatting check, PASS/FAIL.",
  },
  {
    id: 7,
    key: "polish",
    title: "Layout Lock & Export",
    blurb: "Restore original HTML structure, classes, and styles with optimized text.",
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
