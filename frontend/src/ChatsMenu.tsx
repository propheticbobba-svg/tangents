import { useEffect, useRef } from "react";
import type { Conversation } from "./types";

/** A chat with no first message yet has no goal to name it by. */
export const UNTITLED_CHAT = "Untitled";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

/** Short, relative "last used" text: "Just now", "5 min ago", "Yesterday", "3 Nov". */
export function formatLastUsed(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = dayNumber(now) - dayNumber(then);
  if (days <= 1) return "Yesterday";
  if (days <= 7) return `${days} days ago`;
  const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
  return then.getFullYear() === now.getFullYear() ? date : `${date} ${then.getFullYear()}`;
}

export function sideChatLabel(count: number): string {
  if (count <= 0) return "No side chats";
  return count === 1 ? "1 side chat" : `${count} side chats`;
}

function usedAt(chat: Conversation): number {
  const time = new Date(chat.last_used_at ?? chat.created_at).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** Pinned chats first, then the rest; each group most recently used first. Ties keep their order. */
export function sortChats(list: Conversation[]): Conversation[] {
  return list
    .map((chat, index) => ({ chat, index }))
    .sort((a, b) => {
      const fav = Number(!!b.chat.favorite) - Number(!!a.chat.favorite);
      if (fav !== 0) return fav;
      const used = usedAt(b.chat) - usedAt(a.chat);
      return used !== 0 ? used : a.index - b.index;
    })
    .map(({ chat }) => chat);
}

function Pin({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
      <path d="M12 14v7" />
    </svg>
  );
}

export function ChatsMenu({
  conversations,
  activeId,
  open,
  onOpenChange,
  disabled,
  error,
  onPick,
  onDelete,
  onTogglePin,
}: {
  conversations: Conversation[];
  activeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  error: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, favorite: boolean) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onOpenChange(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  const now = new Date();

  return (
    <div className="min-w-0 md:relative" ref={menuRef}>
      <button
        type="button"
        disabled={disabled || conversations.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="btn-ghost glow-ring shrink-0 max-md:min-h-11"
      >
        Chats
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="glass fade-in absolute inset-x-3 top-full z-20 mt-2 max-h-80 overflow-y-auto rounded-2xl p-1.5 shadow-lg md:inset-x-auto md:left-0 md:w-96">
          {error && (
            <p role="alert" className="px-3 py-1.5 text-xs text-danger">
              {error}
            </p>
          )}
          <ul role="listbox" aria-label="Conversations">
            {conversations.map((conversation) => {
              const label = conversation.goal_snippet || UNTITLED_CHAT;
              const selected = conversation.id === activeId;
              const favorite = !!conversation.favorite;
              return (
                <li
                  key={conversation.id}
                  className={`flex items-center gap-1 rounded-xl pr-1 hover:bg-user ${selected ? "bg-user" : ""}`}
                >
                  <button
                    type="button"
                    aria-label={favorite ? `Unpin ${label}` : `Pin ${label}`}
                    aria-pressed={favorite}
                    onClick={() => onTogglePin(conversation.id, !favorite)}
                    className={`glow-ring flex shrink-0 items-center justify-center rounded-full px-2.5 py-1 max-md:min-h-11 max-md:min-w-11 ${favorite ? "text-accent" : "text-muted hover:text-ink"}`}
                  >
                    <Pin filled={favorite} />
                  </button>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onOpenChange(false);
                      onPick(conversation.id);
                    }}
                    className={`glow-ring min-w-0 flex-1 rounded-xl px-2 py-1.5 text-left max-md:min-h-11 text-sm ${selected ? "font-semibold text-ink" : "text-muted hover:text-ink"}`}
                  >
                    <span className="block truncate">{label}</span>
                    <span className="block truncate text-xs font-normal text-muted">
                      {formatLastUsed(conversation.last_used_at ?? conversation.created_at, now)}
                      {" · "}
                      {sideChatLabel(conversation.side_chat_count ?? 0)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${label}`}
                    disabled={disabled}
                    onClick={() => onDelete(conversation.id)}
                    className="glow-ring shrink-0 rounded-full px-2.5 py-1 text-xs max-md:min-h-11 font-semibold text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
