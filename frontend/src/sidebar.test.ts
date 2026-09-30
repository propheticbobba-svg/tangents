import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth } from "./sidebar";

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

describe("sidebar width", () => {
  it("clamps to the sidebar minimum, the chat minimum, and rounds", () => {
    expect(clampSidebarWidth(100, 1400)).toBe(280);
    expect(clampSidebarWidth(2000, 1400)).toBe(1040);
    expect(clampSidebarWidth(500.4, 1400)).toBe(500);
  });

  it("keeps the sidebar minimum when the viewport is tiny", () => {
    expect(clampSidebarWidth(500, 500)).toBe(280);
  });

  it("loads the default when nothing valid is stored", () => {
    expect(loadSidebarWidth()).toBe(384);
    localStorage.setItem("tangents-sidebar-width", "abc");
    expect(loadSidebarWidth()).toBe(384);
  });

  it("saves and loads a width", () => {
    saveSidebarWidth(512);
    expect(loadSidebarWidth()).toBe(512);
  });
});
