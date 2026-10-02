import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelMenu } from "./ModelMenu";
import type { Effort, ModelId } from "./models";

function renderMenu(
  overrides: Partial<{
    model: ModelId;
    effort: Effort | null;
    extended: boolean;
  }> = {},
) {
  const props = {
    model: "claude-sonnet-5-5" as ModelId,
    effort: "high" as Effort | null,
    extended: false,
    disabled: false,
    onModel: vi.fn(),
    onEffort: vi.fn(),
    onExtended: vi.fn(),
    ...overrides,
  };
  render(<ModelMenu {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe("ModelMenu", () => {
  it("shows the model and its effort on the button", () => {
    renderMenu();
    expect(screen.getByRole("button", { name: /Sonnet 5.5 · High/ })).toBeTruthy();
  });

  it("lists the models and effort levels, with Default on High", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Sonnet 5.5 · High/ }));

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(9);
    expect(screen.getByRole("menuitemradio", { name: "Sonnet 5.5" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Opus 5.5" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Fable 5.1" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Haiku 4.5" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /^High/ }).textContent).toContain("Default");
    expect(screen.getByText("Thinking is always on for this model.")).toBeTruthy();
  });

  it("reports Max when that effort is chosen", () => {
    const props = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Sonnet 5.5 · High/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Max" }));
    expect(props.onEffort).toHaveBeenCalledWith("max");
  });

  it("hides effort for Haiku and toggles extended thinking", () => {
    const props = renderMenu({ model: "claude-haiku-4-5", effort: null });
    fireEvent.click(screen.getByRole("button", { name: /Haiku 4.5/ }));
    expect(screen.queryByText("Effort")).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /High/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Extended thinking" }));
    expect(props.onExtended).toHaveBeenCalledWith(true);
  });

  it("closes when Escape is pressed", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Sonnet 5.5 · High/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
