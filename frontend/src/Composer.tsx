import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DictationPhase } from "./MicButton";

export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  prefillKey,
  controls,
  mic,
  dictationPhase = "idle",
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
  prefillKey: number;
  controls?: ReactNode;
  mic?: ReactNode;
  dictationPhase?: DictationPhase;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (prefillKey > 0) ref.current?.focus();
  }, [prefillKey]);

  return (
    <form
      className="px-4 pb-4 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && value.trim()) onSend();
      }}
    >
      <div
        className={`glass glow-ring mx-auto w-full max-w-3xl rounded-3xl p-3 ${
          focused ? "is-active" : ""
        } ${disabled ? "opacity-60" : ""}`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
      <label className="sr-only" htmlFor="composer">
        Message
      </label>
      <textarea
        id="composer"
        ref={ref}
        rows={3}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!disabled && value.trim()) onSend();
          }
        }}
        className="w-full resize-none border-0 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span
          className={`label ${
            dictationPhase === "listening" ? "animate-pulse motion-reduce:animate-none" : ""
          }`}
        >
          {dictationPhase === "listening"
            ? "Listening…"
            : dictationPhase === "transcribing"
              ? "Transcribing…"
              : "Enter to send · Shift+Enter for a new line"}
        </span>
        <div className="flex items-center gap-2">
          {controls}
          {mic}
          <button
            type="submit"
            disabled={disabled || !value.trim()}
            className="btn-primary"
          >
            Send
            <span aria-hidden="true">↑</span>
          </button>
        </div>
      </div>
      </div>
    </form>
  );
}
