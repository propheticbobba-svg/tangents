import { useEffect, useRef, useState } from "react";
import { listBookmarks } from "./api";
import type { Bookmark } from "./types";

type Props = {
  conversationId: string | null;
  disabled: boolean;
  onOpenBookmark: (bookmark: Bookmark) => void;
};

export function BookmarksPanel({ conversationId, disabled, onOpenBookmark }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Bookmark[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);

  function close() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setOpen(false);
    setItems(null);
    setError(null);
    setLoading(false);
  }

  async function show() {
    if (!conversationId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setOpen(true);
    setItems(null);
    setError(null);
    setLoading(true);
    try {
      const list = await listBookmarks(conversationId, controller.signal);
      if (controller.signal.aborted) return;
      setItems(list);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Could not reach the server");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return (
    <div className="min-w-0 md:relative" ref={rootRef}>
      <button
        type="button"
        disabled={disabled || !conversationId}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : void show())}
        className="btn-ghost glow-ring shrink-0 max-md:min-h-11"
      >
        Bookmarks
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Bookmarks in this chat"
          className="glass fade-in absolute inset-x-3 top-full z-20 mt-2 flex max-h-[70dvh] flex-col gap-2 rounded-2xl p-2 shadow-lg md:inset-x-auto md:left-0 md:w-[28rem]"
        >
          <div className="min-h-0 overflow-y-auto" aria-live="polite">
            {loading && <p className="shimmer px-3 py-2 text-sm">Loading bookmarks…</p>}
            {error && <p className="px-3 py-2 text-sm text-danger">Could not load bookmarks: {error}</p>}
            {!loading && !error && items !== null && items.length === 0 && (
              <div className="px-3 py-2 text-sm">
                <p className="text-ink">No bookmarks in this chat yet</p>
                <p className="text-xs text-muted">Press the bookmark button under a message to add one.</p>
              </div>
            )}
            {!error && items !== null && items.length > 0 && (
              <ul role="list" className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <li key={item.message_id}>
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        onOpenBookmark(item);
                      }}
                      className="glow-ring flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left hover:bg-user max-md:min-h-11"
                    >
                      <span className="flex items-center gap-2 text-xs text-muted">
                        <span className="truncate">{item.is_side_node ? item.thread_title : "Main chat"}</span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">{item.role === "user" ? "You" : "Claude"}</span>
                      </span>
                      <span className="text-sm leading-snug text-ink">{item.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
