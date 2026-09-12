import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readNativeTimeline, type TimelineBoundary } from "../adapters/codex-timeline.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { AgentRecord } from "./types.js";

export interface ActivitySegment { id: string; started_at: string; ended_at: string | null }
export interface AgentTimelineRow {
  agent_id: string; source: "native" | "controller";
  coverage: "complete" | "partial" | "unavailable"; segments: ActivitySegment[];
}
export interface AgentTimeline { started_at: string; ended_at: string; rows: AgentTimelineRow[] }
type Interval = { start: number; end: number; open?: boolean };
interface History { agent_id: string; type: string; payload_json: string; created_at: string }
const millis = (value: string) => Date.parse(value);

export function activityIntervals(boundaries: TimelineBoundary[], until: number): { intervals: Interval[]; partial: boolean } {
  const intervals: Interval[] = [];
  let start: number | null = null, key = "", partial = false;
  for (const boundary of [...boundaries].sort((a, b) => a.at - b.at)) {
    if (!Number.isFinite(boundary.at)) { partial = true; continue; }
    if (boundary.kind === "start" && boundary.at <= until) {
      if (start !== null) {
        if (key === boundary.key && start === boundary.at) continue;
        intervals.push({ start, end: boundary.at }); partial = true;
      }
      start = boundary.at; key = boundary.key;
    } else if (boundary.kind === "end") {
      if (start !== null) {
        if (boundary.key !== key && boundary.key !== "turn" && key !== "turn") { partial = true; continue; }
        intervals.push({ start, end: Math.min(until, boundary.at) });
        start = null;
      } else if (boundary.at <= until) partial = true;
    }
  }
  if (start !== null) intervals.push({ start, end: until, open: true });
  return { intervals, partial };
}

export function waitingIntervals(boundaries: TimelineBoundary[], until: number): Interval[] {
  const starts = new Map<string, number>(), intervals: Interval[] = [];
  for (const boundary of [...boundaries].sort((a, b) => a.at - b.at)) {
    if (!Number.isFinite(boundary.at) || boundary.at > until) continue;
    if (boundary.kind === "wait" && !starts.has(boundary.key)) starts.set(boundary.key, boundary.at);
    if (boundary.kind === "resume" && starts.has(boundary.key)) {
      intervals.push({ start: starts.get(boundary.key)!, end: boundary.at }); starts.delete(boundary.key);
    }
    // An interrupted tool cannot keep later turns idle forever.
    if (boundary.kind === "end") {
      for (const start of starts.values()) intervals.push({ start, end: boundary.at });
      starts.clear();
    }
  }
  for (const start of starts.values()) intervals.push({ start, end: until });
  return intervals;
}

export function subtractWaits(active: Interval[], waits: Interval[]): Interval[] {
  return waits.reduce((remaining, wait) => remaining.flatMap(span => {
    if (wait.end <= span.start || wait.start >= span.end) return [span];
    const parts: Interval[] = [];
    if (wait.start > span.start) parts.push({ start: span.start, end: wait.start });
    if (wait.end < span.end) parts.push({ start: wait.end, end: span.end, open: span.open });
    return parts;
  }), active);
}

function controlBoundaries(history: History[]): TimelineBoundary[] {
  const boundaries: TimelineBoundary[] = [];
  let running = false, waiting = false;
  const questionWaits = new Map<string, string>();
  for (const row of history) {
    const at = millis(row.created_at);
    let p: Record<string, unknown>; try { p = JSON.parse(row.payload_json); } catch { continue; }
    if (row.type.startsWith("question.wait_")) {
      const key = `question:${p.wait_id}`;
      boundaries.push({ at, kind: row.type === "question.wait_started" ? "wait" : "resume", key });
      if (row.type === "question.wait_started") {
        questionWaits.set(key, String(p.question_id));
        if (typeof p.expires_at === "string") boundaries.push({ at: millis(p.expires_at), kind: "resume", key });
      } else questionWaits.delete(key);
      continue;
    }
    if (row.type === "question.answered") {
      for (const [key, id] of questionWaits) if (id === p.question_id) { boundaries.push({ at, kind: "resume", key }); questionWaits.delete(key); }
      continue;
    }
    const status = typeof p.status === "string" ? p.status : ({ "agent.started": "running", "agent.completed": "completed", "agent.stopped": "stopped", "agent.failed": "failed", "agent.blocked": "blocked", "agent.unregistered": "stopped" } as Record<string, string>)[row.type];
    if (!status) continue;
    if ((status === "running") !== running) {
      boundaries.push({ at, kind: status === "running" ? "start" : "end", key: "controller" });
      running = status === "running";
    }
    if ((status === "waiting_for_input" || status === "blocked") !== waiting) {
      waiting = status === "waiting_for_input" || status === "blocked";
      boundaries.push({ at, kind: waiting ? "wait" : "resume", key: "control-wait" });
    }
  }
  return boundaries;
}

function nativeThread(agent: AgentRecord): string | undefined {
  if (!agent.backend.startsWith("codex-") || agent.backend_handle?.remote_session) return;
  const handle = agent.backend_handle;
  if (typeof handle?.thread_id === "string") return handle.thread_id;
  if (agent.backend === "codex-subagent" && typeof handle?.native_agent_id === "string") return handle.native_agent_id;
  if (agent.backend === "codex-cli" && typeof handle?.dir === "string") {
    try { const state = JSON.parse(readFileSync(join(handle.dir, "state.json"), "utf8")); if (typeof state.thread_id === "string") return state.thread_id; } catch { /* No persisted native identity yet. */ }
  }
}

/** Full lifecycle history, independent of the dashboard's truncated event feed. */
export function projectAgentTimeline(store: SqliteStore, agents: AgentRecord[], window: { start: string; end: string | null }, generatedAt: string): AgentTimeline {
  const since = millis(window.start), until = Math.max(since, millis(window.end ?? generatedAt));
  const history = store.db.prepare(`select agent_id,type,payload_json,created_at from events
    where agent_id in (select value from json_each(?)) and (type in ('agent.started','agent.completed','agent.failed','agent.stopped','agent.blocked','agent.unregistered','agent.status_changed','question.wait_started','question.wait_ended','question.answered'))
    order by created_at,rowid`).all(JSON.stringify(agents.map(agent => agent.agent_id))) as History[];
  const rows = agents.map((agent): AgentTimelineRow => {
    const control = controlBoundaries(history.filter(row => row.agent_id === agent.agent_id));
    const thread = nativeThread(agent), baseline = agent.backend_handle?.usage_baseline as { rollout_path?: string } | undefined;
    const native = thread ? readNativeTimeline(thread, baseline?.rollout_path) : null;
    const useNative = !!native?.boundaries.some(boundary => boundary.kind === "start" && boundary.at <= until);
    const boundaries = useNative ? native!.boundaries : control;
    const activity = activityIntervals(boundaries, until);
    const passive = ["observer", "orchestrator"].includes(agent.role ?? "") || ["observer", "orchestrator"].includes(String(agent.backend_handle?.agent_control_role));
    // Passive registrations remain administratively waiting while their native
    // conversation works. Only real blocking calls can subtract those turns.
    const controlWaits = control.filter(boundary => boundary.kind === "wait" || boundary.kind === "resume").filter(boundary => !passive || boundary.key !== "control-wait");
    const waits = waitingIntervals([...boundaries, ...(useNative ? controlWaits : [])], until);
    let partial = activity.partial || !!(useNative && native?.partial);
    const terminal = ["completed", "failed", "stopped"].includes(agent.status) || !!agent.unregistered_at;
    const spans = activity.intervals.filter(span => {
      // A terminal snapshot with a missing end is not evidence of continued work.
      if (span.open && terminal) { partial = true; return false; }
      return true;
    });
    const segments = subtractWaits(spans, waits).flatMap((span, index) => {
      const start = Math.max(since, span.start), end = Math.min(until, span.end);
      return end > start ? [{ id: `${agent.agent_id}:${span.start}:${index}`, started_at: new Date(start).toISOString(), ended_at: span.open && !window.end ? null : new Date(end).toISOString() }] : [];
    });
    return { agent_id: agent.agent_id, source: useNative ? "native" : "controller", coverage: partial ? "partial" : segments.length ? "complete" : "unavailable", segments };
  });
  return { started_at: window.start, ended_at: new Date(until).toISOString(), rows };
}
