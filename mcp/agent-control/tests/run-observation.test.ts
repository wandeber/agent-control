import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AgentController } from "../src/core/controller.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { EVENT_TYPES } from "../src/core/types.js";
import type { AgentAdapter, AgentStatusSnapshot, EventRecord, EventType } from "../src/core/types.js";
import { handleTool } from "../src/tools/handlers.js";
import { launchWorker, type WorkerLaunchOptions } from "../src/cli/worker.js";
import { resolve } from "node:path";

describe("run observation", () => {
  let directory: string;
  let store: SqliteStore;
  let controller: AgentController;
  let adapters: AdapterRegistry;
  let staged: ReturnType<typeof vi.fn>;
  let sent: ReturnType<typeof vi.fn>;
  let stopped: ReturnType<typeof vi.fn>;
  let status: AgentStatusSnapshot;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agent-control-observer-test-"));
    vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "observer-test-admin");
    vi.stubEnv("AGENT_CONTROL_HOME", directory);
    vi.stubEnv("CODEX_THREAD_ID", "user-thread");
    store = new SqliteStore(join(directory, "state.sqlite"));
    adapters = new AdapterRegistry();
    staged = vi.fn(async () => {});
    sent = vi.fn(async () => {});
    stopped = vi.fn(async () => ({ status: "stopped" as const }));
    status = { status: "running" };
    for (const kind of ["codex-thread", "fake", "manual"]) {
      adapters.register({ kind, capabilities: () => ({ canStart: true, canSendMessage: true, canReadLatest: true,
        canStopGracefully: true, canForceStop: false, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: true }),
        start: async ({ agent }) => ({ backend: kind, id: agent.agent_id, data: { thread_id: agent.agent_id } }),
        stageNotification: staged, sendMessage: sent, getStatus: async () => status, readLatest: async () => [], stop: stopped
      } satisfies AgentAdapter);
    }
    controller = new AgentController(store, adapters);
  });

  afterEach(async () => {
    await controller.dispose();
    store.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function run() { return controller.createRun({ title: "Observed work", adminKey: "observer-test-admin" }); }
  function observe(runId: string, extra: Partial<Parameters<AgentController["observeRun"]>[0]> = {}) {
    return controller.observeRun({ runId, threadId: "user-thread", adminKey: "observer-test-admin", ...extra });
  }
  function emit(runId: string, type: EventType, payload: Record<string, unknown> = {}, agentId?: string) {
    return (controller as unknown as { emit(input: { runId: string; type: EventType; payload: Record<string, unknown>; agentId?: string }): EventRecord })
      .emit({ runId, type, payload, agentId });
  }
  function wait(observation: ReturnType<typeof observe>, extra: Partial<Parameters<AgentController["waitForRun"]>[0]> = {}) {
    return controller.waitForRun({ runId: observation.run_id, observerAgentId: observation.observer_agent_id,
      cursor: observation.cursor, timeoutMs: 20, intervalMs: 1, ...extra });
  }

  it("projects global subscriptions into the selected dashboard without including foreign participants or run scopes", () => {
    const first = run(), other = run();
    const owner = controller.registerAgent({ runId: first.run_id, backend: "fake", title: "Owner" });
    const worker = controller.registerAgent({ runId: first.run_id, backend: "fake", title: "Worker" });
    const foreign = controller.registerAgent({ runId: other.run_id, backend: "fake", title: "Other" });
    const global = controller.createSubscription({ subscriberAgentId: owner.agent_id, eventType: "agent.completed" });
    const scoped = controller.createSubscription({ runId: first.run_id, sourceAgentId: worker.agent_id, subscriberAgentId: owner.agent_id, eventType: "agent.blocked" });
    controller.createSubscription({ runId: other.run_id, subscriberAgentId: owner.agent_id, eventType: "agent.failed" });
    controller.createSubscription({ subscriberAgentId: foreign.agent_id, eventType: "agent.completed" });
    controller.createSubscription({ sourceAgentId: foreign.agent_id, subscriberAgentId: owner.agent_id, eventType: "agent.stopped" });
    const snapshot = controller.getDashboardSnapshot(first.run_id);
    expect(snapshot.subscriptions.map((subscription) => subscription.subscription_id)).toEqual([global.subscription_id, scoped.subscription_id]);
    expect(snapshot.subscriptions[0]).toMatchObject({ run_id: null, source_agent_id: null });
    expect(controller.listSubscriptions({ runId: first.run_id }).map((subscription) => subscription.subscription_id)).toEqual([scoped.subscription_id]);
  });

  it("attaches a distinct conversation without tokens, ownership grants or parent links", () => {
    const owner = controller.orchestratorLogin({ title: "Owner", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "owner-thread", agent_control_role: "orchestrator" } });
    const observation = observe(owner.run.run_id);
    expect(controller.getAgent(observation.observer_agent_id).role).toBe("observer");
    expect(controller.listAgentLinks({ runId: owner.run.run_id })).toEqual([]);
    expect(store.db.prepare("select count(*) n from bridge_grants").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) n from agent_tokens where agent_id = ?").get(observation.observer_agent_id)).toEqual({ n: 0 });
    expect(observation).not.toHaveProperty("agent_token");
  });

  it("reuses the existing user conversation and subscriptions idempotently", () => {
    const id = run().run_id;
    const first = observe(id);
    const again = observe(id);
    expect(again).toMatchObject({ observer_agent_id: first.observer_agent_id, cursor: first.cursor, reused: true });
    expect(controller.listAgents({ runId: id })).toHaveLength(1);
    expect(controller.listSubscriptions({ runId: id })).toHaveLength(first.event_types.length);
  });

  it("keeps same-thread owner identity and authority without duplicate delivery", async () => {
    const owner = controller.orchestratorLogin({ title: "Owner", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } });
    const observation = observe(owner.run.run_id, { delivery: "notify" });
    controller.createSubscription({ runId: owner.run.run_id, subscriberAgentId: owner.agent.agent_id, eventType: "flow.notification" });
    const action = { action_id: "action-safe", orchestrator_agent_id: owner.agent.agent_id, operation: "spawn_agent", status: "pending", secret: "never-render" };
    emit(owner.run.run_id, "flow.notification", { orchestrator_action: action, reason: "native_orchestrator_action_required" });
    await controller.drainDeliveries();
    expect(observation.observer_agent_id).toBe(owner.agent.agent_id);
    expect(controller.getAgent(owner.agent.agent_id).role).toBe("orchestrator");
    expect(sent).not.toHaveBeenCalled();
    expect(staged).toHaveBeenCalledTimes(1);
    expect(staged.mock.calls[0]?.[1].message).not.toContain("never-render");
    expect((await wait(observation)).events[0]?.orchestrator_action).toMatchObject({ action_id: "action-safe" });
  });

  it("moves existing owner subscriptions into wait without starting a competing turn", async () => {
    const owner = controller.orchestratorLogin({ title: "Owner", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } });
    controller.createSubscription({ runId: owner.run.run_id, subscriberAgentId: owner.agent.agent_id, eventType: "flow.notification" });
    const observation = observe(owner.run.run_id, { eventTypes: ["flow.completed"] });
    emit(owner.run.run_id, "flow.notification");
    await controller.drainDeliveries();
    expect((await wait(observation)).events.map((event) => event.type)).toEqual(["flow.notification"]);
    expect(sent).not.toHaveBeenCalled();
    expect(staged).not.toHaveBeenCalled();
  });

  it.each(["wait", "notify"] as const)("preserves owner subscription source scope in %s delivery before limiting batches", async (delivery) => {
    const owner = controller.orchestratorLogin({ title: "Owner", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } });
    const workerA = controller.registerAgent({ runId: owner.run.run_id, backend: "fake", title: "Worker A" });
    const workerB = controller.registerAgent({ runId: owner.run.run_id, backend: "fake", title: "Worker B" });
    controller.createSubscription({ runId: owner.run.run_id, sourceAgentId: workerA.agent_id,
      subscriberAgentId: owner.agent.agent_id, eventType: "agent.blocked" });
    const observation = observe(owner.run.run_id, { eventTypes: ["flow.completed"], delivery });
    for (let index = 0; index < 25; index++) emit(owner.run.run_id, "agent.blocked", { index }, workerB.agent_id);
    await controller.drainDeliveries();
    expect((await wait(observation, { limit: 1 })).events).toEqual([]);
    expect(staged).not.toHaveBeenCalled();
    const expected = emit(owner.run.run_id, "agent.blocked", {}, workerA.agent_id);
    await controller.drainDeliveries();
    expect((await wait(observation, { limit: 1 })).events.map((event) => event.event_id)).toEqual([expected.event_id]);
    expect(staged).toHaveBeenCalledTimes(delivery === "notify" ? 1 : 0);
  });

  it.each(["wait", "notify"] as const)("preserves owner subscription run scope and accepts a null run scope in %s delivery", async (delivery) => {
    const owner = controller.orchestratorLogin({ title: "Owner", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } });
    const other = run();
    const worker = controller.registerAgent({ runId: owner.run.run_id, backend: "fake", title: "Worker" });
    controller.createSubscription({ runId: other.run_id, sourceAgentId: worker.agent_id,
      subscriberAgentId: owner.agent.agent_id, eventType: "agent.failed" });
    controller.createSubscription({ sourceAgentId: worker.agent_id,
      subscriberAgentId: owner.agent.agent_id, eventType: "agent.stopped" });
    const observation = observe(owner.run.run_id, { eventTypes: ["flow.completed"], delivery });
    emit(owner.run.run_id, "agent.failed", {}, worker.agent_id);
    await controller.drainDeliveries();
    expect((await wait(observation)).events).toEqual([]);
    expect(staged).not.toHaveBeenCalled();
    const expected = emit(owner.run.run_id, "agent.stopped", {}, worker.agent_id);
    await controller.drainDeliveries();
    expect((await wait(observation)).events.map((event) => event.event_id)).toEqual([expected.event_id]);
    expect(staged).toHaveBeenCalledTimes(delivery === "notify" ? 1 : 0);
  });

  it.each(["wait", "notify"] as const)("keeps default observer subscriptions run-wide for future workers in %s delivery", async (delivery) => {
    const observation = observe(run().run_id, { delivery });
    const futureWorker = controller.registerAgent({ runId: observation.run_id, backend: "fake", title: "Future worker" });
    const event = emit(observation.run_id, "agent.blocked", {}, futureWorker.agent_id);
    await controller.drainDeliveries();
    expect((await wait(observation)).events.map((entry) => entry.event_id)).toEqual([event.event_id]);
    expect(staged).toHaveBeenCalledTimes(delivery === "notify" ? 1 : 0);
  });

  it("preserves legacy delivery from a different run outside the observation's scope", async () => {
    const owner = controller.orchestratorLogin({ title: "Owner", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } });
    const observation = observe(owner.run.run_id, { eventTypes: ["flow.completed"], delivery: "wait" });
    const other = run();
    const worker = controller.registerAgent({ runId: other.run_id, backend: "fake", title: "Other-run worker" });
    controller.createSubscription({ runId: other.run_id, sourceAgentId: worker.agent_id,
      subscriberAgentId: owner.agent.agent_id, eventType: "agent.blocked" });
    emit(other.run_id, "agent.blocked", {}, worker.agent_id);
    await controller.drainDeliveries();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(staged).not.toHaveBeenCalled();
    expect((await wait(observation)).events).toEqual([]);
  });

  it("rejects cross-run authority and an unavailable thread identity", () => {
    const owner = controller.orchestratorLogin({ title: "Owner", adminKey: "observer-test-admin", backend: "fake" });
    expect(() => controller.observeRun({ runId: run().run_id, threadId: "user-thread", agentToken: owner.agent_token })).toThrow(/authorized/);
    vi.stubEnv("CODEX_THREAD_ID", "");
    expect(() => controller.observeRun({ runId: owner.run.run_id, adminKey: "observer-test-admin" })).toThrow(/actual Codex thread/);
  });

  it("honors finish-only filters for a separate requester", async () => {
    const observation = observe(run().run_id, { eventTypes: ["flow.completed"] });
    emit(observation.run_id, "flow.step_started", { step_id: "analysis" });
    const terminal = emit(observation.run_id, "flow.completed");
    expect((await wait(observation)).events.map((event) => event.event_id)).toEqual([terminal.event_id]);
  });

  it("observes future free workers and phase changes with one subscription set", async () => {
    const observation = observe(run().run_id);
    const worker = controller.registerAgent({ runId: observation.run_id, backend: "fake", title: "Later worker" });
    emit(observation.run_id, "agent.completed", {}, worker.agent_id);
    emit(observation.run_id, "flow.step_started", { flow_instance_id: "flow-test", step_id: "review" });
    expect((await wait(observation)).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: worker.agent_id, type: "agent.completed" }),
      expect.objectContaining({ flow_instance_id: "flow-test", step_id: "review" })
    ]));
  });

  it("keeps ordered cursors over timestamp ties, batches and controller restarts", async () => {
    const observation = observe(run().run_id, { eventTypes: ["flow.step_started"] });
    const ids = Array.from({ length: 45 }, (_, index) => emit(observation.run_id, "flow.step_started", { step_id: `step${index}` }).event_id);
    store.db.prepare("update events set created_at = '2026-01-01T00:00:00.000Z' where run_id = ?").run(observation.run_id);
    await controller.drainDeliveries();
    const first = await wait(observation);
    expect(first.events.map((event) => event.event_id)).toEqual(ids.slice(0, 20));
    store.close();
    store = new SqliteStore(join(directory, "state.sqlite"));
    controller = new AgentController(store, adapters);
    const next = await wait(observation, { cursor: first.cursor, limit: 100 });
    expect(next.events.map((event) => event.event_id)).toEqual(ids.slice(20));
    const end = await wait(observation, { cursor: next.cursor });
    expect(end).toMatchObject({ events: [], cursor: next.cursor, timed_out: true });
  });

  it("orders events written through another database connection", async () => {
    const observation = observe(run().run_id, { eventTypes: ["flow.completed"] });
    const other = new SqliteStore(join(directory, "state.sqlite"));
    const event = other.createEvent({ runId: observation.run_id, type: "flow.completed" });
    other.close();
    expect((await wait(observation)).events[0]?.event_id).toBe(event.event_id);
  });

  it("does not rewind sequence after purging events", async () => {
    const observation = observe(run().run_id, { eventTypes: ["flow.completed"] });
    emit(observation.run_id, "flow.completed");
    const first = await wait(observation);
    await controller.drainDeliveries();
    store.db.prepare("delete from events where run_id = ?").run(observation.run_id);
    const later = emit(observation.run_id, "flow.completed");
    expect((await wait(observation, { cursor: first.cursor })).events[0]?.event_id).toBe(later.event_id);
  });

  it("rejects a cursor from another run", async () => {
    const first = observe(run().run_id);
    const second = observe(run().run_id);
    await expect(wait(first, { cursor: second.cursor })).rejects.toThrow(/cursor/);
  });

  it("cancels an indefinite MCP wait and preserves its cursor on timeout", async () => {
    const observation = observe(run().run_id);
    const abort = new AbortController();
    const pending = handleTool(controller, "run_wait", { run_id: observation.run_id,
      observer_agent_id: observation.observer_agent_id, cursor: observation.cursor }, abort.signal);
    setTimeout(() => abort.abort(new Error("user cancelled")), 10);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect((await wait(observation)).cursor).toBe(observation.cursor);
    const hour = new AbortController();
    const hourWait = wait(observation, { timeoutMs: 3_600_000, signal: hour.signal });
    hour.abort(new Error("one-hour wait cancelled"));
    await expect(hourWait).rejects.toThrow(/cancelled/);
  });

  it("closes a wait when its last subscription is deleted", async () => {
    const observation = observe(run().run_id, { eventTypes: ["flow.completed"] });
    controller.deleteSubscription(controller.listSubscriptions({ runId: observation.run_id })[0]!.subscription_id);
    expect(await wait(observation)).toMatchObject({ closed: true, events: [] });
  });

  it.each([false, true])("shutdown preserves the user conversation (same owner: %s)", async (sameOwner) => {
    const existing = sameOwner ? controller.orchestratorLogin({ title: "Owner", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } }).run : run();
    const observation = observe(existing.run_id);
    const worker = controller.registerAgent({ runId: existing.run_id, backend: "fake", title: "Worker", status: "running", backendHandle: { id: "worker" } });
    const result = await controller.shutdownRun(existing.run_id);
    expect(result.complete).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped.mock.calls[0]?.[0].id).not.toBe("user-thread");
    expect(controller.getAgent(worker.agent_id).status).toBe("stopped");
    expect(controller.getAgent(observation.observer_agent_id).status).toBe("waiting_for_input");
  });

  it("does not start or directly interrupt an observing conversation", async () => {
    const observation = observe(run().run_id);
    await expect(controller.startAgent({ agentId: observation.observer_agent_id, prompt: "bad worker launch" })).rejects.toThrow(/attached conversation/);
    await controller.stopAgent(observation.observer_agent_id);
    expect(stopped).not.toHaveBeenCalled();
  });

  it("keeps failed notify events readable and never retries uncertain injection", async () => {
    staged.mockRejectedValue(new Error("unsupported method"));
    const observation = observe(run().run_id, { delivery: "notify", eventTypes: ["flow.completed"] });
    const event = emit(observation.run_id, "flow.completed");
    await controller.drainDeliveries();
    const result = await wait(observation);
    expect(result.events[0]).toMatchObject({ event_id: event.event_id, notification_status: "failed" });
    expect(sent).not.toHaveBeenCalled();
    await wait(observation);
    expect(staged).toHaveBeenCalledTimes(1);
  });

  it("does not give a separate observer native action references", async () => {
    const observation = observe(run().run_id, { delivery: "notify", eventTypes: ["flow.notification"] });
    emit(observation.run_id, "flow.notification", { orchestrator_action: { action_id: "action-other", orchestrator_agent_id: "owner", secret: "private" } });
    await controller.drainDeliveries();
    expect((await wait(observation)).events[0]).not.toHaveProperty("orchestrator_action");
    expect(staged.mock.calls[0]?.[1].message).not.toContain("action-other");
  });

  it("projects activity from existing status reads without refreshing heartbeat for presentation", async () => {
    const worker = controller.registerAgent({ runId: run().run_id, backend: "fake", title: "Worker", status: "running", backendHandle: { id: "activity-worker" } });
    const heartbeat = vi.spyOn(store, "touchHeartbeat");
    status = { status: "running", data: { activity: { kind: "message", text: "First line\nCurrent public line", observed_at: "2026-09-05T12:00:00Z" } } };
    await controller.refreshAgentStatus(worker.agent_id);
    const before = heartbeat.mock.calls.length;
    expect(controller.getDashboardSnapshot(worker.run_id).computed_agents[0]?.activity).toMatchObject({ text: "Current public line", observed_at: "2026-09-05T12:00:00Z" });
    controller.getDashboardSnapshot(worker.run_id);
    expect(heartbeat.mock.calls.length).toBe(before);
    status = { status: "running", data: { activity: null } };
    await controller.refreshAgentStatus(worker.agent_id);
    expect(controller.getDashboardSnapshot(worker.run_id).computed_agents[0]?.activity).toBeUndefined();
  });

  it("refreshes identical operation timestamps on a later turn", async () => {
    const worker = controller.registerAgent({ runId: run().run_id, backend: "fake", title: "Worker", status: "running", backendHandle: { id: "same-operation" } });
    status = { status: "running", data: { activity: { kind: "tool", text: "Run tests", state: "running", observed_at: "2026-09-05T12:00:00Z" } } };
    await controller.refreshAgentStatus(worker.agent_id);
    status.data!.activity = { kind: "tool", text: "Run tests", state: "running", observed_at: "2026-09-05T13:00:00Z" };
    await controller.refreshAgentStatus(worker.agent_id);
    expect(controller.getDashboardSnapshot(worker.run_id).computed_agents[0]?.activity?.observed_at).toBe("2026-09-05T13:00:00Z");
  });

  it("does not promote reasoning or raw log messages into public card activity", async () => {
    const worker = controller.registerAgent({ runId: run().run_id, backend: "fake", title: "Worker", status: "running", backendHandle: { id: "public-read" } });
    adapters.get("fake").readLatest = async () => [
      { id: "public", role: "assistant", text: "Public update", created_at: "2026-09-05T12:00:00Z", metadata: { kind: "text" } },
      { id: "private", role: "assistant", text: "Private chain of thought", created_at: "2026-09-05T12:00:01Z", metadata: { kind: "reasoning" } },
      { id: "log", role: "assistant", text: "raw backend secret", created_at: "2026-09-05T12:00:02Z", metadata: { source: "opencode-log-tail" } }
    ];
    await controller.readLatest(worker.agent_id, 10);
    expect(controller.getDashboardSnapshot(worker.run_id).computed_agents[0]?.activity?.text).toBe("Public update");
  });

  it("preserves the user's filters and delivery mode when resuming without overrides", () => {
    const observation = observe(run().run_id, { eventTypes: ["flow.completed"], delivery: "notify" });
    const resumed = observe(observation.run_id);
    expect(resumed).toMatchObject({ event_types: ["flow.completed"], delivery: "notify", reused: true });
  });

  it("backfills ordered cursors when upgrading a database with existing events", async () => {
    const id = run().run_id;
    await controller.drainDeliveries();
    store.db.exec("drop trigger event_observation_order; drop table event_order;");
    store.createEvent({ runId: id, type: "flow.completed" });
    store.close();
    store = new SqliteStore(join(directory, "state.sqlite"));
    controller = new AgentController(store, adapters);
    const rows = store.db.prepare("select e.event_id from events e left join event_order o using(event_id) where o.sequence is null").all();
    expect(rows).toEqual([]);
    expect(store.db.prepare("pragma foreign_key_check").all()).toEqual([]);
  });

  it("attaches the requester before dispatching a free worker", async () => {
    const observedRun = run();
    let registeredBeforeStart = false;
    const adapter = adapters.get("fake");
    adapter.start = async ({ agent }) => {
      registeredBeforeStart = store.db.prepare("select 1 from run_observers where run_id = ?").get(agent.run_id) !== undefined;
      return { backend: "fake", id: agent.agent_id, data: { id: agent.agent_id } };
    };
    const options: WorkerLaunchOptions = { backend: "fake", title: "Worker", phase: "analysis", run: observedRun.run_id,
      promptFile: resolve("../../flows/development-flow-v1/prompts/analysis.md"), repoDir: directory,
      outputArtifact: join(directory, "output.md"), startTimeoutMs: 1000, inputArtifact: [], constraint: [],
      expectArtifact: [], file: [], subscribeEvent: [], subscriberAgentId: [], watchIntervalMs: 1000,
      watch: false, requesterThreadId: "user-thread", requesterEvent: ["agent.completed"] };
    const result = await launchWorker(options, { controller, output: () => {}, authOptions: () => ({ adminKey: "observer-test-admin" }) });
    expect(registeredBeforeStart).toBe(true);
    expect(result.observer).toMatchObject({ thread_id: "user-thread", event_types: ["agent.completed"] });
  });
  it("launches a reportless MCP worker in one call with all events and one user participant", async () => {
    let beforeStart = false;
    const adapter = adapters.get("codex-thread");
    adapter.start = async ({ agent }) => {
      const subscriptions = controller.listSubscriptions({ runId: agent.run_id });
      beforeStart = subscriptions.length === EVENT_TYPES.length;
      return { backend: "codex-thread", id: agent.agent_id, data: { thread_id: agent.agent_id } };
    };
    const launched = await handleTool(controller, "worker_launch", { title: "Quick review", prompt: "Review only", repo_dir: directory, watch: false }) as any;
    expect(beforeStart).toBe(true);
    expect(launched.observer).toMatchObject({ thread_id: "user-thread", event_types: [...EVENT_TYPES], delivery: "wait" });
    expect(controller.listAgents({ runId: launched.run_id }).filter(a => a.backend_handle?.thread_id === "user-thread")).toHaveLength(1);
    expect(controller.getAgent(launched.observer.observer_agent_id).role).toBe("orchestrator");
    expect(launched).not.toHaveProperty("agent_token");
    const batch = await wait(launched.observer);
    expect(batch.events.some(e => e.type === "agent.started")).toBe(true);
    expect(batch.events.some(e => e.type === "agent.status_changed")).toBe(true);
  });

  it("automatically attaches direct MCP starts before the backend runs", async () => {
    const id = run().run_id;
    const worker = controller.registerAgent({ runId: id, backend: "fake", title: "Worker" });
    let attached = false;
    adapters.get("fake").start = async ({ agent }) => {
      attached = controller.listSubscriptions({ runId: id }).length === EVENT_TYPES.length;
      return { backend: "fake", id: agent.agent_id, data: { id: agent.agent_id } };
    };
    const started = await handleTool(controller, "agent_start", { agent_id: worker.agent_id, prompt: "Review" }) as any;
    expect(attached).toBe(true);
    expect(started.observer.event_types).toEqual([...EVENT_TYPES]);
  });

  it("inherits the original requester into child runs before the nested worker thread", async () => {
    const parent = run();
    const original = observe(parent.run_id, { eventTypes: ["agent.completed"] });
    const worker = controller.registerAgent({ runId: parent.run_id, backend: "fake", title: "Nested launcher", adminKey: "observer-test-admin" });
    const child = controller.createRun({ title: "Child", agentToken: worker.agent_token });
    vi.stubEnv("CODEX_THREAD_ID", "nested-thread");
    const first = controller.ensureRequester(child.run_id, { agentToken: worker.agent_token })!;
    expect(first.thread_id).toBe(original.thread_id);
    expect(first.event_types).toEqual([...EVENT_TYPES]);
    expect(controller.ensureRequester(parent.run_id)?.event_types).toEqual(["agent.completed"]);
    const again = controller.ensureRequester(child.run_id)!;
    expect(again.observer_agent_id).toBe(first.observer_agent_id);
    expect(controller.listSubscriptions({ runId: child.run_id })).toHaveLength(EVENT_TYPES.length);
  });

  it("returns an observer for direct flow starts before initial events", async () => {
    const started = await handleTool(controller, "flow_start", { admin_key: "observer-test-admin", config: {
      id: "observed-flow", initial_step: "work", roles: { worker: { backend: "fake" } },
      steps: { work: { role: "worker", prompt: "Review", on: { reported: { finish: true } } } }
    } }) as any;
    expect(started.observer.thread_id).toBe("user-thread");
    const batch = await wait(started.observer);
    expect(batch.events.map(e => e.type)).toEqual(expect.arrayContaining(["flow.started", "flow.step_started"]));
  });

  it("recovers a nested Codex caller without redundant tokens or run arguments", async () => {
    const parent = run();
    const original = observe(parent.run_id);
    const nested = controller.registerAgent({ runId: parent.run_id, backend: "codex-thread", title: "Nested executor", role: "reviewer",
      backendHandle: { thread_id: "nested-conversation" }, adminKey: "observer-test-admin" });
    vi.stubEnv("CODEX_THREAD_ID", "nested-conversation");
    const launched = await handleTool(controller, "worker_launch", { title: "Nested work", prompt: "Review", repo_dir: directory,
      backend: "fake", watch: false }) as any;
    expect(launched.run_id).toBe(parent.run_id);
    expect(launched.observer.thread_id).toBe(original.thread_id);
    expect(controller.getAgent(nested.agent_id).role).toBe("reviewer");
    expect(controller.listAgentLinks({ runId: parent.run_id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_agent_id: nested.agent_id, target_agent_id: launched.agent_id, type: "parent_child" })
    ]));
    expect(JSON.stringify(launched)).not.toMatch(/agent_token|act_/);
  });

  it("keeps a supplied requester passive when the executing host has no Codex identity", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "");
    const launched = await handleTool(controller, "worker_launch", { title: "Headless launch", prompt: "Review", repo_dir: directory,
      backend: "fake", requester_thread_id: "original-user", watch: false }) as any;
    const agents = controller.listAgents({ runId: launched.run_id });
    expect(agents.find(a => a.role === "orchestrator")?.backend).toBe("manual");
    const observer = controller.getAgent(launched.observer.observer_agent_id);
    expect(observer).toMatchObject({ role: "observer", backend_handle: { thread_id: "original-user" } });
    expect(store.db.prepare("select count(*) n from agent_tokens where agent_id = ?").get(observer.agent_id)).toEqual({ n: 0 });
  });

  it("resumes after a user interruption with events accumulated while answering another topic", async () => {
    const observation = observe(run().run_id);
    expect(observation.wait_contract).toMatchObject({ turn_policy: "keep_open_while_work_pending", tool: "run_wait",
      arguments: { run_id: observation.run_id, observer_agent_id: observation.observer_agent_id, timeout_ms: 3_600_000 } });
    expect(observation.wait_contract.arguments).not.toHaveProperty("cursor");
    const firstEvent = emit(observation.run_id, "flow.step_started", { step_id: "analysis" });
    const first = await controller.waitForRun({ runId: observation.run_id, observerAgentId: observation.observer_agent_id });
    expect(first.events.map(e => e.event_id)).toEqual([firstEvent.event_id]);
    await handleTool(controller, "run_ack", { run_id: observation.run_id, observer_agent_id: observation.observer_agent_id, cursor: first.cursor });
    const cancellation = new AbortController();
    const pending = handleTool(controller, "run_wait", first.wait_contract!.arguments, cancellation.signal);
    cancellation.abort(new Error("new user message on another topic"));
    await expect(pending).rejects.toThrow(/new user message/);
    // The model answers the user while backend events continue to be persisted.
    const duringReply = emit(observation.run_id, "flow.step_started", { step_id: "implementation" });
    const resumed = await controller.waitForRun({ runId: observation.run_id, observerAgentId: observation.observer_agent_id, timeoutMs: 3_600_000 });
    expect(resumed.events.map(e => e.event_id)).toEqual([duringReply.event_id]);
    expect(resumed.wait_contract!.arguments).not.toHaveProperty("cursor");
    await handleTool(controller, "run_ack", { run_id: observation.run_id, observer_agent_id: observation.observer_agent_id, cursor: resumed.cursor });
    const timeout = await controller.waitForRun({ runId: observation.run_id, observerAgentId: observation.observer_agent_id,
      timeoutMs: 1, intervalMs: 1 });
    expect(timeout).toMatchObject({ timed_out: true, closed: false,
      wait_contract: { arguments: { timeout_ms: 3_600_000 } } });
  });

  it("uses returned MCP launch, wait and ACK contracts without passing credentials or replaying launch events", async () => {
    adapters.register({ ...adapters.get("fake"), kind: "codex-subagent" });
    const launched = await handleTool(controller, "flow_launch", { title: "Observe the user's native flow", repo_dir: directory,
      owner_task_identity: "user-thread", owner_task_path: "/root", config: { id: "mcp-ack-flow", initial_step: "work",
        roles: { worker: { backend: "codex-subagent" } }, steps: { work: { role: "worker", prompt: "Read the accepted task",
          on: { reported: { finish: true } } } } } }) as any;
    const contract = launched.observer.wait_contract;
    expect(contract.arguments).not.toHaveProperty("cursor");
    expect(contract.arguments).not.toHaveProperty("agent_token");
    const batch = await handleTool(controller, contract.tool, { ...contract.arguments, timeout_ms: 1 }) as any;
    expect(batch.events.length).toBeGreaterThan(0);
    expect(batch.ack_contract.arguments).not.toHaveProperty("agent_token");
    const ack = await handleTool(controller, batch.ack_contract.tool, batch.ack_contract.arguments) as any;
    expect(ack.advanced).toBe(true);
    const next = await handleTool(controller, ack.wait_contract.tool, { ...ack.wait_contract.arguments, timeout_ms: 1 }) as any;
    expect(next.events).toEqual([]);
    const replay = await handleTool(controller, contract.tool, { ...contract.arguments, cursor: launched.observer.cursor, timeout_ms: 1 }) as any;
    expect(replay.events.map((event: any) => event.event_id)).toEqual(batch.events.map((event: any) => event.event_id));
  });

  it("closes only the finished observation and preserves a separate active run's wait contract", async () => {
    const first = observe(run().run_id), second = observe(run().run_id);
    for (const subscription of controller.listSubscriptions({ runId: first.run_id })) controller.deleteSubscription(subscription.subscription_id);
    expect(await wait(first)).toMatchObject({ closed: true, wait_contract: null });
    const event = emit(second.run_id, "flow.step_started", { step_id: "still-running" });
    const ongoing = await wait(second);
    expect(ongoing).toMatchObject({ closed: false, wait_contract: { tool: "run_wait", arguments: { run_id: second.run_id } } });
    expect(ongoing.events.map(e => e.event_id)).toEqual([event.event_id]);
  });

  it("automatically gives a separate executing coordinator its own action-aware observation", async () => {
    const launched = await handleTool(controller, "worker_launch", { title: "Separate executor", prompt: "Review", repo_dir: directory,
      backend: "fake", requester_thread_id: "original-requester", watch: false }) as any;
    const requester = launched.observer, coordinator = launched.coordinator_observer;
    expect(requester.thread_id).toBe("original-requester");
    expect(coordinator.thread_id).toBe("user-thread");
    expect(coordinator.observer_agent_id).not.toBe(requester.observer_agent_id);
    expect(controller.ensureRequester(launched.run_id)!.thread_id).toBe(requester.thread_id);
    const action = { action_id: "action-safe", orchestrator_agent_id: coordinator.observer_agent_id, operation: "spawn_agent", status: "pending" };
    const event = emit(launched.run_id, "flow.notification", { orchestrator_action: action });
    const ownerBatch = await wait(coordinator), userBatch = await wait(requester);
    expect(ownerBatch.closed).toBe(false);
    expect(ownerBatch.events.find(e => e.event_id === event.event_id)?.orchestrator_action).toMatchObject(action);
    expect(userBatch.events.find(e => e.event_id === event.event_id)).not.toHaveProperty("orchestrator_action");
    expect(ownerBatch.wait_contract!.arguments.observer_agent_id).toBe(coordinator.observer_agent_id);
    expect(userBatch.wait_contract!.arguments.observer_agent_id).toBe(requester.observer_agent_id);
  });

  it("keeps cross-run owner actions in separate cursors without promoting child observers", async () => {
    const owner = controller.orchestratorLogin({ title: "Parent owner", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } });
    const parentObservation = observe(owner.run.run_id, { agentToken: owner.agent_token });
    const child = controller.createRun({ title: "Child", agentToken: owner.agent_token });
    const launched = await handleTool(controller, "worker_launch", { title: "Child work", prompt: "Review", repo_dir: directory,
      backend: "fake", run_id: child.run_id, agent_token: owner.agent_token, requester_thread_id: "original-requester", watch: false }) as any;
    const observation = launched.coordinator_observer;
    expect(controller.getAgent(observation.observer_agent_id).role).toBe("observer");
    expect(observation.observer_agent_id).not.toBe(parentObservation.observer_agent_id);
    const worker = controller.listAgents({ runId: child.run_id }).find(agent => agent.backend === "fake")!;
    const other = controller.registerAgent({ runId: child.run_id, backend: "fake", title: "Other" });
    controller.createSubscription({ runId: child.run_id, sourceAgentId: worker.agent_id, subscriberAgentId: owner.agent.agent_id, eventType: "flow.notification" });
    observe(child.run_id, { agentToken: owner.agent_token, eventTypes: ["flow.completed"] });
    const action = { action_id: "child-action", orchestrator_agent_id: owner.agent.agent_id, operation: "spawn_agent", secret: "never-render" };
    emit(child.run_id, "flow.notification", { orchestrator_action: action }, other.agent_id);
    const event = emit(child.run_id, "flow.notification", { orchestrator_action: action }, worker.agent_id);
    const batch = await wait(observation, { limit: 1 });
    expect(batch.events.map(item => item.event_id)).toEqual([event.event_id]);
    expect(batch.events[0]?.orchestrator_action).toMatchObject({ action_id: "child-action", orchestrator_agent_id: owner.agent.agent_id });
    expect(JSON.stringify(batch)).not.toContain("never-render");
    expect((await wait(launched.observer)).events.every(item => !item.orchestrator_action)).toBe(true);
    await controller.drainDeliveries();
    expect(sent).not.toHaveBeenCalled();
    const parentEvent = emit(owner.run.run_id, "flow.completed");
    expect((await wait(parentObservation)).events.some(item => item.event_id === parentEvent.event_id)).toBe(true);
    store.updateAgent(owner.agent.agent_id, { unregisteredAt: new Date().toISOString() });
    observe(child.run_id, { eventTypes: [...EVENT_TYPES] });
    const afterRevocation = emit(child.run_id, "flow.notification", { orchestrator_action: action }, worker.agent_id);
    expect((await wait(observation, { cursor: batch.cursor })).events.find(item => item.event_id === afterRevocation.event_id)).not.toHaveProperty("orchestrator_action");
  });

  it("does not derive cross-run action visibility from public observer metadata", async () => {
    const owner = controller.orchestratorLogin({ title: "Owner", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "owner-thread", agent_control_role: "orchestrator" } });
    const observation = observe(owner.run.run_id);
    store.updateAgent(observation.observer_agent_id, { backendHandle: { thread_id: "owner-thread", agent_control_role: "observer",
      agent_control_observation_owner_id: owner.agent.agent_id } });
    emit(owner.run.run_id, "flow.notification", { orchestrator_action: { action_id: "private-action", orchestrator_agent_id: owner.agent.agent_id } });
    expect((await wait(observation)).events[0]).not.toHaveProperty("orchestrator_action");
  });

  it("preserves parent and existing child owner actions when their Codex thread is shared", async () => {
    const parent = controller.orchestratorLogin({ title: "Parent", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } });
    const child = controller.createRun({ title: "Child", agentToken: parent.agent_token });
    const childOwner = controller.orchestratorLogin({ title: "Child owner", runId: child.run_id,
      adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "user-thread", agent_control_role: "orchestrator" } });
    const observation = observe(child.run_id, { agentToken: parent.agent_token });
    expect(observation.observer_agent_id).toBe(childOwner.agent.agent_id);
    for (const owner of [parent.agent, childOwner.agent]) emit(child.run_id, "flow.notification", {
      orchestrator_action: { action_id: `action-${owner.agent_id}`, orchestrator_agent_id: owner.agent_id, operation: "spawn_agent" }
    });
    expect((await wait(observation)).events.map(event => event.orchestrator_action?.orchestrator_agent_id))
      .toEqual([parent.agent.agent_id, childOwner.agent.agent_id]);
  });

});
