import { codexRunUsageWithEvidence, type UsageEvidence } from "../adapters/codex-run-usage.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { RunWakePolicy } from "./run-wake-policy.js";
import type { AgentRecord, UsageSnapshotRecord } from "./types.js";

interface Window { start: string; end: string | null }
const passive = (role: unknown) => role === "observer" || role === "orchestrator";
export function hasRunConversationUsage(agent: AgentRecord): boolean {
  return ["codex-thread", "codex-session"].includes(agent.backend) && !agent.backend_handle?.remote_session &&
    (passive(agent.role) || passive(agent.backend_handle?.agent_control_role));
}

/** Persist metering separately from manually reported, potentially unscoped snapshots. */
export class RunConversationUsage {
  constructor(private store: SqliteStore) {}

  window(runId: string): Window {
    const run = this.store.getRun(runId)!;
    const policy = new RunWakePolicy(this.store);
    const completion = policy.completion(runId);
    if (!completion && run.status !== "stopped") return { start: run.created_at, end: null };
    // Completion is reversible: new work reopens the window. Use immutable work
    // events, not observer activity, ACK time, or mutable run.updated_at.
    const rows = this.store.db.prepare(`select e.created_at from events e left join agents a on a.agent_id=e.agent_id
      where e.run_id in (select value from json_each(?)) and (
        e.type in ('flow.completed', 'goal.completed')
        or (e.type='goal.continued' and json_extract(e.payload_json,'$.status')='cancelled')
        or (coalesce(a.role,'') not in ('observer','orchestrator') and (
          e.type in ('agent.completed','agent.failed','agent.stopped') or
          (e.type='agent.status_changed' and json_extract(e.payload_json,'$.reason')='turn_interrupted'
            and json_extract(e.payload_json,'$.status') in ('completed','failed','stopped')))))`)
      .all(JSON.stringify(policy.runIds(runId))) as Array<{ created_at: string }>;
    for (const id of policy.runIds(runId)) {
      for (const action of this.store.listOrchestratorActions({ runId: id })) {
        if (action.completed_at) rows.push({ created_at: action.completed_at });
      }
    }
    const workEnd = rows.reduce((latest, row) => Math.max(latest, Date.parse(row.created_at) || 0), Date.parse(run.created_at));
    const shutdowns = this.store.db.prepare(`select created_at from events where run_id=? and type='timer.elapsed'
      and json_extract(payload_json,'$.action') in ('run_shutdown','run_shutdown_completed')`).all(runId) as Array<{ created_at: string }>;
    const shutdown = shutdowns.map(row => Date.parse(row.created_at)).filter(at => at >= workEnd).sort((a, b) => a - b)[0];
    // An administrative shutdown after settled work must not add later chat.
    return { start: run.created_at, end: new Date((!completion || !rows.length ? shutdown : undefined) ?? workEnd).toISOString() };
  }

  read(agent: AgentRecord, window: Window): UsageSnapshotRecord | null {
    const thread = agent.backend_handle?.thread_id;
    if (typeof thread !== "string") return null;
    const row = this.store.db.prepare("select * from run_conversation_usage where run_id=? and agent_id=?")
      .get(agent.run_id, agent.agent_id) as { thread_id: string; started_at: string; ended_at: string | null; snapshot_json: string; evidence_json: string } | undefined;
    const cached: UsageSnapshotRecord | null = row?.thread_id === thread && row.started_at === window.start && row.ended_at === window.end ? JSON.parse(row.snapshot_json) : null;
    const baseline = agent.backend_handle?.usage_baseline as { rollout_path?: string } | undefined;
    let observed;
    try { observed = codexRunUsageWithEvidence(thread, window.start, window.end, baseline?.rollout_path); }
    catch { return cached; }
    if (!observed) return cached;
    if (row?.thread_id === thread && row.started_at === window.start) {
      const prior = JSON.parse(row.evidence_json) as UsageEvidence[], keys = new Set(observed.evidence.map(record => record.key));
      const until = window.end === null ? Infinity : Date.parse(window.end);
      // Missing just one historical segment must never replace a complete saved
      // total. A changed window requires fresh coverage; the old subtotal is not its total.
      if (prior.some(record => record.at <= until && !keys.has(record.key))) return cached;
    }
    const snapshot = { ...observed.usage, usage_id: `run-conversation:${agent.agent_id}`, run_id: agent.run_id, agent_id: agent.agent_id };
    const json = JSON.stringify(snapshot);
    const evidence = JSON.stringify(observed.evidence);
    if (json !== row?.snapshot_json || evidence !== row?.evidence_json) this.store.db.prepare(`insert into run_conversation_usage
      (run_id,agent_id,thread_id,started_at,ended_at,snapshot_json,evidence_json) values (?,?,?,?,?,?,?)
      on conflict(run_id,agent_id) do update set thread_id=excluded.thread_id,started_at=excluded.started_at,
      ended_at=excluded.ended_at,snapshot_json=excluded.snapshot_json,evidence_json=excluded.evidence_json`)
      .run(agent.run_id, agent.agent_id, thread, window.start, window.end, json, evidence);
    return snapshot;
  }
}
