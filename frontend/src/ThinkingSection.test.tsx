import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkingSection } from "./ThinkingSection";

afterEach(() => {
  cleanup();
});

describe("ThinkingSection", () => {
  it("starts collapsed and shows how long the model thought", () => {
    render(
      <ThinkingSection
        text="I compared the two approaches."
        live={false}
        startedAt={null}
        endedAt={null}
        durationMs={12000}
      />,
    );

    const button = screen.getByRole("button", { name: "Thought for 12s" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("I compared the two approaches.")).toBeNull();
  });

  it("expands to the thinking text", () => {
    render(
      <ThinkingSection
        text="I compared the two approaches."
        live={false}
        startedAt={null}
        endedAt={null}
        durationMs={12000}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Thought for 12s" }));
    expect(screen.getByText("I compared the two approaches.")).toBeTruthy();
  });

  it("renders nothing when there is no text and it is not live", () => {
    const { container } = render(
      <ThinkingSection text="" live={false} startedAt={null} endedAt={null} durationMs={null} />,
    );
    expect(container.textContent).toBe("");
  });
});
