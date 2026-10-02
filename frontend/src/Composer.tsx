import { useEffect, useRef, type ReactNode } from "react";

export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  prefillKey,
  controls,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
  prefillKey: number;
  controls?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (prefillKey > 0) ref.current?.focus();
  }, [prefillKey]);

  return (
    <form
      className="border-t border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && value.trim()) onSend();
      }}
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
        className="w-full resize-none rounded-lg border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs text-muted">Enter to send · Shift+Enter for a new line</span>
        <div className="flex items-center gap-2">
          {controls}
          <button
            type="submit"
            disabled={disabled || !value.trim()}
            className="rounded-md bg-[#0f6e6b] px-3 py-1.5 text-sm text-[#f7fffe] disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </form>
  );
}
