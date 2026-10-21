import { useRef, useState } from "react";
import { FileUp, Eye, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isPlausibleApiKey } from "@/lib/api-key-store";
import { convertPdfToHtml } from "@/lib/convert-pdf";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Props = {
  apiKey: string;
  resumeHtml: string;
  setResumeHtml: (html: string) => void;
  busy: boolean;
  convertingPdf: boolean;
  setConvertingPdf: (v: boolean) => void;
};

export function PdfConvertButton({
  apiKey,
  resumeHtml,
  setResumeHtml,
  busy,
  convertingPdf,
  setConvertingPdf,
}: Props) {
  const pdfRef = useRef<HTMLInputElement>(null);
  const [pdfDialogOpen, setPdfDialogOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pdfFileName, setPdfFileName] = useState("");

  async function onConvertPdf(file: File | undefined) {
    if (!file) return;
    if (busy) {
      toast.message("Please wait", { description: "Another task is still running." });
      return;
    }
    if (!isPlausibleApiKey(apiKey)) {
      toast.error("Save a Gemini API key first.");
      return;
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Please upload a PDF file.");
      return;
    }
    if (file.size > 8_000_000) {
      toast.error("PDF is too large (max 8MB).");
      return;
    }

    setConvertingPdf(true);
    setPdfFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const pdfBase64 = btoa(binary);

      const result = await convertPdfToHtml({ data: { apiKey, pdfBase64 } });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setResumeHtml(result.html);
      setPdfDialogOpen(false);
      setPdfFileName("");
      toast.success("PDF converted to HTML resume.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "PDF conversion failed.");
    } finally {
      setConvertingPdf(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9"
              disabled={busy}
              onClick={() => setPdfDialogOpen(true)}
            >
              <FileUp className="size-3.5" /> Convert your PDF to HTML
            </Button>
          </TooltipTrigger>
          <TooltipContent>Upload your PDF to convert it to HTML code</TooltipContent>
        </Tooltip>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 w-fit"
            disabled={!resumeHtml.trim() || convertingPdf}
            onClick={() => setPreviewOpen(true)}
          >
            <Eye className="size-3.5" /> Preview resume
          </Button>
        </TooltipTrigger>
        <TooltipContent>See your converted or loaded resume to ensure it’s accurate</TooltipContent>
      </Tooltip>

      <Dialog open={pdfDialogOpen} onOpenChange={(open) => { if (!convertingPdf) setPdfDialogOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Convert PDF to HTML</DialogTitle>
            <DialogDescription>
              Upload a PDF resume. It is parsed with AI into HTML using the design template layout. Unmatched sections are added with the same theme.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <input
              ref={pdfRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                void onConvertPdf(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={convertingPdf || !isPlausibleApiKey(apiKey)}
              onClick={() => pdfRef.current?.click()}
            >
              {convertingPdf ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <FileUp className="size-4" />
              )}
              {convertingPdf
                ? `Converting${pdfFileName ? ` ${pdfFileName}` : ""}…`
                : "Choose PDF"}
            </Button>
            {!apiKey ? (
              <p className="text-xs text-muted-foreground">
                A Gemini API key is required. Save one under API keys in the header.
              </p>
            ) : null}
            {convertingPdf ? (
              <p className="text-xs text-muted-foreground">
                Parsing PDF and generating HTML. This may take up to a minute.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={convertingPdf}
              onClick={() => setPdfDialogOpen(false)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Resume preview</DialogTitle>
            <DialogDescription className="sr-only">
              Live preview of the resume HTML
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-2">
            {resumeHtml.trim() ? (
              <iframe
                title="Resume preview"
                sandbox=""
                srcDoc={resumeHtml}
                className="h-[min(75vh,900px)] w-full rounded-md bg-white"
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">No resume HTML to preview.</p>
            )}
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <Button type="button" variant="outline" onClick={() => setPreviewOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
