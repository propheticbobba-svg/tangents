import katex from "katex";
import { afterEach, describe, expect, it } from "vitest";
import { forkPreview } from "./ChatPane";
import { normalizeMath, outsideMath, selectionText } from "./mathText";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("normalizeMath", () => {
  it("keeps a valid inline pair", () => {
    expect(normalizeMath("area is $x^2$ here")).toBe("area is $x^2$ here");
  });

  it("escapes currency", () => {
    expect(normalizeMath("costs $5 and $10 total")).toBe("costs \\$5 and \\$10 total");
    expect(normalizeMath("$5, $10, and $15.")).toBe("\\$5, \\$10, and \\$15.");
  });

  it("refuses a closing dollar followed by a digit or preceded by a space", () => {
    expect(normalizeMath("$x$2")).toBe("\\$x\\$2");
    expect(normalizeMath("$x $")).toBe("\\$x \\$");
    expect(normalizeMath("$ x$")).toBe("\\$ x\\$");
  });

  it("keeps escaped dollars", () => {
    expect(normalizeMath("price \\$5")).toBe("price \\$5");
  });

  it("converts backslash parens to dollars", () => {
    expect(normalizeMath("so \\( a_i + b \\) holds")).toBe("so $a_i + b$ holds");
  });

  it("turns display math alone on a line into a fence block", () => {
    expect(normalizeMath("$$x^2$$")).toBe("$$\nx^2\n$$");
    expect(normalizeMath("\\[\nx^2\n\\]")).toBe("$$\nx^2\n$$");
    expect(normalizeMath("$$\nx^2\n$$")).toBe("$$\nx^2\n$$");
  });

  it("keeps blockquote and list prefixes on display blocks", () => {
    expect(normalizeMath("> $$x$$")).toBe("> $$\n> x\n> $$");
    expect(normalizeMath("- $$x$$")).toBe("- $$\n  x\n  $$");
  });

  it("leaves display math inside a sentence inline", () => {
    expect(normalizeMath("we get $$x^2$$ here")).toBe("we get $$x^2$$ here");
  });

  it("allows a single newline inside inline math but not a blank line", () => {
    expect(normalizeMath("a $x\n+1$ b")).toBe("a $x\n+1$ b");
    expect(normalizeMath("a $x\n\n+1$ b")).toBe("a \\$x\n\n+1\\$ b");
  });

  it("escapes an unclosed dollar so a streaming reply shows text until it closes", () => {
    expect(normalizeMath("so $\\frac{1}{")).toBe("so \\$\\frac{1}{");
    expect(normalizeMath("$$\n\\frac{1}{2}")).toBe("\\$\\$\n\\frac{1}{2}");
  });

  it("does not touch fenced code or inline code", () => {
    const fence = '```plotly\n{"layout": {"title": "$5 and $10"}}\n```';
    expect(normalizeMath(fence)).toBe(fence);
    expect(normalizeMath("run `echo $HOME $PATH` now")).toBe("run `echo $HOME $PATH` now");
    expect(normalizeMath("~~~\n\\(x\\) $5\n~~~\nthen $5")).toBe("~~~\n\\(x\\) $5\n~~~\nthen \\$5");
  });

  it("keeps escaped backslashes", () => {
    expect(normalizeMath("a \\\\(b)")).toBe("a \\\\(b)");
  });
});

describe("outsideMath", () => {
  it("transforms only text outside math spans", () => {
    expect(outsideMath("*a* $a_i$ _b_", (s) => s.replace(/[*_]/g, ""))).toBe("a $a_i$ b");
  });

  it("keeps LaTeX intact in the fork preview", () => {
    expect(forkPreview("**Sum** of $a_i * b_i$ terms")).toBe("Sum of $a_i * b_i$ terms");
  });
});

describe("selectionText", () => {
  it("returns null when the range has no math", () => {
    document.body.innerHTML = "<p>plain text</p>";
    const range = document.createRange();
    range.selectNodeContents(document.body);
    expect(selectionText(range)).toBeNull();
  });

  it("quotes rendered math back as LaTeX", () => {
    document.body.innerHTML = `<p>half is <span id="m">${katex.renderToString("\\frac{1}{2}")}</span> exactly</p>`;
    const range = document.createRange();
    range.selectNodeContents(document.body);
    expect(selectionText(range)).toBe("half is $\\frac{1}{2}$ exactly");
  });

  it("expands a selection that starts inside a formula", () => {
    document.body.innerHTML = `<p>${katex.renderToString("x^2")} grows</p>`;
    const inner = document.querySelector(".katex-html")!;
    const end = document.querySelector("p")!.lastChild!;
    const range = document.createRange();
    range.setStart(inner, 0);
    range.setEnd(end, end.textContent!.length);
    expect(selectionText(range)).toBe("$x^2$ grows");
  });
});
