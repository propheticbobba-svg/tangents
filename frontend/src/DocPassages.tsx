import { useState } from "react";
import type { DocPassage } from "./types";

export function DocPassages({ passages }: { passages: DocPassage[] }) {
  const [open, setOpen] = useState(false);
  const label = passages.length === 1 ? "1 passage" : `${passages.length} passages`;
  return (
    <div className="mb-2 select-none">
      <button type="button" onClick={() => setOpen((value) => !value)} className="text-xs text-muted hover:text-ink">
        {open ? `Hide documents — ${label}` : `Searched your documents — ${label}`}
      </button>
      {open && (
        <ul className="mt-1 space-y-2 rounded-md border border-line bg-panel px-3 py-2">
          {passages.map((passage, index) => (
            <li key={`${passage.title}-${index}`}>
              <div className="text-xs text-ink">{passage.title}</div>
              <p className="line-clamp-2 text-xs text-muted">{passage.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
