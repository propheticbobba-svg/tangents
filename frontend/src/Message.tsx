import type { Element, ElementContent } from "hast";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CHART_LANGUAGE } from "./chart";
import { ChartPlaceholder, PlotlyChart } from "./PlotlyChart";
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

function hastText(node: Element | ElementContent): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(hastText).join("");
  return "";
}

function chartSource(node: Element | undefined): string | null {
  const code = node?.children[0];
  if (!code || code.type !== "element" || code.tagName !== "code") return null;
  const classes = code.properties?.className;
  if (!Array.isArray(classes) || !classes.includes(`language-${CHART_LANGUAGE}`)) return null;
  return hastText(code);
}

function chartComponents(streaming: boolean): Components {
  return {
    pre({ node, children, ...rest }) {
      const source = chartSource(node);
      if (source === null) return <pre {...rest}>{children}</pre>;
      return streaming ? <ChartPlaceholder /> : <PlotlyChart source={source} />;
    },
    table({ node, children, ...rest }) {
      if (!node) return null;
      return (
        <div className="markdown-table">
          <table {...rest}>{children}</table>
        </div>
      );
    },
  };
}

const FINISHED_COMPONENTS = chartComponents(false);
const STREAMING_COMPONENTS = chartComponents(true);

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { plainText: [CHART_LANGUAGE] }]]}
        components={streaming ? STREAMING_COMPONENTS : FINISHED_COMPONENTS}
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
      className={`fade-in ${user ? "ml-16" : "mr-10"}`}
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
            ? `ml-auto w-fit max-w-full rounded-2xl border px-4 py-2.5 backdrop-blur ${
                message.is_note
                  ? "border-dashed border-line bg-panel"
                  : "border-line bg-user"
              }`
            : ""
        }
      >
        {message.is_note && <div className="label mb-1">Note</div>}
        {text && <Markdown text={text} />}
      </div>
      {message.role === "assistant" && stopReason === "max_tokens" && (
        <div className="mt-2 flex items-center gap-2">
          <p className="font-mono text-[11px] text-muted">
            Claude hit the maximum length for this message.
          </p>
          {onContinue && (
            <button
              type="button"
              disabled={forkDisabled}
              onClick={onContinue}
              className="btn-ghost glow-ring px-2.5 py-0.5 font-mono text-[11px]"
            >
              Continue
            </button>
          )}
        </div>
      )}
      {message.role === "assistant" && stopReason === "model_context_window_exceeded" && (
        <p className="mt-2 font-mono text-[11px] text-muted">This node ran out of context.</p>
      )}
      {message.role === "assistant" && stopReason === "refusal" && (
        <p className="mt-2 font-mono text-[11px] text-muted">Claude stopped this reply.</p>
      )}
      {message.role === "assistant" && message.usage && <UsageFooter usage={message.usage} />}
      {message.role === "assistant" && (
        <div className="pointer-events-none contents">
          <button
            type="button"
            disabled={forkDisabled}
            onClick={() => onFork(message.id)}
            className="pointer-events-auto sticky bottom-3 z-10 mt-2 ml-auto block w-fit glass glow-ring rounded-full px-3 py-0.5 font-mono text-[11px] text-muted transition-colors hover:text-ink disabled:opacity-40"
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
    <article className="fade-in mr-10" data-role="assistant">
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
        <ul className="mb-2 select-none space-y-0.5 font-mono text-[11px] text-muted">
          {activity.map((line, index) => (
            <li key={`stream-activity-${index}`} className="truncate">
              {line}
            </li>
          ))}
        </ul>
      )}
      {text ? (
        <Markdown text={text} streaming />
      ) : (
        summaries.length === 0 && activity.length === 0 && thinkingStartedAt === null && (
          <p className="shimmer w-fit text-sm">Thinking…</p>
        )
      )}
    </article>
  );
}
