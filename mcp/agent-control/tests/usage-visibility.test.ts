import Database from "better-sqlite3";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexCliAdapter } from "../src/adapters/codex-cli-adapter.js";
import { readCodexSession, sessionBaseline, sessionUsage } from "../src/adapters/codex-session.js";
import { createDefaultAdapterRegistry } from "../src/adapters/registry.js";
import { AgentController } from "../src/core/controller.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

const id = "11111111-1111-4111-8111-111111111111";
const resumeId = "22222222-2222-4222-8222-222222222222";
const row = (type: string, payload: unknown, timestamp = "2026-09-11T10:00:00.000Z") => JSON.stringify({ type, payload, timestamp }) + "\n";
const tokens = (input: number, timestamp?: string) => row("event_msg", { type: "token_count", info: { total_token_usage: {
  input_tokens: input, output_tokens: input / 10, total_tokens: input + input / 10,
  cached_input_tokens: input / 2, cache_write_input_tokens: 0, reasoning_output_tokens: input / 20
} } }, timestamp);
const header = (threadId = id, provider = "openai", model = "gpt-6-astra") => row("session_meta", { id: threadId, model_provider: provider }) + row("turn_context", { model });
let home: string, path: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-usage-visibility-"));
  vi.stubEnv("CODEX_HOME", home); vi.stubEnv("AGENT_CONTROL_HOME", home);
  mkdirSync(join(home, "sessions"));
  path = join(home, "sessions", `rollout-${id}.jsonl`);
  writeFileSync(path, header() + tokens(100));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it("follows Codex's updated rollout index, including resumed filenames with identical file signatures", () => {
  const resumed = join(home, "sessions", `rollout-${id}_${resumeId}.jsonl`);
  writeFileSync(resumed, header() + tokens(200));
  utimesSync(path, 1000, 1000); utimesSync(resumed, 1000, 1000);
  const db = new Database(join(home, "state_5.sqlite"));
  try {
    db.exec("create table threads (id text primary key, rollout_path text)");
    db.prepare("insert into threads values (?, ?)").run(id, path);
    expect(readCodexSession(id)?.usage?.input_tokens).toBe(100);
    db.prepare("update threads set rollout_path = ? where id = ?").run(resumed, id);
    expect(readCodexSession(id)?.usage?.input_tokens).toBe(200);
  } finally { db.close(); }
});

it("validates indexed identity and falls back to verified archived or resumed rollouts", () => {
  const foreign = join(home, "sessions", `rollout-${id}_${resumeId}.jsonl`);
  writeFileSync(foreign, header(resumeId) + tokens(900));
  const outside = join(home, "unrelated.jsonl"); writeFileSync(outside, header() + tokens(800));
  const db = new Database(join(home, "state_5.sqlite"));
  try {
    db.exec("create table threads (id text primary key, rollout_path text)");
    db.prepare("insert into threads values (?, ?)").run(id, foreign);
    expect(readCodexSession(id)?.usage?.input_tokens).toBe(100);
    db.prepare("update threads set rollout_path = ?").run(outside);
    expect(readCodexSession(id)?.usage?.input_tokens).toBe(100);
    rmSync(path); mkdirSync(join(home, "archived_sessions"));
    writeFileSync(join(home, "archived_sessions", `rollout-${id}_${resumeId}.jsonl`), header() + tokens(300));
    expect(readCodexSession(id)?.usage?.input_tokens).toBe(300);
  } finally { db.close(); }
});

it("repairs a stale attachment baseline using the registration boundary, excluding earlier history", () => {
  const old = sessionBaseline(id)!;
  writeFileSync(path, header() + tokens(1000, "2026-09-11T11:00:00Z") + tokens(1100, "2026-09-11T13:00:00Z"));
  expect(sessionUsage({ backend: "codex-thread", id, data: { thread_id: id, agent_control_role: "observer",
    usage_baseline: old, usage_started_at: "2026-09-11T12:00:00Z" } })).toMatchObject({ input_tokens: 100, output_tokens: 10, cached_input_tokens: 50 });
});

it("keeps a verified zero attachment baseline and distinguishes records sharing its timestamp", () => {
  writeFileSync(path, header());
  const zero = sessionBaseline(id)!;
  appendFileSync(path, tokens(100, zero.captured_at));
  const data = { thread_id: id, agent_control_role: "observer", usage_baseline: zero, usage_started_at: zero.captured_at };
  expect(sessionUsage({ backend: "codex-thread", id, data })?.input_tokens).toBe(100);
  const first = sessionBaseline(id)!;
  appendFileSync(path, tokens(200, first.captured_at));
  expect(sessionUsage({ backend: "codex-thread", id, data: { ...data, usage_baseline: first } })?.input_tokens).toBe(100);
});

it("leaves reset counters unknown even if they subsequently exceed their earlier value", () => {
  const baseline = sessionBaseline(id)!;
  appendFileSync(path, tokens(20, "2026-09-11T11:00:00Z") + tokens(200, "2026-09-11T12:00:00Z"));
  for (const data of [{ thread_id: id }, { thread_id: id, usage_baseline: baseline }]) {
    expect(sessionUsage({ backend: "codex-thread", id, data })).toMatchObject({ input_tokens: null, output_tokens: null, total_tokens: null });
  }
});

it("recovers native CLI tokens while running, after interruption, and after completion without double counting", () => {
  writeFileSync(join(home, "state.json"), JSON.stringify({ thread_id: id, status: "running" }));
  writeFileSync(join(home, "events.jsonl"), row("turn.completed", {}));
  const adapter = new CodexCliAdapter(), handle = { backend: "codex-cli", id, data: { dir: home, resolved_model: "gpt-6-astra", model_provider: "openai" } };
  expect(adapter.readUsage(handle)).toMatchObject({ input_tokens: 100, cached_input_tokens: 50, output_tokens: 10, total_tokens: 110 });
  appendFileSync(path, tokens(200, "2026-09-11T11:00:00Z") + row("event_msg", { type: "turn_aborted" }));
  expect(adapter.readUsage(handle)?.total_tokens).toBe(220);
  appendFileSync(path, row("event_msg", { type: "task_complete" }));
  appendFileSync(join(home, "events.jsonl"), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 200, output_tokens: 20 } }) + "\n");
  expect(new CodexCliAdapter().readUsage(handle)?.total_tokens).toBe(220);
  expect(adapter.readUsage({ ...handle, data: { ...handle.data, model_provider: "foreign" } })).toBeNull();
  expect(adapter.readUsage({ ...handle, data: { ...handle.data, resolved_model: "other" } })).toBeNull();
});

it("uses the native cache breakdown for equal stored totals but never combines it with more recent consumption", async () => {
  const store = new SqliteStore(":memory:"), controller = new AgentController(store, createDefaultAdapterRegistry());
  try {
    const run = controller.createRun({ title: "Stored and native usage", repoDir: home });
    writeFileSync(join(home, "state.json"), JSON.stringify({ thread_id: id }));
    const agent = controller.registerAgent({ runId: run.run_id, backend: "codex-cli", title: "Worker", status: "completed",
      backendHandle: { dir: home, resolved_model: "gpt-6-astra", model_provider: "openai" } });
    controller.createUsageSnapshot({ runId: run.run_id, agentId: agent.agent_id, model: "gpt-6-astra", inputTokens: 100,
      outputTokens: 10, totalTokens: 110, capturedAt: "2026-09-11T12:00:00Z" });
    const cost = controller.getDashboardSnapshot(run.run_id).costs?.total.total;
    expect(cost?.usd).toBeCloseTo(.00105, 10); expect(cost?.partial).toBe(false);
    controller.createUsageSnapshot({ runId: run.run_id, agentId: agent.agent_id, model: "gpt-6-astra", inputTokens: 200,
      outputTokens: 20, totalTokens: 220, capturedAt: "2026-09-11T13:00:00Z" });
    const snapshot = controller.getDashboardSnapshot(run.run_id);
    expect(snapshot.computed_agents[0].latest_usage?.input_tokens).toBe(200);
    expect(snapshot.computed_agents[0].latest_usage?.cached_input_tokens == null).toBe(true);
    expect(snapshot.costs?.total.total).toEqual({ usd: .001, partial: true });
  } finally { await controller.dispose(); store.close(); }
});

it("applies the run boundary in dashboard costs without changing stored attachment history", async () => {
  const store = new SqliteStore(":memory:"), controller = new AgentController(store, createDefaultAdapterRegistry());
  try {
    const old = sessionBaseline(id)!;
    writeFileSync(path, header() + tokens(1000, "2020-01-01T00:00:00Z") + tokens(1100, "2099-01-01T00:00:00Z"));
    const run = controller.createRun({ title: "Requester cost scope", repoDir: home });
    const agent = controller.registerAgent({ runId: run.run_id, backend: "codex-session", role: "observer", title: "Requester", status: "completed",
      backendHandle: { thread_id: id, model_provider: "openai", usage_baseline: old, agent_control_role: "observer" } });
    const snapshot = controller.getDashboardSnapshot(run.run_id);
    expect(snapshot.computed_agents[0].latest_usage?.input_tokens).toBe(100);
    expect(snapshot.costs?.total.total.usd).toBeCloseTo(.00105, 10);
    expect(snapshot.costs?.total.total.partial).toBe(false);
    expect(controller.getAgent(agent.agent_id).backend_handle?.usage_baseline).toEqual(old);
    expect(controller.listUsageSnapshots({ runId: run.run_id })).toHaveLength(0);
  } finally { await controller.dispose(); store.close(); }
});
