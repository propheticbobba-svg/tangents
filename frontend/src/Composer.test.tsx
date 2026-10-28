import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { emptyDraft, serializeDraft, textDraft, type Draft } from "./draft";

afterEach(() => {
  cleanup();
});

let setOutside: (draft: Draft) => void = () => {};
let current: Draft = emptyDraft();

function Harness({
  initial,
  onSend,
  disabled = false,
}: {
  initial: Draft;
  onSend: () => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  setOutside = setDraft;
  current = draft;
  return (
    <Composer
      value={draft}
      onChange={setDraft}
      onSend={onSend}
      disabled={disabled}
      placeholder="Message the center node"
      prefillKey={0}
    />
  );
}

function textbox(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

describe("Composer", () => {
  it("is a labelled multiline textbox", () => {
    render(<Harness initial={emptyDraft()} onSend={vi.fn()} />);
    expect(textbox().getAttribute("aria-multiline")).toBe("true");
    expect(textbox().id).toBe("composer");
    expect(textbox().getAttribute("contenteditable")).toBe("true");
  });

  it("sends on Enter and not on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<Harness initial={textDraft("hello")} onSend={onSend} />);
    fireEvent.keyDown(textbox(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not send an empty draft", () => {
    const onSend = vi.fn();
    render(<Harness initial={textDraft("   ")} onSend={onSend} />);
    fireEvent.keyDown(textbox(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a value set from outside, including a restore after a clear", () => {
    render(<Harness initial={emptyDraft()} onSend={vi.fn()} />);
    const restored = textDraft("restored text");
    act(() => setOutside(restored));
    expect(textbox().textContent).toBe("restored text");
    act(() => setOutside(emptyDraft()));
    expect(textbox().textContent).toBe("");
    act(() => setOutside(restored));
    expect(textbox().textContent).toBe("restored text");
  });

  it("is not editable while disabled", () => {
    render(<Harness initial={emptyDraft()} onSend={vi.fn()} disabled />);
    expect(textbox().getAttribute("contenteditable")).toBe("false");
  });

  it("renders a formula box and keeps it in the draft", async () => {
    const draft: Draft = [
      { type: "text", text: "Simplify " },
      { type: "formula", id: "f1", latex: "\\frac{4x^2-2x+6}{3}", spoken: "4x square minus 2x plus 6 divided by 3" },
    ];
    render(<Harness initial={draft} onSend={vi.fn()} />);
    const chip = await screen.findByRole("img", { name: "Formula: \\frac{4x^2-2x+6}{3}" });
    expect(chip.querySelector(".katex .mfrac")).not.toBeNull();
    expect(serializeDraft(current)).toBe("Simplify $\\frac{4x^2-2x+6}{3}$");
  });
});
