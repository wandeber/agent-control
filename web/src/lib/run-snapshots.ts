import type { DashboardSnapshot } from "./types";

/** Navigation projection only. Pricing and run-scoped views use the owning snapshot. */
export function combineRunSnapshots(snapshots: DashboardSnapshot[]): DashboardSnapshot | null {
  const first = snapshots[0];
  if (!first || snapshots.length === 1) return first ?? null;
  const result = { ...first, costs: undefined };
  const keys = ["agents", "agent_links", "flows", "flow_instances", "flow_steps", "flow_reports", "flow_transitions",
    "flow_artifact_bindings", "subscriptions", "heartbeats", "goals", "artifacts", "latest_events", "computed_agents", "run_observers"] as const;
  for (const key of keys) {
    // Records are identities owned by runs. Shared flow definitions are deduplicated.
    Object.assign(result, { [key]: snapshots.flatMap<unknown>(snapshot => snapshot[key] ?? []) });
  }
  result.flows = [...new Map(result.flows.map(flow => [flow.flow_record_id, flow])).values()];
  result.latest_events.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return result;
}
