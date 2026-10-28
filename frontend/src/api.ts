import type { Conversation, DocumentInfo, Message, Thread, ThreadView, Tree, WebSource } from "./types";
import type { SpokenPart } from "./draft";

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

export function transcribe(audio: Blob): Promise<{ text: string }> {
  const body = new FormData();
  body.append("audio", audio, "dictation.wav");
  return request("/api/transcribe", { method: "POST", body });
}

const MATH_TIMEOUT_MS = 25000;

function isSpokenPart(value: unknown): value is SpokenPart {
  if (typeof value !== "object" || value === null) return false;
  const part = value as Record<string, unknown>;
  if (part.type === "text") return typeof part.text === "string";
  return part.type === "formula" && typeof part.latex === "string" && typeof part.spoken === "string";
}

/** Splits a transcript into text and formulas. Never rejects: any failure keeps the plain transcript. */
export async function parseSpokenMath(text: string): Promise<SpokenPart[]> {
  const plain: SpokenPart[] = [{ type: "text", text }];
  try {
    const { parts } = await request<{ parts: unknown }>("/api/dictation/math", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(MATH_TIMEOUT_MS),
    });
    if (!Array.isArray(parts) || parts.length === 0 || !parts.every(isSpokenPart)) return plain;
    return parts;
  } catch {
    return plain;
  }
}

/** Applies a spoken correction to a formula. Rejects with a message for the error line. */
export async function editFormula(latex: string, spoken: string): Promise<string> {
  let result: { latex?: unknown };
  try {
    result = await request("/api/dictation/math/edit", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ latex, spoken }),
      signal: AbortSignal.timeout(MATH_TIMEOUT_MS),
    });
  } catch (err) {
    // A server detail ("Set ANTHROPIC_API_KEY ...") is shown as is; a timeout or
    // network failure gets the generic message.
    if (err instanceof Error && err.name === "Error") throw err;
    throw new Error("Could not update that formula");
  }
  if (typeof result.latex !== "string" || !result.latex.trim()) {
    throw new Error("Could not update that formula");
  }
  return result.latex;
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
  charts: boolean,
  effort: string | null,
  extendedThinking: boolean,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ content, model, web, docs, charts, effort, extended_thinking: extendedThinking }),
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
