import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { App } from "./App";
import { SearchBox } from "./SearchBox";
import type { Message, SearchResult, Thread, ThreadView, Tree } from "./types";

vi.mock("./api");
const mocked = vi.mocked(api);

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
    constructor(_transform?: string) {}
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

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    conversation_id: "conv-1",
    conversation_name: "Learning Rust",
    thread_id: "center-1",
    thread_title: "Learning Rust",
    is_side_node: false,
    message_id: "m1",
    role: "user",
    created_at: "2026-01-01T00:00:00Z",
    snippet: "How does the Rust borrow checker work?",
    ...overrides,
  };
}

function thread(id: string, conversation: string, parent: string | null, title: string): Thread {
  return {
    id,
    conversation_id: conversation,
    parent_thread_id: parent,
    fork_message_id: parent ? `fork-${id}` : null,
    title,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function message(id: string, threadId: string, text: string): Message {
  return {
    id,
    parent_id: null,
    role: "user",
    content: [{ type: "text", text }],
    thread_id: threadId,
    created_at: "2026-01-01T00:00:00Z",
    is_note: false,
    usage: null,
  };
}

function typeQuery(text: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search all chats" }), { target: { value: text } });
}

function openSearch() {
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

describe("SearchBox", () => {
  it("lists matches with chat name, node, speaker and highlighted words", async () => {
    mocked.searchMessages.mockResolvedValue({
      query: "rust borrow",
      truncated: false,
      results: [
        result(),
        result({
          message_id: "m2",
          thread_id: "side-1",
          thread_title: "Lifetimes",
          is_side_node: true,
          role: "assistant",
          snippet: "The borrow rules in Rust are strict.",
        }),
      ],
    });
    render(<SearchBox disabled={false} onOpenResult={vi.fn()} />);
    openSearch();
    typeQuery("rust borrow");

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Learning Rust")).toBeTruthy();
    expect(within(rows[0]).getByText("Main chat")).toBeTruthy();
    expect(within(rows[0]).getByText("You")).toBeTruthy();
    expect(within(rows[1]).getByText("Lifetimes")).toBeTruthy();
    expect(within(rows[1]).getByText("Claude")).toBeTruthy();
    const marks = [...rows[0].querySelectorAll("mark")].map((node) => node.textContent);
    expect(marks).toEqual(["Rust", "borrow"]);
    expect(mocked.searchMessages).toHaveBeenCalledTimes(1);
    expect(mocked.searchMessages.mock.calls[0][0]).toBe("rust borrow");
  });

  it("shows No matches when nothing is found", async () => {
    mocked.searchMessages.mockResolvedValue({ query: "zzz", truncated: false, results: [] });
    render(<SearchBox disabled={false} onOpenResult={vi.fn()} />);
    openSearch();
    typeQuery("zzz");

    expect(await screen.findByText("No matches")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("an empty box shows no results and sends no request", async () => {
    render(<SearchBox disabled={false} onOpenResult={vi.fn()} />);
    openSearch();
    const input = screen.getByRole("searchbox", { name: "Search all chats" });
    typeQuery("   ");
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(mocked.searchMessages).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it("is disabled while a reply is streaming", () => {
    render(<SearchBox disabled onOpenResult={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Search" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Search inside the app", () => {
  const trees: Record<string, Tree> = {
    "conv-1": {
      conversation_id: "conv-1",
      goal: "First chat",
      threads: [thread("center-1", "conv-1", null, "First chat")],
    },
    "conv-2": {
      conversation_id: "conv-2",
      goal: "Second chat",
      threads: [thread("center-2", "conv-2", null, "Second chat"), thread("side-2", "conv-2", "center-2", "Tangent on moons")],
    },
  };
  const views: Record<string, ThreadView> = {
    "center-1": {
      thread: trees["conv-1"].threads[0],
      messages: [message("a", "center-1", "hello from the first chat")],
      forked_from: null,
      ancestry: [],
    },
    "center-2": {
      thread: trees["conv-2"].threads[0],
      messages: [message("b", "center-2", "hello from the second chat")],
      forked_from: null,
      ancestry: [],
    },
    "side-2": {
      thread: trees["conv-2"].threads[1],
      messages: [message("c", "side-2", "moons are interesting")],
      forked_from: null,
      ancestry: [],
    },
  };

  beforeEach(() => {
    mocked.listConversations.mockResolvedValue([
      { id: "conv-1", goal: "First chat", goal_snippet: "First chat", created_at: "2026-01-01T00:00:00Z" },
      { id: "conv-2", goal: "Second chat", goal_snippet: "Second chat", created_at: "2026-01-01T00:00:00Z" },
    ]);
    mocked.getTree.mockImplementation(async (id) => trees[id]);
    mocked.listDocuments.mockResolvedValue([]);
    mocked.getMessages.mockImplementation(async (id) => views[id]);
  });

  async function renderApp() {
    render(<App />);
    await screen.findByText("hello from the first chat");
    mocked.getTree.mockClear();
    mocked.getMessages.mockClear();
  }

  it("clicking a match in another chat opens that chat with its side node active", async () => {
    mocked.searchMessages.mockResolvedValue({
      query: "moons",
      truncated: false,
      results: [
        result({
          conversation_id: "conv-2",
          conversation_name: "Second chat",
          thread_id: "side-2",
          thread_title: "Tangent on moons",
          is_side_node: true,
          snippet: "moons are interesting",
        }),
      ],
    });
    await renderApp();
    openSearch();
    typeQuery("moons");
    fireEvent.click(await screen.findByRole("button", { name: /Second chat/ }));

    expect(await screen.findByText("moons are interesting", { selector: "p, div, span" })).toBeTruthy();
    expect(mocked.getTree).toHaveBeenCalledWith("conv-2");
    expect(mocked.getMessages).toHaveBeenCalledWith("side-2");
    expect(screen.queryByRole("dialog", { name: "Search all chats" })).toBeNull();
    await waitFor(() => {
      const card = screen.getAllByText("Tangent on moons").map((node) => node.closest(".ring-2"));
      expect(card.some(Boolean)).toBe(true);
    });
  });

  it("shows an error when the server can't be reached and keeps the current chat", async () => {
    mocked.searchMessages.mockRejectedValue(new TypeError("Failed to fetch"));
    await renderApp();
    openSearch();
    typeQuery("anything");

    expect(await screen.findByText(/Could not search: Failed to fetch/)).toBeTruthy();
    expect(screen.getByText("hello from the first chat")).toBeTruthy();
    expect(mocked.getTree).not.toHaveBeenCalled();
    expect(mocked.getMessages).not.toHaveBeenCalled();
  });

  it("Esc closes the search without changing the open chat", async () => {
    mocked.searchMessages.mockResolvedValue({ query: "x", truncated: false, results: [result()] });
    await renderApp();
    openSearch();
    typeQuery("x");
    await screen.findAllByRole("listitem");
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Search all chats" })).toBeNull();
    expect(screen.getByText("hello from the first chat")).toBeTruthy();
    expect(mocked.getTree).not.toHaveBeenCalled();
    expect(mocked.getMessages).not.toHaveBeenCalled();
  });
});
