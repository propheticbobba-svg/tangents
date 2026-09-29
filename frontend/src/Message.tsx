import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CompactionDivider } from "./CompactionDivider";
import { UsageFooter } from "./UsageFooter";
import { compactionSummaries, messageText, type Message as ChatMessage } from "./types";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function MessageView({
  message,
  onFork,
  forkDisabled,
}: {
  message: ChatMessage;
  onFork: (messageId: string) => void;
  forkDisabled: boolean;
}) {
  const text = messageText(message.content);
  const summaries = compactionSummaries(message.content);
  const user = message.role === "user";

  return (
    <article
      data-message-id={message.id}
      data-role={message.role}
      className={user ? "ml-16" : "mr-10"}
    >
      {summaries.map((summary, index) => (
        <CompactionDivider key={`${message.id}-compact-${index}`} summary={summary} />
      ))}
      <div
        className={
          user
            ? `rounded-lg px-3 py-2 ${message.is_note ? "border border-dashed border-accent/50 bg-panel" : "bg-user"}`
            : ""
        }
      >
        {message.is_note && (
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Note</div>
        )}
        {text && <Markdown text={text} />}
      </div>
      {message.role === "assistant" && message.usage && <UsageFooter usage={message.usage} />}
      {message.role === "assistant" && (
        <div className="pointer-events-none contents">
          <button
            type="button"
            disabled={forkDisabled}
            onClick={() => onFork(message.id)}
            className="pointer-events-auto sticky bottom-3 z-10 mt-1 ml-auto block w-fit rounded-md border border-line bg-paper px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-ink disabled:opacity-40"
          >
            Fork
          </button>
        </div>
      )}
    </article>
  );
}

export function StreamingMessage({ text, summaries }: { text: string; summaries: string[] }) {
  return (
    <article className="mr-10" data-role="assistant">
      {summaries.map((summary, index) => (
        <CompactionDivider key={`stream-compact-${index}`} summary={summary} />
      ))}
      {text ? (
        <Markdown text={text} />
      ) : (
        summaries.length === 0 && <p className="text-sm text-muted">Thinking…</p>
      )}
    </article>
  );
}
