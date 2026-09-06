import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AgentController } from "../src/core/controller.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { RunObservation } from "../src/core/run-observation.js";
import type { AgentAdapter } from "../src/core/types.js";

describe("processed observer cursors", () => {
  let directory: string;
  let store: SqliteStore;
  let controller: AgentController;
  let observations: RunObservation;
  let adapters: AdapterRegistry;
  const adminKey = "cursor-test-admin";
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "observer-cursors-"));
    vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", adminKey);
    vi.stubEnv("AGENT_CONTROL_HOME", directory);
    vi.stubEnv("CODEX_THREAD_ID", "user-thread");
    adapters = new AdapterRegistry();
    adapters.register({ kind: "codex-thread", capabilities: () => ({ canStart: false, canSendMessage: false,
      canReadLatest: false, canStopGracefully: false, canForceStop: false, canStreamMessages: false,
      canInspectStatusCheaply: false, canAttachExisting: true }) } as AgentAdapter);
    reopen();
  });
  function reopen() {
    store = new SqliteStore(join(directory, "state.sqlite"));
    controller = new AgentController(store, adapters);
    observations = new RunObservation(store, controller, adapters);
  }
  afterEach(async () => {
    await controller.dispose(); store.close(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
  });
  function observe(runId = controller.createRun({ title: "Cursor work", adminKey }).run_id, threadId = "user-thread") {
    return observations.observe({ runId, threadId, adminKey, eventTypes: ["flow.completed"] });
  }
  function emit(runId: string) { return store.createEvent({ runId, type: "flow.completed" }); }
  function wait(observer: ReturnType<typeof observe>, extra: Partial<Parameters<RunObservation["wait"]>[0]> = {}) {
    return observations.wait({ runId: observer.run_id, observerAgentId: observer.observer_agent_id, timeoutMs: 1, intervalMs: 1, ...extra });
  }
  function ack(observer: ReturnType<typeof observe>, cursor: string) {
    return observations.acknowledge({ runId: observer.run_id, observerAgentId: observer.observer_agent_id, cursor, adminKey });
  }

  it("replays fetched but unacknowledged events after reopening the database", async () => {
    const observer = observe();
    const event = emit(observer.run_id);
    const delivered = await wait(observer);
    expect(delivered.events[0]?.event_id).toBe(event.event_id);
    expect(observe(observer.run_id).cursor).toBe(observer.cursor);
    await controller.dispose(); store.close(); reopen();
    expect((await wait(observer)).events[0]?.event_id).toBe(event.event_id);
    expect(ack(observer, delivered.cursor)).toMatchObject({ advanced: true, processed_cursor: delivered.cursor });
    await controller.dispose(); store.close(); reopen();
    expect(observe(observer.run_id).cursor).toBe(delivered.cursor);
    expect(await wait(observer)).toMatchObject({ events: [], timed_out: true });
  });

  it("acknowledges batches monotonically and permits safe duplicate ACKs", async () => {
    const observer = observe(); emit(observer.run_id); emit(observer.run_id);
    const first = await wait(observer, { limit: 1 });
    const second = await wait(observer, { cursor: first.cursor, limit: 1 });
    expect(ack(observer, second.cursor).advanced).toBe(true);
    expect(ack(observer, second.cursor).advanced).toBe(false);
    expect(ack(observer, first.cursor)).toMatchObject({ advanced: false, processed_cursor: second.cursor });
    expect(observe(observer.run_id)).toMatchObject({ cursor: second.cursor, delivered_cursor: second.cursor });
  });

  it("rejects cursors from another observer, another run, or modified signed content", async () => {
    const observer = observe();
    const colleague = observe(observer.run_id, "other-thread");
    const foreign = observe();
    emit(observer.run_id);
    const delivered = await wait(observer);
    expect(() => ack(colleague, delivered.cursor)).toThrow(/cursor/);
    expect(() => ack(foreign, delivered.cursor)).toThrow(/cursor/);
    await expect(wait(colleague, { cursor: delivered.cursor })).rejects.toThrow(/cursor/);
    const data = JSON.parse(Buffer.from(delivered.cursor, "base64url").toString());
    const body = JSON.parse(data[0]); body[3] += 1; data[0] = JSON.stringify(body);
    expect(() => ack(observer, Buffer.from(JSON.stringify(data)).toString("base64url"))).toThrow(/cursor/);
  });

  it("preserves explicit legacy replay without acknowledging an undelivered gap", async () => {
    const observer = observe();
    const skipped = emit(observer.run_id); emit(observer.run_id);
    const { sequence } = store.db.prepare("select sequence from event_order where event_id = ?").get(skipped.event_id) as { sequence: number };
    const legacy = Buffer.from(JSON.stringify([1, observer.run_id, sequence])).toString("base64url");
    const later = await wait(observer, { cursor: legacy });
    expect(later.events).toHaveLength(1);
    expect(() => ack(observer, legacy)).toThrow(/cursor/);
    expect(() => ack(observer, later.cursor)).toThrow(/contiguously/);
    await wait(observer, { limit: 1 });
    expect(ack(observer, later.cursor).advanced).toBe(true);
  });

  it("requires observing ownership and never changes progress for a failed ACK", async () => {
    const observer = observe(); emit(observer.run_id);
    const delivered = await wait(observer);
    const foreignOwner = controller.orchestratorLogin({ title: "Other owner", adminKey, backend: "codex-thread",
      backendHandle: { thread_id: "other-thread", agent_control_role: "orchestrator" } });
    vi.stubEnv("CODEX_THREAD_ID", "other-thread");
    expect(() => observations.acknowledge({ runId: observer.run_id, observerAgentId: observer.observer_agent_id, cursor: delivered.cursor })).toThrow(/identity/);
    expect(() => observations.acknowledge({ runId: observer.run_id, observerAgentId: observer.observer_agent_id, cursor: delivered.cursor,
      agentToken: foreignOwner.agent_token })).toThrow(/identity/);
    expect(observe(observer.run_id).cursor).toBe(observer.cursor);
  });

  it("uses the local observing thread only when explicit credentials are absent", async () => {
    const observer = observe(); emit(observer.run_id);
    const batch = await wait(observer);
    const input = { runId: observer.run_id, observerAgentId: observer.observer_agent_id, cursor: batch.cursor };
    expect(() => observations.acknowledge({ ...input, agentToken: "wrong-explicit-token" })).toThrow();
    expect(() => observations.acknowledge({ ...input, adminKey: "wrong-explicit-admin" })).toThrow(/identity/);
    expect(observe(observer.run_id).cursor).toBe(observer.cursor);
    const acknowledged = observations.acknowledge(input);
    expect(acknowledged.advanced).toBe(true);
    expect(acknowledged.wait_contract.arguments).not.toHaveProperty("cursor");
    expect((await wait(observer)).events).toEqual([]);
    expect((await wait(observer, { cursor: observer.cursor })).events).toEqual(batch.events);
  });

  it("migrates existing subscriptions from their original start without assuming prior processing", async () => {
    const observer = observe(); emit(observer.run_id);
    await wait(observer);
    store.db.prepare("delete from observer_cursors where observer_agent_id = ?").run(observer.observer_agent_id);
    store.db.prepare("delete from observer_deliveries where observer_agent_id = ?").run(observer.observer_agent_id);
    await controller.dispose(); store.close(); reopen();
    const restored = observe(observer.run_id);
    expect((await wait(restored)).events).toHaveLength(1);
    const row = store.db.prepare("select processed_sequence, start_sequence from observer_cursors join run_observers using(observer_agent_id)").get() as Record<string, number>;
    expect(row.processed_sequence).toBe(row.start_sequence);
  });

  it("returns a handling instruction without acknowledging the fetched batch", async () => {
    const observer = observe(); emit(observer.run_id);
    const batch = await wait(observer);
    expect(batch).toMatchObject({ ack_contract: { tool: "run_ack", arguments: { run_id: observer.run_id,
      observer_agent_id: observer.observer_agent_id, cursor: batch.cursor } } });
    expect(batch.wait_contract?.instruction).toContain("Fetching events or receiving a notification never acknowledges");
    expect((await wait(observer)).events).toEqual(batch.events);
  });

  it("keeps injected notifications unprocessed until their event batch is acknowledged", async () => {
    const stage = vi.fn(async () => {});
    adapters.get("codex-thread").stageNotification = stage;
    const observer = observe();
    observations.observe({ runId: observer.run_id, threadId: "user-thread", adminKey, delivery: "notify" });
    const event = emit(observer.run_id);
    await observations.notify(event);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(observe(observer.run_id).cursor).toBe(observer.cursor);
    const delivered = await wait(observer);
    expect(delivered.events[0]?.event_id).toBe(event.event_id);
    ack(observer, delivered.cursor);
    expect((await wait(observer)).events).toEqual([]);
  });

  it("accepts the observing orchestrator token and rejects a same-run foreign owner", async () => {
    const owner = controller.orchestratorLogin({ title: "Observing owner", adminKey, backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } });
    const observer = observe(owner.run.run_id);
    const other = controller.orchestratorLogin({ title: "Other owner", runId: owner.run.run_id, adminKey, backend: "codex-thread",
      backendHandle: { thread_id: "other-thread", agent_control_role: "orchestrator" } });
    emit(observer.run_id);
    const delivered = await wait(observer);
    expect(() => observations.acknowledge({ runId: observer.run_id, observerAgentId: observer.observer_agent_id,
      cursor: delivered.cursor, agentToken: other.agent_token })).toThrow(/identity/);
    expect(observations.acknowledge({ runId: observer.run_id, observerAgentId: observer.observer_agent_id,
      cursor: delivered.cursor, agentToken: owner.agent_token })).toMatchObject({ advanced: true });
  });
});
