import katex from "katex";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cleanLatex } from "./draft";
import { KATEX_OPTIONS } from "./mathText";
import type { DictationPhase } from "./useDictation";

const HIDE_DELAY_MS = 150;
const POPOVER_WIDTH = 320;
const GAP = 8;
const MARGIN = 8;

/** Display style so a fraction is full size inside a line of text. */
export function renderFormula(latex: string, display = false): { html: string; error: string | null } {
  const source = display ? latex : `\\displaystyle ${latex}`;
  try {
    return {
      html: katex.renderToString(source, { ...KATEX_OPTIONS, displayMode: display, throwOnError: true }),
      error: null,
    };
  } catch (err) {
    return { html: "", error: err instanceof Error ? err.message : "Could not render this formula" };
  }
}

type Anchor = { left: number; right: number; top: number; bottom: number };
type Size = { width: number; height: number };

function anchorOf(element: HTMLElement): Anchor {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
}

/**
 * Centered over the chip with a gap, so the formula stays visible; below it when
 * there is no room above. Kept inside the viewport. Plain left/top, no transform:
 * `.fade-in` animates transform and holds its end state, which would override one.
 */
export function floatingPosition(anchor: Anchor, size: Size, viewportWidth: number): { left: number; top: number } {
  const center = (anchor.left + anchor.right) / 2;
  const left = Math.max(MARGIN, Math.min(center - size.width / 2, viewportWidth - size.width - MARGIN));
  const above = anchor.top - GAP - size.height;
  return { left, top: above >= MARGIN ? above : anchor.bottom + GAP };
}

/** Measures the floating element after each render and positions it; hidden until measured. */
function useFloating(anchor: Anchor) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const next = { width: element.offsetWidth, height: element.offsetHeight };
    setSize((current) =>
      current && current.width === next.width && current.height === next.height ? current : next,
    );
  });
  const style: CSSProperties = size
    ? floatingPosition(anchor, size, window.innerWidth)
    : { left: 0, top: 0, visibility: "hidden" };
  return { ref, style };
}

function Floating({ anchor, children, onPointerEnter, onPointerLeave, className }: {
  anchor: Anchor;
  children: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  className: string;
}) {
  const { ref, style } = useFloating(anchor);
  return createPortal(
    <div
      ref={ref}
      className={`glass fade-in fixed z-40 shadow-lg ${className}`}
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>,
    document.body,
  );
}

export function LatexEditor({
  initial,
  anchor,
  onSave,
  onCancel,
}: {
  initial: string;
  anchor: Anchor;
  onSave: (latex: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const { ref, style } = useFloating(anchor);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const preview = renderFormula(cleanLatex(value) || " ", true);

  function save() {
    const latex = cleanLatex(valueRef.current);
    if (latex) onSave(latex);
    else onCancel();
  }
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    textRef.current?.focus();
    textRef.current?.select();
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) saveRef.current();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Edit formula"
      className="glass fade-in fixed z-40 flex flex-col gap-2 rounded-2xl p-3 shadow-lg"
      style={{ ...style, width: POPOVER_WIDTH }}
    >
      <label className="label" htmlFor="formula-latex">
        LaTeX
      </label>
      <textarea
        id="formula-latex"
        ref={textRef}
        rows={3}
        value={value}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="w-full resize-none rounded-lg border border-line bg-transparent px-2 py-1 font-mono text-xs outline-none"
      />
      <div className="formula-preview min-h-10 overflow-x-auto" aria-live="polite">
        {preview.error ? (
          <p className="text-danger font-mono text-[11px]">{preview.error}</p>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: preview.html }} />
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost px-3 py-1 text-xs">
          Cancel
        </button>
        <button type="button" onClick={save} className="btn-primary px-3 py-1 text-xs">
          Save
        </button>
      </div>
    </div>,
    document.body,
  );
}

export type VoiceControl = {
  phase: DictationPhase;
  disabled: boolean;
  onToggle: () => void;
  onCancel: () => void;
};

/**
 * One formula box in the composer: rendered math, and on hover (or when selected
 * with the keyboard) a toolbar with Edit with text, Edit with voice, and Undo math.
 */
export function FormulaChip({
  latex,
  selected,
  editable,
  voice,
  onEditText,
  onUndo,
}: {
  latex: string;
  selected: boolean;
  editable: boolean;
  voice: VoiceControl;
  onEditText: (latex: string) => void;
  onUndo: () => void;
}) {
  const chipRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const rendered = renderFormula(latex);
  const voiceActive = voice.phase !== "idle";
  const toolbarOpen = editable && !editing && (hovered || selected || voiceActive);
  const floating = toolbarOpen || editing;

  function show() {
    window.clearTimeout(hideTimer.current);
    setHovered(true);
  }

  function hideSoon() {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHovered(false), HIDE_DELAY_MS);
  }

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);

  useLayoutEffect(() => {
    if (!floating || !chipRef.current) return;
    const chip = chipRef.current;
    const update = () => setAnchor(anchorOf(chip));
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [floating]);

  return (
    <>
      <span
        ref={chipRef}
        className={`formula-chip ${selected ? "is-selected" : ""} ${voiceActive ? "is-voice" : ""} ${
          rendered.error ? "has-error" : ""
        }`}
        aria-busy={voice.phase === "transcribing" || undefined}
        title={rendered.error ? "Could not render this formula" : undefined}
        aria-label={`Formula: ${latex}`}
        role="img"
        onPointerEnter={show}
        onPointerLeave={hideSoon}
      >
        {rendered.error ? (
          <span className="text-danger font-mono text-xs">{latex}</span>
        ) : (
          <span dangerouslySetInnerHTML={{ __html: rendered.html }} />
        )}
      </span>
      {toolbarOpen && anchor && (
        <Floating
          anchor={anchor}
          className="flex items-center gap-1 whitespace-nowrap rounded-full p-1"
          onPointerEnter={show}
          onPointerLeave={hideSoon}
        >
          <div className="contents" onMouseDown={(event) => event.preventDefault()}>
            {voice.phase === "listening" ? (
              <>
                <span className="label px-2 animate-pulse motion-reduce:animate-none">Listening…</span>
                <button
                  type="button"
                  onClick={voice.onToggle}
                  className="mic-live rounded-full px-3 py-1 text-xs"
                >
                  Stop
                </button>
                <button
                  type="button"
                  onClick={voice.onCancel}
                  className="btn-ghost glow-ring border-transparent px-3 py-1 text-xs"
                >
                  Cancel
                </button>
              </>
            ) : voice.phase === "transcribing" ? (
              <span className="label px-3 py-1">Updating…</span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="btn-ghost glow-ring border-transparent px-3 py-1 text-xs"
                >
                  Edit with text
                </button>
                <button
                  type="button"
                  disabled={voice.disabled}
                  onClick={voice.onToggle}
                  className="btn-ghost glow-ring border-transparent px-3 py-1 text-xs"
                >
                  Edit with voice
                </button>
                <button
                  type="button"
                  onClick={onUndo}
                  className="btn-ghost glow-ring border-transparent px-3 py-1 text-xs"
                >
                  Undo math
                </button>
              </>
            )}
          </div>
        </Floating>
      )}
      {editing && anchor && (
        <LatexEditor
          initial={latex}
          anchor={anchor}
          onSave={(next) => {
            setEditing(false);
            setHovered(false);
            onEditText(next);
          }}
          onCancel={() => {
            setEditing(false);
            setHovered(false);
          }}
        />
      )}
    </>
  );
}
