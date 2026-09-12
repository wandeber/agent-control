import { readFileSync, statSync } from "node:fs";
import { codexUsagePaths } from "./codex-session.js";

export interface TimelineBoundary { at: number; kind: "start" | "end" | "wait" | "resume"; key: string }
export interface NativeTimeline { boundaries: TimelineBoundary[]; partial: boolean }
const cache = new Map<string, { signature: string; value: NativeTimeline }>();

// Only explicit waiting operations are idle. Ordinary tools and silence remain
// part of the active turn; generic exec wrappers can contain useful work too.
function isWait(name: unknown, namespace: unknown): boolean {
  return (name === "wait" && (namespace == null || namespace === "functions")) ||
    (name === "request_user_input" && (namespace == null || namespace === "functions")) ||
    (name === "wait_agent" && namespace === "collaboration") ||
    (name === "sleep" && namespace === "clock");
}

/** Keep only timing metadata, never prompts, tool arguments or answers. */
export function parseNativeTimeline(text: string): NativeTimeline {
  const boundaries: TimelineBoundary[] = [];
  let partial = false;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { if (index < lines.length - 1) partial = true; continue; }
    const p = row.payload;
    if (!p) continue;
    const at = Date.parse(row.timestamp);
    const kind = row.type === "event_msg" ? ({ task_started: "start", task_complete: "end", turn_aborted: "end" } as const)[p.type as "task_started"] : undefined;
    if (kind) {
      if (!Number.isFinite(at)) { partial = true; continue; }
      boundaries.push({ at, kind, key: typeof p.turn_id === "string" ? p.turn_id : "turn" });
    }
    if (row.type !== "response_item" || typeof p.call_id !== "string") continue;
    if (["function_call", "custom_tool_call"].includes(p.type) && isWait(p.name, p.namespace)) {
      if (Number.isFinite(at)) boundaries.push({ at, kind: "wait", key: p.call_id }); else partial = true;
    } else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
      if (Number.isFinite(at)) boundaries.push({ at, kind: "resume", key: p.call_id }); else partial = true;
    }
  }
  return { boundaries, partial };
}

export function readNativeTimeline(threadId: string, baselinePath?: string): NativeTimeline | null {
  const paths = codexUsagePaths(threadId, baselinePath);
  if (!paths.length) return null;
  const records: TimelineBoundary[] = [];
  let partial = false;
  for (const path of paths) {
    try {
      const stat = statSync(path), signature = `${stat.size}:${stat.mtimeMs}`;
      let entry = cache.get(path);
      if (entry?.signature !== signature) {
        entry = { signature, value: parseNativeTimeline(readFileSync(path, "utf8")) };
        if (cache.size >= 100 && !cache.has(path)) cache.delete(cache.keys().next().value!);
        cache.set(path, entry);
      }
      partial ||= entry.value.partial;
      records.push(...entry.value.boundaries);
    } catch { partial = true; }
  }
  const unique = new Map(records.map(record => [`${record.kind}:${record.key}:${record.at}`, record]));
  return { boundaries: [...unique.values()].sort((a, b) => a.at - b.at), partial };
}
