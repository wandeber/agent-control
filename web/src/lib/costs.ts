import type { CostAmount, CostBreakdown, DashboardSnapshot, ExchangeRate } from "./types";

function moneyLabel(value: number, currency: "USD" | "EUR", partial: boolean): string {
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value > 0 && value < 0.01 ? `<${format.format(0.01)}` : format.format(value)}${partial ? "+" : ""}`;
}

/** Keep tiny nonzero consumption visible and distinguish a priced subtotal from a complete estimate. */
export function costLabel(cost?: CostAmount | null): string {
  if (cost?.usd === null || cost?.usd === undefined || !Number.isFinite(cost.usd) || cost.usd < 0) return "—";
  return moneyLabel(cost.usd, "USD", cost.partial);
}

export function euroCostLabel(cost?: CostAmount | null, exchange?: ExchangeRate | null): string {
  if (cost?.usd === null || cost?.usd === undefined || !Number.isFinite(cost.usd) || cost.usd < 0 || !exchange || !Number.isFinite(exchange.usd_per_eur) || exchange.usd_per_eur <= 0) return "—";
  // ECB quotes dollars per euro: divide the unrounded USD amount, then round only for display.
  const euros = cost.usd / exchange.usd_per_eur;
  return Number.isFinite(euros) ? moneyLabel(euros, "EUR", cost.partial) : "—";
}

export function agentCost(snapshot: DashboardSnapshot, agentId: string) {
  return snapshot.costs?.agents.find(item => item.agent_id === agentId) ?? null;
}

export function costBreakdownLabel(cost?: CostBreakdown | null): string {
  if (!cost) return "Estimated token cost unavailable";
  return `Estimated token cost (USD) · Input ${costLabel(cost.input)} · Cache reads ${costLabel(cost.cached)} · Cache writes ${costLabel(cost.cache_write)} · Output ${costLabel(cost.output)}${cost.total.partial ? " · Partial: some usage or prices are unavailable" : ""}`;
}
