import { useState } from "react";

export function CompactionDivider({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 text-xs text-muted"
      >
        <span className="h-px flex-1 bg-line" />
        <span>{open ? "Compacted here — hide" : "Compacted here"}</span>
        <span className="h-px flex-1 bg-line" />
      </button>
      {open && (
        <p className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-panel px-3 py-2 text-sm text-muted">
          {summary.trim() || "The summary was empty."}
        </p>
      )}
    </div>
  );
}
