export type ContentBlock = {
  type: string;
  text?: string;
  content?: string | null;
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
};

export function messageText(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text as string)
    .join("\n\n");
}

export function compactionSummaries(content: ContentBlock[]): string[] {
  return content
    .filter((block) => block.type === "compaction")
    .map((block) => block.content ?? "");
}

export function quoteText(text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n\n`;
}
