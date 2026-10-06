import { describe, expect, it } from "vitest";
import { messageText, type ContentBlock } from "./types";

describe("messageText", () => {
  it("joins citation-split text blocks without inserting newlines", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "| Benchmark | Sol |\n| --- | --- |\n| Terminal-Bench 4.0 | " },
      { type: "text", text: "54.0%" },
      { type: "text", text: " |\n" },
    ];
    expect(messageText(content)).toBe(
      "| Benchmark | Sol |\n| --- | --- |\n| Terminal-Bench 4.0 | 54.0% |\n",
    );
  });

  it("keeps the newlines already in a single text block", () => {
    expect(messageText([{ type: "text", text: "Hello.\n\nNext paragraph." }])).toBe(
      "Hello.\n\nNext paragraph.",
    );
  });
});
