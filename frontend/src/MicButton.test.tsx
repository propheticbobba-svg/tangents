import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicButtonView } from "./MicButton";

afterEach(() => {
  cleanup();
});

describe("MicButtonView", () => {
  it("paints the idle dictate control", () => {
    render(<MicButtonView listening={false} busy={false} disabled={false} onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Dictate" });
    expect(button).toHaveProperty("type", "button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.className.split(/\s+/)).toContain("mic-idle");
    expect(button.className.split(/\s+/)).not.toContain("mic-live");
  });

  it("paints the listening control", () => {
    render(<MicButtonView listening={true} busy={false} disabled={false} onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Stop dictating" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className.split(/\s+/)).toContain("mic-live");
    expect(button.className.split(/\s+/)).not.toContain("mic-idle");
  });

  it("paints the transcribing control without a pulse", () => {
    render(<MicButtonView listening={false} busy={true} disabled={false} onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Transcribing" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.className.split(/\s+/)).toContain("mic-idle");
    expect(button.className.split(/\s+/)).not.toContain("mic-live");
  });
});
