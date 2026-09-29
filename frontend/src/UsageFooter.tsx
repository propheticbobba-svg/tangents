import type { Usage } from "./types";

export function UsageFooter({ usage }: { usage: Usage }) {
  const compaction = usage.iterations?.find((iteration) => iteration.type === "compaction");
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
    </p>
  );
}
