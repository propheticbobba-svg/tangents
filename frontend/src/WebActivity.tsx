import { useState } from "react";
import type { WebSource } from "./types";

export function WebActivity({ sources }: { sources: WebSource[] }) {
  const [open, setOpen] = useState(false);
  const label = sources.length === 1 ? "1 source" : `${sources.length} sources`;
  return (
    <div className="glass my-3 rounded-2xl px-4 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="label glow-ring min-h-7 select-none rounded-full text-[13px] hover:text-ink"
      >
        {open ? `Hide web ${label}` : `Searched the web — ${label}`}
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {sources.map((source) => (
            <li key={source.url} className="truncate py-2 text-[13px]">
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-ink hover:underline"
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
