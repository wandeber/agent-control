import type { AgentMessage, PermissionRequest } from "./types";

export interface ToolActivity {
  call_id: string;
  name: string;
  status: "running" | "completed" | "failed" | "declined" | "unknown";
  command?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  exit_code?: number;
}

export function readToolActivity(metadata?: Record<string, unknown>): ToolActivity | null {
  const value = metadata?.tool_activity;
  if (!value || typeof value !== "object") return null;
  const tool = value as ToolActivity;
  if (typeof tool.call_id !== "string" || typeof tool.name !== "string") return null;
  return { ...tool, status: ["running", "completed", "failed", "declined"].includes(tool.status) ? tool.status : "unknown" };
}

/** Display a request beside its exact native item, never match by command text. */
export function permissionsForTool(metadata: Record<string, unknown> | undefined, requests: PermissionRequest[]): PermissionRequest[] {
  const tool = readToolActivity(metadata);
  if (!tool) return [];
  const identity = metadata?.approval_identity as { thread_id?: unknown; turn_id?: unknown; item_id?: unknown } | undefined;
  const thread = identity?.thread_id ?? metadata?.threadId;
  const turn = identity?.turn_id ?? metadata?.turnId;
  const item = identity?.item_id ?? tool.call_id;
  return requests.filter(request => request.thread_id === thread && request.turn_id === turn && request.item_id === item);
}

/** Merge only an explicit call identity, retaining the first chronological position. */
export function mergeToolMessages(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  const calls = new Map<string, number>();
  for (const message of messages) {
    const tool = readToolActivity(message.metadata);
    if (!tool) { result.push(message); continue; }
    const key = `${String(message.metadata?.turnId ?? "")}:${tool.call_id}`;
    const index = calls.get(key);
    if (index === undefined) { calls.set(key, result.length); result.push(message); continue; }
    const previous = result[index]!;
    const before = readToolActivity(previous.metadata)!;
    result[index] = { ...previous, text: message.text, metadata: { ...previous.metadata, ...message.metadata,
      tool_activity: { ...before, ...tool, name: tool.name === "Tool result" ? before.name : tool.name } } };
  }
  return result;
}
