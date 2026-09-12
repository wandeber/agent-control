import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentController } from "../src/core/controller.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import type { AgentAdapter, AgentStatus, StopResult } from "../src/core/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("recoverable turn interruption authority", () => {
  let controller: AgentController, store: SqliteStore, workerId: string;
  let gate: ReturnType<typeof deferred<StopResult>>, state: AgentStatus, stopCalls: number;
  beforeEach(() => {
    store = new SqliteStore(":memory:"); state = "running"; stopCalls = 0; gate = deferred<StopResult>();
    const adapters = new AdapterRegistry();
    const adapter: AgentAdapter = {
      kind: "fixture", capabilities: () => ({ canStart: true, canSendMessage: true, canReadLatest: true, canStopGracefully: true,
        canForceStop: true, canInterrupt: true, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: false }),
      start: async ({ agent }) => ({ backend: "fixture", id: agent.agent_id, data: {} }),
      sendMessage: async () => { state = "running"; }, getStatus: async () => ({ status: state }), readLatest: async () => [],
      interrupt: () => gate.promise,
      stop: async () => { stopCalls++; state = "stopped"; return { status: state }; }
    };
    adapters.register(adapter);
    controller = new AgentController(store, adapters);
    const run = controller.createRun({ title: "Turn continuity" });
    workerId = controller.registerAgent({ runId: run.run_id, backend: "fixture", title: "Original worker", status: "running", backendHandle: { id: "same-session" } }).agent_id;
  });
  afterEach(async () => { await controller.dispose(); store.close(); });
  it("does not let an old interrupt result overwrite a newer accepted message", async () => {
    const interrupt = controller.stopAgent(workerId, "interrupt");
    const receipt = await controller.sendMessage(workerId, "Continue the original assignment");
    gate.resolve({ status: "waiting_for_input" });
    expect(await interrupt).toMatchObject({ agent_id: workerId, status: "running", work_generation: receipt.agent.work_generation });
    expect(controller.getAgent(workerId).backend_handle).toEqual({ id: "same-session" });
    expect(stopCalls).toBe(0);
  });
  it("keeps cancellation authoritative when it wins while an interrupt is in flight", async () => {
    const interrupt = controller.stopAgent(workerId, "interrupt");
    expect((await controller.stopAgent(workerId, "graceful")).status).toBe("stopped");
    gate.resolve({ status: "waiting_for_input" });
    expect((await interrupt).status).toBe("stopped");
    await expect(controller.sendMessage(workerId, "No resurrection")).rejects.toThrow("Durable stop intent");
    await expect(controller.stopAgent(workerId, "interrupt")).rejects.toThrow("Durable stop intent");
    expect(stopCalls).toBe(1);
  });
  it("preserves a cancelled run across interruption requests without touching the backend", async () => {
    store.updateRunStatus(controller.getAgent(workerId).run_id, "stopping");
    await expect(controller.stopAgent(workerId, "interrupt")).rejects.toThrow("Durable stop intent");
    expect(stopCalls).toBe(0);
  });
});

it('resumes an interrupted native bridge worker and keeps definitive cancellation separate', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { CodexSubagentAdapter } = await import('../src/adapters/codex-subagent-adapter.js');
  const { ManualAdapter } = await import('../src/adapters/manual-adapter.js');
  const directory = mkdtempSync(join(tmpdir(), 'native-turn-continuity-'));
  const oldHome = process.env.AGENT_CONTROL_HOME, oldKey = process.env.AGENT_CONTROL_ADMIN_KEY;
  process.env.AGENT_CONTROL_HOME = directory; process.env.AGENT_CONTROL_ADMIN_KEY = 'native-continuity-admin';
  const store = new SqliteStore(join(directory, 'state.sqlite'));
  const adapters = new AdapterRegistry(); adapters.register(new ManualAdapter()); adapters.register(new CodexSubagentAdapter());
  const controller = new AgentController(store, adapters);
  try {
    const login = controller.orchestratorLogin({ adminKey: 'native-continuity-admin', title: 'Native continuity', repoDir: directory, backend: 'manual' });
    const start = controller.startFlow({ runId: login.run.run_id, agentToken: login.agent_token,
      ownerTaskIdentity: 'continuity-root', ownerTaskPath: '/root',
      config: { id: 'native-continuity', initial_step: 'work', roles: { worker: { backend: 'codex-subagent' } },
        steps: { work: { role: 'worker', prompt: 'Complete the same assignment.', on: { reported: { finish: true } } } } } });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const work = await controller.continueFlow({ flowInstanceId: start.instance.flow_instance_id, bridgeToken });
    const workerId = work.agent!.agent_id;
    const acknowledge = (actionId: string, spawn = false) => {
      const claim = controller.claimOrchestratorAction({ actionId, bridgeToken });
      if (!('action_token' in claim)) throw Error('Expected action claim');
      return controller.acknowledgeOrchestratorAction({ actionId, actionToken: claim.action_token, status: 'succeeded',
        result: spawn ? { native_agent_id: 'same-native-agent', native_task_name: claim.request.task_name, native_task_path: claim.request.expected_task_path } : {} });
    };
    acknowledge(work.orchestrator_action!.action_id, true);
    const interrupt = await controller.stopAgent(workerId, 'interrupt');
    expect(interrupt.status).toBe('running');
    await expect(controller.sendMessage(workerId, 'Too early')).rejects.toThrow('interruption is still pending');
    acknowledge(interrupt.orchestrator_action!.action_id);
    expect(controller.getAgent(workerId).status).toBe('running');
    const stopped = controller.syncCodexSubagent({ agentId: workerId, bridgeToken, nativeAgentId: 'same-native-agent', nativeStatus: 'interrupted', observedAt: new Date().toISOString() });
    expect(stopped.agent.status).toBe('waiting_for_input');
    const followup = await controller.sendMessage(workerId, 'Continue the same assignment');
    if (!('orchestrator_action' in followup) || !followup.orchestrator_action) throw Error('Expected native follow-up');
    expect(followup.orchestrator_action.operation).toBe('followup_task');
    expect(acknowledge(followup.orchestrator_action.action_id).agent.status).toBe('running');
    const cancel = await controller.stopAgent(workerId, 'graceful');
    acknowledge(cancel.orchestrator_action!.action_id);
    controller.syncCodexSubagent({ agentId: workerId, bridgeToken, nativeAgentId: 'same-native-agent', nativeStatus: 'interrupted', observedAt: new Date(Date.now() + 1).toISOString() });
    expect(controller.getAgent(workerId).status).toBe('stopped');
    await expect(controller.sendMessage(workerId, 'Do not revive cancelled work')).rejects.toThrow('Durable stop intent');
    expect(store.listOrchestratorActions({ agentId: workerId }).filter(action => action.operation === 'spawn_agent')).toHaveLength(1);
  } finally {
    await controller.dispose(); store.close(); rmSync(directory, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.AGENT_CONTROL_HOME; else process.env.AGENT_CONTROL_HOME = oldHome;
    if (oldKey === undefined) delete process.env.AGENT_CONTROL_ADMIN_KEY; else process.env.AGENT_CONTROL_ADMIN_KEY = oldKey;
  }
});
