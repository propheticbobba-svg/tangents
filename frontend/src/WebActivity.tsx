import { useState } from "react";
import type { WebSource } from "./types";

export function WebActivity({ sources }: { sources: WebSource[] }) {
  const [open, setOpen] = useState(false);
  const label = sources.length === 1 ? "1 source" : `${sources.length} sources`;
  return (
    <div className="my-2 select-none">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-xs text-muted hover:text-ink"
      >
        {open ? `Hide web ${label}` : `Searched the web — ${label}`}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 rounded-md border border-line bg-panel px-3 py-2">
          {sources.map((source) => (
            <li key={source.url} className="truncate text-xs">
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent hover:underline"
              >
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
