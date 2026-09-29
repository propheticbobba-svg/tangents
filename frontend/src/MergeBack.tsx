import { useState } from "react";
import { mergeThread, summarizeThread } from "./api";

export function MergeBack({
  threadId,
  model,
  disabled,
  onMerged,
}: {
  threadId: string;
  model: string;
  disabled: boolean;
  onMerged: (parentThreadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setOpen(true);
    setLoading(true);
    setError(null);
    setSummary("");
    try {
      const result = await summarizeThread(threadId, model);
      setSummary(result.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not summarize this side node");
    } finally {
      setLoading(false);
    }
  }

  async function confirm() {
    if (!summary.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const note = await mergeThread(threadId, summary.trim());
      setOpen(false);
      onMerged(note.thread_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not merge");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => void start()}
        className="rounded-md border border-line px-2 py-1 text-xs hover:border-accent disabled:opacity-40"
      >
        Merge back
      </button>
    );
  }

  return (
    <div className="absolute right-4 top-12 z-20 w-80 rounded-lg border border-line bg-panel p-3 shadow-lg">
      <div className="text-xs font-medium">Merge into the parent thread</div>
      <p className="mt-1 text-xs text-muted">
        This is appended as a note. Nothing is merged until you confirm.
      </p>
      <textarea
        rows={4}
        value={summary}
        disabled={loading}
        onChange={(event) => setSummary(event.target.value)}
        placeholder={loading ? "Writing a summary…" : "Summary"}
        className="mt-2 w-full resize-none rounded-md border border-line bg-paper px-2 py-1.5 text-sm outline-none focus:border-accent"
      />
      {error && <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-2 py-1 text-xs text-muted"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={loading || !summary.trim()}
          onClick={() => void confirm()}
          className="rounded-md bg-[#0f6e6b] px-2 py-1 text-xs text-[#f7fffe] disabled:opacity-40"
        >
          Append note
        </button>
      </div>
    </div>
  );
}
