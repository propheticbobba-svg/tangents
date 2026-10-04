import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageView } from "./Message";
import type { Message } from "./types";

const plotly = vi.hoisted(() => ({
  react: vi.fn(() => Promise.resolve()),
  purge: vi.fn(),
  Plots: { resize: vi.fn() },
}));
vi.mock("plotly.js-dist-min", () => ({ default: plotly }));

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

  it("shows retrieved passages outside the user bubble", () => {
    render(
      <MessageView
        message={message("user", {
          content: [
            {
              type: "search_result",
              title: "Walls - Basement",
              source: "doc:1#0",
              content: [{ type: "text", text: "The basement journals name Marley." }],
            },
            {
              type: "search_result",
              title: "Walls - Ending",
              source: "doc:1#1",
              content: [{ type: "text", text: "Eren is defeated and killed." }],
            },
            { type: "text", text: "What was hidden?" },
          ],
        })}
        onFork={vi.fn()}
        forkDisabled={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Searched your documents — 2 passages" })).toBeTruthy();
    const bubble = document.querySelector(".bg-user");
    expect(bubble?.textContent).toBe("What was hidden?");
    expect(bubble?.textContent).not.toContain("basement journals");
  });

  it("shows a cut-off notice and continues from it", () => {
    const onContinue = vi.fn();
    render(
      <MessageView
        message={message("assistant", {
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            stop_reason: "max_tokens",
          },
        })}
        onFork={vi.fn()}
        forkDisabled={false}
        onContinue={onContinue}
      />,
    );

    expect(screen.getByText("Claude hit the maximum length for this message.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("shows a collapsed thinking section", () => {
    render(
      <MessageView
        message={message("assistant", {
          content: [
            { type: "thinking", thinking: "I weighed the options." },
            { type: "text", text: "Hello from the model" },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            thinking_ms: 4000,
          },
        })}
        onFork={vi.fn()}
        forkDisabled={false}
      />,
    );

    const thinking = screen.getByRole("button", { name: "Thought for 4s" });
    expect(thinking.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("I weighed the options.")).toBeNull();
  });

  it("keeps Fork sticky when the message contains a chart", () => {
    render(
      <MessageView
        message={message("assistant", {
          content: [
            {
              type: "text",
              text: 'Here is a chart.\n\n```plotly\n{"data":[{"type":"scatter","y":[1]}]}\n```',
            },
          ],
        })}
        onFork={vi.fn()}
        forkDisabled={false}
      />,
    );

    const button = screen.getByRole("button", { name: "Fork" });
    expect(button.className).toContain("sticky");
    expect(button.className).toContain("bottom-3");
    expect(stickyContainingBlock(button)).toBe(button.closest("article"));
    expect(button.closest("p")).toBeNull();
  });
});
