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
    <nav aria-label="Thread ancestry" className="flex min-w-0 flex-wrap items-center gap-1 text-[13px]">
      {ancestry.map((item, index) => (
        <span key={item.id} className="flex min-w-0 items-center gap-1">
          {index > 0 && <span className="text-muted">/</span>}
          <button
            type="button"
            disabled={disabled || item.id === currentId}
            onClick={() => onSelect(item.id)}
            className={`glow-ring max-w-48 truncate rounded-full px-2.5 py-1 transition-colors ${
              item.id === currentId
                ? "font-semibold text-ink"
                : "text-muted hover:bg-user hover:text-ink"
            } disabled:hover:bg-transparent`}
          >
            {item.title}
          </button>
        </span>
      ))}
    </nav>
  );
}
