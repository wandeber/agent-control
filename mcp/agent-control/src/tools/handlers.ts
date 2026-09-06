import { launchFlowTool, launchWorkerTool, requesterOptions } from "./launch.js";
import type { AgentController } from "../core/controller.js";
import { parseDurationMs } from "../core/duration.js";
import { ControllerError } from "../core/errors.js";
import type { AgentLinkType, AgentStatus, EventType, FlowStepInstanceStatus } from "../core/types.js";

export async function handleTool(
  controller: AgentController,
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  switch (name) {
    case "flow_packages": return controller.executeFlowPackages({ flowInstanceId: String(input.flow_instance_id), request: input.request as import("../core/flow-packages.js").FlowPackagesRequest, agentToken: maybeString(input.agent_token), adminKey: maybeString(input.admin_key) });
    case "flow_owner_recover": return controller.recoverFlowOwner({ flowInstanceId: String(input.flow_instance_id), role: String(input.role), restartStepId: String(input.restart_step_id), reason: String(input.reason), expectedRevision: Number(input.expected_revision), agentToken: maybeString(input.agent_token), adminKey: maybeString(input.admin_key) });
    case "flow_context_update": return controller.updateFlowContext({ flowInstanceId: String(input.flow_instance_id), context: String(input.context), expectedRevision: Number(input.expected_revision), agentToken: maybeString(input.agent_token), adminKey: maybeString(input.admin_key) });
    case "flow_decision": return controller.recordFlowDecision({ flowInstanceId: String(input.flow_instance_id), key: String(input.key), value: input.value, reason: String(input.reason), expectedRevision: Number(input.expected_revision), artifactKey: maybeString(input.artifact_key), artifactDigest: maybeString(input.artifact_digest), packageManifestDigest: maybeString(input.package_manifest_digest), agentToken: maybeString(input.agent_token), adminKey: maybeString(input.admin_key) });
    case "flow_evidence": return controller.executeFlowEvidence({ flowInstanceId: String(input.flow_instance_id), key: String(input.key), request: input.request as import("../core/evidence/service.js").EvidenceRequest, stepInstanceId: maybeString(input.step_instance_id), agentToken: maybeString(input.agent_token), adminKey: maybeString(input.admin_key) });
    case "run_ack": return controller.acknowledgeRunEvents({ runId: String(input.run_id), observerAgentId: String(input.observer_agent_id), cursor: String(input.cursor), agentToken: maybeString(input.agent_token), adminKey: maybeString(input.admin_key) });
    case "worker_launch": return launchWorkerTool(controller, input);
    case "flow_launch": return launchFlowTool(controller, input);
    case "run_observe":
      return controller.observeRun({ runId: String(input.run_id), threadId: maybeString(input.thread_id),
        title: maybeString(input.title), eventTypes: maybeStringArray(input.event_types) as EventType[] | undefined,
        delivery: input.delivery as "wait" | "notify" | undefined, adminKey: maybeString(input.admin_key), agentToken: maybeString(input.agent_token) });
    case "run_wait":
      return controller.waitForRun({ runId: String(input.run_id), observerAgentId: String(input.observer_agent_id),
        cursor: maybeString(input.cursor), timeoutMs: maybeNumber(input.timeout_ms), limit: maybeNumber(input.limit), signal });
    case "backend_list":
      return controller.listBackends();
    case "flow_validate_config":
      return controller.validateFlowConfig(maybeObject(input.config) ?? {});
    case "flow_catalog_list":
      return controller.listFlowCatalog({ query: maybeString(input.query) });
    case "flow_catalog_get":
      return controller.getFlowFromCatalog({ flowId: String(input.flow_id) });
    case "flow_start":
      if (!maybeString(input.admin_key) && !maybeString(input.agent_token)) {
        throw new ControllerError("flow_start requires admin_key or agent_token.", "auth_required");
      }
      return controller.startFlow({
        ...requesterOptions(input),
        config: maybeObject(input.config) ?? {},
        runId: maybeString(input.run_id),
        runTitle: maybeString(input.run_title),
        acceptanceContext: maybeString(input.acceptance_context),
        repoDir: maybeString(input.repo_dir),
        adminKey: maybeString(input.admin_key),
        agentToken: maybeString(input.agent_token),
        ownerTaskIdentity: maybeString(input.owner_task_identity),
        ownerTaskPath: maybeString(input.owner_task_path)
      });
    case "flow_get":
      return controller.getFlowSnapshot(String(input.flow_instance_id));
    case "flow_dispatch_active":
      return controller.dispatchActiveFlowStep({
        flowInstanceId: String(input.flow_instance_id),
        subscriberAgentId: maybeString(input.subscriber_agent_id),
        server: maybeString(input.server),
        agentToken: maybeString(input.agent_token),
        bridgeToken: maybeString(input.bridge_token)
      });
    case "flow_continue":
      return controller.continueFlow({
        flowInstanceId: String(input.flow_instance_id),
        subscriberAgentId: maybeString(input.subscriber_agent_id),
        server: maybeString(input.server),
        agentToken: maybeString(input.agent_token),
        bridgeToken: maybeString(input.bridge_token)
      });
    case "orchestrator_action_claim":
      return controller.claimOrchestratorAction({
        actionId: String(input.action_id),
        bridgeToken: String(input.bridge_token)
      });
    case "orchestrator_action_ack":
      return controller.acknowledgeOrchestratorAction({
        actionId: String(input.action_id),
        actionToken: String(input.action_token),
        status: String(input.status) as "succeeded" | "failed",
        result: maybeObject(input.result),
        error: maybeObject(input.error)
      });
    case "agent_external_sync":
      return controller.syncCodexSubagent({
        agentId: String(input.agent_id),
        bridgeToken: String(input.bridge_token),
        nativeAgentId: maybeString(input.native_agent_id),
        nativeTaskName: maybeString(input.native_task_name),
        nativeTaskPath: maybeString(input.native_task_path),
        nativeStatus: String(input.native_status) as
          | "pending_init"
          | "running"
          | "completed"
          | "interrupted"
          | "shutdown"
          | "errored"
          | "missing",
        latestMessage: maybeString(input.latest_message),
        publicActivity: input.public_activity,
        observedAt: maybeString(input.observed_at),
        confirmedAbsent: maybeBoolean(input.confirmed_absent)
      });
    case "flow_step_start":
      return await controller.startFlowStep({
        flowInstanceId: String(input.flow_instance_id),
        stepId: String(input.step_id),
        fromStepInstanceId: maybeString(input.from_step_instance_id),
        transitionId: maybeString(input.transition_id),
        reason: maybeString(input.reason), agentToken: maybeString(input.agent_token), adminKey: maybeString(input.admin_key)
      });
    case "flow_step_report":
      return compactReportAndContinueResult(
        await controller.reportFlowStepAndContinue({
          stepInstanceId: String(input.step_instance_id),
          status: String(input.status) as FlowStepInstanceStatus,
          result: maybeObject(input.result),
          artifacts: maybeStringRecord(input.artifacts),
          summary: maybeString(input.summary),
          server: maybeString(input.server),
          agentToken: maybeString(input.agent_token),
          autoContinue: input.auto_continue === false ? false : true
        })
      );
    case "orchestrator_login":
      return controller.orchestratorLogin({
        adminKey: String(input.admin_key),
        title: String(input.title),
        runTitle: maybeString(input.run_title),
        repoDir: maybeString(input.repo_dir),
        runId: maybeString(input.run_id),
        backend: maybeString(input.backend),
        objective: maybeString(input.objective),
        model: maybeString(input.model),
        backendHandle: maybeObject(input.backend_handle)
      });
    case "run_create":
      if (!maybeString(input.admin_key) && !maybeString(input.agent_token)) {
        throw new ControllerError("run_create requires admin_key or agent_token.", "auth_required");
      }
      return controller.createRun({
        title: String(input.title),
        repoDir: maybeString(input.repo_dir),
        adminKey: maybeString(input.admin_key),
        agentToken: maybeString(input.agent_token)
      });
    case "run_list":
      return controller.listRuns(maybeNumber(input.limit), { agentToken: maybeString(input.agent_token) });
    case "run_get":
      return controller.getRun(String(input.run_id), { agentToken: maybeString(input.agent_token) });
    case "run_shutdown":
      return await controller.shutdownRun(String(input.run_id));
    case "agent_register":
      if (!maybeString(input.admin_key) && !maybeString(input.agent_token)) {
        throw new ControllerError("agent_register requires admin_key or agent_token.", "auth_required");
      }
      return controller.registerAgent({
        runId: maybeString(input.run_id),
        backend: String(input.backend),
        title: String(input.title),
        role: maybeString(input.role),
        objective: maybeString(input.objective),
        repoDir: maybeString(input.repo_dir),
        model: maybeString(input.model),
        status: maybeString(input.status) as AgentStatus | undefined,
        backendHandle: maybeObject(input.backend_handle),
        adminKey: maybeString(input.admin_key),
        agentToken: maybeString(input.agent_token)
      });
    case "agent_start":
      return controller.startAgent({
        ...requesterOptions(input),
        agentId: String(input.agent_id),
        prompt: maybeString(input.prompt),
        server: maybeString(input.server),
        model: maybeString(input.model),
        expectedArtifacts: maybeStringArray(input.expected_artifacts),
        attachments: maybeStringArray(input.attachments),
        metadata: maybeObject(input.metadata),
        agentToken: maybeString(input.agent_token)
      });
    case "agent_list":
      return controller.listAgents({
        runId: maybeString(input.run_id),
        includeUnregistered: Boolean(input.include_unregistered)
      });
    case "agent_get":
      return controller.getAgent(String(input.agent_id));
    case "agent_status":
      return controller.refreshAgentStatus(String(input.agent_id));
    case "agent_send_message":
      return controller.sendMessage(String(input.agent_id), String(input.message));
    case "agent_read_latest":
      return controller.readLatest(String(input.agent_id), maybeNumber(input.limit) ?? 1);
    case "agent_wait":
      assertBlockingWaitAllowed(input.allow_blocking_wait);
      return controller.waitForAgentTerminal(String(input.agent_id), {
        intervalMs: maybeNumber(input.interval_ms),
        timeoutMs: maybeNumber(input.timeout_ms)
      });
    case "agent_stop":
      if (input.agent_id) {
        return controller.stopAgent(String(input.agent_id), stopMode(input.mode));
      }
      return await controller.stopAgents({
        runId: maybeString(input.run_id),
        mode: stopMode(input.mode)
      });
    case "agent_unregister":
      if (input.agent_id) {
        return controller.unregisterAgent(String(input.agent_id));
      }
      return controller.unregisterAgents({ runId: maybeString(input.run_id) });
    case "agent_purge":
      return controller.agentPurge(String(input.agent_id), purgeOptions(input));
    case "subscription_create":
      const subscriptionCaller = maybeString(input.agent_token)
        ? controller.requireAgentToken(maybeString(input.agent_token))
        : null;
      if (!maybeString(input.subscriber_agent_id) && !subscriptionCaller) {
        throw new ControllerError("subscription_create requires subscriber_agent_id or agent_token.", "auth_required");
      }
      return controller.createSubscription({
        runId: maybeString(input.run_id) ?? subscriptionCaller?.run_id,
        sourceAgentId: maybeString(input.source_agent_id),
        subscriberAgentId: maybeString(input.subscriber_agent_id) ?? subscriptionCaller!.agent_id,
        eventType: String(input.event_type) as EventType
      });
    case "subscription_list":
      const subscriptionListCaller = maybeString(input.agent_token)
        ? controller.requireAgentToken(maybeString(input.agent_token))
        : null;
      return controller.listSubscriptions({
        runId: maybeString(input.run_id) ?? subscriptionListCaller?.run_id,
        enabledOnly: Boolean(input.enabled_only)
      });
    case "subscription_delete":
      return controller.deleteSubscription(String(input.subscription_id));
    case "subscription_wait":
      assertBlockingWaitAllowed(input.allow_blocking_wait);
      return controller.waitForSubscriptionEvent(String(input.subscription_id), {
        intervalMs: maybeNumber(input.interval_ms),
        timeoutMs: maybeNumber(input.timeout_ms)
      });
    case "link_create":
      const linkCaller = maybeString(input.agent_token) ? controller.requireAgentToken(maybeString(input.agent_token)) : null;
      if (!maybeString(input.run_id) && !linkCaller) {
        throw new ControllerError("link_create requires run_id or agent_token.", "auth_required");
      }
      return controller.createAgentLink({
        runId: maybeString(input.run_id) ?? linkCaller!.run_id,
        sourceAgentId: String(input.source_agent_id),
        targetAgentId: String(input.target_agent_id),
        type: String(input.type) as AgentLinkType,
        label: maybeString(input.label)
      });
    case "link_list":
      const linkListCaller = maybeString(input.agent_token)
        ? controller.requireAgentToken(maybeString(input.agent_token))
        : null;
      return controller.listAgentLinks({
        runId: maybeString(input.run_id) ?? linkListCaller?.run_id,
        agentId: maybeString(input.agent_id)
      });
    case "link_delete":
      return controller.deleteAgentLink(String(input.link_id));
    case "heartbeat_create":
      return controller.createHeartbeat({
        agentId: String(input.agent_id),
        idleTimeoutMs: Number(input.idle_timeout_ms),
        reminderIntervalMs: maybeNumber(input.reminder_interval_ms)
      });
    case "heartbeat_list":
      return controller.listHeartbeats(maybeString(input.agent_id));
    case "heartbeat_delete":
      return controller.deleteHeartbeat(String(input.heartbeat_id));
    case "goal_register":
      const goalCaller = maybeString(input.agent_token) ? controller.requireAgentToken(maybeString(input.agent_token)) : null;
      if (!maybeString(input.agent_id) && !goalCaller) {
        throw new ControllerError("goal_register requires agent_id or agent_token.", "auth_required");
      }
      return controller.createGoal({
        agentId: maybeString(input.agent_id) ?? goalCaller!.agent_id,
        objective: String(input.objective)
      });
    case "goal_get":
      return controller.getGoal(String(input.goal_id));
    case "goal_confirm":
      return controller.confirmGoal(String(input.goal_id), {
        deferWhileDescendantsRunning: maybeBoolean(input.defer_while_descendants_running)
      });
    case "goal_wait_confirm":
      assertBlockingWaitAllowed(input.allow_blocking_wait);
      return controller.waitForGoalConfirmation(String(input.goal_id), {
        intervalMs: maybeNumber(input.interval_ms),
        timeoutMs: maybeNumber(input.timeout_ms) ?? (input.timeout ? parseDurationMs(String(input.timeout)) : undefined)
      });
    case "goal_update":
      return controller.updateGoal(String(input.goal_id), input.status as never);
    case "goal_unregister":
      return controller.deleteGoal(String(input.goal_id));
    case "event_list":
      return controller.listEvents({
        runId: maybeString(input.run_id),
        agentId: maybeString(input.agent_id),
        type: input.type ? (String(input.type) as EventType) : undefined,
        limit: maybeNumber(input.limit)
      });
    case "run_purge":
      return controller.runPurge(String(input.run_id), purgeOptions(input));
    case "maintenance_purge_old":
      return controller.maintenancePurgeOld({
        ...purgeOptions(input),
        olderThanMs: parseDurationMs(String(input.older_than))
      });
    case "artifact_register":
      return controller.createArtifact({
        runId: maybeString(input.run_id),
        agentId: maybeString(input.agent_id),
        label: String(input.label),
        path: String(input.path),
        expected: Boolean(input.expected)
      });
    case "artifact_read_header":
      return controller.readArtifactHeader(String(input.path), maybeNumber(input.lines) ?? 10);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function maybeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function maybeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function maybeObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function maybeStringRecord(value: unknown): Record<string, string> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      )
    : undefined;
}

function compactReportAndContinueResult(result: {
  report: {
    instance: { flow_instance_id: string; status: string };
    reported_step: {
      step_instance_id: string;
      step_id: string;
      status: string;
      summary: string | null;
      transition_id: string | null;
    };
    selected_transition: { transition_id: string; target_step_id: string | null } | null;
    active_step: { step_instance_id: string; step_id: string; status: string; agent_id: string | null } | null;
    notification: string | null;
  };
  continuation: {
    action: string;
    active_step: { step_instance_id: string; step_id: string; status: string; agent_id: string | null } | null;
    agent: { agent_id: string; role: string | null; status: string; failure_reason: string | null } | null;
    dispatch: { expected_artifacts: string[]; prompt_size: number } | null;
    notification: string | null;
    blocked_reason: string | null;
  } | null;
}): Record<string, unknown> {
  return {
    flow_instance_id: result.report.instance.flow_instance_id,
    flow_status: result.report.instance.status,
    reported_step: {
      step_instance_id: result.report.reported_step.step_instance_id,
      step_id: result.report.reported_step.step_id,
      status: result.report.reported_step.status,
      summary: result.report.reported_step.summary,
      transition_id: result.report.reported_step.transition_id
    },
    selected_transition: result.report.selected_transition
      ? {
          transition_id: result.report.selected_transition.transition_id,
          target_step_id: result.report.selected_transition.target_step_id
        }
      : null,
    active_step: result.report.active_step
      ? {
          step_instance_id: result.report.active_step.step_instance_id,
          step_id: result.report.active_step.step_id,
          status: result.report.active_step.status,
          agent_id: result.report.active_step.agent_id
        }
      : null,
    notification: result.report.notification,
    continuation: result.continuation
      ? {
          action: result.continuation.action,
          active_step: result.continuation.active_step
            ? {
                step_instance_id: result.continuation.active_step.step_instance_id,
                step_id: result.continuation.active_step.step_id,
                status: result.continuation.active_step.status,
                agent_id: result.continuation.active_step.agent_id
              }
            : null,
          agent: result.continuation.agent
            ? {
                agent_id: result.continuation.agent.agent_id,
                role: result.continuation.agent.role,
                status: result.continuation.agent.status,
                failure_reason: result.continuation.agent.failure_reason
              }
            : null,
          dispatch: result.continuation.dispatch
            ? {
                expected_artifacts: result.continuation.dispatch.expected_artifacts,
                prompt_size: result.continuation.dispatch.prompt_size
              }
            : null,
          notification: result.continuation.notification,
          blocked_reason: result.continuation.blocked_reason
        }
      : null
  };
}

function stopMode(value: unknown): "graceful" | "interrupt" | "kill" {
  return value === "interrupt" || value === "kill" ? value : "graceful";
}

function assertBlockingWaitAllowed(value: unknown): void {
  if (value === true || process.env.AGENT_CONTROL_ALLOW_BLOCKING_WAIT === "1") {
    return;
  }
  throw new Error(
    "Blocking waits are disabled by default. Pass allow_blocking_wait=true only for explicit manual/debug waits or short opt-in foreground waits. Normal long-running orchestrators should use detached watchers/subscriptions."
  );
}

function purgeOptions(input: Record<string, unknown>): {
  dryRun: boolean;
  stopFirst: boolean;
  force: boolean;
  deleteRuntimeFiles: boolean;
} {
  return {
    dryRun: Boolean(input.dry_run),
    stopFirst: Boolean(input.stop_first),
    force: Boolean(input.force),
    deleteRuntimeFiles: input.delete_runtime_files !== false
  };
}
