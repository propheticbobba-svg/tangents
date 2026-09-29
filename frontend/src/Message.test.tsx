import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageView } from "./Message";
import type { Message } from "./types";

function message(role: Message["role"], overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    parent_id: null,
    role,
    content: [{ type: "text", text: "Hello from the model" }],
    thread_id: "thread-1",
    created_at: "2026-01-01T00:00:00Z",
    is_note: false,
    usage:
      role === "assistant"
        ? {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          }
        : null,
    ...overrides,
  };
}

/** Ancestors with `display: contents` do not form a box, so they are not a sticky containing block. */
function stickyContainingBlock(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node) {
    if (!node.classList.contains("contents")) return node;
    node = node.parentElement;
  }
  return null;
}

afterEach(() => {
  cleanup();
});

describe("MessageView fork button", () => {
  it("pins an assistant Fork button to the message article", () => {
    render(<MessageView message={message("assistant")} onFork={vi.fn()} forkDisabled={false} />);

    const button = screen.getByRole("button", { name: "Fork" });
    expect(button.className).toContain("sticky");
    expect(button.className).toContain("bottom-3");

    const article = button.closest("article");
    expect(article?.getAttribute("data-message-id")).toBe("msg-1");
    expect(stickyContainingBlock(button)).toBe(article);
    expect(button.closest("p")).toBeNull();
  });

  it("calls onFork with the message id", () => {
    const onFork = vi.fn();
    render(<MessageView message={message("assistant")} onFork={onFork} forkDisabled={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(onFork).toHaveBeenCalledWith("msg-1");
  });

  it("disables Fork while a send is in progress", () => {
    render(<MessageView message={message("assistant")} onFork={vi.fn()} forkDisabled />);

    expect(screen.getByRole("button", { name: "Fork" })).toHaveProperty("disabled", true);
  });

  it("does not render Fork on a user message", () => {
    render(<MessageView message={message("user")} onFork={vi.fn()} forkDisabled={false} />);

    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
  });
});
