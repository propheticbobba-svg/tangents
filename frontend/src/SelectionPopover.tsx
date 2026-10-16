import { useEffect, useRef } from "react";

export function SelectionPopover({
  x,
  y,
  onFork,
  onExplain,
  onClose,
}: {
  x: number;
  y: number;
  onFork: () => void;
  onExplain: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="glass fade-in fixed z-30 flex gap-1 rounded-full p-1 shadow-lg"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={onFork}
        className="btn-ghost glow-ring border-transparent px-3 py-1 text-xs"
      >
        Fork from this
      </button>
      <button
        type="button"
        onClick={onExplain}
        className="btn-ghost glow-ring border-transparent px-3 py-1 text-xs"
      >
        Explain this
      </button>
    </div>
  );
}
