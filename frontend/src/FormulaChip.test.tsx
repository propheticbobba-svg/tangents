import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import type { Draft } from "./draft";
import { serializeDraft } from "./draft";
import { FormulaChip, floatingPosition, type VoiceControl } from "./FormulaChip";

afterEach(() => {
  cleanup();
});

function idleVoice(overrides: Partial<VoiceControl> = {}): VoiceControl {
  return { phase: "idle", disabled: false, onToggle: vi.fn(), onCancel: vi.fn(), ...overrides };
}

function chip(latex: string): HTMLElement {
  return screen.getByRole("img", { name: `Formula: ${latex}` });
}

function hover(element: HTMLElement) {
  fireEvent.pointerEnter(element);
}

describe("FormulaChip", () => {
  it("renders KaTeX and shows the three actions on hover", () => {
    render(
      <FormulaChip latex="\frac{1}{2}" selected={false} editable voice={idleVoice()} onEditText={vi.fn()} onUndo={vi.fn()} />,
    );
    expect(chip("\\frac{1}{2}").querySelector(".katex .mfrac")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Edit with text" })).toBeNull();
    hover(chip("\\frac{1}{2}"));
    expect(screen.getByRole("button", { name: "Edit with text" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit with voice" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo math" })).toBeTruthy();
  });

  it("shows the actions when selected with the keyboard, and none when not editable", () => {
    const { rerender } = render(
      <FormulaChip latex="x" selected editable voice={idleVoice()} onEditText={vi.fn()} onUndo={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Undo math" })).toBeTruthy();
    rerender(<FormulaChip latex="x" selected editable={false} voice={idleVoice()} onEditText={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Undo math" })).toBeNull();
  });

  it("marks LaTeX that KaTeX cannot render", () => {
    render(<FormulaChip latex="\frac{1}{" selected={false} editable voice={idleVoice()} onEditText={vi.fn()} onUndo={vi.fn()} />);
    const box = chip("\\frac{1}{");
    expect(box.className).toContain("has-error");
    expect(box.textContent).toBe("\\frac{1}{");
  });

  it("edits with text: Enter saves cleaned LaTeX, Escape and empty cancel", () => {
    const onEditText = vi.fn();
    render(<FormulaChip latex="x" selected={false} editable voice={idleVoice()} onEditText={onEditText} onUndo={vi.fn()} />);
    hover(chip("x"));
    fireEvent.click(screen.getByRole("button", { name: "Edit with text" }));
    const input = screen.getByRole("textbox", { name: "LaTeX" });
    expect(screen.getByRole("dialog", { name: "Edit formula" })).toBeTruthy();

    fireEvent.change(input, { target: { value: "$x^2$" } });
    expect(document.querySelector(".formula-preview .katex")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEditText).toHaveBeenCalledWith("x^2");
    expect(screen.queryByRole("dialog")).toBeNull();

    hover(chip("x"));
    fireEvent.click(screen.getByRole("button", { name: "Edit with text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "LaTeX" }), { target: { value: "y" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "LaTeX" }), { key: "Escape" });
    expect(onEditText).toHaveBeenCalledTimes(1);

    hover(chip("x"));
    fireEvent.click(screen.getByRole("button", { name: "Edit with text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "LaTeX" }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onEditText).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves when clicking outside the editor", () => {
    const onEditText = vi.fn();
    render(<FormulaChip latex="x" selected={false} editable voice={idleVoice()} onEditText={onEditText} onUndo={vi.fn()} />);
    hover(chip("x"));
    fireEvent.click(screen.getByRole("button", { name: "Edit with text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "LaTeX" }), { target: { value: "z" } });
    fireEvent.mouseDown(document.body);
    expect(onEditText).toHaveBeenCalledWith("z");
  });

  it("runs voice edit controls", () => {
    const voice = idleVoice();
    const { rerender } = render(
      <FormulaChip latex="x" selected={false} editable voice={voice} onEditText={vi.fn()} onUndo={vi.fn()} />,
    );
    hover(chip("x"));
    fireEvent.click(screen.getByRole("button", { name: "Edit with voice" }));
    expect(voice.onToggle).toHaveBeenCalledTimes(1);

    const listening = idleVoice({ phase: "listening" });
    rerender(<FormulaChip latex="x" selected={false} editable voice={listening} onEditText={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByText("Listening…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(listening.onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(listening.onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <FormulaChip latex="x" selected={false} editable voice={idleVoice({ phase: "transcribing" })} onEditText={vi.fn()} onUndo={vi.fn()} />,
    );
    expect(screen.getByText("Updating…")).toBeTruthy();
    // The formula stays visible while it updates: no text-clipping shimmer.
    expect(chip("x").className).toContain("is-voice");
    expect(chip("x").className).not.toContain("shimmer");
    expect(chip("x").getAttribute("aria-busy")).toBe("true");
    expect(chip("x").querySelector(".katex")).not.toBeNull();
  });

  it("disables voice edit while another mic is busy", () => {
    render(<FormulaChip latex="x" selected editable voice={idleVoice({ disabled: true })} onEditText={vi.fn()} onUndo={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Edit with voice" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("floatingPosition", () => {
  const chipBox = { left: 400, right: 500, top: 600, bottom: 630 };

  it("centers above the chip with a gap, so it never covers the formula", () => {
    const { left, top } = floatingPosition(chipBox, { width: 300, height: 40 }, 1200);
    expect(left + 300 / 2).toBe(450);
    expect(top + 40).toBeLessThan(chipBox.top);
  });

  it("goes below the chip when there is no room above", () => {
    const { top } = floatingPosition({ ...chipBox, top: 20, bottom: 50 }, { width: 300, height: 40 }, 1200);
    expect(top).toBeGreaterThan(50);
  });

  it("stays inside the viewport", () => {
    expect(floatingPosition({ ...chipBox, left: 0, right: 20 }, { width: 300, height: 40 }, 1200).left).toBe(8);
    expect(floatingPosition({ ...chipBox, left: 1180, right: 1200 }, { width: 300, height: 40 }, 1200).left).toBe(892);
  });
});

describe("formula box in the composer", () => {
  let current: Draft = [];

  function Harness({ initial }: { initial: Draft }) {
    const [draft, setDraft] = useState<Draft>(initial);
    current = draft;
    return (
      <Composer value={draft} onChange={setDraft} onSend={vi.fn()} disabled={false} placeholder="p" prefillKey={0} />
    );
  }

  const initial: Draft = [
    { type: "text", text: "Simplify " },
    { type: "formula", id: "f1", latex: "\\frac{6}{3}", spoken: "6 divided by 3" },
  ];

  it("Undo math turns the box back into the spoken words", async () => {
    render(<Harness initial={initial} />);
    hover(await screen.findByRole("img", { name: "Formula: \\frac{6}{3}" }));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Undo math" }));
    });
    expect(current).toEqual([{ type: "text", text: "Simplify 6 divided by 3" }]);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("Edit with text updates the draft", async () => {
    render(<Harness initial={initial} />);
    hover(await screen.findByRole("img", { name: "Formula: \\frac{6}{3}" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit with text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "LaTeX" }), { target: { value: "\\frac{6}{2}" } });
    act(() => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "LaTeX" }), { key: "Enter" });
    });
    expect(serializeDraft(current)).toBe("Simplify $\\frac{6}{2}$");
    expect(await screen.findByRole("img", { name: "Formula: \\frac{6}{2}" })).toBeTruthy();
  });
});
