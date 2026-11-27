import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { App } from "./App";
import { BookmarksPanel } from "./BookmarksPanel";
import type { Bookmark, Conversation, Message, Thread, ThreadView, Tree } from "./types";

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

function msg(id: string, threadId: string, role: "user" | "assistant", text: string): Message {
  return {
    id,
    parent_id: null,
    role,
    content: [{ type: "text", text }],
    thread_id: threadId,
    created_at: "2026-01-01T00:00:00Z",
    is_note: false,
    usage: null,
  };
}

const BOOKMARKS: Bookmark[] = [
  {
    message_id: "a1",
    thread_id: "center",
    thread_title: "Trip",
    is_side_node: false,
    role: "assistant",
    snippet: "answer one",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    message_id: "u2",
    thread_id: "side",
    thread_title: "Side",
    is_side_node: true,
    role: "user",
    snippet: "side question",
    created_at: "2026-01-01T00:00:01Z",
  },
];

let marked: Set<string>;

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

let scrolls: number;

beforeEach(() => {
  marked = new Set();
  scrolls = 0;
  Element.prototype.scrollIntoView = () => {
    scrolls += 1;
  };
  const centerMessages = [msg("u1", "center", "user", "question one"), msg("a1", "center", "assistant", "answer one")];
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
  mocked.listBookmarks.mockResolvedValue(BOOKMARKS);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const bookmarksButton = () => screen.getByRole("button", { name: "Bookmarks" });

describe("Bookmarks list", () => {
  it("lists every bookmark of the open chat with where, who and excerpt", async () => {
    render(<App />);
    await screen.findByText("answer one");
    fireEvent.click(bookmarksButton());
    const dialog = await screen.findByRole("dialog", { name: "Bookmarks in this chat" });
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Main chat");
    expect(rows[0]!.textContent).toContain("Claude");
    expect(rows[0]!.textContent).toContain("answer one");
    expect(rows[1]!.textContent).toContain("Side");
    expect(rows[1]!.textContent).toContain("You");
    expect(rows[1]!.textContent).toContain("side question");
    expect(dialog).toBeTruthy();
    expect(mocked.listBookmarks).toHaveBeenCalledWith("c1", expect.anything());
  });

  it("only shows bookmarks from the open chat", async () => {
    const other: Bookmark[] = [{ ...BOOKMARKS[0]!, message_id: "x9", snippet: "other chat text" }];
    mocked.listBookmarks.mockImplementation(async (id) => (id === "c2" ? other : BOOKMARKS));
    const view = render(<BookmarksPanel conversationId="c1" disabled={false} onOpenBookmark={() => {}} />);
    fireEvent.click(bookmarksButton());
    await screen.findByText("side question");
    expect(screen.queryByText("other chat text")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    view.rerender(<BookmarksPanel conversationId="c2" disabled={false} onOpenBookmark={() => {}} />);
    fireEvent.click(bookmarksButton());
    await screen.findByText("other chat text");
    expect(screen.queryByText("side question")).toBeNull();
    expect(mocked.listBookmarks.mock.calls.map((call) => call[0])).toEqual(["c1", "c2"]);
  });

  it("clicking a side chat bookmark opens that side chat, closes the list, scrolls and highlights the message", async () => {
    render(<App />);
    await screen.findByText("answer one");
    fireEvent.click(bookmarksButton());
    fireEvent.click(await screen.findByText("side question", { selector: "span" }));
    await screen.findByText("side answer");
    expect(screen.queryByRole("dialog", { name: "Bookmarks in this chat" })).toBeNull();
    expect(mocked.getMessages).toHaveBeenCalledWith("side");
    await waitFor(() => {
      const target = document.querySelector('[data-message-id="u2"]');
      expect(target?.classList.contains("jump-highlight")).toBe(true);
    });
    expect(scrolls).toBeGreaterThan(0);
  });

  it("shows 'No bookmarks in this chat yet' when there are none", async () => {
    mocked.listBookmarks.mockResolvedValue([]);
    render(<BookmarksPanel conversationId="c1" disabled={false} onOpenBookmark={() => {}} />);
    fireEvent.click(bookmarksButton());
    await screen.findByText("No bookmarks in this chat yet");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("reflects a bookmark added or removed since it was last opened", async () => {
    mocked.listBookmarks.mockImplementation(async () =>
      marked.has("a1") ? [BOOKMARKS[0]!] : [],
    );
    render(<App />);
    await screen.findByText("answer one");
    fireEvent.click(bookmarksButton());
    await screen.findByText("No bookmarks in this chat yet");
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(screen.getAllByRole("button", { name: "Bookmark this message" })[1]!);
    await screen.findByRole("button", { name: "Remove bookmark" });
    fireEvent.click(bookmarksButton());
    await screen.findByText("answer one", { selector: "span" });
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Remove bookmark" }));
    await screen.findAllByRole("button", { name: "Bookmark this message" });
    fireEvent.click(bookmarksButton());
    await screen.findByText("No bookmarks in this chat yet");
    expect(mocked.listBookmarks).toHaveBeenCalledTimes(3);
  });

  it("shows an error in the list and keeps the open chat when bookmarks can't load", async () => {
    mocked.listBookmarks.mockRejectedValue(new Error("boom"));
    render(<App />);
    await screen.findByText("answer one");
    mocked.getMessages.mockClear();
    mocked.getTree.mockClear();
    fireEvent.click(bookmarksButton());
    const dialog = await screen.findByRole("dialog", { name: "Bookmarks in this chat" });
    await waitFor(() => expect(dialog.textContent).toContain("Could not load bookmarks: boom"));
    expect(mocked.getMessages).not.toHaveBeenCalled();
    expect(mocked.getTree).not.toHaveBeenCalled();
    expect(screen.getByText("answer one", { selector: "article *" })).toBeTruthy();
  });

  it("Esc or clicking outside closes the list without changing the open chat; greyed out while Claude replies", async () => {
    render(<App />);
    await screen.findByText("answer one");
    mocked.getMessages.mockClear();
    mocked.getTree.mockClear();
    fireEvent.click(bookmarksButton());
    await screen.findByRole("dialog", { name: "Bookmarks in this chat" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Bookmarks in this chat" })).toBeNull();

    fireEvent.click(bookmarksButton());
    await screen.findByRole("dialog", { name: "Bookmarks in this chat" });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Bookmarks in this chat" })).toBeNull();
    expect(mocked.getMessages).not.toHaveBeenCalled();
    expect(mocked.getTree).not.toHaveBeenCalled();
    expect(screen.getByText("answer one", { selector: "article *" })).toBeTruthy();

    cleanup();
    render(<BookmarksPanel conversationId="c1" disabled={true} onOpenBookmark={() => {}} />);
    expect((bookmarksButton() as HTMLButtonElement).disabled).toBe(true);
  });
});
