import { useState } from "react";

export function CompactionDivider({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="label glow-ring flex min-h-8 w-full select-none items-center gap-3 rounded-full text-[13px] hover:text-ink"
      >
        <span className="h-px flex-1 rounded-full bg-line" />
        <span>{open ? "Compacted here — hide" : "Compacted here"}</span>
        <span className="h-px flex-1 rounded-full bg-line" />
      </button>
      {open && (
        <p className="glass fade-in mt-2 whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed text-muted">
          {summary.trim() || "The summary was empty."}
        </p>
      )}
    </div>
  );
}
