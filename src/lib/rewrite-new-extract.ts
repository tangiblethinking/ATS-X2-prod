/**
 * Pure helpers for the new Rewrite path (no AI, no DOM, no side effects).
 *
 * The model answers Phase 1 (scores), Phase 2 (recommendations) and Phase 3
 * (the rewritten HTML) in one response. These helpers only locate the final
 * HTML block and return it byte-for-byte; they never change tags or text, so
 * every <strong>/<b> the model wrote reaches the HTML box unchanged.
 */

export type RewriteExtraction =
  | { ok: true; html: string; report: string }
  | { ok: false; error: string };

/** Builds the single user message: the saved prompt, then the resume HTML. */
export function buildRewriteMessage(prompt: string, resumeHtml: string): string {
  const sep = prompt.endsWith("\n") ? "\n" : "\n\n";
  return `${prompt}${sep}${resumeHtml}`;
}

const FENCE_RE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;

function looksHtml(s: string): boolean {
  return /<(?:!doctype|html|body|div|section|header|main|article|p|ul|ol|li|h[1-6]|table|span|strong|b)\b/i.test(s);
}

/**
 * Returns the final HTML block from the model reply plus the text before it
 * (scores and recommendations). Order of preference:
 *  1. the last fenced code block whose content is HTML (```html ... ``` or ``` ... ```)
 *  2. the last full document (<!DOCTYPE ...> or <html ...> through </html>)
 *  3. from the first HTML tag line after the last "Phase 3" mention (or the
 *     first tag line in the reply) through the last closing tag
 */
export function extractRewriteOutput(reply: string): RewriteExtraction {
  const text = reply ?? "";
  if (!text.trim()) return { ok: false, error: "The model returned an empty response." };

  // 1. fenced blocks
  let last: { start: number; end: number; body: string } | null = null;
  for (const m of text.matchAll(FENCE_RE)) {
    const lang = (m[1] || "").toLowerCase();
    const body = m[2];
    if ((lang === "html" || lang === "" || lang === "xml") && looksHtml(body)) {
      last = { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, body };
    }
  }
  if (last) {
    return finish(last.body, text.slice(0, last.start) + text.slice(last.end));
  }

  // 2. full documents (unfenced)
  const docStarts = [...text.matchAll(/<!doctype\s+html[^>]*>|<html[\s>]/gi)];
  if (docStarts.length > 0) {
    const startMatch = docStarts[docStarts.length - 1];
    let start = startMatch.index ?? 0;
    // if the last <html> is preceded by its own <!DOCTYPE>, start at the doctype
    const before = text.slice(0, start);
    const dt = before.match(/<!doctype\s+html[^>]*>\s*$/i);
    if (dt && dt.index !== undefined) start = dt.index;
    const endIdx = text.toLowerCase().lastIndexOf("</html>");
    if (endIdx > start) {
      const end = endIdx + "</html>".length;
      return finish(text.slice(start, end), text.slice(0, start) + text.slice(end));
    }
  }

  // 3. bare HTML fragment
  const phase3 = text.search(/phase\s*3[^\n]*\n(?![\s\S]*phase\s*3)/i);
  const from = phase3 >= 0 ? phase3 : 0;
  const tagLine = /^[ \t]*<(?!\/)[a-z!][^>]*>/gim;
  tagLine.lastIndex = from;
  const first = tagLine.exec(text);
  if (first) {
    const start = first.index;
    const lastClose = text.lastIndexOf(">");
    if (lastClose > start) {
      const end = lastClose + 1;
      const frag = text.slice(start, end);
      if (looksHtml(frag)) return finish(frag, text.slice(0, start) + text.slice(end));
    }
  }

  return { ok: false, error: "The model reply did not contain an HTML document." };
}

function finish(html: string, rest: string): RewriteExtraction {
  const out = html.trim();
  if (out.length < 40 || !looksHtml(out)) {
    return { ok: false, error: "The HTML in the model reply was empty or too short." };
  }
  return { ok: true, html: out, report: rest.trim() };
}
