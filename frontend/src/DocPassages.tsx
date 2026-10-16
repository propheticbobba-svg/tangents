import { useState } from "react";
import type { DocPassage } from "./types";

export function DocPassages({ passages }: { passages: DocPassage[] }) {
  const [open, setOpen] = useState(false);
  const label = passages.length === 1 ? "1 passage" : `${passages.length} passages`;
  return (
    <div className="glass mb-2 rounded-lg px-3 py-2">
      <button type="button" onClick={() => setOpen((value) => !value)} className="label select-none hover:text-ink">
        {open ? `Hide documents — ${label}` : `Searched your documents — ${label}`}
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {passages.map((passage, index) => (
            <li key={`${passage.title}-${index}`} className="py-1.5">
              <div className="text-xs text-ink">{passage.title}</div>
              <p className="line-clamp-2 text-xs text-muted">{passage.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
