import { useCallback } from "react";
import { toast } from "sonner";
import { isPlausibleApiKey } from "@/lib/api-key-store";
import { looksLikeHtml } from "@/lib/html-clean";
import {
  analyzeIntent,
  analyzeResume,
  auditAndQA,
  cleanHtml,
  customizeResume,
  extractKeywords,
  fetchJobDescription,
  generateCoverLetter,
  naturalLanguagePass,
  rewriteResume,
  scannabilityPass,
  terminologyPass,
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
      // 1. Job Spec Scraper
      mark(1, "running", "Collecting full job description text…");
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
      mark(1, "done", `${currentJob.length.toLocaleString()} characters collected`);

      // 2. Intent & Analysis
      mark(2, "running", "Analyzing what the job is looking for…");
      const intentResult = await analyzeIntent({ data: { apiKey, jobText: currentJob } });
      addLog((intentResult as any).log);
      if (!intentResult.ok) { fail(2, intentResult.error); return; }
      mark(2, "done", (intentResult as any).intent?.slice(0, 120) || "Intent analyzed");

      // 3. Keyword & Phrase Extraction
      mark(3, "running", "Extracting keywords and phrases…");
      const extracted = await extractKeywords({ data: { apiKey, jobText: currentJob } });
      addLog((extracted as any).log);
      if (!extracted.ok) { fail(3, extracted.error); return; }
      currentKeywords = extracted.keywords;
      setKeywords(currentKeywords);
      mark(3, "done", `${currentKeywords.keywords.length + currentKeywords.phrases.length} keywords / phrases extracted`);

      // 4. Resume Analysis
      mark(4, "running", "Extracting all information from the resume…");
      const resumeAnalysis = await analyzeResume({ data: { apiKey, resumeHtml: original } });
      addLog((resumeAnalysis as any).log);
      if (!resumeAnalysis.ok) { fail(4, resumeAnalysis.error); return; }
      mark(4, "done", "Resume facts extracted");

      // 5. Keyword Injection Rewrite
      mark(5, "running", "Injecting keywords into existing language…");
      const rewritten = await rewriteResume({ data: { apiKey, resumeHtml: original, keywords: currentKeywords } });
      addLog((rewritten as any).log);
      if (!rewritten.ok) { fail(5, rewritten.error); return; }
      currentHtml = rewritten.html;
      mark(5, "done", "Keywords woven into existing content");

      // 6. Terminology Accuracy Pass
      mark(6, "running", "Checking technical accuracy…");
      const term = await terminologyPass({ data: { apiKey, originalHtml: original, draftHtml: currentHtml } });
      addLog((term as any).log);
      if (!term.ok) { fail(6, term.error || "Terminology pass failed"); return; }
      currentHtml = term.html;
      mark(6, "done", "Terminology verified");

      // 7. Human Natural Language Pass
      mark(7, "running", "Rewriting for natural human English…");
      const natural = await naturalLanguagePass({ data: { apiKey, html: currentHtml } });
      addLog((natural as any).log);
      if (!natural.ok) { fail(7, natural.error || "Natural language pass failed"); return; }
      currentHtml = natural.html;
      mark(7, "done", "Natural language applied");

      // 8. Human Scannability Pass
      mark(8, "running", "Optimizing for human scannability…");
      const scan = await scannabilityPass({ data: { apiKey, html: currentHtml } });
      addLog((scan as any).log);
      if (!scan.ok) { fail(8, scan.error || "Scannability pass failed"); return; }
      currentHtml = scan.html;
      mark(8, "done", "Scannability improved");

      // 9. Inject into Original Layout (already done via slots; confirm)
      mark(9, "running", "Placing rewritten text into original HTML layout…");
      mark(9, "done", "Original layout structure preserved");

      // 10. Audit & QA
      mark(10, "running", "Auditing content and HTML…");
      const audited = await auditAndQA({ data: { apiKey, originalHtml: original, currentHtml, keywords: currentKeywords } });
      addLog((audited as any).log);
      if (!audited.ok) { fail(10, audited.error || "Audit failed"); return; }
      currentHtml = audited.html;
      mark(10, "done", `${(audited as any).flags?.length || 0} issues flagged`);

      // 11. Final HTML
      mark(11, "running", "Preparing final HTML…");
      const cleaned = await cleanHtml({ data: { originalHtml: original, currentHtml } });
      setFinalHtml(cleaned.html);
      mark(11, "done", "Final HTML ready");
      toast.success("Pipeline finished.");
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
