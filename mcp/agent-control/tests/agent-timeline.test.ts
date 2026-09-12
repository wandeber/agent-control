import { afterEach, expect, it, vi } from "vitest";
import { activityIntervals, waitingIntervals, subtractWaits, projectAgentTimeline } from "../src/core/agent-timeline.js";
import { parseNativeTimeline } from "../src/adapters/codex-timeline.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import type { TimelineBoundary } from "../src/adapters/codex-timeline.js";
const boundary = (at: number, kind: TimelineBoundary["kind"], key = "turn"): TimelineBoundary => ({ at, kind, key });
const date = (at: number) => new Date(at).toISOString();
afterEach(() => vi.unstubAllEnvs());
it("preserves resumed periods and subtracts the union of overlapping waits", () => {
  const active = activityIntervals([boundary(10, "start"), boundary(30, "end"), boundary(40, "start"), boundary(50, "end")], 60);
  expect(active.intervals).toEqual([{ start: 10, end: 30 }, { start: 40, end: 50 }]);
  const waits = waitingIntervals([boundary(15, "wait", "a"), boundary(18, "wait", "b"), boundary(20, "resume", "a"), boundary(25, "resume", "b")], 60);
  expect(subtractWaits(active.intervals, waits)).toEqual([{ start: 10, end: 15 }, { start: 25, end: 30, open: undefined }, { start: 40, end: 50 }]);
});
it("does not infer idle from ordinary tools or silence, and caps interrupted waits at turn end", () => {
  const rows = [
    { timestamp: date(10), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
    { timestamp: date(12), type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "exec" } },
    { timestamp: date(14), type: "response_item", payload: { type: "function_call", name: "wait", call_id: "wait" } },
    { timestamp: date(20), type: "event_msg", payload: { type: "turn_aborted", turn_id: "t1" } },
    { timestamp: date(30), type: "event_msg", payload: { type: "task_started", turn_id: "t2" } },
    { timestamp: date(40), type: "event_msg", payload: { type: "task_complete", turn_id: "t2" } }
  ];
  const parsed = parseNativeTimeline(rows.map(row => JSON.stringify(row)).join("\n"));
  expect(subtractWaits(activityIntervals(parsed.boundaries, 50).intervals, waitingIntervals(parsed.boundaries, 50))).toEqual([{ start: 10, end: 14 }, { start: 30, end: 40 }]);
});
it("keeps full controller history and common coordinates for parallel and resumed workers", () => {
  const store = new SqliteStore(":memory:");
  try {
    const run = store.createRun({ title: "Parallel" });
    const a = store.createAgent({ runId: run.run_id, backend: "manual", title: "A", status: "completed" });
    const b = store.createAgent({ runId: run.run_id, backend: "manual", title: "B", status: "completed" });
    const event = (id: string, at: number, type: any, payload = {}) => {
      const record = store.createEvent({ runId: run.run_id, agentId: id, type, payload });
      store.db.prepare("update events set created_at=? where event_id=?").run(date(at), record.event_id);
    };
    event(a.agent_id, 10, "agent.started"); event(b.agent_id, 20, "agent.started");
    event(a.agent_id, 30, "agent.completed"); event(b.agent_id, 40, "agent.completed");
    event(a.agent_id, 50, "agent.started"); event(a.agent_id, 60, "agent.completed");
    for (let i = 0; i < 130; i++) event(a.agent_id, 100 + i, "agent.message");
    const result = projectAgentTimeline(store, [a, b], { start: date(0), end: date(70) }, date(500));
    expect(result.ended_at).toBe(date(70));
    expect(result.rows[0].segments.map(s => [s.started_at, s.ended_at])).toEqual([[date(10), date(30)], [date(50), date(60)]]);
    expect(result.rows[1].segments.map(s => [s.started_at, s.ended_at])).toEqual([[date(20), date(40)]]);
  } finally { store.close(); }
});
it("correlates explicit waits across rollout boundaries without treating every tool result as a wait", () => {
  const first = parseNativeTimeline(JSON.stringify({ timestamp: date(10), type: "response_item", payload: { type: "function_call", name: "wait", call_id: "w" } }));
  const resumed = parseNativeTimeline(JSON.stringify({ timestamp: date(20), type: "response_item", payload: { type: "function_call_output", call_id: "w", output: "not retained" } }));
  expect(waitingIntervals([...first.boundaries, ...resumed.boundaries], 50)).toEqual([{ start: 10, end: 20 }]);
  expect(JSON.stringify(resumed)).not.toContain("not retained");
});
it("clips a known native end beyond the run window and ignores a mismatched turn end", () => {
  const clipped = activityIntervals([boundary(10, "start", "a"), boundary(90, "end", "a")], 50);
  expect(clipped).toEqual({ intervals: [{ start: 10, end: 50 }], partial: false });
  const mixed = activityIntervals([boundary(10, "start", "a"), boundary(20, "start", "b"), boundary(30, "end", "a"), boundary(40, "end", "b")], 50);
  expect(mixed).toEqual({ intervals: [{ start: 10, end: 20 }, { start: 20, end: 40 }], partial: true });
});
it("closes observed work at blocked/unregistered boundaries rather than extending to now", () => {
  const store = new SqliteStore(":memory:");
  try {
    const run = store.createRun({ title: "Blocked" });
    const agent = store.createAgent({ runId: run.run_id, backend: "manual", title: "A", status: "blocked" });
    for (const [at, type] of [[10, "agent.started"], [20, "agent.blocked"], [40, "agent.started"], [50, "agent.unregistered"]] as const) {
      const event = store.createEvent({ runId: run.run_id, agentId: agent.agent_id, type, payload: {} });
      store.db.prepare("update events set created_at=? where event_id=?").run(date(at), event.event_id);
    }
    expect(projectAgentTimeline(store, [agent], { start: date(0), end: null }, date(100)).rows[0].segments.map(span => [span.started_at, span.ended_at])).toEqual([[date(10), date(20)], [date(40), date(50)]]);
  } finally { store.close(); }
});
