import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPane } from "./ChatPane";
import type { Message, ThreadView } from "./types";

vi.mock("plotly.js-dist-min", () => ({
  default: { react: vi.fn(() => Promise.resolve()), purge: vi.fn(), Plots: { resize: vi.fn() } },
}));

function msg(id: string): Message {
  return {
    id,
    parent_id: null,
    role: "assistant",
    content: [{ type: "text", text: `text ${id}` }],
    thread_id: "t1",
    created_at: "2026-01-01T00:00:00Z",
    is_note: false,
    usage: null,
  };
}

const view = {
  thread: { id: "t1", parent_thread_id: null },
  ancestry: [],
  forked_from: null,
  messages: Array.from({ length: 60 }, (_, i) => msg(`m${i}`)),
} as unknown as ThreadView;

const noop = () => {};
function pane(jump: { messageId: string; nonce: number } | null) {
  return (
    <ChatPane
      view={view}
      goal={null}
      streaming={null}
      sending={false}
      error={null}
      draft={[] as never}
      prefillKey={0}
      onDraft={noop}
      onSend={noop}
      onFork={noop}
      onForkSelection={noop}
      onSelectThread={noop}
      onSaveGoal={async () => {}}
      controls={null}
      mic={null}
      dictationPhase={"idle" as never}
      formulaMic={null}
      onFormulaMic={noop}
      onComposerError={noop}
      onContinue={noop}
      jump={jump}
    />
  );
}

let scrolled: Array<string | null>;
beforeEach(() => {
  vi.useFakeTimers();
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("data-message-id"));
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const article = (id: string) => document.querySelector(`[data-message-id="${id}"]`);

describe("ChatPane bookmark buttons", () => {
  const streamingTurn = {
    text: "still writing",
    summaries: [],
    activity: [],
    thinking: "",
    thinkingStartedAt: null,
    thinkingEndedAt: null,
  };

  it("has no bookmark button on a reply still being written", () => {
    const small = { ...view, messages: [msg("m0")] } as unknown as ThreadView;
    render(
      <ChatPane
        view={small}
        goal={null}
        streaming={streamingTurn}
        sending
        error={null}
        draft={[] as never}
        prefillKey={0}
        onDraft={noop}
        onSend={noop}
        onFork={noop}
        onForkSelection={noop}
        onSelectThread={noop}
        onSaveGoal={async () => {}}
        controls={null}
        mic={null}
        dictationPhase={"idle" as never}
        formulaMic={null}
        onFormulaMic={noop}
        onComposerError={noop}
        onContinue={noop}
        onToggleBookmark={noop}
      />,
    );
    expect(screen.getByText("still writing")).toBeTruthy();
    // Only the finished message has one; the streaming article has none.
    expect(screen.getAllByRole("button", { name: "Bookmark this message" })).toHaveLength(1);
    const streamingArticle = screen.getByText("still writing").closest("article");
    expect(streamingArticle?.querySelector("button")).toBeNull();
  });
});

describe("ChatPane jump to a search match", () => {
  it("scrolls to the matched message instead of the bottom", () => {
    render(pane({ messageId: "m3", nonce: 1 }));
    expect(scrolled).toEqual(["m3"]);
  });

  it("highlights the matched message and removes the highlight by itself", () => {
    render(pane({ messageId: "m3", nonce: 1 }));
    expect(article("m3")?.classList.contains("jump-highlight")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(article("m3")?.classList.contains("jump-highlight")).toBe(false);
  });

  it("jumps again when the node is already open", () => {
    const { rerender } = render(pane(null));
    scrolled.length = 0;
    rerender(pane({ messageId: "m3", nonce: 1 }));
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    scrolled.length = 0;
    rerender(pane({ messageId: "m10", nonce: 2 }));
    expect(scrolled).toEqual(["m10"]);
    expect(article("m10")?.classList.contains("jump-highlight")).toBe(true);
  });

  it("shows a note when the matched message is gone", () => {
    render(pane({ messageId: "gone", nonce: 1 }));
    expect(screen.getByRole("status").textContent).toContain("couldn't be found");
    expect(document.querySelector(".jump-highlight")).toBeNull();
    expect(article("m0")).not.toBeNull();
  });
});
