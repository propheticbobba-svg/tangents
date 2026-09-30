import type { Usage } from "./types";

export function UsageFooter({ usage }: { usage: Usage }) {
  const compaction = usage.iterations?.find((iteration) => iteration.type === "compaction");
  const web = usage.server_tool_use;
  return (
    <p className="mt-2 text-[11px] text-muted">
      in {usage.input_tokens ?? 0} · out {usage.output_tokens ?? 0} · cache read{" "}
      {usage.cache_read_input_tokens ?? 0} · cache write {usage.cache_creation_input_tokens ?? 0}
      {compaction && (
        <>
          {" "}
          · compaction in {compaction.input_tokens ?? 0} / out {compaction.output_tokens ?? 0}
        </>
      )}
      {web && ((web.web_search_requests ?? 0) > 0 || (web.web_fetch_requests ?? 0) > 0) && (
        <>
          {" "}
          · searches {web.web_search_requests ?? 0} · fetches {web.web_fetch_requests ?? 0}
        </>
      )}
    </p>
  );
}
