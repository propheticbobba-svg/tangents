import { useEffect, useRef, useState } from "react";
import { Breadcrumb } from "./Breadcrumb";
import { Composer } from "./Composer";
import { MergeBack } from "./MergeBack";
import { MessageView, StreamingMessage } from "./Message";
import { PinnedGoal } from "./PinnedGoal";
import { SelectionPopover } from "./SelectionPopover";
import { messageText, type StreamingTurn, type ThreadView } from "./types";

function forkPreview(text: string): string {
  const prose = text.split("```")[0] ?? text;
  return prose.replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim();
}

type Selection = {
  messageId: string;
  text: string;
  x: number;
  y: number;
};

export function ChatPane({
  view,
  goal,
  streaming,
  sending,
  error,
  draft,
  prefillKey,
  onDraft,
  onSend,
  onFork,
  onForkSelection,
  onSelectThread,
  onBackToCenter,
  onSaveGoal,
  onMerged,
  model,
}: {
  view: ThreadView | null;
  goal: string | null;
  streaming: StreamingTurn | null;
  sending: boolean;
  error: string | null;
  draft: string;
  prefillKey: number;
  onDraft: (value: string) => void;
  onSend: () => void;
  onFork: (messageId: string) => void;
  onForkSelection: (messageId: string, text: string, mode: "quote" | "explain") => void;
  onSelectThread: (threadId: string) => void;
  onBackToCenter: () => void;
  onSaveGoal: (goal: string) => Promise<void>;
  onMerged: (parentThreadId: string) => void;
  model: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const sideNode = view !== null && view.thread.parent_thread_id !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [view?.messages.length, streaming?.text, streaming?.summaries.length, streaming?.activity.length]);

  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text || sel.rangeCount === 0) return;
    const node = sel.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    const message = element?.closest("[data-message-id]");
    if (!(message instanceof HTMLElement) || message.dataset.role !== "assistant") return;
    const messageId = message.dataset.messageId;
    if (!messageId) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelection({
      messageId,
      text,
      x: Math.min(Math.max(8, rect.left), window.innerWidth - 220),
      y: Math.min(rect.bottom + 8, window.innerHeight - 48),
    });
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <PinnedGoal goal={goal} onSave={onSaveGoal} />
      <div className="relative flex items-center gap-3 border-b border-line px-4 py-2">
        {view && (
          <Breadcrumb
            ancestry={view.ancestry}
            currentId={view.thread.id}
            onSelect={onSelectThread}
            disabled={sending}
          />
        )}
        <div className="flex-1" />
        {sideNode && view && (
          <>
            <button
              type="button"
              disabled={sending}
              onClick={onBackToCenter}
              className="rounded-md border border-line px-2 py-1 text-xs hover:border-accent disabled:opacity-40"
            >
              Back to center
            </button>
            <MergeBack threadId={view.thread.id} model={model} disabled={sending} onMerged={onMerged} />
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" onMouseUp={captureSelection}>
        {view?.forked_from && (
          <blockquote className="mb-4 border-l-2 border-accent/40 pl-3 text-sm text-muted">
            <div className="text-[10px] uppercase tracking-wide">Forked from</div>
            <p className="mt-1 line-clamp-3">{forkPreview(messageText(view.forked_from.content))}</p>
          </blockquote>
        )}
        {view && view.messages.length === 0 && !streaming && (
          <p className="text-sm text-muted">
            {sideNode
              ? "This side node inherits the path up to the fork, and nothing written here is added to the parent thread."
              : "This is the center node. The main thread stays here."}
          </p>
        )}
        <div className="flex flex-col gap-4">
          {view?.messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              onFork={onFork}
              forkDisabled={sending}
            />
          ))}
          {streaming && (
            <StreamingMessage
              text={streaming.text}
              summaries={streaming.summaries}
              activity={streaming.activity}
            />
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      {error && (
        <p className="px-4 pb-2 text-sm text-rose-700 dark:text-rose-300" role="alert">
          {error}
        </p>
      )}
      <Composer
        value={draft}
        onChange={onDraft}
        onSend={onSend}
        disabled={sending || !view}
        prefillKey={prefillKey}
        placeholder={sideNode ? "Continue this side node" : "Message the center node"}
      />
      {selection && !sending && (
        <SelectionPopover
          x={selection.x}
          y={selection.y}
          onClose={() => setSelection(null)}
          onFork={() => {
            const chosen = selection;
            setSelection(null);
            window.getSelection()?.removeAllRanges();
            onForkSelection(chosen.messageId, chosen.text, "quote");
          }}
          onExplain={() => {
            const chosen = selection;
            setSelection(null);
            window.getSelection()?.removeAllRanges();
            onForkSelection(chosen.messageId, chosen.text, "explain");
          }}
        />
      )}
    </section>
  );
}
