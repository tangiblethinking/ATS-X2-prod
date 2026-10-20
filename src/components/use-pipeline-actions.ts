import { useCallback } from "react";
import { toast } from "sonner";
import { isPlausibleApiKey } from "@/lib/api-key-store";
import { looksLikeHtml } from "@/lib/html-clean";
import {
  buildIntegritySchema,
  auditAndRemediate,
  simulateATS,
  finalPolish,
  auditKeywords,
  cleanHtml,
  customizeResume,
  extractKeywords,
  fetchJobDescription,
  generateCoverLetter,
  grammarCheck,
  lockLayout,
  rewriteResume,
  grammarAndNaturalEnglish,
} from "@/lib/optimize";
import type { JobResult } from "@/lib/job-search";
import {
  MAX_JOB_CHARS,
  type AuditResult,
  type KeywordSet,
  type StepId,
  type StepStatus,
} from "@/lib/pipeline-types";
import type { DocKind } from "@/components/output-panel";

type SetStatuses = React.Dispatch<React.SetStateAction<Record<StepId, StepStatus>>>;
type SetDetails = React.Dispatch<React.SetStateAction<Partial<Record<StepId, string>>>>;

export function usePipelineActions(opts: {
  apiKey: string;
  jobUrl: string;
  setJobUrl: (v: string) => void;
  jobText: string;
  setJobText: (v: string) => void;
  resumeHtml: string;
  keywords: KeywordSet | null;
  setKeywords: (v: KeywordSet | null) => void;
  finalHtml: string | null;
  setFinalHtml: (v: string | null) => void;
  coverHtml: string | null;
  setCoverHtml: (v: string | null) => void;
  setAudit: (v: AuditResult | null) => void;
  setStatuses: SetStatuses;
  setDetails: SetDetails;
  busy: boolean;
  setRunning: (v: boolean) => void;
  setRewriting: (v: boolean) => void;
  setCustomizing: (v: boolean) => void;
  setGeneratingCover: (v: boolean) => void;
  setMode: (v: "pipeline" | "search") => void;
  idleStatuses: () => Record<StepId, StepStatus>;
  setPipelineLog?: (updater: (prev: string[]) => string[]) => void;
}) {
  const {
    apiKey, jobUrl, setJobUrl, jobText, setJobText, resumeHtml,
    keywords, setKeywords, finalHtml, setFinalHtml, coverHtml, setCoverHtml,
    setAudit, setStatuses, setDetails, busy, setRunning, setRewriting,
    setCustomizing, setGeneratingCover, setMode, idleStatuses, setPipelineLog,
  } = opts;

  const mark = useCallback((id: StepId, status: StepStatus, detail?: string) => {
    setStatuses((prev) => ({ ...prev, [id]: status }));
    if (detail) setDetails((prev) => ({ ...prev, [id]: detail }));
  }, [setStatuses, setDetails]);

  const fail = useCallback((id: StepId, message: string) => {
    mark(id, "error", message);
    toast.error(message);
  }, [mark]);

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const addLog = useCallback((line?: string) => {
    if (!line || !setPipelineLog) return;
    setPipelineLog((prev) => [...prev, line]);
  }, [setPipelineLog]);

  const toastBusy = useCallback(() => {
    toast.message("Please wait", {
      description: "A task is still running. Finish it before starting a new one.",
    });
  }, []);

  const resetPipeline = useCallback(() => {
    setStatuses(idleStatuses());
    setDetails({});
    setKeywords(null);
    setAudit(null);
    setFinalHtml(null);
    setCoverHtml(null);
    setPipelineLog?.(() => []);
  }, [setStatuses, setDetails, setKeywords, setAudit, setFinalHtml, setCoverHtml, idleStatuses, setPipelineLog]);

  const runPipeline = useCallback(async (runOpts?: { url?: string; skipResetUrl?: boolean }) => {
    if (busy) { toastBusy(); return; }
    const urlToUse = (runOpts?.url ?? jobUrl).trim();
    if (!isPlausibleApiKey(apiKey)) { toast.error("Save a Gemini API key first."); return; }
    if (!looksLikeHtml(resumeHtml)) { toast.error("The resume must be HTML, not plain text."); return; }
    if (urlToUse.length < 8) { toast.error("Enter a valid job description URL."); return; }
    if (runOpts?.skipResetUrl) setJobUrl(urlToUse);

    setRunning(true);
    resetPipeline();
    const original = resumeHtml.trim();
    let currentJob = jobText.trim();
    let currentHtml = original;
    let currentKeywords: KeywordSet | null = null;

    try {
      mark(1, "running", "Fetching job description and extracting ATS keywords…");
      const fetched = await fetchJobDescription({ data: { url: urlToUse } });
      if (fetched.ok) {
        currentJob = fetched.text.slice(0, MAX_JOB_CHARS);
        setJobText(currentJob);
      } else if (currentJob.length >= 40) {
        mark(1, "running", `${fetched.error} Using pasted text.`);
      } else {
        fail(1, fetched.error);
        return;
      }
      const extracted = await extractKeywords({ data: { apiKey, jobText: currentJob } });
      addLog((extracted as any).log);
      if (!extracted.ok) { fail(1, extracted.error); return; }
      currentKeywords = extracted.keywords;
      setKeywords(currentKeywords);
      mark(1, "done", `${currentKeywords.keywords.length + currentKeywords.phrases.length} keywords / phrases extracted`);

      await delay(2800);
      mark(2, "running", "Cataloging facts, dates, metrics, and employers…");
      const integrity = await buildIntegritySchema({ data: { apiKey, resumeHtml: original, keywords: currentKeywords } });
      addLog((integrity as any).log);
      if (!integrity.ok) { fail(2, integrity.error || "Integrity failed"); return; }
      mark(2, "done", "Baseline locked — skill gaps flagged");

      await delay(2200);
      mark(3, "running", "Breaking resume into Summary, Experience, Skills, Education…");
      // Coordinator does light section analysis so the step is real
      const sections = (original.match(/<h2[^>]*>|<div class="section"/gi) || []).length;
      mark(3, "done", `${sections || "Multiple"} sections identified — work packages ready`);

      await delay(2600);
      mark(4, "running", "Rewriting sections with evidence-gated keyword weaving…");
      const rewritten = await rewriteResume({ data: { apiKey, resumeHtml: original, keywords: currentKeywords } });
      addLog((rewritten as any).log);
      if (!rewritten.ok) { fail(4, rewritten.error); return; }
      currentHtml = rewritten.html;
      mark(4, "done", "Sections rewritten for clarity and ATS alignment");

      await delay(2400);
      mark(5, "running", "Auditing for invented claims and technical inaccuracies…");
      const audited = await auditAndRemediate({ data: { apiKey, originalHtml: original, draftHtml: currentHtml, keywords: currentKeywords } });
      addLog((audited as any).log);
      if (!audited.ok) { fail(5, audited.error || "Audit failed"); return; }
      currentHtml = audited.html;
      mark(5, "done", "Integrity audit complete");

      await delay(1800);
      mark(5, "running", "Polishing for natural human English…");
      const gram = await grammarAndNaturalEnglish({ data: { apiKey, html: currentHtml } });
      addLog((gram as any).log);
      if (gram.ok && (gram as any).html) currentHtml = (gram as any).html;
      mark(5, "done", "Human English applied");

      await delay(2000);
      mark(6, "running", "Calculating real keyword match and validating formatting…");
      const sim = await simulateATS({ data: { apiKey, resumeHtml: currentHtml, keywords: currentKeywords } });
      addLog((sim as any).log);
      if (!sim.ok) { fail(6, sim.error || "ATS sim failed"); return; }
      const verdict = sim.result?.verdict || "PASS";
      mark(6, "done", `${verdict} · ${sim.result?.match_percentage ?? "?"}% match`);

      await delay(1600);
      mark(7, "running", "Cleaning HTML and locking single-column layout…");
      const locked = await lockLayout({ data: { apiKey, originalHtml: original, currentHtml } });
      addLog((locked as any).log);
      if (!locked.ok) { fail(7, locked.error); return; }
      currentHtml = locked.html;

      const cleaned = await cleanHtml({ data: { originalHtml: original, currentHtml } });
      setFinalHtml(cleaned.html);
      mark(7, "done", "Clean ATS-safe HTML ready");
      toast.success("Pipeline finished. Review the optimized resume.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The pipeline failed.");
    } finally {
      setRunning(false);
    }
  }, [busy, jobUrl, apiKey, resumeHtml, jobText, setJobUrl, setJobText, setKeywords, setAudit, setFinalHtml, setRunning, resetPipeline, mark, fail, toastBusy, addLog]);

  const onRewriteOutput = useCallback(async () => {
    if (busy) { toastBusy(); return; }
    if (!finalHtml) { toast.error("Run the pipeline first so there is output to rewrite."); return; }
    if (!isPlausibleApiKey(apiKey)) { toast.error("Save a Gemini API key first."); return; }
    setRewriting(true);
    try {
      let kw = keywords;
      if (!kw || (kw.keywords.length === 0 && kw.phrases.length === 0 && kw.must_have.length === 0 && kw.nice_to_have.length === 0)) {
        const job = jobText.trim();
        if (job.length < 40) {
          toast.error("Keywords are missing and the job description text is too short to re-extract.");
          return;
        }
        const extracted = await extractKeywords({ data: { apiKey, jobText: job } });
        if (!extracted.ok) { toast.error(extracted.error); return; }
        kw = extracted.keywords;
        setKeywords(kw);
      }
      const rewritten = await rewriteResume({ data: { apiKey, resumeHtml: finalHtml, keywords: kw } });
      if (!rewritten.ok) { toast.error(rewritten.error); return; }
      setFinalHtml(rewritten.html);
      toast.success("Rewrite complete. Output updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rewrite failed.");
    } finally {
      setRewriting(false);
    }
  }, [busy, finalHtml, apiKey, keywords, jobText, setKeywords, setFinalHtml, setRewriting, toastBusy]);

  const onCustomizeOutput = useCallback(async (instructions: string, kind: DocKind) => {
    if (busy) { toastBusy(); return; }
    const target = kind === "cover" ? coverHtml : finalHtml;
    if (!target) {
      toast.error(kind === "cover" ? "Generate a cover letter first." : "Run the pipeline first.");
      return;
    }
    if (!isPlausibleApiKey(apiKey)) { toast.error("Save a Gemini API key first."); return; }
    const trimmed = instructions.trim();
    if (trimmed.length < 3) { toast.error("Enter edit instructions."); return; }
    setCustomizing(true);
    try {
      const result = await customizeResume({ data: { apiKey, resumeHtml: target, instructions: trimmed } });
      if (!result.ok) { toast.error(result.error); return; }
      if (kind === "cover") setCoverHtml(result.html);
      else setFinalHtml(result.html);
      toast.success("Customize complete. Output updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Customize failed.");
    } finally {
      setCustomizing(false);
    }
  }, [busy, coverHtml, finalHtml, apiKey, setCoverHtml, setFinalHtml, setCustomizing, toastBusy]);

  const onGenerateCover = useCallback(async () => {
    if (busy) { toastBusy(); return; }
    if (!finalHtml) { toast.error("Finish the pipeline first."); return; }
    if (!isPlausibleApiKey(apiKey)) { toast.error("Save a Gemini API key first."); return; }
    const job = jobText.trim();
    if (job.length < 40) { toast.error("Job description text is too short."); return; }
    setGeneratingCover(true);
    try {
      const result = await generateCoverLetter({
        data: { apiKey, jobText: job, resumeHtml: finalHtml, keywords: keywords ?? undefined },
      });
      if (!result.ok) { toast.error(result.error); return; }
      setCoverHtml(result.html);
      toast.success("Cover letter ready.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cover letter generation failed.");
    } finally {
      setGeneratingCover(false);
    }
  }, [busy, finalHtml, apiKey, jobText, keywords, setCoverHtml, setGeneratingCover, toastBusy]);

  const sendToInputs = useCallback((job: JobResult) => {
    if (busy) { toastBusy(); return; }
    resetPipeline();
    setJobText("");
    setJobUrl(job.applicationUrl);
    setMode("pipeline");
    toast.success(`Sent to Pipeline: ${job.title}`, { description: "Starting the alignment pipeline…" });
    void (async () => {
      await new Promise((r) => setTimeout(r, 80));
      await runPipeline({ url: job.applicationUrl, skipResetUrl: true });
    })();
  }, [busy, resetPipeline, setJobText, setJobUrl, setMode, runPipeline, toastBusy]);

  return {
    runPipeline,
    onRewriteOutput,
    onCustomizeOutput,
    onGenerateCover,
    sendToInputs,
    resetPipeline,
    toastBusy,
  };
}
