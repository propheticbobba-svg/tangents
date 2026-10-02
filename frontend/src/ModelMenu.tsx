import { useEffect, useRef, useState } from "react";
import { EFFORT_LABELS, MODELS, modelInfo, type Effort, type ModelId } from "./models";

export function ModelMenu({
  model,
  effort,
  extended,
  disabled,
  onModel,
  onEffort,
  onExtended,
}: {
  model: ModelId;
  effort: Effort | null;
  extended: boolean;
  disabled: boolean;
  onModel: (id: ModelId) => void;
  onEffort: (level: Effort) => void;
  onExtended: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const info = modelInfo(model);
  const label =
    info.thinking === "adaptive" && effort
      ? `${info.label} · ${EFFORT_LABELS[effort]}`
      : extended
        ? `${info.label} · Extended`
        : info.label;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model and effort, ${label}`}
        onClick={() => setOpen((current) => !current)}
        className="rounded-md border border-line bg-panel px-2 py-1 text-sm disabled:opacity-40"
      >
        {label}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Model and effort"
          className="absolute bottom-full right-0 z-20 mb-1 w-64 rounded-md border border-line bg-panel py-1 shadow-md"
        >
          {MODELS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === model}
              onClick={() => onModel(item.id)}
              className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-paper"
            >
              <span>{item.label}</span>
              {item.id === model && <span aria-hidden="true">✓</span>}
            </button>
          ))}
          {info.efforts.length > 0 && (
            <div className="mt-1 border-t border-line pt-1">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted">Effort</div>
              {info.efforts.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="menuitemradio"
                  aria-checked={level === effort}
                  onClick={() => {
                    onEffort(level);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-paper"
                >
                  <span>
                    {EFFORT_LABELS[level]}
                    {level === info.defaultEffort && (
                      <span className="ml-2 text-xs text-muted">Default</span>
                    )}
                  </span>
                  {level === effort && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          )}
          <div className="mt-1 border-t border-line pt-1">
            {info.thinking === "adaptive" ? (
              <p className="px-2 py-1.5 text-xs text-muted">Thinking is always on for this model.</p>
            ) : (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={extended}
                onClick={() => onExtended(!extended)}
                className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-paper"
              >
                <span>Extended thinking</span>
                {extended && <span aria-hidden="true">✓</span>}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
