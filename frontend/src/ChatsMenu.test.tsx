import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { App } from "./App";
import { ChatsMenu, formatLastUsed, sideChatLabel, sortChats } from "./ChatsMenu";
import type { Conversation, Message, Thread, ThreadView, Tree } from "./types";

vi.mock("./api");
const mocked = vi.mocked(api);

const NOW = new Date(2026, 10, 23, 15, 0, 0); // 23 Nov 2026, local time

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function chat(id: string, name: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    goal: name,
    goal_snippet: name,
    created_at: ago(30 * DAY),
    last_used_at: ago(HOUR),
    favorite: false,
    side_chat_count: 0,
    ...extra,
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

function renderMenu(conversations: Conversation[], props: Partial<Parameters<typeof ChatsMenu>[0]> = {}) {
  return render(
    <ChatsMenu
      conversations={conversations}
      activeId={null}
      open
      onOpenChange={vi.fn()}
      disabled={false}
      error={null}
      onPick={vi.fn()}
      onDelete={vi.fn()}
      onTogglePin={vi.fn()}
      {...props}
    />,
  );
}

describe("formatting", () => {
  it("formats last used times", () => {
    expect(formatLastUsed(ago(20_000), NOW)).toBe("Just now");
    expect(formatLastUsed(ago(5 * 60_000), NOW)).toBe("5 min ago");
    expect(formatLastUsed(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(formatLastUsed(ago(3 * HOUR), NOW)).toBe("3 hours ago");
    expect(formatLastUsed(ago(DAY + 2 * HOUR), NOW)).toBe("Yesterday");
    expect(formatLastUsed(ago(4 * DAY), NOW)).toBe("4 days ago");
    expect(formatLastUsed(new Date(2026, 10, 3, 10).toISOString(), NOW)).toBe("3 Nov");
    expect(formatLastUsed(new Date(2025, 10, 3, 10).toISOString(), NOW)).toBe("3 Nov 2025");
  });

  it("labels side chat counts", () => {
    expect(sideChatLabel(0)).toBe("No side chats");
    expect(sideChatLabel(1)).toBe("1 side chat");
    expect(sideChatLabel(4)).toBe("4 side chats");
  });

  it("sorts pinned first, then by last used", () => {
    const sorted = sortChats([
      chat("a", "A", { last_used_at: ago(3 * HOUR) }),
      chat("b", "B", { last_used_at: ago(HOUR), favorite: false }),
      chat("c", "C", { last_used_at: ago(9 * HOUR), favorite: true }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["c", "b", "a"]);
  });
});

describe("ChatsMenu rows", () => {
  it("shows when each chat was last used", () => {
    renderMenu([
      chat("a", "Three hours", { last_used_at: ago(3 * HOUR) }),
      chat("b", "Recent chat", { last_used_at: ago(DAY + 2 * HOUR) }),
      chat("c", "Old chat", { last_used_at: new Date(2026, 10, 3, 10).toISOString() }),
    ]);
    expect(screen.getByText(/^3 hours ago/)).toBeTruthy();
    expect(screen.getByText(/^Yesterday/)).toBeTruthy();
    expect(screen.getByText(/^3 Nov/)).toBeTruthy();
  });

  it("shows how many side chats each chat has", () => {
    renderMenu([
      chat("a", "Many", { side_chat_count: 4 }),
      chat("b", "One", { side_chat_count: 1 }),
      chat("c", "None", { side_chat_count: 0 }),
    ]);
    expect(screen.getByText(/4 side chats/)).toBeTruthy();
    expect(screen.getByText(/· 1 side chat$/)).toBeTruthy();
    expect(screen.getByText(/No side chats/)).toBeTruthy();
  });

  it("the pin toggles without opening the chat or closing the menu", () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    const onTogglePin = vi.fn();
    renderMenu([chat("a", "Trip planning")], { onPick, onOpenChange, onTogglePin });
    fireEvent.click(screen.getByRole("button", { name: "Pin Trip planning" }));
    expect(onTogglePin).toHaveBeenCalledWith("a", true);
    expect(onPick).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("Chats menu inside the app", () => {
  const trees: Record<string, Tree> = {};
  const views: Record<string, ThreadView> = {};

  function msg(id: string, threadId: string, role: "user" | "assistant", text: string, cutOff = false): Message {
    return {
      id,
      parent_id: null,
      role,
      content: [{ type: "text", text }],
      thread_id: threadId,
      created_at: ago(HOUR),
      is_note: false,
      usage: cutOff ? ({ stop_reason: "max_tokens" } as Message["usage"]) : null,
    };
  }

  function setup(list: Conversation[]) {
    for (const item of list) {
      const center: Thread = {
        id: `center-${item.id}`,
        conversation_id: item.id,
        parent_thread_id: null,
        fork_message_id: null,
        title: item.goal ?? "",
        created_at: item.created_at,
      };
      trees[item.id] = { conversation_id: item.id, goal: item.goal, threads: [center] };
      views[center.id] = {
        thread: center,
        messages: [msg(`m-${item.id}`, center.id, "assistant", `hello from ${item.goal}`, item.id === "old")],
        forked_from: null,
        ancestry: [],
      };
    }
    mocked.listConversations.mockResolvedValue(list);
    mocked.getTree.mockImplementation(async (id) => trees[id]);
    mocked.listDocuments.mockResolvedValue([]);
    mocked.getMessages.mockImplementation(async (id) => views[id]);
  }

  const newer = () => chat("new", "Newest chat", { last_used_at: ago(HOUR) });
  const older = () => chat("old", "Older chat", { last_used_at: ago(5 * DAY) });

  async function openMenu() {
    fireEvent.click(await screen.findByRole("button", { name: /Chats/ }));
    return screen.findByRole("listbox", { name: "Conversations" });
  }

  function order(): string[] {
    return screen.getAllByRole("option").map((option) => option.textContent ?? "");
  }

  it("pinning a chat marks it pinned and moves it to the top without changing the open chat", async () => {
    setup([newer(), older()]);
    mocked.setFavorite.mockResolvedValue({ ...older(), favorite: true });
    render(<App />);
    await screen.findByText("hello from Newest chat");
    await openMenu();
    mocked.getTree.mockClear();

    const star = screen.getByRole("button", { name: "Pin Older chat" });
    fireEvent.click(star);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Unpin Older chat" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(mocked.setFavorite).toHaveBeenCalledWith("old", true);
    expect(order()[0]).toContain("Older chat");
    expect(screen.getByRole("listbox", { name: "Conversations" })).toBeTruthy();
    expect(mocked.getTree).not.toHaveBeenCalled();
    const open = screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true");
    expect(open?.textContent).toContain("Newest chat");
    expect(screen.getByText("hello from Newest chat")).toBeTruthy();
  });

  it("unpinning a chat moves it back among the others by last used", async () => {
    setup([older, newer].map((make) => make()).map((item) => (item.id === "old" ? { ...item, favorite: true } : item)));
    mocked.setFavorite.mockResolvedValue(older());
    render(<App />);
    await openMenu();
    expect(order()[0]).toContain("Older chat");

    fireEvent.click(screen.getByRole("button", { name: "Unpin Older chat" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Pin Older chat" }).getAttribute("aria-pressed"),
      ).toBe("false"),
    );
    expect(mocked.setFavorite).toHaveBeenCalledWith("old", false);
    expect(order()[0]).toContain("Newest chat");
    expect(order()[1]).toContain("Older chat");
  });

  it("pinned chats from the server are pinned and on top after a reload", async () => {
    setup([{ ...older(), favorite: true }, newer()]);
    const first = render(<App />);
    await openMenu();
    first.unmount();
    cleanup();

    render(<App />);
    await openMenu();
    expect(order()[0]).toContain("Older chat");
    expect(
      screen.getByRole("button", { name: "Unpin Older chat" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("puts the pin back and shows an error when the pin can't be saved", async () => {
    setup([newer(), older()]);
    mocked.setFavorite.mockRejectedValue(new Error("down"));
    render(<App />);
    await openMenu();

    fireEvent.click(screen.getByRole("button", { name: "Pin Older chat" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't save that pin");
    expect(
      screen.getByRole("button", { name: "Pin Older chat" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(order()[0]).toContain("Newest chat");
  });

  it("after sending a message in an older chat, the menu shows it above other chats with Just now", async () => {
    setup([newer(), older(), chat("third", "Third chat", { last_used_at: ago(2 * HOUR) })]);
    mocked.streamMessage.mockResolvedValue(undefined);
    render(<App />);
    await screen.findByText("hello from Newest chat");

    await openMenu();
    fireEvent.click(screen.getByRole("option", { name: /Older chat/ }));
    await screen.findByText("hello from Older chat");

    // The server now reports the older chat as just used.
    mocked.listConversations.mockResolvedValue([
      { ...older(), last_used_at: NOW.toISOString(), side_chat_count: 0 },
      newer(),
      chat("third", "Third chat", { last_used_at: ago(2 * HOUR) }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocked.streamMessage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: /Chats/ }).hasAttribute("disabled")).toBe(false));

    const list = await openMenu();
    await waitFor(() => expect(order()[0]).toContain("Older chat"));
    expect(within(list).getAllByRole("option")[0].textContent).toContain("Just now");
  });
});
