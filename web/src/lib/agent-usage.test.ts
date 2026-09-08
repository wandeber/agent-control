import { describe, expect, it } from "vitest";
import { agentCostRows, agentTokenLabel, agentTotalLabel, modelUsage, usageBreakdown } from "./agent-presentation";
import type { UsageSnapshotRecord, DashboardSnapshot } from "./types";

const usage = (values: Partial<UsageSnapshotRecord>) => ({ input_tokens: null, output_tokens: null, total_tokens: null, ...values }) as UsageSnapshotRecord;

describe("agent token consumption", () => {
  it("hides unavailable consumption even when context size is known", () => {
    expect(agentTokenLabel(null)).toBeNull();
    expect(agentTokenLabel(usage({ context_used: 12000 }))).toBeNull();
  });
  it("preserves reported zero and partial counts without inventing missing values", () => {
    expect(agentTokenLabel(usage({ input_tokens: 1200, output_tokens: 0 }))).toBe("1,200 in · 0 out tokens");
    expect(agentTokenLabel(usage({ total_tokens: 1400 }))).toBe("1,400 total tokens");
    expect(agentTokenLabel(usage({ input_tokens: -1, output_tokens: NaN }))).toBeNull();
  });
});

describe("model aggregation", () => {
  it("combines workers by model without mixing unknown consumption into zero", () => {
    const snapshot = { agents: [{ agent_id: 'a', model: 'yoda' }, { agent_id: 'b', model: 'yoda' }, { agent_id: 'c', model: 'anakin' }], computed_agents: [
      { agent_id: 'a', latest_usage: usage({ input_tokens: 100, output_tokens: 20, total_tokens: 120 }) },
      { agent_id: 'b', latest_usage: usage({ input_tokens: 50, output_tokens: 10, total_tokens: 60 }) },
      { agent_id: 'c', latest_usage: null }
    ] } as unknown as DashboardSnapshot;
    const result = modelUsage(snapshot);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.model).toBe('yoda');
    expect(result.totals.total).toEqual({ value: 180, partial: false });
    expect(agentTotalLabel(usage({ input_tokens: 20 }))).toBeNull();
  });
});

it("only decomposes reported usage and keeps tool output distinct from reasoning", () => {
  expect(usageBreakdown(usage({ input_tokens: 100, output_tokens: 25, total_tokens: 125, cached_input_tokens: 80, reasoning_output_tokens: 10 }))).toEqual([
    { label: "Input", value: 100 }, { label: "Cached input", value: 80 }, { label: "Uncached input", value: 20 },
    { label: "Output", value: 25 }, { label: "Reasoning", value: 10 }, { label: "Text and other output", value: 15 }, { label: "Total", value: 125 }
  ]);
  expect(usageBreakdown(usage({ input_tokens: 100, output_tokens: 25 }))).toHaveLength(2);
  expect(usageBreakdown(usage({ output_tokens: 25, reasoning_output_tokens: 26 }))).toEqual([{ label: "Output", value: 25 }]);
});

it("aggregates cache per model without treating missing cache usage as uncached", () => {
  const snapshot = { agents: [{ agent_id: "a", model: "yoda" }, { agent_id: "b", model: "yoda" }], computed_agents: [
    { agent_id: "a", latest_usage: usage({ input_tokens: 100, cached_input_tokens: 80 }) },
    { agent_id: "b", latest_usage: usage({ input_tokens: 50, cached_input_tokens: 40 }) }
  ] } as unknown as DashboardSnapshot;
  expect(modelUsage(snapshot).rows[0]).toMatchObject({ input: { value: 150, partial: false }, cached: { value: 120, partial: false }, uncached: { value: 30, partial: false } });
  snapshot.computed_agents[1].latest_usage!.cached_input_tokens = null;
  expect(modelUsage(snapshot).totals).toMatchObject({ cached: { value: 80, partial: true }, uncached: { value: 20, partial: true } });
});

it("keeps thread titles and individual token partitions even when agents share a role or model", () => {
  const snapshot = { agents: [
    { agent_id: "a", title: "Spring poem", role: "worker", model: "yoda" },
    { agent_id: "b", title: "Summer poem", role: "worker", model: "yoda" }
  ], computed_agents: [
    { agent_id: "a", latest_usage: usage({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, total_tokens: 120 }) },
    { agent_id: "b", latest_usage: usage({ input_tokens: 50, cached_input_tokens: null, output_tokens: 10, total_tokens: 60 }) }
  ], costs: { agents: [{ agent_id: "a", model: "yoda" }, { agent_id: "b", model: "yoda" }] } } as unknown as DashboardSnapshot;
  const rows = agentCostRows(snapshot);
  expect(rows.map(row => row.name)).toEqual(["Spring poem", "Summer poem"]);
  expect(rows[0].usage).toMatchObject({ input: { value: 100 }, cached: { value: 80 }, uncached: { value: 20 }, output: { value: 20 }, total: { value: 120 } });
  expect(rows[1].usage).toMatchObject({ input: { value: 50 }, cached: { value: null }, uncached: { value: null }, output: { value: 10 }, total: { value: 60 } });
  expect(rows.reduce((sum, row) => sum + row.usage.total.value!, 0)).toBe(modelUsage(snapshot).totals.total.value);
  snapshot.computed_agents[0].latest_usage = null;
  expect(agentCostRows(snapshot)[0].usage.total.value).toBeNull();
});
