import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadModel, modelInfo } from "./models";

// Node's built-in localStorage is an empty object unless --localstorage-file is set, which hides jsdom's.
beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, String(value));
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  });
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("models", () => {
  it("loads a stored current model", () => {
    localStorage.setItem("tangents-model", "claude-opus-5-5");
    expect(loadModel()).toBe("claude-opus-5-5");
  });

  it("rewrites a stored Haiku 4.5 id to Haiku 5.5", () => {
    localStorage.setItem("tangents-model", "claude-haiku-4-5");
    expect(loadModel()).toBe("claude-haiku-5-5");
    expect(localStorage.getItem("tangents-model")).toBe("claude-haiku-5-5");
  });

  it("loads Sonnet when nothing is stored", () => {
    expect(loadModel()).toBe("claude-sonnet-5-5");
  });

  it("describes Haiku 5.5 as an adaptive effort model", () => {
    const info = modelInfo("claude-haiku-5-5");
    expect(info.label).toBe("Haiku 5.5");
    expect(info.defaultEffort).toBe("medium");
    expect(info.thinking).toBe("adaptive");
    expect(info.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
