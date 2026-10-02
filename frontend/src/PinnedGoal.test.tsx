import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinnedGoal } from "./PinnedGoal";

const goal = "Build a scaling law lab.\n\n## Phase 0\nAsk me clarifying questions.";

afterEach(() => {
  cleanup();
});

describe("PinnedGoal", () => {
  it("clamps a collapsed goal without a display class that would undo the clamp", () => {
    render(<PinnedGoal goal={goal} onSave={vi.fn()} />);

    const text = screen.getByRole("button", { name: /Build a scaling law lab/ });
    const classes = text.className.split(/\s+/);
    expect(classes).toContain("line-clamp-2");
    for (const display of ["block", "flex", "grid", "inline", "inline-block"]) {
      expect(classes).not.toContain(display);
    }
  });

  it("caps an expanded goal so it scrolls instead of filling the pane", () => {
    render(<PinnedGoal goal={goal} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const classes = screen.getByRole("button", { name: /Build a scaling law lab/ }).className.split(/\s+/);
    expect(classes).not.toContain("line-clamp-2");
    expect(classes).toContain("max-h-48");
    expect(classes).toContain("overflow-y-auto");
  });
});
