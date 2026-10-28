import type { JSONContent } from "@tiptap/core";
import { appendTranscript } from "./dictation";

/**
 * The composer's draft: typed or dictated text plus formula boxes. Text may hold
 * "\n". A formula is sent as `$latex$`; `spoken` is what was said, for Undo math.
 */
export type DraftText = { type: "text"; text: string };
export type DraftFormula = { type: "formula"; id: string; latex: string; spoken: string };
export type DraftPart = DraftText | DraftFormula;
export type Draft = DraftPart[];

/** What the dictation endpoint returns: formulas have no id yet. */
export type SpokenPart = DraftText | { type: "formula"; latex: string; spoken: string };

export function emptyDraft(): Draft {
  return [];
}

export function textDraft(text: string): Draft {
  return text ? [{ type: "text", text }] : [];
}

export function isDraftEmpty(draft: Draft): boolean {
  return draft.every((part) => part.type === "text" && !part.text.trim());
}

function newId(): string {
  return crypto.randomUUID();
}

/** Joins neighbouring text parts and drops empty ones. */
function tidy(parts: DraftPart[]): Draft {
  const out: Draft = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (!part.text) continue;
      const last = out[out.length - 1];
      if (last?.type === "text") {
        out[out.length - 1] = { type: "text", text: last.text + part.text };
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

/** Strips anything that would break the `$…$` delimiters. */
export function cleanLatex(latex: string): string {
  let out = latex.trim();
  for (const [left, right] of [
    ["$$", "$$"],
    ["\\[", "\\]"],
    ["\\(", "\\)"],
    ["$", "$"],
  ] as const) {
    if (out.length > left.length + right.length && out.startsWith(left) && out.endsWith(right)) {
      out = out.slice(left.length, -right.length).trim();
    }
  }
  return out.replace(/\$/g, "").trim();
}

const TOUCHES_MATH = /[\w$]/;

/**
 * The message text. A formula becomes `$latex$`, with a space added where a
 * neighbouring word character or formula would break the `$` pairing rules.
 */
export function serializeDraft(draft: Draft): string {
  let out = "";
  draft.forEach((part, index) => {
    if (part.type === "text") {
      out += part.text;
      return;
    }
    const latex = cleanLatex(part.latex);
    if (!latex) return;
    if (out && TOUCHES_MATH.test(out[out.length - 1] ?? "")) out += " ";
    out += `$${latex}$`;
    const next = draft[index + 1];
    const nextChar = next?.type === "text" ? next.text[0] : next ? "$" : undefined;
    if (nextChar && TOUCHES_MATH.test(nextChar)) out += " ";
  });
  return out;
}

/**
 * Appends dictated parts at the end of the draft. Spacing at the join follows
 * `appendTranscript`: one space unless the draft is empty or already ends in
 * whitespace. Spacing inside the dictation is kept as transcribed.
 */
export function appendDictation(draft: Draft, spoken: SpokenPart[]): Draft {
  const incoming: Draft = tidy(
    spoken.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "formula", id: newId(), latex: part.latex, spoken: part.spoken },
    ),
  );
  const first = incoming[0];
  if (first?.type === "text") incoming[0] = { type: "text", text: first.text.trimStart() };
  const lastIndex = incoming.length - 1;
  const last = incoming[lastIndex];
  if (last?.type === "text") incoming[lastIndex] = { type: "text", text: last.text.trimEnd() };
  const additions = tidy(incoming);
  if (additions.length === 0) return draft;

  const head = draft.slice(0, -1);
  const tail = draft[draft.length - 1];
  const lead = additions[0];
  if (lead?.type === "text") {
    // appendTranscript trims what it appends; keep the space before a following formula.
    const trailing = additions.length > 1 ? (/\s*$/.exec(lead.text)?.[0] ?? "") : "";
    const joined = appendTranscript(tail?.type === "text" ? tail.text : "", lead.text) + trailing;
    const base = tail?.type === "text" ? head : draft;
    const separator = tail?.type === "formula" ? " " : "";
    return tidy([...base, { type: "text", text: separator + joined }, ...additions.slice(1)]);
  }
  const needsSpace =
    tail !== undefined && (tail.type === "formula" || !/\s$/.test(tail.text));
  return tidy([...draft, ...(needsSpace ? [{ type: "text" as const, text: " " }] : []), ...additions]);
}

/** Text to ProseMirror inline nodes: newlines become hard breaks. */
export function textNodes(text: string): JSONContent[] {
  const nodes: JSONContent[] = [];
  text.split("\n").forEach((line, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (line) nodes.push({ type: "text", text: line });
  });
  return nodes;
}

export function draftToDoc(draft: Draft): JSONContent {
  const content: JSONContent[] = [];
  for (const part of draft) {
    if (part.type === "text") content.push(...textNodes(part.text));
    else
      content.push({
        type: "formula",
        attrs: { id: part.id, latex: part.latex, spoken: part.spoken },
      });
  }
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

export function docToDraft(doc: JSONContent): Draft {
  const parts: DraftPart[] = [];
  (doc.content ?? []).forEach((block, index) => {
    if (index > 0) parts.push({ type: "text", text: "\n" });
    for (const node of block.content ?? []) {
      if (node.type === "text") parts.push({ type: "text", text: node.text ?? "" });
      else if (node.type === "hardBreak") parts.push({ type: "text", text: "\n" });
      else if (node.type === "formula") {
        const attrs = node.attrs ?? {};
        parts.push({
          type: "formula",
          id: typeof attrs.id === "string" && attrs.id ? attrs.id : newId(),
          latex: typeof attrs.latex === "string" ? attrs.latex : "",
          spoken: typeof attrs.spoken === "string" ? attrs.spoken : "",
        });
      }
    }
  });
  return tidy(parts);
}
