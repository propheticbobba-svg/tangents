import type { AncestryItem } from "./types";

export function Breadcrumb({
  ancestry,
  currentId,
  onSelect,
  disabled,
}: {
  ancestry: AncestryItem[];
  currentId: string;
  onSelect: (threadId: string) => void;
  disabled: boolean;
}) {
  return (
    <nav aria-label="Thread ancestry" className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs">
      {ancestry.map((item, index) => (
        <span key={item.id} className="flex min-w-0 items-center gap-1.5">
          {index > 0 && <span className="text-muted opacity-50">/</span>}
          <button
            type="button"
            disabled={disabled || item.id === currentId}
            onClick={() => onSelect(item.id)}
            className={`max-w-48 truncate transition-colors ${
              item.id === currentId ? "text-ink" : "text-muted hover:text-ink"
            } disabled:hover:text-muted`}
          >
            {item.title}
          </button>
        </span>
      ))}
    </nav>
  );
}
