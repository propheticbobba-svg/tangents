import { parseSpokenMath } from "./api";
import type { SpokenPart } from "./draft";
import { useDictation, type DictationPhase } from "./useDictation";

export type { DictationPhase } from "./useDictation";

export function MicButtonView({
  listening,
  busy,
  disabled,
  onClick,
}: {
  listening: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = busy ? "Transcribing" : listening ? "Stop dictating" : "Dictate";
  return (
    <button
      type="button"
      className={`grid h-8 w-8 place-items-center rounded-full transition-colors disabled:opacity-40 ${
        listening ? "mic-live" : "mic-idle"
      }`}
      aria-label={label}
      title={label}
      aria-pressed={listening}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={onClick}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
        <path d="M19 11a7 7 0 0 1-14 0" />
        <path d="M12 18v3" />
      </svg>
    </button>
  );
}

/** Composer dictation. A transcript that looks like math comes back with formula parts. */
export function MicButton({
  disabled,
  onText,
  onError,
  onPhase,
}: {
  disabled: boolean;
  onText: (parts: SpokenPart[]) => void;
  onError: (message: string) => void;
  onPhase: (phase: DictationPhase) => void;
}) {
  const { phase, toggle } = useDictation({
    disabled,
    process: parseSpokenMath,
    onResult: onText,
    onError,
    onPhase,
  });
  return (
    <MicButtonView
      listening={phase === "listening"}
      busy={phase === "transcribing"}
      disabled={disabled}
      onClick={toggle}
    />
  );
}
