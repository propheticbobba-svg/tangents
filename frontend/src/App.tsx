import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  createConversation,
  createThread,
  deleteConversation,
  deleteDocument,
  deleteThread,
  getMessages,
  getTree,
  listConversations,
  listDocuments,
  setBookmark,
  setFavorite,
  streamMessage,
  updateGoal,
  uploadDocument,
} from "./api";
import { ChatPane } from "./ChatPane";
import { ChatsMenu, UNTITLED_CHAT, sortChats } from "./ChatsMenu";
import { appendDictation, emptyDraft, isDraftEmpty, serializeDraft, textDraft, type Draft } from "./draft";
import { DocumentsPanel } from "./DocumentsPanel";
import { MicButton, type DictationPhase } from "./MicButton";
import { ResizeHandle } from "./ResizeHandle";
import { SearchBox } from "./SearchBox";
import { TreeView } from "./TreeView";
import { loadCharts, saveCharts } from "./charts";
import { loadDocSearch, saveDocSearch } from "./docsearch";
import { ModelMenu } from "./ModelMenu";
import {
  loadEffort,
  loadExtendedThinking,
  loadModel,
  modelInfo,
  saveEffort,
  saveExtendedThinking,
  saveModel,
  type Effort,
  type ModelId,
} from "./models";
import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth } from "./sidebar";
import { loadWebSearch, saveWebSearch } from "./websearch";
import { useTheme } from "./theme";
import {
  quoteText,
  type Conversation,
  type SearchResult,
  type DocumentInfo,
  type StreamingTurn,
  type Thread,
  type ThreadView,
  type Tree,
} from "./types";

function subtreeIds(threads: Thread[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let growing = true;
  while (growing) {
    growing = false;
    for (const thread of threads) {
      const parentId = thread.parent_thread_id;
      if (parentId !== null && ids.has(parentId) && !ids.has(thread.id)) {
        ids.add(thread.id);
        growing = true;
      }
    }
  }
  return ids;
}

function toggleClass(on: boolean): string {
  return `btn-ghost glow-ring shrink-0 max-md:min-h-11${
    on ? " !border-accent !bg-accent !text-[var(--on-accent)] font-semibold" : ""
  }`;
}

/** Solid when on, hollow when off, so the state does not rely on color alone. */
function ToggleDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 rounded-full border-[1.5px] border-current ${on ? "bg-current" : "bg-transparent"}`}
    />
  );
}

export function App() {
  const { resolved, toggle } = useTheme();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [view, setView] = useState<ThreadView | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [dictationPhase, setDictationPhase] = useState<DictationPhase>("idle");
  const [formulaMic, setFormulaMic] = useState<string | null>(null);
  const [prefillKey, setPrefillKey] = useState(0);
  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [jump, setJump] = useState<{ messageId: string; nonce: number } | null>(null);
  const [model, setModel] = useState<ModelId>(loadModel);
  const [effort, setEffort] = useState<Effort | null>(() => loadEffort(loadModel()));
  const [extended, setExtended] = useState<boolean>(loadExtendedThinking);
  const [web, setWeb] = useState<boolean>(loadWebSearch);
  const [docs, setDocs] = useState<boolean>(loadDocSearch);
  const [charts, setCharts] = useState<boolean>(loadCharts);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [indexing, setIndexing] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(loadSidebarWidth()));
  const asideRef = useRef<HTMLElement>(null);


  async function openConversation(id: string, preferredThreadId?: string) {
    const [nextTree, nextDocuments] = await Promise.all([getTree(id), listDocuments(id)]);
    setConversationId(id);
    setTree(nextTree);
    setDocuments(nextDocuments);
    setDocError(null);
    const center = nextTree.threads.find((thread) => thread.parent_thread_id === null);
    const nextThread =
      preferredThreadId && nextTree.threads.some((thread) => thread.id === preferredThreadId)
        ? preferredThreadId
        : (center?.id ?? null);
    setThreadId(nextThread);
    setView(nextThread ? await getMessages(nextThread) : null);
  }

  const pinSaving = useRef(false);
  // Bumped whenever a pin starts or finishes saving; a list fetched across a bump may be stale.
  const pinVersion = useRef(0);

  function changeMenuOpen(open: boolean) {
    setMenuOpen(open);
    if (!open) return;
    setChatsError(null);
    // Fresh list (times, order, counts) every time the menu opens; keep the old one on failure.
    const startedAt = pinVersion.current;
    void listConversations()
      .then((list) => {
        if (pinVersion.current === startedAt && !pinSaving.current) setConversations(list);
      })
      .catch(() => undefined);
  }

  function markBookmarked(messageId: string, bookmarked: boolean) {
    setView((current) =>
      current
        ? {
            ...current,
            messages: current.messages.map((m) => (m.id === messageId ? { ...m, bookmarked } : m)),
            forked_from:
              current.forked_from && current.forked_from.id === messageId
                ? { ...current.forked_from, bookmarked }
                : current.forked_from,
          }
        : current,
    );
  }

  async function toggleBookmark(messageId: string, bookmarked: boolean) {
    setError(null);
    markBookmarked(messageId, bookmarked);
    try {
      await setBookmark(messageId, bookmarked);
    } catch {
      markBookmarked(messageId, !bookmarked);
      setError("Couldn't save that bookmark");
    }
  }

  async function togglePin(id: string, favorite: boolean) {
    // The list re-sorts at once, so a quick second click lands on another chat: ignore it until saved.
    if (pinSaving.current) return;
    pinSaving.current = true;
    pinVersion.current += 1;
    const previous = conversations;
    setChatsError(null);
    setConversations(sortChats(previous.map((item) => (item.id === id ? { ...item, favorite } : item))));
    try {
      await setFavorite(id, favorite);
    } catch {
      setConversations((list) =>
        sortChats(list.map((item) => (item.id === id ? { ...item, favorite: !favorite } : item))),
      );
      setChatsError("Couldn't save that pin");
    } finally {
      pinSaving.current = false;
      pinVersion.current += 1;
    }
  }

  useEffect(() => {
    function onResize() {
      setSidebarWidth(clampSidebarWidth(loadSidebarWidth()));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
    setDraft(emptyDraft());
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
    const label = current.goal_snippet || UNTITLED_CHAT;
    if (!window.confirm(`Delete “${label}”? This cannot be undone.`)) return;
    setError(null);
    try {
      await deleteConversation(id);
      const index = conversations.findIndex((item) => item.id === id);
      const remaining = conversations.filter((item) => item.id !== id);
      setConversations(remaining);
      if (id !== conversationId) return;
      setDraft(emptyDraft());
      setStreaming(null);
      const next = remaining[index] ?? remaining[index - 1] ?? null;
      if (next) {
        await openConversation(next.id);
      } else {
        setConversationId(null);
        setTree(null);
        setDocuments([]);
        setThreadId(null);
        setView(null);
        setMenuOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that conversation");
    }
  }

  async function removeThread(id: string) {
    if (sending || !tree || !conversationId) return;
    const thread = tree.threads.find((item) => item.id === id);
    if (!thread || thread.parent_thread_id === null) return;
    const subtree = subtreeIds(tree.threads, id);
    const childCount = subtree.size - 1;
    const title = thread.title;
    const prompt =
      childCount === 0
        ? `Delete “${title}”? This cannot be undone.`
        : `Delete “${title}” and ${childCount} side ${childCount === 1 ? "node" : "nodes"} under it? This cannot be undone.`;
    if (!window.confirm(prompt)) return;
    const parentId = thread.parent_thread_id;
    setError(null);
    try {
      await deleteThread(id);
      setTree(await getTree(conversationId));
      if (threadId !== null && subtree.has(threadId)) {
        setDraft(emptyDraft());
        setStreaming(null);
        setThreadId(parentId);
        setView(await getMessages(parentId));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that node");
    }
  }

  async function pickConversation(id: string) {
    if (sending || id === conversationId) return;
    setError(null);
    setDraft(emptyDraft());
    setStreaming(null);
    setJump(null);
    await openConversation(id);
  }

  async function openSearchResult(result: SearchResult) {
    if (sending) return;
    setMenuOpen(false);
    setError(null);
    setDraft(emptyDraft());
    setStreaming(null);
    try {
      await openConversation(result.conversation_id, result.thread_id);
      setJump({ messageId: result.message_id, nonce: Date.now() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that result");
    }
  }

  async function selectThread(id: string) {
    if (sending || id === threadId) return;
    setError(null);
    setDraft(emptyDraft());
    setStreaming(null);
    setJump(null);
    try {
      setThreadId(id);
      setView(await getMessages(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that node");
    }
  }

  async function send(targetThreadId: string, content: string, restore?: Draft) {
    setMenuOpen(false);
    setSending(true);
    setError(null);
    setDraft(emptyDraft());
    const info = modelInfo(model);
    setStreaming({
      text: "",
      summaries: [],
      activity: [],
      thinking: "",
      thinkingStartedAt: null,
      thinkingEndedAt: null,
    });
    let failed = false;
    try {
      await streamMessage(
        targetThreadId,
        content,
        model,
        web,
        docs && documents.length > 0,
        charts,
        info.efforts.length ? effort : null,
        (info.thinking as "adaptive" | "extended") === "extended" && extended,
        (event) => {
        if (event.event === "user_message") {
          setView((current) =>
            current && current.thread.id === targetThreadId
              ? { ...current, messages: [...current.messages, event.data] }
              : current,
          );
        } else if (event.event === "thinking") {
          setStreaming((current) =>
            current && {
              ...current,
              thinking: current.thinking + event.data.text,
              thinkingStartedAt: current.thinkingStartedAt ?? Date.now(),
            },
          );
        } else if (event.event === "delta") {
          setStreaming((current) =>
            current && {
              ...current,
              text: current.text + event.data.text,
              thinkingEndedAt:
                current.thinkingStartedAt !== null && current.thinkingEndedAt === null
                  ? Date.now()
                  : current.thinkingEndedAt,
            },
          );
        } else if (event.event === "compaction") {
          setStreaming((current) =>
            current && { ...current, summaries: [...current.summaries, event.data.content] },
          );
        } else if (event.event === "web_activity") {
          const label =
            event.data.tool === "web_fetch"
              ? `Reading ${event.data.url}`
              : `Searching for ${event.data.query}`;
          setStreaming((current) => current && { ...current, activity: [...current.activity, label] });
        } else if (event.event === "web_result") {
          setStreaming((current) =>
            current && {
              ...current,
              activity: [
                ...current.activity,
                `Found ${event.data.sources.length} source${event.data.sources.length === 1 ? "" : "s"}`,
              ],
            },
          );
        } else if (event.event === "error") {
          failed = true;
          setError(event.data.error);
          setDraft(restore ?? textDraft(content));
          setStreaming(null);
        }
      },
      );
      if (conversationId) await refreshLists(conversationId);
      const fresh = await getMessages(targetThreadId);
      setView((current) => (current && current.thread.id === targetThreadId ? fresh : current));
      if (failed) setDraft(restore ?? textDraft(content));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
      setDraft(restore ?? textDraft(content));
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
        setDraft(textDraft(quoteText(selection)));
        setPrefillKey((value) => value + 1);
      } else {
        setDraft(emptyDraft());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not fork");
    } finally {
      if (!handedOff) setSending(false);
    }
  }

  async function uploadFiles(files: File[]) {
    if (!conversationId || sending) return;
    setDocError(null);
    for (const file of files) {
      setIndexing(file.name);
      try {
        await uploadDocument(conversationId, file);
      } catch (err) {
        setDocError(err instanceof Error ? err.message : "Could not add that document");
      }
    }
    setIndexing(null);
    try {
      setDocuments(await listDocuments(conversationId));
    } catch (err) {
      setDocError(err instanceof Error ? err.message : "Could not refresh documents");
    }
  }

  async function removeDocument(document: DocumentInfo) {
    if (!conversationId || sending || indexing) return;
    if (!window.confirm(`Delete “${document.filename}”?`)) return;
    setDocError(null);
    try {
      await deleteDocument(document.id);
      setDocuments(await listDocuments(conversationId));
    } catch (err) {
      setDocError(err instanceof Error ? err.message : "Could not delete that document");
    }
  }

  function previewSidebarWidth(width: number) {
    asideRef.current?.style.setProperty("--sidebar-w", `${width}px`);
  }

  function commitSidebarWidth(width: number) {
    setSidebarWidth(width);
    saveSidebarWidth(width);
  }

  async function saveGoal(goal: string) {
    if (!conversationId) return;
    const updated = await updateGoal(conversationId, goal);
    setTree((current) => (current ? { ...current, goal: updated.goal } : current));
    setConversations((list) => list.map((item) => (item.id === conversationId ? { ...item, ...updated } : item)));
  }

  return (
    <div className="flex h-full flex-col text-ink">
      <header className="relative z-20 flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2 md:h-16 md:flex-nowrap md:gap-2.5 md:px-5 md:py-0">
        <span className="mr-2 flex shrink-0 items-center gap-2 font-sans text-lg font-bold tracking-tight">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-accent" />
          Tangents
        </span>
        <ChatsMenu
          conversations={conversations}
          activeId={conversationId}
          open={menuOpen}
          onOpenChange={changeMenuOpen}
          disabled={sending}
          error={chatsError}
          onPick={(id) => void pickConversation(id)}
          onDelete={(id) => void removeConversation(id)}
          onTogglePin={(id, favorite) => void togglePin(id, favorite)}
        />
        <SearchBox disabled={sending} onOpenResult={(result) => void openSearchResult(result)} />
        <button
          type="button"
          disabled={sending}
          onClick={() => void startConversation()}
          className="btn-ghost glow-ring shrink-0 whitespace-nowrap max-md:min-h-11"
        >
          New conversation
        </button>
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
          className={toggleClass(web)}
        >
          <ToggleDot on={web} />
          Web
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={docs}
          aria-label="Search this conversation's documents"
          disabled={sending || documents.length === 0}
          onClick={() => {
            const next = !docs;
            setDocs(next);
            saveDocSearch(next);
          }}
          className={toggleClass(docs)}
        >
          <ToggleDot on={docs} />
          Docs
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={charts}
          aria-label="Let Claude draw charts"
          disabled={sending}
          onClick={() => {
            const next = !charts;
            setCharts(next);
            saveCharts(next);
          }}
          className={toggleClass(charts)}
        >
          <ToggleDot on={charts} />
          Charts
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggle}
          className="btn-ghost glow-ring shrink-0 whitespace-nowrap max-md:min-h-11"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {resolved === "dark" ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </>
            ) : (
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            )}
          </svg>
          {resolved === "dark" ? "Light" : "Dark"}
        </button>
      </header>
      {booting ? (
        <p className="shimmer px-6 py-8 text-base">Loading…</p>
      ) : !conversationId ? (
        <div className="flex flex-1 items-center justify-center px-6 py-12">
          <div className="glass fade-in flex max-w-2xl flex-col items-center gap-5 rounded-3xl p-8 text-center md:p-12">
            <h1 className="text-3xl font-bold leading-tight tracking-tight md:text-4xl">
              A center node, and side nodes for the tangents.
            </h1>
            <p className="max-w-lg text-base leading-relaxed text-muted md:text-lg">
              The main thread never picks up tokens from a side node. A side node only inherits the path up to the message you forked from.
            </p>
            {error && <p className="text-danger text-sm">{error}</p>}
            <button
              type="button"
              onClick={() => void startConversation()}
              className="btn-primary glow-ring px-6 py-2.5 !text-base"
            >
              New conversation
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-visible">
          <ChatPane
            jump={jump}
            view={view}
            goal={tree?.goal ?? null}
            streaming={streaming}
            sending={sending}
            error={error}
            draft={draft}
            prefillKey={prefillKey}
            onDraft={setDraft}
            onSend={() => {
              if (!threadId || isDraftEmpty(draft)) return;
              const content = serializeDraft(draft).trim();
              if (content) void send(threadId, content, draft);
            }}
            onToggleBookmark={(messageId, next) => void toggleBookmark(messageId, next)}
            onFork={(messageId) => void forkFrom(messageId, "open")}
            onForkSelection={(messageId, text, mode) => void forkFrom(messageId, mode, text)}
            onSelectThread={(id) => void selectThread(id)}
            onSaveGoal={saveGoal}
            controls={
              <ModelMenu
                model={model}
                effort={effort}
                extended={extended}
                disabled={sending}
                onModel={(next) => {
                  setModel(next);
                  saveModel(next);
                  setEffort(loadEffort(next));
                }}
                onEffort={(level) => {
                  setEffort(level);
                  saveEffort(model, level);
                }}
                onExtended={(value) => {
                  setExtended(value);
                  saveExtendedThinking(value);
                }}
              />
            }
            mic={
              <MicButton
                disabled={sending || !view || formulaMic !== null}
                onText={(parts) => setDraft((current) => appendDictation(current, parts))}
                onError={setError}
                onPhase={(phase) => {
                  setDictationPhase(phase);
                  if (phase === "listening") setError(null);
                }}
              />
            }
            dictationPhase={dictationPhase}
            formulaMic={formulaMic}
            onFormulaMic={setFormulaMic}
            onComposerError={setError}
            onContinue={() => {
              if (threadId && !sending) void send(threadId, "Continue");
            }}
          />
          <aside
            ref={asideRef}
            style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
            className="relative flex h-[75dvh] w-full shrink-0 flex-col border-t border-line bg-panel md:h-auto md:w-[var(--sidebar-w)] md:border-l md:border-t-0"
          >
            <ResizeHandle width={sidebarWidth} onPreview={previewSidebarWidth} onCommit={commitSidebarWidth} />
            <DocumentsPanel
              documents={documents}
              disabled={sending}
              indexing={indexing}
              error={docError}
              onUpload={(files) => void uploadFiles(files)}
              onDelete={(document) => void removeDocument(document)}
            />
            <div className="label px-4 pb-1.5 pt-3">
              Tree
            </div>
            <div className="min-h-0 flex-1">
              <TreeView
                threads={tree?.threads ?? []}
                activeThreadId={threadId}
                onSelect={(id) => void selectThread(id)}
                onDelete={(id) => void removeThread(id)}
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
