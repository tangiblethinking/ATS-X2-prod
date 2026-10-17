/**
 * Extract visible text nodes from HTML into stable slots, then re-inject
 * rewritten text without ever asking a model to regenerate the document.
 *
 * Text between tags is replaced with {{t0}}, {{t1}}, … placeholders.
 * The template (all tags, attributes, styles) is returned unchanged.
 */

export type TextSlot = { id: string; text: string };

const TEXT_BETWEEN_TAGS = />([^<]+)</g;

export function extractTextSlots(html: string): { template: string; slots: TextSlot[] } {
  const slots: TextSlot[] = [];
  let i = 0;
  const template = html.replace(TEXT_BETWEEN_TAGS, (full, text: string) => {
    // Skip pure whitespace and very short fragments (punctuation, single chars)
    if (!text.trim() || text.trim().length < 2) return full;
    const id = `t${i++}`;
    slots.push({ id, text });
    return `>{{${id}}}<`;
  });
  return { template, slots };
}

export function injectTextSlots(template: string, rewritten: TextSlot[]): string {
  const byId = new Map(rewritten.map((s) => [s.id, s.text]));
  return template.replace(/\{\{(t\d+)\}\}/g, (full, id: string) => {
    const next = byId.get(id);
    return next != null && next.trim().length > 0 ? next : full;
  });
}

/** Parse model JSON that is expected to be { slots: [{ id, text }] } or a raw array. */
export function parseRewrittenSlots(raw: unknown, original: TextSlot[]): TextSlot[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as any).slots)) {
    list = (raw as any).slots;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as any).texts)) {
    list = (raw as any).texts;
  }

  const byId = new Map<string, string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const text = typeof rec.text === "string" ? rec.text : "";
    if (id && text.trim()) byId.set(id, text);
  }

  // Fall back to original text for any slot the model omitted or emptied
  return original.map((s) => ({
    id: s.id,
    text: byId.get(s.id) ?? s.text,
  }));
}
