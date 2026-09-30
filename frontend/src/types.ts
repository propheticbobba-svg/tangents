export type WebSource = { title: string; url: string };

export type ContentBlock = {
  type: string;
  text?: string;
  content?: unknown;
  name?: string;
  url?: string;
  title?: string;
  source?: string;
};

export type DocumentInfo = {
  id: string;
  filename: string;
  title: string;
  created_at: string;
  chunk_count: number;
};

export type DocPassage = {
  title: string;
  text: string;
};

export type UsageIteration = {
  type: string;
  input_tokens?: number;
  output_tokens?: number;
};

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  iterations?: UsageIteration[];
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
};

export type Message = {
  id: string;
  parent_id: string | null;
  role: "user" | "assistant";
  content: ContentBlock[];
  thread_id: string;
  created_at: string;
  is_note: boolean;
  usage: Usage | null;
};

export type Thread = {
  id: string;
  conversation_id: string;
  parent_thread_id: string | null;
  fork_message_id: string | null;
  title: string;
  created_at: string;
  fork_snippet?: string | null;
  fork_position?: number | null;
};

export type AncestryItem = {
  id: string;
  title: string;
};

export type ThreadView = {
  thread: Thread;
  messages: Message[];
  forked_from: Message | null;
  ancestry: AncestryItem[];
};

export type Conversation = {
  id: string;
  goal: string | null;
  goal_snippet: string | null;
  created_at: string;
  center_thread_id?: string;
};

export type Tree = {
  conversation_id: string;
  goal: string | null;
  threads: Thread[];
};

export type StreamingTurn = {
  text: string;
  summaries: string[];
  activity: string[];
};

export function messageText(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text as string)
    .join("\n\n");
}

export function docPassages(content: ContentBlock[]): DocPassage[] {
  const passages: DocPassage[] = [];
  for (const block of content) {
    if (block.type !== "search_result" || !Array.isArray(block.content)) continue;
    const text = (block.content as ContentBlock[])
      .filter((item) => item?.type === "text" && item.text)
      .map((item) => item.text as string)
      .join("\n\n");
    passages.push({ title: block.title || "Document", text });
  }
  return passages;
}

export function compactionSummaries(content: ContentBlock[]): string[] {
  return content
    .filter((block) => block.type === "compaction")
    .map((block) => (typeof block.content === "string" ? block.content : ""));
}

function pushSource(url: unknown, title: unknown, seen: Set<string>, out: WebSource[]) {
  if (typeof url !== "string" || !url || seen.has(url)) return;
  seen.add(url);
  out.push({ title: typeof title === "string" && title ? title : url, url });
}

export function webSources(content: ContentBlock[]): WebSource[] {
  const seen = new Set<string>();
  const sources: WebSource[] = [];
  for (const block of content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const item of block.content as ContentBlock[]) {
        pushSource(item?.url, item?.title, seen, sources);
      }
    } else if (block.type === "web_fetch_tool_result") {
      const inner = block.content as ContentBlock | undefined;
      if (inner && inner.type === "web_fetch_result") pushSource(inner.url, inner.title, seen, sources);
    }
  }
  return sources;
}

export function quoteText(text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n\n`;
}
