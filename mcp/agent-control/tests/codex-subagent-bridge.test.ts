import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { CodexSubagentAdapter } from "../src/adapters/codex-subagent-adapter.js";
import { ManualAdapter } from "../src/adapters/manual-adapter.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { AgentController } from "../src/core/controller.js";
import { hashToken } from "../src/core/identity.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHandle,
  AgentMessage,
  AgentMessageInput,
  AgentStopResult,
  AgentStatusSnapshot,
  ReadLatestOptions,
  StartAgentInput,
  StopOptions,
  StopResult
} from "../src/core/types.js";
import { handleTool } from "../src/tools/handlers.js";
import { TOOL_DEFINITIONS } from "../src/tools/tool-definitions.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

describe("codex-subagent durable orchestrator bridge", () => {
  let tmp: string;
  let store: SqliteStore;
  let controller: AgentController;
  let registry: AdapterRegistry;
  let oldControlHome: string | undefined;
  let oldAdminKey: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-control-native-bridge-"));
    oldControlHome = process.env.AGENT_CONTROL_HOME;
    oldAdminKey = process.env.AGENT_CONTROL_ADMIN_KEY;
    process.env.AGENT_CONTROL_HOME = join(tmp, "home");
    process.env.AGENT_CONTROL_ADMIN_KEY = "ack_native_bridge_test";
    store = new SqliteStore(join(tmp, "state.sqlite"));
    registry = new AdapterRegistry();
    registry.register(new ManualAdapter());
    registry.register(new CodexSubagentAdapter());
    controller = new AgentController(store, registry);
  });

  afterEach(() => {
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

  it("launches with a one-time scoped grant and durably claims and acknowledges spawn", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;

    expect(bridgeToken).toMatch(/^acb_/);
    expect(launched.start.bridge_credential).toMatchObject({
      run_id: launched.login.run.run_id,
      orchestrator_agent_id: launched.login.agent.agent_id,
      owner_task_identity: "thread-native-root",
      owner_task_path: "/root"
    });
    expect(launched.start.instance.originating_bridge_grant_id).toBe(
      launched.start.bridge_credential!.bridge_grant_id
    );
    expect(JSON.stringify(launched.start)).not.toContain("agent_token");
    expect(JSON.stringify(launched.start)).not.toContain("ack_native_bridge_test");
    expect(() =>
      controller.startFlow({
        config: nativeConfig(),
        runId: launched.login.run.run_id,
        agentToken: launched.login.agent_token,
        ownerTaskIdentity: "thread-native-root",
        ownerTaskPath: "/root/other"
      })
    ).toThrowError(/requires one active bridge grant/);
    const resumed = controller.startFlow({
      config: nativeConfig(),
      runId: launched.login.run.run_id,
      agentToken: launched.login.agent_token,
      ownerTaskIdentity: "thread-native-root",
      ownerTaskPath: "/root"
    });
    expect(resumed.reused).toBe(true);
    expect(resumed.bridge_credential).toBeUndefined();
    expect(resumed.bridge_grant).toEqual({
      bridge_grant_id: launched.start.bridge_credential!.bridge_grant_id,
      run_id: launched.login.run.run_id,
      orchestrator_agent_id: launched.login.agent.agent_id,
      owner_task_identity: "thread-native-root",
      owner_task_path: "/root",
      created_at: launched.start.bridge_credential!.created_at,
      expires_at: null
    });
    expect(JSON.stringify(resumed)).not.toContain("acb_");

    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    expect(continuation.action).toBe("orchestrator_action_required");
    expect(continuation.orchestrator_action).toMatchObject({
      operation: "spawn_agent",
      status: "pending",
      flow_instance_id: launched.start.instance.flow_instance_id,
      step_instance_id: launched.start.active_step!.step_instance_id
    });
    expect(JSON.stringify(continuation.orchestrator_action)).not.toContain("Perform native work");

    const actionId = continuation.orchestrator_action!.action_id;
    const claimed = controller.claimOrchestratorAction({ actionId, bridgeToken });
    expect(claimed).toMatchObject({
      action_id: actionId,
      operation: "spawn_agent",
      backend: "codex-subagent",
      request: {
        fork_turns: "none",
        message: expect.stringContaining("Perform native work"),
        expected_task_path: expect.stringMatching(/^\/root\/worker_[a-z0-9]+$/)
      }
    });
    expect("action_token" in claimed && claimed.action_token).toMatch(/^aca_/);
    expect(String("request" in claimed && claimed.request.message)).toContain(
      "Do not call native collaboration/subagent tools"
    );
    expect(String("request" in claimed && claimed.request.message)).toContain(
      "call `flow_step_report`, and then end"
    );

    const duplicateClaim = controller.claimOrchestratorAction({ actionId, bridgeToken });
    expect(duplicateClaim).toMatchObject({ status: "already_claimed", action_id: actionId });
    expect(duplicateClaim).not.toHaveProperty("action_token");
    expect(duplicateClaim).not.toHaveProperty("request");

    if (!("action_token" in claimed)) {
      throw new Error("Expected a claimed action envelope.");
    }
    const expectedTaskPath = String(claimed.request.expected_task_path);
    const acknowledgement = controller.acknowledgeOrchestratorAction({
      actionId,
      actionToken: claimed.action_token,
      status: "succeeded",
      result: {
        native_agent_id: "native-agent-1",
        native_task_name: String(claimed.request.task_name),
        native_task_path: expectedTaskPath
      }
    });
    expect(acknowledgement.agent).toMatchObject({
      backend: "codex-subagent",
      status: "running",
      backend_handle: {
        native_agent_id: "native-agent-1",
        native_task_path: expectedTaskPath,
        expected_task_path: expectedTaskPath
      }
    });

    const idempotentAck = controller.acknowledgeOrchestratorAction({
      actionId,
      actionToken: claimed.action_token,
      status: "succeeded",
      result: {
        native_task_path: expectedTaskPath,
        native_task_name: String(claimed.request.task_name),
        native_agent_id: "native-agent-1"
      }
    });
    expect(idempotentAck.action.status).toBe("succeeded");
    expect(() =>
      controller.acknowledgeOrchestratorAction({
        actionId,
        actionToken: claimed.action_token,
        status: "failed",
        error: { message: "contradiction" }
      })
    ).toThrowError(/Conflicting acknowledgement/);
  });

  it("replays a fresh step dispatch with the same native spawn action", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Fresh native review",
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: nativeConfig({ agent_lifecycle: "fresh_per_step" }),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-fresh-native-review",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;

    expect(
      controller
        .listAgents({ runId: login.run.run_id })
        .filter((agent) => agent.role === "worker")
    ).toHaveLength(0);

    const first = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const replay = await controller.dispatchActiveFlowStep({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });

    expect(first).toMatchObject({
      action: "orchestrator_action_required",
      orchestrator_action: { operation: "spawn_agent", status: "pending" }
    });
    expect(replay.agent.agent_id).toBe(first.agent!.agent_id);
    expect(replay.orchestrator_action).toEqual(first.orchestrator_action);
    expect(
      store
        .listOrchestratorActions({ agentId: first.agent!.agent_id })
        .filter((action) => action.step_instance_id === start.active_step!.step_instance_id)
    ).toHaveLength(1);
  });

  it("cancels a pending native spawn when its flow step is manually superseded", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Pending native manual reroute",
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: manualRerouteNativeConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-pending-native-manual-reroute",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const workerId = continuation.agent!.agent_id;
    const spawnActionId = continuation.orchestrator_action!.action_id;

    const rerouted = await controller.startFlowStep({
      flowInstanceId: start.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: start.active_step!.step_instance_id,
      transitionId: "manual-cancel-pending-native-spawn"
    });

    expect(rerouted).toMatchObject({
      instance: { status: "active", current_step_id: "planning" },
      active_step: { step_id: "planning", status: "active" },
      cleanup: [
        {
          agent_id: workerId,
          status: "stopped",
          orchestrator_action: null
        }
      ]
    });
    expect(store.getOrchestratorAction(spawnActionId)).toMatchObject({
      operation: "spawn_agent",
      status: "cancelled",
      error_json: { reason: "agent_stopped_before_spawn", scope: "flow_route" }
    });
    expect(controller.getAgent(workerId)).toMatchObject({
      status: "stopped",
      backend_handle: null
    });
    expect(
      store
        .listOrchestratorActions({ agentId: workerId })
        .filter((action) => action.operation === "interrupt_agent")
    ).toEqual([]);
  });

  it("returns and wakes the owner for a native interrupt after a running worker is rerouted", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Running native manual reroute",
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: manualRerouteNativeConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-running-native-manual-reroute",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed native spawn before manual reroute.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: "native-agent-manually-rerouted",
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });
    const workerId = continuation.agent!.agent_id;

    const rerouted = await controller.startFlowStep({
      flowInstanceId: start.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: start.active_step!.step_instance_id,
      transitionId: "manual-interrupt-running-native-worker"
    });

    expect(rerouted).toMatchObject({
      instance: { status: "active", current_step_id: "planning" },
      active_step: { step_id: "planning", status: "active" },
      cleanup: [
        {
          agent_id: workerId,
          status: "stopping",
          orchestrator_action: {
            operation: "interrupt_agent",
            status: "pending",
            agent_id: workerId,
            flow_instance_id: start.instance.flow_instance_id,
            step_instance_id: start.active_step!.step_instance_id
          }
        }
      ]
    });
    const cleanupAction = rerouted.cleanup[0]!.orchestrator_action!;
    expect(JSON.stringify(rerouted.cleanup)).not.toMatch(
      /bridge_token|action_token|native-agent-manually-rerouted|expected_task_path|"target"/
    );
    expect(controller.getAgent(workerId).status).toBe("stopping");
    expect(
      store
        .listOrchestratorActions({ agentId: workerId })
        .filter((action) => action.operation === "interrupt_agent" && action.status === "pending")
    ).toHaveLength(1);
    const wake = controller
      .listEvents({ runId: login.run.run_id, type: "flow.notification" })
      .find((event) => event.event_id === `event_${cleanupAction.action_id.slice("action_".length)}`);
    expect(wake).toMatchObject({
      agent_id: workerId,
      payload: {
        reason: "native_orchestrator_action_required",
        orchestrator_action: cleanupAction
      }
    });
    expect(JSON.stringify(wake)).not.toMatch(/bridge_token|action_token|"target"/);
    expect(
      controller
        .getFlowSnapshot(start.instance.flow_instance_id)
        .steps.filter((step) => step.status === "active")
    ).toEqual([expect.objectContaining({ step_id: "planning" })]);
  });

  it("re-drives native manual-route cleanup after a crash before interrupt creation", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Restart native manual reroute",
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: manualRerouteNativeConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-restart-native-manual-reroute",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed native spawn before restart cleanup test.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: "native-agent-restart-manual-reroute",
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });
    const workerId = continuation.agent!.agent_id;
    let releaseOriginalStop!: (value: AgentStopResult) => void;
    const originalStop = new Promise<AgentStopResult>((resolve) => {
      releaseOriginalStop = resolve;
    });
    const stopSpy = vi.spyOn(controller, "stopAgent").mockReturnValue(originalStop);

    const pendingRoute = controller.startFlowStep({
      flowInstanceId: start.instance.flow_instance_id,
      stepId: "planning",
      fromStepInstanceId: start.active_step!.step_instance_id,
      transitionId: "manual-crash-before-native-interrupt"
    });
    expect(controller.getAgent(workerId).status).toBe("stopping");
    expect(
      store
        .listOrchestratorActions({ agentId: workerId })
        .filter((action) => action.operation === "interrupt_agent")
    ).toEqual([]);
    stopSpy.mockRestore();

    const restartedStore = new SqliteStore(join(tmp, "state.sqlite"));
    const restartedController = new AgentController(restartedStore, registry);
    await restartedController.drainDeliveries();
    const interrupt = restartedStore
      .listOrchestratorActions({ agentId: workerId })
      .find((action) => action.operation === "interrupt_agent");
    expect(interrupt).toMatchObject({ status: "pending", agent_id: workerId });
    expect(
      restartedController
        .listEvents({ runId: login.run.run_id, type: "flow.notification" })
        .find((event) => event.event_id === `event_${interrupt!.action_id.slice("action_".length)}`)
    ).toMatchObject({
      payload: {
        reason: "native_orchestrator_action_required",
        orchestrator_action: { action_id: interrupt!.action_id, operation: "interrupt_agent" }
      }
    });

    releaseOriginalStop(restartedController.getAgent(workerId));
    await pendingRoute;
    restartedStore.close();
  });

  it("retries a fresh native spawn after assignment precedes a prompt failure", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Fresh native prompt retry",
      repoDir: "/repo",
      backend: "manual"
    });
    const promptPath = join(tmp, "late-native-review.md");
    const start = controller.startFlow({
      config: {
        id: "fresh-native-prompt-retry-flow",
        initial_step: "review",
        roles: {
          reviewer: {
            backend: "codex-subagent",
            agent_lifecycle: "fresh_per_step"
          }
        },
        steps: {
          review: {
            role: "reviewer",
            prompt_path: promptPath,
            on: { reported: { finish: true } }
          }
        }
      },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-fresh-native-prompt-retry",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;

    await expect(
      controller.continueFlow({
        flowInstanceId: start.instance.flow_instance_id,
        bridgeToken
      })
    ).rejects.toThrow(/prompt source file is unavailable/);

    const assignedStep = controller
      .getFlowSnapshot(start.instance.flow_instance_id)
      .steps.find((step) => step.status === "active")!;
    const assignedAgentId = assignedStep.agent_id!;
    expect(controller.getAgent(assignedAgentId)).toMatchObject({
      status: "queued",
      backend_handle: null
    });
    expect(store.listOrchestratorActions({ agentId: assignedAgentId })).toHaveLength(0);

    writeFileSync(promptPath, "# Native review\n\nReview independently.\n", "utf8");
    const recovered = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    expect(recovered).toMatchObject({
      action: "orchestrator_action_required",
      active_step: {
        step_instance_id: assignedStep.step_instance_id,
        agent_id: assignedAgentId
      },
      agent: { agent_id: assignedAgentId },
      orchestrator_action: {
        operation: "spawn_agent",
        status: "pending",
        step_instance_id: assignedStep.step_instance_id
      }
    });

    rmSync(promptPath);
    const replay = await controller.dispatchActiveFlowStep({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    expect(replay.agent.agent_id).toBe(assignedAgentId);
    expect(replay.orchestrator_action).toEqual(recovered.orchestrator_action);
    expect(
      store
        .listOrchestratorActions({ agentId: assignedAgentId })
        .filter((action) => action.step_instance_id === assignedStep.step_instance_id)
    ).toHaveLength(1);

    const claim = controller.claimOrchestratorAction({
      actionId: recovered.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in claim)) {
      throw new Error("Expected the recovered spawn action to be claimable.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: claim.action_id,
      actionToken: claim.action_token,
      status: "failed",
      error: { message: "The native runtime rejected the recovered spawn." }
    });
    const failedReplay = await controller.dispatchActiveFlowStep({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    expect(failedReplay).toMatchObject({
      agent: { agent_id: assignedAgentId, status: "failed" },
      orchestrator_action: null
    });
    expect(
      store
        .listOrchestratorActions({ agentId: assignedAgentId })
        .filter((action) => action.step_instance_id === assignedStep.step_instance_id)
    ).toHaveLength(1);
  });

  it("preserves completed external truth when spawn acknowledgement arrives later", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed spawn action.");
    }
    const workerId = continuation.agent!.agent_id;
    const spawnResult = {
      native_agent_id: "native-agent-completed-before-spawn-ack",
      native_task_name: spawnClaim.request.task_name,
      native_task_path: spawnClaim.request.expected_task_path
    };

    const synchronized = controller.syncCodexSubagent({
      agentId: workerId,
      bridgeToken,
      nativeAgentId: spawnResult.native_agent_id,
      nativeTaskName: String(spawnResult.native_task_name),
      nativeTaskPath: String(spawnResult.native_task_path),
      nativeStatus: "completed"
    });
    expect(synchronized.agent).toMatchObject({ status: "completed", failure_reason: null });

    const acknowledged = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: spawnResult
    });
    expect(acknowledged).toMatchObject({
      action: { status: "succeeded" },
      agent: {
        status: "completed",
        failure_reason: null,
        backend_handle: {
          native_agent_id: spawnResult.native_agent_id,
          native_task_name: spawnResult.native_task_name,
          native_task_path: spawnResult.native_task_path,
          expected_task_path: spawnResult.native_task_path
        }
      }
    });
    expect(acknowledged.orchestrator_action).toBeUndefined();
    expect(
      store
        .listOrchestratorActions({ agentId: workerId })
        .filter((action) => action.operation === "interrupt_agent")
    ).toEqual([]);

    const repeated = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: spawnResult
    });
    expect(repeated.agent).toMatchObject({ status: "completed", failure_reason: null });
  });

  it("holds one immediate write reservation across every native ACK projection", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const workerId = continuation.agent!.agent_id;
    const competitor = new Database(join(tmp, "state.sqlite"));
    competitor.pragma("busy_timeout = 1");
    const serializedOperations: string[] = [];
    const completeAction = store.completeOrchestratorAction.bind(store);
    vi.spyOn(store, "completeOrchestratorAction").mockImplementation((input) => {
      const completion = completeAction(input);
      expect(store.db.inTransaction).toBe(true);
      // The action is terminal now, but its agent projection has not run yet.
      // A second process cannot commit external lifecycle truth in this former
      // read/write gap; it acquires the reservation after the ACK commits.
      expect(() => competitor.exec("begin immediate")).toThrow(/database is locked/);
      serializedOperations.push(completion.action.operation);
      return completion;
    });

    try {
      const spawnClaim = controller.claimOrchestratorAction({
        actionId: continuation.orchestrator_action!.action_id,
        bridgeToken
      });
      if (!("action_token" in spawnClaim)) {
        throw new Error("Expected claimed spawn action for ACK serialization test.");
      }
      const nativeAgentId = "native-agent-ack-serialization";
      controller.acknowledgeOrchestratorAction({
        actionId: spawnClaim.action_id,
        actionToken: spawnClaim.action_token,
        status: "succeeded",
        result: {
          native_agent_id: nativeAgentId,
          native_task_name: spawnClaim.request.task_name,
          native_task_path: spawnClaim.request.expected_task_path
        }
      });

      const send = await controller.sendMessage(workerId, "Serialized native send.");
      if (send.delivered) {
        throw new Error("Expected bridged send action for ACK serialization test.");
      }
      const sendClaim = controller.claimOrchestratorAction({
        actionId: send.orchestrator_action.action_id,
        bridgeToken
      });
      if (!("action_token" in sendClaim)) {
        throw new Error("Expected claimed send action for ACK serialization test.");
      }
      controller.acknowledgeOrchestratorAction({
        actionId: sendClaim.action_id,
        actionToken: sendClaim.action_token,
        status: "succeeded",
        result: {}
      });

      controller.syncCodexSubagent({
        agentId: workerId,
        bridgeToken,
        nativeAgentId,
        nativeStatus: "completed",
        observedAt: "2000-01-01T00:00:00.000Z"
      });
      const followup = await controller.sendMessage(
        workerId,
        "Serialized native follow-up."
      );
      if (followup.delivered) {
        throw new Error("Expected bridged follow-up action for ACK serialization test.");
      }
      const followupClaim = controller.claimOrchestratorAction({
        actionId: followup.orchestrator_action.action_id,
        bridgeToken
      });
      if (!("action_token" in followupClaim)) {
        throw new Error("Expected claimed follow-up action for ACK serialization test.");
      }
      const durableFollowup = store.getOrchestratorAction(followupClaim.action_id)!;
      controller.syncCodexSubagent({
        agentId: workerId,
        bridgeToken,
        nativeAgentId,
        nativeStatus: "completed",
        observedAt: durableFollowup.claimed_at!
      });
      const followupAck = controller.acknowledgeOrchestratorAction({
        actionId: followupClaim.action_id,
        actionToken: followupClaim.action_token,
        status: "succeeded",
        result: {}
      });
      expect(followupAck.agent.status).toBe("running");

      const stopped = await controller.stopAgent(workerId, "interrupt");
      const interrupt = stopped.orchestrator_action;
      if (!interrupt) {
        throw new Error("Expected native interrupt action for ACK serialization test.");
      }
      const interruptClaim = controller.claimOrchestratorAction({
        actionId: interrupt.action_id,
        bridgeToken
      });
      if (!("action_token" in interruptClaim)) {
        throw new Error("Expected claimed interrupt action for ACK serialization test.");
      }
      controller.acknowledgeOrchestratorAction({
        actionId: interruptClaim.action_id,
        actionToken: interruptClaim.action_token,
        status: "succeeded",
        result: {}
      });

      expect(serializedOperations).toEqual([
        "spawn_agent",
        "send_message",
        "followup_task",
        "interrupt_agent"
      ]);
      const terminalSync = controller.syncCodexSubagent({
        agentId: workerId,
        bridgeToken,
        nativeAgentId,
        nativeStatus: "interrupted",
        observedAt: new Date(
          Date.parse(durableFollowup.claimed_at!) + 1_000
        ).toISOString()
      });
      expect(terminalSync.agent.status).toBe("stopped");
    } finally {
      competitor.close();
    }
  });

  it("rolls back native flow initialization atomically and retries after a backend appears", () => {
    const atomicStore = new SqliteStore(":memory:");
    const atomicRegistry = new AdapterRegistry();
    atomicRegistry.register(new CodexSubagentAdapter());
    const atomicController = new AgentController(atomicStore, atomicRegistry);
    const login = atomicController.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Atomic native initialization",
      backend: "codex-subagent"
    });
    const config = {
      id: "atomic-native-initialization",
      initial_step: "manual_work",
      roles: {
        manual_worker: { backend: "manual" },
        native_worker: { backend: "codex-subagent" }
      },
      steps: {
        manual_work: {
          role: "manual_worker",
          prompt: "Wait for the late manual backend.",
          on: { reported: { finish: true } }
        },
        native_work: {
          role: "native_worker",
          prompt: "Keep the native bridge requirement active.",
          on: { reported: { finish: true } }
        }
      }
    };

    expect(() =>
      atomicController.startFlow({
        config,
        runId: login.run.run_id,
        agentToken: login.agent_token,
        ownerTaskPath: "/root"
      })
    ).toThrowError(/Unsupported backend: manual/);
    expect(
      atomicStore.db.prepare("select count(*) as count from flows").get()
    ).toMatchObject({ count: 0 });
    expect(
      atomicStore.db.prepare("select count(*) as count from flow_instances").get()
    ).toMatchObject({ count: 0 });
    expect(
      atomicStore.db.prepare("select count(*) as count from bridge_grants").get()
    ).toMatchObject({ count: 0 });

    atomicRegistry.register(new ManualAdapter());
    const retried = atomicController.startFlow({
      config,
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root"
    });
    expect(retried).toMatchObject({ reused: false, active_step: { step_id: "manual_work" } });
    expect(retried.bridge_credential?.bridge_token).toMatch(/^acb_/);
    expect(atomicStore.listFlowInstances({ runId: login.run.run_id })).toHaveLength(1);
    expect(atomicStore.listBridgeGrants({ runId: login.run.run_id })).toHaveLength(1);
    atomicStore.close();
  });

  it("binds an action to its originating grant and rejects a different owner task", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Cross-grant owner A",
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: nativeConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-native-owner-a",
      ownerTaskPath: "/root/a"
    });
    const bridgeTokenA = start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken: bridgeTokenA
    });
    const actionId = continuation.orchestrator_action!.action_id;
    const bridgeTokenB = "acb_cross_grant_owner_b";
    const grantB = store.createBridgeGrant({
      runId: login.run.run_id,
      orchestratorAgentId: login.agent.agent_id,
      ownerTaskIdentity: "thread-native-owner-b",
      ownerTaskPath: "/root/b",
      tokenHash: hashToken(bridgeTokenB)
    });

    expect(store.getOrchestratorAction(actionId)).toMatchObject({
      originating_bridge_grant_id: start.bridge_credential!.bridge_grant_id,
      claimed_by_bridge_grant_id: null
    });
    await expect(
      controller.continueFlow({
        flowInstanceId: start.instance.flow_instance_id,
        bridgeToken: bridgeTokenB
      })
    ).rejects.toThrow(/another bridge grant|different native request|different bridge task binding/);
    expect(() =>
      controller.claimOrchestratorAction({ actionId, bridgeToken: bridgeTokenB })
    ).toThrowError(expect.objectContaining({
      reason: "auth_required",
      details: expect.objectContaining({ reason: "action_grant_mismatch" })
    }));
    expect(store.getOrchestratorAction(actionId)).toMatchObject({
      status: "pending",
      claim_attempt: 0,
      originating_bridge_grant_id: start.bridge_credential!.bridge_grant_id
    });

    const claimed = controller.claimOrchestratorAction({ actionId, bridgeToken: bridgeTokenA });
    expect(claimed).toMatchObject({ action_id: actionId, operation: "spawn_agent" });
    expect(store.getOrchestratorAction(actionId)).toMatchObject({
      status: "claimed",
      originating_bridge_grant_id: start.bridge_credential!.bridge_grant_id,
      claimed_by_bridge_grant_id: start.bridge_credential!.bridge_grant_id
    });
    expect(grantB.owner_task_path).toBe("/root/b");
  });

  it("isolates two native flows under one orchestrator by their exact originating grants", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Two independent native flow owners",
      repoDir: "/repo",
      backend: "manual"
    });
    const startA = controller.startFlow({
      config: { ...nativeConfig(), id: "native-flow-owner-a" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-native-owner-a",
      ownerTaskPath: "/root/a"
    });
    const startB = controller.startFlow({
      config: { ...nativeConfig(), id: "native-flow-owner-b" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-native-owner-b",
      ownerTaskPath: "/root/b"
    });
    const tokenA = startA.bridge_credential!.bridge_token;
    const tokenB = startB.bridge_credential!.bridge_token;

    expect(startA.instance.originating_bridge_grant_id).toBe(
      startA.bridge_credential!.bridge_grant_id
    );
    expect(startB.instance.originating_bridge_grant_id).toBe(
      startB.bridge_credential!.bridge_grant_id
    );
    expect(startA.instance.originating_bridge_grant_id).not.toBe(
      startB.instance.originating_bridge_grant_id
    );

    await expect(
      controller.continueFlow({
        flowInstanceId: startA.instance.flow_instance_id,
        bridgeToken: tokenB
      })
    ).rejects.toThrow(/different bridge task binding/);
    expect(
      store.getFlowStepInstance(startA.active_step!.step_instance_id)
    ).toMatchObject({ status: "active", agent_id: null });
    expect(
      store.listOrchestratorActions({ runId: login.run.run_id })
    ).toEqual([]);
    expect(
      store.getBridgeGrant(startB.bridge_credential!.bridge_grant_id)
    ).toMatchObject({ last_used_at: null });

    const continuationA = await controller.continueFlow({
      flowInstanceId: startA.instance.flow_instance_id,
      bridgeToken: tokenA
    });
    const continuationB = await controller.continueFlow({
      flowInstanceId: startB.instance.flow_instance_id,
      bridgeToken: tokenB
    });
    expect(
      store.getOrchestratorAction(continuationA.orchestrator_action!.action_id)
    ).toMatchObject({
      flow_instance_id: startA.instance.flow_instance_id,
      originating_bridge_grant_id: startA.bridge_credential!.bridge_grant_id
    });
    expect(
      store.getOrchestratorAction(continuationB.orchestrator_action!.action_id)
    ).toMatchObject({
      flow_instance_id: startB.instance.flow_instance_id,
      originating_bridge_grant_id: startB.bridge_credential!.bridge_grant_id
    });
    expect(() =>
      controller.claimOrchestratorAction({
        actionId: continuationA.orchestrator_action!.action_id,
        bridgeToken: tokenB
      })
    ).toThrowError(expect.objectContaining({ reason: "auth_required" }));
  });

  it("migrates only provable legacy flow grants and keeps ambiguous flows unbound", async () => {
    const legacyPath = join(tmp, "legacy-flow-grant.sqlite");
    const legacyStore = new SqliteStore(legacyPath);
    const legacyRegistry = new AdapterRegistry();
    legacyRegistry.register(new ManualAdapter());
    legacyRegistry.register(new CodexSubagentAdapter());
    const legacyController = new AgentController(legacyStore, legacyRegistry);
    const login = legacyController.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Legacy flow grant migration",
      backend: "manual"
    });
    const startA = legacyController.startFlow({
      config: { ...nativeConfig(), id: "legacy-flow-with-action-evidence" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root/a"
    });
    const startB = legacyController.startFlow({
      config: { ...nativeConfig(), id: "legacy-flow-with-ambiguous-topology" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root/b"
    });
    await legacyController.continueFlow({
      flowInstanceId: startA.instance.flow_instance_id,
      bridgeToken: startA.bridge_credential!.bridge_token
    });
    legacyStore.close();

    // Recreate the exact legacy condition: actions already carry their causal
    // grant, while flow_instances predates the new binding column.
    const rawLegacy = new Database(legacyPath);
    rawLegacy.exec(`
      delete from schema_migrations;
      drop index if exists idx_flow_instances_origin_grant;
      alter table flow_instances drop column originating_bridge_grant_id;
    `);
    rawLegacy.close();

    const migrated = new SqliteStore(legacyPath);
    expect(migrated.getFlowInstance(startA.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: startA.bridge_credential!.bridge_grant_id
    });
    expect(migrated.getFlowInstance(startB.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: null
    });
    const migratedController = new AgentController(migrated, legacyRegistry);
    await expect(
      migratedController.continueFlow({
        flowInstanceId: startB.instance.flow_instance_id,
        bridgeToken: startB.bridge_credential!.bridge_token
      })
    ).rejects.toThrow(/no provable originating bridge grant/);

    // The migration is intentionally one-shot. A later topology change cannot
    // retroactively acquire the ambiguous flow on a subsequent restart.
    migrated.createBridgeGrant({
      runId: login.run.run_id,
      orchestratorAgentId: login.agent.agent_id,
      ownerTaskIdentity: "later-owner",
      ownerTaskPath: "/root/later",
      tokenHash: hashToken("acb_later_legacy_flow_owner")
    });
    migrated.close();
    const reopened = new SqliteStore(legacyPath);
    expect(reopened.getFlowInstance(startB.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: null
    });
    reopened.close();
  });

  it("keeps deleted legacy A origins unbound from later B and installs equivalent foreign keys", async () => {
    const legacyPath = join(tmp, "legacy-deleted-origin-later-grant.sqlite");
    const legacyStore = new SqliteStore(legacyPath);
    const legacyRegistry = new AdapterRegistry();
    legacyRegistry.register(new ManualAdapter());
    legacyRegistry.register(new CodexSubagentAdapter());
    const legacyController = new AgentController(legacyStore, legacyRegistry);
    const login = legacyController.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Deleted A later B migration",
      backend: "manual"
    });
    const start = legacyController.startFlow({
      config: { ...nativeConfig(), id: "deleted-a-later-b-flow" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root/a"
    });
    const continuation = await legacyController.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken: start.bridge_credential!.bridge_token
    });
    const actionId = continuation.orchestrator_action!.action_id;
    const originalClaim = legacyController.claimOrchestratorAction({
      actionId,
      bridgeToken: start.bridge_credential!.bridge_token
    });
    expect(originalClaim).toMatchObject({ action_id: actionId });
    const originalGrantId = start.bridge_credential!.bridge_grant_id;
    legacyStore.close();

    const rawLegacy = new Database(legacyPath);
    rawLegacy.pragma("foreign_keys = OFF");
    rawLegacy.exec(`
      delete from schema_migrations;
      drop index if exists idx_flow_instances_origin_grant;
      drop index if exists idx_orchestrator_actions_origin_grant;
      delete from bridge_grants where bridge_grant_id = '${originalGrantId}';
      alter table orchestrator_actions drop column originating_bridge_grant_id;
      alter table flow_instances drop column originating_bridge_grant_id;
      create table legacy_origin_migration_audit (entry text not null);
      create index legacy_flow_status_index on flow_instances(status);
      create trigger legacy_flow_status_trigger
      after update of status on flow_instances
      begin
        insert into legacy_origin_migration_audit (entry) values (new.flow_instance_id);
      end;
    `);
    rawLegacy
      .prepare(
        `insert into bridge_grants (
          bridge_grant_id, run_id, orchestrator_agent_id, owner_task_identity,
          owner_task_path, token_hash, created_at, last_used_at, expires_at, revoked_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "bridge_later_owner_b00000000",
        login.run.run_id,
        login.agent.agent_id,
        "later-owner-b",
        "/root/b",
        hashToken("acb_legacy_later_owner_b"),
        "2099-01-01T00:00:00.000Z",
        null,
        null,
        null
      );
    rawLegacy.close();

    const migrated = new SqliteStore(legacyPath);
    expect(migrated.getFlowInstance(start.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: null
    });
    expect(migrated.getOrchestratorAction(actionId)).toMatchObject({
      originating_bridge_grant_id: null,
      claimed_by_bridge_grant_id: null
    });

    const flowForeignKeys = migrated.db
      .prepare("pragma foreign_key_list(flow_instances)")
      .all() as Array<Record<string, unknown>>;
    const actionForeignKeys = migrated.db
      .prepare("pragma foreign_key_list(orchestrator_actions)")
      .all() as Array<Record<string, unknown>>;
    expect(flowForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "bridge_grants",
          from: "originating_bridge_grant_id",
          on_delete: "SET NULL"
        })
      ])
    );
    expect(actionForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "bridge_grants",
          from: "originating_bridge_grant_id",
          on_delete: "NO ACTION"
        })
      ])
    );
    expect(migrated.db.prepare("pragma foreign_key_check").all()).toEqual([]);
    expect(
      migrated.db
        .prepare(
          `select name from sqlite_master
           where name in ('legacy_flow_status_index', 'legacy_flow_status_trigger')
           order by name`
        )
        .all()
    ).toEqual([
      { name: "legacy_flow_status_index" },
      { name: "legacy_flow_status_trigger" }
    ]);

    const constrainedGrant = migrated.createBridgeGrant({
      runId: login.run.run_id,
      orchestratorAgentId: login.agent.agent_id,
      ownerTaskIdentity: "constraint-owner",
      ownerTaskPath: "/root/constraint-owner",
      tokenHash: hashToken("acb_constraint_owner")
    });
    migrated.db
      .prepare(
        "update flow_instances set originating_bridge_grant_id = ? where flow_instance_id = ?"
      )
      .run(constrainedGrant.bridge_grant_id, start.instance.flow_instance_id);
    migrated.db
      .prepare(
        "update orchestrator_actions set originating_bridge_grant_id = ? where action_id = ?"
      )
      .run(constrainedGrant.bridge_grant_id, actionId);
    expect(() =>
      migrated.db
        .prepare("delete from bridge_grants where bridge_grant_id = ?")
        .run(constrainedGrant.bridge_grant_id)
    ).toThrow(/FOREIGN KEY constraint failed/);
    migrated.db
      .prepare(
        "update orchestrator_actions set originating_bridge_grant_id = null where action_id = ?"
      )
      .run(actionId);
    migrated.db
      .prepare("delete from bridge_grants where bridge_grant_id = ?")
      .run(constrainedGrant.bridge_grant_id);
    expect(migrated.getFlowInstance(start.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: null
    });

    expect(() => migrated.purgeRunRows(login.run.run_id, false)).not.toThrow();
    expect(
      migrated.db.prepare("select count(*) as count from bridge_grants").get()
    ).toMatchObject({ count: 0 });
    expect(
      migrated.db.prepare("select count(*) as count from flow_instances").get()
    ).toMatchObject({ count: 0 });
    expect(
      migrated.db.prepare("select count(*) as count from orchestrator_actions").get()
    ).toMatchObject({ count: 0 });
    migrated.close();
  });

  it("does not let a t3 action adopt t2 grant B for a t1 flow whose grant A was deleted", () => {
    const legacyPath = join(tmp, "legacy-flow-before-later-action.sqlite");
    const legacyStore = new SqliteStore(legacyPath);
    const legacyRegistry = new AdapterRegistry();
    legacyRegistry.register(new ManualAdapter());
    legacyRegistry.register(new CodexSubagentAdapter());
    const legacyController = new AgentController(legacyStore, legacyRegistry);
    const login = legacyController.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Flow predates later grant and action",
      backend: "manual"
    });
    const start = legacyController.startFlow({
      config: { ...nativeConfig(), id: "flow-before-later-action" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root/a"
    });
    const worker = legacyStore
      .listAgents({ runId: login.run.run_id })
      .find((agent) => agent.role === "worker");
    if (!worker) {
      throw new Error("Expected the native flow to declare its worker.");
    }
    const originalGrantId = start.bridge_credential!.bridge_grant_id;
    legacyStore.close();

    const rawLegacy = new Database(legacyPath);
    rawLegacy.pragma("foreign_keys = OFF");
    rawLegacy.exec(`
      delete from schema_migrations;
      delete from bridge_grants where bridge_grant_id = '${originalGrantId}';
    `);
    const laterGrantId = "bridge_dddddddddddddddddddd";
    const laterBridgeToken = "acb_later_b_for_old_flow";
    rawLegacy
      .prepare(
        `insert into bridge_grants (
          bridge_grant_id, run_id, orchestrator_agent_id, owner_task_identity,
          owner_task_path, token_hash, created_at, last_used_at, expires_at, revoked_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        laterGrantId,
        login.run.run_id,
        login.agent.agent_id,
        "later-owner-b",
        "/root/b",
        hashToken(laterBridgeToken),
        "2098-01-01T00:00:00.000Z",
        null,
        null,
        null
      );
    const laterActionId = "action_cccccccccccccccccccc";
    rawLegacy
      .prepare(
        `insert into orchestrator_actions (
          action_id, idempotency_key, run_id, orchestrator_agent_id, agent_id,
          flow_instance_id, step_instance_id, operation, status, payload_json,
          result_json, error_json, originating_bridge_grant_id,
          claimed_by_bridge_grant_id, claim_owner_identity, claim_attempt,
          claimed_at, claim_lease_expires_at, action_token_hash, created_at,
          updated_at, completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        laterActionId,
        "legacy-action-created-after-later-grant",
        login.run.run_id,
        login.agent.agent_id,
        worker.agent_id,
        start.instance.flow_instance_id,
        start.active_step!.step_instance_id,
        "spawn_agent",
        "pending",
        JSON.stringify({ message: "This later action must remain unbound." }),
        null,
        null,
        null,
        null,
        null,
        0,
        null,
        null,
        null,
        "2099-01-01T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
        null
      );
    rawLegacy.close();

    const migrated = new SqliteStore(legacyPath);
    const migratedController = new AgentController(migrated, legacyRegistry);
    expect(migrated.getFlowInstance(start.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: null
    });
    expect(migrated.getOrchestratorAction(laterActionId)).toMatchObject({
      originating_bridge_grant_id: null,
      claim_attempt: 0
    });
    expect(() =>
      migratedController.claimOrchestratorAction({
        actionId: laterActionId,
        bridgeToken: laterBridgeToken
      })
    ).toThrowError(
      expect.objectContaining({
        reason: "auth_required",
        details: expect.objectContaining({ reason: "unbound_action" })
      })
    );
    expect(laterGrantId).toBe("bridge_dddddddddddddddddddd");
    migrated.close();
  });

  it("does not replace deleted explicit A origins with an unrelated eligible grant C", async () => {
    const legacyPath = join(tmp, "legacy-explicit-origin-deleted-with-candidate.sqlite");
    const legacyStore = new SqliteStore(legacyPath);
    const legacyRegistry = new AdapterRegistry();
    legacyRegistry.register(new ManualAdapter());
    legacyRegistry.register(new CodexSubagentAdapter());
    const legacyController = new AgentController(legacyStore, legacyRegistry);
    const login = legacyController.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Deleted explicit A with eligible C",
      backend: "manual"
    });
    const start = legacyController.startFlow({
      config: { ...nativeConfig(), id: "deleted-explicit-a-with-candidate-c" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root/a"
    });
    const continuation = await legacyController.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken: start.bridge_credential!.bridge_token
    });
    const actionId = continuation.orchestrator_action!.action_id;
    const originalGrantId = start.bridge_credential!.bridge_grant_id;
    const candidateToken = "acb_preexisting_candidate_c";
    const candidateGrant = legacyStore.createBridgeGrant({
      runId: login.run.run_id,
      orchestratorAgentId: login.agent.agent_id,
      ownerTaskIdentity: "unrelated-candidate-c",
      ownerTaskPath: "/root/c",
      tokenHash: hashToken(candidateToken)
    });
    // C is deliberately made older than both causal rows. It would be the one
    // remaining chronological candidate after A is deleted, so this fixture
    // distinguishes a genuine legacy null from a rejected explicit A claim.
    legacyStore.db
      .prepare("update bridge_grants set created_at = ? where bridge_grant_id = ?")
      .run("2000-01-01T00:00:00.000Z", candidateGrant.bridge_grant_id);
    legacyStore.close();

    const rawLegacy = new Database(legacyPath);
    rawLegacy.pragma("foreign_keys = OFF");
    rawLegacy.exec(`
      delete from schema_migrations;
      delete from bridge_grants where bridge_grant_id = '${originalGrantId}';
    `);
    rawLegacy.close();

    const migrated = new SqliteStore(legacyPath);
    const migratedController = new AgentController(migrated, legacyRegistry);
    expect(migrated.getFlowInstance(start.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: null
    });
    expect(migrated.getOrchestratorAction(actionId)).toMatchObject({
      originating_bridge_grant_id: null,
      claim_attempt: 0
    });
    expect(() =>
      migratedController.claimOrchestratorAction({
        actionId,
        bridgeToken: candidateToken
      })
    ).toThrowError(
      expect.objectContaining({
        reason: "auth_required",
        details: expect.objectContaining({ reason: "unbound_action" })
      })
    );
    migrated.close();
  });

  it("reconciles a legacy null action to flow A but clears an eligible action B mismatch", async () => {
    const legacyPath = join(tmp, "legacy-flow-action-final-reconciliation.sqlite");
    const legacyStore = new SqliteStore(legacyPath);
    const legacyRegistry = new AdapterRegistry();
    legacyRegistry.register(new ManualAdapter());
    legacyRegistry.register(new CodexSubagentAdapter());
    const legacyController = new AgentController(legacyStore, legacyRegistry);
    const login = legacyController.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Final flow action reconciliation",
      backend: "manual"
    });
    const start = legacyController.startFlow({
      config: { ...nativeConfig(), id: "flow-a-action-null-or-b" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root/a"
    });
    const grantA = start.bridge_credential!.bridge_grant_id;
    const grantAToken = start.bridge_credential!.bridge_token;
    const grantBToken = "acb_second_eligible_grant_b";
    const grantB = legacyStore.createBridgeGrant({
      runId: login.run.run_id,
      orchestratorAgentId: login.agent.agent_id,
      ownerTaskIdentity: "eligible-grant-b",
      ownerTaskPath: "/root/b",
      tokenHash: hashToken(grantBToken)
    });
    // B predates the flow for migration purposes, making both A and B valid
    // topology candidates. Only the flow's explicit A origin may resolve the
    // action that genuinely had no legacy origin.
    legacyStore.db
      .prepare("update bridge_grants set created_at = ? where bridge_grant_id = ?")
      .run("2000-01-01T00:00:00.000Z", grantB.bridge_grant_id);
    const continuation = await legacyController.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken: grantAToken
    });
    const nullActionId = continuation.orchestrator_action!.action_id;
    legacyStore.close();

    const mismatchedActionId = "action_eeeeeeeeeeeeeeeeeeee";
    const rawLegacy = new Database(legacyPath);
    rawLegacy.pragma("foreign_keys = OFF");
    rawLegacy
      .prepare(
        `insert into orchestrator_actions (
          action_id, idempotency_key, run_id, orchestrator_agent_id, agent_id,
          flow_instance_id, step_instance_id, operation, status, payload_json,
          result_json, error_json, originating_bridge_grant_id,
          claimed_by_bridge_grant_id, claim_owner_identity, claim_attempt,
          claimed_at, claim_lease_expires_at, action_token_hash, created_at,
          updated_at, completed_at
        )
        select ?, ?, run_id, orchestrator_agent_id, agent_id,
               flow_instance_id, step_instance_id, operation, status, payload_json,
               result_json, error_json, ?, null, null, 0,
               null, null, null, created_at, updated_at, completed_at
        from orchestrator_actions where action_id = ?`
      )
      .run(
        mismatchedActionId,
        "legacy-eligible-action-b-mismatch",
        grantB.bridge_grant_id,
        nullActionId
      );
    rawLegacy
      .prepare(
        "update orchestrator_actions set originating_bridge_grant_id = null where action_id = ?"
      )
      .run(nullActionId);
    rawLegacy.exec("delete from schema_migrations;");
    rawLegacy.close();

    const migrated = new SqliteStore(legacyPath);
    const migratedController = new AgentController(migrated, legacyRegistry);
    expect(migrated.getFlowInstance(start.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: grantA
    });
    expect(migrated.getOrchestratorAction(nullActionId)).toMatchObject({
      originating_bridge_grant_id: grantA
    });
    expect(migrated.getOrchestratorAction(mismatchedActionId)).toMatchObject({
      originating_bridge_grant_id: null,
      claim_attempt: 0
    });
    expect(
      migratedController.claimOrchestratorAction({
        actionId: nullActionId,
        bridgeToken: grantAToken
      })
    ).toMatchObject({ action_id: nullActionId });
    expect(() =>
      migratedController.claimOrchestratorAction({
        actionId: mismatchedActionId,
        bridgeToken: grantBToken
      })
    ).toThrowError(
      expect.objectContaining({
        reason: "auth_required",
        details: expect.objectContaining({ reason: "unbound_action" })
      })
    );
    migrated.close();
  });

  it("taints invalid and erased claimant evidence before eligible C inference", async () => {
    const legacyPath = join(tmp, "legacy-deleted-claimant-with-eligible-c.sqlite");
    const legacyStore = new SqliteStore(legacyPath);
    const legacyRegistry = new AdapterRegistry();
    legacyRegistry.register(new ManualAdapter());
    legacyRegistry.register(new CodexSubagentAdapter());
    const legacyController = new AgentController(legacyStore, legacyRegistry);
    const login = legacyController.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Deleted claimant A with eligible C",
      backend: "manual"
    });
    const start = legacyController.startFlow({
      config: { ...nativeConfig(), id: "deleted-claimant-a-eligible-c" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root/a"
    });
    const continuation = await legacyController.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken: start.bridge_credential!.bridge_token
    });
    const claimedActionId = continuation.orchestrator_action!.action_id;
    legacyController.claimOrchestratorAction({
      actionId: claimedActionId,
      bridgeToken: start.bridge_credential!.bridge_token
    });
    const originalGrantId = start.bridge_credential!.bridge_grant_id;
    const candidateToken = "acb_claimant_candidate_c";
    const candidateGrant = legacyStore.createBridgeGrant({
      runId: login.run.run_id,
      orchestratorAgentId: login.agent.agent_id,
      ownerTaskIdentity: "claimant-candidate-c",
      ownerTaskPath: "/root/c",
      tokenHash: hashToken(candidateToken)
    });
    legacyStore.db
      .prepare("update bridge_grants set created_at = ? where bridge_grant_id = ?")
      .run("2000-01-01T00:00:00.000Z", candidateGrant.bridge_grant_id);
    legacyStore.close();

    const erasedClaimantActionId = "action_ffffffffffffffffffff";
    const rawLegacy = new Database(legacyPath);
    rawLegacy.pragma("foreign_keys = OFF");
    rawLegacy
      .prepare(
        `insert into orchestrator_actions (
          action_id, idempotency_key, run_id, orchestrator_agent_id, agent_id,
          flow_instance_id, step_instance_id, operation, status, payload_json,
          result_json, error_json, originating_bridge_grant_id,
          claimed_by_bridge_grant_id, claim_owner_identity, claim_attempt,
          claimed_at, claim_lease_expires_at, action_token_hash, created_at,
          updated_at, completed_at
        )
        select ?, ?, run_id, orchestrator_agent_id, agent_id,
               flow_instance_id, step_instance_id, operation, status, payload_json,
               result_json, error_json, null, null, claim_owner_identity, claim_attempt,
               claimed_at, claim_lease_expires_at, action_token_hash, created_at,
               updated_at, completed_at
        from orchestrator_actions where action_id = ?`
      )
      .run(
        erasedClaimantActionId,
        "legacy-erased-claimant-metadata",
        claimedActionId
      );
    // The first action retains a now-dangling explicit claimant A. The second
    // models ON DELETE SET NULL having already erased that id while leaving
    // the atomically written claim attempt, owner, timestamps, and token hash.
    rawLegacy
      .prepare(
        "update orchestrator_actions set originating_bridge_grant_id = null where action_id = ?"
      )
      .run(claimedActionId);
    rawLegacy
      .prepare(
        "update flow_instances set originating_bridge_grant_id = null where flow_instance_id = ?"
      )
      .run(start.instance.flow_instance_id);
    rawLegacy
      .prepare("delete from bridge_grants where bridge_grant_id = ?")
      .run(originalGrantId);
    rawLegacy.exec("delete from schema_migrations;");
    rawLegacy.close();

    const migrated = new SqliteStore(legacyPath);
    const migratedController = new AgentController(migrated, legacyRegistry);
    expect(migrated.getFlowInstance(start.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: null
    });
    for (const actionId of [claimedActionId, erasedClaimantActionId]) {
      expect(migrated.getOrchestratorAction(actionId)).toMatchObject({
        originating_bridge_grant_id: null,
        claimed_by_bridge_grant_id: null,
        claim_attempt: 1
      });
      expect(() =>
        migratedController.claimOrchestratorAction({
          actionId,
          bridgeToken: candidateToken
        })
      ).toThrowError(
        expect.objectContaining({
          reason: "auth_required",
          details: expect.objectContaining({ reason: "unbound_action" })
        })
      );
    }
    await expect(
      migratedController.continueFlow({
        flowInstanceId: start.instance.flow_instance_id,
        bridgeToken: candidateToken
      })
    ).rejects.toThrow(/no provable originating bridge grant/);
    migrated.close();
  });

  it("propagates a rejected explicit action A origin to its null parent flow", async () => {
    const legacyPath = join(tmp, "legacy-invalid-child-origin-taints-flow.sqlite");
    const legacyStore = new SqliteStore(legacyPath);
    const legacyRegistry = new AdapterRegistry();
    legacyRegistry.register(new ManualAdapter());
    legacyRegistry.register(new CodexSubagentAdapter());
    const legacyController = new AgentController(legacyStore, legacyRegistry);
    const login = legacyController.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Invalid child A taints null flow",
      backend: "manual"
    });
    const start = legacyController.startFlow({
      config: { ...nativeConfig(), id: "invalid-child-a-null-parent" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root/a"
    });
    const continuation = await legacyController.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken: start.bridge_credential!.bridge_token
    });
    const actionId = continuation.orchestrator_action!.action_id;
    const originalGrantId = start.bridge_credential!.bridge_grant_id;
    const candidateToken = "acb_invalid_child_candidate_c";
    const candidateGrant = legacyStore.createBridgeGrant({
      runId: login.run.run_id,
      orchestratorAgentId: login.agent.agent_id,
      ownerTaskIdentity: "invalid-child-candidate-c",
      ownerTaskPath: "/root/c",
      tokenHash: hashToken(candidateToken)
    });
    legacyStore.db
      .prepare("update bridge_grants set created_at = ? where bridge_grant_id = ?")
      .run("2000-01-01T00:00:00.000Z", candidateGrant.bridge_grant_id);
    legacyStore.close();

    const rawLegacy = new Database(legacyPath);
    rawLegacy.pragma("foreign_keys = OFF");
    // Only the parent is a genuine legacy null. The child's explicit A is
    // deliberately left dangling so its rejection must taint the parent before
    // topology inference can assign the otherwise eligible C grant.
    rawLegacy
      .prepare(
        "update flow_instances set originating_bridge_grant_id = null where flow_instance_id = ?"
      )
      .run(start.instance.flow_instance_id);
    rawLegacy
      .prepare("delete from bridge_grants where bridge_grant_id = ?")
      .run(originalGrantId);
    rawLegacy.exec("delete from schema_migrations;");
    rawLegacy.close();

    const migrated = new SqliteStore(legacyPath);
    const migratedController = new AgentController(migrated, legacyRegistry);
    expect(migrated.getFlowInstance(start.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: null
    });
    expect(migrated.getOrchestratorAction(actionId)).toMatchObject({
      originating_bridge_grant_id: null,
      claimed_by_bridge_grant_id: null,
      claim_attempt: 0
    });
    await expect(
      migratedController.continueFlow({
        flowInstanceId: start.instance.flow_instance_id,
        bridgeToken: candidateToken
      })
    ).rejects.toThrow(/no provable originating bridge grant/);
    expect(() =>
      migratedController.claimOrchestratorAction({
        actionId,
        bridgeToken: candidateToken
      })
    ).toThrowError(
      expect.objectContaining({
        reason: "auth_required",
        details: expect.objectContaining({ reason: "unbound_action" })
      })
    );
    migrated.close();
  });

  it("rolls back an interrupted origin migration and completes it on reopen", async () => {
    const legacyPath = join(tmp, "legacy-origin-migration-interrupted.sqlite");
    const legacyStore = new SqliteStore(legacyPath);
    const legacyRegistry = new AdapterRegistry();
    legacyRegistry.register(new ManualAdapter());
    legacyRegistry.register(new CodexSubagentAdapter());
    const legacyController = new AgentController(legacyStore, legacyRegistry);
    const login = legacyController.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Interrupted origin migration",
      backend: "manual"
    });
    const start = legacyController.startFlow({
      config: { ...nativeConfig(), id: "interrupted-origin-migration-flow" },
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskPath: "/root"
    });
    const continuation = await legacyController.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken: start.bridge_credential!.bridge_token
    });
    legacyStore.close();

    const rawLegacy = new Database(legacyPath);
    rawLegacy.exec(`
      delete from schema_migrations;
      drop index if exists idx_flow_instances_origin_grant;
      drop index if exists idx_orchestrator_actions_origin_grant;
      alter table orchestrator_actions drop column originating_bridge_grant_id;
      alter table flow_instances drop column originating_bridge_grant_id;
      create trigger inject_origin_migration_failure
      before insert on schema_migrations
      begin
        select raise(abort, 'injected origin migration failure');
      end;
    `);
    rawLegacy.close();

    expect(() => new SqliteStore(legacyPath)).toThrow(
      /injected origin migration failure/
    );

    const afterFailure = new Database(legacyPath);
    const flowColumnsAfterFailure = afterFailure
      .prepare("pragma table_info(flow_instances)")
      .all() as Array<{ name: string }>;
    const actionColumnsAfterFailure = afterFailure
      .prepare("pragma table_info(orchestrator_actions)")
      .all() as Array<{ name: string }>;
    expect(flowColumnsAfterFailure.map((column) => column.name)).not.toContain(
      "originating_bridge_grant_id"
    );
    expect(actionColumnsAfterFailure.map((column) => column.name)).not.toContain(
      "originating_bridge_grant_id"
    );
    expect(
      afterFailure
        .prepare("select count(*) as count from flow_instances")
        .get()
    ).toMatchObject({ count: 1 });
    expect(
      afterFailure
        .prepare("select count(*) as count from orchestrator_actions")
        .get()
    ).toMatchObject({ count: 1 });
    expect(
      afterFailure
        .prepare("select count(*) as count from schema_migrations")
        .get()
    ).toMatchObject({ count: 0 });
    afterFailure.exec("drop trigger inject_origin_migration_failure;");
    afterFailure.close();

    const reopened = new SqliteStore(legacyPath);
    expect(reopened.getFlowInstance(start.instance.flow_instance_id)).toMatchObject({
      originating_bridge_grant_id: start.bridge_credential!.bridge_grant_id
    });
    expect(
      reopened.getOrchestratorAction(continuation.orchestrator_action!.action_id)
    ).toMatchObject({
      originating_bridge_grant_id: start.bridge_credential!.bridge_grant_id
    });
    expect(
      reopened.db
        .prepare("select count(*) as count from schema_migrations")
        .get()
    ).toMatchObject({ count: 1 });
    reopened.close();
  });

  it("migrates provable legacy action grants and leaves ambiguous ownership fail-closed", () => {
    const legacyPath = join(tmp, "legacy-action-grant.sqlite");
    const legacy = new Database(legacyPath);
    const now = new Date().toISOString();
    const rawTokenA = "acb_legacy_owner_a";
    const rawTokenB = "acb_legacy_owner_b";
    legacy.exec(`
      create table runs (
        run_id text primary key, title text not null, repo_dir text,
        parent_run_id text, created_by_agent_id text, status text not null,
        created_at text not null, updated_at text not null
      );
      create table agents (
        agent_id text primary key, run_id text not null, backend text not null,
        title text not null, role text, objective text, repo_dir text, model text,
        backend_handle_json text, work_generation integer not null default 0,
        work_revision integer not null default 0, status text not null,
        failure_reason text, unregistered_at text, created_at text not null,
        updated_at text not null
      );
      create table bridge_grants (
        bridge_grant_id text primary key, run_id text not null,
        orchestrator_agent_id text not null, owner_task_identity text,
        owner_task_path text not null, token_hash text not null unique,
        created_at text not null, last_used_at text, expires_at text, revoked_at text
      );
      create table orchestrator_actions (
        action_id text primary key, idempotency_key text not null unique,
        run_id text not null, orchestrator_agent_id text not null,
        agent_id text not null, flow_instance_id text, step_instance_id text,
        operation text not null, status text not null, payload_json text not null,
        result_json text, error_json text, originating_bridge_grant_id text,
        claimed_by_bridge_grant_id text,
        claim_owner_identity text, claim_attempt integer not null default 0,
        claimed_at text, claim_lease_expires_at text, action_token_hash text,
        created_at text not null, updated_at text not null, completed_at text
      );
    `);
    legacy
      .prepare("insert into runs values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("run_legacy_grants", "Legacy grant migration", "/repo", null, null, "active", now, now);
    const insertAgent = legacy.prepare(
      "insert into agents values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    insertAgent.run(
      "agent_legacy_orchestrator",
      "run_legacy_grants",
      "manual",
      "Legacy orchestrator",
      "orchestrator",
      null,
      "/repo",
      null,
      null,
      0,
      0,
      "waiting_for_input",
      null,
      null,
      now,
      now
    );
    insertAgent.run(
      "agent_legacy_worker",
      "run_legacy_grants",
      "codex-subagent",
      "Legacy worker",
      "worker",
      null,
      "/repo",
      null,
      null,
      0,
      0,
      "planned",
      null,
      null,
      now,
      now
    );
    const insertGrant = legacy.prepare(
      "insert into bridge_grants values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const grantA = "bridge_aaaaaaaaaaaaaaaaaaaa";
    const grantB = "bridge_bbbbbbbbbbbbbbbbbbbb";
    insertGrant.run(
      grantA,
      "run_legacy_grants",
      "agent_legacy_orchestrator",
      "legacy-owner-a",
      "/root/a",
      hashToken(rawTokenA),
      now,
      null,
      null,
      null
    );
    insertGrant.run(
      grantB,
      "run_legacy_grants",
      "agent_legacy_orchestrator",
      "legacy-owner-b",
      "/root/b",
      hashToken(rawTokenB),
      now,
      null,
      null,
      null
    );
    const insertAction = legacy.prepare(
      "insert into orchestrator_actions values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const boundActionId = "action_aaaaaaaaaaaaaaaaaaaa";
    const ambiguousActionId = "action_bbbbbbbbbbbbbbbbbbbb";
    insertAction.run(
      boundActionId,
      "legacy-bound-action",
      "run_legacy_grants",
      "agent_legacy_orchestrator",
      "agent_legacy_worker",
      null,
      null,
      "spawn_agent",
      "pending",
      JSON.stringify({ message: "Legacy bound work" }),
      null,
      null,
      null,
      grantA,
      null,
      0,
      null,
      null,
      null,
      now,
      now,
      null
    );
    insertAction.run(
      ambiguousActionId,
      "legacy-ambiguous-action",
      "run_legacy_grants",
      "agent_legacy_orchestrator",
      "agent_legacy_worker",
      null,
      null,
      "spawn_agent",
      "pending",
      JSON.stringify({ message: "Legacy ambiguous work" }),
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
      now,
      now,
      null
    );
    legacy.close();

    const migratedStore = new SqliteStore(legacyPath);
    const migratedController = new AgentController(migratedStore, new AdapterRegistry());
    try {
      expect(
        migratedStore.db
          .prepare("pragma foreign_key_list(orchestrator_actions)")
          .all()
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "bridge_grants",
            from: "originating_bridge_grant_id",
            on_delete: "NO ACTION"
          })
        ])
      );
      expect(migratedStore.getOrchestratorAction(boundActionId)).toMatchObject({
        originating_bridge_grant_id: grantA
      });
      expect(migratedStore.getOrchestratorAction(ambiguousActionId)).toMatchObject({
        originating_bridge_grant_id: null
      });
      expect(
        migratedController.claimOrchestratorAction({
          actionId: boundActionId,
          bridgeToken: rawTokenA
        })
      ).toMatchObject({ action_id: boundActionId, operation: "spawn_agent" });
      expect(() =>
        migratedController.claimOrchestratorAction({
          actionId: ambiguousActionId,
          bridgeToken: rawTokenB
        })
      ).toThrowError(expect.objectContaining({
        reason: "auth_required",
        details: expect.objectContaining({ reason: "unbound_action" })
      }));
    } finally {
      migratedStore.close();
    }
  });

  it("serializes two stores claiming the same orchestrator action", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const actionId = continuation.orchestrator_action!.action_id;
    const secondStore = new SqliteStore(join(tmp, "state.sqlite"));
    const secondController = new AgentController(secondStore, new AdapterRegistry());

    try {
      const winner = controller.claimOrchestratorAction({ actionId, bridgeToken });
      const loser = secondController.claimOrchestratorAction({ actionId, bridgeToken });

      expect(winner).toMatchObject({ action_id: actionId, operation: "spawn_agent" });
      expect(winner).toHaveProperty("action_token");
      expect(loser).toEqual({
        status: "already_claimed",
        action_id: actionId,
        retry_after_ms: expect.any(Number)
      });
      expect(secondStore.getOrchestratorAction(actionId)).toMatchObject({
        status: "claimed",
        claim_attempt: 1,
        claimed_by_bridge_grant_id: launched.start.bridge_credential!.bridge_grant_id
      });
    } finally {
      secondStore.close();
    }
  });

  it("revalidates bridge revocation, expiry, and exact scope inside the claim transaction", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const grantId = launched.start.bridge_credential!.bridge_grant_id;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const actionId = continuation.orchestrator_action!.action_id;
    const secondStore = new SqliteStore(join(tmp, "state.sqlite"));
    const unrelatedRun = controller.createRun({ title: "Unrelated bridge scope" });
    const originalClaim = store.claimOrchestratorAction.bind(store);
    let mutateBeforeClaim: () => void = () => undefined;
    vi.spyOn(store, "claimOrchestratorAction").mockImplementation((input) => {
      // This hook runs after the controller has accepted the API request but
      // before the durable store enters its point of linearization. It models
      // another process changing authorization in precisely the window that a
      // controller-only grant check cannot protect.
      mutateBeforeClaim();
      return originalClaim(input);
    });

    try {
      mutateBeforeClaim = () => {
        secondStore.revokeBridgeGrant(grantId);
      };
      expect(() =>
        controller.claimOrchestratorAction({ actionId, bridgeToken })
      ).toThrowError(expect.objectContaining({
        reason: "auth_required",
        details: expect.objectContaining({ reason: "revoked_grant" })
      }));

      secondStore.db
        .prepare("update bridge_grants set revoked_at = null where bridge_grant_id = ?")
        .run(grantId);
      mutateBeforeClaim = () => {
        secondStore.db
          .prepare("update bridge_grants set expires_at = ? where bridge_grant_id = ?")
          .run("2000-01-01T00:00:00.000Z", grantId);
      };
      expect(() =>
        controller.claimOrchestratorAction({ actionId, bridgeToken })
      ).toThrowError(expect.objectContaining({
        reason: "auth_required",
        details: expect.objectContaining({ reason: "expired_grant" })
      }));

      secondStore.db
        .prepare("update bridge_grants set expires_at = null where bridge_grant_id = ?")
        .run(grantId);
      mutateBeforeClaim = () => {
        secondStore.db
          .prepare("update bridge_grants set run_id = ? where bridge_grant_id = ?")
          .run(unrelatedRun.run_id, grantId);
      };
      expect(() =>
        controller.claimOrchestratorAction({ actionId, bridgeToken })
      ).toThrowError(expect.objectContaining({
        reason: "auth_required",
        details: expect.objectContaining({ reason: "scope_mismatch" })
      }));

      expect(store.getOrchestratorAction(actionId)).toMatchObject({
        status: "pending",
        claim_attempt: 0,
        claimed_by_bridge_grant_id: null
      });
    } finally {
      secondStore.close();
    }
  });

  it("rotates an expired claim token and rejects the old token", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const actionId = continuation.orchestrator_action!.action_id;
    const first = controller.claimOrchestratorAction({ actionId, bridgeToken });
    if (!("action_token" in first)) {
      throw new Error("Expected first action claim.");
    }

    store.db
      .prepare("update orchestrator_actions set claim_lease_expires_at = ? where action_id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), actionId);
    const reclaimed = controller.claimOrchestratorAction({ actionId, bridgeToken });
    if (!("action_token" in reclaimed)) {
      throw new Error("Expected expired action reclaim.");
    }
    expect(reclaimed.action_token).not.toBe(first.action_token);
    expect(() =>
      controller.acknowledgeOrchestratorAction({
        actionId,
        actionToken: first.action_token,
        status: "succeeded",
        result: { native_agent_id: "native-agent-old-token" }
      })
    ).toThrowError(/rotated/);

    const acknowledged = controller.acknowledgeOrchestratorAction({
      actionId,
      actionToken: reclaimed.action_token,
      status: "succeeded",
      result: { native_agent_id: "native-agent-current-token" }
    });
    expect(acknowledged.action.status).toBe("succeeded");
  });

  it("accepts the current action token after lease expiry until a reclaim rotates it", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const actionId = continuation.orchestrator_action!.action_id;
    const claim = controller.claimOrchestratorAction({ actionId, bridgeToken });
    if (!("action_token" in claim)) {
      throw new Error("Expected action claim.");
    }
    store.db
      .prepare("update orchestrator_actions set claim_lease_expires_at = ? where action_id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), actionId);

    const acknowledged = controller.acknowledgeOrchestratorAction({
      actionId,
      actionToken: claim.action_token,
      status: "succeeded",
      result: { native_agent_id: "native-agent-after-expiry" }
    });
    expect(acknowledged.action.status).toBe("succeeded");
  });

  it("atomically rejects work-action inserts after durable run or agent stop intent", () => {
    const launched = launchNativeFlow();
    const worker = controller
      .listAgents({ runId: launched.login.run.run_id })
      .find((agent) => agent.role === "worker")!;
    store.updateRunStatus(launched.login.run.run_id, "stopping");

    const blockedByRun = store.createOrGetOrchestratorAction({
      idempotencyKey: "atomic-stop-run-spawn",
      runId: launched.login.run.run_id,
      orchestratorAgentId: launched.login.agent.agent_id,
      originatingBridgeGrantId: launched.start.bridge_credential!.bridge_grant_id,
      agentId: worker.agent_id,
      flowInstanceId: launched.start.instance.flow_instance_id,
      stepInstanceId: launched.start.active_step!.step_instance_id,
      operation: "spawn_agent",
      payloadJson: { message: "Must not be inserted after run stop intent." }
    });
    expect(blockedByRun).toBeNull();
    expect(store.getOrchestratorActionByIdempotencyKey("atomic-stop-run-spawn")).toBeNull();

    store.updateRunStatus(launched.login.run.run_id, "running");
    store.updateAgent(worker.agent_id, { status: "stopping" });
    const blockedByAgent = store.createOrGetOrchestratorAction({
      idempotencyKey: "atomic-stop-agent-followup",
      runId: launched.login.run.run_id,
      orchestratorAgentId: launched.login.agent.agent_id,
      originatingBridgeGrantId: launched.start.bridge_credential!.bridge_grant_id,
      agentId: worker.agent_id,
      flowInstanceId: launched.start.instance.flow_instance_id,
      stepInstanceId: launched.start.active_step!.step_instance_id,
      operation: "followup_task",
      payloadJson: { message: "Must not be inserted after agent stop intent." }
    });
    expect(blockedByAgent).toBeNull();
    expect(
      store.getOrchestratorActionByIdempotencyKey("atomic-stop-agent-followup")
    ).toBeNull();

    const cleanup = store.createOrGetOrchestratorAction({
      idempotencyKey: "atomic-stop-interrupt-cleanup",
      runId: launched.login.run.run_id,
      orchestratorAgentId: launched.login.agent.agent_id,
      originatingBridgeGrantId: launched.start.bridge_credential!.bridge_grant_id,
      agentId: worker.agent_id,
      flowInstanceId: launched.start.instance.flow_instance_id,
      stepInstanceId: launched.start.active_step!.step_instance_id,
      operation: "interrupt_agent",
      payloadJson: { target: worker.agent_id }
    });
    expect(cleanup).toMatchObject({ operation: "interrupt_agent", status: "pending" });
  });

  it("maps external state without completing the flow and keeps latest_message private", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const claim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in claim)) {
      throw new Error("Expected spawn claim.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: claim.action_id,
      actionToken: claim.action_token,
      status: "succeeded",
      result: { native_agent_id: "native-agent-sync" }
    });

    const workerId = continuation.agent!.agent_id;
    const secretLatestMessage = "PRIVATE_NATIVE_LATEST_MESSAGE";
    const runningObservedAt = new Date().toISOString();
    const completedObservedAt = new Date(Date.now() + 10_000).toISOString();
    expect(
      controller.syncCodexSubagent({
        agentId: workerId,
        bridgeToken,
        nativeAgentId: "native-agent-sync",
        nativeStatus: "running",
        latestMessage: secretLatestMessage,
        observedAt: runningObservedAt
      }).agent.status
    ).toBe("running");
    expect(
      controller.syncCodexSubagent({
        agentId: workerId,
        bridgeToken,
        nativeAgentId: "native-agent-sync",
        nativeStatus: "completed",
        observedAt: completedObservedAt
      }).agent.status
    ).toBe("completed");
    const nativeMessages = await controller.listAgentMessages(workerId, { limit: 5 });
    expect(nativeMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: secretLatestMessage,
          created_at: completedObservedAt,
          metadata: expect.objectContaining({ source: "codex-subagent-external-sync" })
        })
      ])
    );

    const stale = controller.syncCodexSubagent({
      agentId: workerId,
      bridgeToken,
      nativeAgentId: "native-agent-sync",
      nativeStatus: "running",
      latestMessage: "STALE_NATIVE_LATEST_MESSAGE",
      observedAt: runningObservedAt
    });
    expect(stale).toMatchObject({
      agent: { status: "completed" },
      native_status: "completed",
      observed_at: completedObservedAt
    });
    expect(
      controller.syncCodexSubagent({
        agentId: workerId,
        bridgeToken,
        nativeAgentId: "native-agent-sync",
        nativeStatus: "completed",
        observedAt: completedObservedAt
      }).agent.status
    ).toBe("completed");

    expect(JSON.stringify(controller.getDashboardSnapshot(launched.login.run.run_id))).not.toContain(
      secretLatestMessage
    );
    expect(JSON.stringify(controller.listEvents({ runId: launched.login.run.run_id }))).not.toContain(
      secretLatestMessage
    );
    expect(
      store.db
        .prepare("select latest_message from codex_subagent_external_states where agent_id = ?")
        .get(workerId)
    ).toMatchObject({ latest_message: secretLatestMessage });

    const blocked = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    expect(blocked.action).toBe("blocked");
    expect(blocked.blocked_reason).toBe("terminal_agent_missing_flow_report");
  });

  it("requires two exact missing observations separated by five seconds", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const claim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in claim)) {
      throw new Error("Expected spawn claim.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: claim.action_id,
      actionToken: claim.action_token,
      status: "succeeded",
      result: { native_agent_id: "native-agent-missing" }
    });

    const workerId = continuation.agent!.agent_id;
    const firstObservedAt = new Date(Date.now() - 6_000).toISOString();
    const first = controller.syncCodexSubagent({
      agentId: workerId,
      bridgeToken,
      nativeAgentId: "native-agent-missing",
      nativeStatus: "missing",
      observedAt: firstObservedAt
    });
    expect(first.agent).toMatchObject({ status: "unknown", failure_reason: null });

    const second = controller.syncCodexSubagent({
      agentId: workerId,
      bridgeToken,
      nativeAgentId: "native-agent-missing",
      nativeStatus: "missing",
      observedAt: new Date().toISOString()
    });
    expect(second.agent).toMatchObject({
      status: "unknown",
      failure_reason: "backend_unavailable"
    });
  });

  it("cancels an unclaimed spawn when stopped before execution and blocks continuation", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const workerId = continuation.agent!.agent_id;
    const spawnActionId = continuation.orchestrator_action!.action_id;

    const stopped = await controller.stopAgent(workerId, "graceful");
    expect(stopped).toMatchObject({ status: "stopped" });
    expect(stopped).not.toHaveProperty("orchestrator_action");
    expect(store.getOrchestratorAction(spawnActionId)).toMatchObject({
      operation: "spawn_agent",
      status: "cancelled",
      claim_attempt: 0
    });
    expect(
      store
        .listOrchestratorActions({ agentId: workerId })
        .filter((action) => action.operation === "interrupt_agent")
    ).toEqual([]);
    expect(
      store
        .listOrchestratorActions({ agentId: workerId })
        .filter((action) => action.status === "pending" || action.status === "claimed")
    ).toEqual([]);
    await controller.drainDeliveries();
    expect(
      controller
        .listEvents({ runId: launched.login.run.run_id, type: "flow.notification" })
        .filter((event) => event.payload.reason === "native_orchestrator_action_required")
    ).toEqual([]);

    const afterStop = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    expect(afterStop).toMatchObject({
      action: "blocked",
      blocked_reason: "terminal_agent_missing_flow_report",
      agent: { agent_id: workerId, status: "stopped" }
    });
  });

  it("rejects a spawn insert when handleless native stop commits first", async () => {
    const launched = launchNativeFlow();
    const worker = controller
      .listAgents({ runId: launched.login.run.run_id })
      .find((agent) => agent.role === "worker")!;

    const stopped = await controller.stopAgent(worker.agent_id, "graceful");
    expect(stopped).toMatchObject({ status: "stopped", backend_handle: null });

    const attemptedSpawn = store.createOrGetOrchestratorAction({
      idempotencyKey: `stop-first-spawn:${launched.start.active_step!.step_instance_id}`,
      runId: launched.login.run.run_id,
      orchestratorAgentId: launched.login.agent.agent_id,
      originatingBridgeGrantId: launched.start.bridge_credential!.bridge_grant_id,
      agentId: worker.agent_id,
      flowInstanceId: launched.start.instance.flow_instance_id,
      stepInstanceId: launched.start.active_step!.step_instance_id,
      operation: "spawn_agent",
      payloadJson: { message: "This insert must lose to durable stop intent." }
    });
    expect(attemptedSpawn).toBeNull();
    expect(
      store
        .listOrchestratorActions({ agentId: worker.agent_id })
        .filter((action) => action.status === "pending" || action.status === "claimed")
    ).toEqual([]);

    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken: launched.start.bridge_credential!.bridge_token
    });
    expect(continuation).toMatchObject({
      action: "blocked",
      blocked_reason: "agent_stopped_no_new_work",
      agent: { agent_id: worker.agent_id, status: "stopped" }
    });
    await controller.drainDeliveries();
    expect(
      controller
        .listEvents({ runId: launched.login.run.run_id, type: "flow.notification" })
        .filter((event) => event.payload.reason === "native_orchestrator_action_required")
    ).toEqual([]);
  });

  it("returns a blocked continuation without a stale spawn ref when stop wins before projection", async () => {
    const launched = launchNativeFlow();
    cancelNextNewWorkProjection("spawn_agent");

    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken: launched.start.bridge_credential!.bridge_token
    });
    expect(continuation).toMatchObject({
      action: "blocked",
      agent: { status: "stopping" },
      dispatch: { orchestrator_action: null },
      orchestrator_action: null,
      blocked_reason: "agent_stopping_no_new_work"
    });
    const spawnActions = store
      .listOrchestratorActions({ agentId: continuation.agent!.agent_id })
      .filter((action) => action.operation === "spawn_agent");
    expect(spawnActions).toHaveLength(1);
    expect(spawnActions[0]?.status).toBe("cancelled");
    await controller.drainDeliveries();
    expect(
      controller
        .listEvents({ runId: launched.login.run.run_id, type: "flow.notification" })
        .filter((event) => event.payload.reason === "native_orchestrator_action_required")
    ).toEqual([]);
  });

  it("returns no stale native message ref when stop cancels it before projection", async () => {
    const running = await launchRunningNativeWorker(
      "native-message-cancelled-before-projection"
    );
    const workerId = running.continuation.agent!.agent_id;
    cancelNextNewWorkProjection("send_message");

    const result = await controller.sendMessage(
      workerId,
      "Cancel this native message before its status projection."
    );
    expect(result).toMatchObject({
      delivered: false,
      agent: { status: "stopping" },
      orchestrator_action: null
    });
    const messageActions = store
      .listOrchestratorActions({ agentId: workerId })
      .filter((action) => action.operation === "send_message");
    expect(messageActions).toHaveLength(1);
    expect(messageActions[0]?.status).toBe("cancelled");
  });

  it("preserves a failed spawn ACK that commits before the initial projection", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    failNextNativeActionBeforeProjection("spawn_agent", bridgeToken);

    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    expect(continuation).toMatchObject({
      action: "blocked",
      agent: { status: "failed", failure_reason: "tool_error" },
      dispatch: { orchestrator_action: null },
      orchestrator_action: null,
      blocked_reason: "agent_start_failed"
    });
    const spawnAction = store
      .listOrchestratorActions({ agentId: continuation.agent!.agent_id })
      .find((action) => action.operation === "spawn_agent");
    expect(spawnAction).toMatchObject({
      status: "failed",
      error_json: { message: "Native action failed before its initial status projection." }
    });
  });

  it("waits for the report when a successful spawn ACK wins before projection", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    succeedNextSpawnBeforeProjection(bridgeToken);

    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    expect(continuation).toMatchObject({
      action: "waiting_for_report",
      agent: { status: "running" },
      dispatch: { orchestrator_action: null },
      orchestrator_action: null,
      blocked_reason: null
    });
    expect(
      store
        .listOrchestratorActions({ agentId: continuation.agent!.agent_id })
        .find((action) => action.operation === "spawn_agent")
    ).toMatchObject({ status: "succeeded" });
  });

  it("preserves a failed message ACK that commits before the initial projection", async () => {
    const running = await launchRunningNativeWorker(
      "native-message-failed-before-projection"
    );
    const workerId = running.continuation.agent!.agent_id;
    failNextNativeActionBeforeProjection("send_message", running.bridgeToken);

    const result = await controller.sendMessage(
      workerId,
      "Fail this native message before its initial status projection."
    );
    expect(result).toMatchObject({
      delivered: false,
      agent: { status: "failed", failure_reason: "tool_error" },
      orchestrator_action: null
    });
    const messageAction = store
      .listOrchestratorActions({ agentId: workerId })
      .find((action) => action.operation === "send_message");
    expect(messageAction).toMatchObject({ status: "failed" });
  });

  it("allows a new flow step to retry after a spawn definitively fails", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Retry failed native spawn",
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: retryableNativeFlowConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-retry-failed-native-spawn",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const firstContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const firstAction = firstContinuation.orchestrator_action!;
    const firstClaim = controller.claimOrchestratorAction({
      actionId: firstAction.action_id,
      bridgeToken
    });
    if (!("action_token" in firstClaim)) {
      throw new Error("Expected claimed initial spawn action.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: firstClaim.action_id,
      actionToken: firstClaim.action_token,
      status: "failed",
      error: { message: "The native runtime rejected the spawn." }
    });
    expect(store.getOrchestratorAction(firstAction.action_id)?.status).toBe("failed");
    expect(controller.getAgent(firstContinuation.agent!.agent_id)).toMatchObject({
      status: "failed",
      backend_handle: null
    });

    const blocked = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    expect(blocked).toMatchObject({
      action: "blocked",
      blocked_reason: "terminal_agent_missing_flow_report",
      active_step: { step_instance_id: start.active_step!.step_instance_id }
    });

    // A manual retry creates a distinct step instance. The failed action is
    // authoritative evidence that no native task exists, so this step may
    // enqueue a fresh spawn while pending/claimed/succeeded actions stay closed.
    const retry = await controller.startFlowStep({
      flowInstanceId: start.instance.flow_instance_id,
      stepId: "retry",
      fromStepInstanceId: start.active_step!.step_instance_id,
      transitionId: "manual-retry-after-failed-spawn",
      reason: "Retry after the native spawn failed before creating a worker."
    });
    expect(retry.active_step).toMatchObject({ step_id: "retry", status: "active" });
    const retryContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    expect(retryContinuation).toMatchObject({
      action: "orchestrator_action_required",
      active_step: { step_id: "retry" },
      agent: { agent_id: firstContinuation.agent!.agent_id },
      orchestrator_action: {
        operation: "spawn_agent",
        status: "pending",
        step_instance_id: retry.active_step!.step_instance_id
      }
    });
    expect(retryContinuation.orchestrator_action!.action_id).not.toBe(firstAction.action_id);
    expect(
      store
        .listOrchestratorActions({ agentId: firstContinuation.agent!.agent_id })
        .filter((action) => action.operation === "spawn_agent")
        .map((action) => ({ action_id: action.action_id, status: action.status }))
    ).toEqual([
      { action_id: firstAction.action_id, status: "failed" },
      { action_id: retryContinuation.orchestrator_action!.action_id, status: "pending" }
    ]);

    const retryClaim = controller.claimOrchestratorAction({
      actionId: retryContinuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in retryClaim)) {
      throw new Error("Expected claimed retry spawn action.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: retryClaim.action_id,
      actionToken: retryClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: "native-agent-after-failed-spawn",
        native_task_name: retryClaim.request.task_name,
        native_task_path: retryClaim.request.expected_task_path
      }
    });
    const completed = await controller.reportFlowStepAndContinue({
      stepInstanceId: retry.active_step!.step_instance_id,
      status: "completed",
      result: { retried: true },
      summary: "The retried native worker completed the flow step."
    });
    expect(completed.report.instance.status).toBe("completed");
    expect(completed.continuation).toBeNull();
    await controller.drainDeliveries();
  });

  it("keeps a claimed spawn fail-closed when stop cannot prove whether a native worker exists", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnActionId = continuation.orchestrator_action!.action_id;
    const claim = controller.claimOrchestratorAction({ actionId: spawnActionId, bridgeToken });
    if (!("action_token" in claim)) {
      throw new Error("Expected claimed spawn action.");
    }

    const stopped = await controller.stopAgent(continuation.agent!.agent_id, "graceful");
    expect(stopped).toMatchObject({
      status: "stopping",
      orchestrator_action: {
        action_id: spawnActionId,
        operation: "spawn_agent",
        status: "claimed"
      }
    });
    expect(store.getOrchestratorAction(spawnActionId)?.status).toBe("claimed");
    expect(
      store
        .listOrchestratorActions({ agentId: continuation.agent!.agent_id })
        .filter((action) => action.operation === "interrupt_agent")
    ).toEqual([]);
  });

  it("preserves shutdown intent when a claimed spawn acknowledges after stop", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed spawn action.");
    }
    // A later task grant for the same run/orchestrator must not acquire any
    // cleanup derived from owner A's already-claimed spawn.
    const bridgeTokenB = "acb_late_spawn_owner_b";
    const grantB = store.createBridgeGrant({
      runId: launched.login.run.run_id,
      orchestratorAgentId: launched.login.agent.agent_id,
      ownerTaskIdentity: "thread-native-owner-b",
      ownerTaskPath: "/root/b",
      tokenHash: hashToken(bridgeTokenB)
    });

    const shutdown = await controller.shutdownRun(launched.login.run.run_id);
    expect(shutdown).toMatchObject({
      run: { status: "stopping" },
      complete: false,
      orchestrator_actions: [
        expect.objectContaining({ operation: "spawn_agent", status: "claimed" })
      ]
    });

    const spawnResult = {
      native_agent_id: "native-agent-late-spawn",
      native_task_name: spawnClaim.request.task_name,
      native_task_path: spawnClaim.request.expected_task_path
    };
    const acknowledgement = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: spawnResult
    });
    expect(acknowledgement).toMatchObject({
      agent: { status: "stopping" },
      orchestrator_action: { operation: "interrupt_agent", status: "pending" }
    });
    expect(
      store.getOrchestratorAction(acknowledgement.orchestrator_action!.action_id)
    ).toMatchObject({
      originating_bridge_grant_id:
        launched.start.bridge_credential!.bridge_grant_id
    });
    expect(() =>
      controller.claimOrchestratorAction({
        actionId: acknowledgement.orchestrator_action!.action_id,
        bridgeToken: bridgeTokenB
      })
    ).toThrowError(expect.objectContaining({ reason: "auth_required" }));
    expect(grantB.owner_task_path).toBe("/root/b");
    expect(controller.getRun(launched.login.run.run_id).status).toBe("stopping");

    const recoveredContinuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    expect(recoveredContinuation).toMatchObject({
      action: "orchestrator_action_required",
      agent: { status: "stopping" },
      orchestrator_action: {
        action_id: acknowledgement.orchestrator_action!.action_id,
        operation: "interrupt_agent"
      }
    });

    const repeated = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: spawnResult
    });
    expect(repeated.orchestrator_action?.action_id).toBe(
      acknowledgement.orchestrator_action?.action_id
    );

    const interruptClaim = controller.claimOrchestratorAction({
      actionId: acknowledgement.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in interruptClaim)) {
      throw new Error("Expected claimed late-spawn interrupt action.");
    }
    // Make the durable ordering explicit so this regression cannot depend on
    // two acknowledgements landing in different wall-clock milliseconds.
    store.db
      .prepare("update orchestrator_actions set completed_at = ? where action_id = ?")
      .run("2000-01-01T00:00:00.000Z", spawnClaim.action_id);
    controller.acknowledgeOrchestratorAction({
      actionId: interruptClaim.action_id,
      actionToken: interruptClaim.action_token,
      status: "succeeded",
      result: {}
    });
    expect(controller.getAgent(continuation.agent!.agent_id).status).toBe("stopping");

    const coveredReplay = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: spawnResult
    });
    expect(coveredReplay.orchestrator_action).toBeUndefined();
    expect(
      store
        .listOrchestratorActions({ agentId: continuation.agent!.agent_id })
        .filter((action) => action.operation === "interrupt_agent")
    ).toHaveLength(1);

    controller.syncCodexSubagent({
      agentId: continuation.agent!.agent_id,
      bridgeToken,
      nativeAgentId: "native-agent-late-spawn",
      nativeStatus: "interrupted"
    });
    expect(controller.getAgent(continuation.agent!.agent_id).status).toBe("stopped");
    expect(controller.getRun(launched.login.run.run_id).status).toBe("stopped");
  });

  it("keeps run stop intent authoritative when running sync arrives before a late spawn ACK", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed spawn action.");
    }
    const nativeAgentId = "native-agent-running-sync-after-shutdown";

    const shutdown = await controller.shutdownRun(launched.login.run.run_id);
    expect(shutdown).toMatchObject({ run: { status: "stopping" }, complete: false });
    const runningSync = controller.syncCodexSubagent({
      agentId: continuation.agent!.agent_id,
      bridgeToken,
      nativeAgentId,
      nativeTaskName: String(spawnClaim.request.task_name),
      nativeTaskPath: String(spawnClaim.request.expected_task_path),
      nativeStatus: "running",
      observedAt: "2026-07-16T08:00:00.000Z"
    });
    expect(runningSync).toMatchObject({
      agent: { status: "stopping" },
      orchestrator_action: { operation: "interrupt_agent", status: "pending" }
    });
    expect(controller.getRun(launched.login.run.run_id).status).toBe("stopping");

    const spawnAcknowledgement = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: nativeAgentId,
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });
    expect(spawnAcknowledgement).toMatchObject({
      agent: { status: "stopping" },
      orchestrator_action: {
        action_id: runningSync.orchestrator_action!.action_id,
        operation: "interrupt_agent",
        status: "pending"
      }
    });
    const interrupts = store
      .listOrchestratorActions({ agentId: continuation.agent!.agent_id })
      .filter((action) => action.operation === "interrupt_agent");
    expect(interrupts).toHaveLength(1);

    const interruptClaim = controller.claimOrchestratorAction({
      actionId: runningSync.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in interruptClaim)) {
      throw new Error("Expected the running-sync cleanup interrupt to be claimable.");
    }
    store.db
      .prepare("update orchestrator_actions set completed_at = ? where action_id = ?")
      .run("2000-01-01T00:00:00.000Z", spawnClaim.action_id);
    controller.acknowledgeOrchestratorAction({
      actionId: interruptClaim.action_id,
      actionToken: interruptClaim.action_token,
      status: "succeeded",
      result: {}
    });
    const coveredReplay = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: nativeAgentId,
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });
    expect(coveredReplay.orchestrator_action).toBeUndefined();
    controller.syncCodexSubagent({
      agentId: continuation.agent!.agent_id,
      bridgeToken,
      nativeAgentId,
      nativeTaskName: String(spawnClaim.request.task_name),
      nativeTaskPath: String(spawnClaim.request.expected_task_path),
      nativeStatus: "interrupted",
      observedAt: "2026-07-16T08:00:01.000Z"
    });
    expect(controller.getAgent(continuation.agent!.agent_id).status).toBe("stopped");
    expect(controller.getRun(launched.login.run.run_id).status).toBe("stopped");
  });

  it("cancels an unclaimed cleanup interrupt when terminal native sync arrives first", async () => {
    const running = await launchRunningNativeWorker(
      "native-terminal-sync-cancels-pending-interrupt"
    );
    const workerId = running.continuation.agent!.agent_id;
    const shutdown = await controller.shutdownRun(running.launched.login.run.run_id);
    const interrupt = shutdown.orchestrator_actions.find(
      (action) => action.operation === "interrupt_agent"
    )!;
    expect(interrupt).toMatchObject({ status: "pending" });

    const synchronized = controller.syncCodexSubagent({
      agentId: workerId,
      bridgeToken: running.bridgeToken,
      nativeAgentId: running.nativeAgentId,
      nativeTaskName: String(running.spawnClaim.request.task_name),
      nativeTaskPath: String(running.spawnClaim.request.expected_task_path),
      nativeStatus: "interrupted",
      // Keep the authoritative observation strictly after the action without
      // depending on the wall clock of the test run.
      observedAt: "2099-07-16T12:00:00.000Z"
    });
    expect(synchronized.agent).toMatchObject({ status: "stopped" });
    expect(store.getOrchestratorAction(interrupt.action_id)).toMatchObject({
      status: "cancelled",
      error_json: {
        reason: "native_terminal_observation_superseded_interrupt"
      }
    });
    expect(controller.getRun(running.launched.login.run.run_id).status).toBe("stopped");

    const continuation = await controller.continueFlow({
      flowInstanceId: running.launched.start.instance.flow_instance_id,
      bridgeToken: running.bridgeToken
    });
    expect(continuation.action).toBe("blocked");
    expect(continuation.orchestrator_action).toBeNull();
    expect(() =>
      controller.claimOrchestratorAction({
        actionId: interrupt.action_id,
        bridgeToken: running.bridgeToken
      })
    ).toThrowError(/not claimable/);
  });

  it("retains a claimed cleanup interrupt across terminal native sync for idempotent ACK", async () => {
    const running = await launchRunningNativeWorker(
      "native-terminal-sync-retains-claimed-interrupt"
    );
    const workerId = running.continuation.agent!.agent_id;
    const shutdown = await controller.shutdownRun(running.launched.login.run.run_id);
    const interrupt = shutdown.orchestrator_actions.find(
      (action) => action.operation === "interrupt_agent"
    )!;
    const interruptClaim = controller.claimOrchestratorAction({
      actionId: interrupt.action_id,
      bridgeToken: running.bridgeToken
    });
    if (!("action_token" in interruptClaim)) {
      throw new Error("Expected claimed cleanup interrupt before terminal sync.");
    }

    controller.syncCodexSubagent({
      agentId: workerId,
      bridgeToken: running.bridgeToken,
      nativeAgentId: running.nativeAgentId,
      nativeTaskName: String(running.spawnClaim.request.task_name),
      nativeTaskPath: String(running.spawnClaim.request.expected_task_path),
      nativeStatus: "interrupted",
      observedAt: "2026-07-16T12:00:01.000Z"
    });
    expect(store.getOrchestratorAction(interrupt.action_id)?.status).toBe("claimed");
    expect(controller.getRun(running.launched.login.run.run_id).status).toBe("stopped");

    const continuation = await controller.continueFlow({
      flowInstanceId: running.launched.start.instance.flow_instance_id,
      bridgeToken: running.bridgeToken
    });
    expect(continuation).toMatchObject({
      action: "orchestrator_action_required",
      orchestrator_action: {
        action_id: interrupt.action_id,
        operation: "interrupt_agent",
        status: "claimed"
      }
    });
    const acknowledgement = controller.acknowledgeOrchestratorAction({
      actionId: interruptClaim.action_id,
      actionToken: interruptClaim.action_token,
      status: "succeeded",
      result: {}
    });
    expect(acknowledgement.orchestrator_action).toBeUndefined();
    expect(acknowledgement.agent.status).toBe("stopped");
  });

  it("advances late-spawn interrupt generation when prior completion cannot cover the spawn ACK", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed spawn action.");
    }
    await controller.shutdownRun(launched.login.run.run_id);
    const spawnResult = {
      native_agent_id: "native-agent-late-spawn-inverse-order",
      native_task_name: spawnClaim.request.task_name,
      native_task_path: spawnClaim.request.expected_task_path
    };
    const firstAck = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: spawnResult
    });
    const firstInterrupt = firstAck.orchestrator_action!;
    const interruptClaim = controller.claimOrchestratorAction({
      actionId: firstInterrupt.action_id,
      bridgeToken
    });
    if (!("action_token" in interruptClaim)) {
      throw new Error("Expected claimed first late-spawn interrupt.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: interruptClaim.action_id,
      actionToken: interruptClaim.action_token,
      status: "succeeded",
      result: {}
    });

    // Persist the inverse ordering explicitly: despite success, this interrupt
    // cannot prove it completed after the work acknowledgement.
    store.db
      .prepare("update orchestrator_actions set completed_at = ? where action_id = ?")
      .run("2026-07-16T08:00:01.000Z", spawnClaim.action_id);
    store.db
      .prepare("update orchestrator_actions set completed_at = ? where action_id = ?")
      .run("2026-07-16T08:00:00.000Z", firstInterrupt.action_id);

    const replay = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: spawnResult
    });
    expect(replay).toMatchObject({
      agent: { status: "stopping" },
      orchestrator_action: { operation: "interrupt_agent", status: "pending" }
    });
    expect(replay.orchestrator_action!.action_id).not.toBe(firstInterrupt.action_id);

    const exactReplay = controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: spawnResult
    });
    expect(exactReplay.orchestrator_action?.action_id).toBe(
      replay.orchestrator_action!.action_id
    );
    expect(
      store
        .listOrchestratorActions({ agentId: continuation.agent!.agent_id })
        .filter((action) => action.operation === "interrupt_agent")
        .map((action) => action.status)
    ).toEqual(["succeeded", "pending"]);
  });

  it("cancels a pending spawn in the same durable shutdown generation", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnAction = continuation.orchestrator_action!;
    expect(spawnAction).toMatchObject({ operation: "spawn_agent", status: "pending" });

    const shutdown = await controller.shutdownRun(launched.login.run.run_id);
    expect(shutdown).toMatchObject({ run: { status: "stopped" }, complete: true });
    expect(store.getOrchestratorAction(spawnAction.action_id)).toMatchObject({
      status: "cancelled",
      error_json: {
        reason: "agent_stopped_before_spawn",
        scope: "run_shutdown"
      }
    });
    expect(() =>
      controller.claimOrchestratorAction({
        actionId: spawnAction.action_id,
        bridgeToken
      })
    ).toThrowError(/not claimable/);
    expect(
      store
        .listOrchestratorActions({ agentId: continuation.agent!.agent_id })
        .filter(
          (action) =>
            action.status === "pending" &&
            (action.operation === "spawn_agent" ||
              action.operation === "send_message" ||
              action.operation === "followup_task")
        )
    ).toEqual([]);
  });

  it("atomically cancels an unclaimed follow-up when shutdown records stop intent", async () => {
    const ownerAdapter = new FlakyCodexThreadOwnerAdapter(10);
    registry.register(ownerAdapter);
    controller = new AgentController(store, registry, null, {
      nativeActionDeliveryRetryDelaysMs: []
    });
    const launched = await createPendingSameRoleFollowup(
      ownerAdapter,
      "pending-followup-shutdown"
    );
    await controller.drainDeliveries();
    expect(ownerAdapter.attempts).toBe(1);
    const followupAction = launched.handoff.continuation!.orchestrator_action!;

    const shutdown = await controller.shutdownRun(launched.login.run.run_id);
    const cancelled = store.getOrchestratorAction(followupAction.action_id)!;
    expect(shutdown).toMatchObject({ run: { status: "stopping" }, complete: false });
    expect(cancelled).toMatchObject({
      operation: "followup_task",
      status: "cancelled",
      claim_attempt: 0,
      error_json: {
        reason: "native_message_cancelled_by_stop",
        scope: "run_shutdown"
      }
    });
    expect(() =>
      controller.claimOrchestratorAction({
        actionId: followupAction.action_id,
        bridgeToken: launched.bridgeToken
      })
    ).toThrowError(/not claimable/);

    const interrupts = store
      .listOrchestratorActions({ agentId: launched.firstContinuation.agent!.agent_id })
      .filter((action) => action.operation === "interrupt_agent");
    expect(interrupts).toHaveLength(1);
    expect(shutdown.orchestrator_actions).toContainEqual(
      expect.objectContaining({ action_id: interrupts[0]!.action_id })
    );
    const recovered = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken: launched.bridgeToken
    });
    expect(recovered).toMatchObject({
      action: "orchestrator_action_required",
      agent: { status: "stopping" },
      orchestrator_action: {
        action_id: interrupts[0]!.action_id,
        operation: "interrupt_agent"
      }
    });
    await controller.drainDeliveries();

    controller = new AgentController(store, registry, null, {
      nativeActionDeliveryRetryDelaysMs: []
    });
    await controller.drainDeliveries();
    expect(ownerAdapter.attempts).toBe(1);
    expect(ownerAdapter.sent).toHaveLength(0);
    expect(
      controller
        .listEvents({ runId: launched.login.run.run_id, type: "flow.notification" })
        .filter((event) => event.payload.reason === "native_orchestrator_action_required")
    ).toHaveLength(1);
    expect(
      store
        .listOrchestratorActions({ agentId: launched.firstContinuation.agent!.agent_id })
        .filter((action) => action.operation === "interrupt_agent")
    ).toHaveLength(1);
  });

  it.each(["succeeded", "failed"] as const)(
    "keeps claimed follow-up shutdown intent and one interrupt after a late %s ACK",
    async (ackStatus) => {
      const ownerAdapter = new CapturingOwnerAdapter();
      const launched = await createPendingSameRoleFollowup(
        ownerAdapter,
        `claimed-followup-shutdown-${ackStatus}`
      );
      await controller.drainDeliveries();
      const followupAction = launched.handoff.continuation!.orchestrator_action!;
      const followupClaim = controller.claimOrchestratorAction({
        actionId: followupAction.action_id,
        bridgeToken: launched.bridgeToken
      });
      if (!("action_token" in followupClaim)) {
        throw new Error("Expected claimed follow-up action before shutdown.");
      }

      const shutdown = await controller.shutdownRun(launched.login.run.run_id);
      const interrupt = shutdown.orchestrator_actions.find(
        (action) => action.operation === "interrupt_agent"
      )!;
      expect(shutdown).toMatchObject({
        run: { status: "stopping" },
        complete: false
      });
      expect(store.getOrchestratorAction(followupAction.action_id)?.status).toBe("claimed");
      expect(interrupt).toMatchObject({ operation: "interrupt_agent", status: "pending" });

      const acknowledgement = controller.acknowledgeOrchestratorAction({
        actionId: followupClaim.action_id,
        actionToken: followupClaim.action_token,
        status: ackStatus,
        ...(ackStatus === "succeeded"
          ? { result: {} }
          : { error: { message: "The claimed follow-up transport failed after shutdown." } })
      });
      expect(acknowledgement).toMatchObject({
        agent: { status: "stopping", failure_reason: null },
        orchestrator_action: { action_id: interrupt.action_id, operation: "interrupt_agent" }
      });
      expect(controller.getRun(launched.login.run.run_id).status).toBe("stopping");

      const repeated = controller.acknowledgeOrchestratorAction({
        actionId: followupClaim.action_id,
        actionToken: followupClaim.action_token,
        status: ackStatus,
        ...(ackStatus === "succeeded"
          ? { result: {} }
          : { error: { message: "The claimed follow-up transport failed after shutdown." } })
      });
      expect(repeated.orchestrator_action?.action_id).toBe(interrupt.action_id);
      expect(
        store
          .listOrchestratorActions({ agentId: launched.firstContinuation.agent!.agent_id })
          .filter((action) => action.operation === "interrupt_agent")
      ).toHaveLength(1);
      expect(
        controller
          .listEvents({ runId: launched.login.run.run_id, type: "flow.notification" })
          .filter((event) => event.payload.reason === "native_orchestrator_action_required")
      ).toHaveLength(1);
      expect(ownerAdapter.sent).toHaveLength(1);

      const interruptClaim = controller.claimOrchestratorAction({
        actionId: interrupt.action_id,
        bridgeToken: launched.bridgeToken
      });
      if (!("action_token" in interruptClaim)) {
        throw new Error("Expected claimed follow-up shutdown interrupt.");
      }
      controller.acknowledgeOrchestratorAction({
        actionId: interruptClaim.action_id,
        actionToken: interruptClaim.action_token,
        status: "succeeded",
        result: {}
      });
      expect(controller.getAgent(launched.firstContinuation.agent!.agent_id).status).toBe(
        "stopping"
      );
      controller.syncCodexSubagent({
        agentId: launched.firstContinuation.agent!.agent_id,
        bridgeToken: launched.bridgeToken,
        nativeAgentId: launched.nativeAgentId,
        nativeStatus: "interrupted"
      });
      expect(controller.getAgent(launched.firstContinuation.agent!.agent_id).status).toBe(
        "stopped"
      );
      expect(controller.getRun(launched.login.run.run_id).status).toBe("stopped");
    }
  );

  it.each(["succeeded", "failed"] as const)(
    "creates one new open interrupt when a claimed follow-up %s ACK arrives after the prior interrupt ACK",
    async (ackStatus) => {
      const ownerAdapter = new CapturingOwnerAdapter();
      const launched = await createPendingSameRoleFollowup(
        ownerAdapter,
        `post-interrupt-followup-ack-${ackStatus}`
      );
      const followupAction = launched.handoff.continuation!.orchestrator_action!;
      const followupClaim = controller.claimOrchestratorAction({
        actionId: followupAction.action_id,
        bridgeToken: launched.bridgeToken
      });
      if (!("action_token" in followupClaim)) {
        throw new Error("Expected claimed follow-up before shutdown.");
      }
      const shutdown = await controller.shutdownRun(launched.login.run.run_id);
      const firstInterrupt = shutdown.orchestrator_actions.find(
        (action) => action.operation === "interrupt_agent"
      )!;
      const firstInterruptClaim = controller.claimOrchestratorAction({
        actionId: firstInterrupt.action_id,
        bridgeToken: launched.bridgeToken
      });
      if (!("action_token" in firstInterruptClaim)) {
        throw new Error("Expected claimed pre-ACK shutdown interrupt.");
      }
      controller.acknowledgeOrchestratorAction({
        actionId: firstInterruptClaim.action_id,
        actionToken: firstInterruptClaim.action_token,
        status: "succeeded",
        result: {}
      });

      const lateWorkAck = controller.acknowledgeOrchestratorAction({
        actionId: followupClaim.action_id,
        actionToken: followupClaim.action_token,
        status: ackStatus,
        ...(ackStatus === "succeeded"
          ? { result: {} }
          : { error: { message: "The follow-up transport resolved after its first interrupt." } })
      });
      expect(lateWorkAck).toMatchObject({
        agent: { status: "stopping" },
        orchestrator_action: { operation: "interrupt_agent", status: "pending" }
      });
      expect(lateWorkAck.orchestrator_action!.action_id).not.toBe(firstInterrupt.action_id);
      expect(store.getOrchestratorAction(firstInterrupt.action_id)?.status).toBe("succeeded");

      const replay = controller.acknowledgeOrchestratorAction({
        actionId: followupClaim.action_id,
        actionToken: followupClaim.action_token,
        status: ackStatus,
        ...(ackStatus === "succeeded"
          ? { result: {} }
          : { error: { message: "The follow-up transport resolved after its first interrupt." } })
      });
      expect(replay.orchestrator_action).toMatchObject({
        action_id: lateWorkAck.orchestrator_action!.action_id,
        status: "pending"
      });
      expect(
        store
          .listOrchestratorActions({ agentId: launched.firstContinuation.agent!.agent_id })
          .filter((action) => action.operation === "interrupt_agent")
      ).toHaveLength(2);

      const secondInterruptClaim = controller.claimOrchestratorAction({
        actionId: lateWorkAck.orchestrator_action!.action_id,
        bridgeToken: launched.bridgeToken
      });
      if (!("action_token" in secondInterruptClaim)) {
        throw new Error("Expected claimed post-ACK interrupt generation.");
      }
      controller.acknowledgeOrchestratorAction({
        actionId: secondInterruptClaim.action_id,
        actionToken: secondInterruptClaim.action_token,
        status: "succeeded",
        result: {}
      });
      controller.syncCodexSubagent({
        agentId: launched.firstContinuation.agent!.agent_id,
        bridgeToken: launched.bridgeToken,
        nativeAgentId: launched.nativeAgentId,
        nativeStatus: "interrupted"
      });
      const completedReplay = controller.acknowledgeOrchestratorAction({
        actionId: followupClaim.action_id,
        actionToken: followupClaim.action_token,
        status: ackStatus,
        ...(ackStatus === "succeeded"
          ? { result: {} }
          : { error: { message: "The follow-up transport resolved after its first interrupt." } })
      });
      expect(completedReplay.orchestrator_action).toBeUndefined();
      expect(
        store
          .listOrchestratorActions({ agentId: launched.firstContinuation.agent!.agent_id })
          .filter((action) => action.operation === "interrupt_agent")
      ).toHaveLength(2);
      expect(controller.getRun(launched.login.run.run_id).status).toBe("stopped");
    }
  );

  it("accepts a late worker report after shutdown without dispatching the next flow step", async () => {
    const ownerAdapter = new CapturingOwnerAdapter();
    registry.register(ownerAdapter);
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Late-report shutdown owner",
      repoDir: "/repo",
      backend: ownerAdapter.kind,
      backendHandle: { id: "late-report-shutdown-owner" }
    });
    const start = controller.startFlow({
      config: sameRoleNativeFlowConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-late-report-shutdown-owner",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const firstContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: firstContinuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed first-step spawn action.");
    }
    const workerAgentId = firstContinuation.agent!.agent_id;
    const nativeAgentId = "native-agent-late-report-shutdown";
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: nativeAgentId,
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });

    const shutdown = await controller.shutdownRun(login.run.run_id);
    expect(shutdown).toMatchObject({ run: { status: "stopping" }, complete: false });
    expect(controller.getAgent(workerAgentId).status).toBe("stopping");
    const actionsBeforeLateReport = store
      .listOrchestratorActions({ runId: login.run.run_id })
      .map((action) => action.action_id);

    const lateReport = await controller.reportFlowStepAndContinue({
      stepInstanceId: start.active_step!.step_instance_id,
      status: "completed",
      result: { phase: "first", reported_after_shutdown: true },
      summary: "The first phase completed before shutdown and reported its result late."
    });
    expect(lateReport.report).toMatchObject({
      reported_step: { step_id: "first", status: "completed" },
      active_step: { step_id: "second", status: "active", agent_id: null }
    });
    expect(lateReport.continuation).toMatchObject({
      action: "blocked",
      blocked_reason: "run_stopping_no_new_work",
      active_step: { step_id: "second", agent_id: null },
      dispatch: null,
      orchestrator_action: null
    });
    const mcpContinuation = (await handleTool(controller, "flow_continue", {
      flow_instance_id: start.instance.flow_instance_id,
      bridge_token: bridgeToken
    })) as Awaited<ReturnType<AgentController["continueFlow"]>>;
    expect(mcpContinuation).toMatchObject({
      action: "blocked",
      blocked_reason: "run_stopping_no_new_work",
      orchestrator_action: null
    });
    expect(controller.getAgent(workerAgentId).status).toBe("stopping");
    expect(controller.getRun(login.run.run_id).status).toBe("stopping");
    expect(
      store
        .listOrchestratorActions({ runId: login.run.run_id })
        .map((action) => action.action_id)
    ).toEqual(actionsBeforeLateReport);
    expect(
      controller
        .listEvents({ runId: login.run.run_id, type: "flow.notification" })
        .filter((event) => event.payload.reason === "native_orchestrator_action_required")
    ).toEqual([]);
    expect(ownerAdapter.sent).toEqual([]);

    await expect(
      controller.dispatchActiveFlowStep({
        flowInstanceId: start.instance.flow_instance_id,
        bridgeToken
      })
    ).rejects.toThrowError(/Durable stop intent blocks flow_dispatch_active/);
    await expect(
      controller.startAgent({ agentId: workerAgentId, prompt: "Do not restart this worker." })
    ).rejects.toThrowError(/Durable stop intent blocks agent_start/);
    await expect(
      handleTool(controller, "agent_send_message", {
        agent_id: workerAgentId,
        message: "Do not deliver work after shutdown."
      })
    ).rejects.toThrowError(/Durable stop intent blocks agent_send_message/);
    expect(controller.getAgent(workerAgentId).status).toBe("stopping");
    expect(
      store
        .listOrchestratorActions({ runId: login.run.run_id })
        .map((action) => action.action_id)
    ).toEqual(actionsBeforeLateReport);

    const interruptAction = shutdown.orchestrator_actions.find(
      (action) => action.operation === "interrupt_agent"
    )!;
    const interruptClaim = controller.claimOrchestratorAction({
      actionId: interruptAction.action_id,
      bridgeToken
    });
    if (!("action_token" in interruptClaim)) {
      throw new Error("Expected the shutdown interrupt to remain claimable.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: interruptClaim.action_id,
      actionToken: interruptClaim.action_token,
      status: "succeeded",
      result: {}
    });
    controller.syncCodexSubagent({
      agentId: workerAgentId,
      bridgeToken,
      nativeAgentId,
      nativeStatus: "interrupted"
    });
    expect(controller.getAgent(workerAgentId).status).toBe("stopped");
    expect(controller.getRun(login.run.run_id).status).toBe("stopped");
  });

  it("does not reclaim an expired work-starting action after durable stop intent", async () => {
    const ownerAdapter = new CapturingOwnerAdapter();
    const launched = await createPendingSameRoleFollowup(
      ownerAdapter,
      "expired-followup-stop-intent"
    );
    const followupAction = launched.handoff.continuation!.orchestrator_action!;
    const originalClaim = controller.claimOrchestratorAction({
      actionId: followupAction.action_id,
      bridgeToken: launched.bridgeToken
    });
    if (!("action_token" in originalClaim)) {
      throw new Error("Expected claimed follow-up action before shutdown.");
    }
    const claimedBeforeShutdown = store.getOrchestratorAction(followupAction.action_id)!;
    expect(claimedBeforeShutdown).toMatchObject({
      status: "claimed",
      claim_attempt: 1,
      action_token_hash: expect.any(String)
    });

    const shutdown = await controller.shutdownRun(launched.login.run.run_id);
    store.db
      .prepare("update orchestrator_actions set claim_lease_expires_at = ? where action_id = ?")
      .run("2000-01-01T00:00:00.000Z", followupAction.action_id);
    const expiredClaim = store.getOrchestratorAction(followupAction.action_id)!;
    expect(expiredClaim).toMatchObject({ status: "claimed", claim_attempt: 1 });

    expect(() =>
      controller.claimOrchestratorAction({
        actionId: followupAction.action_id,
        bridgeToken: launched.bridgeToken
      })
    ).toThrowError(/Durable stop intent blocks this work-starting orchestrator action/);
    const afterRejectedReclaim = store.getOrchestratorAction(followupAction.action_id)!;
    expect(afterRejectedReclaim).toMatchObject({
      status: "claimed",
      claim_attempt: claimedBeforeShutdown.claim_attempt,
      claimed_by_bridge_grant_id: claimedBeforeShutdown.claimed_by_bridge_grant_id,
      action_token_hash: claimedBeforeShutdown.action_token_hash
    });

    const lateAcknowledgement = controller.acknowledgeOrchestratorAction({
      actionId: originalClaim.action_id,
      actionToken: originalClaim.action_token,
      status: "succeeded",
      result: {}
    });
    const interruptAction = shutdown.orchestrator_actions.find(
      (action) => action.operation === "interrupt_agent"
    )!;
    expect(lateAcknowledgement).toMatchObject({
      agent: { status: "stopping" },
      orchestrator_action: {
        action_id: interruptAction.action_id,
        operation: "interrupt_agent"
      }
    });

    const interruptClaim = controller.claimOrchestratorAction({
      actionId: interruptAction.action_id,
      bridgeToken: launched.bridgeToken
    });
    if (!("action_token" in interruptClaim)) {
      throw new Error("Expected interrupt cleanup action to remain claimable.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: interruptClaim.action_id,
      actionToken: interruptClaim.action_token,
      status: "succeeded",
      result: {}
    });
    controller.syncCodexSubagent({
      agentId: launched.firstContinuation.agent!.agent_id,
      bridgeToken: launched.bridgeToken,
      nativeAgentId: launched.nativeAgentId,
      nativeStatus: "interrupted"
    });
    expect(controller.getRun(launched.login.run.run_id).status).toBe("stopped");
  });

  it("awaits bulk shutdown, surfaces native interrupts, and finalizes after terminal sync", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed spawn action.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: "native-agent-shutdown",
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });

    const shutdown = (await handleTool(controller, "run_shutdown", {
      run_id: launched.login.run.run_id
    })) as Awaited<ReturnType<AgentController["shutdownRun"]>>;
    expect(shutdown).toMatchObject({
      run: { status: "stopping" },
      complete: false,
      pending_agent_ids: [continuation.agent!.agent_id],
      orchestrator_actions: [
        expect.objectContaining({ operation: "interrupt_agent", status: "pending" })
      ]
    });
    expect(
      shutdown.stopped.find((agent) => agent.agent_id === continuation.agent!.agent_id)
    ).toMatchObject({
      status: "stopping",
      orchestrator_action: { operation: "interrupt_agent", status: "pending" }
    });

    const interruptAction = shutdown.orchestrator_actions[0]!;
    const interruptClaim = controller.claimOrchestratorAction({
      actionId: interruptAction.action_id,
      bridgeToken
    });
    if (!("action_token" in interruptClaim)) {
      throw new Error("Expected claimed interrupt action.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: interruptClaim.action_id,
      actionToken: interruptClaim.action_token,
      status: "succeeded",
      result: {}
    });
    expect(store.getRun(launched.login.run.run_id)?.status).toBe("stopping");

    controller.syncCodexSubagent({
      agentId: continuation.agent!.agent_id,
      bridgeToken,
      nativeAgentId: "native-agent-shutdown",
      nativeStatus: "interrupted"
    });
    expect(store.getRun(launched.login.run.run_id)?.status).toBe("stopped");
  });

  it.each(["succeeded", "failed"] as const)(
    "preserves stopped external truth when interrupt acknowledgement finishes as %s",
    async (ackStatus) => {
      const launched = launchNativeFlow();
      const bridgeToken = launched.start.bridge_credential!.bridge_token;
      const continuation = await controller.continueFlow({
        flowInstanceId: launched.start.instance.flow_instance_id,
        bridgeToken
      });
      const spawnClaim = controller.claimOrchestratorAction({
        actionId: continuation.orchestrator_action!.action_id,
        bridgeToken
      });
      if (!("action_token" in spawnClaim)) {
        throw new Error("Expected claimed spawn action.");
      }
      const nativeAgentId = `native-agent-terminal-interrupt-${ackStatus}`;
      controller.acknowledgeOrchestratorAction({
        actionId: spawnClaim.action_id,
        actionToken: spawnClaim.action_token,
        status: "succeeded",
        result: {
          native_agent_id: nativeAgentId,
          native_task_name: spawnClaim.request.task_name,
          native_task_path: spawnClaim.request.expected_task_path
        }
      });

      const shutdown = await controller.shutdownRun(launched.login.run.run_id);
      const interruptAction = shutdown.orchestrator_actions.find(
        (action) => action.operation === "interrupt_agent"
      )!;
      const interruptClaim = controller.claimOrchestratorAction({
        actionId: interruptAction.action_id,
        bridgeToken
      });
      if (!("action_token" in interruptClaim)) {
        throw new Error("Expected claimed interrupt action.");
      }

      controller.syncCodexSubagent({
        agentId: continuation.agent!.agent_id,
        bridgeToken,
        nativeAgentId,
        nativeStatus: "interrupted"
      });
      expect(controller.getRun(launched.login.run.run_id).status).toBe("stopped");

      const acknowledged = controller.acknowledgeOrchestratorAction({
        actionId: interruptClaim.action_id,
        actionToken: interruptClaim.action_token,
        status: ackStatus,
        ...(ackStatus === "succeeded"
          ? { result: {} }
          : { error: { message: "Late interrupt transport failure." } })
      });
      expect(acknowledged.agent).toMatchObject({ status: "stopped", failure_reason: null });
      expect(controller.getAgent(continuation.agent!.agent_id)).toMatchObject({
        status: "stopped",
        failure_reason: null
      });
      expect(controller.getRun(launched.login.run.run_id).status).toBe("stopped");
    }
  );

  it("keeps a shutting-down run non-terminal when its native interrupt fails", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed spawn action.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: "native-agent-failed-interrupt",
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });

    const shutdown = await controller.shutdownRun(launched.login.run.run_id);
    const interruptClaim = controller.claimOrchestratorAction({
      actionId: shutdown.orchestrator_actions[0]!.action_id,
      bridgeToken
    });
    if (!("action_token" in interruptClaim)) {
      throw new Error("Expected claimed interrupt action.");
    }
    const failed = controller.acknowledgeOrchestratorAction({
      actionId: interruptClaim.action_id,
      actionToken: interruptClaim.action_token,
      status: "failed",
      error: { message: "Native interrupt tool failed." }
    });

    expect(failed.agent).toMatchObject({ status: "stopping", failure_reason: "tool_error" });
    expect(store.getRun(launched.login.run.run_id)?.status).toBe("stopping");
  });

  it("maps send, follow-up, and interrupt to exact root operations", async () => {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected spawn claim.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: { native_agent_id: "native-agent-ops" }
    });
    const workerId = continuation.agent!.agent_id;
    const bridgeTokenB = "acb_derived_action_owner_b";
    store.createBridgeGrant({
      runId: launched.login.run.run_id,
      orchestratorAgentId: launched.login.agent.agent_id,
      ownerTaskIdentity: "derived-action-owner-b",
      ownerTaskPath: "/root/b",
      tokenHash: hashToken(bridgeTokenB)
    });

    const send = await controller.sendMessage(workerId, "message while running");
    expect(send).toMatchObject({
      delivered: false,
      orchestrator_action: { operation: "send_message" }
    });
    if (send.delivered) {
      throw new Error("Expected bridged send action.");
    }
    expect(store.getOrchestratorAction(send.orchestrator_action.action_id)).toMatchObject({
      originating_bridge_grant_id:
        launched.start.bridge_credential!.bridge_grant_id
    });
    expect(() =>
      controller.claimOrchestratorAction({
        actionId: send.orchestrator_action.action_id,
        bridgeToken: bridgeTokenB
      })
    ).toThrowError(expect.objectContaining({ reason: "auth_required" }));
    const sendClaim = controller.claimOrchestratorAction({
      actionId: send.orchestrator_action.action_id,
      bridgeToken
    });
    expect(sendClaim).toMatchObject({
      operation: "send_message",
      request: {
        target: expect.stringMatching(/^\/root\/worker_[a-z0-9]+$/),
        message: "message while running"
      }
    });

    controller.syncCodexSubagent({
      agentId: workerId,
      bridgeToken,
      nativeAgentId: "native-agent-ops",
      nativeStatus: "completed"
    });
    const followup = await controller.sendMessage(workerId, "restart from idle");
    expect(followup).toMatchObject({
      delivered: false,
      orchestrator_action: { operation: "followup_task" }
    });
    if (followup.delivered) {
      throw new Error("Expected bridged follow-up action.");
    }
    expect(
      store.getOrchestratorAction(followup.orchestrator_action.action_id)
    ).toMatchObject({
      originating_bridge_grant_id:
        launched.start.bridge_credential!.bridge_grant_id
    });
    const interrupted = await controller.stopAgent(workerId, "interrupt");
    expect(interrupted.orchestrator_action).toMatchObject({ operation: "interrupt_agent" });
    expect(
      store.getOrchestratorAction(interrupted.orchestrator_action!.action_id)
    ).toMatchObject({
      originating_bridge_grant_id:
        launched.start.bridge_credential!.bridge_grant_id
    });
  });

  it.each([
    {
      nativeStatus: "completed",
      ackStatus: "failed",
      expectedStatus: "completed",
      expectedFailureReason: null
    },
    {
      nativeStatus: "errored",
      ackStatus: "succeeded",
      expectedStatus: "failed",
      expectedFailureReason: "tool_error"
    }
  ] as const)(
    "preserves $nativeStatus external truth when send acknowledgement finishes as $ackStatus",
    async ({ nativeStatus, ackStatus, expectedStatus, expectedFailureReason }) => {
      const launched = launchNativeFlow();
      const bridgeToken = launched.start.bridge_credential!.bridge_token;
      const continuation = await controller.continueFlow({
        flowInstanceId: launched.start.instance.flow_instance_id,
        bridgeToken
      });
      const spawnClaim = controller.claimOrchestratorAction({
        actionId: continuation.orchestrator_action!.action_id,
        bridgeToken
      });
      if (!("action_token" in spawnClaim)) {
        throw new Error("Expected claimed spawn action.");
      }
      const nativeAgentId = `native-agent-terminal-send-${ackStatus}`;
      controller.acknowledgeOrchestratorAction({
        actionId: spawnClaim.action_id,
        actionToken: spawnClaim.action_token,
        status: "succeeded",
        result: { native_agent_id: nativeAgentId }
      });

      const sent = await controller.sendMessage(
        continuation.agent!.agent_id,
        "Transport acknowledgement may arrive after terminal sync."
      );
      if (sent.delivered) {
        throw new Error("Expected bridged send action.");
      }
      const sendClaim = controller.claimOrchestratorAction({
        actionId: sent.orchestrator_action.action_id,
        bridgeToken
      });
      if (!("action_token" in sendClaim)) {
        throw new Error("Expected claimed send action.");
      }

      controller.syncCodexSubagent({
        agentId: continuation.agent!.agent_id,
        bridgeToken,
        nativeAgentId,
        nativeStatus
      });
      const acknowledged = controller.acknowledgeOrchestratorAction({
        actionId: sendClaim.action_id,
        actionToken: sendClaim.action_token,
        status: ackStatus,
        ...(ackStatus === "succeeded"
          ? { result: {} }
          : { error: { message: "Late send transport failure." } })
      });

      expect(acknowledged.agent).toMatchObject({
        status: expectedStatus,
        failure_reason: expectedFailureReason
      });
      expect(controller.getAgent(continuation.agent!.agent_id)).toMatchObject({
        status: expectedStatus,
        failure_reason: expectedFailureReason
      });
    }
  );

  it("uses one durable follow-up when the same native task advances to a new flow step", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Same-role follow-up orchestrator",
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: sameRoleNativeFlowConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-same-role-follow-up",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const firstContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: firstContinuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed first-step spawn action.");
    }
    const nativeAgentId = "native-agent-same-role-follow-up";
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: nativeAgentId,
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });

    // The worker reports while its native task is still logically running. A
    // new flow step must nevertheless persist a follow-up action because the
    // task can become idle before the root orchestrator claims that action.
    const handoff = await controller.reportFlowStepAndContinue({
      stepInstanceId: start.active_step!.step_instance_id,
      status: "completed",
      result: { phase: "first" },
      summary: "The first same-role phase is complete."
    });
    expect(handoff.continuation).toMatchObject({
      action: "orchestrator_action_required",
      active_step: { step_id: "second" },
      agent: { agent_id: firstContinuation.agent!.agent_id },
      orchestrator_action: {
        operation: "followup_task",
        status: "pending",
        step_instance_id: handoff.report.active_step!.step_instance_id
      }
    });
    const nextAction = handoff.continuation!.orchestrator_action!;
    expect(
      store
        .listOrchestratorActions({ agentId: firstContinuation.agent!.agent_id })
        .filter((action) => action.operation === "spawn_agent")
    ).toHaveLength(1);

    const wakeups = controller
      .listEvents({ runId: login.run.run_id, type: "flow.notification" })
      .filter((event) => event.payload.reason === "native_orchestrator_action_required");
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.event_id).toBe(`event_${nextAction.action_id.slice("action_".length)}`);
    expect(wakeups[0]).toMatchObject({
      agent_id: firstContinuation.agent!.agent_id,
      payload: {
        flow_instance_id: start.instance.flow_instance_id,
        step_instance_id: nextAction.step_instance_id,
        reason: "native_orchestrator_action_required",
        orchestrator_action: nextAction
      }
    });
    expect(JSON.stringify(wakeups[0]?.payload)).not.toContain("request");
    expect(JSON.stringify(wakeups[0]?.payload)).not.toContain("bridge_token");
    expect(JSON.stringify(wakeups[0]?.payload)).not.toContain("action_token");

    const repeatedContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    expect(repeatedContinuation.orchestrator_action?.action_id).toBe(nextAction.action_id);

    // External state can advance after action creation but before claim. The
    // persisted operation must remain a follow-up so claiming it still starts
    // the new turn on the now-idle native task.
    controller.syncCodexSubagent({
      agentId: firstContinuation.agent!.agent_id,
      bridgeToken,
      nativeAgentId,
      nativeTaskPath: String(spawnClaim.request.expected_task_path),
      nativeStatus: "completed",
      observedAt: new Date(Date.now() - 5_000).toISOString()
    });
    const stepActionClaim = controller.claimOrchestratorAction({
      actionId: nextAction.action_id,
      bridgeToken
    });
    if (!("action_token" in stepActionClaim)) {
      throw new Error("Expected claimed reused-task follow-up action.");
    }
    expect(stepActionClaim).toMatchObject({
      operation: "followup_task",
      step_instance_id: handoff.report.active_step!.step_instance_id,
      request: {
        target: spawnClaim.request.expected_task_path,
        message: expect.stringContaining("Complete the second phase using the existing native task.")
      }
    });
    const acknowledged = controller.acknowledgeOrchestratorAction({
      actionId: stepActionClaim.action_id,
      actionToken: stepActionClaim.action_token,
      status: "succeeded",
      result: {}
    });
    expect(acknowledged.agent).toMatchObject({ status: "running", failure_reason: null });
    expect(controller.getAgent(firstContinuation.agent!.agent_id).status).toBe("running");

    const waitingForReport = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    expect(waitingForReport).toMatchObject({
      action: "waiting_for_report",
      active_step: { step_instance_id: handoff.report.active_step!.step_instance_id },
      agent: { agent_id: firstContinuation.agent!.agent_id, status: "running" }
    });

    const durableFollowup = store.getOrchestratorAction(stepActionClaim.action_id)!;
    const newTurnCompletedAt = new Date(Date.parse(durableFollowup.claimed_at!) + 1_000).toISOString();
    const newTurnTerminal = controller.syncCodexSubagent({
      agentId: firstContinuation.agent!.agent_id,
      bridgeToken,
      nativeAgentId,
      nativeTaskPath: String(spawnClaim.request.expected_task_path),
      nativeStatus: "completed",
      observedAt: newTurnCompletedAt
    });
    expect(newTurnTerminal.agent.status).toBe("completed");

    const completed = await controller.reportFlowStepAndContinue({
      stepInstanceId: handoff.report.active_step!.step_instance_id,
      status: "completed",
      result: { phase: "second" },
      summary: "The reused native task completed the second phase."
    });
    expect(completed.report.instance.status).toBe("completed");
    expect(completed.continuation).toBeNull();
    expect(
      store
        .listOrchestratorActions({ agentId: firstContinuation.agent!.agent_id })
        .filter((action) => action.operation === "spawn_agent")
    ).toHaveLength(1);
    await controller.drainDeliveries();
  });

  it("preserves a terminal native observation recorded after the follow-up claim", async () => {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Fast same-role follow-up orchestrator",
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: sameRoleNativeFlowConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-fast-same-role-follow-up",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const firstContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: firstContinuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed first-step spawn action.");
    }
    const nativeAgentId = "native-agent-fast-same-role-follow-up";
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: nativeAgentId,
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });
    const handoff = await controller.reportFlowStepAndContinue({
      stepInstanceId: start.active_step!.step_instance_id,
      status: "completed",
      result: { phase: "first" },
      summary: "The first phase handed off to a fast follow-up."
    });
    const followupClaim = controller.claimOrchestratorAction({
      actionId: handoff.continuation!.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in followupClaim)) {
      throw new Error("Expected claimed fast follow-up action.");
    }
    const durableFollowup = store.getOrchestratorAction(followupClaim.action_id)!;
    controller.syncCodexSubagent({
      agentId: firstContinuation.agent!.agent_id,
      bridgeToken,
      nativeAgentId,
      nativeTaskPath: String(spawnClaim.request.expected_task_path),
      nativeStatus: "completed",
      observedAt: new Date(Date.parse(durableFollowup.claimed_at!) + 1_000).toISOString()
    });

    const acknowledged = controller.acknowledgeOrchestratorAction({
      actionId: followupClaim.action_id,
      actionToken: followupClaim.action_token,
      status: "succeeded",
      result: {}
    });
    expect(acknowledged.agent).toMatchObject({ status: "completed", failure_reason: null });
    expect(controller.getAgent(firstContinuation.agent!.agent_id).status).toBe("completed");

    const completed = await controller.reportFlowStepAndContinue({
      stepInstanceId: handoff.report.active_step!.step_instance_id,
      status: "completed",
      result: { phase: "second" },
      summary: "The fast follow-up completed before its transport ACK arrived."
    });
    expect(completed.report.instance.status).toBe("completed");
    expect(completed.continuation).toBeNull();
    await controller.drainDeliveries();
  });

  it("treats a terminal observation exactly equal to the follow-up claim as old-turn evidence", async () => {
    const launched = await createPendingSameRoleFollowup(
      new CapturingOwnerAdapter(),
      "equal-followup-timestamp"
    );
    await controller.drainDeliveries();
    const followupAction = launched.handoff.continuation!.orchestrator_action!;
    const followupClaim = controller.claimOrchestratorAction({
      actionId: followupAction.action_id,
      bridgeToken: launched.bridgeToken
    });
    if (!("action_token" in followupClaim)) {
      throw new Error("Expected claimed equality-boundary follow-up action.");
    }
    const durableFollowup = store.getOrchestratorAction(followupClaim.action_id)!;
    const claimedAt = durableFollowup.claimed_at!;
    controller.syncCodexSubagent({
      agentId: launched.firstContinuation.agent!.agent_id,
      bridgeToken: launched.bridgeToken,
      nativeAgentId: launched.nativeAgentId,
      nativeTaskPath: String(launched.spawnClaim.request.expected_task_path),
      nativeStatus: "completed",
      observedAt: claimedAt
    });
    expect(
      store.getCodexSubagentExternalState(launched.firstContinuation.agent!.agent_id)
        ?.observed_at
    ).toBe(claimedAt);

    const acknowledged = controller.acknowledgeOrchestratorAction({
      actionId: followupClaim.action_id,
      actionToken: followupClaim.action_token,
      status: "succeeded",
      result: {}
    });
    expect(acknowledged.agent).toMatchObject({ status: "running", failure_reason: null });
    const waiting = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken: launched.bridgeToken
    });
    expect(waiting).toMatchObject({
      action: "waiting_for_report",
      agent: { status: "running" }
    });

    controller.syncCodexSubagent({
      agentId: launched.firstContinuation.agent!.agent_id,
      bridgeToken: launched.bridgeToken,
      nativeAgentId: launched.nativeAgentId,
      nativeTaskPath: String(launched.spawnClaim.request.expected_task_path),
      nativeStatus: "completed",
      observedAt: new Date(Date.parse(claimedAt) + 1).toISOString()
    });
    const completed = await controller.reportFlowStepAndContinue({
      stepInstanceId: launched.handoff.report.active_step!.step_instance_id,
      status: "completed",
      result: { phase: "second" },
      summary: "The equality-boundary follow-up completed."
    });
    expect(completed.report.instance.status).toBe("completed");
    expect(completed.continuation).toBeNull();
  });

  it("wakes the root owner once when worker auto-continue creates a native handoff action", async () => {
    const ownerAdapter = new CapturingOwnerAdapter();
    registry.register(ownerAdapter);
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Native handoff owner",
      repoDir: "/repo",
      backend: ownerAdapter.kind,
      backendHandle: { id: "native-handoff-owner" }
    });
    const start = controller.startFlow({
      config: twoRoleNativeHandoffFlowConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-native-handoff-owner",
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const firstContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    await controller.drainDeliveries();
    expect(ownerAdapter.sent).toHaveLength(0);
    expect(
      controller
        .listEvents({ runId: login.run.run_id, type: "flow.notification" })
        .filter((event) => event.payload.reason === "native_orchestrator_action_required")
    ).toHaveLength(0);

    const firstSpawnClaim = controller.claimOrchestratorAction({
      actionId: firstContinuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in firstSpawnClaim)) {
      throw new Error("Expected claimed first-role spawn action.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: firstSpawnClaim.action_id,
      actionToken: firstSpawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: "native-handoff-analysis",
        native_task_name: firstSpawnClaim.request.task_name,
        native_task_path: firstSpawnClaim.request.expected_task_path
      }
    });

    const handoff = await controller.reportFlowStepAndContinue({
      stepInstanceId: start.active_step!.step_instance_id,
      status: "completed",
      result: { analysis_ready: true },
      summary: "Analysis is ready for review."
    });
    expect(handoff.continuation).toMatchObject({
      action: "orchestrator_action_required",
      active_step: { step_id: "review" },
      orchestrator_action: { operation: "spawn_agent", status: "pending" }
    });
    await controller.drainDeliveries();

    const nextAction = handoff.continuation!.orchestrator_action!;
    const wakeups = controller
      .listEvents({ runId: login.run.run_id, type: "flow.notification" })
      .filter((event) => event.payload.reason === "native_orchestrator_action_required");
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.event_id).toBe(
      `event_${nextAction.action_id.slice("action_".length)}`
    );
    expect(wakeups[0]).toMatchObject({
      agent_id: firstContinuation.agent!.agent_id,
      payload: {
        flow_instance_id: start.instance.flow_instance_id,
        step_instance_id: nextAction.step_instance_id,
        reason: "native_orchestrator_action_required",
        orchestrator_action: nextAction
      }
    });
    expect(JSON.stringify(wakeups[0]?.payload)).not.toContain("request");
    expect(JSON.stringify(wakeups[0]?.payload)).not.toContain("bridge_token");
    expect(JSON.stringify(wakeups[0]?.payload)).not.toContain("action_token");
    const replayedWakeup = store.createEvent({
      eventId: wakeups[0]!.event_id,
      runId: wakeups[0]!.run_id,
      agentId: wakeups[0]!.agent_id,
      type: wakeups[0]!.type,
      payload: wakeups[0]!.payload
    });
    expect(replayedWakeup).toEqual(wakeups[0]);
    expect(
      controller
        .listEvents({ runId: login.run.run_id, type: "flow.notification" })
        .filter((event) => event.payload.reason === "native_orchestrator_action_required")
    ).toHaveLength(1);
    expect(ownerAdapter.sent).toHaveLength(1);
    expect(ownerAdapter.sent[0]?.message).toContain(nextAction.action_id);
    expect(ownerAdapter.sent[0]?.message).toContain("Orchestrator operation: spawn_agent");
    expect(ownerAdapter.sent[0]?.message).toContain("Claim and execute the safe action reference above");
    const ownerSubscription = controller
      .listSubscriptions({ runId: login.run.run_id, enabledOnly: true })
      .find(
        (subscription) =>
          subscription.subscriber_agent_id === login.agent.agent_id &&
          subscription.event_type === "flow.notification"
      );
    expect(ownerSubscription?.last_delivered_event_id).toBe(wakeups[0]?.event_id);

    const repeatedContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    expect(repeatedContinuation.orchestrator_action?.action_id).toBe(nextAction.action_id);
    await controller.drainDeliveries();
    expect(
      controller
        .listEvents({ runId: login.run.run_id, type: "flow.notification" })
        .filter((event) => event.payload.reason === "native_orchestrator_action_required")
    ).toHaveLength(1);
    expect(ownerAdapter.sent).toHaveLength(1);

    const secondSpawnClaim = controller.claimOrchestratorAction({
      actionId: nextAction.action_id,
      bridgeToken
    });
    if (!("action_token" in secondSpawnClaim)) {
      throw new Error("Expected claimed second-role spawn action.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: secondSpawnClaim.action_id,
      actionToken: secondSpawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: "native-handoff-review",
        native_task_name: secondSpawnClaim.request.task_name,
        native_task_path: secondSpawnClaim.request.expected_task_path
      }
    });
    const completed = await controller.reportFlowStepAndContinue({
      stepInstanceId: handoff.report.active_step!.step_instance_id,
      status: "completed",
      result: { approved: true },
      summary: "Review approved the handoff."
    });
    expect(completed.report.instance.status).toBe("completed");
    expect(completed.continuation).toBeNull();
  });

  it("retries a transient Codex owner wake with bounded deterministic backoff", async () => {
    const ownerAdapter = new FlakyCodexThreadOwnerAdapter();
    registry.register(ownerAdapter);
    controller = new AgentController(store, registry, null, {
      nativeActionDeliveryRetryDelaysMs: [0, 1]
    });
    const launched = await createPendingNativeHandoff(ownerAdapter, "automatic-retry");

    await controller.drainDeliveries();

    const action = launched.handoff.continuation!.orchestrator_action!;
    const wakeups = controller
      .listEvents({ runId: launched.login.run.run_id, type: "flow.notification" })
      .filter((event) => event.payload.reason === "native_orchestrator_action_required");
    expect(ownerAdapter.attempts).toBe(2);
    expect(ownerAdapter.sent).toHaveLength(1);
    expect(controller.getAgent(launched.login.agent.agent_id).work_generation).toBe(2);
    expect(
      store.db
        .prepare(
          `select count(*) as count
           from agent_work_acceptances
           where agent_id = ? and acceptance_key like 'subscription-delivery:%'`
        )
        .get(launched.login.agent.agent_id)
    ).toMatchObject({ count: 2 });
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.event_id).toBe(`event_${action.action_id.slice("action_".length)}`);
    expect(JSON.stringify(wakeups[0]?.payload)).not.toContain("request");
    expect(JSON.stringify(wakeups[0]?.payload)).not.toContain("bridge_token");
    expect(JSON.stringify(wakeups[0]?.payload)).not.toContain("action_token");
    expect(
      controller
        .listEvents({ runId: launched.login.run.run_id, type: "agent.delivery_failed" })
        .filter((event) => event.payload.source_event_id === wakeups[0]?.event_id)
    ).toHaveLength(1);
    const ownerSubscription = controller
      .listSubscriptions({ runId: launched.login.run.run_id, enabledOnly: true })
      .find(
        (subscription) =>
          subscription.subscriber_agent_id === launched.login.agent.agent_id &&
          subscription.event_type === "flow.notification"
      );
    expect(ownerSubscription?.last_delivered_event_id).toBe(wakeups[0]?.event_id);

    const repeated = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken: launched.bridgeToken
    });
    expect(repeated.orchestrator_action?.action_id).toBe(action.action_id);
    await controller.drainDeliveries();
    expect(ownerAdapter.attempts).toBe(2);
    expect(ownerAdapter.sent).toHaveLength(1);
    expect(
      controller
        .listEvents({ runId: launched.login.run.run_id, type: "flow.notification" })
        .filter((event) => event.payload.reason === "native_orchestrator_action_required")
    ).toHaveLength(1);
  });

  it("re-drives one undelivered native wake on continue and controller startup", async () => {
    const ownerAdapter = new FlakyCodexThreadOwnerAdapter(2);
    registry.register(ownerAdapter);
    controller = new AgentController(store, registry, null, {
      nativeActionDeliveryRetryDelaysMs: []
    });
    const launched = await createPendingNativeHandoff(ownerAdapter, "durable-redrive");
    await controller.drainDeliveries();
    expect(ownerAdapter.attempts).toBe(1);
    expect(ownerAdapter.sent).toHaveLength(0);

    const action = launched.handoff.continuation!.orchestrator_action!;
    const resumed = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken: launched.bridgeToken
    });
    expect(resumed.orchestrator_action?.action_id).toBe(action.action_id);
    await controller.drainDeliveries();
    expect(ownerAdapter.attempts).toBe(2);
    expect(ownerAdapter.sent).toHaveLength(0);

    // Simulate losing every in-memory timer/task. Constructor recovery scans
    // only open actions and schedules their already-persisted deterministic
    // wake event; it never creates a replacement row.
    controller = new AgentController(store, registry, null, {
      nativeActionDeliveryRetryDelaysMs: []
    });
    await controller.drainDeliveries();
    expect(ownerAdapter.attempts).toBe(3);
    expect(ownerAdapter.sent).toHaveLength(1);

    const wakeups = controller
      .listEvents({ runId: launched.login.run.run_id, type: "flow.notification" })
      .filter((event) => event.payload.reason === "native_orchestrator_action_required");
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.event_id).toBe(`event_${action.action_id.slice("action_".length)}`);
    const ownerSubscription = controller
      .listSubscriptions({ runId: launched.login.run.run_id, enabledOnly: true })
      .find(
        (subscription) =>
          subscription.subscriber_agent_id === launched.login.agent.agent_id &&
          subscription.event_type === "flow.notification"
      );
    expect(ownerSubscription?.last_delivered_event_id).toBe(wakeups[0]?.event_id);

    await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken: launched.bridgeToken
    });
    await controller.drainDeliveries();
    expect(ownerAdapter.attempts).toBe(3);
    expect(ownerAdapter.sent).toHaveLength(1);
  });

  it("rejects model and unknown native options while accepting explicit fork inheritance", () => {
    expect(() =>
      controller.validateFlowConfig(nativeConfig({ model: "gpt-override" }))
    ).toThrowError(/does not support model overrides/);
    expect(() =>
      controller.validateFlowConfig({
        ...nativeConfig(),
        roles: {
          worker: {
            backend: "codex-subagent",
            agent_type: "worker"
          }
        }
      })
    ).toThrowError(/Unsupported codex-subagent role option/);

    const validated = controller.validateFlowConfig(
      nativeConfig({
        model: "",
        backend_options: { codex_subagent: { fork_turns: "all" } }
      })
    );
    expect(validated.config.roles?.worker).toMatchObject({
      backend: "codex-subagent",
      backend_options: { codex_subagent: { fork_turns: "all" } }
    });
    expect(validated.config.roles?.worker.model).toBeUndefined();
  });

  it("exposes MCP bridge contracts and purges native rows", async () => {
    const toolNames = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(toolNames.has("orchestrator_action_claim")).toBe(true);
    expect(toolNames.has("orchestrator_action_ack")).toBe(true);
    expect(toolNames.has("agent_external_sync")).toBe(true);

    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await handleTool(controller, "flow_continue", {
      flow_instance_id: launched.start.instance.flow_instance_id,
      bridge_token: bridgeToken
    }) as { orchestrator_action: { action_id: string } };
    const claimed = await handleTool(controller, "orchestrator_action_claim", {
      action_id: continuation.orchestrator_action.action_id,
      bridge_token: bridgeToken
    }) as { action_token: string };
    expect(claimed.action_token).toMatch(/^aca_/);

    const preview = await controller.runPurge(launched.login.run.run_id, {
      dryRun: true,
      force: true,
      deleteRuntimeFiles: false
    });
    expect(preview.deleted_rows.bridge_grants).toBe(1);
    expect(preview.deleted_rows.orchestrator_actions).toBe(1);
    await controller.runPurge(launched.login.run.run_id, {
      dryRun: false,
      force: true,
      deleteRuntimeFiles: false
    });
    expect(store.db.prepare("select count(*) as count from bridge_grants").get()).toMatchObject({ count: 0 });
    expect(store.db.prepare("select count(*) as count from orchestrator_actions").get()).toMatchObject({ count: 0 });
  });

  it("migrates an existing flow_instances table and creates bridge indexes", () => {
    const legacyPath = join(tmp, "legacy.sqlite");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      create table runs (
        run_id text primary key,
        title text not null,
        repo_dir text,
        status text not null,
        created_at text not null,
        updated_at text not null
      );
      create table flows (
        flow_record_id text primary key,
        flow_id text not null,
        version text,
        description text,
        config_json text not null,
        created_at text not null,
        updated_at text not null
      );
      create table flow_instances (
        flow_instance_id text primary key,
        flow_record_id text not null,
        run_id text not null,
        originating_bridge_grant_id text,
        status text not null,
        current_step_id text,
        created_at text not null,
        updated_at text not null
      );
    `);
    legacy.close();

    const migrated = new SqliteStore(legacyPath);
    const columns = migrated.db.prepare("pragma table_info(flow_instances)").all() as Array<{ name: string }>;
    const foreignKeys = migrated.db
      .prepare("pragma foreign_key_list(flow_instances)")
      .all();
    const indexes = migrated.db.prepare("select name from sqlite_master where type = 'index'").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("orchestrator_agent_id");
    expect(columns.map((column) => column.name)).toContain("originating_bridge_grant_id");
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "bridge_grants",
          from: "originating_bridge_grant_id",
          on_delete: "SET NULL"
        })
      ])
    );
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_bridge_grants_run_orchestrator",
        "idx_flow_instances_origin_grant",
        "idx_orchestrator_actions_run_status",
        "idx_orchestrator_actions_agent_status"
      ])
    );
    migrated.close();
  });

  it.each([
    {
      caseName: "wrong target column",
      flowOriginDefinition:
        "text references bridge_grants(token_hash) on delete set null",
      actionOriginDefinition:
        "text references bridge_grants(bridge_grant_id)",
      flowTableConstraint: "",
      verifyFlowDeleteSetNull: false
    },
    {
      caseName: "wrong ON UPDATE action",
      flowOriginDefinition:
        "text references bridge_grants(bridge_grant_id) on delete set null",
      actionOriginDefinition:
        "text references bridge_grants(bridge_grant_id) on update cascade",
      flowTableConstraint: "",
      verifyFlowDeleteSetNull: false
    },
    {
      caseName: "NOT NULL SET NULL source",
      flowOriginDefinition:
        "text not null references bridge_grants(bridge_grant_id) on delete set null",
      actionOriginDefinition:
        "text references bridge_grants(bridge_grant_id)",
      flowTableConstraint: "",
      verifyFlowDeleteSetNull: false
    },
    {
      caseName: "composite flow foreign key",
      flowOriginDefinition: "text",
      actionOriginDefinition:
        "text references bridge_grants(bridge_grant_id)",
      // The malformed SET NULL applies to both child columns. If accepted as
      // equivalent, deleting a grant tries to null the required run_id too.
      flowTableConstraint:
        ", foreign key (originating_bridge_grant_id, run_id) references bridge_grants(bridge_grant_id, run_id) on delete set null",
      verifyFlowDeleteSetNull: true
    }
  ])(
    "rebuilds empty legacy origin tables with $caseName",
    async ({
      caseName,
      flowOriginDefinition,
      actionOriginDefinition,
      flowTableConstraint,
      verifyFlowDeleteSetNull
    }) => {
      const legacyPath = join(
        tmp,
        `legacy-wrong-origin-fk-${caseName.replaceAll(" ", "-")}.sqlite`
      );
      const legacy = new Database(legacyPath);
      legacy.exec(`
        create table schema_migrations (
          migration_id text primary key,
          applied_at text not null
        );
        insert into schema_migrations (migration_id, applied_at)
        values ('2026-07-16-native-origin-grant-fk-v4', '2026-07-16T00:00:00.000Z');
        create table flow_instances (
          flow_instance_id text primary key,
          flow_record_id text not null references flows(flow_record_id) on delete cascade,
          run_id text not null references runs(run_id) on delete cascade,
          orchestrator_agent_id text,
          originating_bridge_grant_id ${flowOriginDefinition},
          status text not null,
          current_step_id text,
          created_at text not null,
          updated_at text not null
          ${flowTableConstraint}
        );
        create table orchestrator_actions (
          action_id text primary key,
          idempotency_key text not null unique,
          run_id text not null references runs(run_id) on delete cascade,
          orchestrator_agent_id text not null references agents(agent_id) on delete cascade,
          agent_id text not null references agents(agent_id) on delete cascade,
          flow_instance_id text references flow_instances(flow_instance_id) on delete cascade,
          step_instance_id text references flow_step_instances(step_instance_id) on delete cascade,
          operation text not null,
          status text not null,
          payload_json text not null,
          result_json text,
          error_json text,
          originating_bridge_grant_id ${actionOriginDefinition},
          claimed_by_bridge_grant_id text references bridge_grants(bridge_grant_id) on delete set null,
          claim_owner_identity text,
          claim_attempt integer not null default 0,
          claimed_at text,
          claim_lease_expires_at text,
          action_token_hash text,
          created_at text not null,
          updated_at text not null,
          completed_at text
        );
      `);
      legacy.close();

      const migrated = new SqliteStore(legacyPath);
      const flowOriginColumn = (
        migrated.db.prepare("pragma table_info(flow_instances)").all() as Array<
          Record<string, unknown>
        >
      ).find((column) => column.name === "originating_bridge_grant_id");
      const actionOriginColumn = (
        migrated.db.prepare("pragma table_info(orchestrator_actions)").all() as Array<
          Record<string, unknown>
        >
      ).find((column) => column.name === "originating_bridge_grant_id");
      expect(flowOriginColumn).toMatchObject({ notnull: 0 });
      expect(actionOriginColumn).toMatchObject({ notnull: 0 });
      expect(
        migrated.db.prepare("pragma foreign_key_list(flow_instances)").all()
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "bridge_grants",
            from: "originating_bridge_grant_id",
            to: "bridge_grant_id",
            on_delete: "SET NULL",
            on_update: "NO ACTION"
          })
        ])
      );
      if (verifyFlowDeleteSetNull) {
        const grantForeignKeys = (
          migrated.db.prepare("pragma foreign_key_list(flow_instances)").all() as Array<
            Record<string, unknown>
          >
        ).filter((foreignKey) => foreignKey.table === "bridge_grants");
        expect(grantForeignKeys).toEqual([
          expect.objectContaining({
            seq: 0,
            table: "bridge_grants",
            from: "originating_bridge_grant_id",
            to: "bridge_grant_id",
            on_delete: "SET NULL",
            on_update: "NO ACTION"
          })
        ]);
      }
      expect(
        migrated.db.prepare("pragma foreign_key_list(orchestrator_actions)").all()
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "bridge_grants",
            from: "originating_bridge_grant_id",
            to: "bridge_grant_id",
            on_delete: "NO ACTION",
            on_update: "NO ACTION"
          })
        ])
      );

      const migratedRegistry = new AdapterRegistry();
      migratedRegistry.register(new ManualAdapter());
      migratedRegistry.register(new CodexSubagentAdapter());
      const migratedController = new AgentController(
        migrated,
        migratedRegistry
      );
      const login = migratedController.orchestratorLogin({
        adminKey: "ack_native_bridge_test",
        title: `Future insert after ${caseName}`,
        backend: "manual"
      });
      const start = migratedController.startFlow({
        config: {
          ...nativeConfig(),
          id: `future-insert-${caseName.replaceAll(" ", "-").toLowerCase()}`
        },
        runId: login.run.run_id,
        agentToken: login.agent_token,
        ownerTaskPath: "/root"
      });
      const continuation = await migratedController.continueFlow({
        flowInstanceId: start.instance.flow_instance_id,
        bridgeToken: start.bridge_credential!.bridge_token
      });
      expect(start.instance.originating_bridge_grant_id).toBe(
        start.bridge_credential!.bridge_grant_id
      );
      expect(
        migrated.getOrchestratorAction(
          continuation.orchestrator_action!.action_id
        )
      ).toMatchObject({
        originating_bridge_grant_id:
          start.bridge_credential!.bridge_grant_id
      });
      if (verifyFlowDeleteSetNull) {
        // The action FK intentionally uses NO ACTION. Clear that independent
        // reference, then exercise the repaired flow FK and verify run_id did
        // not participate in its SET NULL action.
        migrated.db
          .prepare(
            "update orchestrator_actions set originating_bridge_grant_id = null where action_id = ?"
          )
          .run(continuation.orchestrator_action!.action_id);
        expect(() =>
          migrated.db
            .prepare("delete from bridge_grants where bridge_grant_id = ?")
            .run(start.bridge_credential!.bridge_grant_id)
        ).not.toThrow();
        expect(migrated.getFlowInstance(start.instance.flow_instance_id)).toMatchObject({
          run_id: login.run.run_id,
          originating_bridge_grant_id: null
        });
      }
      expect(migrated.db.prepare("pragma foreign_key_check").all()).toEqual([]);
      migrated.close();
    }
  );

  it("keeps bridge and action tokens out of the one-shot CLI workflow", () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const cli = spawnSync(
      tsx,
      [
        "src/cli.ts",
        "flow",
        "launch",
        "--config-file",
        join(process.cwd(), "tests", "fixtures", "codex-subagent-flow.yaml"),
        "--title",
        "Native CLI launch",
        "--orchestrator-backend",
        "manual",
        "--owner-task-identity",
        "thread-cli-root",
        "--owner-task-path",
        "/root"
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_CONTROL_HOME: join(tmp, "cli-home"),
          AGENT_CONTROL_ADMIN_KEY: "ack_native_cli_test"
        }
      }
    );
    expect(cli.status, cli.stderr).toBe(0);
    const result = JSON.parse(cli.stdout) as Record<string, unknown>;
    expect(result).toMatchObject({
      next: "native_subagent_action_required",
      bridge_grant: {
        bridge_grant_id: expect.stringMatching(/^bridge_/),
        owner_task_identity: "thread-cli-root",
        owner_task_path: "/root"
      },
      orchestrator_action: {
        operation: "spawn_agent",
        status: "pending"
      }
    });
    expect(JSON.stringify(result)).not.toContain("agent_token");
    expect(JSON.stringify(result)).not.toContain("bridge_token");
    expect(JSON.stringify(result)).not.toContain("Perform the assigned native CLI contract check");

    const bridgeGrant = result.bridge_grant as { bridge_grant_id: string };
    const actionRef = result.orchestrator_action as { action_id: string };
    const credentialDirectory = join(tmp, "cli-home", "credentials", "bridges");
    const credentialFiles = readdirSync(credentialDirectory);
    expect(credentialFiles).toEqual([`${bridgeGrant.bridge_grant_id}.json`]);
    expect(statSync(credentialDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(credentialDirectory, credentialFiles[0]!)).mode & 0o777).toBe(0o600);
    const cliEnv = {
      ...process.env,
      AGENT_CONTROL_HOME: join(tmp, "cli-home"),
      AGENT_CONTROL_ADMIN_KEY: "ack_native_cli_test",
      CODEX_THREAD_ID: "thread-cli-root"
    };
    const cliStatePath = join(tmp, "cli-home", "state.sqlite");
    const stateBeforeResume = new Database(cliStatePath);
    stateBeforeResume
      .prepare("update bridge_grants set last_used_at = null where bridge_grant_id = ?")
      .run(bridgeGrant.bridge_grant_id);
    stateBeforeResume.close();
    const resumedProcess = spawnSync(
      tsx,
      [
        "src/cli.ts",
        "flow",
        "launch",
        "--config-file",
        join(process.cwd(), "tests", "fixtures", "codex-subagent-flow.yaml"),
        "--title",
        "Native CLI launch",
        "--run",
        String(result.run_id),
        "--orchestrator-backend",
        "manual",
        "--owner-task-identity",
        "thread-cli-root",
        "--owner-task-path",
        "/root"
      ],
      { encoding: "utf8", env: cliEnv }
    );
    expect(resumedProcess.status, resumedProcess.stderr).toBe(0);
    const resumedResult = JSON.parse(resumedProcess.stdout) as Record<string, unknown>;
    expect(resumedResult).toMatchObject({
      flow_reused: true,
      flow_instance_id: result.flow_instance_id,
      bridge_grant: { bridge_grant_id: bridgeGrant.bridge_grant_id },
      next: "native_subagent_action_required"
    });
    expect(resumedProcess.stdout).not.toContain("agent_token");
    expect(resumedProcess.stdout).not.toContain("bridge_token");
    expect(resumedProcess.stdout).not.toContain("acb_");
    const stateAfterResume = new Database(cliStatePath, { readonly: true });
    expect(
      stateAfterResume
        .prepare("select last_used_at from bridge_grants where bridge_grant_id = ?")
        .get(bridgeGrant.bridge_grant_id)
    ).toMatchObject({ last_used_at: expect.any(String) });
    stateAfterResume.close();

    const claimProcess = spawnSync(
      tsx,
      [
        "src/cli.ts",
        "action",
        "claim",
        "--action",
        actionRef.action_id
      ],
      { encoding: "utf8", env: cliEnv }
    );
    expect(claimProcess.status, claimProcess.stderr).toBe(0);
    const claim = JSON.parse(claimProcess.stdout) as {
      action_claim: { action_id: string; claim_attempt: number; lease_expires_at: string };
      request: { task_name: string; expected_task_path: string };
    };
    expect(claim.action_claim).toMatchObject({
      action_id: actionRef.action_id,
      claim_attempt: 1,
      lease_expires_at: expect.any(String)
    });
    expect(claimProcess.stdout).not.toContain("aca_");
    const actionClaimDirectory = join(tmp, "cli-home", "credentials", "action-claims");
    expect(readdirSync(actionClaimDirectory)).toEqual([`${actionRef.action_id}.json`]);
    expect(statSync(actionClaimDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(actionClaimDirectory, `${actionRef.action_id}.json`)).mode & 0o777).toBe(0o600);

    const ackProcess = spawnSync(
      tsx,
      [
        "src/cli.ts",
        "action",
        "ack",
        "--action",
        actionRef.action_id,
        "--status",
        "succeeded",
        "--result-json",
        JSON.stringify({
          native_agent_id: "native-cli-agent",
          native_task_name: claim.request.task_name,
          native_task_path: claim.request.expected_task_path
        })
      ],
      { encoding: "utf8", env: cliEnv }
    );
    expect(ackProcess.status, ackProcess.stderr).toBe(0);
    expect(JSON.parse(ackProcess.stdout)).toMatchObject({
      action: { status: "succeeded" },
      agent: { status: "running" }
    });

    const syncProcess = spawnSync(
      tsx,
      [
        "src/cli.ts",
        "agent",
        "external-sync",
        "--agent",
        String(result.worker_agent_id),
        "--native-agent-id",
        "native-cli-agent",
        "--native-status",
        "running"
      ],
      { encoding: "utf8", env: cliEnv }
    );
    expect(syncProcess.status, syncProcess.stderr).toBe(0);
    expect(JSON.parse(syncProcess.stdout)).toMatchObject({
      agent: { status: "running" },
      native_status: "running"
    });

    const continueProcess = spawnSync(
      tsx,
      [
        "src/cli.ts",
        "flow",
        "continue",
        "--flow",
        String(result.flow_instance_id),
        "--bridge-grant",
        bridgeGrant.bridge_grant_id
      ],
      { encoding: "utf8", env: cliEnv }
    );
    expect(continueProcess.status, continueProcess.stderr).toBe(0);
    expect(JSON.parse(continueProcess.stdout)).toMatchObject({ action: "waiting_for_report" });

    const bulkStopProcess = spawnSync(
      tsx,
      [
        "src/cli.ts",
        "agent",
        "stop",
        "--run",
        String(result.run_id),
        "--mode",
        "graceful"
      ],
      { encoding: "utf8", env: cliEnv }
    );
    expect(bulkStopProcess.status, bulkStopProcess.stderr).toBe(0);
    const bulkStops = JSON.parse(bulkStopProcess.stdout) as Array<Record<string, unknown>>;
    expect(
      bulkStops.find((agent) => agent.agent_id === result.worker_agent_id)
    ).toMatchObject({
      status: "stopping",
      orchestrator_action: { operation: "interrupt_agent", status: "pending" }
    });
    expect(bulkStopProcess.stdout).not.toContain("bridge_token");
    expect(bulkStopProcess.stdout).not.toContain("action_token");
  });

  it("persists flow-start bridge credentials without printing the raw token", () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const cliHome = join(tmp, "cli-flow-start-home");
    const cliEnv = {
      ...process.env,
      AGENT_CONTROL_HOME: cliHome,
      AGENT_CONTROL_ADMIN_KEY: "ack_native_cli_flow_start_test"
    };
    const loginProcess = spawnSync(
      tsx,
      ["src/cli.ts", "auth", "login", "--title", "Flow start orchestrator", "--backend", "manual"],
      { encoding: "utf8", env: cliEnv }
    );
    expect(loginProcess.status, loginProcess.stderr).toBe(0);
    const login = JSON.parse(loginProcess.stdout) as {
      run: { run_id: string };
      agent_token: string;
    };

    const startProcess = spawnSync(
      tsx,
      [
        "src/cli.ts",
        "--token",
        login.agent_token,
        "flow",
        "start",
        "--config-file",
        join(process.cwd(), "tests", "fixtures", "codex-subagent-flow.yaml"),
        "--run",
        login.run.run_id,
        "--owner-task-identity",
        "thread-cli-flow-start",
        "--owner-task-path",
        "/root"
      ],
      { encoding: "utf8", env: cliEnv }
    );
    expect(startProcess.status, startProcess.stderr).toBe(0);
    const result = JSON.parse(startProcess.stdout) as {
      bridge_grant: { bridge_grant_id: string };
    };

    expect(result.bridge_grant.bridge_grant_id).toMatch(/^bridge_/);
    expect(startProcess.stdout).not.toContain("bridge_token");
    expect(startProcess.stdout).not.toContain("acb_");
    expect(
      readdirSync(join(cliHome, "credentials", "bridges"))
    ).toEqual([`${result.bridge_grant.bridge_grant_id}.json`]);
  });

  async function createPendingNativeHandoff(
    ownerAdapter: CapturingOwnerAdapter,
    suffix: string
  ) {
    registry.register(ownerAdapter);
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: `Native handoff owner ${suffix}`,
      repoDir: "/repo",
      backend: ownerAdapter.kind,
      backendHandle: { id: `native-handoff-owner-${suffix}` }
    });
    const start = controller.startFlow({
      config: twoRoleNativeHandoffFlowConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: `thread-native-handoff-owner-${suffix}`,
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const firstContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const firstSpawnClaim = controller.claimOrchestratorAction({
      actionId: firstContinuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in firstSpawnClaim)) {
      throw new Error("Expected claimed first-role spawn action.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: firstSpawnClaim.action_id,
      actionToken: firstSpawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: `native-handoff-analysis-${suffix}`,
        native_task_name: firstSpawnClaim.request.task_name,
        native_task_path: firstSpawnClaim.request.expected_task_path
      }
    });
    const handoff = await controller.reportFlowStepAndContinue({
      stepInstanceId: start.active_step!.step_instance_id,
      status: "completed",
      result: { analysis_ready: true },
      summary: "Analysis is ready for the native owner wake test."
    });
    expect(handoff.continuation).toMatchObject({
      action: "orchestrator_action_required",
      active_step: { step_id: "review" },
      orchestrator_action: { operation: "spawn_agent", status: "pending" }
    });
    return { login, start, bridgeToken, firstContinuation, handoff };
  }

  async function createPendingSameRoleFollowup(
    ownerAdapter: CapturingOwnerAdapter,
    suffix: string
  ) {
    registry.register(ownerAdapter);
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: `Same-role owner ${suffix}`,
      repoDir: "/repo",
      backend: ownerAdapter.kind,
      backendHandle: { id: `same-role-owner-${suffix}` }
    });
    const start = controller.startFlow({
      config: sameRoleNativeFlowConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: `thread-same-role-owner-${suffix}`,
      ownerTaskPath: "/root"
    });
    const bridgeToken = start.bridge_credential!.bridge_token;
    const firstContinuation = await controller.continueFlow({
      flowInstanceId: start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: firstContinuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed same-role spawn action.");
    }
    const nativeAgentId = `native-agent-same-role-${suffix}`;
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: nativeAgentId,
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });
    const handoff = await controller.reportFlowStepAndContinue({
      stepInstanceId: start.active_step!.step_instance_id,
      status: "completed",
      result: { phase: "first" },
      summary: "The first same-role phase is ready for its follow-up."
    });
    expect(handoff.continuation).toMatchObject({
      action: "orchestrator_action_required",
      active_step: { step_id: "second" },
      orchestrator_action: { operation: "followup_task", status: "pending" }
    });
    return {
      login,
      start,
      bridgeToken,
      firstContinuation,
      spawnClaim,
      nativeAgentId,
      handoff
    };
  }

  async function launchRunningNativeWorker(nativeAgentId: string) {
    const launched = launchNativeFlow();
    const bridgeToken = launched.start.bridge_credential!.bridge_token;
    const continuation = await controller.continueFlow({
      flowInstanceId: launched.start.instance.flow_instance_id,
      bridgeToken
    });
    const spawnClaim = controller.claimOrchestratorAction({
      actionId: continuation.orchestrator_action!.action_id,
      bridgeToken
    });
    if (!("action_token" in spawnClaim)) {
      throw new Error("Expected claimed spawn action for running native worker.");
    }
    controller.acknowledgeOrchestratorAction({
      actionId: spawnClaim.action_id,
      actionToken: spawnClaim.action_token,
      status: "succeeded",
      result: {
        native_agent_id: nativeAgentId,
        native_task_name: spawnClaim.request.task_name,
        native_task_path: spawnClaim.request.expected_task_path
      }
    });
    return {
      launched,
      bridgeToken,
      continuation,
      spawnClaim,
      nativeAgentId
    };
  }

  function cancelNextNewWorkProjection(
    operation: "spawn_agent" | "send_message" | "followup_task"
  ): void {
    const original = store.updateAgentForOpenOrchestratorAction.bind(store);
    let intercepted = false;
    vi.spyOn(store, "updateAgentForOpenOrchestratorAction").mockImplementation(
      (actionId, agentId, patch) => {
        if (!intercepted) {
          const action = store.getOrchestratorAction(actionId);
          if (action) {
            expect(action.operation).toBe(operation);
            intercepted = true;
            store.immediateTransaction(() => {
              store.updateAgent(agentId, { status: "stopping" });
              store.cancelUnclaimedOrchestratorAction({
                actionId: action.action_id,
                errorJson: {
                  reason: "test_stop_won_after_action_read",
                  message:
                    "The deterministic test stop cancelled work between the controller read and projection."
                }
              });
            });
          }
        }
        return original(actionId, agentId, patch);
      }
    );
  }

  function failNextNativeActionBeforeProjection(
    operation: "spawn_agent" | "send_message" | "followup_task",
    bridgeToken: string
  ): void {
    const original = store.updateAgentForOpenOrchestratorAction.bind(store);
    let intercepted = false;
    vi.spyOn(store, "updateAgentForOpenOrchestratorAction").mockImplementation(
      (actionId, agentId, patch) => {
        const action = store.getOrchestratorAction(actionId);
        if (!intercepted && action?.operation === operation) {
          intercepted = true;
          const claim = controller.claimOrchestratorAction({ actionId, bridgeToken });
          if (!("action_token" in claim)) {
            throw new Error(`Expected ${operation} action to be claimable before projection.`);
          }
          controller.acknowledgeOrchestratorAction({
            actionId,
            actionToken: claim.action_token,
            status: "failed",
            error: {
              message: "Native action failed before its initial status projection."
            }
          });
        }
        return original(actionId, agentId, patch);
      }
    );
  }

  function succeedNextSpawnBeforeProjection(bridgeToken: string): void {
    const original = store.updateAgentForOpenOrchestratorAction.bind(store);
    let intercepted = false;
    vi.spyOn(store, "updateAgentForOpenOrchestratorAction").mockImplementation(
      (actionId, agentId, patch) => {
        const action = store.getOrchestratorAction(actionId);
        if (!intercepted && action?.operation === "spawn_agent") {
          intercepted = true;
          const claim = controller.claimOrchestratorAction({ actionId, bridgeToken });
          if (!("action_token" in claim)) {
            throw new Error("Expected spawn action to be claimable before projection.");
          }
          controller.acknowledgeOrchestratorAction({
            actionId,
            actionToken: claim.action_token,
            status: "succeeded",
            result: {
              native_agent_id: "native-agent-succeeded-before-projection",
              native_task_name: claim.request.task_name,
              native_task_path: claim.request.expected_task_path
            }
          });
        }
        return original(actionId, agentId, patch);
      }
    );
  }

  function launchNativeFlow() {
    const login = controller.orchestratorLogin({
      adminKey: "ack_native_bridge_test",
      title: "Root native orchestrator",
      repoDir: "/repo",
      backend: "manual"
    });
    const start = controller.startFlow({
      config: nativeConfig(),
      runId: login.run.run_id,
      agentToken: login.agent_token,
      ownerTaskIdentity: "thread-native-root",
      ownerTaskPath: "/root"
    });
    return { login, start };
  }
});

class CapturingOwnerAdapter implements AgentAdapter {
  readonly kind: string;
  readonly sent: Array<{ handle: AgentHandle; message: string }> = [];

  constructor(kind = "capturing-owner") {
    this.kind = kind;
  }

  capabilities(): AgentCapabilities {
    return {
      canStart: true,
      canSendMessage: true,
      canReadLatest: true,
      canStopGracefully: true,
      canForceStop: false,
      canStreamMessages: false,
      canInspectStatusCheaply: false,
      canAttachExisting: true
    };
  }

  async start(input: StartAgentInput): Promise<AgentHandle> {
    return {
      backend: this.kind,
      id: input.agent.agent_id,
      data: input.agent.backend_handle ?? { id: input.agent.agent_id }
    };
  }

  async sendMessage(handle: AgentHandle, input: AgentMessageInput): Promise<void> {
    this.sent.push({ handle, message: input.message });
  }

  async getStatus(_handle: AgentHandle): Promise<AgentStatusSnapshot> {
    return { status: "running" };
  }

  async readLatest(_handle: AgentHandle, _options: ReadLatestOptions): Promise<AgentMessage[]> {
    return [];
  }

  async stop(_handle: AgentHandle, _options: StopOptions): Promise<StopResult> {
    return { status: "stopped" };
  }
}

class FlakyCodexThreadOwnerAdapter extends CapturingOwnerAdapter {
  attempts = 0;

  constructor(private failuresRemaining = 1) {
    super("codex-thread");
  }

  override async sendMessage(handle: AgentHandle, input: AgentMessageInput): Promise<void> {
    this.attempts += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("The active root task temporarily rejected native delivery.");
    }
    await super.sendMessage(handle, input);
  }
}

function sameRoleNativeFlowConfig() {
  return {
    id: "same-role-native-flow",
    initial_step: "first",
    roles: {
      worker: { backend: "codex-subagent" }
    },
    steps: {
      first: {
        role: "worker",
        prompt: "Complete the first phase in the native task.",
        on: { reported: { to: "second" } }
      },
      second: {
        role: "worker",
        prompt: "Complete the second phase using the existing native task.",
        on: { reported: { finish: true } }
      }
    }
  };
}

function retryableNativeFlowConfig() {
  return {
    id: "retryable-native-flow",
    initial_step: "work",
    roles: {
      worker: { backend: "codex-subagent" }
    },
    steps: {
      work: {
        role: "worker",
        prompt: "Attempt the native work.",
        on: { reported: { finish: true } }
      },
      retry: {
        role: "worker",
        prompt: "Retry the native work after a definitive spawn failure.",
        on: { reported: { finish: true } }
      }
    }
  };
}

function twoRoleNativeHandoffFlowConfig() {
  return {
    id: "two-role-native-handoff-flow",
    initial_step: "analysis",
    roles: {
      analyst: { backend: "codex-subagent" },
      reviewer: { backend: "codex-subagent" }
    },
    steps: {
      analysis: {
        role: "analyst",
        prompt: "Produce the analysis for the native handoff.",
        on: { reported: { to: "review" } }
      },
      review: {
        role: "reviewer",
        prompt: "Review the native handoff analysis.",
        on: { reported: { finish: true } }
      }
    }
  };
}

function nativeConfig(roleOverrides: Record<string, unknown> = {}) {
  return {
    id: "native-bridge-flow",
    initial_step: "work",
    roles: {
      worker: {
        backend: "codex-subagent",
        ...roleOverrides
      }
    },
    steps: {
      work: {
        role: "worker",
        prompt: "Perform native work and produce the assigned result.",
        on: { reported: { finish: true } }
      }
    }
  };
}

function manualRerouteNativeConfig() {
  return {
    id: "manual-reroute-native-flow",
    initial_step: "work",
    roles: {
      worker: {
        backend: "codex-subagent",
        agent_lifecycle: "fresh_per_step"
      },
      planner: { backend: "manual" }
    },
    steps: {
      work: {
        role: "worker",
        prompt: "Perform native work until the coordinator selects another route.",
        on: { reported: { to: "planning" } }
      },
      planning: {
        role: "planner",
        prompt: "Continue from the coordinator's manual route.",
        on: { reported: { finish: true } }
      }
    }
  };
}
