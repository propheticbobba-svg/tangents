import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TreeView } from "./TreeView";
import type { Thread } from "./types";

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

function thread(overrides: Partial<Thread> & Pick<Thread, "id">): Thread {
  return {
    conversation_id: "conv-1",
    parent_thread_id: null,
    fork_message_id: null,
    title: overrides.id,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const threads = [
  thread({ id: "center", title: "Center" }),
  thread({
    id: "side",
    parent_thread_id: "center",
    fork_message_id: "msg-1",
    title: "Rust lifetimes",
    created_at: "2026-01-01T00:01:00Z",
  }),
];

function deleteButton(title: string): HTMLButtonElement | null {
  return document.querySelector(`button[aria-label="Delete ${title}"]`);
}

function renderTree(props: Partial<ComponentProps<typeof TreeView>> = {}) {
  return render(
    <div style={{ width: 800, height: 600 }}>
      <TreeView
        threads={threads}
        activeThreadId="center"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        disabled={false}
        colorMode="light"
        {...props}
      />
    </div>,
  );
}

afterEach(() => {
  cleanup();
});

describe("TreeView delete", () => {
  it("offers Delete on a side node and not on the center", () => {
    renderTree();

    const button = deleteButton("Rust lifetimes");
    expect(button).not.toBeNull();
    expect(button?.className).toContain("hidden");
    expect(button?.className).toContain("group-hover:block");
    expect(button?.className).toContain("nodrag");
    expect(button?.className).toContain("nopan");
    expect(deleteButton("Center")).toBeNull();
  });

  it("deletes without switching to that node", () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    renderTree({ onSelect, onDelete });

    const button = deleteButton("Rust lifetimes");
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onDelete).toHaveBeenCalledWith("side");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("blocks pointer events while a reply is streaming", () => {
    const { container } = renderTree({ disabled: true, activeThreadId: "side" });

    expect(container.querySelector(".pointer-events-none")).toBeTruthy();
  });
});
