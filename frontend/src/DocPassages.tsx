import { useState } from "react";
import type { DocPassage } from "./types";

export function DocPassages({ passages }: { passages: DocPassage[] }) {
  const [open, setOpen] = useState(false);
  const label = passages.length === 1 ? "1 passage" : `${passages.length} passages`;
  return (
    <div className="glass mb-3 rounded-2xl px-4 py-2.5">
      <button type="button" onClick={() => setOpen((value) => !value)} className="label glow-ring min-h-7 select-none rounded-full text-[13px] hover:text-ink">
        {open ? `Hide documents — ${label}` : `Searched your documents — ${label}`}
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {passages.map((passage, index) => (
            <li key={`${passage.title}-${index}`} className="py-2">
              <div className="text-[13px] font-semibold text-ink">{passage.title}</div>
              <p className="line-clamp-2 text-[13px] text-muted">{passage.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
