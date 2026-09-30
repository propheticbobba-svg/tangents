import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, clampSidebarWidth, maxSidebarWidth } from "./sidebar";

const STEP = 16;
const BIG_STEP = 64;

function releaseBody() {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

export function ResizeHandle({
  width,
  onPreview,
  onCommit,
}: {
  width: number;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);

  useEffect(() => () => {
    if (drag.current) releaseBody();
  }, []);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, latest: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current) return;
    const next = clampSidebarWidth(current.startWidth + current.startX - event.clientX);
    if (next === current.latest) return;
    current.latest = next;
    onPreview(next);
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    releaseBody();
    onCommit(current.latest);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width + step;
    else if (event.key === "ArrowRight") next = width - step;
    if (next === null) return;
    event.preventDefault();
    onCommit(clampSidebarWidth(next));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize tree panel"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={maxSidebarWidth()}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => onCommit(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH))}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -left-px z-30 w-1.5 cursor-col-resize touch-none select-none outline-none hover:bg-accent/30 focus-visible:bg-accent/40"
    />
  );
}
