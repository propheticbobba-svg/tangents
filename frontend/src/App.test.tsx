import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { App } from "./App";
import type { Conversation, Message, Thread, ThreadView, Tree } from "./types";

vi.mock("./api");
vi.mock("plotly.js-dist-min", () => ({
  default: { react: vi.fn(() => Promise.resolve()), purge: vi.fn(), Plots: { resize: vi.fn() } },
}));
const mocked = vi.mocked(api);

const CHAT: Conversation = {
  id: "c1",
  goal: "Trip",
  goal_snippet: "Trip",
  created_at: "2026-01-01T00:00:00Z",
  last_used_at: "2026-01-01T00:00:00Z",
  favorite: false,
  side_chat_count: 1,
};

const CENTER: Thread = {
  id: "center",
  conversation_id: "c1",
  parent_thread_id: null,
  fork_message_id: null,
  title: "Trip",
  created_at: "2026-01-01T00:00:00Z",
};
const SIDE: Thread = { ...CENTER, id: "side", parent_thread_id: "center", fork_message_id: "a1", title: "Side" };

function msg(id: string, threadId: string, role: "user" | "assistant", text: string, isNote = false): Message {
  return {
    id,
    parent_id: null,
    role,
    content: [{ type: "text", text }],
    thread_id: threadId,
    created_at: "2026-01-01T00:00:00Z",
    is_note: isNote,
    usage: null,
  };
}

let marked: Set<string>;
let scrolls: number;

function serverView(thread: Thread, messages: Message[]): ThreadView {
  return {
    thread,
    messages: messages.map((m) => ({ ...m, bookmarked: marked.has(m.id) })),
    forked_from: null,
    ancestry: [],
  };
}

beforeAll(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
  class DOMMatrixStub {
    m22 = 1;
  }
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixStub);
  window.DOMMatrixReadOnly = DOMMatrixStub as unknown as typeof DOMMatrixReadOnly;
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as unknown as typeof window.matchMedia;
  }
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  marked = new Set();
  scrolls = 0;
  Element.prototype.scrollIntoView = () => {
    scrolls += 1;
  };
  const centerMessages = [
    msg("u1", "center", "user", "question one"),
    msg("a1", "center", "assistant", "answer one"),
    msg("n1", "center", "user", "a note to self", true),
  ];
  const sideMessages = [msg("u2", "side", "user", "side question"), msg("a2", "side", "assistant", "side answer")];
  mocked.listConversations.mockResolvedValue([CHAT]);
  mocked.getTree.mockResolvedValue({ conversation_id: "c1", goal: "Trip", threads: [CENTER, SIDE] } as Tree);
  mocked.listDocuments.mockResolvedValue([]);
  mocked.getMessages.mockImplementation(async (id) =>
    id === "side" ? serverView(SIDE, sideMessages) : serverView(CENTER, centerMessages),
  );
  mocked.setBookmark.mockImplementation(async (id, on) => {
    if (on) marked.add(id);
    else marked.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const bookmarkButtons = () => screen.queryAllByRole("button", { name: /^(Bookmark this message|Remove bookmark)$/ });

describe("Bookmark buttons in the app", () => {
  it("shows a bookmark button on every finished message, notes included, without hover", async () => {
    render(<App />);
    await screen.findByText("answer one");
    expect(bookmarkButtons()).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Bookmark this message" })).toHaveLength(3);
  });

  it("shows a bookmark button on every message of a side chat", async () => {
    render(<App />);
    await screen.findByText("answer one");
    mocked.getMessages.mockClear();
    const sideLink = (await screen.findAllByText("Side"))[0]!;
    fireEvent.click(sideLink);
    await screen.findByText("side answer");
    expect(bookmarkButtons()).toHaveLength(2);
  });

  it("bookmarking fills the button and survives a reload", async () => {
    const first = render(<App />);
    await screen.findByText("answer one");
    fireEvent.click(screen.getAllByRole("button", { name: "Bookmark this message" })[1]!);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Remove bookmark" })).toHaveLength(1));
    expect(mocked.setBookmark).toHaveBeenCalledWith("a1", true);

    first.unmount();
    render(<App />);
    await screen.findByText("answer one");
    const filled = screen.getAllByRole("button", { name: "Remove bookmark" });
    expect(filled).toHaveLength(1);
    expect(filled[0]!.closest("article")?.getAttribute("data-message-id")).toBe("a1");
  });

  it("removing a bookmark empties the button and survives a reload", async () => {
    marked.add("a1");
    const first = render(<App />);
    await screen.findByText("answer one");
    fireEvent.click(screen.getByRole("button", { name: "Remove bookmark" }));
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Remove bookmark" })).toHaveLength(0));
    expect(mocked.setBookmark).toHaveBeenCalledWith("a1", false);

    first.unmount();
    render(<App />);
    await screen.findByText("answer one");
    expect(screen.queryAllByRole("button", { name: "Remove bookmark" })).toHaveLength(0);
    expect(bookmarkButtons()).toHaveLength(3);
  });

  it("a failed bookmark save puts the button back and shows an error", async () => {
    mocked.setBookmark.mockRejectedValue(new Error("boom"));
    render(<App />);
    await screen.findByText("answer one");
    fireEvent.click(screen.getAllByRole("button", { name: "Bookmark this message" })[0]!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save that bookmark");
    expect(screen.getAllByRole("button", { name: "Bookmark this message" })).toHaveLength(3);
    expect(screen.queryAllByRole("button", { name: "Remove bookmark" })).toHaveLength(0);
  });

  it("pressing bookmark keeps the open chat and does not scroll", async () => {
    render(<App />);
    await screen.findByText("answer one");
    mocked.getMessages.mockClear();
    mocked.getTree.mockClear();
    const before = scrolls;
    fireEvent.click(screen.getAllByRole("button", { name: "Bookmark this message" })[0]!);
    await waitFor(() => expect(mocked.setBookmark).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Remove bookmark" });
    expect(scrolls).toBe(before);
    expect(mocked.getMessages).not.toHaveBeenCalled();
    expect(mocked.getTree).not.toHaveBeenCalled();
    expect(screen.getByText("answer one")).toBeTruthy();
  });
});
