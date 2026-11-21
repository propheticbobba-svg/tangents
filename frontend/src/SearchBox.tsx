import { useEffect, useRef, useState, type ReactNode } from "react";
import { searchMessages } from "./api";
import type { SearchResult } from "./types";

const DEBOUNCE_MS = 250;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text: string, query: string): ReactNode {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi");
  const wordSet = new Set(words);
  return text.split(pattern).map((piece, index) =>
    wordSet.has(piece.toLowerCase()) ? (
      <mark key={index} className="rounded bg-glow px-0.5 text-ink">
        {piece}
      </mark>
    ) : (
      piece
    ),
  );
}

type Props = {
  disabled: boolean;
  onOpenResult: (result: SearchResult) => void;
};

export function SearchBox({ disabled, onOpenResult }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelPending() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }

  async function run(text: string) {
    cancelPending();
    const trimmed = text.trim();
    if (!trimmed) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await searchMessages(trimmed, controller.signal);
      if (controller.signal.aborted) return;
      setResults(response.results);
    } catch (err) {
      if (controller.signal.aborted) return;
      setResults(null);
      setError(err instanceof Error ? err.message : "Could not reach the server");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function close() {
    cancelPending();
    setOpen(false);
    setQuery("");
    setResults(null);
    setError(null);
    setLoading(false);
  }

  function onQuery(text: string) {
    setQuery(text);
    cancelPending();
    if (!text.trim()) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    timerRef.current = setTimeout(() => void run(text), DEBOUNCE_MS);
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

  useEffect(() => cancelPending, []);

  return (
    <div className="min-w-0 md:relative" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="btn-ghost glow-ring shrink-0 max-md:min-h-11"
      >
        Search
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Search all chats"
          className="glass fade-in absolute inset-x-3 top-full z-20 mt-2 flex max-h-[70dvh] flex-col gap-2 rounded-2xl p-2 shadow-lg md:inset-x-auto md:left-0 md:w-[28rem]"
        >
          <input
            type="search"
            autoFocus
            value={query}
            aria-label="Search all chats"
            placeholder="Search everything you've said…"
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void run(query);
            }}
            className="glow-ring w-full rounded-xl border border-line bg-paper px-3 py-2 text-sm text-ink max-md:min-h-11"
          />
          <div className="min-h-0 overflow-y-auto" aria-live="polite">
            {loading && <p className="shimmer px-3 py-2 text-sm">Searching…</p>}
            {error && <p className="px-3 py-2 text-sm text-danger">Could not search: {error}</p>}
            {!loading && !error && results !== null && results.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted">No matches</p>
            )}
            {!error && results !== null && results.length > 0 && (
              <ul role="list" className="flex flex-col gap-0.5">
                {results.map((result) => (
                  <li key={result.message_id}>
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        onOpenResult(result);
                      }}
                      className="glow-ring flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left hover:bg-user max-md:min-h-11"
                    >
                      <span className="flex items-center gap-2 text-xs text-muted">
                        <span className="truncate font-semibold text-ink">{result.conversation_name}</span>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{result.is_side_node ? result.thread_title : "Main chat"}</span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">{result.role === "user" ? "You" : "Claude"}</span>
                      </span>
                      <span className="text-sm leading-snug text-ink">{highlight(result.snippet, query)}</span>
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
