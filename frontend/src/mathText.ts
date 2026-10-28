import type { KatexOptions } from "katex";

/** Shared by the thread (rehype-katex) and the composer chips. `trust: false` blocks \href and friends. */
export const KATEX_OPTIONS = {
  strict: "ignore",
  trust: false,
  maxExpand: 1000,
  errorColor: "var(--danger)",
} satisfies KatexOptions;

const FENCE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/;
const LINE_PREFIX = /^([ \t]*(?:>[ \t]?)*)([-*+][ \t]+|\d{1,9}[.)][ \t]+)?/;

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** Index of the next unescaped `delim` at or after `from`, or -1 if a blank line comes first. */
function findClose(text: string, from: number, delim: string): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (text.startsWith(delim, i)) return i;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "\n" && /^\n[ \t>]*\n/.test(text.slice(i, i + 64))) return -1;
  }
  return -1;
}

/** Pandoc rule: a closing `$` has non-space on its left and no digit on its right. */
function findInlineClose(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const at = findClose(text, i, "$");
    if (at === -1) return -1;
    if (text[at + 1] === "$") {
      i = at + 2;
      continue;
    }
    if (!isSpace(text[at - 1]) && !/\d/.test(text[at + 1] ?? "")) return at;
    i = at + 1;
  }
  return -1;
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(text: string, index: number): number {
  const end = text.indexOf("\n", index);
  return end === -1 ? text.length : end;
}

/**
 * Display math. Alone on its line(s) it becomes a `$$` fence block so remark-math
 * renders it in display mode, keeping any blockquote or list prefix. Mid-sentence
 * it stays `$$…$$`, which remark-math renders inline.
 */
function displayMath(text: string, open: number, openLen: number, close: number, closeLen: number): string {
  const inner = text.slice(open + openLen, close);
  const start = lineStart(text, open);
  const lead = text.slice(start, open);
  const prefix = LINE_PREFIX.exec(lead);
  const alone =
    prefix !== null &&
    prefix[0].length === lead.length &&
    text.slice(close + closeLen, lineEnd(text, close + closeLen)).trim() === "";
  if (!alone || prefix === null) return `$$${inner.trim()}$$`;
  const cont = prefix[1] + " ".repeat(prefix[2]?.length ?? 0);
  const lines = inner.split("\n");
  const first = lines[0] ?? "";
  const body: string[] = [];
  if (first.trim() !== "") body.push(cont + first.trimStart());
  body.push(...lines.slice(1));
  if (body.length > 1 && /^[\s>]*$/.test(body[body.length - 1] ?? "")) body.pop();
  return `$$\n${body.join("\n")}\n${cont}$$`;
}

function normalizeProse(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      let close = text.indexOf(ticks, i + run);
      while (close !== -1 && text[close + run] === "`") {
        let skip = close;
        while (text[skip] === "`") skip++;
        close = text.indexOf(ticks, skip);
      }
      if (close === -1) {
        out += ticks;
        i += run;
      } else {
        out += text.slice(i, close + run);
        i = close + run;
      }
      continue;
    }
    if (ch === "\\" && next === "\\") {
      out += "\\\\";
      i += 2;
      continue;
    }
    if (ch === "\\" && next === "$") {
      out += "\\$";
      i += 2;
      continue;
    }
    if (ch === "\\" && next === "(") {
      const close = findClose(text, i + 2, "\\)");
      const inner = close === -1 ? "" : text.slice(i + 2, close).trim();
      if (inner) {
        out += `$${inner}$`;
        i = close + 2;
        continue;
      }
    }
    if (ch === "\\" && next === "[") {
      const close = findClose(text, i + 2, "\\]");
      if (close !== -1 && text.slice(i + 2, close).trim()) {
        out += displayMath(text, i, 2, close, 2);
        i = close + 2;
        continue;
      }
    }
    if (ch === "$" && next === "$") {
      const close = findClose(text, i + 2, "$$");
      if (close !== -1 && text.slice(i + 2, close).trim()) {
        out += displayMath(text, i, 2, close, 2);
        i = close + 2;
        continue;
      }
      out += "\\$\\$";
      i += 2;
      continue;
    }
    if (ch === "$") {
      const close = isSpace(next) ? -1 : findInlineClose(text, i + 1);
      if (close !== -1) {
        out += text.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      out += "\\$";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Display-only rewrite before Markdown parsing; stored content is never changed.
 * remark-math treats any `$…$` as math (so "$5 and $10" breaks) and does not know
 * `\(…\)` or `\[…\]`. This pass decides which dollars are math using pandoc's rules,
 * escapes the rest, converts the backslash delimiters, and leaves code untouched.
 */
export function normalizeMath(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; size: number } | null = null;
  const flush = () => {
    if (prose.length > 0) out.push(normalizeProse(prose.join("\n")));
    prose = [];
  };
  for (const line of lines) {
    if (fence) {
      out.push(line);
      const closing = FENCE.exec(line);
      if (
        closing &&
        closing[1]?.[0] === fence.char &&
        (closing[1]?.length ?? 0) >= fence.size &&
        line.slice(closing[0].length).trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    const opening = FENCE.exec(line);
    if (opening && opening[1]) {
      flush();
      fence = { char: opening[1][0] ?? "`", size: opening[1].length };
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join("\n");
}

function texOf(element: Element): string | null {
  return element.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null;
}

const BLOCK_TAGS = new Set(["P", "LI", "DIV", "PRE", "TR", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * Selection text for Fork from this / Explain this. Rendered KaTeX selects as a
 * jumble of glyphs plus MathML, so each formula is quoted back as its LaTeX.
 * Returns null when the range touches no math, and the caller keeps `toString()`.
 */
export function selectionText(range: Range): string | null {
  const root = range.commonAncestorContainer;
  const rootElement = root instanceof Element ? root : root.parentElement;
  if (!rootElement) return null;
  const touches =
    rootElement.closest(".katex") !== null ||
    Array.from(rootElement.querySelectorAll(".katex")).some((node) => range.intersectsNode(node));
  if (!touches) return null;

  const expanded = range.cloneRange();
  const startMath = (expanded.startContainer instanceof Element
    ? expanded.startContainer
    : expanded.startContainer.parentElement
  )?.closest(".katex-display, .katex");
  if (startMath) expanded.setStartBefore(startMath);
  const endMath = (expanded.endContainer instanceof Element
    ? expanded.endContainer
    : expanded.endContainer.parentElement
  )?.closest(".katex-display, .katex");
  if (endMath) expanded.setEndAfter(endMath);

  const fragment = expanded.cloneContents();
  const holder = document.createElement("div");
  holder.appendChild(fragment);
  for (const math of Array.from(holder.querySelectorAll(".katex-display"))) {
    const tex = texOf(math);
    math.replaceWith(document.createTextNode(tex === null ? "" : `\n$$${tex}$$\n`));
  }
  for (const math of Array.from(holder.querySelectorAll(".katex"))) {
    const tex = texOf(math);
    math.replaceWith(document.createTextNode(tex === null ? "" : `$${tex}$`));
  }
  let text = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    node.childNodes.forEach(walk);
    if (node instanceof Element && BLOCK_TAGS.has(node.tagName)) text += "\n";
  };
  walk(holder);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

const MATH_SPAN = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/;

/** Applies `transform` only to the text outside `$…$` / `$$…$$` spans. */
export function outsideMath(text: string, transform: (prose: string) => string): string {
  return text
    .split(MATH_SPAN)
    .map((piece, index) => (index % 2 === 1 ? piece : transform(piece)))
    .join("");
}
