import type { DashboardSnapshot } from "./types";

/** Navigation projection only. Pricing and run-scoped views use the owning snapshot. */
export function combineRunSnapshots(snapshots: DashboardSnapshot[]): DashboardSnapshot | null {
  const first = snapshots[0];
  if (!first || snapshots.length === 1) return first ?? null;
  const result = { ...first, costs: undefined };
  const keys = ["agents", "agent_links", "flows", "flow_instances", "flow_steps", "flow_reports", "flow_transitions",
    "flow_artifact_bindings", "subscriptions", "heartbeats", "goals", "artifacts", "latest_events", "computed_agents", "run_observers", "permission_requests", "agent_access"] as const;
  for (const key of keys) {
    // Records are identities owned by runs. Shared flow definitions are deduplicated.
    Object.assign(result, { [key]: snapshots.flatMap<unknown>(snapshot => snapshot[key] ?? []) });
  }
  const timelines = snapshots.flatMap(snapshot => snapshot.agent_timeline ? [snapshot.agent_timeline] : []);
  result.agent_timeline = timelines.length ? {
    started_at: new Date(Math.min(...timelines.map(timeline => Date.parse(timeline.started_at)))).toISOString(),
    ended_at: new Date(Math.max(...timelines.map(timeline => Date.parse(timeline.ended_at)))).toISOString(),
    rows: timelines.flatMap(timeline => timeline.rows.map(row => ({ ...row,
      segments: row.segments.map(segment => ({ ...segment, ended_at: segment.ended_at ?? timeline.ended_at }))
    })))
  } : undefined;
  result.user_questions = [...new Map(snapshots.flatMap(snapshot => snapshot.user_questions ?? []).map(question => [question.question_id, question])).values()];
  result.flows = [...new Map(result.flows.map(flow => [flow.flow_record_id, flow])).values()];
  result.latest_events.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return result;
}
