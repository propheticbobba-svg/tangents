import { useState } from "react";
import type { WebSource } from "./types";

export function WebActivity({ sources }: { sources: WebSource[] }) {
  const [open, setOpen] = useState(false);
  const label = sources.length === 1 ? "1 source" : `${sources.length} sources`;
  return (
    <div className="glass my-2 rounded-lg px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="label select-none hover:text-ink"
      >
        {open ? `Hide web ${label}` : `Searched the web — ${label}`}
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {sources.map((source) => (
            <li key={source.url} className="truncate py-1.5 text-xs">
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
