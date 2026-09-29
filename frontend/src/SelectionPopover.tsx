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
      className="fixed z-30 flex gap-1 rounded-lg border border-line bg-panel p-1 shadow-lg"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={onFork}
        className="rounded-md px-2 py-1 text-xs hover:bg-user"
      >
        Fork from this
      </button>
      <button
        type="button"
        onClick={onExplain}
        className="rounded-md px-2 py-1 text-xs hover:bg-user"
      >
        Explain this
      </button>
    </div>
  );
}
