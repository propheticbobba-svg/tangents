import { describe, expect, it } from "vitest";
import {
  appendDictation,
  cleanLatex,
  docToDraft,
  draftToDoc,
  emptyDraft,
  isDraftEmpty,
  serializeDraft,
  textDraft,
  type Draft,
} from "./draft";

function formula(latex: string, spoken = "said", id = "f1"): Draft[number] {
  return { type: "formula", id, latex, spoken };
}

describe("serializeDraft", () => {
  it("writes formulas as dollar math", () => {
    const draft: Draft = [{ type: "text", text: "Simplify " }, formula("\\frac{1}{2}"), { type: "text", text: " please" }];
    expect(serializeDraft(draft)).toBe("Simplify $\\frac{1}{2}$ please");
  });

  it("adds spaces where a neighbour would break the dollar pairing", () => {
    expect(serializeDraft([{ type: "text", text: "is" }, formula("x"), { type: "text", text: "2" }])).toBe(
      "is $x$ 2",
    );
    expect(serializeDraft([formula("a", "a", "1"), formula("b", "b", "2")])).toBe("$a$ $b$");
    expect(serializeDraft([{ type: "text", text: "(" }, formula("x"), { type: "text", text: ")." }])).toBe(
      "($x$).",
    );
  });

  it("drops dollar signs and empty formulas", () => {
    expect(serializeDraft([formula("$x^2$")])).toBe("$x^2$");
    expect(serializeDraft([formula("  ")])).toBe("");
  });

  it("keeps newlines", () => {
    expect(serializeDraft([{ type: "text", text: "a\nb" }])).toBe("a\nb");
  });
});

describe("cleanLatex", () => {
  it("strips wrappers and stray dollars", () => {
    expect(cleanLatex(" $$x$$ ")).toBe("x");
    expect(cleanLatex("\\(x\\)")).toBe("x");
    expect(cleanLatex("a$b")).toBe("ab");
  });
});

describe("isDraftEmpty", () => {
  it("is empty for whitespace only, and not with a formula", () => {
    expect(isDraftEmpty(emptyDraft())).toBe(true);
    expect(isDraftEmpty(textDraft("  \n "))).toBe(true);
    expect(isDraftEmpty(textDraft("hi"))).toBe(false);
    expect(isDraftEmpty([formula("x")])).toBe(false);
  });
});

describe("appendDictation", () => {
  it("matches appendTranscript spacing for plain text", () => {
    expect(appendDictation(emptyDraft(), [{ type: "text", text: " hello " }])).toEqual(textDraft("hello"));
    expect(appendDictation(textDraft("hi"), [{ type: "text", text: "there" }])).toEqual(textDraft("hi there"));
    expect(appendDictation(textDraft("hi "), [{ type: "text", text: "there" }])).toEqual(textDraft("hi there"));
    expect(appendDictation(textDraft("hi\n"), [{ type: "text", text: "there" }])).toEqual(textDraft("hi\nthere"));
  });

  it("keeps the draft when nothing was said", () => {
    const draft = textDraft("hi");
    expect(appendDictation(draft, [{ type: "text", text: "  " }])).toBe(draft);
  });

  it("appends formulas with fresh ids and keeps inner spacing", () => {
    const next = appendDictation(textDraft("Note:"), [
      { type: "text", text: "so " },
      { type: "formula", latex: "x^2", spoken: "x squared" },
      { type: "text", text: " grows." },
    ]);
    expect(next).toHaveLength(3);
    expect(next[0]).toEqual({ type: "text", text: "Note: so " });
    expect(next[1]).toMatchObject({ type: "formula", latex: "x^2", spoken: "x squared" });
    expect((next[1] as { id: string }).id).toMatch(/[0-9a-f-]{36}/);
    expect(next[2]).toEqual({ type: "text", text: " grows." });
  });

  it("puts a space between a formula and what follows it", () => {
    const afterFormula = appendDictation([formula("x")], [{ type: "text", text: "next" }]);
    expect(serializeDraft(afterFormula)).toBe("$x$ next");
    const leadingFormula = appendDictation(textDraft("see"), [{ type: "formula", latex: "y", spoken: "y" }]);
    expect(serializeDraft(leadingFormula)).toBe("see $y$");
    expect(appendDictation(emptyDraft(), [{ type: "formula", latex: "y", spoken: "y" }])[0]).toMatchObject({
      type: "formula",
    });
  });
});

describe("doc round trip", () => {
  it("keeps text, newlines and formulas", () => {
    const draft: Draft = [{ type: "text", text: "a\nb " }, formula("x^2", "x squared", "id-1"), { type: "text", text: " c" }];
    expect(docToDraft(draftToDoc(draft))).toEqual(draft);
  });

  it("joins pasted paragraphs with a newline", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ],
    };
    expect(docToDraft(doc)).toEqual(textDraft("one\ntwo"));
  });

  it("gives an empty draft for an empty doc", () => {
    expect(docToDraft(draftToDoc(emptyDraft()))).toEqual([]);
  });
});
