import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CompactionDivider } from "./CompactionDivider";
import { DocPassages } from "./DocPassages";
import { UsageFooter } from "./UsageFooter";
import { WebActivity } from "./WebActivity";
import { ThinkingSection } from "./ThinkingSection";
import {
  compactionSummaries,
  docPassages,
  messageText,
  thinkingText,
  webSources,
  type Message as ChatMessage,
} from "./types";

const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table">
      <table {...props} />
    </div>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function MessageView({
  message,
  onFork,
  forkDisabled,
  onContinue,
}: {
  message: ChatMessage;
  onFork: (messageId: string) => void;
  forkDisabled: boolean;
  onContinue?: () => void;
}) {
  const text = messageText(message.content);
  const thinking = thinkingText(message.content);
  const summaries = compactionSummaries(message.content);
  const sources = webSources(message.content);
  const passages = docPassages(message.content);
  const user = message.role === "user";
  const stopReason = message.usage?.stop_reason;

  return (
    <article
      data-message-id={message.id}
      data-role={message.role}
      className={user ? "ml-16" : "mr-10"}
    >
      {summaries.map((summary, index) => (
        <CompactionDivider key={`${message.id}-compact-${index}`} summary={summary} />
      ))}
      {message.role === "assistant" && thinking && (
        <ThinkingSection
          text={thinking}
          live={false}
          startedAt={null}
          endedAt={null}
          durationMs={message.usage?.thinking_ms ?? null}
        />
      )}
      {sources.length > 0 && <WebActivity sources={sources} />}
      {passages.length > 0 && <DocPassages passages={passages} />}
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
      {message.role === "assistant" && stopReason === "max_tokens" && (
        <div className="mt-1 flex items-center gap-2">
          <p className="text-xs text-muted">Claude hit the maximum length for this message.</p>
          {onContinue && (
            <button
              type="button"
              disabled={forkDisabled}
              onClick={onContinue}
              className="rounded-md border border-line px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-ink disabled:opacity-40"
            >
              Continue
            </button>
          )}
        </div>
      )}
      {message.role === "assistant" && stopReason === "model_context_window_exceeded" && (
        <p className="mt-1 text-xs text-muted">This node ran out of context.</p>
      )}
      {message.role === "assistant" && stopReason === "refusal" && (
        <p className="mt-1 text-xs text-muted">Claude stopped this reply.</p>
      )}
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

export function StreamingMessage({
  text,
  summaries,
  activity,
  thinking,
  thinkingStartedAt,
  thinkingEndedAt,
}: {
  text: string;
  summaries: string[];
  activity: string[];
  thinking: string;
  thinkingStartedAt: number | null;
  thinkingEndedAt: number | null;
}) {
  return (
    <article className="mr-10" data-role="assistant">
      {summaries.map((summary, index) => (
        <CompactionDivider key={`stream-compact-${index}`} summary={summary} />
      ))}
      {thinkingStartedAt !== null && (
        <ThinkingSection
          text={thinking}
          live
          startedAt={thinkingStartedAt}
          endedAt={thinkingEndedAt}
          durationMs={null}
        />
      )}
      {activity.length > 0 && (
        <ul className="mb-2 select-none space-y-0.5 text-xs text-muted">
          {activity.map((line, index) => (
            <li key={`stream-activity-${index}`} className="truncate">
              {line}
            </li>
          ))}
        </ul>
      )}
      {text ? (
        <Markdown text={text} />
      ) : (
        summaries.length === 0 && activity.length === 0 && thinkingStartedAt === null && (
          <p className="text-sm text-muted">Thinking…</p>
        )
      )}
    </article>
  );
}
