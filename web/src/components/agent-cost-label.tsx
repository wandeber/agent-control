import { agentCost, costAvailabilityLabel, costBreakdownLabel, costLabel } from "@/lib/costs";
import type { DashboardSnapshot } from "@/lib/types";

export function AgentCostLabel({ snapshot, agentId }: { snapshot: DashboardSnapshot; agentId: string }) {
  const cost = agentCost(snapshot, agentId);
  const availability = costAvailabilityLabel(cost, snapshot.costs?.configuration_valid);
  return <span className="whitespace-nowrap tabular-nums" title={availability ?? costBreakdownLabel(cost)} aria-label={cost?.total.usd == null ? availability ?? "Estimated cost unavailable" : `Estimated cost ${costLabel(cost.total)} USD`}>{costLabel(cost?.total)}</span>;
}
