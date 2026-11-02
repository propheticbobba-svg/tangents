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
        className="btn-ghost glow-ring min-h-11 px-4 text-[13px] font-semibold"
      >
        {label}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Model and effort"
          className="glass fade-in absolute bottom-full right-0 z-20 mb-2 w-64 max-w-[calc(100vw-2rem)] rounded-2xl py-1.5 shadow-lg"
        >
          {MODELS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === model}
              onClick={() => onModel(item.id)}
              className="mx-1.5 flex min-h-9 w-[calc(100%-0.75rem)] items-center justify-between rounded-xl px-3 py-2 text-left text-sm hover:bg-user"
            >
              <span>{item.label}</span>
              {item.id === model && <span aria-hidden="true" className="text-ink">✓</span>}
            </button>
          ))}
          {info.efforts.length > 0 && (
            <div className="mt-1 border-t border-line pt-1">
              <div className="label px-3 py-1">Effort</div>
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
                  className="mx-1.5 flex min-h-9 w-[calc(100%-0.75rem)] items-center justify-between rounded-xl px-3 py-2 text-left text-sm hover:bg-user"
                >
                  <span>
                    {EFFORT_LABELS[level]}
                    {level === info.defaultEffort && (
                      <span className="ml-2 text-xs text-muted">Default</span>
                    )}
                  </span>
                  {level === effort && <span aria-hidden="true" className="text-ink">✓</span>}
                </button>
              ))}
            </div>
          )}
          <div className="mt-1 border-t border-line pt-1">
            {info.thinking === "adaptive" ? (
              <p className="px-4 py-2 text-[13px] text-muted">Thinking is always on for this model.</p>
            ) : (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={extended}
                onClick={() => onExtended(!extended)}
                className="mx-1.5 flex min-h-9 w-[calc(100%-0.75rem)] items-center justify-between rounded-xl px-3 py-2 text-left text-sm hover:bg-user"
              >
                <span>Extended thinking</span>
                {extended && <span aria-hidden="true" className="text-ink">✓</span>}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
