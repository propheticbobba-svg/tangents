import type { Conversation, DocumentInfo, Message, Thread, ThreadView, Tree, WebSource } from "./types";

export type ChatEvent =
  | { event: "user_message"; data: Message }
  | { event: "delta"; data: { text: string } }
  | { event: "thinking"; data: { text: string } }
  | { event: "compaction"; data: { content: string } }
  | { event: "web_activity"; data: { tool: string; query: string; url: string } }
  | { event: "web_result"; data: { tool: string; sources: WebSource[] } }
  | { event: "done"; data: Message }
  | { event: "error"; data: { error: string } };

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    /* not JSON */
  }
  return response.statusText || "Request failed";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

const jsonHeaders = { "Content-Type": "application/json" };

export function listConversations(): Promise<Conversation[]> {
  return request("/api/conversations");
}

export function createConversation(): Promise<Conversation> {
  return request("/api/conversations", { method: "POST" });
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await errorMessage(response));
}

export async function deleteThread(id: string): Promise<void> {
  const response = await fetch(`/api/threads/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await errorMessage(response));
}

export function updateGoal(id: string, goal: string): Promise<Conversation> {
  return request(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ goal }),
  });
}

export function getTree(id: string): Promise<Tree> {
  return request(`/api/conversations/${id}/tree`);
}

export function listDocuments(conversationId: string): Promise<DocumentInfo[]> {
  return request(`/api/conversations/${conversationId}/documents`);
}

export function uploadDocument(conversationId: string, file: File): Promise<DocumentInfo> {
  const body = new FormData();
  body.append("file", file);
  return request(`/api/conversations/${conversationId}/documents`, { method: "POST", body });
}

export async function deleteDocument(id: string): Promise<void> {
  const response = await fetch(`/api/documents/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await errorMessage(response));
}

export function getMessages(threadId: string): Promise<ThreadView> {
  return request(`/api/threads/${threadId}/messages`);
}

export function createThread(forkMessageId: string): Promise<Thread> {
  return request("/api/threads", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ fork_message_id: forkMessageId }),
  });
}

function parseSse(block: string): ChatEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) } as ChatEvent;
}

export async function streamMessage(
  threadId: string,
  content: string,
  model: string,
  web: boolean,
  docs: boolean,
  effort: string | null,
  extendedThinking: boolean,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ content, model, web, docs, effort, extended_thinking: extendedThinking }),
  });
  if (!response.ok || !response.body) {
    throw new Error(await errorMessage(response));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const parsed = parseSse(part);
      if (parsed) onEvent(parsed);
    }
  }
  if (buffer.trim()) {
    const parsed = parseSse(buffer);
    if (parsed) onEvent(parsed);
  }
}
