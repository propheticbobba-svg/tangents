import { useEffect, useRef, useState } from "react";

export function PinnedGoal({
  goal,
  onSave,
}: {
  goal: string | null;
  onSave: (goal: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const savingRef = useRef(false);

  useEffect(() => {
    setDraft(goal ?? "");
  }, [goal]);

  async function save() {
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the goal");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (goal === null && !editing) {
    return (
      <div className="border-b border-line px-4 py-2 text-sm text-muted">
        The pinned goal appears with the first message on the center node.
      </div>
    );
  }

  if (editing) {
    return (
      <div className="border-b border-line px-4 py-2">
        <div className="text-[10px] uppercase tracking-wide text-muted">Goal</div>
        <textarea
          autoFocus
          rows={3}
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancelRef.current = true;
              setDraft(goal ?? "");
              setEditing(false);
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void save();
            }
          }}
          className="mt-1 w-full resize-none bg-transparent font-serif text-sm outline-none"
        />
        {error && <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
      </div>
    );
  }

  return (
    <div className="border-b border-line px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">Goal</span>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-xs text-accent"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={`mt-1 w-full text-left font-serif text-sm ${
          expanded ? "block max-h-48 overflow-y-auto whitespace-pre-wrap" : "line-clamp-2"
        }`}
      >
        {goal}
      </button>
    </div>
  );
}
