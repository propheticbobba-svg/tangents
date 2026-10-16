import type { Usage } from "./types";

function Stat({ children }: { children: React.ReactNode }) {
  return <span className="border-l border-line px-2 first:border-l-0 first:pl-0">{children}</span>;
}

export function UsageFooter({ usage }: { usage: Usage }) {
  const compaction = usage.iterations?.find((iteration) => iteration.type === "compaction");
  const web = usage.server_tool_use;
  return (
    <p className="mt-2 flex flex-wrap gap-y-1 font-mono text-[10px] tabular-nums text-muted">
      <Stat>in {usage.input_tokens ?? 0}</Stat>
      <Stat>out {usage.output_tokens ?? 0}</Stat>
      <Stat>cache read {usage.cache_read_input_tokens ?? 0}</Stat>
      <Stat>cache write {usage.cache_creation_input_tokens ?? 0}</Stat>
      {compaction && (
        <Stat>
          compaction in {compaction.input_tokens ?? 0} / out {compaction.output_tokens ?? 0}
        </Stat>
      )}
      {web && ((web.web_search_requests ?? 0) > 0 || (web.web_fetch_requests ?? 0) > 0) && (
        <>
          <Stat>searches {web.web_search_requests ?? 0}</Stat>
          <Stat>fetches {web.web_fetch_requests ?? 0}</Stat>
        </>
      )}
    </p>
  );
}
