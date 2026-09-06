import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AgentController } from "../src/core/controller.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import type { AgentAdapter } from "../src/core/types.js";

describe("controller disposal", () => {
  let directory: string, store: SqliteStore, controller: AgentController, adapter: AgentAdapter;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agent-control-dispose-"));
    vi.stubEnv("AGENT_CONTROL_HOME", directory); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "dispose-admin");
    vi.stubEnv("CODEX_THREAD_ID", "");
    store = new SqliteStore(join(directory, "state.sqlite"));
    adapter = { kind: "fake", capabilities: () => ({ canStart: true, canSendMessage: true, canReadLatest: true,
      canStopGracefully: true, canForceStop: false, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: true }),
      start: async ({agent}) => ({ backend: "fake", id: agent.agent_id, data: { id: agent.agent_id } }),
      getStatus: vi.fn(async () => ({ status: "running" as const })), readLatest: async () => [], sendMessage: async () => {},
      stop: vi.fn(async () => ({ status: "stopped" as const })) };
    const registry = new AdapterRegistry(); registry.register(adapter); controller = new AgentController(store, registry);
  });
  afterEach(async () => { await controller.dispose(); if (store.db.open) store.close(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, {recursive:true,force:true}); });
  async function worker() {
    const run = controller.createRun({title:"Dispose check",adminKey:"dispose-admin"});
    const agent = controller.registerAgent({runId:run.run_id,backend:"fake",title:"Worker"});
    return controller.startAgent({agentId:agent.agent_id,prompt:"Work"});
  }
  it("cancels future status timers and preserves durable workers when the store closes", async () => {
    vi.useFakeTimers(); const started = await worker();
    const calls = vi.mocked(adapter.getStatus).mock.calls.length;
    await Promise.all([controller.dispose(), controller.dispose()]);
    expect(controller.getAgent(started.agent_id).status).toBe("running");
    store.close(); await vi.advanceTimersByTimeAsync(30_001);
    expect(adapter.getStatus).toHaveBeenCalledTimes(calls); expect(adapter.stop).not.toHaveBeenCalled();
  });
  it("waits for an in-flight status refresh before allowing SQLite to close", async () => {
    const started = await worker();
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>(r => { entered = r; });
    adapter.getStatus = async () => { entered(); await new Promise<void>(r => { release = r; }); return {status:"completed"}; };
    controller.runBackground(() => controller.refreshAgentStatus(started.agent_id)); await began;
    let disposed = false; const closing = controller.dispose().then(() => { disposed = true; });
    await Promise.resolve(); expect(disposed).toBe(false);
    release(); await closing;
    expect(controller.getAgent(started.agent_id).status).toBe("completed");
    const ignored = vi.fn(async () => {}); controller.runBackground(ignored); await Promise.resolve(); expect(ignored).not.toHaveBeenCalled();
  });
  it("keeps supervising later flow phases when the first worker has finished", async () => {
    const owner = controller.orchestratorLogin({ title: "Owner", backend: "fake", adminKey: "dispose-admin" });
    const start = controller.startFlow({ runId: owner.run.run_id, agentToken: owner.agent_token, config: {
      id: "multi-phase-supervision", initial_step: "first", roles: { first: { backend: "fake" }, second: { backend: "fake" } },
      steps: { first: { role: "first", prompt: "First", on: { reported: { to: "second" } } },
        second: { role: "second", prompt: "Second", on: { reported: { finish: true } } } }
    } });
    const first = await controller.continueFlow({ flowInstanceId: start.instance.flow_instance_id, agentToken: owner.agent_token });
    const watch = controller.waitForFlowTerminal(start.instance.flow_instance_id, { intervalMs: 1, timeoutMs: 80 });
    const next = await controller.reportFlowStepAndContinue({ stepInstanceId: start.active_step!.step_instance_id,
      status: "completed", result: {} });
    const second = next.continuation!.agent!;
    adapter.getStatus = async handle => ({ status: handle.id === second.agent_id ? "failed" : "completed" });
    const result = await watch;
    expect(first.agent!.agent_id).not.toBe(second.agent_id);
    expect(controller.getAgent(second.agent_id).status).toBe("failed");
    expect(controller.listEvents({ runId: owner.run.run_id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.failed", agent_id: second.agent_id })
    ]));
    expect(result.timed_out).toBe(true);
  });

});
