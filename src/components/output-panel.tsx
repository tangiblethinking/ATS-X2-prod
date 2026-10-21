import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  Pencil,
  Printer,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AuditResult, KeywordSet } from "@/lib/pipeline-types";

export type DocKind = "resume" | "cover";

type Props = {
  html: string | null;
  coverHtml: string | null;
  keywords: KeywordSet | null;
  audit: AuditResult | null;
  pipelineComplete?: boolean;
  rewriting?: boolean;
  customizing?: boolean;
  generatingCover?: boolean;
  busy?: boolean;
  onRewrite?: () => void;
  onCustomize?: (instructions: string, kind: DocKind) => void;
  onGenerateCover?: () => void;
  onHtmlChange?: (kind: DocKind, html: string) => void;
};

async function copyText(label: string, value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`);
  } catch {
    toast.error("Could not copy. Select the text instead.");
  }
}

function downloadHtml(html: string, filename: string) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function withPrintHints(html: string): string {
  const printCss = `
@media print {
  html, body {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  @page {
    size: letter;
    margin: 0.4in;
  }
}
`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `<style data-ats-print>${printCss}</style></head>`);
  }
  if (/<html\b/i.test(html)) {
    return html.replace(
      /<html\b[^>]*>/i,
      (m) => `${m}<head><meta charset="utf-8"><style data-ats-print>${printCss}</style></head>`,
    );
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style data-ats-print>${printCss}</style></head><body>${html}</body></html>`;
}

function openDocForPrint(html: string, title: string) {
  const docHtml = withPrintHints(html);
  const win = window.open("", "_blank");
  if (!win) {
    toast.error("Pop-up blocked. Allow pop-ups for this site, then try again.");
    return;
  }
  win.document.open();
  win.document.write(docHtml);
  win.document.close();
  win.document.title = title;
  const runPrint = () => {
    try {
      win.focus();
      win.print();
    } catch {
      toast.message("Opened in a new tab — use Print → Save as PDF.");
    }
  };
  if (win.document.readyState === "complete") {
    window.setTimeout(runPrint, 400);
  } else {
    win.addEventListener("load", () => window.setTimeout(runPrint, 400));
    window.setTimeout(runPrint, 1500);
  }
  toast.success('Print dialog opened — choose "Save as PDF".');
}

function openDocInTab(html: string, title: string) {
  const docHtml = withPrintHints(html);
  const win = window.open("", "_blank");
  if (!win) {
    toast.error("Pop-up blocked. Allow pop-ups for this site, then try again.");
    return;
  }
  win.document.open();
  win.document.write(docHtml);
  win.document.close();
  win.document.title = title;
  win.focus();
  toast.success("Opened in a new tab.");
}

export function OutputPanel({
  html,
  coverHtml,
  keywords,
  audit,
  pipelineComplete = false,
  rewriting = false,
  customizing = false,
  generatingCover = false,
  busy = false,
  onRewrite,
  onCustomize,
  onGenerateCover,
  onHtmlChange,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [docTab, setDocTab] = useState<DocKind>("resume");

  if (!html && !keywords && !coverHtml) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-xl bg-secondary/60 px-6 py-10 text-center">
        <p className="font-display text-lg text-foreground">No output yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Save an API key, add a job URL and your resume HTML, then run the
          six-step pipeline.
        </p>
      </div>
    );
  }

  const isCover = docTab === "cover";

  function submitCustomize() {
    const trimmed = instructions.trim();
    if (trimmed.length < 3) {
      toast.error("Enter edit instructions.");
      return;
    }
    setCustomizeOpen(false);
    onCustomize?.(trimmed, docTab);
    setInstructions("");
  }

  return (
    <>
      <Tabs value={docTab} onValueChange={(v) => {
        const next = v as DocKind;
        setDocTab(next);
        if (next === "cover" && !coverHtml && pipelineComplete && !busy && html) {
          onGenerateCover?.();
        }
      }} className="min-w-0">
        <TabsList className="mb-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="resume">Resume</TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>The Generated Resume</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="cover">Cover Letter</TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>{coverHtml ? "The generated cover letter" : "None generated — select to generate"}</TooltipContent>
          </Tooltip>
        </TabsList>

        <TabsContent value="resume" className="mt-0">
          <DocWorkspace
            html={html}
            keywords={keywords}
            audit={audit}
            showPostActions={Boolean(pipelineComplete && html)}
            busy={busy}
            rewriting={rewriting}
            customizing={customizing}
            generatingCover={generatingCover}
            copied={copied}
            setCopied={setCopied}
            onRewrite={onRewrite}
            onOpenCustomize={() => {
              if (busy) return;
              setCustomizeOpen(true);
            }}
            onHtmlChange={(next) => onHtmlChange?.("resume", next)}
            downloadName="resume-ats.html"
            docTitle="resume-ats"
            emptyPreview="Preview appears after the pipeline finishes."
            emptyHtml="Clean HTML appears in step 6."
          />
        </TabsContent>

        <TabsContent value="cover" className="mt-0">
          {!coverHtml ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl bg-secondary/60 px-6 py-10 text-center">
              <p className="font-display text-lg text-foreground">No cover letter yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Generate a cover letter from the job description and aligned resume. Requires a finished pipeline.
              </p>
              <Button
                type="button"
                disabled={!pipelineComplete || busy || !html}
                onClick={() => onGenerateCover?.()}
              >
                {generatingCover ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <FileText className="size-4" />
                )}
                {generatingCover ? "Generating…" : "Generate cover letter"}
              </Button>
            </div>
          ) : (
            <DocWorkspace
              html={coverHtml}
              keywords={keywords}
              audit={audit}
              showPostActions={Boolean(pipelineComplete && coverHtml)}
              busy={busy}
              rewriting={rewriting}
              customizing={customizing}
              generatingCover={generatingCover}
              copied={copied}
              setCopied={setCopied}
              onRewrite={onRewrite}
              onOpenCustomize={() => {
                if (busy) return;
                setCustomizeOpen(true);
              }}
              onHtmlChange={(next) => onHtmlChange?.("cover", next)}
              downloadName="cover-letter.html"
              docTitle="cover-letter"
              emptyPreview="Cover letter preview."
              emptyHtml="Cover letter HTML."
              onRegenerate={onGenerateCover}
              regenerating={generatingCover}
            />
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={customizeOpen} onOpenChange={setCustomizeOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Customize output</DialogTitle>
            <DialogDescription>
              Describe text and/or layout changes for the current {isCover ? "cover letter" : "resume"} HTML.
              Structure, styles, and section order can be edited when you ask.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="customize-instructions">Edit instructions</Label>
            <Textarea
              id="customize-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value.slice(0, 4000))}
              className="min-h-32"
              placeholder="e.g. Shorten the opening. Soften leadership language. Adjust spacing."
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              {instructions.length.toLocaleString()} / 4,000 characters
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCustomizeOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitCustomize}
              disabled={busy || instructions.trim().length < 3}
            >
              Apply edits
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DocWorkspace({
  html,
  keywords,
  audit,
  showPostActions,
  busy,
  rewriting,
  customizing,
  generatingCover,
  copied,
  setCopied,
  onRewrite,
  onOpenCustomize,
  onHtmlChange,
  downloadName,
  docTitle,
  emptyPreview,
  emptyHtml,
  onRegenerate,
  regenerating,
}: {
  html: string | null;
  keywords: KeywordSet | null;
  audit: AuditResult | null;
  showPostActions: boolean;
  busy: boolean;
  rewriting: boolean;
  customizing: boolean;
  generatingCover: boolean;
  copied: boolean;
  setCopied: (v: boolean) => void;
  onRewrite?: () => void;
  onOpenCustomize: () => void;
  onHtmlChange?: (html: string) => void;
  downloadName: string;
  docTitle: string;
  emptyPreview: string;
  emptyHtml: string;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  const [pane, setPane] = useState(html ? "preview" : "keywords");
  const [draft, setDraft] = useState(html ?? "");

  useEffect(() => {
    setDraft(html ?? "");
  }, [html]);

  const live = draft || html || "";

  function commitDraft() {
    if (!onHtmlChange) return;
    if (draft === (html ?? "")) return;
    onHtmlChange(draft);
  }

  function changePane(next: string) {
    if (pane === "html" && next !== "html") commitDraft();
    setPane(next);
  }

  return (
    <Tabs value={pane} onValueChange={changePane} className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList>
          <Tooltip><TooltipTrigger asChild><TabsTrigger value="preview">Preview</TabsTrigger></TooltipTrigger><TooltipContent>What your resume looks like on screen</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><TabsTrigger value="html">HTML</TabsTrigger></TooltipTrigger><TooltipContent>The code your resume uses</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><TabsTrigger value="keywords">Keywords</TabsTrigger></TooltipTrigger><TooltipContent>The extracted words the generation included in the rewrite</TooltipContent></Tooltip>
        </TabsList>
        {live ? (
          <div className="flex flex-wrap gap-2">
            {showPostActions ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        commitDraft();
                        onRewrite?.();
                      }}
                    >
                      {rewriting ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                      {rewriting ? "Rewriting…" : "Rewrite"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{onRegenerate ? "Regenerate a new cover letter" : "Regenerate a new resume"}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        commitDraft();
                        onOpenCustomize();
                      }}
                    >
                      {customizing ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <Pencil className="size-3.5" />
                      )}
                      {customizing ? "Customizing…" : "Customize"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Describe edits you want directly</TooltipContent>
                </Tooltip>
                {onRegenerate ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => onRegenerate()}
                  >
                    {regenerating ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <FileText className="size-3.5" />
                    )}
                    {regenerating ? "Generating…" : "Regenerate"}
                  </Button>
                ) : null}
              </>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    commitDraft();
                    await copyText("HTML", live);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  Copy HTML
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy the code</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    commitDraft();
                    downloadHtml(live, downloadName);
                  }}
                >
                  <Download className="size-3.5" />
                  HTML
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download your HTML code file</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    commitDraft();
                    openDocInTab(live, docTitle);
                  }}
                >
                  Open
                </Button>
              </TooltipTrigger>
              <TooltipContent>See your resume in a new tab and print it</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="paper"
                  size="sm"
                  onClick={() => {
                    commitDraft();
                    openDocForPrint(live, docTitle);
                  }}
                >
                  <Printer className=size-3.5" />
                  PDF / Print
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open your resume in a new tab and autoprint</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>

      {(rewriting || customizing || generatingCover) && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm">
          <LoaderCircle className="size-4 animate-spin shrink-0" />
          <span className="shimmer-text font-medium">
            {rewriting
              ? "Rewriting output…"
              : customizing
                ? "Customizing…"
                : "Generating cover letter…"}
          </span>
          <span className="text-xs text-muted-foreground">Please wait. Do not start another task.</span>
        </div>
      )}

      <TabsContent value="preview">
        {live ? (
          <div className="overflow-hidden rounded-xl bg-paper shadow-[var(--shadow-border)]">
            <iframe
              title="Document preview"
              sandbox=""
              srcDoc={live}
              className="h-[min(72vh,880px)] w-full bg-paper"
            />
          </div>
        ) : (
          <EmptyNote text={emptyPreview} />
        )}
      </TabsContent>

      <TabsContent value="html">
        {html || draft ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            spellCheck={false}
            disabled={busy}
            className="h-[min(72vh,880px)] resize-none rounded-xl bg-secondary p-4 font-mono text-xs leading-relaxed text-foreground"
            aria-label="Editable document HTML"
          />
        ) : (
          <EmptyNote text={emptyHtml} />
        )}
      </TabsContent>

      <TabsContent value="keywords">
        {keywords ? (
          <div className="flex flex-col gap-5">
            <KeywordGroup title="Must have" items={keywords.must_have} />
            <KeywordGroup title="Phrases" items={keywords.phrases} />
            <KeywordGroup title="Keywords" items={keywords.keywords} />
            <KeywordGroup title="Nice to have" items={keywords.nice_to_have} />
          </div>
        ) : (
          <EmptyNote text="Keywords appear after step 1." />
        )}
      </TabsContent>
    </Tabs>
  );
}

function KeywordGroup({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{title}</p>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <Badge key={item} variant="stone">
            {item}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}
