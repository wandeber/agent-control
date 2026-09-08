import { agentCost, costBreakdownLabel, costLabel } from "@/lib/costs";
import type { DashboardSnapshot } from "@/lib/types";

export function AgentCostLabel({ snapshot, agentId }: { snapshot: DashboardSnapshot; agentId: string }) {
  if (!snapshot.costs) return null;
  const cost = agentCost(snapshot, agentId);
  return <span className="whitespace-nowrap tabular-nums" title={costBreakdownLabel(cost)} aria-label={`Estimated cost ${costLabel(cost?.total)} USD`}>{costLabel(cost?.total)}</span>;
}
