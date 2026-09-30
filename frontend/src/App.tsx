import { useEffect, useRef, useState } from "react";
import {
  createConversation,
  createThread,
  deleteConversation,
  getMessages,
  getTree,
  listConversations,
  streamMessage,
  updateGoal,
} from "./api";
import { ChatPane } from "./ChatPane";
import { TreeView } from "./TreeView";
import { MODELS, loadModel, saveModel, type ModelId } from "./models";
import { loadWebSearch, saveWebSearch } from "./websearch";
import { useTheme } from "./theme";
import { quoteText, type Conversation, type StreamingTurn, type ThreadView, type Tree } from "./types";

export function App() {
  const { resolved, toggle } = useTheme();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [view, setView] = useState<ThreadView | null>(null);
  const [draft, setDraft] = useState("");
  const [prefillKey, setPrefillKey] = useState(0);
  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [model, setModel] = useState<ModelId>(loadModel);
  const [web, setWeb] = useState<boolean>(loadWebSearch);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const centerThreadId = tree?.threads.find((thread) => thread.parent_thread_id === null)?.id ?? null;
  const currentLabel =
    conversations.find((item) => item.id === conversationId)?.goal_snippet ||
    (conversationId ? "New conversation" : "No conversations");

  async function openConversation(id: string, preferredThreadId?: string) {
    const nextTree = await getTree(id);
    setConversationId(id);
    setTree(nextTree);
    const center = nextTree.threads.find((thread) => thread.parent_thread_id === null);
    const nextThread =
      preferredThreadId && nextTree.threads.some((thread) => thread.id === preferredThreadId)
        ? preferredThreadId
        : (center?.id ?? null);
    setThreadId(nextThread);
    setView(nextThread ? await getMessages(nextThread) : null);
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    listConversations()
      .then(async (list) => {
        setConversations(list);
        if (list[0]) await openConversation(list[0].id);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not reach the server");
      })
      .finally(() => setBooting(false));
  }, []);

  async function refreshLists(id: string) {
    const [nextTree, list] = await Promise.all([getTree(id), listConversations()]);
    setTree(nextTree);
    setConversations(list);
  }

  async function startConversation() {
    if (sending) return;
    setMenuOpen(false);
    setError(null);
    setDraft("");
    try {
      const created = await createConversation();
      setConversations(await listConversations());
      await openConversation(created.id, created.center_thread_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a conversation");
    }
  }

  async function removeConversation(id: string) {
    if (sending) return;
    const current = conversations.find((item) => item.id === id);
    if (!current) return;
    const label = current.goal_snippet || "New conversation";
    if (!window.confirm(`Delete “${label}”? This cannot be undone.`)) return;
    setError(null);
    try {
      await deleteConversation(id);
      const index = conversations.findIndex((item) => item.id === id);
      const remaining = conversations.filter((item) => item.id !== id);
      setConversations(remaining);
      if (id !== conversationId) return;
      setDraft("");
      setStreaming(null);
      const next = remaining[index] ?? remaining[index - 1] ?? null;
      if (next) {
        await openConversation(next.id);
      } else {
        setConversationId(null);
        setTree(null);
        setThreadId(null);
        setView(null);
        setMenuOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that conversation");
    }
  }

  async function pickConversation(id: string) {
    if (sending || id === conversationId) return;
    setError(null);
    setDraft("");
    setStreaming(null);
    await openConversation(id);
  }

  async function selectThread(id: string) {
    if (sending || id === threadId) return;
    setError(null);
    setDraft("");
    setStreaming(null);
    try {
      setThreadId(id);
      setView(await getMessages(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that node");
    }
  }

  async function send(targetThreadId: string, content: string) {
    setMenuOpen(false);
    setSending(true);
    setError(null);
    setDraft("");
    setStreaming({ text: "", summaries: [], activity: [] });
    let failed = false;
    try {
      await streamMessage(targetThreadId, content, model, web, (event) => {
        if (event.event === "user_message") {
          setView((current) =>
            current && current.thread.id === targetThreadId
              ? { ...current, messages: [...current.messages, event.data] }
              : current,
          );
        } else if (event.event === "delta") {
          setStreaming((current) => ({
            text: (current?.text ?? "") + event.data.text,
            summaries: current?.summaries ?? [],
            activity: current?.activity ?? [],
          }));
        } else if (event.event === "compaction") {
          setStreaming((current) => ({
            text: current?.text ?? "",
            summaries: [...(current?.summaries ?? []), event.data.content],
            activity: current?.activity ?? [],
          }));
        } else if (event.event === "web_activity") {
          const label =
            event.data.tool === "web_fetch"
              ? `Reading ${event.data.url}`
              : `Searching for ${event.data.query}`;
          setStreaming((current) => ({
            text: current?.text ?? "",
            summaries: current?.summaries ?? [],
            activity: [...(current?.activity ?? []), label],
          }));
        } else if (event.event === "web_result") {
          setStreaming((current) => ({
            text: current?.text ?? "",
            summaries: current?.summaries ?? [],
            activity: [
              ...(current?.activity ?? []),
              `Found ${event.data.sources.length} source${event.data.sources.length === 1 ? "" : "s"}`,
            ],
          }));
        } else if (event.event === "error") {
          failed = true;
          setError(event.data.error);
          setDraft(content);
          setStreaming(null);
        }
      });
      if (conversationId) await refreshLists(conversationId);
      const fresh = await getMessages(targetThreadId);
      setView((current) => (current && current.thread.id === targetThreadId ? fresh : current));
      if (failed) setDraft(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
      setDraft(content);
      try {
        const fresh = await getMessages(targetThreadId);
        setView((current) => (current && current.thread.id === targetThreadId ? fresh : current));
      } catch {
        /* the server may be down; the error above is enough */
      }
    } finally {
      setStreaming(null);
      setSending(false);
    }
  }

  async function forkFrom(messageId: string, mode: "open" | "quote" | "explain", selection?: string) {
    if (sending || !conversationId) return;
    setSending(true);
    let handedOff = false;
    try {
      const thread = await createThread(messageId);
      setTree(await getTree(conversationId));
      setThreadId(thread.id);
      setView(await getMessages(thread.id));
      setError(null);
      if (mode === "explain" && selection) {
        handedOff = true;
        await send(thread.id, `${quoteText(selection)}Explain this.`);
        return;
      }
      if (mode === "quote" && selection) {
        setDraft(quoteText(selection));
        setPrefillKey((value) => value + 1);
      } else {
        setDraft("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not fork");
    } finally {
      if (!handedOff) setSending(false);
    }
  }

  async function saveGoal(goal: string) {
    if (!conversationId) return;
    const updated = await updateGoal(conversationId, goal);
    setTree((current) => (current ? { ...current, goal: updated.goal } : current));
    setConversations((list) => list.map((item) => (item.id === conversationId ? { ...item, ...updated } : item)));
  }

  async function onMerged(parentThreadId: string) {
    if (conversationId) setTree(await getTree(conversationId));
    setThreadId(parentThreadId);
    setDraft("");
    setView(await getMessages(parentThreadId));
  }

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <header className="relative z-20 flex h-14 items-center gap-3 border-b border-line px-4">
        <span className="font-serif text-lg">Tangents</span>
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            disabled={sending || conversations.length === 0}
            aria-label={`Conversation: ${currentLabel}`}
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="inline-block max-w-xs truncate rounded-md border border-line bg-panel px-2 py-1 text-left text-sm disabled:opacity-40"
          >
            {currentLabel}
          </button>
          {menuOpen && (
            <ul
              role="listbox"
              aria-label="Conversations"
              className="absolute left-0 top-full z-20 mt-1 max-h-72 w-80 overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-md"
            >
              {conversations.map((conversation) => {
                const label = conversation.goal_snippet || "New conversation";
                const selected = conversation.id === conversationId;
                return (
                  <li key={conversation.id} className="flex items-center gap-1 pr-1">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        setMenuOpen(false);
                        void pickConversation(conversation.id);
                      }}
                      className={`min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm ${selected ? "text-accent" : "hover:bg-paper"}`}
                    >
                      {label}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${label}`}
                      disabled={sending}
                      onClick={() => void removeConversation(conversation.id)}
                      className="shrink-0 rounded px-1.5 py-1 text-xs text-muted hover:text-rose-700 disabled:opacity-40 dark:hover:text-rose-300"
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <button
          type="button"
          disabled={sending}
          onClick={() => void startConversation()}
          className="rounded-md border border-line px-2 py-1 text-sm hover:border-accent disabled:opacity-40"
        >
          New conversation
        </button>
        <label className="sr-only" htmlFor="model">
          Model
        </label>
        <select
          id="model"
          value={model}
          disabled={sending}
          onChange={(event) => {
            const next = event.target.value as ModelId;
            setModel(next);
            saveModel(next);
          }}
          className="rounded-md border border-line bg-panel px-2 py-1 text-sm"
        >
          {MODELS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          role="switch"
          aria-checked={web}
          aria-label="Search the web"
          disabled={sending}
          onClick={() => {
            const next = !web;
            setWeb(next);
            saveWebSearch(next);
          }}
          className={`rounded-md border px-2 py-1 text-sm disabled:opacity-40 ${
            web ? "border-accent text-accent" : "border-line text-muted"
          }`}
        >
          Web
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggle}
          className="rounded-md border border-line px-2 py-1 text-sm"
        >
          {resolved === "dark" ? "Light" : "Dark"}
        </button>
      </header>
      {booting ? (
        <p className="p-6 text-sm text-muted">Loading…</p>
      ) : !conversationId ? (
        <div className="flex flex-1 flex-col items-start justify-center gap-3 px-8">
          <h1 className="font-serif text-2xl">A center node, and side nodes for the tangents.</h1>
          <p className="max-w-md text-sm text-muted">
            The main thread never picks up tokens from a side node. A side node only inherits the path up to the message you forked from.
          </p>
          {error && <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>}
          <button
            type="button"
            onClick={() => void startConversation()}
            className="rounded-md bg-[#0f6e6b] px-3 py-1.5 text-sm text-[#f7fffe]"
          >
            New conversation
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ChatPane
            view={view}
            goal={tree?.goal ?? null}
            streaming={streaming}
            sending={sending}
            error={error}
            draft={draft}
            prefillKey={prefillKey}
            onDraft={setDraft}
            onSend={() => {
              if (threadId && draft.trim()) void send(threadId, draft.trim());
            }}
            onFork={(messageId) => void forkFrom(messageId, "open")}
            onForkSelection={(messageId, text, mode) => void forkFrom(messageId, mode, text)}
            onSelectThread={(id) => void selectThread(id)}
            onBackToCenter={() => {
              if (centerThreadId) void selectThread(centerThreadId);
            }}
            onSaveGoal={saveGoal}
            onMerged={(parentThreadId) => void onMerged(parentThreadId)}
            model={model}
          />
          <aside className="flex w-96 shrink-0 flex-col border-l border-line">
            <div className="border-b border-line px-3 py-2 text-[10px] uppercase tracking-wide text-muted">
              Tree
            </div>
            <div className="min-h-0 flex-1">
              <TreeView
                threads={tree?.threads ?? []}
                activeThreadId={threadId}
                onSelect={(id) => void selectThread(id)}
                disabled={sending}
                colorMode={resolved}
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
