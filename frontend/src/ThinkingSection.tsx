import { useEffect, useState } from "react";
import { Markdown } from "./Message";

function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

export function ThinkingSection({
  text,
  live,
  startedAt,
  endedAt,
  durationMs,
}: {
  text: string;
  live: boolean;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live || endedAt !== null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live, endedAt]);

  if (!text && !live) return null;

  const ticking = live && endedAt === null && startedAt !== null;
  const settledMs =
    durationMs ?? (startedAt !== null && endedAt !== null ? endedAt - startedAt : null);
  const label = ticking
    ? `Thinking… ${seconds(now - (startedAt as number))}s`
    : settledMs !== null
      ? `Thought for ${seconds(settledMs)}s`
      : "Thinking";

  return (
    <div className="mb-2 select-none text-xs text-muted">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="text-left"
      >
        {label}
      </button>
      {open && text && (
        <div className="mt-1 border-l-2 border-line pl-3">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}
