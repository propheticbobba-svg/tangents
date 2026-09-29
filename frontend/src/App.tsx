import { useEffect, useState } from "react";
import {
  createConversation,
  createThread,
  getMessages,
  getTree,
  listConversations,
  streamMessage,
  updateGoal,
} from "./api";
import { ChatPane } from "./ChatPane";
import { TreeView } from "./TreeView";
import { MODELS, loadModel, saveModel, type ModelId } from "./models";
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

  const centerThreadId = tree?.threads.find((thread) => thread.parent_thread_id === null)?.id ?? null;

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
    setSending(true);
    setError(null);
    setDraft("");
    setStreaming({ text: "", summaries: [] });
    let failed = false;
    try {
      await streamMessage(targetThreadId, content, model, (event) => {
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
          }));
        } else if (event.event === "compaction") {
          setStreaming((current) => ({
            text: current?.text ?? "",
            summaries: [...(current?.summaries ?? []), event.data.content],
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
      <header className="flex h-14 items-center gap-3 border-b border-line px-4">
        <span className="font-serif text-lg">Tangents</span>
        <label className="sr-only" htmlFor="conversation">
          Conversation
        </label>
        <select
          id="conversation"
          value={conversationId ?? ""}
          disabled={sending || conversations.length === 0}
          onChange={(event) => void pickConversation(event.target.value)}
          className="max-w-xs truncate rounded-md border border-line bg-panel px-2 py-1 text-sm"
        >
          {conversations.length === 0 && <option value="">No conversations</option>}
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.goal_snippet || "New conversation"}
            </option>
          ))}
        </select>
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
