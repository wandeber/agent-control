import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AgentController } from "../src/core/controller.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import type { AgentAdapter, AgentStatusSnapshot, EventRecord, EventType } from "../src/core/types.js";
import { handleTool } from "../src/tools/handlers.js";

describe("run control wait", () => {
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

  function gate(runId: string, owner: "requester" | "orchestrator", authority: "user" | "coordinator" = "user") {
    return emit(runId, "flow.notification", { reason: "coordinator_gate", step_id: "approval",
      decision: { key: "plan_approval", owner, authority } });
  }

  function worker(runId: string, backend = "fake") {
    return controller.registerAgent({ runId, backend, title: "Worker", status: "planned" });
  }

  it("keeps a one-hour MCP call pending through routine events and returns the requester decision", async () => {
    const observation = observe(run().run_id);
    const pending = handleTool(controller, "run_wait", observation.wait_contract.arguments);
    let returned = false;
    void pending.then(() => { returned = true; });
    for (let i = 0; i < 130; i++) emit(observation.run_id, "flow.notification", { reason: "evidence_recorded" });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(returned).toBe(false);
    const decision = gate(observation.run_id, "requester");
    const result = await pending as any;
    expect(result.events.map((event: EventRecord) => event.event_id)).toEqual([decision.event_id]);
    expect(result.events[0].decision).toEqual({ key: "plan_approval", owner: "requester", authority: "user" });
    expect(result.completion).toBeNull();
  });

  it("filters before limit=1 and ACK covers excluded activity without replaying the handled decision", async () => {
    const observation = observe(run().run_id);
    for (let i = 0; i < 130; i++) emit(observation.run_id, "artifact.updated");
    const decision = gate(observation.run_id, "requester", "coordinator");
    const result = await wait(observation, { limit: 1, timeoutMs: 1000 });
    expect(result.events.map(event => event.event_id)).toEqual([decision.event_id]);
    expect(result.events[0]?.decision).toMatchObject({ authority: "coordinator" });
    const replay = await controller.waitForRun({ runId: observation.run_id, observerAgentId: observation.observer_agent_id, timeoutMs: 1000 });
    expect(replay.events.map(event => event.event_id)).toEqual([decision.event_id]);
    const ack = await handleTool(controller, "run_ack", result.ack_contract!.arguments) as any;
    expect(ack.wait_contract.arguments.wake_on).toBe("control");
    expect(await handleTool(controller, "run_wait", { ...ack.wait_contract.arguments, timeout_ms: 5 }))
      .toMatchObject({ events: [], timed_out: true, completion: null });
  });

  it("routes coordinator events separately while preserving requester-owned coordinator decisions", async () => {
    const owner = controller.orchestratorLogin({ title: "Executor", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "executor-thread" } });
    const requester = observe(owner.run.run_id);
    const executor = observe(owner.run.run_id, { threadId: "executor-thread", agentToken: owner.agent_token });
    const userGate = gate(owner.run.run_id, "requester", "coordinator");
    const executorGate = gate(owner.run.run_id, "orchestrator", "coordinator");
    const done = emit(owner.run.run_id, "agent.completed");
    expect((await wait(requester)).events.map(event => event.event_id)).toEqual([userGate.event_id]);
    expect((await wait(executor)).events.map(event => event.event_id)).toEqual([executorGate.event_id, done.event_id]);
  });

  it("does not complete a run until both workers have settled, including an imported session", async () => {
    adapters.register({ ...adapters.get("fake"), kind: "codex-session" });
    const observation = observe(run().run_id);
    const first = worker(observation.run_id), second = worker(observation.run_id, "codex-session");
    store.updateAgent(first.agent_id, { status: "completed" });
    emit(observation.run_id, "agent.completed", {}, first.agent_id);
    expect(await wait(observation)).toMatchObject({ events: [], completion: null, timed_out: true });
    status = { status: "completed" };
    store.updateAgent(second.agent_id, { status: "completed", backendHandle: { thread_id: "external-session" } });
    const result = await wait(observation);
    expect(result.completion).toEqual({ outcome: "completed", worker_count: 2, flow_count: 0, run_count: 1 });
    expect(result.closed).toBe(false);
  });

  it("keeps blocked work unresolved and distinguishes failed and cancelled outcomes", async () => {
    const observation = observe(run().run_id), task = worker(observation.run_id);
    store.updateAgent(task.agent_id, { status: "blocked" });
    emit(observation.run_id, "agent.blocked", {}, task.agent_id);
    expect((await wait(observation)).completion).toBeNull();
    store.updateAgent(task.agent_id, { status: "failed" });
    expect((await wait(observation)).completion?.outcome).toBe("failed");
    store.updateAgent(task.agent_id, { status: "stopped" });
    expect((await wait(observation)).completion?.outcome).toBe("cancelled");
  });

  it("does not finish an empty run or a parent with a pending child", async () => {
    const observation = observe(run().run_id);
    expect((await wait(observation)).completion).toBeNull();
    const parent = worker(observation.run_id);
    store.updateAgent(parent.agent_id, { status: "completed" });
    const child = controller.createRun({ title: "Child", agentToken: parent.agent_token });
    expect((await wait(observation)).completion).toBeNull();
    const childWorker = worker(child.run_id);
    expect((await wait(observation)).completion).toBeNull();
    store.updateAgent(childWorker.agent_id, { status: "completed" });
    expect((await wait(observation)).completion).toMatchObject({ outcome: "completed", run_count: 2, worker_count: 2 });
  });

  it("waits for every flow and ignores only unused roles belonging to finished flows", async () => {
    const observation = observe(run().run_id);
    const start = (id: string) => controller.startFlow({ runId: observation.run_id, adminKey: "observer-test-admin", config: {
      id, initial_step: "work", roles: { worker: { backend: "fake" } },
      steps: { work: { role: "worker", prompt: "Read only", on: { reported: { finish: true } } } }
    } });
    const first = start("first"), second = start("second");
    store.updateFlowInstance(first.instance.flow_instance_id, { status: "completed", currentStepId: null });
    emit(observation.run_id, "flow.completed", { flow_instance_id: first.instance.flow_instance_id });
    expect((await wait(observation)).completion).toBeNull();
    store.updateFlowInstance(second.instance.flow_instance_id, { status: "completed", currentStepId: null });
    expect((await wait(observation)).completion).toMatchObject({ outcome: "completed", flow_count: 2 });
    worker(observation.run_id);
    expect((await wait(observation)).completion).toBeNull();
  });

  it("recovers an existing requester gate on late attachment and suppresses obsolete generations", async () => {
    const owner = controller.orchestratorLogin({ title: "Executor", adminKey: "observer-test-admin", backend: "codex-thread",
      backendHandle: { thread_id: "executor-thread" } });
    const started = controller.startFlow({ runId: owner.run.run_id, agentToken: owner.agent_token, requesterThreadId: "user-thread", config: {
      id: "gated", initial_step: "approve", roles: { coordinator: { backend: "manual" } },
      steps: { approve: { role: "coordinator", execution: "coordinator", decision: { key: "approval", owner: "requester", authority: "user" },
        on: { reported: { finish: true } } } }
    } });
    const original = started.observer!;
    // Simulate a conversation that was not attached until after the gate was recorded.
    store.db.prepare("delete from run_observers where observer_agent_id = ?").run(original.observer_agent_id);
    const late = observe(owner.run.run_id);
    const result = await wait(late);
    expect(result.events.some(event => event.decision?.key === "approval")).toBe(true);
    store.updateFlowStepInstance(started.active_step!.step_instance_id, { status: "completed" });
    expect((await wait(late)).events.some(event => event.decision)).toBe(false);
  });

  it("cancels promptly during a slow backend read, then resumes without stopping work or consuming events", async () => {
    let release!: (status: AgentStatusSnapshot) => void;
    const reading = new Promise<AgentStatusSnapshot>(resolve => { release = resolve; });
    const getStatus = vi.fn(() => reading);
    adapters.register({ ...adapters.get("fake"), getStatus });
    const observation = observe(run().run_id), task = worker(observation.run_id);
    store.updateAgent(task.agent_id, { status: "running", backendHandle: { id: "external" } });
    const abort = new AbortController();
    const pending = controller.waitForRun({ runId: observation.run_id, observerAgentId: observation.observer_agent_id,
      timeoutMs: 3_600_000, signal: abort.signal });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(getStatus).toHaveBeenCalledTimes(1);
    abort.abort(new Error("User asks another question"));
    await expect(pending).rejects.toThrow("User asks another question");
    const decision = gate(observation.run_id, "requester");
    release({ status: "running" });
    expect((await wait(observation)).events.map(event => event.event_id)).toEqual([decision.event_id]);
    expect(stopped).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });

  it("preserves an explicit all policy through delivered ACK and next wait", async () => {
    const observation = observe(run().run_id);
    const event = emit(observation.run_id, "agent.completed");
    const first = await wait(observation, { wakeOn: "all" });
    expect(first.events.map(item => item.event_id)).toEqual([event.event_id]);
    const ack = await handleTool(controller, "run_ack", first.ack_contract!.arguments) as any;
    expect(ack.wait_contract.arguments.wake_on).toBe("all");
    const next = emit(observation.run_id, "artifact.updated");
    const result = await handleTool(controller, "run_wait", ack.wait_contract.arguments) as any;
    expect(result.events.map((item: EventRecord) => item.event_id)).toEqual([next.event_id]);
  });
  it("delivers nested requester gates and blockers to the original wait with their source run", async () => {
    const observation = observe(run().run_id), parent = worker(observation.run_id);
    const child = controller.createRun({ title: "Child", agentToken: parent.agent_token });
    const attached = observe(child.run_id);
    const decision = gate(child.run_id, "requester");
    const result = await wait(observation);
    expect(result.events).toEqual([expect.objectContaining({ event_id: decision.event_id, run_id: child.run_id })]);
    await handleTool(controller, "run_ack", result.ack_contract!.arguments);
    const blocked = emit(child.run_id, "flow.step_blocked");
    const next = await controller.waitForRun({ runId: observation.run_id, observerAgentId: observation.observer_agent_id, timeoutMs: 20 });
    expect(next.events.map(item => item.event_id)).toEqual([blocked.event_id]);
    expect(attached.observer_agent_id).not.toBe(observation.observer_agent_id);
  });

  it("does not expose another conversation's child subscription", async () => {
    const observation = observe(run().run_id), parent = worker(observation.run_id);
    const child = controller.createRun({ title: "Child", agentToken: parent.agent_token });
    observe(child.run_id, { threadId: "another-conversation" });
    gate(child.run_id, "requester");
    expect((await wait(observation)).events).toEqual([]);
  });

  it("completes a coordinator-only parent whose actual work is all in children", async () => {
    const owner = controller.orchestratorLogin({ title: "Executor", adminKey: "observer-test-admin" });
    const observation = observe(owner.run.run_id);
    const child = controller.createRun({ title: "Child", agentToken: owner.agent_token });
    const task = worker(child.run_id);
    store.updateAgent(task.agent_id, { status: "completed" });
    expect((await wait(observation)).completion).toMatchObject({ outcome: "completed", run_count: 2, worker_count: 1 });
  });

  it("does not hide an ad hoc blocker because an unrelated flow is active", async () => {
    const observation = observe(run().run_id), task = worker(observation.run_id);
    controller.startFlow({ runId: observation.run_id, adminKey: "observer-test-admin", config: {
      id: "unrelated", initial_step: "work", roles: { worker: { backend: "fake" } },
      steps: { work: { role: "worker", prompt: "Read", on: { reported: { finish: true } } } }
    } });
    store.updateAgent(task.agent_id, { status: "blocked" });
    const blocker = emit(observation.run_id, "agent.blocked", {}, task.agent_id);
    expect((await wait(observation)).events.map(event => event.event_id)).toEqual([blocker.event_id]);
  });

  it("drains all requested worker completions before returning aggregate completion", async () => {
    const observation = observe(run().run_id);
    for (let i = 0; i < 4; i++) {
      const task = worker(observation.run_id);
      store.updateAgent(task.agent_id, { status: "completed" });
      emit(observation.run_id, "agent.completed", {}, task.agent_id);
    }
    for (let i = 0; i < 4; i++) {
      const result = await controller.waitForRun({ runId: observation.run_id, observerAgentId: observation.observer_agent_id,
        wakeOn: "all", limit: 1, timeoutMs: 1000 });
      expect(result.events).toHaveLength(1);
      expect(result.completion?.outcome ?? null).toBe(i === 3 ? "completed" : null);
      await handleTool(controller, "run_ack", result.ack_contract!.arguments);
    }
  });

  it("refreshes an imported terminal session before declaring completion", async () => {
    adapters.register({ ...adapters.get("fake"), kind: "codex-session" });
    const observation = observe(run().run_id), task = worker(observation.run_id, "codex-session");
    store.updateAgent(task.agent_id, { status: "completed", backendHandle: { thread_id: "external-session" } });
    status = { status: "running" };
    const result = await wait(observation);
    expect(result).toMatchObject({ completion: null, timed_out: true });
    expect(store.getAgent(task.agent_id)?.status).toBe("running");
  });

  it("wakes when an independent worker needs input and leaves the work pending", async () => {
    const observation = observe(run().run_id), task = worker(observation.run_id);
    store.updateAgent(task.agent_id, { status: "waiting_for_input" });
    const event = emit(observation.run_id, "agent.status_changed", { status: "waiting_for_input" }, task.agent_id);
    const result = await wait(observation);
    expect(result.events.map(item => item.event_id)).toEqual([event.event_id]);
    expect(result.completion).toBeNull();
  });

  it("does not validate a replacement session with a discarded old-handle read", async () => {
    let release!: (snapshot: AgentStatusSnapshot) => void;
    const firstRead = new Promise<AgentStatusSnapshot>(resolve => { release = resolve; });
    const getStatus = vi.fn().mockReturnValueOnce(firstRead).mockResolvedValue({ status: "running" });
    adapters.register({ ...adapters.get("fake"), kind: "codex-session", getStatus });
    const observation = observe(run().run_id), task = worker(observation.run_id, "codex-session");
    store.updateAgent(task.agent_id, { status: "completed", backendHandle: { thread_id: "old-session" } });
    const pending = wait(observation, { timeoutMs: 50 });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(getStatus).toHaveBeenCalledTimes(1);
    store.updateAgent(task.agent_id, { backendHandle: { thread_id: "replacement-session" } });
    release({ status: "completed" });
    expect(await pending).toMatchObject({ completion: null, timed_out: true });
    expect(getStatus.mock.calls.length).toBeGreaterThan(1);
    expect(store.getAgent(task.agent_id)?.status).toBe("running");
  });

});
