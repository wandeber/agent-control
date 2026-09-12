import Database from "better-sqlite3";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { codexRunUsage } from "../src/adapters/codex-run-usage.js";
import { sessionBaseline } from "../src/adapters/codex-session.js";
import { createDefaultAdapterRegistry } from "../src/adapters/registry.js";
import { AgentController } from "../src/core/controller.js";
import { RunConversationUsage } from "../src/core/run-conversation-usage.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const at = (time: string) => `2026-09-11T${time}:00.000Z`;
const row = (type: string, payload: unknown, timestamp: string) => JSON.stringify({ type, payload, timestamp }) + "\n";
const header = (created = at("09:00"), thread = id) => row("session_meta", { id: thread }, created) + row("turn_context", { model: "gpt-6-astra" }, created);
function tokens(n: number, time: string, fresh = false) {
  const usage = { input_tokens: n, output_tokens: n / 10, total_tokens: n + n / 10, cached_input_tokens: n / 2, cache_write_input_tokens: 0, reasoning_output_tokens: n / 20 };
  return row("event_msg", { type: "token_count", info: { total_token_usage: usage, ...(fresh ? { last_token_usage: usage } : {}) } }, at(time));
}
let home: string, path: string, store: SqliteStore, controller: AgentController;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-run-metering-"));
  vi.stubEnv("CODEX_HOME", home); vi.stubEnv("AGENT_CONTROL_HOME", home);
  mkdirSync(join(home, "sessions")); path = join(home, "sessions", `rollout-${id}.jsonl`);
  writeFileSync(path, header() + tokens(1000, "09:59") + tokens(1100, "10:01") + tokens(1300, "10:03") + tokens(2000, "10:05"));
  store = new SqliteStore(join(home, "control.sqlite")); controller = new AgentController(store, createDefaultAdapterRegistry());
});
afterEach(async () => { await controller.dispose(); store.close(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

function setupRun() {
  vi.useFakeTimers(); vi.setSystemTime(at("10:00"));
  const run = controller.createRun({ title: "Bounded coordinator", repoDir: home });
  vi.setSystemTime(at("10:02"));
  const observer = controller.registerAgent({ runId: run.run_id, backend: "codex-thread", role: "orchestrator", title: "Coordinator",
    backendHandle: { thread_id: id, usage_baseline: sessionBaseline(id), agent_control_role: "orchestrator" } });
  const worker = controller.registerAgent({ runId: run.run_id, backend: "manual", title: "Worker", status: "completed" });
  vi.setSystemTime(at("10:04"));
  controller.emit({ runId: run.run_id, agentId: worker.agent_id, type: "agent.completed", payload: {} });
  return { run, observer, worker };
}

it("counts from run creation despite a later attachment and excludes post-completion conversation", () => {
  const { run, observer } = setupRun();
  controller.createUsageSnapshot({ runId: run.run_id, agentId: observer.agent_id, inputTokens: 999999, capturedAt: at("15:00") });
  const snapshot = controller.getDashboardSnapshot(run.run_id);
  const usage = snapshot.computed_agents.find(a => a.agent_id === observer.agent_id)!.latest_usage;
  expect(usage).toMatchObject({ input_tokens: 300, output_tokens: 30, cached_input_tokens: 150, cache_write_input_tokens: 0,
    scope_started_at: at("10:00"), scope_ended_at: at("10:04") });
  expect(snapshot.costs!.agents.find(a => a.agent_id === observer.agent_id)!.total.usd).toBeCloseTo(.00315);
  controller.getDashboardSnapshot(run.run_id);
  expect(store.db.prepare("select count(*) as n from run_conversation_usage").get()).toEqual({ n: 1 });
});

it("recovers the old run after rollover and keeps all cache partitions after a controller and store restart", async () => {
  const { run, observer } = setupRun();
  const resumed = join(home, "sessions", `rollout-${id}_${other}.jsonl`);
  writeFileSync(resumed, header(at("11:00")) + tokens(20, "11:01", true));
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("create table threads(id text primary key, rollout_path text)"); db.prepare("insert into threads values (?,?)").run(id, resumed); db.close();
  const get = () => controller.getDashboardSnapshot(run.run_id).computed_agents.find(a => a.agent_id === observer.agent_id)!.latest_usage;
  expect(get()).toMatchObject({ input_tokens: 300, output_tokens: 30, cached_input_tokens: 150 });
  await controller.dispose(); store.close(); rmSync(path); rmSync(resumed);
  store = new SqliteStore(join(home, "control.sqlite")); controller = new AgentController(store, createDefaultAdapterRegistry());
  expect(get()).toMatchObject({ input_tokens: 300, output_tokens: 30, cached_input_tokens: 150 });
});

it("keeps successive runs of the same thread in independent windows", () => {
  writeFileSync(path, header() + tokens(1000, "09:59") + tokens(1300, "10:04") + tokens(2000, "10:05"));
  expect(codexRunUsage(id, at("10:00"), at("10:04"))).toMatchObject({ input_tokens: 300 });
  expect(codexRunUsage(id, at("10:04"), at("10:06"))).toMatchObject({ input_tokens: 700 });
});

it.each(["older", "newer", "truncated"])("preserves a measured total when %s rollout evidence disappears", async (missing) => {
  const { run, observer, worker } = setupRun();
  writeFileSync(path, header() + tokens(100, "09:59") + tokens(200, "10:01"));
  const resumed = join(home, "sessions", `rollout-${id}_${other}.jsonl`);
  writeFileSync(resumed, header(at("10:02")) + tokens(20, "10:03", true) + tokens(60, "10:04"));
  const meter = new RunConversationUsage(store);
  expect(meter.read(observer, meter.window(run.run_id))).toMatchObject({ input_tokens: 160, cached_input_tokens: 80 });
  if (missing === "truncated") writeFileSync(resumed, header(at("10:02")) + tokens(20, "10:03", true));
  else rmSync(missing === "older" ? path : resumed);
  expect(meter.read(observer, meter.window(run.run_id))).toMatchObject({ input_tokens: 160, cached_input_tokens: 80 });
  expect(JSON.parse((store.db.prepare("select snapshot_json from run_conversation_usage").get() as { snapshot_json: string }).snapshot_json).input_tokens).toBe(160);
  store.updateAgent(worker.agent_id, { status: "running" });
  // A previous window's subtotal is not a complete measurement of resumed work.
  expect(meter.read(observer, meter.window(run.run_id))).toBeNull();
});

it("adds a proven fresh resumed counter without dropping the earlier run segment", () => {
  writeFileSync(path, header() + tokens(100, "09:59") + tokens(200, "10:01"));
  writeFileSync(join(home, "sessions", `rollout-${id}_${other}.jsonl`), header(at("10:02")) + tokens(20, "10:03", true) + tokens(60, "10:04"));
  expect(codexRunUsage(id, at("10:00"), at("10:05"))).toMatchObject({ input_tokens: 160, output_tokens: 16, cached_input_tokens: 80 });
});

it("deduplicates copied history and retains cumulative continuity between files", () => {
  const copied = header() + tokens(100, "09:59") + tokens(200, "10:01");
  writeFileSync(path, copied);
  writeFileSync(join(home, "sessions", `rollout-${id}_${other}.jsonl`), copied + tokens(300, "10:03"));
  expect(codexRunUsage(id, at("10:00"), at("10:04"))).toMatchObject({ input_tokens: 200, output_tokens: 20 });
});

it("rejects unexplained resets and foreign identities instead of inventing a positive delta", () => {
  writeFileSync(path, header() + tokens(100, "09:59") + tokens(20, "10:01") + tokens(200, "10:03"));
  writeFileSync(join(home, "sessions", `rollout-${id}_${other}.jsonl`), header(at("10:00"), other) + tokens(900, "10:02", true));
  expect(codexRunUsage(id, at("10:00"), at("10:04"))).toMatchObject({ input_tokens: null, output_tokens: null, total_tokens: null });
});

it("does not finish on one worker event, and recomputes the window when the same run gets more work", () => {
  const { run, worker } = setupRun();
  const meter = new RunConversationUsage(store);
  const child = controller.createRun({ title: "Child", agentToken: worker.agent_token });
  const childWorker = controller.registerAgent({ runId: child.run_id, backend: "manual", title: "Child worker", status: "running" });
  expect(meter.window(run.run_id).end).toBeNull();
  store.updateAgent(childWorker.agent_id, { status: "completed" });
  vi.setSystemTime(at("10:06")); controller.emit({ runId: child.run_id, agentId: childWorker.agent_id, type: "agent.completed", payload: {} });
  expect(meter.window(run.run_id).end).toBe(at("10:06"));
  store.updateAgent(worker.agent_id, { status: "running" });
  expect(meter.window(run.run_id).end).toBeNull();
  store.updateAgent(worker.agent_id, { status: "completed" });
  vi.setSystemTime(at("10:08")); controller.emit({ runId: run.run_id, agentId: worker.agent_id, type: "agent.completed", payload: {} });
  expect(meter.window(run.run_id).end).toBe(at("10:08"));
});

it("does not move the cutoff for observer activity, late permission updates, or administrative shutdown", () => {
  const { run, observer, worker } = setupRun();
  const meter = new RunConversationUsage(store);
  vi.setSystemTime(at("10:06")); controller.emit({ runId: run.run_id, type: "timer.elapsed", payload: { action: "run_shutdown" } });
  vi.setSystemTime(at("11:00")); controller.emit({ runId: run.run_id, agentId: observer.agent_id, type: "agent.completed", payload: {} });
  controller.emit({ runId: run.run_id, type: "timer.elapsed", payload: { action: "run_shutdown" } });
  controller.emit({ runId: run.run_id, agentId: worker.agent_id, type: "agent.status_changed", payload: { status: "completed", reason: "backend_permission_request_updated" } });
  expect(meter.window(run.run_id).end).toBe(at("10:04"));
});

it("ends when cancellation resolves the last outstanding goal", () => {
  const { run, worker } = setupRun();
  const goal = controller.createGoal({ agentId: worker.agent_id, objective: "Await acceptance" });
  const meter = new RunConversationUsage(store);
  expect(meter.window(run.run_id).end).toBeNull();
  vi.setSystemTime(at("10:10")); controller.updateGoal(goal.goal_id, "cancelled");
  expect(meter.window(run.run_id).end).toBe(at("10:10"));
});

it("prices an interval only with its own models, leaving mixed-model usage unattributed", () => {
  writeFileSync(path, header() + tokens(100, "09:59") + tokens(200, "10:01") + row("turn_context", { model: "gpt-5.6-luna" }, at("10:02")) + tokens(300, "10:03"));
  expect(codexRunUsage(id, at("10:00"), at("10:04"))).toMatchObject({ input_tokens: 200, model: "Mixed models" });
  expect(codexRunUsage(id, at("10:02"), at("10:04"))).toMatchObject({ input_tokens: 100, model: "gpt-5.6-luna" });
});
