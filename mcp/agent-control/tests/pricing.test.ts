import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentController } from "../src/core/controller.js";
import { createDefaultAdapterRegistry } from "../src/adapters/registry.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { buildRunCosts, estimateTokenCost, loadPricing } from "../src/core/pricing.js";
import type { AgentRecord, UsageSnapshotRecord } from "../src/core/types.js";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "ac-pricing-")); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const rates = { input_per_million: 10, cached_input_per_million: 1, cache_write_input_per_million: 12.5, output_per_million: 50 };
const usage = (values: Partial<UsageSnapshotRecord> = {}) => ({ input_tokens: 1000000, cached_input_tokens: 800000, cache_write_input_tokens: 100000, output_tokens: 10000, total_tokens: 1010000, reasoning_output_tokens: 8000, model: "gpt-6-astra", ...values }) as UsageSnapshotRecord;
const agent = (id: string, values: Partial<AgentRecord> = {}) => ({ agent_id: id, backend: "codex-thread", model: "gpt-6-astra", status: "completed", ...values }) as AgentRecord;

describe("token cost estimates", () => {
  it("partitions input and charges reasoning only once within output", () => {
    expect(estimateTokenCost(usage(), rates)).toEqual({ input: { usd: 1, partial: false }, cached: { usd: .8, partial: false }, cache_write: { usd: 1.25, partial: false }, output: { usd: .5, partial: false }, total: { usd: 3.55, partial: false } });
  });
  it("keeps unavailable rates, missing usage and explicit free rates distinct", () => {
    expect(estimateTokenCost(usage(), null).total.usd).toBeNull();
    expect(estimateTokenCost(null, rates).total.usd).toBeNull();
    expect(estimateTokenCost(usage(), { input_per_million: 0, cached_input_per_million: 0, cache_write_input_per_million: 0, output_per_million: 0 }).total).toEqual({ usd: 0, partial: false });
    expect(estimateTokenCost(usage({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0 }), rates).total).toEqual({ usd: 0, partial: false });
  });
  it("rejects inconsistent cache partitions and reports only the priced output subtotal", () => {
    expect(estimateTokenCost(usage({ cache_write_input_tokens: 300000 }), rates).total).toEqual({ usd: .5, partial: true });
    expect(estimateTokenCost(usage({ cached_input_tokens: null }), rates).total).toEqual({ usd: .5, partial: true });
    expect(estimateTokenCost(usage({ cache_write_input_tokens: null }), rates).total).toEqual({ usd: 1.3, partial: true });
    expect(estimateTokenCost(usage({ input_tokens: NaN, output_tokens: -1 }), rates).total.usd).toBeNull();
    expect(estimateTokenCost(usage({ cache_write_input_tokens: -1 }), rates).total).toEqual({ usd: .5, partial: true });
  });
  it("does not require a cache-write split for models with equal ordinary and write rates", () => {
    const cost = estimateTokenCost(usage({ cache_write_input_tokens: null }), { ...rates, cache_write_input_per_million: 10 });
    expect(cost.total).toEqual({ usd: 3.3, partial: false });
  });
  it("does not infer long context from cumulative session input", () => {
    expect(estimateTokenCost(usage(), rates).total.usd).toBe(3.55);
  });
});

describe("pricing configuration and run aggregation", () => {
  it("serves identical costs across refreshes and applies edited project rates through the real dashboard", async () => {
    const root = temp(); vi.stubEnv("AGENT_CONTROL_HOME", root); mkdirSync(join(root, ".agents"));
    const store = new SqliteStore(":memory:"), controller = new AgentController(store, createDefaultAdapterRegistry());
    try {
      const run = controller.createRun({ title: "Pricing fixture", repoDir: root });
      controller.registerAgent({ runId: run.run_id, backend: "codex-cli", title: "Sample", status: "completed", backendHandle: { dir: root, resolved_model: "gpt-6-astra", model_provider: "openai" } });
      writeFileSync(join(root, "events.jsonl"), `${JSON.stringify({ type: "turn.completed", usage: usage() })}\n`);
      for (let i = 0; i < 2; i++) expect(controller.getDashboardSnapshot(run.run_id).costs?.total.total).toEqual({ usd: 3.55, partial: false });
      writeFileSync(join(root, ".agents", "pricing.toml"), '[models."gpt-6-astra"]\noutput_per_million=25\n');
      expect(controller.getDashboardSnapshot(run.run_id).costs?.total.total).toEqual({ usd: 3.3, partial: false });
      // A selected historical run can fall outside the recent-run menu.
      vi.spyOn(controller, "listRuns").mockReturnValueOnce([]);
      const historicalSnapshot = controller.getDashboardSnapshot(run.run_id);
      expect(historicalSnapshot.runs).toHaveLength(0);
      expect(historicalSnapshot.costs?.total.total).toEqual({ usd: 3.3, partial: false });
      expect(controller.listUsageSnapshots({ runId: run.run_id })).toHaveLength(0);
    } finally { await controller.dispose(); store.close(); }
  });
  it("loads bundled, user and project rates in deterministic order, including from a project subdirectory", () => {
    const home = temp(), root = temp();
    mkdirSync(join(root, ".git")); mkdirSync(join(root, ".agents")); mkdirSync(join(root, "src"));
    writeFileSync(join(home, "pricing.toml"), '[models."gpt-6-astra"]\ninput_per_million = 8\noutput_per_million = 40\n');
    writeFileSync(join(root, ".agents", "pricing.toml"), '[models."gpt-6-astra"]\noutput_per_million = 35\n');
    expect(loadPricing(join(root, "src"), home).models["gpt-6-astra"]).toEqual({ ...rates, input_per_million: 8, output_per_million: 35 });
    expect(loadPricing(join(root, "src"), home).files).toHaveLength(2);
  });
  it("exposes the bundled ECB rate and lets user and project conversions override it independently of token prices", () => {
    const home = temp(), root = temp();
    mkdirSync(join(root, ".agents"));
    const original = loadPricing(root, home);
    expect(original.exchange?.usd_per_eur).toBeGreaterThan(0);
    expect(original.exchange?.source).toBe("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    writeFileSync(join(home, "pricing.toml"), '[exchange]\nusd_per_eur=1.1\n');
    writeFileSync(join(root, ".agents", "pricing.toml"), '[exchange]\nusd_per_eur=1.2\n');
    const result = buildRunCosts([agent("a")], new Map([["a", usage()]]), root, home);
    expect(result.exchange).toEqual({ usd_per_eur: 1.2, source: null, updated_at: null });
    expect(result.total.total).toEqual({ usd: 3.55, partial: false });
  });
  it("combines same-model agents, excludes duplicate thread identities, and retains unknown-price rows", () => {
    const a = agent("a", { backend_handle: { thread_id: "one" } }), b = agent("b"), c = agent("c", { model: "unpriced-model" });
    const duplicate = agent("alias", { backend_handle: { thread_id: "one" } });
    const result = buildRunCosts([a, b, duplicate, c], new Map([["a", usage()], ["b", usage()], ["c", usage({ model: "unpriced-model" })]]), null, temp());
    expect(result.agents).toHaveLength(3);
    expect(result.models.find(row => row.model === "gpt-6-astra")?.total).toEqual({ usd: 7.1, partial: false });
    expect(result.models.find(row => row.model === "unpriced-model")?.total.usd).toBeNull();
    expect(result.total.total).toEqual({ usd: 7.1, partial: true });
  });
  it("supports exact provider/model overrides without guessing external aliases", () => {
    const home = temp();
    const a = agent("a", { backend_handle: { model_provider: "gateway" } });
    expect(buildRunCosts([a], new Map([["a", usage()]]), null, home).total.total.usd).toBeNull();
    writeFileSync(join(home, "pricing.toml"), '[models."gateway/gpt-6-astra"]\ninput_per_million=0\ncached_input_per_million=0\ncache_write_input_per_million=0\noutput_per_million=0\n');
    expect(buildRunCosts([a], new Map([["a", usage()]]), null, home).total.total).toEqual({ usd: 0, partial: false });
  });
  it("prices Yoda with its explicit multimodal DeepSeek peak reference and combines workers by model", () => {
    const workers = [
      agent("a", { backend: "codex-cli", model: "yoda", backend_handle: { model_provider: "softec-ai-lab" } }),
      agent("b", { backend: "codex-cli", model: "yoda", backend_handle: { profile: "legacy-yoda-profile" } })
    ];
    const result = buildRunCosts(workers, new Map(workers.map(worker => [worker.agent_id, usage({ model: "yoda" })])), null, temp());
    for (const cost of result.agents) {
      expect(cost.rates).toEqual({ input_per_million: .44, cached_input_per_million: .014, cache_write_input_per_million: .44, output_per_million: 1.32 });
      expect(cost.total.usd).toBeCloseTo(.1124, 10);
      expect(cost.total.partial).toBe(false);
    }
    expect(result.models).toHaveLength(1);
    expect(result.models[0].model).toBe("yoda");
    expect(result.models[0].total.usd).toBeCloseTo(.2248, 10);
    expect(result.total.total).toEqual(result.models[0].total);
    expect(result.model_references?.yoda).toEqual({ model: "deepseek-v4-flash-vision-exp", source: "https://api-docs.deepseek.com/quick_start/pricing/", basis: "Peak API rates" });
  });
  it("allows partial Yoda overrides and more specific provider rates", () => {
    const home = temp();
    const worker = agent("a", { backend: "codex-cli", model: "yoda", backend_handle: { model_provider: "softec-ai-lab" } });
    const observed = new Map([["a", usage({ model: "yoda", cache_write_input_tokens: null })]]);
    writeFileSync(join(home, "pricing.toml"), '[models.yoda]\noutput_per_million=0.66\n');
    expect(buildRunCosts([worker], observed, null, home).agents[0].rates?.output_per_million).toBe(.66);
    writeFileSync(join(home, "pricing.toml"), '[models.yoda]\noutput_per_million=0.66\n[models."softec-ai-lab/yoda"]\ninput_per_million=1\ncached_input_per_million=1\ncache_write_input_per_million=1\noutput_per_million=1\n');
    const result = buildRunCosts([worker], observed, null, home);
    expect(result.agents[0].pricing_key).toBe("softec-ai-lab/yoda");
    expect(result.total.total).toEqual({ usd: 1.01, partial: false });
  });
  it("keeps usage when the first identity for a thread has none", () => {
    const a = agent("alias", { backend_handle: { thread_id: "one" } }), b = agent("worker", { backend_handle: { thread_id: "one" } });
    const result = buildRunCosts([a, b], new Map([["worker", usage()]]), null, temp());
    expect(result.total.total).toEqual({ usd: 3.55, partial: false });
    expect(result.agents.map(item => item.agent_id)).toEqual(["worker"]);
  });
  it("does not assume old CLI profiles with unknown providers are OpenAI", () => {
    const a = agent("a", { backend: "codex-cli", backend_handle: { profile: "gateway" } });
    expect(buildRunCosts([a], new Map([["a", usage()]]), null, temp()).total.total.usd).toBeNull();
  });
  it.each(['[models.x]\ninput_per_million=2', '[models."gpt-6-astra"]\ninput_per_million=-1', '[models."gpt-6-astra"]\noutput_per_million=nan', '[models."gpt-6-astra"]\noutput=3', 'broken = [', '[exchange]\nusd_per_eur=0', '[exchange]\nusd_per_eur=nan', '[exchange]\neur_per_usd=1', '[exchange]\nusd_per_eur=1\nunknown=2'])('invalid overrides cannot crash the dashboard or silently use default prices: %s', text => {
    const home = temp(); writeFileSync(join(home, "pricing.toml"), text);
    const result = buildRunCosts([agent("a")], new Map([["a", usage()]]), null, home);
    expect(result.configuration_valid).toBe(false);
    expect(result.total.total.usd).toBeNull();
  });
  it("retains missing completed usage as partial but does not charge unstarted planned agents", () => {
    const result = buildRunCosts([agent("a"), agent("b"), agent("c", { status: "planned" })], new Map([["a", usage()]]), null, temp());
    expect(result.total.total).toEqual({ usd: 3.55, partial: true });
    expect(result.agents).toHaveLength(2);
  });
});
