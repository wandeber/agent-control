import { ControllerError } from "../src/core/errors.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexSubagentAdapter } from "../src/adapters/codex-subagent-adapter.js";
import { CodexCliAdapter } from "../src/adapters/codex-cli-adapter.js";
import { ManualAdapter } from "../src/adapters/manual-adapter.js";
import { OpenCodeServerAdapter } from "../src/adapters/opencode-server-adapter.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { AgentController, buildGoalConfirmationPrompt } from "../src/core/controller.js";
import { resolveAdminKey } from "../src/core/identity.js";
import { agentRuntimePath, runRuntimePath } from "../src/core/paths.js";
import { handleTool } from "../src/tools/handlers.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHandle,
  AgentMessage,
  AgentMessageInput,
  AgentStatus,
  AgentStatusSnapshot,
  EventRecord,
  ReadLatestOptions,
  StartAgentInput,
  StopOptions,
  StopResult
} from "../src/core/types.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

const CAPABILITIES: AgentCapabilities = {
  canStart: true,
  canSendMessage: true,
  canReadLatest: true,
  canStopGracefully: true,
  canForceStop: true,
  canStreamMessages: false,
  canInspectStatusCheaply: true,
  canAttachExisting: true
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeAdapter implements AgentAdapter {
  readonly sent: Array<{ handle: AgentHandle; message: string; metadata?: Record<string, unknown> }> = [];
  readonly starts: StartAgentInput[] = [];
  readonly stopped: AgentHandle[] = [];
  readonly statuses = new Map<string, AgentStatus>();
  stopStatus: AgentStatus = "stopped";
  statusError: Error | null = null;

  constructor(readonly kind = "fake") {}

  capabilities(): AgentCapabilities {
    return CAPABILITIES;
  }

  async start(input: StartAgentInput): Promise<AgentHandle> {
    this.starts.push(input);
    this.statuses.set(input.agent.agent_id, "running");
    return {
      backend: this.kind,
      id: input.agent.agent_id,
      data: { id: input.agent.agent_id }
    };
  }

  async sendMessage(handle: AgentHandle, message: AgentMessageInput): Promise<void> {
    this.sent.push({ handle, message: message.message, metadata: message.metadata });
  }

  async getStatus(handle: AgentHandle): Promise<AgentStatusSnapshot> {
    if (this.statusError) {
      throw this.statusError;
    }
    return {
      status: this.statuses.get(handle.id) ?? "running"
    };
  }

  async readLatest(handle: AgentHandle, _options: ReadLatestOptions): Promise<AgentMessage[]> {
    return [
      {
        id: "message-1",
        role: "assistant",
        text: `latest from ${handle.id}`,
        created_at: new Date().toISOString()
      }
    ];
  }

  async stop(handle: AgentHandle, _options: StopOptions): Promise<StopResult> {
    this.stopped.push(handle);
    this.statuses.set(handle.id, this.stopStatus);
    return { status: this.stopStatus, data: { id: handle.id } };
  }
}

class DeferredFakeAdapter extends FakeAdapter {
  startGate: ReturnType<typeof createDeferred<void>> | null = null;
  startErrorAfterAccept: Error | null = null;
  stopGate: ReturnType<typeof createDeferred<void>> | null = null;
  statusGate: ReturnType<typeof createDeferred<void>> | null = null;
  statusReads = 0;
  sendGate: ReturnType<typeof createDeferred<void>> | null = null;
  sendErrorAfterAccept: Error | null = null;
  sendGates: Array<ReturnType<typeof createDeferred<void>> | null> = [];
  sendErrorsAfterAccept: Array<Error | null> = [];
  stopErrorAtCall: number | null = null;

  override async start(input: StartAgentInput): Promise<AgentHandle> {
    this.starts.push(input);
    if (this.startGate) {
      await this.startGate.promise;
    }
    this.statuses.set(input.agent.agent_id, "running");
    if (this.startErrorAfterAccept) {
      throw this.startErrorAfterAccept;
    }
    return {
      backend: this.kind,
      id: input.agent.agent_id,
      data: { id: input.agent.agent_id, late_start: Boolean(this.startGate) }
    };
  }

  override async sendMessage(handle: AgentHandle, message: AgentMessageInput): Promise<void> {
    const attemptIndex = this.sent.length;
    this.sent.push({ handle, message: message.message, metadata: message.metadata });
    const attemptGate = attemptIndex < this.sendGates.length
      ? this.sendGates[attemptIndex]
      : this.sendGate;
    if (attemptGate) {
      await attemptGate.promise;
    }
    // Model backends where accepting a message revives the same session. This
    // makes a send that resolves after shutdown require a second, compensating
    // stop rather than only preserving the logical database projection.
    this.statuses.set(handle.id, "running");
    const attemptError = attemptIndex < this.sendErrorsAfterAccept.length
      ? this.sendErrorsAfterAccept[attemptIndex]
      : this.sendErrorAfterAccept;
    if (attemptError) {
      throw attemptError;
    }
  }

  override async getStatus(handle: AgentHandle): Promise<AgentStatusSnapshot> {
    this.statusReads += 1;
    // Capture both successful and failed observations before the gate. Tests
    // can then advance the same backend session to a newer work generation
    // while an objectively stale result remains in flight.
    const observation = super.getStatus(handle).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    );
    if (this.statusGate) {
      await this.statusGate.promise;
    }
    const captured = await observation;
    if (captured.error) {
      throw captured.error;
    }
    return captured.value!;
  }

  override async stop(handle: AgentHandle, options: StopOptions): Promise<StopResult> {
    if (this.stopErrorAtCall === this.stopped.length + 1) {
      this.stopped.push(handle);
      throw new Error("Deferred adapter compensating stop failed.");
    }
    if (this.stopGate) {
      this.stopped.push(handle);
      await this.stopGate.promise;
      this.statuses.set(handle.id, this.stopStatus);
      return { status: this.stopStatus, data: { id: handle.id } };
    }
    return super.stop(handle, options);
  }
}

class NoopWatchingDeferredFakeAdapter extends DeferredFakeAdapter {
  override watchStatus(
    _handle: AgentHandle,
    _onChange: (snapshot: AgentStatusSnapshot) => void | Promise<void>
  ): () => void {
    // Cross-controller tests need the watcher registration path without real
    // timers retaining a secondary SQLite connection after the assertion.
    return () => undefined;
  }
}

class FakeCodexThreadAdapter extends FakeAdapter {
  constructor() {
    super("codex-thread");
  }

  override async start(input: StartAgentInput): Promise<AgentHandle> {
    this.starts.push(input);
    this.statuses.set(input.agent.agent_id, "running");
    const threadId = `thread_${input.agent.agent_id}`;
    return {
      backend: this.kind,
      id: threadId,
      data: { thread_id: threadId }
    };
  }
}

describe("AgentController", () => {
  let tmp: string;
  let store: SqliteStore;
  let adapter: FakeAdapter;
  let registry: AdapterRegistry;
  let controller: AgentController;
  let oldControlHome: string | undefined;
  let oldAdminKey: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-control-test-"));
    oldControlHome = process.env.AGENT_CONTROL_HOME;
    oldAdminKey = process.env.AGENT_CONTROL_ADMIN_KEY;
    process.env.AGENT_CONTROL_HOME = join(tmp, "home");
    delete process.env.AGENT_CONTROL_ADMIN_KEY;
    store = new SqliteStore(join(tmp, "state.sqlite"));
    adapter = new FakeAdapter();
    registry = new AdapterRegistry();
    registry.register(adapter);
    controller = new AgentController(store, registry);
  });

  afterEach(async () => {
    await controller.dispose();
    vi.restoreAllMocks();
    store.close();
    if (oldControlHome === undefined) {
      delete process.env.AGENT_CONTROL_HOME;
    } else {
      process.env.AGENT_CONTROL_HOME = oldControlHome;
    }
    if (oldAdminKey === undefined) {
      delete process.env.AGENT_CONTROL_ADMIN_KEY;
    } else {
      process.env.AGENT_CONTROL_ADMIN_KEY = oldAdminKey;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("generates a persistent local admin key when no env override exists", () => {
    const first = resolveAdminKey();
    const second = resolveAdminKey();

    expect(first).toMatch(/^ack_/);
    expect(second).toBe(first);
  });

  it("uses the admin key env override when present", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_test_admin";

    expect(resolveAdminKey()).toBe("ack_test_admin");
  });

  it("migrates legacy agent rows with zeroed work observation fences", () => {
    const legacyPath = join(tmp, "legacy-work-generation.sqlite");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      create table runs (
        run_id text primary key,
        title text not null,
        repo_dir text,
        parent_run_id text,
        created_by_agent_id text,
        status text not null,
        created_at text not null,
        updated_at text not null
      );
      create table agents (
        agent_id text primary key,
        run_id text not null references runs(run_id) on delete cascade,
        backend text not null,
        title text not null,
        role text,
        objective text,
        repo_dir text,
        model text,
        backend_handle_json text,
        status text not null,
        failure_reason text,
        unregistered_at text,
        created_at text not null,
        updated_at text not null
      );
      insert into runs values (
        'run_legacy_generation', 'Legacy generation', null, null, null,
        'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      insert into agents values (
        'agent_legacy_generation', 'run_legacy_generation', 'fake', 'Legacy worker',
        null, null, null, null, '{"id":"legacy-worker"}', 'unknown', 'unknown', null,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      create table agent_work_acceptances (
        acceptance_key text primary key,
        agent_id text not null references agents(agent_id) on delete cascade,
        work_generation integer not null,
        created_at text not null
      );
      insert into agent_work_acceptances values (
        'legacy-acceptance', 'agent_legacy_generation', 0,
        '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = new SqliteStore(legacyPath);
    expect(migrated.getAgent("agent_legacy_generation")).toMatchObject({
      work_generation: 0,
      work_revision: 0,
      status: "unknown",
      failure_reason: "unknown"
    });
    const lifecycleColumns = migrated.db.prepare("pragma table_info(agents)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
    expect(lifecycleColumns.find((column) => column.name === "work_generation")).toMatchObject({
      notnull: 1,
      dflt_value: "0"
    });
    expect(lifecycleColumns.find((column) => column.name === "work_revision")).toMatchObject({
      notnull: 1,
      dflt_value: "0"
    });
    expect(
      migrated.db
        .prepare(
          "select name from sqlite_master where type = 'table' and name = 'subscription_deliveries'"
        )
        .get()
    ).toMatchObject({ name: "subscription_deliveries" });
    expect(
      migrated.db
        .prepare(
          `select attempt_revision, phase, completion_revision, updated_at, completed_at
           from agent_work_acceptances where acceptance_key = 'legacy-acceptance'`
        )
        .get()
    ).toMatchObject({
      attempt_revision: 0,
      phase: "ambiguous",
      completion_revision: 0,
      updated_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:00.000Z"
    });
    expect(
      migrated.agentHasAmbiguousAcceptedWork("agent_legacy_generation", 0)
    ).toBe(true);
    migrated.close();
  });

  it("logs in an orchestrator with an admin key and returns a usable agent token", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_login_test";

    const result = controller.orchestratorLogin({
      adminKey: "ack_login_test",
      title: "Root orchestration",
      repoDir: "/repo",
      backend: "fake"
    });
    const resolved = controller.requireAgentToken(result.agent_token);

    expect(result.run.parent_run_id).toBeNull();
    expect(result.run.created_by_agent_id).toBeNull();
    expect(result.agent.role).toBe("orchestrator");
    expect(resolved.agent_id).toBe(result.agent.agent_id);
  });

  it("reuses an existing orchestrator login for the same run and Codex thread handle", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_login_reuse_test";
    const backendHandle = {
      thread_id: "thread_123",
      agent_control_role: "orchestrator",
      cwd: "/repo"
    };

    const first = controller.orchestratorLogin({
      adminKey: "ack_login_reuse_test",
      title: "Reusable orchestrator",
      repoDir: "/repo",
      backend: "fake",
      backendHandle
    });
    const second = controller.orchestratorLogin({
      adminKey: "ack_login_reuse_test",
      title: "Reusable orchestrator",
      repoDir: "/repo",
      runId: first.run.run_id,
      backend: "fake",
      backendHandle
    });

    expect(second.run.run_id).toBe(first.run.run_id);
    expect(second.agent.agent_id).toBe(first.agent.agent_id);
    expect(controller.requireAgentToken(second.agent_token).agent_id).toBe(first.agent.agent_id);
    expect(controller.listAgents({ runId: first.run.run_id }).filter((agent) => agent.role === "orchestrator")).toHaveLength(1);
  });

  it("registers same-run children from the caller token and creates the hierarchy link", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_parent_child_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_parent_child_test",
      title: "Parent orchestration",
      backend: "fake"
    });

    const worker = controller.registerAgent({
      agentToken: login.agent_token,
      backend: "fake",
      title: "Implementation worker",
      role: "implementer"
    });
    const links = controller.listAgentLinks({ runId: login.run.run_id });

    expect(worker.run_id).toBe(login.run.run_id);
    expect(worker.agent_token).toMatch(/^act_/);
    expect(links).toMatchObject([
      {
        source_agent_id: login.agent.agent_id,
        target_agent_id: worker.agent_id,
        type: "parent_child",
        label: "implementer"
      }
    ]);
  });

  it("creates child runs from agent tokens and scopes run listing to accessible descendants", () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_child_run_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_child_run_test",
      title: "Root run",
      backend: "fake"
    });
    const child = controller.createRun({
      title: "Child run",
      repoDir: "/repo/child",
      agentToken: login.agent_token
    });
    const siblingAgent = controller.registerAgent({
      runId: login.run.run_id,
      backend: "fake",
      title: "Sibling agent"
    });
    const siblingChild = controller.createRun({
      title: "Sibling child run",
      agentToken: siblingAgent.agent_token
    });
    const unrelated = controller.createRun({ title: "Unrelated run" });

    const visible = controller.listRuns(50, { agentToken: login.agent_token }).map((run) => run.run_id);
    const siblingVisible = controller.listRuns(50, { agentToken: siblingAgent.agent_token }).map((run) => run.run_id);

    expect(child.parent_run_id).toBe(login.run.run_id);
    expect(child.created_by_agent_id).toBe(login.agent.agent_id);
    expect(visible).toContain(login.run.run_id);
    expect(visible).toContain(child.run_id);
    expect(visible).not.toContain(siblingChild.run_id);
    expect(siblingVisible).toContain(login.run.run_id);
    expect(siblingVisible).toContain(siblingChild.run_id);
    expect(siblingVisible).not.toContain(child.run_id);
    expect(visible).not.toContain(unrelated.run_id);
  });

  it("injects a fresh worker token into adapter start inputs", async () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_start_token_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_start_token_test",
      title: "Token run",
      backend: "fake"
    });
    const worker = controller.registerAgent({
      agentToken: login.agent_token,
      backend: "fake",
      title: "Worker"
    });

    const started = await controller.startAgent({
      agentId: worker.agent_id,
      prompt: "do work",
      agentToken: login.agent_token
    });

    expect(adapter.starts[0]?.agentToken).toBe(started.agent_token);
    expect(controller.requireAgentToken(started.agent_token).agent_id).toBe(worker.agent_id);
  });

  it("creates runs and registers agents", () => {
    const run = controller.createRun({ title: "test run", repoDir: "/repo" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      role: "implementer",
      backendHandle: { id: "attached-thread" },
      status: "running"
    });

    expect(agent.status).toBe("running");
    expect(agent.backend_handle?.id).toBe("attached-thread");
    expect(controller.listAgents({ runId: run.run_id })).toHaveLength(1);
  });

  it("starts an agent and records lifecycle events", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker"
    });

    const started = await controller.startAgent({ agentId: agent.agent_id, prompt: "do work" });
    const events = controller.listEvents({ runId: run.run_id });

    expect(started.status).toBe("running");
    expect(events.some((event) => event.type === "agent.started")).toBe(true);
  });

  it("does not fail a starting agent before its backend handle is stored", async () => {
    const run = controller.createRun({ title: "starting race run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "starting worker",
      status: "starting"
    });

    const refreshed = await controller.refreshAgentStatus(agent.agent_id);
    const events = controller.listEvents({ runId: run.run_id });

    expect(refreshed.status).toBe("starting");
    expect(events.some((event) => event.type === "agent.failed")).toBe(false);
  });

  it("marks an existing agent running when a follow-up message is delivered", async () => {
    const run = controller.createRun({ title: "follow-up run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "follow-up worker",
      backendHandle: { id: "attached-worker" },
      status: "completed"
    });

    const result = await controller.sendMessage(agent.agent_id, "continue");
    const events = controller.listEvents({ runId: run.run_id });

    expect(result.delivered).toBe(true);
    expect(result.agent.status).toBe("running");
    expect(controller.getAgent(agent.agent_id).status).toBe("running");
    expect(adapter.sent.at(-1)).toMatchObject({
      message: "continue"
    });
    expect(events.some((event) => event.type === "agent.message")).toBe(true);
  });

  it("rejects unsupported direct messages before projecting or fencing work", async () => {
    registry.register(new ManualAdapter());
    const run = controller.createRun({ title: "Unsupported direct message" });
    const manual = controller.registerAgent({
      runId: run.run_id,
      backend: "manual",
      title: "manual participant",
      backendHandle: { id: "manual-participant", status: "completed" },
      status: "completed"
    });

    await expect(
      controller.sendMessage(manual.agent_id, "This backend cannot receive work.")
    ).rejects.toMatchObject({ reason: "unsupported_operation" });

    expect(controller.getAgent(manual.agent_id)).toMatchObject({
      status: "completed",
      failure_reason: null,
      work_generation: 0,
      work_revision: 0
    });
    expect(
      store.db
        .prepare("select count(*) as count from agent_work_acceptances where agent_id = ?")
        .get(manual.agent_id)
    ).toMatchObject({ count: 0 });
    expect(controller.listEvents({ agentId: manual.agent_id, type: "agent.message" })).toEqual([]);
  });

  it("does not emit repeated status changes when only missing failure reason normalization differs", async () => {
    const run = controller.createRun({ title: "stable status run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "stable worker",
      backendHandle: { id: "stable-worker" },
      status: "running"
    });

    await controller.refreshAgentStatus(agent.agent_id);
    await controller.refreshAgentStatus(agent.agent_id);
    const statusEvents = controller.listEvents({ runId: run.run_id }).filter((event) => event.type === "agent.status_changed");

    expect(statusEvents).toHaveLength(0);
  });

  it("discards stale same-handle status results and errors after newer work", async () => {
    const deferredAdapter = new DeferredFakeAdapter();
    adapter = deferredAdapter;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Same-handle refresh generation fence" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "generation-fenced worker",
      backendHandle: { id: "generation-fenced-worker" },
      status: "running"
    });
    expect(worker.work_generation).toBe(0);

    deferredAdapter.statuses.set("generation-fenced-worker", "completed");
    const completedGate = createDeferred<void>();
    deferredAdapter.statusGate = completedGate;
    const staleCompleted = controller.refreshAgentStatus(worker.agent_id);
    expect(deferredAdapter.statusReads).toBe(1);

    const firstTurn = await controller.sendMessage(worker.agent_id, "Begin a newer turn.");
    expect(firstTurn.agent).toMatchObject({ status: "running", work_generation: 1 });
    completedGate.resolve();
    await expect(staleCompleted).resolves.toMatchObject({
      status: "running",
      work_generation: 1
    });
    expect(
      controller.listEvents({ agentId: worker.agent_id, type: "agent.completed" })
    ).toEqual([]);

    const errorGate = createDeferred<void>();
    deferredAdapter.statusGate = errorGate;
    deferredAdapter.statusError = new Error("Captured status failure from the previous turn.");
    const staleError = controller.refreshAgentStatus(worker.agent_id);
    expect(deferredAdapter.statusReads).toBe(2);

    const secondTurn = await controller.sendMessage(worker.agent_id, "Begin one more turn.");
    expect(secondTurn.agent).toMatchObject({ status: "running", work_generation: 2 });
    // The adapter observation already captured the error; clearing the live
    // backend state now models a healthy current generation.
    deferredAdapter.statusError = null;
    deferredAdapter.statuses.set("generation-fenced-worker", "running");
    errorGate.resolve();
    await expect(staleError).resolves.toMatchObject({
      status: "running",
      work_generation: 2
    });
    expect(controller.listEvents({ agentId: worker.agent_id, type: "agent.failed" })).toEqual([]);
    expect(
      (controller as unknown as { statusWatchers: Map<string, unknown> }).statusWatchers.has(
        worker.agent_id
      )
    ).toBe(true);

    controller.createHeartbeat({ agentId: worker.agent_id, idleTimeoutMs: 60_000 });
    await controller.checkHeartbeats();
    expect(controller.getAgent(worker.agent_id).work_generation).toBe(2);
    await controller.stopAgent(worker.agent_id);
    expect(controller.getAgent(worker.agent_id).work_generation).toBe(2);
  });

  it("discards a refresh captured during the same successful direct-send attempt", async () => {
    const deferredAdapter = new DeferredFakeAdapter("same-attempt-success-fake");
    registry.register(deferredAdapter);
    const sendGate = createDeferred<void>();
    deferredAdapter.sendGate = sendGate;
    const run = controller.createRun({ title: "Same-attempt successful send refresh" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "same-attempt successful worker",
      backendHandle: { id: "same-attempt-success-worker" },
      status: "completed"
    });

    const send = controller.sendMessage(worker.agent_id, "Accept this physical attempt.");
    expect(deferredAdapter.sent).toHaveLength(1);
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "running",
      work_generation: 1,
      work_revision: 1
    });

    // This observation begins after the generation fence, but before the
    // adapter response closes the physical attempt.
    deferredAdapter.statuses.set("same-attempt-success-worker", "completed");
    const statusGate = createDeferred<void>();
    deferredAdapter.statusGate = statusGate;
    const staleRefresh = controller.refreshAgentStatus(worker.agent_id);
    expect(deferredAdapter.statusReads).toBe(1);

    sendGate.resolve();
    await expect(send).resolves.toMatchObject({
      delivered: true,
      agent: { status: "running", work_generation: 1, work_revision: 2 }
    });
    statusGate.resolve();
    await expect(staleRefresh).resolves.toMatchObject({
      status: "running",
      work_generation: 1,
      work_revision: 2
    });
    expect(controller.listEvents({ agentId: worker.agent_id, type: "agent.completed" })).toEqual([]);
    expect(
      (controller as unknown as { statusWatchers: Map<string, unknown> }).statusWatchers.has(
        worker.agent_id
      )
    ).toBe(true);

    deferredAdapter.statusGate = null;
    await controller.stopAgent(worker.agent_id);
  });

  it("defers a terminal refresh that finishes before direct-send I/O and preserves a later stop", async () => {
    const deferredAdapter = new DeferredFakeAdapter("invoking-refresh-success-fake");
    registry.register(deferredAdapter);
    const sendGate = createDeferred<void>();
    deferredAdapter.sendGate = sendGate;
    const run = controller.createRun({ title: "Invoking send terminal refresh" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "invoking terminal-refresh worker",
      backendHandle: { id: "invoking-terminal-refresh-worker" },
      status: "running"
    });

    const send = controller.sendMessage(worker.agent_id, "Keep this invocation pending.");
    expect(deferredAdapter.sent).toHaveLength(1);
    deferredAdapter.statuses.set("invoking-terminal-refresh-worker", "completed");

    // The status call finishes while the adapter send is still gated. A
    // terminal projection here would make stopAgent treat this worker as
    // already done, skip physical cleanup, and let the later send revive it.
    await expect(controller.refreshAgentStatus(worker.agent_id)).resolves.toMatchObject({
      status: "running",
      work_generation: 1,
      work_revision: 1
    });
    expect(controller.listEvents({ agentId: worker.agent_id, type: "agent.completed" })).toEqual([]);

    await expect(controller.stopAgent(worker.agent_id)).resolves.toMatchObject({
      status: "stopped",
      work_generation: 1,
      work_revision: 1
    });
    expect(deferredAdapter.stopped).toHaveLength(1);

    sendGate.resolve();
    await expect(send).resolves.toMatchObject({
      delivered: true,
      agent: { status: "stopped", work_generation: 1, work_revision: 2 }
    });
    expect(deferredAdapter.stopped).toHaveLength(2);
    expect(deferredAdapter.statuses.get("invoking-terminal-refresh-worker")).toBe("stopped");
    expect(controller.getAgent(worker.agent_id).status).toBe("stopped");
  });

  it("defers a refresh error that finishes before direct-send I/O", async () => {
    const deferredAdapter = new DeferredFakeAdapter("invoking-refresh-error-fake");
    registry.register(deferredAdapter);
    const sendGate = createDeferred<void>();
    deferredAdapter.sendGate = sendGate;
    const run = controller.createRun({ title: "Invoking send refresh error" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "invoking refresh-error worker",
      backendHandle: { id: "invoking-refresh-error-worker" },
      status: "running"
    });

    const send = controller.sendMessage(worker.agent_id, "Keep this error-path invocation pending.");
    deferredAdapter.statusError = new Error("Status inspection failed during adapter I/O.");
    await expect(controller.refreshAgentStatus(worker.agent_id)).resolves.toMatchObject({
      status: "running",
      failure_reason: null,
      work_generation: 1,
      work_revision: 1
    });
    expect(controller.listEvents({ agentId: worker.agent_id, type: "agent.failed" })).toEqual([]);

    deferredAdapter.statusError = null;
    sendGate.resolve();
    await expect(send).resolves.toMatchObject({
      delivered: true,
      agent: { status: "running", work_generation: 1, work_revision: 2 }
    });
    await controller.stopAgent(worker.agent_id);
  });

  it("keeps same-attempt ambiguous work inspectable through refresh failure and recovery", async () => {
    const deferredAdapter = new DeferredFakeAdapter("same-attempt-ambiguous-fake");
    registry.register(deferredAdapter);
    const sendGate = createDeferred<void>();
    const lostResponse = new Error("The backend accepted work but its response was lost.");
    deferredAdapter.sendGate = sendGate;
    deferredAdapter.sendErrorAfterAccept = lostResponse;
    const run = controller.createRun({ title: "Same-attempt ambiguous send refresh" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "same-attempt ambiguous worker",
      backendHandle: { id: "same-attempt-ambiguous-worker" },
      status: "completed"
    });

    const send = controller.sendMessage(worker.agent_id, "Accept this uncertain attempt.");
    deferredAdapter.statuses.set("same-attempt-ambiguous-worker", "completed");
    const statusGate = createDeferred<void>();
    deferredAdapter.statusGate = statusGate;
    const staleRefresh = controller.refreshAgentStatus(worker.agent_id);
    expect(deferredAdapter.statusReads).toBe(1);

    sendGate.resolve();
    await expect(send).rejects.toBe(lostResponse);
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "unknown",
      failure_reason: "unknown",
      work_generation: 1,
      work_revision: 2
    });
    statusGate.resolve();
    await expect(staleRefresh).resolves.toMatchObject({
      status: "unknown",
      work_generation: 1,
      work_revision: 2
    });
    expect(controller.listEvents({ agentId: worker.agent_id, type: "agent.completed" })).toEqual([]);

    // A failed inspection cannot turn durable delivery uncertainty into a
    // terminal failure. A later healthy observation still reconciles it.
    deferredAdapter.statusGate = null;
    deferredAdapter.statusError = new Error("Temporary status endpoint failure.");
    await expect(controller.refreshAgentStatus(worker.agent_id)).resolves.toMatchObject({
      status: "unknown",
      failure_reason: "unknown",
      work_generation: 1,
      work_revision: 2
    });
    expect(
      controller
        .listEvents({ agentId: worker.agent_id, type: "agent.status_changed" })
        .filter((event) => event.payload.reason === "status_refresh_failed_during_work_uncertainty")
    ).toHaveLength(1);
    expect(
      (controller as unknown as { statusWatchers: Map<string, unknown> }).statusWatchers.has(
        worker.agent_id
      )
    ).toBe(true);

    deferredAdapter.statusError = null;
    deferredAdapter.statuses.set("same-attempt-ambiguous-worker", "running");
    await expect(controller.refreshAgentStatus(worker.agent_id)).resolves.toMatchObject({
      status: "running",
      failure_reason: null,
      work_generation: 1,
      work_revision: 2
    });
    deferredAdapter.sendErrorAfterAccept = null;
    await controller.stopAgent(worker.agent_id);
  });

  it("recovers an expired direct-send owner after restart without replaying adapter I/O", async () => {
    const run = controller.createRun({ title: "Restarted abandoned direct send" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "abandoned direct-send worker",
      backendHandle: { id: "abandoned-direct-send-worker" },
      status: "running"
    });
    const acceptanceKey = "send:restart-abandoned-direct-send";
    const accepted = store.advanceAgentWorkGenerationForAcceptedWork(
      worker.agent_id,
      acceptanceKey,
      {
        claimOwnerId: "controller-that-crashed",
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
        projectStatus: "running",
        failureReason: null
      }
    );
    expect(accepted).toMatchObject({
      type: "accepted",
      agent: { work_generation: 1, work_revision: 1, status: "running" }
    });

    // Model a process dying after the backend accepted the message but before
    // its SQLite completion transition. The restarted controller must inspect
    // backend truth, never issue this physical send a second time.
    await adapter.sendMessage(
      {
        backend: "fake",
        id: "abandoned-direct-send-worker",
        data: { id: "abandoned-direct-send-worker" }
      },
      { message: "Possibly accepted before the process crashed." }
    );
    adapter.statuses.set("abandoned-direct-send-worker", "running");
    expect(adapter.sent).toHaveLength(1);

    store.close();
    store = new SqliteStore(join(tmp, "state.sqlite"));
    registry = new AdapterRegistry();
    registry.register(adapter);
    controller = new AgentController(store, registry);

    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "unknown",
      failure_reason: "unknown",
      work_generation: 1,
      work_revision: 2
    });
    expect(
      store.db
        .prepare(
          "select phase, claim_owner_id, lease_expires_at from agent_work_acceptances where acceptance_key = ?"
        )
        .get(acceptanceKey)
    ).toMatchObject({
      phase: "ambiguous",
      claim_owner_id: "controller-that-crashed",
      lease_expires_at: null
    });
    expect(adapter.sent).toHaveLength(1);

    await expect(controller.refreshAgentStatus(worker.agent_id)).resolves.toMatchObject({
      status: "running",
      failure_reason: null,
      work_revision: 2
    });
    expect(adapter.sent).toHaveLength(1);

    // Stop after reconciliation remains authoritative and performs cleanup;
    // recovery cannot revive or resend the abandoned work.
    await expect(controller.stopAgent(worker.agent_id)).resolves.toMatchObject({
      status: "stopped",
      work_revision: 2
    });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.stopped).toHaveLength(1);
  });

  it("refuses an accepted-work boundary after durable stop intent", () => {
    const run = controller.createRun({ title: "Stopped accepted-work fence" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "stopping accepted-work worker",
      backendHandle: { id: "stopping-accepted-work-worker" },
      status: "stopping"
    });

    const first = store.advanceAgentWorkGenerationForAcceptedWork(
      worker.agent_id,
      "accepted-work:test-replay",
      {
        claimOwnerId: "stopped-acceptance-test",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      }
    );
    const replay = store.advanceAgentWorkGenerationForAcceptedWork(
      worker.agent_id,
      "accepted-work:test-replay",
      {
        claimOwnerId: "stopped-acceptance-test",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      }
    );

    expect(first).toMatchObject({
      type: "stop_intent",
      advanced: false,
      agent: { status: "stopping", work_generation: 0 }
    });
    expect(replay).toMatchObject({
      type: "stop_intent",
      advanced: false,
      agent: { status: "stopping", work_generation: 0 }
    });
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "stopping",
      work_generation: 0
    });
    expect(
      store.db
        .prepare("select count(*) as count from agent_work_acceptances where agent_id = ?")
        .get(worker.agent_id)
    ).toMatchObject({ count: 0 });
  });

  it("does not cross direct-send I/O when another controller wins the stop race", async () => {
    const sharedAdapter = new NoopWatchingDeferredFakeAdapter("cross-controller-stop-send");
    registry.register(sharedAdapter);
    const run = controller.createRun({ title: "Cross-controller stopped send" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: sharedAdapter.kind,
      title: "cross-controller stopped-send worker",
      backendHandle: { id: "cross-controller-stopped-send-worker" },
      status: "running"
    });
    const secondStore = new SqliteStore(join(tmp, "state.sqlite"));
    const secondRegistry = new AdapterRegistry();
    secondRegistry.register(sharedAdapter);
    const secondController = new AgentController(secondStore, secondRegistry);
    const originalAcceptance = store.advanceAgentWorkGenerationForAcceptedWork.bind(store);

    vi.spyOn(store, "advanceAgentWorkGenerationForAcceptedWork").mockImplementation(
      (agentId, acceptanceKey, options) => {
        // The first controller already passed its optimistic precheck. Model a
        // second controller committing stop immediately before the durable
        // acceptance boundary; BEGIN IMMEDIATE must observe this winner.
        secondStore.immediateTransaction(() => {
          secondStore.updateAgent(worker.agent_id, { status: "stopping" });
        });
        return originalAcceptance(agentId, acceptanceKey, options);
      }
    );

    try {
      await expect(
        controller.sendMessage(worker.agent_id, "This must never reach the adapter.")
      ).rejects.toMatchObject({
        reason: "tool_error",
        details: expect.objectContaining({ reason: "durable_stop_intent" })
      });
      expect(sharedAdapter.sent).toEqual([]);
      expect(secondController.getAgent(worker.agent_id)).toMatchObject({
        status: "stopping",
        work_generation: 0,
        work_revision: 0
      });
      expect(
        store.db
          .prepare("select count(*) as count from agent_work_acceptances where agent_id = ?")
          .get(worker.agent_id)
      ).toMatchObject({ count: 0 });
    } finally {
      secondStore.close();
    }
  });

  it("advances work generation once when a backend start is accepted", async () => {
    const run = controller.createRun({ title: "Start work generation" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "new worker",
      status: "planned"
    });

    const started = await controller.startAgent({
      agentId: worker.agent_id,
      prompt: "Start exactly once."
    });
    expect(started).toMatchObject({ status: "running", work_generation: 1 });

    await controller.refreshAgentStatus(worker.agent_id);
    expect(controller.getAgent(worker.agent_id).work_generation).toBe(1);
    await controller.stopAgent(worker.agent_id);
  });

  it("advances native work generation only when an idempotent action is first inserted", () => {
    const run = controller.createRun({ title: "Native action work generation" });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "native action owner",
      status: "waiting_for_input"
    });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "native action worker",
      status: "planned"
    });
    const grant = store.createBridgeGrant({
      runId: run.run_id,
      orchestratorAgentId: orchestrator.agent_id,
      ownerTaskPath: "/root",
      tokenHash: "native-action-work-generation-grant"
    });
    const actionInput = {
      idempotencyKey: "generation-idempotent-spawn",
      runId: run.run_id,
      orchestratorAgentId: orchestrator.agent_id,
      originatingBridgeGrantId: grant.bridge_grant_id,
      agentId: worker.agent_id,
      operation: "spawn_agent" as const,
      payloadJson: { message: "Spawn once." }
    };

    const first = store.createOrGetOrchestratorAction(actionInput)!;
    const replay = store.createOrGetOrchestratorAction(actionInput)!;
    expect(replay.action_id).toBe(first.action_id);
    expect(controller.getAgent(worker.agent_id).work_generation).toBe(1);

    store.updateAgentForOpenOrchestratorAction(first.action_id, worker.agent_id, {
      status: "starting",
      failureReason: null
    });
    store.updateAgentForOpenOrchestratorAction(first.action_id, worker.agent_id, {
      status: "starting",
      failureReason: null
    });
    expect(controller.getAgent(worker.agent_id).work_generation).toBe(1);
  });

  it("runs a simple multi-step flow, selects a transition, and binds artifacts", () => {
    const run = controller.createRun({ title: "flow run", repoDir: "/repo" });
    const analyst = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "Analyst",
      role: "analyst"
    });
    const smallWorker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "Small worker",
      role: "small-worker"
    });
    const analysisPath = join(tmp, "analysis.md");
    const smallResultPath = join(tmp, "small-result.md");

    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "simple-task-router",
        description: "Route a task by size.",
        initial_step: "classify",
        artifacts: {
          analysis: { path: analysisPath, description: "Classifier handoff." },
          small_result: { path: smallResultPath, description: "Small worker result." }
        },
        steps: {
          classify: {
            agent_id: analyst.agent_id,
            role: "analyst",
            outputs: {
              analysis: { artifact: "analysis", required: true }
            },
            report: {
              schema: {
                required: ["size"],
                properties: {
                  size: { enum: ["s", "xl"] }
                }
              }
            },
            on: {
              reported: {
                transitions: [
                  {
                    id: "route-small",
                    when: { equals: { var: "result.size", value: "s" } },
                    to: "small_worker"
                  },
                  {
                    id: "route-large",
                    when: { equals: { var: "result.size", value: "xl" } },
                    notify: "orchestrator"
                  }
                ]
              }
            }
          },
          small_worker: {
            agent_id: smallWorker.agent_id,
            role: "small_worker",
            inputs: {
              analysis: { artifact: "analysis", required: true }
            },
            outputs: {
              small_result: { artifact: "small_result", required: true }
            },
            on: {
              reported: { finish: true }
            }
          }
        },
        roles: {
          analyst: {
            backend: "opencode-server",
            model: "custom/analyst"
          },
          small_worker: {
            backend: "codex-thread",
            model: "custom/small"
          }
        }
      }
    });

    expect(started.active_step?.step_id).toBe("classify");
    expect(started.active_step?.input_json.runtime_contract).toMatchObject({
      flow_id: "simple-task-router",
      flow_instance_id: started.instance.flow_instance_id,
      step_id: "classify",
      run: {
        run_id: run.run_id,
        title: "flow run",
        repo_dir: "/repo"
      },
      worker: {
        agent_id: analyst.agent_id,
        role: "analyst",
        backend: "opencode-server",
        model: "custom/analyst"
      },
      input_artifacts: {},
      output_artifacts: {
        analysis: {
          artifact: "analysis",
          description: "Classifier handoff.",
          required: true,
          path: analysisPath
        }
      }
    });
    expect(JSON.stringify(started.active_step?.input_json.runtime_contract)).toContain("Runtime Contract");
    expect(JSON.stringify(started.active_step?.input_json.runtime_contract)).toContain("Classifier handoff.");
    expect(JSON.stringify(started.active_step?.input_json.runtime_contract)).toContain("custom/analyst");
    expect(started.active_step?.input_json.output_artifacts).toMatchObject({
      analysis: {
        artifact: "analysis",
        description: "Classifier handoff.",
        required: true,
        path: analysisPath
      }
    });
    expect(started.active_step?.input_json.reporting_contract).toMatchObject({
      step_id: "classify",
      step_instance_id: started.active_step?.step_instance_id,
      mcp_tool: {
        name: "flow_step_report",
        input: {
          step_instance_id: started.active_step?.step_instance_id,
          status: "completed",
          result: { size: "s" },
          artifacts: { analysis: analysisPath }
        }
      },
      result_schema: {
        required: ["size"],
        properties: {
          size: { enum: ["s", "xl"] }
        }
      },
      artifact_example: { analysis: analysisPath }
    });
    expect(JSON.stringify(started.active_step?.input_json.reporting_contract)).toContain("agentctl flow report");
    expect(JSON.stringify(started.active_step?.input_json.reporting_contract)).toContain("Reporting Contract");

    const classifyStartedEvent = controller
      .listEvents({ runId: run.run_id, type: "flow.step_started" })
      .find((event) => event.payload.step_id === "classify");
    expect(classifyStartedEvent?.payload.runtime_contract).toEqual(
      started.active_step?.input_json.runtime_contract
    );
    expect(classifyStartedEvent?.payload.reporting_contract).toEqual(
      started.active_step?.input_json.reporting_contract
    );

    writeFileSync(analysisPath, "classified as small\n", "utf8");
    const routed = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      result: { size: "s" },
      artifacts: { analysis: analysisPath },
      summary: "Classified as a small task."
    });

    expect(routed.instance.current_step_id).toBe("small_worker");
    expect(routed.selected_transition?.transition_id).toBe("route-small");
    expect(routed.active_step?.step_id).toBe("small_worker");
    expect(routed.active_step?.input_json).toMatchObject({ analysis: analysisPath });
    expect(routed.active_step?.input_json.input_artifacts).toMatchObject({
      analysis: {
        artifact: "analysis",
        description: "Classifier handoff.",
        required: true,
        path: analysisPath
      }
    });
    expect(routed.active_step?.input_json.runtime_contract).toMatchObject({
      worker: {
        agent_id: smallWorker.agent_id,
        role: "small_worker",
        backend: "codex-thread",
        model: "custom/small"
      }
    });
    expect(JSON.stringify(routed.active_step?.input_json.runtime_contract)).toContain("Input artifacts");
    expect(JSON.stringify(routed.active_step?.input_json.runtime_contract)).toContain(analysisPath);
    expect(routed.artifact_bindings).toMatchObject([{ artifact_key: "analysis", path: analysisPath }]);

    writeFileSync(smallResultPath, "small path done\n", "utf8");
    const completed = controller.reportFlowStep({
      stepInstanceId: routed.active_step!.step_instance_id,
      status: "completed",
      artifacts: { small_result: smallResultPath },
      summary: "Small path completed."
    });

    expect(completed.instance.status).toBe("completed");
    expect(completed.active_step).toBeNull();
    expect(completed.artifact_bindings.map((binding) => binding.artifact_key).sort()).toEqual([
      "analysis",
      "small_result"
    ]);
    expect(controller.listEvents({ runId: run.run_id }).map((event) => event.type)).toContain("flow.completed");

    const dashboard = controller.getDashboardSnapshot(run.run_id);
    expect(dashboard.flows.map((flow) => flow.flow_id)).toEqual(["simple-task-router"]);
    expect(dashboard.flow_instances).toHaveLength(1);
    expect(dashboard.flow_steps.map((step) => step.step_id)).toEqual(["classify", "small_worker"]);
    expect(dashboard.flow_reports).toHaveLength(2);
    expect(dashboard.flow_transitions.map((transition) => transition.transition_id)).toEqual([
      "route-small",
      "notify"
    ]);
    expect(dashboard.flow_artifact_bindings.map((binding) => binding.artifact_key).sort()).toEqual([
      "analysis",
      "small_result"
    ]);
  });

  it("reuses an active flow instance when start is called again for the same run and flow", () => {
    const run = controller.createRun({ title: "reused flow run", repoDir: "/repo" });
    const config = {
      id: "reused-flow",
      version: "1.0.0",
      initial_step: "first",
      steps: {
        first: {
          on: {
            reported: { finish: true }
          }
        }
      }
    };

    const first = controller.startFlow({ runId: run.run_id, config });
    const second = controller.startFlow({ runId: run.run_id, config });

    expect(second.reused).toBe(true);
    expect(second.instance.flow_instance_id).toBe(first.instance.flow_instance_id);
    expect(second.active_step?.step_instance_id).toBe(first.active_step?.step_instance_id);
    expect(store.listFlowInstances({ runId: run.run_id })).toHaveLength(1);
    expect(controller.listEvents({ runId: run.run_id, type: "flow.started" })).toHaveLength(1);
  });

  it("dispatches an active flow step using a subscriber agent without creating a temporary orchestrator", async () => {
    const run = controller.createRun({ title: "subscriber dispatch run", repoDir: "/repo" });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "Flow orchestrator",
      role: "orchestrator"
    });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "subscriber-dispatch-flow",
        initial_step: "work",
        roles: {
          worker: {
            backend: "fake",
            model: "fake-model"
          }
        },
        steps: {
          work: {
            role: "worker",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const dispatched = await controller.dispatchActiveFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      subscriberAgentId: orchestrator.agent_id
    });
    const agents = controller.listAgents({ runId: run.run_id });
    const links = controller.listAgentLinks({ runId: run.run_id });

    expect(dispatched.agent.role).toBe("worker");
    expect(agents.filter((agent) => agent.role === "orchestrator")).toHaveLength(1);
    expect(links).toMatchObject([
      {
        source_agent_id: orchestrator.agent_id,
        target_agent_id: dispatched.agent.agent_id,
        type: "parent_child",
        label: "worker"
      }
    ]);
  });

  it.each(["codex-thread", "opencode-server"])("dispatches %s flows with the selected adapter server and Codex effort", async (backend) => {
    const worker = new FakeAdapter(backend);
    registry.register(worker);
    const run = controller.createRun({ title: "Backend defaults", repoDir: "/repo" });
    const orchestrator = controller.registerAgent({ runId: run.run_id, backend: "fake", title: "Orchestrator", role: "orchestrator" });
    const isCodex = backend === "codex-thread";
    const started = controller.startFlow({ runId: run.run_id, config: {
      id: "backend-defaults", initial_step: "work",
      roles: { worker: { backend, model: isCodex ? "gpt-5.6-luna" : "provider/explicit-model", ...(isCodex ? { reasoning_effort: "max" } : {}) } },
      steps: { work: { role: "worker", on: { reported: { finish: true } } } }
    } });
    await controller.dispatchActiveFlowStep({ flowInstanceId: started.instance.flow_instance_id, subscriberAgentId: orchestrator.agent_id });
    expect(worker.starts[0]?.server).toBe(isCodex ? undefined : "http://localhost:53910");
    expect(worker.starts[0]?.metadata?.reasoning_effort).toBe(isCodex ? "max" : undefined);
  });

  it("pre-registers declarative flow agents and reuses their cards across clean step instances", async () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_planned_flow_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_planned_flow_test",
      title: "Planned role run",
      repoDir: "/repo",
      backend: "fake"
    });
    const config = {
      id: "planned-role-flow",
      initial_step: "work",
      roles: {
        worker: {
          backend: "fake",
          model: "fake-worker"
        },
        reviewer: {
          backend: "fake",
          model: "fake-reviewer"
        }
      },
      steps: {
        work: {
          role: "worker",
          report: {
            schema: {
              required: ["done"],
              properties: {
                done: { enum: [true] }
              }
            }
          },
          on: {
            reported: { to: "review" }
          }
        },
        review: {
          role: "reviewer",
          report: {
            schema: {
              required: ["verdict"],
              properties: {
                verdict: { enum: ["approved", "changes"] }
              }
            }
          },
          on: {
            reported: {
              transitions: [
                {
                  id: "needs-more-work",
                  when: { equals: { var: "result.verdict", value: "changes" } },
                  to: "work"
                },
                {
                  id: "approved",
                  when: { equals: { var: "result.verdict", value: "approved" } },
                  finish: true
                }
              ]
            }
          }
        }
      }
    };

    const started = controller.startFlow({
      runId: login.run.run_id,
      config,
      agentToken: login.agent_token
    });
    const plannedAgents = controller.listAgents({ runId: login.run.run_id });
    const worker = plannedAgents.find((agent) => agent.role === "worker");
    const reviewer = plannedAgents.find((agent) => agent.role === "reviewer");

    expect(worker).toMatchObject({
      title: "planned-role-flow: worker",
      status: "planned",
      model: "fake-worker"
    });
    expect(reviewer).toMatchObject({
      title: "planned-role-flow: reviewer",
      status: "planned",
      model: "fake-reviewer"
    });
    expect(controller.listAgentLinks({ runId: login.run.run_id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_agent_id: login.agent.agent_id,
          target_agent_id: worker?.agent_id,
          type: "parent_child",
          label: "worker"
        }),
        expect.objectContaining({
          source_agent_id: login.agent.agent_id,
          target_agent_id: reviewer?.agent_id,
          type: "parent_child",
          label: "reviewer"
        }),
        expect.objectContaining({
          source_agent_id: worker?.agent_id,
          target_agent_id: reviewer?.agent_id,
          type: "handoff",
          label: "reported"
        }),
        expect.objectContaining({
          source_agent_id: reviewer?.agent_id,
          target_agent_id: worker?.agent_id,
          type: "handoff",
          label: "needs-more-work"
        })
      ])
    );

    const firstWork = await controller.dispatchActiveFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    expect(firstWork.agent.agent_id).toBe(worker?.agent_id);
    expect(firstWork.agent.status).toBe("running");
    expect(adapter.starts.at(-1)?.prompt).toContain(`- Worker agent: \`${worker?.agent_id}\``);

    const afterWork = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      result: { done: true },
      summary: "Work completed."
    });
    const reviewDispatch = await controller.dispatchActiveFlowStep({
      flowInstanceId: afterWork.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    expect(reviewDispatch.agent.agent_id).toBe(reviewer?.agent_id);

    const afterReview = controller.reportFlowStep({
      stepInstanceId: afterWork.active_step!.step_instance_id,
      status: "completed",
      result: { verdict: "changes" },
      summary: "Needs one clean retry."
    });
    const secondWork = await controller.dispatchActiveFlowStep({
      flowInstanceId: afterReview.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    const dashboard = controller.getDashboardSnapshot(login.run.run_id);

    expect(secondWork.agent.agent_id).toBe(worker?.agent_id);
    expect(dashboard.agents.filter((agent) => agent.role === "worker")).toHaveLength(1);
    expect(dashboard.flow_steps.filter((step) => step.agent_id === worker?.agent_id)).toHaveLength(2);
    expect(controller.listSubscriptions({ runId: login.run.run_id })).toHaveLength(10);
  });

  it("creates one clean Codex thread agent per fresh step instance and keeps redispatch idempotent", async () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_fresh_review_flow_test";
    const codexThreadAdapter = new FakeCodexThreadAdapter();
    registry.register(codexThreadAdapter);
    const login = controller.orchestratorLogin({
      adminKey: "ack_fresh_review_flow_test",
      title: "Fresh review run",
      repoDir: "/repo",
      backend: "fake"
    });
    const started = controller.startFlow({
      runId: login.run.run_id,
      agentToken: login.agent_token,
      config: {
        id: "fresh-review-flow",
        initial_step: "final_review",
        roles: {
          final_reviewer: {
            backend: "codex-thread",
            model: "review-model",
            agent_lifecycle: "fresh_per_step" as const
          }
        },
        steps: {
          final_review: {
            role: "final_reviewer",
            report: {
              schema: {
                required: ["verdict"],
                properties: {
                  verdict: { enum: ["approved", "changes"] }
                }
              }
            },
            on: {
              reported: {
                transitions: [
                  {
                    id: "rerun-final-review",
                    when: { equals: { var: "result.verdict", value: "changes" } },
                    to: "final_review"
                  },
                  {
                    id: "approve-final-review",
                    when: { equals: { var: "result.verdict", value: "approved" } },
                    finish: true
                  }
                ]
              }
            }
          }
        }
      }
    });

    // Fresh roles do not create a dormant persistent role card at flow start.
    expect(
      controller
        .listAgents({ runId: login.run.run_id })
        .filter((agent) => agent.role === "final_reviewer")
    ).toHaveLength(0);

    const firstDispatch = await controller.dispatchActiveFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    const firstAgentId = String(firstDispatch.agent.agent_id);
    const firstAgent = controller.getAgent(firstAgentId);
    const firstThreadId = String(firstAgent.backend_handle?.thread_id);
    expect(firstAgent.title).toBe(
      `fresh-review-flow: final_reviewer [final_review:${started.active_step!.step_instance_id}]`
    );
    expect(firstThreadId).toBe(`thread_${firstAgentId}`);
    expect(codexThreadAdapter.starts).toHaveLength(1);
    expect(codexThreadAdapter.starts[0]?.agent.backend_handle).toBeNull();

    const firstReplay = await controller.dispatchActiveFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    expect(firstReplay.agent.agent_id).toBe(firstAgentId);
    expect(codexThreadAdapter.starts).toHaveLength(1);

    const rerun = await controller.reportFlowStepAndContinue({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      result: { verdict: "changes" },
      summary: "Run an independent final review again."
    });
    const secondStep = rerun.report.active_step!;
    const secondAgentId = rerun.continuation!.agent!.agent_id;

    expect(rerun.continuation?.action).toBe("dispatched");
    expect(secondStep.step_instance_id).not.toBe(started.active_step!.step_instance_id);
    expect(secondAgentId).not.toBe(firstAgentId);
    expect(codexThreadAdapter.starts).toHaveLength(2);
    expect(codexThreadAdapter.starts[1]?.agent.backend_handle).toBeNull();
    const secondThreadId = String(controller.getAgent(secondAgentId).backend_handle?.thread_id);
    expect(controller.getAgent(secondAgentId).title).toBe(
      `fresh-review-flow: final_reviewer [final_review:${secondStep.step_instance_id}]`
    );
    expect(secondThreadId).toBe(`thread_${secondAgentId}`);
    expect(secondThreadId).not.toBe(firstThreadId);
    const firstAttempt = store.listAgentStartAttempts(firstAgentId)[0]!;
    const secondAttempt = store.listAgentStartAttempts(secondAgentId)[0]!;
    expect(firstAttempt).toMatchObject({
      step_instance_id: started.active_step!.step_instance_id,
      phase: "succeeded"
    });
    expect(secondAttempt).toMatchObject({
      step_instance_id: secondStep.step_instance_id,
      phase: "succeeded"
    });
    expect(secondAttempt.start_attempt_id).not.toBe(firstAttempt.start_attempt_id);

    const secondReplay = await controller.dispatchActiveFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    expect(secondReplay.agent.agent_id).toBe(secondAgentId);
    expect(codexThreadAdapter.starts).toHaveLength(2);

    const finalReviewAgents = controller
      .listAgents({ runId: login.run.run_id })
      .filter((agent) => agent.role === "final_reviewer");
    expect(finalReviewAgents).toHaveLength(2);
    expect(new Set(finalReviewAgents.map((agent) => agent.title)).size).toBe(2);
    expect(
      controller.listAgentLinks({ runId: login.run.run_id })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_agent_id: login.agent.agent_id,
          target_agent_id: firstAgentId,
          type: "parent_child",
          label: "final_reviewer"
        }),
        expect.objectContaining({
          source_agent_id: login.agent.agent_id,
          target_agent_id: secondAgentId,
          type: "parent_child",
          label: "final_reviewer"
        }),
        expect.objectContaining({
          source_agent_id: firstAgentId,
          target_agent_id: secondAgentId,
          type: "handoff",
          label: "rerun-final-review"
        })
      ])
    );
    const terminalSubscriptions = controller
      .listSubscriptions({ runId: login.run.run_id })
      .filter(
        (subscription) =>
          [firstAgentId, secondAgentId].includes(subscription.source_agent_id ?? "") &&
          subscription.subscriber_agent_id === login.agent.agent_id &&
          ["agent.completed", "agent.failed", "agent.blocked", "agent.stopped"].includes(
            subscription.event_type
          )
      );
    expect(terminalSubscriptions).toHaveLength(8);
  });

  it("retries a fresh Codex thread after prompt construction fails post-assignment", async () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_fresh_prompt_retry_test";
    const codexThreadAdapter = new FakeCodexThreadAdapter();
    registry.register(codexThreadAdapter);
    const login = controller.orchestratorLogin({
      adminKey: "ack_fresh_prompt_retry_test",
      title: "Fresh prompt retry",
      repoDir: "/repo",
      backend: "fake"
    });
    const promptPath = join(tmp, "late-final-review.md");
    const started = controller.startFlow({
      runId: login.run.run_id,
      agentToken: login.agent_token,
      config: {
        id: "fresh-prompt-retry-flow",
        initial_step: "final_review",
        roles: {
          final_reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          }
        },
        steps: {
          final_review: {
            role: "final_reviewer",
            prompt_path: promptPath,
            on: { reported: { finish: true } }
          }
        }
      }
    });

    await expect(
      controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id })
    ).rejects.toThrow(/prompt source file is unavailable/);

    const strandedSnapshot = controller.getFlowSnapshot(started.instance.flow_instance_id);
    const assignedStep = strandedSnapshot.steps.find((step) => step.status === "active")!;
    const assignedAgent = controller.getAgent(assignedStep.agent_id!);
    expect(assignedAgent).toMatchObject({
      status: "queued",
      backend_handle: null
    });
    expect(codexThreadAdapter.starts).toHaveLength(0);

    // `starting` is written before a backend call and may survive a process
    // crash, so it cannot replace handle/action/session evidence on retry.
    store.updateAgent(assignedAgent.agent_id, { status: "starting" });
    const abandoned = store.claimAgentStartAttempt({
      agentId: assignedAgent.agent_id,
      flowInstanceId: started.instance.flow_instance_id,
      stepInstanceId: assignedStep.step_instance_id,
      generation: 1,
      leaseExpiresAt: "2000-01-01T00:00:00.000Z"
    });
    expect(abandoned).toMatchObject({
      type: "claimed",
      attempt: { phase: "prepared", invocation_started_at: null }
    });
    writeFileSync(promptPath, "# Final review\n\nReview independently.\n", "utf8");
    const recovered = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(recovered).toMatchObject({
      action: "dispatched",
      active_step: {
        step_instance_id: assignedStep.step_instance_id,
        agent_id: assignedAgent.agent_id
      },
      agent: { agent_id: assignedAgent.agent_id }
    });
    expect(codexThreadAdapter.starts).toHaveLength(1);
    expect(store.listAgentStartAttempts(assignedAgent.agent_id)[0]).toMatchObject({
      phase: "succeeded",
      step_instance_id: assignedStep.step_instance_id
    });

    rmSync(promptPath);
    const replay = await controller.dispatchActiveFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      subscriberAgentId: login.agent.agent_id,
      agentToken: login.agent_token
    });
    expect(replay.agent.agent_id).toBe(assignedAgent.agent_id);
    expect(codexThreadAdapter.starts).toHaveLength(1);
  });

  it("serializes concurrent fresh Codex-thread starts behind one durable attempt", async () => {
    const deferredAdapter = new DeferredFakeAdapter("codex-thread");
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Concurrent fresh start", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "concurrent-fresh-start-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { finish: true } } }
        }
      }
    });

    const owner = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(deferredAdapter.starts).toHaveLength(1);
    const assigned = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;

    // Use a second SQLite connection/controller to exercise the cross-process
    // CAS path rather than relying only on JavaScript promise interleaving.
    const competingStore = new SqliteStore(join(tmp, "state.sqlite"));
    const competingController = new AgentController(competingStore, registry);
    const concurrent = await competingController.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(concurrent).toMatchObject({
      action: "start_in_progress",
      active_step: { step_instance_id: assigned.step_instance_id },
      agent: { agent_id: assigned.agent_id },
      notification: "backend_start_in_progress"
    });
    expect(deferredAdapter.starts).toHaveLength(1);
    expect(store.listAgentStartAttempts(assigned.agent_id!)).toEqual([
      expect.objectContaining({
        step_instance_id: assigned.step_instance_id,
        generation: 1,
        phase: "invoking"
      })
    ]);
    competingStore.close();

    startGate.resolve();
    const dispatched = await owner;
    expect(dispatched).toMatchObject({
      action: "dispatched",
      agent: { agent_id: assigned.agent_id, status: "running" },
      dispatch: { start_state: "started" }
    });
    expect(deferredAdapter.starts).toHaveLength(1);
    expect(store.listAgentStartAttempts(assigned.agent_id!)).toEqual([
      expect.objectContaining({
        phase: "succeeded",
        handle_json: { id: assigned.agent_id, late_start: true }
      })
    ]);
  });

  it("keeps a manual route authoritative when an invoking start returns afterward", async () => {
    const deferredAdapter = new DeferredFakeAdapter("codex-thread");
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Manual route beats invoking start", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "manual-route-invoking-start-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          },
          planner: { backend: "fake" }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { to: "planning" } } },
          planning: { role: "planner", on: { reported: { finish: true } } }
        }
      }
    });

    const original = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const oldStep = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    expect(store.listAgentStartAttempts(oldStep.agent_id!)[0]).toMatchObject({
      phase: "invoking"
    });

    const advanced = await controller.startFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: oldStep.step_instance_id,
      transitionId: "manual-while-review-starts"
    });
    expect(advanced.active_step).toMatchObject({ step_id: "planning", status: "active" });

    startGate.resolve();
    const superseded = await original;
    expect(superseded).toMatchObject({
      action: "start_superseded",
      active_step: { step_id: "planning", status: "active" },
      notification: "flow_route_advanced_during_backend_start",
      dispatch: { start_state: "superseded" }
    });
    expect(store.listAgentStartAttempts(oldStep.agent_id!)[0]).toMatchObject({
      phase: "superseded",
      error_json: { reason: "later_flow_step_exists" }
    });
    const snapshot = controller.getFlowSnapshot(started.instance.flow_instance_id);
    expect(snapshot.instance).toMatchObject({ status: "active", current_step_id: "planning" });
    expect(snapshot.steps.filter((step) => step.status === "active")).toEqual([
      expect.objectContaining({ step_id: "planning" })
    ]);
    expect(snapshot.steps.find((step) => step.step_instance_id === oldStep.step_instance_id)).toMatchObject({
      status: "cancelled"
    });
    expect(controller.getAgent(oldStep.agent_id!)).toMatchObject({ status: "stopped" });
    expect(deferredAdapter.stopped).toEqual([
      expect.objectContaining({ id: oldStep.agent_id })
    ]);
  });

  it("awaits cleanup of a running fresh worker before returning a manual route", async () => {
    const run = controller.createRun({ title: "Manual route cleans fresh worker", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "manual-route-cleans-fresh-worker-flow",
        initial_step: "review",
        roles: {
          reviewer: { backend: "fake", agent_lifecycle: "fresh_per_step" as const },
          planner: { backend: "fake", agent_lifecycle: "fresh_per_step" as const }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { to: "planning" } } },
          planning: { role: "planner", on: { reported: { finish: true } } }
        }
      }
    });
    const dispatched = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const oldStep = dispatched.active_step!;
    expect(dispatched.agent).toMatchObject({ status: "running" });

    const rerouted = await controller.startFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: oldStep.step_instance_id,
      transitionId: "manual-clean-running-review"
    });

    expect(rerouted).toMatchObject({
      instance: { status: "active", current_step_id: "planning" },
      active_step: { step_id: "planning", status: "active" },
      cleanup: [
        {
          agent_id: oldStep.agent_id,
          status: "stopped",
          failure_reason: null,
          orchestrator_action: null
        }
      ]
    });
    expect(adapter.stopped).toEqual([
      expect.objectContaining({ id: oldStep.agent_id })
    ]);
    expect(controller.getAgent(oldStep.agent_id!)).toMatchObject({ status: "stopped" });
    expect(
      controller
        .getFlowSnapshot(started.instance.flow_instance_id)
        .steps.filter((step) => step.status === "active")
    ).toEqual([expect.objectContaining({ step_id: "planning" })]);
  });

  it("preserves manual cleanup across stale status refreshes and retries it after restart", async () => {
    const initialAdapter = new DeferredFakeAdapter("codex-thread");
    initialAdapter.stopErrorAtCall = 1;
    registry.register(initialAdapter);
    const run = controller.createRun({ title: "Retry durable manual cleanup", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "retry-durable-manual-cleanup-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          },
          planner: { backend: "fake", agent_lifecycle: "fresh_per_step" as const }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { to: "planning" } } },
          planning: { role: "planner", on: { reported: { finish: true } } }
        }
      }
    });
    const dispatched = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const oldStep = dispatched.active_step!;

    // Hold a running observation across the manual route. The eventual result
    // is stale with respect to the stop intent that the route persists while
    // getStatus is in flight, so projection must re-read lifecycle authority.
    const statusGate = createDeferred<void>();
    initialAdapter.statusGate = statusGate;
    const staleRefresh = controller.refreshAgentStatus(oldStep.agent_id!);
    expect(initialAdapter.statusReads).toBe(1);

    const rerouted = await controller.startFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: oldStep.step_instance_id,
      transitionId: "manual-cleanup-needs-retry"
    });

    expect(rerouted).toMatchObject({
      instance: { status: "active", current_step_id: "planning" },
      active_step: { step_id: "planning", status: "active" },
      cleanup: [
        {
          agent_id: oldStep.agent_id,
          status: "stopping",
          failure_reason: "unknown",
          orchestrator_action: null
        }
      ]
    });
    expect(initialAdapter.stopped).toHaveLength(1);
    expect(controller.getAgent(oldStep.agent_id!)).toMatchObject({
      status: "stopping",
      failure_reason: "unknown",
      backend_handle: { id: oldStep.agent_id }
    });
    expect(
      controller
        .listEvents({ agentId: oldStep.agent_id!, type: "agent.status_changed" })
        .filter((event) => event.payload.reason === "external_stop_retry_pending")
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          status: "stopping",
          failure_reason: "unknown",
          error: "Deferred adapter compensating stop failed."
        })
      })
    ]);

    statusGate.resolve();
    const staleProjection = await staleRefresh;
    expect(staleProjection).toMatchObject({ status: "stopping", failure_reason: "unknown" });
    expect(controller.getAgent(oldStep.agent_id!)).toMatchObject({
      status: "stopping",
      failure_reason: "unknown"
    });
    expect(
      controller
        .listEvents({ agentId: oldStep.agent_id!, type: "agent.status_changed" })
        .filter(
          (event) =>
            event.payload.reason === "backend_nonterminal_observed_during_cleanup"
        )
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          status: "stopping",
          observed_status: "running",
          failure_reason: "unknown"
        })
      })
    ]);

    initialAdapter.statusError = new Error("Status endpoint is temporarily unavailable.");
    const failedPoll = await controller.pollActiveAgents(run.run_id);
    expect(failedPoll.find((candidate) => candidate.agent_id === oldStep.agent_id)).toMatchObject({
      status: "stopping",
      failure_reason: "unknown"
    });
    expect(controller.getAgent(oldStep.agent_id!)).toMatchObject({
      status: "stopping",
      failure_reason: "unknown"
    });
    expect(
      controller
        .listEvents({ agentId: oldStep.agent_id!, type: "agent.status_changed" })
        .filter((event) => event.payload.reason === "status_refresh_failed_during_cleanup")
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          status: "stopping",
          failure_reason: "unknown",
          error: "Status endpoint is temporarily unavailable."
        })
      })
    ]);

    // A new controller performs one startup redrive. Its own first stop also
    // fails, proving that transient failures remain visible and pending without
    // recursively scheduling a busy retry loop in the same process.
    const restartedStore = new SqliteStore(join(tmp, "state.sqlite"));
    const restartedRegistry = new AdapterRegistry();
    const restartedAdapter = new DeferredFakeAdapter("codex-thread");
    restartedAdapter.stopErrorAtCall = 1;
    restartedRegistry.register(restartedAdapter);
    restartedRegistry.register(new FakeAdapter());
    const restartedController = new AgentController(restartedStore, restartedRegistry);
    await restartedController.drainDeliveries();
    expect(restartedAdapter.stopped).toHaveLength(1);
    expect(restartedController.getAgent(oldStep.agent_id!)).toMatchObject({
      status: "stopping",
      failure_reason: "unknown"
    });
    await restartedController.drainDeliveries();
    expect(restartedAdapter.stopped).toHaveLength(1);
    expect(
      restartedController
        .listEvents({ agentId: oldStep.agent_id!, type: "agent.status_changed" })
        .filter((event) => event.payload.reason === "external_stop_retry_pending")
    ).toHaveLength(2);

    const retried = await restartedController.stopAgent(oldStep.agent_id!);
    expect(retried).toMatchObject({ status: "stopped", failure_reason: null });
    expect(restartedAdapter.stopped).toHaveLength(2);
    const snapshot = restartedController.getFlowSnapshot(started.instance.flow_instance_id);
    expect(snapshot.instance).toMatchObject({ status: "active", current_step_id: "planning" });
    expect(snapshot.steps.find((step) => step.step_instance_id === oldStep.step_instance_id)).toMatchObject({
      status: "cancelled"
    });
    expect(snapshot.steps.filter((step) => step.status === "active")).toEqual([
      expect.objectContaining({ step_id: "planning" })
    ]);
    restartedStore.close();
  });

  it("retains a reused worker that is still owned by the manually selected step", async () => {
    const run = controller.createRun({ title: "Manual route retains reused worker", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "manual-route-retains-reused-worker-flow",
        initial_step: "first",
        roles: {
          worker: { backend: "fake", agent_lifecycle: "reuse" as const }
        },
        steps: {
          first: { role: "worker", on: { reported: { to: "second" } } },
          second: { role: "worker", on: { reported: { finish: true } } }
        }
      }
    });
    const first = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const workerId = first.agent!.agent_id;

    const rerouted = await controller.startFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      stepId: "second",
      fromStepInstanceId: first.active_step!.step_instance_id,
      transitionId: "manual-reuse-same-worker"
    });

    expect(rerouted).toMatchObject({
      active_step: { step_id: "second", status: "active" },
      cleanup: []
    });
    expect(controller.getAgent(workerId)).toMatchObject({ status: "running" });
    expect(adapter.stopped).toEqual([]);
    const second = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(second).toMatchObject({
      action: "dispatched",
      active_step: { step_id: "second", agent_id: workerId },
      agent: { agent_id: workerId, status: "running" }
    });
    expect(adapter.stopped).toEqual([]);
  });

  it("cancels a prepared fresh start when stop wins before invocation", async () => {
    const codexThreadAdapter = new FakeCodexThreadAdapter();
    registry.register(codexThreadAdapter);
    const run = controller.createRun({ title: "Prepared fresh start stop", repoDir: "/repo" });
    const promptPath = join(tmp, "not-yet-available-review.md");
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "prepared-fresh-start-stop-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          }
        },
        steps: {
          review: {
            role: "reviewer",
            prompt_path: promptPath,
            on: { reported: { finish: true } }
          }
        }
      }
    });
    await expect(
      controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id })
    ).rejects.toThrow(/prompt source file is unavailable/);
    const assigned = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    store.claimAgentStartAttempt({
      agentId: assigned.agent_id!,
      flowInstanceId: started.instance.flow_instance_id,
      stepInstanceId: assigned.step_instance_id,
      generation: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const stopped = await controller.stopAgent(assigned.agent_id!);
    expect(stopped).toMatchObject({ status: "stopped", backend_handle: null });
    expect(store.listAgentStartAttempts(assigned.agent_id!)[0]).toMatchObject({
      phase: "cancelled",
      invocation_started_at: null,
      error_json: { reason: "agent_stop_before_backend_start_invocation" }
    });
    expect(codexThreadAdapter.starts).toHaveLength(0);
  });

  it("atomically blocks a fresh step when stop cancels its prepared start boundary", async () => {
    const run = controller.createRun({ title: "Prepared boundary stop interleaving", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "prepared-boundary-stop-interleaving-flow",
        initial_step: "review",
        roles: {
          reviewer: { backend: "fake", agent_lifecycle: "fresh_per_step" as const }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { finish: true } } }
        }
      }
    });
    const observer = new SqliteStore(join(tmp, "state.sqlite"));
    const begin = store.beginAgentStartAttempt.bind(store);
    let stop: Promise<unknown> | null = null;
    vi.spyOn(store, "beginAgentStartAttempt").mockImplementation((input) => {
      const row = store.db
        .prepare("select agent_id from agent_start_attempts where start_attempt_id = ?")
        .get(input.startAttemptId) as { agent_id: string };
      // stopAgent reaches the handleless cancellation transaction before its
      // returned promise settles. A second connection must observe either the
      // old prepared/starting pair or the final cancelled/stopped pair, never a
      // cancelled attempt attached to a startable agent.
      stop = controller.stopAgent(row.agent_id);
      const observedAttempt = observer.listAgentStartAttempts(row.agent_id)[0];
      const observedAgent = observer.getAgent(row.agent_id)!;
      expect({ phase: observedAttempt?.phase, status: observedAgent.status }).toEqual({
        phase: "cancelled",
        status: "stopped"
      });
      return begin(input);
    });

    const continuation = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    await stop;
    observer.close();

    expect(continuation).toMatchObject({
      action: "blocked",
      blocked_reason: "backend_start_cancelled",
      active_step: { status: "blocked" },
      agent: { status: "stopped" },
      dispatch: { start_state: "cancelled" }
    });
    expect(adapter.starts).toHaveLength(0);
    const blocked = controller.getFlowSnapshot(started.instance.flow_instance_id);
    expect(blocked.instance.status).toBe("blocked");
    expect(blocked.steps[0]).toMatchObject({
      status: "blocked",
      summary: expect.stringMatching(/^Backend start attempt .* cancelled before adapter invocation\.$/)
    });
    expect(store.listAgentStartAttempts(continuation.agent!.agent_id)[0]).toMatchObject({
      phase: "cancelled",
      error_json: { reason: "agent_stop_before_backend_start_invocation" }
    });
  });

  it("maps a failed durable start attempt to a precise blocked flow without adapter I/O", async () => {
    const run = controller.createRun({ title: "Failed start attempt mapping", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "failed-start-attempt-mapping-flow",
        initial_step: "review",
        roles: {
          reviewer: { backend: "fake", agent_lifecycle: "fresh_per_step" as const }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { finish: true } } }
        }
      }
    });
    const begin = store.beginAgentStartAttempt.bind(store);
    vi.spyOn(store, "beginAgentStartAttempt").mockImplementation((input) => {
      const failedAt = new Date().toISOString();
      store.db
        .prepare(
          `update agent_start_attempts
           set phase = 'failed', error_json = ?, completed_at = ?, updated_at = ?
           where start_attempt_id = ? and phase = 'prepared'`
        )
        .run(
          JSON.stringify({
            reason: "backend_start_failed_before_invocation",
            message: "The durable start failed before adapter invocation."
          }),
          failedAt,
          failedAt,
          input.startAttemptId
        );
      return begin(input);
    });

    const continuation = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });

    expect(continuation).toMatchObject({
      action: "blocked",
      blocked_reason: "backend_start_failed",
      active_step: { status: "blocked" },
      agent: { status: "failed", failure_reason: "unknown" },
      dispatch: { start_state: "failed" }
    });
    expect(adapter.starts).toHaveLength(0);
    expect(store.listAgentStartAttempts(continuation.agent!.agent_id)[0]).toMatchObject({
      phase: "failed",
      error_json: { reason: "backend_start_failed_before_invocation" }
    });
    const replay = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(replay).toMatchObject({
      action: "blocked",
      blocked_reason: "backend_start_failed",
      active_step: { status: "blocked" }
    });
  });

  it("blocks an expired invoking start without retry and reconciles its late owner success", async () => {
    const deferredAdapter = new DeferredFakeAdapter("codex-thread");
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Ambiguous fresh start", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "ambiguous-fresh-start-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { finish: true } } }
        }
      }
    });

    const owner = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(deferredAdapter.starts).toHaveLength(1);
    const assigned = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    store.db
      .prepare(
        "update agent_start_attempts set lease_expires_at = ? where agent_id = ? and step_instance_id = ?"
      )
      .run("2000-01-01T00:00:00.000Z", assigned.agent_id, assigned.step_instance_id);

    const blocked = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(blocked).toMatchObject({
      action: "blocked",
      blocked_reason: "backend_start_ambiguous",
      active_step: { status: "blocked" }
    });
    expect(deferredAdapter.starts).toHaveLength(1);
    expect(store.listAgentStartAttempts(assigned.agent_id!)[0]).toMatchObject({
      phase: "ambiguous",
      error_json: { reason: "backend_start_invocation_lease_expired" }
    });
    const blockedReplay = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(blockedReplay).toMatchObject({
      action: "blocked",
      blocked_reason: "backend_start_ambiguous",
      notification: "automatic_backend_start_retry_disabled"
    });
    expect(deferredAdapter.starts).toHaveLength(1);

    // Only the original lease owner may turn the ambiguous attempt into a
    // success. Its valid late handle atomically completes the attempt and
    // reopens the block created for this exact attempt id.
    startGate.resolve();
    const recovered = await owner;
    expect(recovered.action).toBe("dispatched");
    expect(deferredAdapter.starts).toHaveLength(1);
    expect(store.listAgentStartAttempts(assigned.agent_id!)[0]).toMatchObject({
      phase: "succeeded",
      handle_json: { id: assigned.agent_id, late_start: true }
    });
    expect(controller.getFlowSnapshot(started.instance.flow_instance_id)).toMatchObject({
      instance: { status: "active" },
      steps: [expect.objectContaining({ step_instance_id: assigned.step_instance_id, status: "active" })]
    });
    const replay = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(replay.action).toBe("waiting_for_report");
    expect(deferredAdapter.starts).toHaveLength(1);
  });

  it("keeps a manually advanced route authoritative over a late ambiguous start", async () => {
    const deferredAdapter = new DeferredFakeAdapter("codex-thread");
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Manual route beats late start", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "manual-route-late-start-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          },
          planner: { backend: "fake" }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { to: "planning" } } },
          planning: { role: "planner", on: { reported: { finish: true } } }
        }
      }
    });

    const lateDispatch = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const oldStep = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    store.db
      .prepare("update agent_start_attempts set lease_expires_at = ? where agent_id = ?")
      .run("2000-01-01T00:00:00.000Z", oldStep.agent_id);
    await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });

    const advanced = await controller.startFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: oldStep.step_instance_id,
      transitionId: "manual-review-to-planning",
      reason: "The coordinator accepted the review timeout and advanced manually."
    });
    expect(advanced.active_step?.step_id).toBe("planning");

    startGate.resolve();
    const lateResult = await lateDispatch;
    expect(lateResult).toMatchObject({
      action: "start_superseded",
      notification: "flow_route_advanced_during_backend_start",
      dispatch: { start_state: "superseded" }
    });
    const snapshot = controller.getFlowSnapshot(started.instance.flow_instance_id);
    expect(snapshot.instance).toMatchObject({ status: "active", current_step_id: "planning" });
    expect(snapshot.steps.filter((step) => step.status === "active")).toEqual([
      expect.objectContaining({ step_id: "planning" })
    ]);
    expect(controller.getAgent(oldStep.agent_id!)).toMatchObject({
      status: "stopped",
      backend_handle: { id: oldStep.agent_id, late_start: true }
    });
    expect(deferredAdapter.stopped).toEqual([
      expect.objectContaining({ id: oldStep.agent_id })
    ]);
  });

  it("cleans a reconciled late worker when the manual route commits immediately after it", async () => {
    const deferredAdapter = new DeferredFakeAdapter("codex-thread");
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Manual route after late recovery", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "manual-route-after-recovery-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          },
          planner: { backend: "fake" }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { to: "planning" } } },
          planning: { role: "planner", on: { reported: { finish: true } } }
        }
      }
    });
    const lateDispatch = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const oldStep = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    store.db
      .prepare("update agent_start_attempts set lease_expires_at = ? where agent_id = ?")
      .run("2000-01-01T00:00:00.000Z", oldStep.agent_id);
    await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });

    startGate.resolve();
    const recovered = await lateDispatch;
    expect(recovered.action).toBe("dispatched");
    expect(
      controller.getFlowSnapshot(started.instance.flow_instance_id).steps[0]?.summary
    ).toMatch(/^Late backend start attempt /);
    await controller.startFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: oldStep.step_instance_id,
      transitionId: "manual-after-late-recovery"
    });
    await controller.drainDeliveries();

    const snapshot = controller.getFlowSnapshot(started.instance.flow_instance_id);
    expect(snapshot.instance).toMatchObject({ status: "active", current_step_id: "planning" });
    expect(snapshot.steps.filter((step) => step.status === "active")).toEqual([
      expect.objectContaining({ step_id: "planning" })
    ]);
    expect(controller.getAgent(oldStep.agent_id!).status).toBe("stopped");
    expect(deferredAdapter.stopped).toHaveLength(1);
  });

  it("never reopens a completed flow when an old ambiguous start returns late", async () => {
    const deferredAdapter = new DeferredFakeAdapter("codex-thread");
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Completed route beats late start", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "completed-route-late-start-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          },
          finisher: { backend: "fake" }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { to: "finish" } } },
          finish: { role: "finisher", on: { reported: { finish: true } } }
        }
      }
    });

    const lateDispatch = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const oldStep = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    store.db
      .prepare("update agent_start_attempts set lease_expires_at = ? where agent_id = ?")
      .run("2000-01-01T00:00:00.000Z", oldStep.agent_id);
    await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });
    const advanced = await controller.startFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      stepId: "finish",
      fromStepInstanceId: oldStep.step_instance_id,
      transitionId: "manual-review-to-finish"
    });
    const finishDispatch = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(finishDispatch.action).toBe("dispatched");
    controller.reportFlowStep({
      stepInstanceId: advanced.active_step!.step_instance_id,
      status: "completed",
      result: {},
      summary: "The replacement route completed."
    });
    expect(controller.getFlowSnapshot(started.instance.flow_instance_id).instance.status).toBe(
      "completed"
    );

    startGate.resolve();
    const lateResult = await lateDispatch;
    expect(lateResult.action).toBe("start_superseded");
    const snapshot = controller.getFlowSnapshot(started.instance.flow_instance_id);
    expect(snapshot.instance).toMatchObject({ status: "completed", current_step_id: null });
    expect(snapshot.steps.filter((step) => step.status === "active")).toEqual([]);
    expect(controller.getAgent(oldStep.agent_id!).status).toBe("stopped");
    expect(deferredAdapter.stopped).toHaveLength(1);
  });

  it("treats a rejected post-invocation start response as ambiguous and never retries it", async () => {
    const deferredAdapter = new DeferredFakeAdapter("codex-thread");
    deferredAdapter.startErrorAfterAccept = new Error(
      "The backend accepted thread/start but its response was lost."
    );
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Rejected start response", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "rejected-start-response-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { finish: true } } }
        }
      }
    });

    const blocked = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(blocked).toMatchObject({
      action: "blocked",
      blocked_reason: "backend_start_ambiguous",
      active_step: { status: "blocked" },
      dispatch: { start_state: "ambiguous" }
    });
    const agentId = blocked.agent!.agent_id;
    expect(store.listAgentStartAttempts(agentId)[0]).toMatchObject({
      phase: "ambiguous",
      error_json: { reason: "backend_start_outcome_ambiguous" }
    });

    const replay = await controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(replay).toMatchObject({
      action: "blocked",
      blocked_reason: "backend_start_ambiguous"
    });
    expect(deferredAdapter.starts).toHaveLength(1);
  });

  it("keeps a stop race pending until a late fresh start handle is compensated", async () => {
    const deferredAdapter = new DeferredFakeAdapter("codex-thread");
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Fresh start stop race", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "fresh-start-stop-race-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { finish: true } } }
        }
      }
    });

    const dispatch = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(deferredAdapter.starts).toHaveLength(1);
    const assigned = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;

    const stopping = await controller.stopAgent(assigned.agent_id!);
    expect(stopping).toMatchObject({ status: "stopping", backend_handle: null });
    expect(deferredAdapter.stopped).toHaveLength(0);

    startGate.resolve();
    await dispatch;
    expect(deferredAdapter.starts).toHaveLength(1);
    expect(deferredAdapter.stopped).toEqual([
      expect.objectContaining({ id: assigned.agent_id })
    ]);
    expect(controller.getAgent(assigned.agent_id!)).toMatchObject({
      status: "stopped",
      backend_handle: { id: assigned.agent_id, late_start: true }
    });
    expect(store.listAgentStartAttempts(assigned.agent_id!)[0]).toMatchObject({
      phase: "succeeded",
      handle_json: { id: assigned.agent_id, late_start: true }
    });
  });

  it("restores a succeeded start handle after restart before compensating stop", async () => {
    const deferredAdapter = new DeferredFakeAdapter("codex-thread");
    const startGate = createDeferred<void>();
    const stopGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    deferredAdapter.stopGate = stopGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Restart-safe late start cleanup", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "restart-safe-late-start-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-thread",
            agent_lifecycle: "fresh_per_step" as const
          }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { finish: true } } }
        }
      }
    });

    const lateDispatch = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const assigned = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    await controller.stopAgent(assigned.agent_id!);
    startGate.resolve();
    for (let turn = 0; turn < 20 && deferredAdapter.stopped.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(deferredAdapter.stopped).toHaveLength(1);
    expect(controller.getAgent(assigned.agent_id!)).toMatchObject({
      status: "stopping",
      backend_handle: { id: assigned.agent_id, late_start: true }
    });
    expect(store.listAgentStartAttempts(assigned.agent_id!)[0]).toMatchObject({
      phase: "succeeded",
      handle_json: { id: assigned.agent_id, late_start: true }
    });

    // Simulate a database produced by the old crash window where only the
    // succeeded attempt retained the handle. Startup must restore it before a
    // handleless stop can incorrectly declare the backend session absent.
    store.db
      .prepare("update agents set backend_handle_json = null where agent_id = ?")
      .run(assigned.agent_id);
    const restartedStore = new SqliteStore(join(tmp, "state.sqlite"));
    const restartedRegistry = new AdapterRegistry();
    const restartedAdapter = new DeferredFakeAdapter("codex-thread");
    restartedRegistry.register(restartedAdapter);
    const restartedController = new AgentController(restartedStore, restartedRegistry);
    expect(restartedController.getAgent(assigned.agent_id!)).toMatchObject({
      status: "stopping",
      backend_handle: { id: assigned.agent_id, late_start: true }
    });
    await restartedController.drainDeliveries();
    expect(restartedController.getAgent(assigned.agent_id!).status).toBe("stopped");
    expect(restartedAdapter.stopped).toEqual([
      expect.objectContaining({ id: assigned.agent_id })
    ]);
    restartedStore.close();

    stopGate.resolve();
    await lateDispatch;
  });

  it("rolls back a handleless non-native stop when its terminal event cannot commit", async () => {
    const run = controller.createRun({ title: "Atomic handleless non-native event" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "handleless non-native worker",
      status: "stopping"
    });
    store.updateRunStatus(run.run_id, "stopping");
    store.db.exec(`
      create trigger reject_handleless_non_native_stopped_event
      before insert on events
      when new.type = 'agent.stopped'
      begin
        select raise(abort, 'test non-native stopped event failure');
      end;
    `);

    await expect(controller.stopAgent(worker.agent_id)).rejects.toThrow(
      /test non-native stopped event failure/
    );
    expect(controller.getAgent(worker.agent_id)).toMatchObject({ status: "stopping" });
    expect(controller.getRun(run.run_id)).toMatchObject({ status: "stopping" });
    expect(controller.listEvents({ agentId: worker.agent_id, type: "agent.stopped" })).toEqual([]);

    store.db.exec("drop trigger reject_handleless_non_native_stopped_event");
    const restartedStore = new SqliteStore(join(tmp, "state.sqlite"));
    const restartedRegistry = new AdapterRegistry();
    restartedRegistry.register(new FakeAdapter());
    const restartedController = new AgentController(restartedStore, restartedRegistry);
    await restartedController.drainDeliveries();

    expect(restartedController.getAgent(worker.agent_id)).toMatchObject({ status: "stopped" });
    expect(restartedController.getRun(run.run_id)).toMatchObject({ status: "stopped" });
    expect(
      restartedController.listEvents({ agentId: worker.agent_id, type: "agent.stopped" })
    ).toHaveLength(1);
    expect(
      restartedController
        .listEvents({ runId: run.run_id, type: "timer.elapsed" })
        .filter((event) => event.payload.action === "run_shutdown_completed")
    ).toHaveLength(1);
    restartedStore.close();
  });

  it("rolls back native handleless cancellation when its terminal event cannot commit", async () => {
    registry.register(new CodexSubagentAdapter());
    const run = controller.createRun({ title: "Atomic handleless native event" });
    const owner = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "terminal native action owner",
      status: "stopped"
    });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "codex-subagent",
      title: "handleless native worker",
      status: "planned"
    });
    const grant = store.createBridgeGrant({
      runId: run.run_id,
      orchestratorAgentId: owner.agent_id,
      ownerTaskPath: "/root",
      tokenHash: "atomic-handleless-native-grant"
    });
    const spawnAction = store.createOrGetOrchestratorAction({
      idempotencyKey: "atomic-handleless-native-spawn",
      runId: run.run_id,
      orchestratorAgentId: owner.agent_id,
      originatingBridgeGrantId: grant.bridge_grant_id,
      agentId: worker.agent_id,
      operation: "spawn_agent",
      payloadJson: { message: "Remain pending until stop wins." }
    })!;
    store.immediateTransaction(() => {
      store.updateRunStatus(run.run_id, "stopping");
      store.updateAgent(worker.agent_id, { status: "stopping" });
    });
    store.db.exec(`
      create trigger reject_handleless_native_stopped_event
      before insert on events
      when new.type = 'agent.stopped'
      begin
        select raise(abort, 'test native stopped event failure');
      end;
    `);

    await expect(controller.stopAgent(worker.agent_id)).rejects.toThrow(
      /test native stopped event failure/
    );
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "stopping",
      work_generation: 1
    });
    expect(controller.getRun(run.run_id)).toMatchObject({ status: "stopping" });
    expect(store.getOrchestratorAction(spawnAction.action_id)).toMatchObject({ status: "pending" });
    expect(controller.listEvents({ agentId: worker.agent_id, type: "agent.stopped" })).toEqual([]);

    store.db.exec("drop trigger reject_handleless_native_stopped_event");
    const restartedStore = new SqliteStore(join(tmp, "state.sqlite"));
    const restartedRegistry = new AdapterRegistry();
    restartedRegistry.register(new CodexSubagentAdapter());
    const restartedController = new AgentController(restartedStore, restartedRegistry);
    await restartedController.drainDeliveries();

    expect(restartedController.getAgent(worker.agent_id)).toMatchObject({
      status: "stopped",
      work_generation: 1
    });
    expect(restartedController.getRun(run.run_id)).toMatchObject({ status: "stopped" });
    expect(restartedStore.getOrchestratorAction(spawnAction.action_id)).toMatchObject({
      status: "cancelled"
    });
    expect(
      restartedController.listEvents({ agentId: worker.agent_id, type: "agent.stopped" })
    ).toHaveLength(1);
    expect(
      restartedController
        .listEvents({ runId: run.run_id, type: "timer.elapsed" })
        .filter((event) => event.payload.action === "run_shutdown_completed")
    ).toHaveLength(1);
    restartedStore.close();
  });

  it("re-drives a persisted stopping worker after restart without a start attempt", async () => {
    const run = controller.createRun({ title: "Restart durable manual cleanup", repoDir: "/repo" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "abandoned reusable worker",
      backendHandle: { id: "abandoned-reusable-worker" },
      status: "running"
    });
    store.updateAgent(worker.agent_id, { status: "stopping" });

    const restartedStore = new SqliteStore(join(tmp, "state.sqlite"));
    const restartedRegistry = new AdapterRegistry();
    const restartedAdapter = new FakeAdapter();
    restartedRegistry.register(restartedAdapter);
    const restartedController = new AgentController(restartedStore, restartedRegistry);
    await restartedController.drainDeliveries();

    expect(restartedController.getAgent(worker.agent_id)).toMatchObject({ status: "stopped" });
    expect(restartedAdapter.stopped).toEqual([
      expect.objectContaining({ id: "abandoned-reusable-worker" })
    ]);
    restartedStore.close();
  });

  it("repairs terminal stopping runs at startup but preserves runs with live agents", async () => {
    const terminalRun = controller.createRun({ title: "Legacy terminal stopping run" });
    const terminalWorker = controller.registerAgent({
      runId: terminalRun.run_id,
      backend: "fake",
      title: "already stopped worker",
      backendHandle: { id: "already-stopped-worker" },
      status: "stopped"
    });
    store.updateRunStatus(terminalRun.run_id, "stopping");

    const liveRun = controller.createRun({ title: "Still-live stopping run" });
    const liveWorker = controller.registerAgent({
      runId: liveRun.run_id,
      backend: "fake",
      title: "still-live worker",
      backendHandle: { id: "still-live-worker" },
      status: "running"
    });
    store.updateRunStatus(liveRun.run_id, "stopping");

    const restartedStore = new SqliteStore(join(tmp, "state.sqlite"));
    const restartedRegistry = new AdapterRegistry();
    const restartedAdapter = new FakeAdapter();
    restartedRegistry.register(restartedAdapter);
    const restartedController = new AgentController(restartedStore, restartedRegistry);
    await restartedController.drainDeliveries();

    expect(restartedController.getAgent(terminalWorker.agent_id).status).toBe("stopped");
    expect(restartedController.getRun(terminalRun.run_id).status).toBe("stopped");
    expect(restartedController.getAgent(liveWorker.agent_id).status).toBe("running");
    expect(restartedController.getRun(liveRun.run_id).status).toBe("stopping");
    expect(restartedAdapter.stopped).toEqual([]);
    expect(
      restartedController
        .listEvents({ runId: terminalRun.run_id, type: "timer.elapsed" })
        .filter((event) => event.payload.action === "run_shutdown_completed")
    ).toHaveLength(1);
    restartedStore.close();
  });

  it("reconciles authoritative OpenCode launch metadata before an expired start can block", async () => {
    const deferredAdapter = new DeferredFakeAdapter("opencode-server");
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Recovered OpenCode launch", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "recovered-opencode-launch-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "opencode-server",
            agent_lifecycle: "fresh_per_step" as const
          }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { finish: true } } }
        }
      }
    });

    const original = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const assigned = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    const runtimeDir = agentRuntimePath(run.run_id, assigned.agent_id!);
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "opencode-launch.json"),
      JSON.stringify({
        id: "recovered-opencode-session",
        server: "http://localhost:53910",
        title: "Recovered OpenCode review"
      }),
      "utf8"
    );
    store.db
      .prepare("update agent_start_attempts set lease_expires_at = ? where agent_id = ?")
      .run("2000-01-01T00:00:00.000Z", assigned.agent_id);

    const restartedStore = new SqliteStore(join(tmp, "state.sqlite"));
    const restartedController = new AgentController(restartedStore, registry);
    const recovered = await restartedController.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(recovered).toMatchObject({
      action: "waiting_for_report",
      active_step: { step_instance_id: assigned.step_instance_id, status: "active" },
      agent: {
        agent_id: assigned.agent_id,
        status: "running",
        backend_handle: { id: "recovered-opencode-session" }
      }
    });
    expect(restartedStore.listAgentStartAttempts(assigned.agent_id!)[0]).toMatchObject({
      phase: "succeeded",
      handle_json: { id: "recovered-opencode-session" }
    });
    expect(restartedController.getFlowSnapshot(started.instance.flow_instance_id).instance.status).toBe(
      "active"
    );
    expect(deferredAdapter.starts).toHaveLength(1);
    restartedStore.close();

    startGate.resolve();
    const originalResult = await original;
    expect(originalResult).toMatchObject({
      action: "dispatched",
      active_step: { step_instance_id: assigned.step_instance_id, status: "active" },
      agent: {
        agent_id: assigned.agent_id,
        status: "running",
        backend_handle: { id: "recovered-opencode-session" }
      },
      dispatch: { start_state: "started" }
    });
    expect(deferredAdapter.starts).toHaveLength(1);
  });

  it("surfaces a recovered start as superseded when its route advances before the owner returns", async () => {
    const deferredAdapter = new DeferredFakeAdapter("opencode-server");
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Recovered start loses route", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "recovered-opencode-superseded-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "opencode-server",
            agent_lifecycle: "fresh_per_step" as const
          },
          planner: { backend: "fake" }
        },
        steps: {
          review: { role: "reviewer", on: { reported: { to: "planning" } } },
          planning: { role: "planner", on: { reported: { finish: true } } }
        }
      }
    });

    const original = controller.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    const oldStep = controller
      .getFlowSnapshot(started.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    const runtimeDir = agentRuntimePath(run.run_id, oldStep.agent_id!);
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "opencode-launch.json"),
      JSON.stringify({
        id: oldStep.agent_id,
        server: "http://localhost:53910",
        title: "Recovered OpenCode review"
      }),
      "utf8"
    );

    const recoveringStore = new SqliteStore(join(tmp, "state.sqlite"));
    const recoveringController = new AgentController(recoveringStore, registry);
    const recovered = await recoveringController.continueFlow({
      flowInstanceId: started.instance.flow_instance_id
    });
    expect(recovered).toMatchObject({
      action: "waiting_for_report",
      active_step: { step_instance_id: oldStep.step_instance_id, status: "active" },
      agent: { agent_id: oldStep.agent_id, status: "running" }
    });
    expect(recoveringStore.listAgentStartAttempts(oldStep.agent_id!)[0]).toMatchObject({
      phase: "succeeded",
      handle_json: { id: oldStep.agent_id }
    });

    const rerouted = await controller.startFlowStep({
      flowInstanceId: started.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: oldStep.step_instance_id,
      transitionId: "manual-after-metadata-recovery"
    });
    expect(rerouted).toMatchObject({
      active_step: { step_id: "planning", status: "active" },
      cleanup: [
        {
          agent_id: oldStep.agent_id,
          status: "stopped",
          orchestrator_action: null
        }
      ]
    });
    expect(deferredAdapter.stopped).toEqual([
      expect.objectContaining({ id: oldStep.agent_id })
    ]);
    // Cleanup no longer depends on the original adapter invocation returning.
    // Its eventual response can still represent a revived session, so it must
    // be compensated a second time without changing the new route.
    startGate.resolve();
    const superseded = await original;
    expect(superseded).toMatchObject({
      action: "start_superseded",
      active_step: { step_id: "planning", status: "active" },
      dispatch: { start_state: "superseded" }
    });
    expect(store.listAgentStartAttempts(oldStep.agent_id!)[0]).toMatchObject({
      phase: "superseded",
      error_json: { reason: "later_flow_step_exists" }
    });
    expect(controller.getAgent(oldStep.agent_id!)).toMatchObject({ status: "stopped" });
    expect(deferredAdapter.stopped).toHaveLength(2);
    const snapshot = controller.getFlowSnapshot(started.instance.flow_instance_id);
    expect(snapshot.instance).toMatchObject({ status: "active", current_step_id: "planning" });
    expect(snapshot.steps.filter((step) => step.status === "active")).toEqual([
      expect.objectContaining({ step_id: "planning" })
    ]);
    recoveringStore.close();
  });

  it("auto-continues reported flow steps without routing through an orchestrator", async () => {
    const run = controller.createRun({ title: "auto flow run", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "auto-flow",
        initial_step: "work",
        roles: {
          worker: { backend: "fake" },
          reviewer: { backend: "fake" }
        },
        steps: {
          work: {
            role: "worker",
            report: {
              schema: {
                required: ["done"],
                properties: { done: { enum: [true] } }
              }
            },
            on: {
              reported: { to: "review" }
            }
          },
          review: {
            role: "reviewer",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const first = await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });
    expect(first.action).toBe("dispatched");
    expect(first.agent?.role).toBe("worker");
    expect(controller.listSubscriptions({ runId: run.run_id })).toHaveLength(0);

    const reported = await controller.reportFlowStepAndContinue({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      result: { done: true },
      summary: "Work done."
    });

    expect(reported.report.active_step?.step_id).toBe("review");
    expect(reported.continuation?.action).toBe("dispatched");
    expect(reported.continuation?.agent?.role).toBe("reviewer");
    expect(adapter.starts).toHaveLength(2);
  });

  it("auto-continues compactly from the MCP flow_step_report handler", async () => {
    const run = controller.createRun({ title: "tool auto flow run", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "tool-auto-flow",
        initial_step: "work",
        roles: {
          worker: { backend: "fake" },
          reviewer: { backend: "fake" }
        },
        steps: {
          work: {
            role: "worker",
            report: {
              schema: {
                required: ["done"],
                properties: { done: { enum: [true] } }
              }
            },
            on: {
              reported: { to: "review" }
            }
          },
          review: {
            role: "reviewer",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });
    await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });

    const response = await handleTool(controller, "flow_step_report", {
      step_instance_id: started.active_step!.step_instance_id,
      status: "completed",
      result: { done: true },
      summary: "Tool report done."
    });

    expect(response).toMatchObject({
      flow_instance_id: started.instance.flow_instance_id,
      flow_status: "active",
      reported_step: {
        step_id: "work",
        status: "completed"
      },
      selected_transition: {
        target_step_id: "review"
      },
      continuation: {
        action: "dispatched",
        agent: {
          role: "reviewer",
          status: "running"
        }
      }
    });
    expect(JSON.stringify(response)).not.toContain("runtime_contract");
    expect(JSON.stringify(response)).not.toContain("tool-auto-flow: worker");
  });

  it("blocks a flow when a terminal worker never reports its step result", async () => {
    const run = controller.createRun({ title: "missing report flow run", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "missing-report-flow",
        initial_step: "work",
        roles: {
          worker: { backend: "fake" }
        },
        steps: {
          work: {
            role: "worker",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const dispatched = await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });
    expect(dispatched.action).toBe("dispatched");
    adapter.statuses.set(dispatched.agent!.agent_id, "completed");

    const blocked = await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id });

    expect(blocked.action).toBe("blocked");
    expect(blocked.blocked_reason).toBe("terminal_agent_missing_flow_report");
    expect(blocked.active_step?.status).toBe("blocked");
    expect(controller.getFlowSnapshot(started.instance.flow_instance_id).instance.status).toBe("blocked");
    expect(controller.listEvents({ runId: run.run_id }).map((event) => event.type)).toContain("flow.step_blocked");
  });

  it("includes flow blocker and notification instructions in subscription notifications", async () => {
    const run = controller.createRun({ title: "flow notification run", repoDir: "/repo" });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "Orchestrator",
      role: "orchestrator"
    });
    await controller.startAgent({ agentId: subscriber.agent_id, prompt: "register visible thread" });
    controller.createSubscription({
      runId: run.run_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "flow.step_started"
    });

    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "notified-flow",
        initial_step: "first",
        steps: {
          first: {}
        }
      }
    });
    await controller.drainDeliveries();

    expect(adapter.sent.at(-1)?.message).toContain(`Flow instance: ${started.instance.flow_instance_id}`);
    expect(adapter.sent.at(-1)?.message).toContain(`Step instance: ${started.active_step?.step_instance_id}`);
    expect(adapter.sent.at(-1)?.message).toContain("do not call `flow_start` again");
    expect(adapter.sent.at(-1)?.message).toContain("Normal flow advancement is handled by Agent Control");
    expect(adapter.sent.at(-1)?.message).not.toContain("Preferred MCP call");
    expect(adapter.sent.at(-1)?.message).not.toContain("flow_dispatch_active");
  });

  it("delivers configured owner feedback when a flow finishes with notify", async () => {
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_finish_notify_test";
    const login = controller.orchestratorLogin({
      adminKey: "ack_finish_notify_test",
      title: "Finish notification orchestrator",
      repoDir: "/repo",
      backend: "fake"
    });
    await controller.startAgent({ agentId: login.agent.agent_id, prompt: "register visible orchestrator" });
    const started = controller.startFlow({
      runId: login.run.run_id,
      agentToken: login.agent_token,
      config: {
        id: "finish-notify-flow",
        initial_step: "final_review",
        steps: {
          final_review: {
            on: {
              reported: {
                finish: true,
                notify: "orchestrator"
              }
            }
          }
        }
      }
    });

    const completed = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      summary: "Final answer is ready."
    });
    await controller.drainDeliveries();

    expect(completed.instance.status).toBe("completed");
    expect(completed.notification).toBe("orchestrator");
    expect(controller.listEvents({ runId: login.run.run_id }).map((event) => event.type)).toEqual(
      expect.arrayContaining(["flow.completed", "flow.notification"])
    );
    expect(adapter.sent.at(-1)?.message).toContain("flow.notification");
    expect(adapter.sent.at(-1)?.message).toContain("Status: completed");
    expect(adapter.sent.at(-1)?.message).toContain("Message: Final answer is ready.");
    expect(adapter.sent.at(-1)?.message).toContain("configured flow notification");
  });

  it("keeps completion feedback within the all-runs supervision boundary", async () => {
    const run = controller.createRun({ title: "First supervised run" });
    const other = controller.createRun({ title: "Other work still pending" });
    const subscriber = controller.registerAgent({ runId: run.run_id, backend: "fake", title: "Conversation", role: "orchestrator" });
    await controller.startAgent({ agentId: subscriber.agent_id, prompt: "Supervise both runs." });
    controller.createSubscription({ runId: run.run_id, subscriberAgentId: subscriber.agent_id, eventType: "flow.completed" });
    const pending = controller.startFlow({ runId: other.run_id, config: { id: "pending", initial_step: "work", steps: { work: {} } } });
    const ending = controller.startFlow({ runId: run.run_id, config: { id: "ending", initial_step: "work", steps: { work: { on: { reported: { finish: true } } } } } });
    controller.reportFlowStep({ stepInstanceId: ending.active_step!.step_instance_id, status: "completed" });
    await controller.drainDeliveries();
    const notification = adapter.sent.at(-1)?.message;
    expect(notification).toContain("update in commentary while any other supervised work remains");
    expect(notification).toContain("only when all supervised work is resolved");
    expect(notification).not.toContain("complete instruction for this short re-entry");
    expect(controller.getFlowSnapshot(pending.instance.flow_instance_id).instance.status).not.toBe("completed");
  });

  it("accepts markdown prompt references for roles and steps", () => {
    const run = controller.createRun({ title: "prompted flow run", repoDir: "/repo" });
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "prompted-flow",
        initial_step: "analysis",
        prompts: {
          analyst_role: {
            path: "prompts/roles/analyst.md",
            description: "Stable analyst behavior."
          },
          analysis_step: {
            path: "prompts/steps/analysis.md",
            description: "Analysis step instructions."
          }
        },
        roles: {
          analyst: {
            prompt_ref: "analyst_role"
          }
        },
        steps: {
          analysis: {
            role: "analyst",
            prompt_ref: "analysis_step",
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    expect(started.active_step?.input_json.prompt_sources).toEqual([
      {
        scope: "role",
        owner_id: "analyst",
        prompt_ref: "analyst_role",
        path: "prompts/roles/analyst.md",
        description: "Stable analyst behavior."
      },
      {
        scope: "step",
        owner_id: "analysis",
        prompt_ref: "analysis_step",
        path: "prompts/steps/analysis.md",
        description: "Analysis step instructions."
      }
    ]);

    const startedEvent = controller
      .listEvents({ runId: run.run_id, type: "flow.step_started" })
      .find((event) => event.payload.step_id === "analysis");
    expect(startedEvent?.payload.prompt_sources).toEqual(started.active_step?.input_json.prompt_sources);
  });

  it("rejects invalid prompt references and non-markdown prompt paths", () => {
    expect(() =>
      controller.validateFlowConfig({
        id: "missing-prompt-ref",
        initial_step: "analysis",
        steps: {
          analysis: {
            prompt_ref: "unknown_prompt"
          }
        }
      })
    ).toThrow(/undefined prompt/);

    expect(() =>
      controller.validateFlowConfig({
        id: "wrong-prompt-extension",
        initial_step: "analysis",
        prompts: {
          analysis_step: {
            path: "prompts/analysis.txt"
          }
        },
        steps: {
          analysis: {
            prompt_ref: "analysis_step"
          }
        }
      })
    ).toThrow(/Markdown/);
  });

  it("blocks a flow step when the result schema or required artifacts are invalid", () => {
    const run = controller.createRun({ title: "blocked flow run" });
    const reportPath = join(tmp, "report.md");
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "schema-gated-flow",
        initial_step: "classify",
        artifacts: {
          report: { path: reportPath }
        },
        steps: {
          classify: {
            outputs: {
              report: { artifact: "report", required: true }
            },
            report: {
              schema: {
                required: ["size"],
                properties: {
                  size: { enum: ["s", "xl"] }
                }
              }
            },
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const blocked = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      result: { size: "m" },
      artifacts: { report: reportPath },
      summary: "Invalid size value."
    });

    expect(blocked.instance.status).toBe("blocked");
    expect(blocked.reported_step.status).toBe("blocked");
    expect(blocked.notification).toBe("blocked");
    expect(controller.listEvents({ runId: run.run_id }).map((event) => event.type)).toContain("flow.step_blocked");
  });

  it("delivers manual orchestrator context to the next step after a notify action", async () => {
    const run = controller.createRun({ title: "manual flow run" });
    const analysisPath = join(tmp, "manual-analysis.md");
    const planPath = join(tmp, "manual-plan.md");
    const started = controller.startFlow({
      runId: run.run_id,
      config: {
        id: "orchestrator-driven-flow",
        initial_step: "analysis",
        artifacts: {
          analysis: { path: analysisPath },
          plan: { path: planPath }
        },
        roles: {
          planner: { backend: "fake" }
        },
        steps: {
          analysis: {
            outputs: {
              analysis: { artifact: "analysis", required: true }
            },
            on: {
              reported: { notify: "orchestrator" }
            }
          },
          planning: {
            role: "planner",
            inputs: {
              analysis: { artifact: "analysis", required: true }
            },
            outputs: {
              plan: { artifact: "plan", required: true }
            },
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    writeFileSync(analysisPath, "analysis ready\n", "utf8");
    const waiting = controller.reportFlowStep({
      stepInstanceId: started.active_step!.step_instance_id,
      status: "completed",
      artifacts: { analysis: analysisPath },
      summary: "Analysis ready for orchestrator routing."
    });

    expect(waiting.instance.status).toBe("waiting_for_orchestrator");
    expect(waiting.notification).toBe("orchestrator");

    const planning = await controller.startFlowStep({
      flowInstanceId: waiting.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: waiting.reported_step.step_instance_id,
      transitionId: "manual-analysis-to-planning",
      reason: "orchestrator approved planning"
    });

    expect(planning.selected_transition?.transition_id).toBe("manual-analysis-to-planning");
    expect(planning.active_step?.step_id).toBe("planning");
    expect(planning.active_step?.input_json).toMatchObject({
      analysis: analysisPath,
      coordinator_context: "orchestrator approved planning",
      runtime_contract: {
        objective_source: "coordinator_context_over_run_title",
        coordinator_context: "orchestrator approved planning"
      }
    });
    const runtimeContract = planning.active_step?.input_json.runtime_contract as Record<string, unknown>;
    expect(String(runtimeContract.objective)).toContain(
      "Latest coordinator context (authoritative wherever it adds, clarifies, or conflicts):\norchestrator approved planning"
    );
    expect(planning.instance.status).toBe("active");

    const dispatched = await controller.continueFlow({ flowInstanceId: planning.instance.flow_instance_id });
    expect(dispatched.action).toBe("dispatched");
    expect(adapter.starts.at(-1)?.prompt).toContain("- Objective source: `coordinator_context_over_run_title`");
    expect(adapter.starts.at(-1)?.prompt).toContain(
      "Latest coordinator context (authoritative wherever it adds, clarifies, or conflicts):\norchestrator approved planning"
    );
  });

  it("projects historical CLI journal usage into dashboard totals without inserting duplicate snapshots", () => {
    registry.register(new CodexCliAdapter());
    const run = controller.createRun({ title: "CLI usage" });
    const agent = controller.registerAgent({runId:run.run_id,backend:"codex-cli",title:"Yoda",status:"completed",backendHandle:{dir:tmp,resolved_model:"yoda"}});
    const journal=join(tmp,"events.jsonl");
    const first=JSON.stringify({type:"agent_control.prompt"}) + "\n" + JSON.stringify({type:"turn.completed",usage:{input_tokens:100,output_tokens:25,cached_input_tokens:90}}) + "\n";
    writeFileSync(journal,first);
    for (let i=0;i<2;i++) {
      const snapshot=controller.getDashboardSnapshot(run.run_id);
      expect(snapshot.computed_agents.find(a=>a.agent_id===agent.agent_id)?.latest_usage).toMatchObject({total_tokens:125,model:"yoda"});
      expect(snapshot.usage_totals.total_tokens).toBe(125);
    }
    writeFileSync(journal,first+first);
    expect(controller.getDashboardSnapshot(run.run_id).usage_totals.total_tokens).toBe(250);
    expect(controller.listUsageSnapshots({agentId:agent.agent_id})).toEqual([]);
    rmSync(journal);
    expect(controller.getDashboardSnapshot(run.run_id).computed_agents[0]?.latest_usage).toBeNull();
  });

  it("records visual links, usage snapshots, and dashboard aggregates", () => {
    const run = controller.createRun({ title: "visual run", repoDir: "/repo" });
    const planner = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "planner",
      status: "completed"
    });
    const implementer = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "implementer",
      status: "running",
      model: "fake-model"
    });

    const link = controller.createAgentLink({
      runId: run.run_id,
      sourceAgentId: implementer.agent_id,
      targetAgentId: planner.agent_id,
      type: "waits_for",
      label: "implementation waits for plan"
    });
    const usage = controller.createUsageSnapshot({
      runId: run.run_id,
      agentId: implementer.agent_id,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      contextUsed: 200,
      contextLimit: 1000,
      source: "fake",
      model: "fake-model"
    });
    const snapshot = controller.getDashboardSnapshot(run.run_id);

    expect(link.type).toBe("waits_for");
    expect(usage.total_tokens).toBe(125);
    expect(snapshot.agent_links).toHaveLength(1);
    expect(snapshot.usage_totals.total_tokens).toBe(125);
    expect(snapshot.status_counts.running).toBe(1);
    expect(snapshot.computed_agents.find((agent) => agent.agent_id === implementer.agent_id)?.latest_usage?.usage_id).toBe(
      usage.usage_id
    );
  });

  it("freezes elapsed time for terminal agents at their last update", () => {
    const run = controller.createRun({ title: "terminal duration run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "completed worker",
      status: "completed"
    });
    const createdAt = "2026-06-11T10:00:00.000Z";
    const updatedAt = "2026-06-11T10:01:00.000Z";
    store.db
      .prepare("update agents set created_at = ?, updated_at = ? where agent_id = ?")
      .run(createdAt, updatedAt, agent.agent_id);

    const snapshot = controller.getDashboardSnapshot(run.run_id);
    const computed = snapshot.computed_agents.find((entry) => entry.agent_id === agent.agent_id);

    expect(computed?.is_terminal).toBe(true);
    expect(computed?.elapsed_ms).toBe(60_000);
  });

  it("does not fail queued or waiting agents that are only registered for visibility", async () => {
    const run = controller.createRun({ title: "visibility-only run" });
    const queued = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "future reviewer",
      status: "queued"
    });
    const waiting = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "coordinator",
      status: "waiting_for_input"
    });

    await controller.pollActiveAgents(run.run_id);

    expect(controller.getAgent(queued.agent_id).status).toBe("queued");
    expect(controller.getAgent(waiting.agent_id).status).toBe("waiting_for_input");
  });

  it("reads OpenCode latest output passively when the server is unavailable", async () => {
    const opencodeAdapter = new OpenCodeServerAdapter();
    const runtimeDir = join(tmp, "opencode-passive-read");
    mkdirSync(runtimeDir, { recursive: true });
    const logFile = join(runtimeDir, "opencode.log");
    writeFileSync(logFile, "last visible worker line\n", "utf8");

    const messages = await opencodeAdapter.readLatest(
      {
        backend: "opencode-server",
        id: "agent-opencode",
        data: {
          server: "http://localhost:1",
          model: "opencode-go/deepseek-v4-pro",
          title: "passive read",
          repoDir: "/repo",
          pidFile: join(runtimeDir, "opencode.pid"),
          logFile,
          exitFile: join(runtimeDir, "opencode-exit.json"),
          metadataFile: join(runtimeDir, "opencode-launch.json"),
          expectedArtifacts: []
        }
      },
      { limit: 5 }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.metadata?.source).toBe("opencode-log-tail");
    expect(messages[0]?.text).toContain("last visible worker line");
  });

  it("delivers completion events to subscribers", async () => {
    const run = controller.createRun({ title: "test run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      objective: "React to worker completion.",
      backendHandle: { id: "orchestrator-handle" },
      status: "completed"
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.completed"
    });
    adapter.statuses.set("worker-handle", "completed");

    await controller.refreshAgentStatus(worker.agent_id);
    await controller.drainDeliveries();

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.message).toContain("Agent Control notification");
    expect(adapter.sent[0]?.message).toContain("agent.completed");
    expect(adapter.sent[0]?.message).toContain(`Source agent: worker (${worker.agent_id})`);
    expect(adapter.sent[0]?.message).toContain("Status: completed");
    expect(adapter.sent[0]?.message).toContain("React to worker completion.");
    expect(adapter.sent[0]?.message.trim().startsWith("{")).toBe(false);
    expect(controller.getAgent(orchestrator.agent_id)).toMatchObject({
      status: "running",
      work_generation: 1
    });
  });

  it("discards a refresh captured during the same successful subscription attempt", async () => {
    const subscriberAdapter = new DeferredFakeAdapter("same-attempt-subscription-success");
    registry.register(subscriberAdapter);
    const run = controller.createRun({ title: "Same-attempt subscription success" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "subscription source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: subscriberAdapter.kind,
      title: "successful subscriber",
      backendHandle: { id: "same-attempt-subscription-success" },
      status: "completed"
    });
    const subscription = controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "same_attempt_success" }
    });
    const deliveryController = controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    };
    const sendGate = createDeferred<void>();
    subscriberAdapter.sendGate = sendGate;

    const delivery = deliveryController.deliverSubscriptions(sourceEvent);
    expect(subscriberAdapter.sent).toHaveLength(1);
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "running",
      work_generation: 1,
      work_revision: 1
    });

    subscriberAdapter.statuses.set("same-attempt-subscription-success", "completed");
    const statusGate = createDeferred<void>();
    subscriberAdapter.statusGate = statusGate;
    const staleRefresh = controller.refreshAgentStatus(subscriber.agent_id);
    expect(subscriberAdapter.statusReads).toBe(1);

    sendGate.resolve();
    await delivery;
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "running",
      work_generation: 1,
      work_revision: 2
    });
    expect(controller.listSubscriptions({ runId: run.run_id })[0]).toMatchObject({
      subscription_id: subscription.subscription_id,
      last_delivered_event_id: sourceEvent.event_id
    });

    statusGate.resolve();
    await expect(staleRefresh).resolves.toMatchObject({
      status: "running",
      work_generation: 1,
      work_revision: 2
    });
    expect(
      controller.listEvents({ agentId: subscriber.agent_id, type: "agent.completed" })
    ).toEqual([]);
    expect(
      (controller as unknown as { statusWatchers: Map<string, unknown> }).statusWatchers.has(
        subscriber.agent_id
      )
    ).toBe(true);

    subscriberAdapter.statusGate = null;
    await controller.stopAgent(subscriber.agent_id);
  });

  it("defers a terminal refresh while subscription delivery still owns adapter I/O", async () => {
    const subscriberAdapter = new DeferredFakeAdapter("invoking-subscription-refresh");
    registry.register(subscriberAdapter);
    const run = controller.createRun({ title: "Invoking subscription refresh" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "invoking subscription source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: subscriberAdapter.kind,
      title: "invoking subscription target",
      backendHandle: { id: "invoking-subscription-target" },
      status: "running"
    });
    controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "invoking_subscription_refresh" }
    });
    const sendGate = createDeferred<void>();
    subscriberAdapter.sendGate = sendGate;

    const delivery = (controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    }).deliverSubscriptions(sourceEvent);
    expect(subscriberAdapter.sent).toHaveLength(1);
    subscriberAdapter.statuses.set("invoking-subscription-target", "completed");

    await expect(controller.refreshAgentStatus(subscriber.agent_id)).resolves.toMatchObject({
      status: "running",
      work_generation: 1,
      work_revision: 1
    });
    expect(
      controller.listEvents({ agentId: subscriber.agent_id, type: "agent.completed" })
    ).toEqual([]);

    await controller.stopAgent(subscriber.agent_id);
    sendGate.resolve();
    await delivery;

    expect(subscriberAdapter.stopped).toHaveLength(2);
    expect(subscriberAdapter.statuses.get("invoking-subscription-target")).toBe("stopped");
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "stopped",
      work_generation: 1,
      work_revision: 2
    });
    expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)).toMatchObject({
      status: "delivered",
      claim_attempt: 1
    });
  });

  it("recovers an expired delivery owner after restart without duplicate delivery", async () => {
    const run = controller.createRun({ title: "Restarted abandoned delivery" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "abandoned delivery source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "abandoned delivery subscriber",
      backendHandle: { id: "abandoned-delivery-subscriber" },
      status: "running"
    });
    controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "abandoned_delivery_restart" }
    });
    const claimOwnerId = "delivery-controller-that-crashed";
    const claim = store.claimSubscriptionDelivery({
      eventId: sourceEvent.event_id,
      subscriberAgentId: subscriber.agent_id,
      claimOwnerId
    });
    const acceptanceKey =
      `subscription-delivery:${sourceEvent.event_id}:${subscriber.agent_id}:attempt:${claim.delivery.claim_attempt}`;
    const began = store.beginSubscriptionDeliveryAttempt({
      eventId: sourceEvent.event_id,
      subscriberAgentId: subscriber.agent_id,
      claimOwnerId,
      claimAttempt: claim.delivery.claim_attempt,
      acceptanceKey,
      acceptanceLeaseExpiresAt: "2000-01-01T00:00:00.000Z"
    });
    expect(began).toMatchObject({
      type: "began",
      agent: { work_generation: 1, work_revision: 1 }
    });

    await adapter.sendMessage(
      {
        backend: "fake",
        id: "abandoned-delivery-subscriber",
        data: { id: "abandoned-delivery-subscriber" }
      },
      { message: "Possibly delivered before the process crashed." }
    );
    adapter.statuses.set("abandoned-delivery-subscriber", "running");
    expect(adapter.sent).toHaveLength(1);

    store.close();
    store = new SqliteStore(join(tmp, "state.sqlite"));
    registry = new AdapterRegistry();
    registry.register(adapter);
    controller = new AgentController(store, registry);

    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "unknown",
      work_generation: 1,
      work_revision: 2
    });
    expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)).toMatchObject({
      status: "ambiguous",
      claim_attempt: 1,
      claim_owner_id: null,
      last_error: {
        reason: "delivery_outcome_ambiguous_after_owner_lease_expired",
        acceptance_key: acceptanceKey
      }
    });
    expect(
      controller.listEvents({
        agentId: subscriber.agent_id,
        type: "agent.delivery_failed"
      })
    ).toEqual([
      expect.objectContaining({
        run_id: run.run_id,
        agent_id: subscriber.agent_id,
        type: "agent.delivery_failed",
        payload: {
          source_event_id: sourceEvent.event_id,
          subscriber_agent_id: subscriber.agent_id,
          delivery_claim_attempt: 1,
          status: "ambiguous",
          reason: "delivery_outcome_ambiguous_after_owner_lease_expired"
        }
      })
    ]);

    await (controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    }).deliverSubscriptions(sourceEvent);
    expect(adapter.sent).toHaveLength(1);
    expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)?.status).toBe(
      "ambiguous"
    );

    await controller.refreshAgentStatus(subscriber.agent_id);
    await controller.stopAgent(subscriber.agent_id);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.stopped).toHaveLength(1);
  });

  it("discards a refresh captured during the same ambiguous subscription attempt", async () => {
    const subscriberAdapter = new DeferredFakeAdapter("same-attempt-subscription-ambiguous");
    registry.register(subscriberAdapter);
    const sendGate = createDeferred<void>();
    const lostResponse = new Error("Subscription work was accepted but the response was lost.");
    subscriberAdapter.sendGate = sendGate;
    subscriberAdapter.sendErrorAfterAccept = lostResponse;
    const run = controller.createRun({ title: "Same-attempt subscription ambiguity" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "ambiguous subscription source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: subscriberAdapter.kind,
      title: "ambiguous subscriber",
      backendHandle: { id: "same-attempt-subscription-ambiguous" },
      status: "completed"
    });
    controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "same_attempt_ambiguity" }
    });
    const deliveryController = controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    };

    const delivery = deliveryController.deliverSubscriptions(sourceEvent);
    expect(subscriberAdapter.sent).toHaveLength(1);
    subscriberAdapter.statuses.set("same-attempt-subscription-ambiguous", "completed");
    const statusGate = createDeferred<void>();
    subscriberAdapter.statusGate = statusGate;
    const staleRefresh = controller.refreshAgentStatus(subscriber.agent_id);
    expect(subscriberAdapter.statusReads).toBe(1);

    sendGate.resolve();
    await delivery;
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "unknown",
      failure_reason: "unknown",
      work_generation: 1,
      work_revision: 2
    });
    expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)).toMatchObject({
      status: "pending",
      claim_attempt: 1
    });

    statusGate.resolve();
    await expect(staleRefresh).resolves.toMatchObject({
      status: "unknown",
      work_generation: 1,
      work_revision: 2
    });
    expect(
      (controller as unknown as { statusWatchers: Map<string, unknown> }).statusWatchers.has(
        subscriber.agent_id
      )
    ).toBe(true);
    expect(
      controller.listEvents({ agentId: subscriber.agent_id, type: "agent.completed" })
    ).toEqual([]);

    subscriberAdapter.statusGate = null;
    subscriberAdapter.sendErrorAfterAccept = null;
    await controller.stopAgent(subscriber.agent_id);
  });

  it("fences a stale stopped refresh while a stop-won subscription delivery is compensated", async () => {
    const subscriberAdapter = new DeferredFakeAdapter("subscriber-fake");
    registry.register(subscriberAdapter);
    const run = controller.createRun({ title: "Accepted subscription stale-refresh fence" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "completion source",
      backendHandle: { id: "subscription-source" },
      status: "running"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: subscriberAdapter.kind,
      title: "stop-won subscriber",
      backendHandle: { id: "stop-won-subscriber" },
      status: "running"
    });
    controller.createSubscription({
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });

    subscriberAdapter.statuses.set("stop-won-subscriber", "stopped");
    const statusGate = createDeferred<void>();
    subscriberAdapter.statusGate = statusGate;
    const staleRefresh = controller.refreshAgentStatus(subscriber.agent_id);
    expect(subscriberAdapter.statusReads).toBe(1);

    const sendGate = createDeferred<void>();
    const stopGate = createDeferred<void>();
    subscriberAdapter.sendGate = sendGate;
    subscriberAdapter.stopGate = stopGate;
    adapter.statuses.set("subscription-source", "completed");
    await controller.refreshAgentStatus(source.agent_id);
    for (let turn = 0; turn < 20 && subscriberAdapter.sent.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(subscriberAdapter.sent).toHaveLength(1);
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "running",
      work_generation: 1
    });

    store.immediateTransaction(() => {
      store.updateRunStatus(run.run_id, "stopping");
      store.updateAgent(subscriber.agent_id, { status: "stopping" });
    });
    sendGate.resolve();
    for (let turn = 0; turn < 20 && subscriberAdapter.stopped.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(subscriberAdapter.stopped).toHaveLength(1);
    expect(subscriberAdapter.statuses.get("stop-won-subscriber")).toBe("running");
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "stopping",
      work_generation: 1
    });

    statusGate.resolve();
    await expect(staleRefresh).resolves.toMatchObject({
      status: "stopping",
      work_generation: 1
    });
    expect(
      controller.listEvents({ agentId: subscriber.agent_id, type: "agent.stopped" })
    ).toEqual([]);

    stopGate.resolve();
    await controller.drainDeliveries();
    expect(subscriberAdapter.statuses.get("stop-won-subscriber")).toBe("stopped");
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "stopped",
      work_generation: 1
    });
    expect(controller.getRun(run.run_id).status).toBe("stopped");
  });

  it("advances a new refresh fence for every physical subscription retry", async () => {
    const subscriberAdapter = new DeferredFakeAdapter("retrying-subscriber-fake");
    const retryGate = createDeferred<void>();
    const lostResponse = new Error("The first subscription attempt was accepted but its response was lost.");
    subscriberAdapter.sendGates = [null, retryGate];
    subscriberAdapter.sendErrorsAfterAccept = [lostResponse, null];
    registry.register(subscriberAdapter);
    const run = controller.createRun({ title: "Physical subscription retry fences" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "retry event source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: subscriberAdapter.kind,
      title: "retrying subscriber",
      backendHandle: { id: "retrying-subscriber" },
      status: "running"
    });
    const subscription = controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "physical_retry_test" }
    });
    const deliveryController = controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    };

    await deliveryController.deliverSubscriptions(sourceEvent);
    expect(subscriberAdapter.sent).toHaveLength(1);
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "unknown",
      work_generation: 1,
      work_revision: 2
    });
    expect(controller.listSubscriptions({ runId: run.run_id })[0]).toMatchObject({
      subscription_id: subscription.subscription_id,
      last_delivered_event_id: null
    });

    subscriberAdapter.statuses.set("retrying-subscriber", "completed");
    const statusGate = createDeferred<void>();
    subscriberAdapter.statusGate = statusGate;
    const staleRefresh = controller.refreshAgentStatus(subscriber.agent_id);
    expect(subscriberAdapter.statusReads).toBe(1);

    const retry = deliveryController.deliverSubscriptions(sourceEvent);
    for (let turn = 0; turn < 20 && subscriberAdapter.sent.length < 2; turn += 1) {
      await Promise.resolve();
    }
    expect(subscriberAdapter.sent).toHaveLength(2);
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "running",
      work_generation: 2
    });
    const attempts = store.db
      .prepare(
        `select acceptance_key, work_generation
         from agent_work_acceptances
         where agent_id = ? and acceptance_key like 'subscription-delivery:%'
         order by work_generation asc`
      )
      .all(subscriber.agent_id) as Array<{
        acceptance_key: string;
        work_generation: number;
      }>;
    expect(attempts).toEqual([
      {
        acceptance_key: expect.stringContaining(":attempt:1"),
        work_generation: 1
      },
      {
        acceptance_key: expect.stringContaining(":attempt:2"),
        work_generation: 2
      }
    ]);
    expect(attempts[0]?.acceptance_key).not.toBe(attempts[1]?.acceptance_key);

    statusGate.resolve();
    await expect(staleRefresh).resolves.toMatchObject({
      status: "running",
      work_generation: 2
    });
    expect(
      controller.listEvents({ agentId: subscriber.agent_id, type: "agent.completed" })
    ).toEqual([]);

    retryGate.resolve();
    await retry;
    expect(subscriberAdapter.statuses.get("retrying-subscriber")).toBe("running");
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "running",
      work_generation: 2,
      work_revision: 4
    });
    expect(controller.listSubscriptions({ runId: run.run_id })[0]).toMatchObject({
      subscription_id: subscription.subscription_id,
      last_delivered_event_id: sourceEvent.event_id
    });
    expect(store.getEvent(sourceEvent.event_id)).toEqual(sourceEvent);
    expect(
      controller
        .listEvents({ runId: run.run_id, type: "agent.delivery_failed" })
        .filter((event) => event.payload.source_event_id === sourceEvent.event_id)
    ).toHaveLength(1);

    subscriberAdapter.statusGate = null;
    await controller.stopAgent(subscriber.agent_id);
  });

  it("delivers one message when duplicate subscriptions match the same subscriber event", async () => {
    const run = controller.createRun({ title: "duplicate subscription run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      objective: "React once.",
      backendHandle: { id: "orchestrator-handle" },
      status: "running"
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.completed"
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.completed"
    });
    adapter.statuses.set("worker-handle", "completed");

    await controller.refreshAgentStatus(worker.agent_id);
    await controller.drainDeliveries();

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.message).toContain("agent.completed");
  });

  it("records manual subscription delivery as unsupported without projecting work", async () => {
    registry.register(new ManualAdapter());
    const run = controller.createRun({ title: "Unsupported manual subscription" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "manual delivery source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: "manual",
      title: "manual subscriber",
      backendHandle: { id: "manual-subscriber", status: "waiting_for_input" },
      status: "waiting_for_input"
    });
    const subscription = controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "manual_unsupported" }
    });

    await (controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    }).deliverSubscriptions(sourceEvent);

    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "waiting_for_input",
      failure_reason: null,
      work_generation: 0,
      work_revision: 0
    });
    expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)).toMatchObject({
      status: "failed",
      claim_attempt: 1,
      last_error: { reason: "subscriber_cannot_receive_messages" }
    });
    expect(controller.listSubscriptions({ runId: run.run_id })[0]).toMatchObject({
      subscription_id: subscription.subscription_id,
      last_delivered_event_id: null
    });
    expect(
      controller
        .listEvents({ agentId: subscriber.agent_id, type: "agent.delivery_failed" })
        .map((event) => event.payload.reason)
    ).toEqual(["subscriber_cannot_receive_messages"]);
    expect(
      store.db
        .prepare("select count(*) as count from agent_work_acceptances where agent_id = ?")
        .get(subscriber.agent_id)
    ).toMatchObject({ count: 0 });
  });

  it("fails Codex subagent subscriptions visibly instead of invoking the native adapter directly", async () => {
    registry.register(new CodexSubagentAdapter());
    const run = controller.createRun({ title: "Unsupported native subscription" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "native delivery source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: "codex-subagent",
      title: "native subscriber without direct delivery",
      status: "waiting_for_input"
    });
    const subscription = controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "native_unsupported" }
    });

    await (controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    }).deliverSubscriptions(sourceEvent);

    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "waiting_for_input",
      failure_reason: null,
      work_generation: 0,
      work_revision: 0
    });
    expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)).toMatchObject({
      status: "failed",
      claim_attempt: 1,
      last_error: { reason: "subscriber_requires_orchestrator_action" }
    });
    expect(controller.listSubscriptions({ runId: run.run_id })[0]).toMatchObject({
      subscription_id: subscription.subscription_id,
      last_delivered_event_id: null
    });
    expect(
      controller
        .listEvents({ agentId: subscriber.agent_id, type: "agent.delivery_failed" })
        .map((event) => event.payload.reason)
    ).toEqual(["subscriber_requires_orchestrator_action"]);
    expect(store.listOrchestratorActions()).toEqual([]);
    expect(
      store.db
        .prepare("select count(*) as count from agent_work_acceptances where agent_id = ?")
        .get(subscriber.agent_id)
    ).toMatchObject({ count: 0 });
  });

  it("does not cross delivery I/O when stop wins between claim and begin", async () => {
    const subscriberAdapter = new NoopWatchingDeferredFakeAdapter(
      "delivery-stop-before-begin"
    );
    registry.register(subscriberAdapter);
    const run = controller.createRun({ title: "Stopped claimed delivery" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "stopped delivery source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: subscriberAdapter.kind,
      title: "stopped delivery subscriber",
      backendHandle: { id: "delivery-stop-before-begin" },
      status: "running"
    });
    controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "stop_between_claim_and_begin" }
    });
    const secondStore = new SqliteStore(join(tmp, "state.sqlite"));
    const originalBegin = store.beginSubscriptionDeliveryAttempt.bind(store);

    vi.spyOn(store, "beginSubscriptionDeliveryAttempt").mockImplementation((input) => {
      // `claimSubscriptionDelivery` has already committed. A separate process
      // now wins stop before this controller can record the invocation phase.
      secondStore.immediateTransaction(() => {
        secondStore.updateAgent(subscriber.agent_id, { status: "stopping" });
      });
      return originalBegin(input);
    });

    try {
      await (controller as unknown as {
        deliverSubscriptions(event: EventRecord): Promise<void>;
      }).deliverSubscriptions(sourceEvent);

      expect(subscriberAdapter.sent).toEqual([]);
      expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
        status: "stopping",
        work_generation: 0,
        work_revision: 0
      });
      expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)).toMatchObject({
        status: "failed",
        claim_attempt: 1,
        last_error: { reason: "durable_stop_intent" }
      });
      expect(
        store.db
          .prepare("select count(*) as count from agent_work_acceptances where agent_id = ?")
          .get(subscriber.agent_id)
      ).toMatchObject({ count: 0 });
    } finally {
      secondStore.close();
    }
  });

  it("coalesces duplicate subscriptions across concurrent controllers", async () => {
    const subscriberAdapter = new NoopWatchingDeferredFakeAdapter(
      "cross-controller-subscriber"
    );
    registry.register(subscriberAdapter);
    const run = controller.createRun({ title: "Cross-controller logical delivery" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "cross-controller source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: subscriberAdapter.kind,
      title: "cross-controller subscriber",
      backendHandle: { id: "cross-controller-subscriber" },
      status: "completed"
    });
    controller.createSubscription({
      runId: run.run_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    controller.createSubscription({
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "cross_controller_delivery" }
    });

    const secondStore = new SqliteStore(join(tmp, "state.sqlite"));
    const secondRegistry = new AdapterRegistry();
    secondRegistry.register(subscriberAdapter);
    const secondController = new AgentController(secondStore, secondRegistry);
    const sendGate = createDeferred<void>();
    subscriberAdapter.sendGate = sendGate;
    const firstDelivery = (controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    }).deliverSubscriptions(sourceEvent);
    const secondDelivery = (secondController as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    }).deliverSubscriptions(sourceEvent);

    expect(subscriberAdapter.sent).toHaveLength(1);
    expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)).toMatchObject({
      status: "invoking",
      claim_attempt: 1
    });
    sendGate.resolve();
    await Promise.all([firstDelivery, secondDelivery]);

    expect(subscriberAdapter.sent).toHaveLength(1);
    expect(
      controller
        .listSubscriptions()
        .filter((candidate) => candidate.subscriber_agent_id === subscriber.agent_id)
        .map((candidate) => candidate.last_delivered_event_id)
    ).toEqual([sourceEvent.event_id, sourceEvent.event_id]);
    expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)).toMatchObject({
      status: "delivered",
      claim_attempt: 1
    });
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "running",
      work_generation: 1,
      work_revision: 2
    });
    expect(
      store.db
        .prepare("select count(*) as count from events where event_id = ?")
        .get(sourceEvent.event_id)
    ).toMatchObject({ count: 1 });

    await controller.stopAgent(subscriber.agent_id);
    secondStore.close();
  });

  it("reclaims only a stale pre-invocation logical delivery after restart", async () => {
    const run = controller.createRun({ title: "Stale prepared delivery recovery" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "stale delivery source",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "recovered subscriber",
      backendHandle: { id: "recovered-subscriber" },
      status: "completed"
    });
    controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "stale_pre_invocation_claim" }
    });
    const abandoned = store.claimSubscriptionDelivery({
      eventId: sourceEvent.event_id,
      subscriberAgentId: subscriber.agent_id,
      claimOwnerId: "controller_that_exited_before_invocation"
    });
    expect(abandoned).toMatchObject({
      claimed: true,
      delivery: { status: "claimed", claim_attempt: 1 }
    });
    store.db
      .prepare(
        `update subscription_deliveries
         set claimed_at = ?, updated_at = ?
         where event_id = ? and subscriber_agent_id = ?`
      )
      .run(
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
        sourceEvent.event_id,
        subscriber.agent_id
      );

    await (controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    }).deliverSubscriptions(sourceEvent);

    expect(adapter.sent).toHaveLength(1);
    expect(store.getSubscriptionDelivery(sourceEvent.event_id, subscriber.agent_id)).toMatchObject({
      status: "delivered",
      claim_attempt: 2
    });
    expect(
      store.db
        .prepare(
          `select acceptance_key, work_generation
           from agent_work_acceptances
           where agent_id = ? and acceptance_key like 'subscription-delivery:%'`
        )
        .get(subscriber.agent_id)
    ).toMatchObject({
      acceptance_key: expect.stringContaining(":attempt:2"),
      work_generation: 1
    });

    await controller.stopAgent(subscriber.agent_id);
  });

  it("requires Codex thread subscribers to use native delivery for visible wakeups", async () => {
    const codexAdapter = new FakeAdapter("codex-thread");
    registry.register(codexAdapter);
    const run = controller.createRun({ title: "codex subscriber run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "codex-thread",
      title: "orchestrator",
      objective: "Ask the user whether to continue.",
      backendHandle: { thread_id: "thread-visible", id: "thread-visible" },
      status: "waiting_for_input"
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.completed"
    });
    adapter.statuses.set("worker-handle", "completed");

    await controller.refreshAgentStatus(worker.agent_id);
    await controller.drainDeliveries();

    expect(codexAdapter.sent).toHaveLength(1);
    expect(codexAdapter.sent[0]?.message).toContain("Codex Desktop visibility note");
    expect(codexAdapter.sent[0]?.message).toContain("Target Codex thread: thread-visible");
    expect(codexAdapter.sent[0]?.message).toContain("start with a short human-readable assistant update");
    expect(codexAdapter.sent[0]?.message).toContain("Do not try to force-refresh this same active turn");
    expect(codexAdapter.sent[0]?.message).not.toContain("codex_app.read_thread");
    expect(codexAdapter.sent[0]?.message).not.toContain("codex_app.send_message_to_thread");
  });

  it("retries terminal notifications when a Codex thread is temporarily busy", async () => {
    const codexAdapter = new DeferredFakeAdapter("codex-thread");
    codexAdapter.sendErrorsAfterAccept = [
      new Error("The current Codex turn is still writing the target thread."),
      null
    ];
    registry.register(codexAdapter);
    controller = new AgentController(store, registry, null, {
      codexThreadDeliveryRetryDelaysMs: [0, 1]
    });

    const run = controller.createRun({ title: "Codex terminal notification retry" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "completed worker",
      status: "completed"
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: "codex-thread",
      title: "Codex coordinator",
      backendHandle: { thread_id: "busy-thread" },
      status: "waiting_for_input"
    });
    const subscription = controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });
    const sourceEvent = store.createEvent({
      runId: run.run_id,
      agentId: source.agent_id,
      type: "agent.completed",
      payload: { status: "completed", reason: "codex_thread_busy" }
    });

    await (controller as unknown as {
      deliverSubscriptions(event: EventRecord): Promise<void>;
    }).deliverSubscriptions(sourceEvent);
    await controller.drainDeliveries();

    expect(codexAdapter.sent).toHaveLength(2);
    expect(controller.getAgent(subscriber.agent_id)).toMatchObject({
      status: "running",
      work_generation: 2
    });
    expect(controller.listSubscriptions({ runId: run.run_id })[0]).toMatchObject({
      subscription_id: subscription.subscription_id,
      last_delivered_event_id: sourceEvent.event_id
    });
    expect(
      controller
        .listEvents({ runId: run.run_id, type: "agent.delivery_failed" })
        .filter((event) => event.payload.source_event_id === sourceEvent.event_id)
    ).toHaveLength(1);

    await controller.stopAgent(subscriber.agent_id);
  });

  it("sends compact goal confirmation prompts through the owning agent", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });
    const goal = controller.createGoal({
      agentId: agent.agent_id,
      objective: "finish the phase"
    });

    const result = await controller.confirmGoal(goal.goal_id);

    expect(result.delivered).toBe(true);
    expect(adapter.sent[0]?.message).toContain("finish the phase");
    expect(buildGoalConfirmationPrompt("x")).toContain("complete");
  });

  it("adds the Codex native delivery reminder to goal confirmations for Codex threads", async () => {
    const codexAdapter = new FakeAdapter("codex-thread");
    registry.register(codexAdapter);
    const run = controller.createRun({ title: "codex goal run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "codex-thread",
      title: "orchestrator",
      backendHandle: { thread_id: "thread-goal", id: "thread-goal" },
      status: "waiting_for_input"
    });
    const goal = controller.createGoal({
      agentId: agent.agent_id,
      objective: "supervise until final review is resolved"
    });

    await controller.confirmGoal(goal.goal_id);

    expect(codexAdapter.sent).toHaveLength(1);
    expect(codexAdapter.sent[0]?.message).toContain("supervise until final review is resolved");
    expect(codexAdapter.sent[0]?.message).toContain("Target Codex thread: thread-goal");
    expect(codexAdapter.sent[0]?.message).toContain("Codex Desktop visibility note");
  });

  it("does not create a heartbeat when registering a goal", () => {
    const run = controller.createRun({ title: "goal without heartbeat run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      backendHandle: { id: "orchestrator-handle" },
      status: "waiting_for_input"
    });

    controller.createGoal({
      agentId: agent.agent_id,
      objective: "supervise until complete"
    });

    const heartbeats = controller.listHeartbeats(agent.agent_id);
    expect(heartbeats).toHaveLength(0);
  });

  it("defers goal confirmation until active descendants are terminal", async () => {
    const run = controller.createRun({ title: "goal run" });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      backendHandle: { id: "orchestrator-handle" },
      status: "running"
    });
    const child = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "child worker",
      backendHandle: { id: "child-handle" },
      status: "running"
    });
    controller.createAgentLink({
      runId: run.run_id,
      sourceAgentId: orchestrator.agent_id,
      targetAgentId: child.agent_id,
      type: "parent_child"
    });
    const goal = controller.createGoal({
      agentId: orchestrator.agent_id,
      objective: "finish the orchestrated task"
    });

    const deferred = await controller.confirmGoal(goal.goal_id);

    expect(deferred.deferred).toBe(true);
    expect(deferred.delivered).toBe(false);
    expect(deferred.active_descendants.map((agent) => agent.agent_id)).toEqual([child.agent_id]);
    expect(adapter.sent).toHaveLength(0);

    adapter.statuses.set("child-handle", "completed");
    const confirmed = await controller.waitForGoalConfirmation(goal.goal_id, { intervalMs: 1, timeoutMs: 100 });

    expect(confirmed).toMatchObject({ timed_out: false, confirmed: true });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.handle.id).toBe("orchestrator-handle");
    expect(adapter.sent[0]?.message).toContain("finish the orchestrated task");
  });

  it("keeps stop and unregister as separate operations", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "running"
    });

    const stopped = await controller.stopAgent(agent.agent_id);
    const unregistered = await controller.unregisterAgent(agent.agent_id);

    expect(stopped.status).toBe("stopped");
    expect(unregistered.unregistered_at).not.toBeNull();
    expect(controller.listAgents({ runId: run.run_id })).toHaveLength(0);
    expect(controller.listAgents({ runId: run.run_id, includeUnregistered: true })).toHaveLength(1);
  });

  it("keeps an ordinary first stop failure terminal when no durable cleanup intent exists", async () => {
    const deferredAdapter = new DeferredFakeAdapter();
    deferredAdapter.stopErrorAtCall = 1;
    adapter = deferredAdapter;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Ordinary stop failure" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "ordinary stop worker",
      backendHandle: { id: "ordinary-stop-worker" },
      status: "running"
    });

    const failed = await controller.stopAgent(worker.agent_id);

    expect(failed).toMatchObject({ status: "failed", failure_reason: "unknown" });
    expect(deferredAdapter.stopped).toHaveLength(1);
    expect(
      controller.listEvents({ agentId: worker.agent_id, type: "agent.failed" })
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: "Deferred adapter compensating stop failed.",
          reason: "unknown"
        })
      })
    ]);
  });

  it("awaits non-native bulk shutdown while preserving terminal stop results", async () => {
    const run = controller.createRun({ title: "bulk stop run" });
    const first = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "first worker",
      backendHandle: { id: "bulk-first" },
      status: "running"
    });
    const second = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "second worker",
      backendHandle: { id: "bulk-second" },
      status: "running"
    });

    const shutdown = await controller.shutdownRun(run.run_id);

    expect(shutdown).toMatchObject({
      run: { status: "stopped" },
      complete: true,
      pending_agent_ids: [],
      orchestrator_actions: []
    });
    expect(shutdown.stopped.map((agent) => agent.agent_id)).toEqual([
      first.agent_id,
      second.agent_id
    ]);
    expect(shutdown.stopped.every((agent) => agent.status === "stopped")).toBe(true);
  });

  it("finalizes a failed shutdown when startup redrive later stops the last worker", async () => {
    const initialAdapter = new DeferredFakeAdapter();
    initialAdapter.stopErrorAtCall = 1;
    adapter = initialAdapter;
    registry.register(initialAdapter);
    const run = controller.createRun({ title: "Restart-finalized shutdown" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: initialAdapter.kind,
      title: "shutdown retry worker",
      backendHandle: { id: "shutdown-retry-worker" },
      status: "running"
    });

    const firstShutdown = await controller.shutdownRun(run.run_id);
    expect(firstShutdown).toMatchObject({
      run: { status: "stopping" },
      complete: false,
      pending_agent_ids: [worker.agent_id],
      stopped: [
        {
          agent_id: worker.agent_id,
          status: "stopping",
          failure_reason: "unknown"
        }
      ]
    });

    const restartedStore = new SqliteStore(join(tmp, "state.sqlite"));
    const restartedRegistry = new AdapterRegistry();
    const restartedAdapter = new FakeAdapter();
    restartedRegistry.register(restartedAdapter);
    const restartedController = new AgentController(restartedStore, restartedRegistry);
    await restartedController.drainDeliveries();

    expect(restartedAdapter.stopped).toEqual([
      expect.objectContaining({ id: "shutdown-retry-worker" })
    ]);
    expect(restartedController.getAgent(worker.agent_id)).toMatchObject({
      status: "stopped",
      failure_reason: null
    });
    expect(restartedController.getRun(run.run_id)).toMatchObject({ status: "stopped" });
    expect(
      restartedController
        .listEvents({ runId: run.run_id, type: "timer.elapsed" })
        .filter((event) => event.payload.action === "run_shutdown_completed")
    ).toHaveLength(1);
    restartedStore.close();
  });

  it("rolls back a terminal agent projection when run finalization cannot commit", async () => {
    const run = controller.createRun({ title: "Atomic terminal stop projection" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "atomic stop worker",
      backendHandle: { id: "atomic-stop-worker" },
      status: "running"
    });
    store.updateRunStatus(run.run_id, "stopping");
    store.db.exec(`
      create trigger reject_test_run_finalization
      before update of status on runs
      when new.status = 'stopped'
      begin
        select raise(abort, 'test run finalization failure');
      end;
    `);

    await expect(controller.stopAgent(worker.agent_id)).rejects.toThrow(
      /test run finalization failure/
    );
    expect(controller.getAgent(worker.agent_id)).toMatchObject({ status: "stopping" });
    expect(controller.getRun(run.run_id)).toMatchObject({ status: "stopping" });
    expect(
      controller.listEvents({ agentId: worker.agent_id, type: "agent.stopped" })
    ).toEqual([]);

    store.db.exec("drop trigger reject_test_run_finalization");
    const retried = await controller.stopAgent(worker.agent_id);
    expect(retried).toMatchObject({ status: "stopped", failure_reason: null });
    expect(controller.getRun(run.run_id)).toMatchObject({ status: "stopped" });
  });

  it("keeps an accepted terminal-agent send inspectable when its response is lost", async () => {
    const deferredAdapter = new DeferredFakeAdapter();
    adapter = deferredAdapter;
    registry.register(deferredAdapter);
    const sendGate = createDeferred<void>();
    const lostResponse = new Error("The backend accepted the terminal follow-up but lost its response.");
    deferredAdapter.sendGate = sendGate;
    deferredAdapter.sendErrorAfterAccept = lostResponse;
    const run = controller.createRun({ title: "Terminal direct-send ambiguity" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "completed follow-up worker",
      backendHandle: { id: "completed-follow-up-worker" },
      status: "completed"
    });
    deferredAdapter.statuses.set("completed-follow-up-worker", "completed");

    const send = controller.sendMessage(worker.agent_id, "Start another physical turn.");
    expect(deferredAdapter.sent).toHaveLength(1);
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "running",
      failure_reason: null,
      work_generation: 1
    });

    sendGate.resolve();
    await expect(send).rejects.toBe(lostResponse);
    expect(deferredAdapter.statuses.get("completed-follow-up-worker")).toBe("running");
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "unknown",
      failure_reason: "unknown",
      work_generation: 1
    });
    expect(
      controller
        .listEvents({ agentId: worker.agent_id, type: "agent.status_changed" })
        .filter((event) => event.payload.reason === "backend_send_outcome_ambiguous")
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          work_generation: 1,
          adapter_error: lostResponse.message
        })
      })
    ]);
    expect(
      (controller as unknown as { statusWatchers: Map<string, unknown> }).statusWatchers.has(
        worker.agent_id
      )
    ).toBe(true);

    await expect(controller.refreshAgentStatus(worker.agent_id)).resolves.toMatchObject({
      status: "running",
      failure_reason: null,
      work_generation: 1
    });
    deferredAdapter.sendErrorAfterAccept = null;
    await controller.stopAgent(worker.agent_id);
  });

  it("fences a stale stopped refresh while a stop-won send is compensated", async () => {
    const deferredAdapter = new DeferredFakeAdapter();
    adapter = deferredAdapter;
    registry.register(deferredAdapter);
    const run = controller.createRun({ title: "Accepted send stale-refresh fence" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "accepted send worker",
      backendHandle: { id: "accepted-send-worker" },
      status: "running"
    });

    deferredAdapter.statuses.set("accepted-send-worker", "stopped");
    const statusGate = createDeferred<void>();
    deferredAdapter.statusGate = statusGate;
    const staleRefresh = controller.refreshAgentStatus(worker.agent_id);
    expect(deferredAdapter.statusReads).toBe(1);

    const sendGate = createDeferred<void>();
    const stopGate = createDeferred<void>();
    deferredAdapter.sendGate = sendGate;
    deferredAdapter.stopGate = stopGate;
    const send = controller.sendMessage(worker.agent_id, "Revive after durable stop wins.");
    expect(deferredAdapter.sent).toHaveLength(1);
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "running",
      work_generation: 1
    });

    // Model a durable shutdown winner without completing backend cleanup. The
    // accepted send may now revive the physical session, but its fence already
    // makes the older terminal observation stale while status stays stopping.
    store.immediateTransaction(() => {
      store.updateRunStatus(run.run_id, "stopping");
      store.updateAgent(worker.agent_id, { status: "stopping" });
    });
    sendGate.resolve();
    for (let turn = 0; turn < 20 && deferredAdapter.stopped.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(deferredAdapter.stopped).toHaveLength(1);
    expect(deferredAdapter.statuses.get("accepted-send-worker")).toBe("running");
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "stopping",
      work_generation: 1
    });

    statusGate.resolve();
    await expect(staleRefresh).resolves.toMatchObject({
      status: "stopping",
      work_generation: 1
    });
    expect(controller.listEvents({ agentId: worker.agent_id, type: "agent.stopped" })).toEqual([]);

    stopGate.resolve();
    await expect(send).resolves.toMatchObject({
      delivered: true,
      agent: { status: "stopped", work_generation: 1 }
    });
    expect(deferredAdapter.statuses.get("accepted-send-worker")).toBe("stopped");
    expect(controller.getRun(run.run_id).status).toBe("stopped");
  });

  it("preserves stop intent when a non-native send resolves after shutdown", async () => {
    const deferredAdapter = new DeferredFakeAdapter();
    adapter = deferredAdapter;
    registry.register(deferredAdapter);
    const sendGate = createDeferred<void>();
    deferredAdapter.sendGate = sendGate;
    const run = controller.createRun({ title: "late send completion run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "late send worker",
      backendHandle: { id: "late-send-worker" },
      status: "running"
    });

    const send = controller.sendMessage(worker.agent_id, "Complete after shutdown.");
    expect(deferredAdapter.sent).toHaveLength(1);
    const shutdown = await controller.shutdownRun(run.run_id);
    expect(shutdown).toMatchObject({ run: { status: "stopped" }, complete: true });
    expect(deferredAdapter.stopped).toHaveLength(1);
    expect(deferredAdapter.statuses.get("late-send-worker")).toBe("stopped");

    sendGate.resolve();
    const result = await send;
    expect(result).toMatchObject({ delivered: true, agent: { status: "stopped" } });
    expect(deferredAdapter.stopped).toHaveLength(2);
    expect(deferredAdapter.statuses.get("late-send-worker")).toBe("stopped");
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "stopped",
      work_generation: 1
    });
    expect(controller.getRun(run.run_id).status).toBe("stopped");
  });

  it("compensates an accepted non-native send whose response rejects after shutdown", async () => {
    const deferredAdapter = new DeferredFakeAdapter();
    adapter = deferredAdapter;
    registry.register(deferredAdapter);
    const sendGate = createDeferred<void>();
    const lostResponse = new Error("The backend accepted the message but lost its response.");
    deferredAdapter.sendGate = sendGate;
    deferredAdapter.sendErrorAfterAccept = lostResponse;
    const run = controller.createRun({ title: "uncertain rejected send run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "uncertain rejected send worker",
      backendHandle: { id: "uncertain-rejected-send-worker" },
      status: "running"
    });

    const send = controller.sendMessage(worker.agent_id, "Reactivate, then lose the response.");
    const shutdown = await controller.shutdownRun(run.run_id);
    expect(shutdown).toMatchObject({ run: { status: "stopped" }, complete: true });
    expect(deferredAdapter.stopped).toHaveLength(1);

    sendGate.resolve();
    await expect(send).rejects.toBe(lostResponse);
    expect(deferredAdapter.stopped).toHaveLength(2);
    expect(deferredAdapter.statuses.get("uncertain-rejected-send-worker")).toBe(
      "stopped"
    );
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "stopped",
      work_generation: 1
    });
    expect(controller.getRun(run.run_id).status).toBe("stopped");
  });

  it("preserves an ambiguous non-native rejection while exposing possible work", async () => {
    const deferredAdapter = new DeferredFakeAdapter();
    adapter = deferredAdapter;
    registry.register(deferredAdapter);
    const rejection = new Error("Normal backend send failure.");
    deferredAdapter.sendErrorAfterAccept = rejection;
    const run = controller.createRun({ title: "normal rejected send run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "normal rejected send worker",
      backendHandle: { id: "normal-rejected-send-worker" },
      status: "running"
    });

    await expect(
      controller.sendMessage(worker.agent_id, "Reject without a concurrent stop.")
    ).rejects.toBe(rejection);
    expect(deferredAdapter.stopped).toEqual([]);
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "unknown",
      failure_reason: "unknown",
      work_generation: 1
    });
    expect(controller.getRun(run.run_id).status).toBe("active");
    deferredAdapter.sendErrorAfterAccept = null;
    await controller.stopAgent(worker.agent_id);
  });

  it("keeps late non-native send cleanup unresolved when compensating stop fails", async () => {
    const deferredAdapter = new DeferredFakeAdapter();
    adapter = deferredAdapter;
    registry.register(deferredAdapter);
    const sendGate = createDeferred<void>();
    deferredAdapter.sendGate = sendGate;
    deferredAdapter.stopErrorAtCall = 2;
    const run = controller.createRun({ title: "late send failed cleanup run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "late send failed cleanup worker",
      backendHandle: { id: "late-send-failed-cleanup-worker" },
      status: "running"
    });

    const send = controller.sendMessage(worker.agent_id, "Reactivate after shutdown.");
    const shutdown = await controller.shutdownRun(run.run_id);
    expect(shutdown).toMatchObject({ run: { status: "stopped" }, complete: true });

    sendGate.resolve();
    const result = await send;
    expect(result).toMatchObject({
      delivered: true,
      agent: { status: "stopping", failure_reason: "unknown" }
    });
    expect(deferredAdapter.stopped).toHaveLength(2);
    expect(deferredAdapter.statuses.get("late-send-failed-cleanup-worker")).toBe(
      "running"
    );
    expect(controller.getAgent(worker.agent_id).status).toBe("stopping");
    expect(controller.getRun(run.run_id).status).toBe("stopping");
  });

  it("compensates a non-native start that returns a live handle after shutdown", async () => {
    const deferredAdapter = new DeferredFakeAdapter();
    adapter = deferredAdapter;
    registry.register(deferredAdapter);
    const startGate = createDeferred<void>();
    deferredAdapter.startGate = startGate;
    const run = controller.createRun({ title: "late start completion run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: deferredAdapter.kind,
      title: "late start worker",
      status: "planned"
    });

    const start = controller.startAgent({ agentId: worker.agent_id, prompt: "Start slowly." });
    expect(deferredAdapter.starts).toHaveLength(1);
    const shutdown = await controller.shutdownRun(run.run_id);
    expect(shutdown).toMatchObject({ run: { status: "stopped" }, complete: true });

    startGate.resolve();
    const result = await start;
    expect(result).toMatchObject({
      status: "stopped",
      backend_handle: { id: worker.agent_id, late_start: true }
    });
    expect(deferredAdapter.stopped).toEqual([
      expect.objectContaining({ id: worker.agent_id })
    ]);
    expect(controller.getAgent(worker.agent_id)).toMatchObject({
      status: "stopped",
      backend_handle: { id: worker.agent_id, late_start: true }
    });
    expect(controller.getRun(run.run_id).status).toBe("stopped");
  });

  it("finalizes an asynchronous non-native shutdown after a terminal status refresh", async () => {
    adapter.stopStatus = "stopping";
    const run = controller.createRun({ title: "asynchronous stop run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "asynchronous worker",
      backendHandle: { id: "asynchronous-worker" },
      status: "running"
    });

    const shutdown = await controller.shutdownRun(run.run_id);
    expect(shutdown).toMatchObject({ run: { status: "stopping" }, complete: false });

    adapter.statuses.set("asynchronous-worker", "stopped");
    const refreshed = await controller.refreshAgentStatus(worker.agent_id);

    expect(refreshed.status).toBe("stopped");
    expect(controller.getRun(run.run_id).status).toBe("stopped");
  });

  it("preserves task ownership during backend disconnect and reconciles on recovery", async () => {
    const run = controller.createRun({ title: "recover connection" });
    const worker = controller.registerAgent({ runId: run.run_id, backend: "fake", title: "worker",
      backendHandle: { id: "recovering-worker" }, status: "running" });
    adapter.statusError = new ControllerError("offline", "backend_unavailable");
    const disconnected = await controller.refreshAgentStatus(worker.agent_id);
    expect(disconnected.status).toBe("running");
    expect(disconnected.backend_handle).toEqual(worker.backend_handle);
    expect(controller.listEvents({agentId: worker.agent_id, type: "agent.failed"})).toHaveLength(0);
    adapter.statusError = null;
    adapter.statuses.set("recovering-worker", "completed");
    expect((await controller.refreshAgentStatus(worker.agent_id)).status).toBe("completed");
    expect(adapter.starts).toHaveLength(0);
    expect(adapter.sent).toHaveLength(0);
  });

  it("keeps an asynchronous shutdown pending when status refresh fails", async () => {
    adapter.stopStatus = "stopping";
    const run = controller.createRun({ title: "failed status refresh run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "failed refresh worker",
      backendHandle: { id: "failed-refresh-worker" },
      status: "running"
    });

    const shutdown = await controller.shutdownRun(run.run_id);
    expect(shutdown).toMatchObject({ run: { status: "stopping" }, complete: false });

    adapter.statusError = new Error("Backend status endpoint failed.");
    const refreshed = await controller.refreshAgentStatus(worker.agent_id);

    expect(refreshed).toMatchObject({ status: "stopping", failure_reason: "unknown" });
    expect(controller.getRun(run.run_id).status).toBe("stopping");
    expect(
      controller
        .listEvents({ agentId: worker.agent_id, type: "agent.status_changed" })
        .filter((event) => event.payload.reason === "status_refresh_failed_during_cleanup")
    ).toHaveLength(1);

    adapter.statusError = null;
    adapter.statuses.set("failed-refresh-worker", "stopped");
    const terminal = await controller.refreshAgentStatus(worker.agent_id);
    expect(terminal).toMatchObject({ status: "stopped", failure_reason: null });
    expect(controller.getRun(run.run_id).status).toBe("stopped");
  });

  it("purges one agent rows and controller-owned runtime files", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      backendHandle: { id: "worker-handle" },
      status: "stopped"
    });
    mkdirSync(agentRuntimePath(run.run_id, agent.agent_id), { recursive: true });
    controller.createHeartbeat({ agentId: agent.agent_id, idleTimeoutMs: 1_000 });
    controller.createGoal({ agentId: agent.agent_id, objective: "done" });
    controller.createArtifact({
      runId: run.run_id,
      agentId: agent.agent_id,
      label: "outside",
      path: join(tmp, "outside-artifact.md")
    });
    controller.createAgentLink({
      runId: run.run_id,
      sourceAgentId: agent.agent_id,
      targetAgentId: agent.agent_id,
      type: "parent_child"
    });
    controller.createUsageSnapshot({
      runId: run.run_id,
      agentId: agent.agent_id,
      totalTokens: 10
    });
    controller.createSubscription({
      sourceAgentId: agent.agent_id,
      subscriberAgentId: agent.agent_id,
      eventType: "agent.completed"
    });
    controller.startFlow({
      runId: run.run_id,
      config: {
        id: "agent-purge-flow",
        initial_step: "tracked_step",
        steps: {
          tracked_step: {
            agent_id: agent.agent_id,
            on: {
              reported: { notify: "orchestrator" }
            }
          }
        }
      }
    });
    await controller.unregisterAgent(agent.agent_id);

    const result = await controller.agentPurge(agent.agent_id);

    expect(result.purged_agents).toContain(agent.agent_id);
    expect(result.deleted_rows.agents).toBe(1);
    expect(result.deleted_rows.goals).toBe(1);
    expect(result.deleted_rows.heartbeats).toBe(1);
    expect(result.deleted_rows.artifacts).toBe(1);
    expect(result.deleted_rows.agent_links).toBe(1);
    expect(result.deleted_rows.usage_snapshots).toBe(1);
    expect(result.deleted_rows.subscriptions).toBe(1);
    expect(result.deleted_rows.flow_step_instances).toBe(1);
    expect(existsSync(agentRuntimePath(run.run_id, agent.agent_id))).toBe(false);
    expect(controller.listAgents({ runId: run.run_id, includeUnregistered: true })).toHaveLength(0);
    expect(store.listGoals(agent.agent_id)).toHaveLength(0);
  });

  it("purges one run rows and controller-owned runtime files", async () => {
    const run = controller.createRun({ title: "test run" });
    const first = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "first",
      status: "stopped"
    });
    const second = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "second",
      status: "completed"
    });
    mkdirSync(runRuntimePath(run.run_id), { recursive: true });
    controller.createHeartbeat({ agentId: first.agent_id, idleTimeoutMs: 1_000 });
    controller.createGoal({ agentId: second.agent_id, objective: "done" });
    controller.createArtifact({
      runId: run.run_id,
      agentId: first.agent_id,
      label: "report",
      path: join(tmp, "repo-report.md")
    });
    controller.createAgentLink({
      runId: run.run_id,
      sourceAgentId: first.agent_id,
      targetAgentId: second.agent_id,
      type: "handoff"
    });
    controller.createUsageSnapshot({
      runId: run.run_id,
      agentId: second.agent_id,
      totalTokens: 42
    });
    controller.startFlow({
      runId: run.run_id,
      config: {
        id: "run-purge-flow",
        initial_step: "visible_step",
        steps: {
          visible_step: {
            agent_id: first.agent_id,
            on: {
              reported: { finish: true }
            }
          }
        }
      }
    });

    const result = await controller.runPurge(run.run_id);

    expect(result.purged_runs).toEqual([run.run_id]);
    expect(result.purged_agents.sort()).toEqual([first.agent_id, second.agent_id].sort());
    expect(result.deleted_rows.runs).toBe(1);
    expect(result.deleted_rows.agents).toBe(2);
    expect(result.deleted_rows.agent_links).toBe(1);
    expect(result.deleted_rows.usage_snapshots).toBe(1);
    expect(result.deleted_rows.flows).toBe(1);
    expect(result.deleted_rows.flow_instances).toBe(1);
    expect(result.deleted_rows.flow_step_instances).toBe(1);
    expect(existsSync(runRuntimePath(run.run_id))).toBe(false);
    expect(controller.listAgents({ runId: run.run_id, includeUnregistered: true })).toHaveLength(0);
    expect(() => controller.getRun(run.run_id)).toThrow(/Run not found/);
  });

  it("refuses to purge active agents unless forced", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "running",
      backendHandle: { id: "worker-handle" }
    });

    await expect(controller.agentPurge(agent.agent_id)).rejects.toThrow(/Refusing to purge/);

    const preview = await controller.agentPurge(agent.agent_id, { dryRun: true });
    expect(preview.deleted_rows.agents).toBe(1);

    const result = await controller.agentPurge(agent.agent_id, { force: true });
    expect(result.purged_agents).toEqual([agent.agent_id]);
  });

  it("refuses to purge when stop_first cannot stop an active agent", async () => {
    adapter.stopStatus = "stopping";
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "running",
      backendHandle: { id: "worker-handle" }
    });

    await expect(
      controller.runPurge(run.run_id, { stopFirst: true, force: true })
    ).rejects.toThrow(/stop_first did not stop/);
    expect(controller.getAgent(agent.agent_id).status).toBe("stopping");
  });

  it("does not deliver stop events while purging a run with stop_first", async () => {
    const run = controller.createRun({ title: "cleanup run" });
    const worker = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "running",
      backendHandle: { id: "worker-handle" }
    });
    const orchestrator = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "orchestrator",
      status: "waiting_for_input",
      backendHandle: { id: "orchestrator-handle" }
    });
    controller.createSubscription({
      sourceAgentId: worker.agent_id,
      subscriberAgentId: orchestrator.agent_id,
      eventType: "agent.stopped"
    });

    await controller.runPurge(run.run_id, { stopFirst: true, force: true });
    await controller.drainDeliveries();

    expect(adapter.sent).toHaveLength(0);
  });

  it.each(["provider/explicit-model", undefined])("recovers OpenCode runtime handles without inventing a model (%s)", async (model) => {
    const opencodeAdapter = new FakeAdapter("opencode-server");
    registry.register(opencodeAdapter);
    const run = controller.createRun({ title: "opencode run", repoDir: "/repo" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "opencode-server",
      title: "implementation",
      repoDir: "/repo",
      model,
      status: "running"
    });
    const runtimePath = agentRuntimePath(run.run_id, agent.agent_id);
    mkdirSync(runtimePath, { recursive: true });
    const pidFile = join(runtimePath, "opencode.pid");
    const logFile = join(runtimePath, "opencode.log");
    const metadataFile = join(runtimePath, "opencode-launch.json");
    writeFileSync(pidFile, "12345\n", "utf8");
    writeFileSync(
      metadataFile,
      JSON.stringify({
        server: "http://localhost:53910",
        model,
        title: "implementation",
        repoDir: "/repo",
        pidFile,
        logFile,
        expectedArtifacts: [join(tmp, "implementation-report.md")]
      }),
      "utf8"
    );

    const result = await controller.runPurge(run.run_id, { stopFirst: true });

    expect(opencodeAdapter.stopped).toHaveLength(1);
    expect(opencodeAdapter.stopped[0]?.data.model).toBe(model ?? "");
    expect(opencodeAdapter.stopped[0]?.data.pidFile).toBe(pidFile);
    expect(result.purged_runs).toEqual([run.run_id]);
    expect(existsSync(runRuntimePath(run.run_id))).toBe(false);
    expect(() => controller.getRun(run.run_id)).toThrow(/Run not found/);
  });

  it("rejects OpenCode continuation without a known model before accessing the backend", async () => {
    const opencodeAdapter = new OpenCodeServerAdapter();
    await expect(opencodeAdapter.sendMessage({ backend: "opencode-server", id: "unknown-model", data: { model: "" } }, { message: "Continue." })).rejects.toThrow(/provider\/model format/);
  });

  it("requires explicit debug opt-in for MCP blocking waits", async () => {
    const run = controller.createRun({ title: "wait run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "running",
      backendHandle: { id: "worker-handle" }
    });

    await expect(
      handleTool(controller, "agent_wait", {
        agent_id: agent.agent_id,
        interval_ms: 1,
        timeout_ms: 1
      })
    ).rejects.toThrow(/Blocking waits are disabled/);
    await expect(
      handleTool(controller, "agent_wait", {
        agent_id: agent.agent_id,
        interval_ms: 1,
        timeout_ms: 1,
        allow_blocking_wait: true
      })
    ).resolves.toMatchObject({ timed_out: true });
  });

  it("returns a matching subscription event when direct delivery is unavailable", async () => {
    registry.register(new ManualAdapter());
    const run = controller.createRun({ title: "subscription wakeup run" });
    const source = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "running",
      backendHandle: { id: "worker-handle" }
    });
    const subscriber = controller.registerAgent({
      runId: run.run_id,
      backend: "manual",
      title: "coordinator",
      role: "orchestrator",
      status: "waiting_for_input",
      backendHandle: { status: "waiting_for_input" }
    });
    adapter.statuses.set("worker-handle", "completed");
    const subscription = controller.createSubscription({
      runId: run.run_id,
      sourceAgentId: source.agent_id,
      subscriberAgentId: subscriber.agent_id,
      eventType: "agent.completed"
    });

    const result = await handleTool(controller, "subscription_wait", {
      subscription_id: subscription.subscription_id,
      allow_blocking_wait: true,
      interval_ms: 1,
      timeout_ms: 100
    });

    expect(result).toMatchObject({
      timed_out: false,
      matched: true,
      delivered: false,
      event: { type: "agent.completed", agent_id: source.agent_id }
    });
    expect(
      controller
        .listSubscriptions({})
        .find((entry) => entry.subscription_id === subscription.subscription_id)
        ?.last_delivered_event_id
    ).toBeNull();
  });

  it("dry-runs purge without deleting rows or runtime files", async () => {
    const run = controller.createRun({ title: "test run" });
    const agent = controller.registerAgent({
      runId: run.run_id,
      backend: "fake",
      title: "worker",
      status: "stopped"
    });
    mkdirSync(agentRuntimePath(run.run_id, agent.agent_id), { recursive: true });

    const result = await controller.agentPurge(agent.agent_id, { dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.deleted_rows.agents).toBe(1);
    expect(result.deleted_runtime_paths).toContain(agentRuntimePath(run.run_id, agent.agent_id));
    expect(existsSync(agentRuntimePath(run.run_id, agent.agent_id))).toBe(true);
    expect(controller.getAgent(agent.agent_id).agent_id).toBe(agent.agent_id);
  });

  it("purges old stopped runs and old unregistered agents only", async () => {
    const oldStoppedRun = controller.createRun({ title: "old stopped" });
    const oldStoppedAgent = controller.registerAgent({
      runId: oldStoppedRun.run_id,
      backend: "fake",
      title: "old stopped agent",
      status: "stopped"
    });
    const oldActiveRun = controller.createRun({ title: "old active" });
    const oldUnregisteredAgent = controller.registerAgent({
      runId: oldActiveRun.run_id,
      backend: "fake",
      title: "old unregistered agent",
      status: "stopped"
    });
    const freshRun = controller.createRun({ title: "fresh stopped" });
    const freshAgent = controller.registerAgent({
      runId: freshRun.run_id,
      backend: "fake",
      title: "fresh agent",
      status: "stopped"
    });
    await controller.unregisterAgent(oldUnregisteredAgent.agent_id);
    store.updateRunStatus(oldStoppedRun.run_id, "stopped");
    store.updateRunStatus(freshRun.run_id, "stopped");
    const oldIso = new Date(Date.now() - 10 * 86_400_000).toISOString();
    store.db.prepare("update runs set updated_at = ? where run_id = ?").run(oldIso, oldStoppedRun.run_id);
    store.db
      .prepare("update agents set unregistered_at = ?, updated_at = ? where agent_id = ?")
      .run(oldIso, oldIso, oldUnregisteredAgent.agent_id);

    const result = await controller.maintenancePurgeOld({
      olderThanMs: 7 * 86_400_000,
      dryRun: false,
      stopFirst: false,
      force: false,
      deleteRuntimeFiles: true
    });

    expect(result.purged_runs).toEqual([oldStoppedRun.run_id]);
    expect(result.purged_agents).toContain(oldStoppedAgent.agent_id);
    expect(result.purged_agents).toContain(oldUnregisteredAgent.agent_id);
    expect(controller.getRun(oldActiveRun.run_id).run_id).toBe(oldActiveRun.run_id);
    expect(controller.getRun(freshRun.run_id).run_id).toBe(freshRun.run_id);
    expect(controller.getAgent(freshAgent.agent_id).agent_id).toBe(freshAgent.agent_id);
  });

  it("refuses to delete runtime paths outside the controller runs root", async () => {
    const now = new Date().toISOString();
    store.db
      .prepare(
        "insert into runs (run_id, title, repo_dir, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run("..", "path traversal", null, "stopped", now, now);
    store.db
      .prepare(
        `insert into agents (
          agent_id, run_id, backend, title, role, objective, repo_dir, model,
          backend_handle_json, status, failure_reason, unregistered_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("agent_escape", "..", "fake", "escape", null, null, null, null, null, "stopped", null, null, now, now);

    const result = await controller.runPurge("..");

    expect(result.skipped_runtime_paths.some((path) => path.includes("outside controller runtime root"))).toBe(
      true
    );
  });
});
