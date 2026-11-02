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
      <div className="glass border-x-0 border-t-0 px-4 py-2.5">
        <p className="mx-auto max-w-3xl text-sm text-muted">
          The pinned goal appears with the first message on the center node.
        </p>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="glass border-x-0 border-t-0 px-4 py-2.5">
       <div className="mx-auto max-w-3xl">
        <div className="label">Goal</div>
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
          className="mt-1 w-full resize-none rounded-xl border border-line bg-transparent px-3 py-2 text-[15px] leading-6 outline-none focus:border-accent"
        />
        {error && <p className="text-danger mt-1 text-[13px]">{error}</p>}
       </div>
      </div>
    );
  }

  return (
    <div className="glass border-x-0 border-t-0 px-4 py-2.5">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-3">
          <span className="label">Goal</span>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="btn-ghost glow-ring min-h-8 px-3 text-xs"
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={`mt-1 w-full text-left text-[15px] leading-6 ${
            expanded ? "block max-h-48 overflow-y-auto whitespace-pre-wrap" : "line-clamp-2"
          }`}
        >
          {goal}
        </button>
      </div>
    </div>
  );
}
