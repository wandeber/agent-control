import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControllerError, errorToPayload } from "./errors.js";
import {
  parseFlowConfig,
  resolveArtifactPath,
  resolveInputArtifacts,
  resolveStepPromptSources,
  resolveStepEventAction,
  selectTransition,
  validateStepResult
} from "./flow.js";
import { getFlowFromCatalog, listFlowCatalog, type FlowCatalogGetResult, type FlowCatalogListResult } from "./flow-catalog.js";
import { generateAgentToken, hashToken, verifyAdminKey } from "./identity.js";
import { newId, nowIso } from "./ids.js";
import { agentRuntimePath, isInsideRunsRuntimeRoot, runRuntimeDir, runRuntimePath } from "./paths.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type {
  AgentHandle,
  AgentLinkRecord,
  AgentLinkType,
  AgentMessage,
  AgentRecord,
  AgentStatus,
  AgentWithToken,
  ArtifactRecord,
  DashboardSnapshot,
  EventRecord,
  EventType,
  FailureReason,
  FlowConfig,
  FlowContinueResult,
  FlowDispatchActiveResult,
  FlowInstanceRecord,
  FlowRecord,
  FlowSnapshot,
  FlowStepActionConfig,
  FlowStartResult,
  FlowStepInstanceRecord,
  FlowStepInstanceStatus,
  FlowStepReportResult,
  FlowStepReportAndContinueResult,
  FlowStepStartResult,
  FlowTransitionRecord,
  GoalConfirmationResult,
  GoalRecord,
  GoalStatus,
  HeartbeatRecord,
  MaintenancePurgeOptions,
  OrchestratorLoginResult,
  PurgeOptions,
  PurgeResult,
  RunRecord,
  SubscriptionRecord,
  UsageSnapshotRecord
} from "./types.js";
import { AGENT_STATUSES } from "./types.js";

const TERMINAL_STATUSES = new Set<AgentStatus>(["completed", "failed", "blocked", "stopped"]);
const PURGE_SAFE_STATUSES = new Set<AgentStatus>(["planned", "completed", "failed", "blocked", "stopped"]);
const DEFAULT_OPENCODE_SERVER = "http://localhost:53910";
const DEFAULT_OPENCODE_MODEL = "opencode-go/deepseek-v4-pro";

export class AgentController {
  private readonly statusWatchers = new Map<string, () => void>();
  private readonly pendingDeliveries = new Set<Promise<void>>();
  private readonly inFlightSubscriberDeliveries = new Set<string>();
  private readonly suppressedDeliveryRunIds = new Set<string>();
  private readonly suppressedDeliveryAgentIds = new Set<string>();

  constructor(
    private readonly store: SqliteStore,
    private readonly adapters: AdapterRegistry
  ) {}

  listBackends(): ReturnType<AdapterRegistry["list"]> {
    return this.adapters.list();
  }

  validateFlowConfig(config: unknown): { valid: true; config: FlowConfig } {
    return { valid: true, config: parseFlowConfig(config) };
  }

  listFlowCatalog(input: { query?: string | null } = {}): FlowCatalogListResult {
    return listFlowCatalog({ query: input.query });
  }

  getFlowFromCatalog(input: { flowId: string }): FlowCatalogGetResult {
    return getFlowFromCatalog({ flowId: input.flowId });
  }

  async drainDeliveries(): Promise<void> {
    while (this.pendingDeliveries.size > 0) {
      await Promise.allSettled([...this.pendingDeliveries]);
    }
  }

  createRun(input: {
    title: string;
    repoDir?: string | null;
    adminKey?: string | null;
    agentToken?: string | null;
  }): RunRecord {
    const caller = input.agentToken ? this.requireAgentToken(input.agentToken) : null;
    if (!caller && input.adminKey && !verifyAdminKey(input.adminKey)) {
      throw new ControllerError("Invalid Agent Control admin key.", "auth_required");
    }
    const run = this.store.createRun({
      title: input.title,
      repoDir: input.repoDir,
      parentRunId: caller?.run_id,
      createdByAgentId: caller?.agent_id
    });
    this.emit({ runId: run.run_id, type: "timer.elapsed", payload: { action: "run_created" } });
    return run;
  }

  startFlow(input: {
    config: unknown;
    runId?: string | null;
    runTitle?: string | null;
    repoDir?: string | null;
    adminKey?: string | null;
    agentToken?: string | null;
  }): FlowStartResult {
    const config = parseFlowConfig(input.config);
    const caller = input.agentToken ? this.requireAgentToken(input.agentToken) : null;
    const run = input.runId
      ? this.getRun(input.runId, { agentToken: input.agentToken ?? undefined })
      : this.createRun({
          title: input.runTitle ?? config.description ?? config.id,
          repoDir: input.repoDir,
          adminKey: input.adminKey,
          agentToken: input.agentToken
        });
    if (input.runId) {
      const reusable = this.findReusableFlowInstance(run.run_id, config);
      if (reusable) {
        if (caller) {
          this.ensureFlowOwnerSubscriptions(run.run_id, caller.agent_id);
        }
        const activeStep = this.store
          .listFlowStepInstances(reusable.instance.flow_instance_id)
          .find((step) => step.status === "active") ?? null;
        return {
          flow: reusable.flow,
          instance: reusable.instance,
          active_step: activeStep,
          reused: true,
          blocked_reason: reusable.instance.status === "blocked" ? "blocked" : undefined
        };
      }
    }
    const flow = this.store.createFlow(config);
    const instance = this.store.createFlowInstance({
      flowRecordId: flow.flow_record_id,
      runId: run.run_id,
      currentStepId: config.initial_step
    });
    this.ensureDeclaredFlowAgents({
      config,
      flowId: flow.flow_id,
      run,
      caller,
      agentToken: input.agentToken ?? null
    });
    if (caller) {
      this.ensureFlowOwnerSubscriptions(run.run_id, caller.agent_id);
    }
    this.emit({
      runId: run.run_id,
      type: "flow.started",
      payload: {
        flow_instance_id: instance.flow_instance_id,
        flow_record_id: flow.flow_record_id,
        flow_id: flow.flow_id,
        initial_step: config.initial_step
      }
    });
    const activeStep = this.activateFlowStep(flow.config, instance, config.initial_step);
    return {
      flow,
      instance: this.getFlowInstanceOrThrow(instance.flow_instance_id),
      active_step: activeStep.status === "active" ? activeStep : null,
      reused: false,
      blocked_reason: activeStep.status === "blocked" ? String(activeStep.summary ?? "blocked") : undefined
    };
  }

  getFlowSnapshot(flowInstanceId: string): FlowSnapshot {
    const instance = this.getFlowInstanceOrThrow(flowInstanceId);
    const flow = this.getFlowOrThrow(instance.flow_record_id);
    return {
      flow,
      instance,
      steps: this.store.listFlowStepInstances(flowInstanceId),
      reports: this.store.listFlowStepReports(flowInstanceId),
      transitions: this.store.listFlowTransitions(flowInstanceId),
      artifact_bindings: this.store.listFlowArtifactBindings(flowInstanceId)
    };
  }

  startFlowStep(input: {
    flowInstanceId: string;
    stepId: string;
    fromStepInstanceId?: string | null;
    transitionId?: string | null;
    reason?: string | null;
  }): FlowStepStartResult {
    const instance = this.getFlowInstanceOrThrow(input.flowInstanceId);
    const flow = this.getFlowOrThrow(instance.flow_record_id);
    if (!flow.config.steps[input.stepId]) {
      throw new ControllerError("Cannot start undefined flow step.", "tool_error", {
        flow_instance_id: input.flowInstanceId,
        step_id: input.stepId
      });
    }

    let transitionRecord: FlowTransitionRecord | null = null;
    if (input.fromStepInstanceId) {
      const fromStep = this.getFlowStepInstanceOrThrow(input.fromStepInstanceId);
      if (fromStep.flow_instance_id !== instance.flow_instance_id) {
        throw new ControllerError("Manual flow transition source belongs to another flow instance.", "tool_error", {
          flow_instance_id: instance.flow_instance_id,
          from_step_instance_id: fromStep.step_instance_id
        });
      }
      const transitionId = input.transitionId ?? `${fromStep.step_id}-manual-to-${input.stepId}`;
      transitionRecord = this.store.createFlowTransition({
        flowInstanceId: instance.flow_instance_id,
        fromStepInstanceId: fromStep.step_instance_id,
        transitionId,
        targetStepId: input.stepId,
        actionJson: {
          manual: true,
          to: input.stepId,
          reason: input.reason ?? null
        }
      });
      this.store.updateFlowStepInstance(fromStep.step_instance_id, { transitionId });
      this.emit({
        runId: instance.run_id,
        agentId: fromStep.agent_id,
        type: "flow.transition_selected",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          from_step_instance_id: fromStep.step_instance_id,
          transition_id: transitionId,
          target_step_id: input.stepId,
          manual: true,
          reason: input.reason
        }
      });
    }

    const active = this.activateFlowStep(flow.config, instance, input.stepId);
    return {
      ...this.getFlowSnapshot(instance.flow_instance_id),
      selected_transition: transitionRecord,
      active_step: active.status === "active" ? active : null,
      notification: active.status === "blocked" ? "blocked" : null
    };
  }

  async dispatchActiveFlowStep(input: {
    flowInstanceId: string;
    subscriberAgentId?: string | null;
    server?: string | null;
    agentToken?: string | null;
  }): Promise<FlowDispatchActiveResult> {
    const snapshot = this.getFlowSnapshot(input.flowInstanceId);

    const activeStep = this.activeFlowStepOrThrow(snapshot, input.flowInstanceId);
    const stepConfig = snapshot.flow.config.steps[activeStep.step_id];
    const roleConfig = stepConfig.role ? snapshot.flow.config.roles?.[stepConfig.role] : undefined;
    const backend = roleConfig?.backend;
    if (!backend) {
      throw new ControllerError("Active flow step role does not define a backend.", "tool_error", {
        flow_instance_id: input.flowInstanceId,
        step_id: activeStep.step_id,
        role: stepConfig.role
      });
    }
    this.adapters.get(backend);

    const subscriber = input.subscriberAgentId ? this.getAgent(input.subscriberAgentId) : null;
    if (subscriber) {
      if (subscriber.unregistered_at) {
        throw new ControllerError("Flow dispatch subscriber is unregistered.", "auth_required", {
          subscriber_agent_id: subscriber.agent_id
        });
      }
      if (subscriber.run_id !== snapshot.instance.run_id) {
        throw new ControllerError("Flow dispatch subscriber belongs to a different run.", "auth_required", {
          flow_instance_id: input.flowInstanceId,
          subscriber_agent_id: subscriber.agent_id,
          subscriber_run_id: subscriber.run_id
        });
      }
    }
    const caller = input.agentToken ? this.requireAgentToken(input.agentToken) : subscriber;
    if (!caller) {
      throw new ControllerError("flow_dispatch_active requires agent_token or subscriber_agent_id.", "auth_required", {
        flow_instance_id: input.flowInstanceId
      });
    }
    if (!this.canAgentAccessRun(caller, snapshot.instance.run_id)) {
      throw new ControllerError(`Run not accessible: ${snapshot.instance.run_id}`, "auth_required", {
        run_id: snapshot.instance.run_id
      });
    }

    return this.dispatchActiveFlowStepInternal({
      snapshot,
      activeStep,
      subscriberAgentId: input.subscriberAgentId ?? null,
      server: input.server ?? null,
      agentToken: input.agentToken ?? null
    });
  }

  async continueFlow(input: {
    flowInstanceId: string;
    subscriberAgentId?: string | null;
    server?: string | null;
    agentToken?: string | null;
  }): Promise<FlowContinueResult> {
    if (input.agentToken) {
      const caller = this.requireAgentToken(input.agentToken);
      const instance = this.getFlowInstanceOrThrow(input.flowInstanceId);
      if (!this.canAgentAccessRun(caller, instance.run_id)) {
        throw new ControllerError(`Run not accessible: ${instance.run_id}`, "auth_required", {
          run_id: instance.run_id
        });
      }
    }
    if (input.subscriberAgentId) {
      const subscriber = this.getAgent(input.subscriberAgentId);
      const instance = this.getFlowInstanceOrThrow(input.flowInstanceId);
      if (subscriber.run_id !== instance.run_id) {
        throw new ControllerError("Flow continuation subscriber belongs to a different run.", "auth_required", {
          flow_instance_id: input.flowInstanceId,
          subscriber_agent_id: subscriber.agent_id
        });
      }
    }
    return this.continueFlowInternal({
      flowInstanceId: input.flowInstanceId,
      subscriberAgentId: input.subscriberAgentId ?? null,
      server: input.server ?? null,
      agentToken: input.agentToken ?? null
    });
  }

  async reportFlowStepAndContinue(input: {
    stepInstanceId: string;
    status: FlowStepInstanceStatus;
    result?: Record<string, unknown>;
    artifacts?: Record<string, string>;
    summary?: string | null;
    server?: string | null;
    autoContinue?: boolean;
  }): Promise<FlowStepReportAndContinueResult> {
    const report = this.reportFlowStep(input);
    if (input.autoContinue === false || !report.active_step) {
      return { report, continuation: null };
    }
    const continuation = await this.continueFlowInternal({
      flowInstanceId: report.instance.flow_instance_id,
      server: input.server ?? null
    });
    return { report, continuation };
  }

  private async dispatchActiveFlowStepInternal(input: {
    snapshot: FlowSnapshot;
    activeStep: FlowStepInstanceRecord;
    subscriberAgentId?: string | null;
    server?: string | null;
    agentToken?: string | null;
  }): Promise<FlowDispatchActiveResult> {
    const snapshot = input.snapshot;
    const activeStep = input.activeStep;
    const stepConfig = snapshot.flow.config.steps[activeStep.step_id];
    const roleConfig = stepConfig.role ? snapshot.flow.config.roles?.[stepConfig.role] : undefined;
    const backend = roleConfig?.backend;
    if (!backend) {
      throw new ControllerError("Active flow step role does not define a backend.", "tool_error", {
        flow_instance_id: snapshot.instance.flow_instance_id,
        step_id: activeStep.step_id,
        role: stepConfig.role
      });
    }
    this.adapters.get(backend);
    const run = this.getRun(snapshot.instance.run_id);
    const expectedArtifacts = expectedArtifactsFromStep(activeStep);
    const registered =
      this.findDeclaredFlowAgent(run.run_id, snapshot.flow.flow_id, stepConfig.role, backend) ??
      this.registerAgent({
        runId: run.run_id,
        backend,
        title: `${snapshot.flow.flow_id}: ${stepConfig.role ?? activeStep.step_id}`,
        role: stepConfig.role,
        objective: run.title,
        repoDir: run.repo_dir,
        model: roleConfig?.model,
        agentToken: input.agentToken
      });
    const subscriber = input.subscriberAgentId ? this.getAgent(input.subscriberAgentId) : null;
    if (subscriber && subscriber.agent_id !== registered.agent_id) {
      this.createAgentLinkIfMissing({
        runId: registered.run_id,
        sourceAgentId: subscriber.agent_id,
        targetAgentId: registered.agent_id,
        type: "parent_child",
        label: stepConfig.role ?? null
      });
    }
    const assignedStep = this.store.updateFlowStepInstance(activeStep.step_instance_id, {
      agentId: registered.agent_id
    });
    const subscriptions: SubscriptionRecord[] = [];
    if (subscriber) {
      for (const eventType of ["agent.completed", "agent.failed", "agent.blocked", "agent.stopped"] as EventType[]) {
        subscriptions.push(
          this.createSubscriptionIfMissing({
            runId: run.run_id,
            sourceAgentId: registered.agent_id,
            subscriberAgentId: subscriber.agent_id,
            eventType
          })
        );
      }
    }
    const stepForPrompt = this.store.updateFlowStepInstance(activeStep.step_instance_id, {
      inputJson: assignFlowStepWorkerAgent(assignedStep.input_json, registered.agent_id)
    });
    const prompt = this.buildActiveFlowWorkerPrompt(stepForPrompt);

    const started = await this.startAgent({
      agentId: registered.agent_id,
      prompt,
      server: input.server ?? DEFAULT_OPENCODE_SERVER,
      model: roleConfig?.model,
      expectedArtifacts,
      metadata: {
        flow_instance_id: snapshot.instance.flow_instance_id,
        step_instance_id: activeStep.step_instance_id,
        step_id: activeStep.step_id
      },
      agentToken: input.agentToken
    });
    const { agent_token: _agentToken, ...agent } = started;

    return {
      flow_instance_id: snapshot.instance.flow_instance_id,
      step: {
        step_instance_id: assignedStep.step_instance_id,
        step_id: assignedStep.step_id,
        status: assignedStep.status,
        agent_id: assignedStep.agent_id
      },
      agent: {
        agent_id: agent.agent_id,
        run_id: agent.run_id,
        backend: agent.backend,
        title: agent.title,
        role: agent.role,
        status: agent.status,
        failure_reason: agent.failure_reason
      },
      subscriptions: subscriptions.map((subscription) => ({
        subscription_id: subscription.subscription_id,
        event_type: subscription.event_type,
        source_agent_id: subscription.source_agent_id,
        subscriber_agent_id: subscription.subscriber_agent_id
      })),
      expected_artifacts: expectedArtifacts,
      prompt_size: prompt.length
    };
  }

  private async continueFlowInternal(input: {
    flowInstanceId: string;
    subscriberAgentId?: string | null;
    server?: string | null;
    agentToken?: string | null;
  }): Promise<FlowContinueResult> {
    const snapshot = this.getFlowSnapshot(input.flowInstanceId);
    const instance = snapshot.instance;
    if (instance.status === "waiting_for_orchestrator") {
      return this.flowContinuationResult(snapshot, "waiting_for_orchestrator", {
        notification: "orchestrator"
      });
    }
    if (instance.status === "blocked") {
      return this.flowContinuationResult(snapshot, "blocked", {
        blockedReason: "flow_blocked"
      });
    }
    if (instance.status === "completed") {
      return this.flowContinuationResult(snapshot, "completed");
    }
    if (instance.status === "cancelled") {
      return this.flowContinuationResult(snapshot, "cancelled");
    }

    const activeStep = snapshot.steps.find((step) => step.status === "active") ?? null;
    if (!activeStep) {
      return this.flowContinuationResult(snapshot, "no_active_step", {
        blockedReason: "no_active_step"
      });
    }

    if (activeStep.agent_id) {
      const agent = await this.refreshAgentStatus(activeStep.agent_id);
      if (TERMINAL_STATUSES.has(agent.status)) {
        const hasReport = this.store
          .listFlowStepReports(activeStep.flow_instance_id)
          .some((report) => report.step_instance_id === activeStep.step_instance_id);
        if (!hasReport) {
          const blockedStep = this.blockFlowStepForMissingReport(activeStep, agent);
          return this.flowContinuationResult(this.getFlowSnapshot(input.flowInstanceId), "blocked", {
            activeStep: blockedStep,
            agent,
            blockedReason: "terminal_agent_missing_flow_report"
          });
        }
      }
      return this.flowContinuationResult(snapshot, "waiting_for_report", {
        activeStep,
        agent
      });
    }

    const dispatch = await this.dispatchActiveFlowStepInternal({
      snapshot,
      activeStep,
      subscriberAgentId: input.subscriberAgentId ?? null,
      server: input.server ?? null,
      agentToken: input.agentToken ?? null
    });
    const dispatchedAgent = this.getAgent(String(dispatch.agent.agent_id));
    if (TERMINAL_STATUSES.has(dispatchedAgent.status) && dispatchedAgent.status !== "completed") {
      const blockedStep = this.blockFlowStepForMissingReport(activeStep, dispatchedAgent);
      return this.flowContinuationResult(this.getFlowSnapshot(input.flowInstanceId), "blocked", {
        activeStep: blockedStep,
        agent: dispatchedAgent,
        dispatch,
        blockedReason: `agent_start_${dispatchedAgent.status}`
      });
    }
    return this.flowContinuationResult(this.getFlowSnapshot(input.flowInstanceId), "dispatched", {
      activeStep: this.getFlowStepInstanceOrThrow(activeStep.step_instance_id),
      agent: dispatchedAgent,
      dispatch
    });
  }

  private flowContinuationResult(
    snapshot: FlowSnapshot,
    action: FlowContinueResult["action"],
    options: {
      activeStep?: FlowStepInstanceRecord | null;
      dispatch?: FlowDispatchActiveResult | null;
      agent?: AgentRecord | null;
      notification?: string | null;
      blockedReason?: string | null;
    } = {}
  ): FlowContinueResult {
    return {
      flow_instance_id: snapshot.instance.flow_instance_id,
      action,
      instance: snapshot.instance,
      active_step:
        options.activeStep ?? snapshot.steps.find((step) => step.status === "active") ?? null,
      dispatch: options.dispatch ?? null,
      agent: options.agent ?? null,
      notification: options.notification ?? null,
      blocked_reason: options.blockedReason ?? null
    };
  }

  private activeFlowStepOrThrow(snapshot: FlowSnapshot, flowInstanceId: string): FlowStepInstanceRecord {
    const activeStep = snapshot.steps.find((step) => step.status === "active");
    if (!activeStep) {
      throw new ControllerError("No active flow step to dispatch.", "tool_error", {
        flow_instance_id: flowInstanceId
      });
    }
    if (activeStep.agent_id) {
      throw new ControllerError("Active flow step already has an assigned agent.", "tool_error", {
        flow_instance_id: flowInstanceId,
        step_instance_id: activeStep.step_instance_id,
        agent_id: activeStep.agent_id
      });
    }
    return activeStep;
  }

  private blockFlowStepForMissingReport(
    step: FlowStepInstanceRecord,
    agent: AgentRecord
  ): FlowStepInstanceRecord {
    const summary = `Worker ${agent.agent_id} reached terminal status ${agent.status} without reporting the flow step result.`;
    const blocked = this.store.updateFlowStepInstance(step.step_instance_id, {
      status: "blocked",
      summary,
      completedAt: nowIso()
    });
    this.store.updateFlowInstance(step.flow_instance_id, {
      status: "blocked",
      currentStepId: step.step_id
    });
    this.emit({
      runId: agent.run_id,
      agentId: agent.agent_id,
      type: "flow.step_blocked",
      payload: {
        flow_instance_id: step.flow_instance_id,
        step_instance_id: step.step_instance_id,
        step_id: step.step_id,
        reason: "terminal_agent_missing_flow_report",
        agent_status: agent.status
      }
    });
    return blocked;
  }

  reportFlowStep(input: {
    stepInstanceId: string;
    status: FlowStepInstanceStatus;
    result?: Record<string, unknown>;
    artifacts?: Record<string, string>;
    summary?: string | null;
  }): FlowStepReportResult {
    const existingStep = this.getFlowStepInstanceOrThrow(input.stepInstanceId);
    if (existingStep.status !== "active") {
      throw new ControllerError("Flow step report requires an active step instance.", "tool_error", {
        step_instance_id: input.stepInstanceId,
        status: existingStep.status
      });
    }
    const instance = this.getFlowInstanceOrThrow(existingStep.flow_instance_id);
    const flow = this.getFlowOrThrow(instance.flow_record_id);
    const stepConfig = flow.config.steps[existingStep.step_id];
    const result = input.result ?? {};
    const artifacts = input.artifacts ?? {};

    this.store.createFlowStepReport({
      stepInstanceId: existingStep.step_instance_id,
      status: input.status,
      resultJson: result,
      artifactsJson: artifacts,
      summary: input.summary
    });

    if (input.status !== "completed") {
      const blockedStep = this.finishFlowStep(existingStep, input.status, result, {}, null, input.summary ?? null);
      const status = input.status === "failed" ? "blocked" : input.status;
      this.store.updateFlowInstance(instance.flow_instance_id, {
        status: status === "blocked" ? "blocked" : "active",
        currentStepId: existingStep.step_id
      });
      this.emit({
        runId: instance.run_id,
        agentId: blockedStep.agent_id,
        type: input.status === "blocked" ? "flow.step_blocked" : "flow.step_reported",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          step_instance_id: blockedStep.step_instance_id,
          step_id: blockedStep.step_id,
          status: input.status,
          summary: input.summary
        }
      });
      return {
        ...this.getFlowSnapshot(instance.flow_instance_id),
        reported_step: blockedStep,
        selected_transition: null,
        active_step: null,
        notification: input.status
      };
    }

    try {
      validateStepResult(stepConfig.report?.schema, result);
      const outputBindings = this.bindFlowOutputs(flow.config, instance, existingStep, artifacts);
      const completedStep = this.finishFlowStep(
        existingStep,
        "completed",
        result,
        outputBindings,
        null,
        input.summary ?? null
      );
      this.emit({
        runId: instance.run_id,
        agentId: completedStep.agent_id,
        type: "flow.step_reported",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          step_instance_id: completedStep.step_instance_id,
          step_id: completedStep.step_id,
          status: "completed",
          result,
          artifacts: outputBindings,
          summary: input.summary
        }
      });
      return this.advanceFlowAfterStep(flow.config, instance, completedStep, result);
    } catch (error) {
      const payload = errorToPayload(error);
      const blocked = this.finishFlowStep(existingStep, "blocked", result, {}, null, input.summary ?? null);
      this.store.updateFlowInstance(instance.flow_instance_id, {
        status: "blocked",
        currentStepId: existingStep.step_id
      });
      this.emit({
        runId: instance.run_id,
        agentId: blocked.agent_id,
        type: "flow.step_blocked",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          step_instance_id: blocked.step_instance_id,
          step_id: blocked.step_id,
          reason: payload.reason,
          error: payload
        }
      });
      return {
        ...this.getFlowSnapshot(instance.flow_instance_id),
        reported_step: blocked,
        selected_transition: null,
        active_step: null,
        notification: "blocked"
      };
    }
  }

  listRuns(limit?: number, input: { agentToken?: string | null } = {}): RunRecord[] {
    const runs = this.store.listRuns(5000);
    const caller = input.agentToken ? this.requireAgentToken(input.agentToken) : null;
    const visible = caller ? this.filterRunsForAgent(runs, caller) : runs;
    return visible.slice(0, limit ?? 50);
  }

  getRun(runId: string, input: { agentToken?: string | null } = {}): RunRecord {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new ControllerError(`Run not found: ${runId}`, "tool_error", { runId });
    }
    if (input.agentToken) {
      const caller = this.requireAgentToken(input.agentToken);
      if (!this.canAgentAccessRun(caller, runId)) {
        throw new ControllerError(`Run not accessible: ${runId}`, "auth_required", { runId });
      }
    }
    return run;
  }

  orchestratorLogin(input: {
    adminKey: string;
    title: string;
    runTitle?: string | null;
    repoDir?: string | null;
    runId?: string | null;
    backend?: string | null;
    objective?: string | null;
    model?: string | null;
    backendHandle?: Record<string, unknown> | null;
  }): OrchestratorLoginResult {
    if (!verifyAdminKey(input.adminKey)) {
      throw new ControllerError("Invalid Agent Control admin key.", "auth_required");
    }
    const backend = input.backend ?? "codex-thread";
    this.adapters.get(backend);
    const run = input.runId
      ? this.getRun(input.runId)
      : this.createRun({ title: input.runTitle ?? input.title, repoDir: input.repoDir, adminKey: input.adminKey });
    const existing = this.findReusableOrchestrator(run.run_id, backend, input.title, input.backendHandle);
    if (existing) {
      const agentToken = this.issueAgentToken(existing.agent_id);
      return { run, agent: existing, agent_token: agentToken };
    }
    const agent = this.store.createAgent({
      runId: run.run_id,
      backend,
      title: input.title,
      role: "orchestrator",
      objective: input.objective,
      repoDir: input.repoDir ?? run.repo_dir,
      model: input.model,
      backendHandle: input.backendHandle,
      status: "waiting_for_input"
    });
    const agentToken = this.issueAgentToken(agent.agent_id);
    return { run, agent, agent_token: agentToken };
  }

  shutdownRun(runId: string): { run: RunRecord; stopped: AgentRecord[] } {
    const stopped = this.stopAgents({ runId, mode: "graceful" });
    const run = this.store.updateRunStatus(runId, "stopped");
    this.emit({
      runId,
      type: "timer.elapsed",
      payload: { action: "run_shutdown", stoppedAgents: stopped.length }
    });
    return { run, stopped };
  }

  registerAgent(input: {
    runId?: string;
    backend: string;
    title: string;
    role?: string | null;
    objective?: string | null;
    repoDir?: string | null;
    model?: string | null;
    backendHandle?: Record<string, unknown> | null;
    status?: AgentStatus;
    adminKey?: string | null;
    agentToken?: string | null;
  }): AgentWithToken {
    const caller = input.agentToken ? this.requireAgentToken(input.agentToken) : null;
    if (!caller && input.adminKey && !verifyAdminKey(input.adminKey)) {
      throw new ControllerError("Invalid Agent Control admin key.", "auth_required");
    }
    const runId = input.runId ?? caller?.run_id;
    if (!runId) {
      throw new ControllerError("agent_register requires run_id or a valid agent token.", "auth_required");
    }
    this.getRun(runId);
    if (caller && !this.canAgentAccessRun(caller, runId)) {
      throw new ControllerError(`Run not accessible: ${runId}`, "auth_required", { runId });
    }
    this.adapters.get(input.backend);
    const agent = this.store.createAgent({ ...input, runId });
    const agentToken = this.issueAgentToken(agent.agent_id);
    if (caller && caller.run_id === agent.run_id && caller.agent_id !== agent.agent_id) {
      this.createAgentLink({
        runId: agent.run_id,
        sourceAgentId: caller.agent_id,
        targetAgentId: agent.agent_id,
        type: "parent_child",
        label: input.role ?? null
      });
    }
    return { ...agent, agent_token: agentToken };
  }

  listAgents(input: { runId?: string; includeUnregistered?: boolean } = {}): AgentRecord[] {
    return this.store.listAgents(input);
  }

  getAgent(agentId: string): AgentRecord {
    const agent = this.store.getAgent(agentId);
    if (!agent) {
      throw new ControllerError(`Agent not found: ${agentId}`, "tool_error", { agentId });
    }
    return agent;
  }

  requireAgentToken(agentToken: string | null | undefined): AgentRecord {
    const value = agentToken?.trim();
    if (!value) {
      throw new ControllerError("Agent token is required.", "auth_required");
    }
    const agent = this.store.getAgentByTokenHash(hashToken(value));
    if (!agent || agent.unregistered_at) {
      throw new ControllerError("Invalid Agent Control agent token.", "auth_required");
    }
    return agent;
  }

  issueAgentToken(agentId: string): string {
    this.getAgent(agentId);
    const token = generateAgentToken();
    this.store.createAgentToken({ agentId, tokenHash: hashToken(token) });
    return token;
  }

  canAgentAccessRun(agent: AgentRecord, runId: string): boolean {
    return this.filterRunsForAgent(this.store.listRuns(5000), agent).some((run) => run.run_id === runId);
  }

  private ensureDeclaredFlowAgents(input: {
    config: FlowConfig;
    flowId: string;
    run: RunRecord;
    caller: AgentRecord | null;
    agentToken: string | null;
  }): Map<string, AgentRecord> {
    const roleAgents = new Map<string, AgentRecord>();
    const usedRoles = new Set(
      Object.values(input.config.steps)
        .map((step) => step.role)
        .filter((role): role is string => Boolean(role))
    );

    for (const role of [...usedRoles].sort()) {
      const roleConfig = input.config.roles?.[role];
      const explicit = this.explicitDeclaredAgentForRole(input.config, input.run.run_id, role);
      if (explicit) {
        roleAgents.set(role, explicit);
        continue;
      }
      if (!roleConfig?.backend) {
        continue;
      }
      const existing = this.findDeclaredFlowAgent(input.run.run_id, input.flowId, role, roleConfig.backend);
      if (existing) {
        roleAgents.set(role, existing);
        continue;
      }

      const planned = this.registerAgent({
        runId: input.run.run_id,
        backend: roleConfig.backend,
        title: declaredFlowAgentTitle(input.flowId, role),
        role,
        objective: input.run.title,
        repoDir: input.run.repo_dir,
        model: roleConfig.model,
        status: "planned",
        agentToken: input.agentToken
      });
      roleAgents.set(role, planned);
    }

    if (input.caller) {
      for (const agent of roleAgents.values()) {
        if (agent.agent_id === input.caller.agent_id) {
          continue;
        }
        this.createAgentLinkIfMissing({
          runId: input.run.run_id,
          sourceAgentId: input.caller.agent_id,
          targetAgentId: agent.agent_id,
          type: "parent_child",
          label: agent.role
        });
      }
    }

    this.createDeclaredFlowHandoffLinks({
      config: input.config,
      run: input.run,
      roleAgents,
      caller: input.caller
    });

    return roleAgents;
  }

  private ensureFlowOwnerSubscriptions(runId: string, ownerAgentId: string): void {
    for (const eventType of ["flow.notification", "flow.step_blocked"] as EventType[]) {
      this.createSubscriptionIfMissing({
        runId,
        subscriberAgentId: ownerAgentId,
        eventType
      });
    }
  }

  private explicitDeclaredAgentForRole(config: FlowConfig, runId: string, role: string): AgentRecord | null {
    const explicitAgentId = Object.values(config.steps).find((step) => step.role === role && step.agent_id)?.agent_id;
    if (!explicitAgentId) {
      return null;
    }
    const agent = this.store.getAgent(explicitAgentId);
    if (!agent || agent.unregistered_at || agent.run_id !== runId) {
      return null;
    }
    return agent;
  }

  private findDeclaredFlowAgent(
    runId: string,
    flowId: string,
    role: string | null | undefined,
    backend?: string | null
  ): AgentRecord | null {
    if (!role) {
      return null;
    }
    const title = declaredFlowAgentTitle(flowId, role);
    return (
      this.store
        .listAgents({ runId })
        .find(
          (agent) =>
            !agent.unregistered_at &&
            agent.role === role &&
            agent.title === title &&
            (!backend || agent.backend === backend)
        ) ?? null
    );
  }

  private createDeclaredFlowHandoffLinks(input: {
    config: FlowConfig;
    run: RunRecord;
    roleAgents: Map<string, AgentRecord>;
    caller: AgentRecord | null;
  }): void {
    for (const [sourceStepId, step] of Object.entries(input.config.steps)) {
      const sourceAgent = step.role ? input.roleAgents.get(step.role) : null;
      if (!sourceAgent) {
        continue;
      }
      for (const [eventName, action] of Object.entries(step.on ?? {})) {
        for (const target of flowActionTargets(action, eventName)) {
          const targetAgent =
            target.kind === "step"
              ? this.declaredAgentForStep(input.config, input.roleAgents, target.id)
              : this.declaredAgentForNotify(input.roleAgents, input.caller, target.id);
          if (!targetAgent || targetAgent.agent_id === sourceAgent.agent_id) {
            continue;
          }
          this.createAgentLinkIfMissing({
            runId: input.run.run_id,
            sourceAgentId: sourceAgent.agent_id,
            targetAgentId: targetAgent.agent_id,
            type: "handoff",
            label: target.label
          });
        }
      }
    }
  }

  private declaredAgentForStep(
    config: FlowConfig,
    roleAgents: Map<string, AgentRecord>,
    stepId: string
  ): AgentRecord | null {
    const targetStep = config.steps[stepId];
    return targetStep?.role ? roleAgents.get(targetStep.role) ?? null : null;
  }

  private declaredAgentForNotify(
    roleAgents: Map<string, AgentRecord>,
    caller: AgentRecord | null,
    notifyTarget: string
  ): AgentRecord | null {
    if (caller?.role === notifyTarget) {
      return caller;
    }
    return roleAgents.get(notifyTarget) ?? null;
  }

  private findReusableOrchestrator(
    runId: string,
    backend: string,
    title: string,
    backendHandle?: Record<string, unknown> | null
  ): AgentRecord | null {
    const wantedThreadId = recordString(backendHandle, "thread_id");
    const agents = this.store.listAgents({ runId });
    return (
      agents.find((agent) => {
        if (agent.unregistered_at || agent.role !== "orchestrator" || agent.backend !== backend) {
          return false;
        }
        if (wantedThreadId) {
          return recordString(agent.backend_handle, "thread_id") === wantedThreadId;
        }
        return agent.title === title;
      }) ?? null
    );
  }

  private filterRunsForAgent(runs: RunRecord[], agent: AgentRecord): RunRecord[] {
    const runById = new Map(runs.map((run) => [run.run_id, run]));
    const accessible = new Set<string>([agent.run_id]);
    const expandable = new Set<string>();

    for (const run of runs) {
      if (run.created_by_agent_id === agent.agent_id) {
        accessible.add(run.run_id);
        expandable.add(run.run_id);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const run of runs) {
        if (run.parent_run_id && expandable.has(run.parent_run_id) && !accessible.has(run.run_id)) {
          accessible.add(run.run_id);
          expandable.add(run.run_id);
          changed = true;
        }
      }
    }

    return runs.filter((run) => accessible.has(run.run_id) && runById.has(run.run_id));
  }

  async startAgent(input: {
    agentId: string;
    prompt?: string;
    server?: string;
    model?: string;
    expectedArtifacts?: string[];
    attachments?: string[];
    metadata?: Record<string, unknown>;
    agentToken?: string | null;
  }): Promise<AgentWithToken> {
    const agent = this.getAgent(input.agentId);
    if (input.agentToken) {
      const caller = this.requireAgentToken(input.agentToken);
      if (!this.canAgentAccessRun(caller, agent.run_id)) {
        throw new ControllerError(`Agent not accessible: ${agent.agent_id}`, "auth_required", {
          agent_id: agent.agent_id
        });
      }
    }
    const adapter = this.adapters.get(agent.backend);
    const capabilities = adapter.capabilities();
    if (!capabilities.canStart && !agent.backend_handle) {
      throw new ControllerError(`Backend cannot start agents: ${agent.backend}`, "unsupported_operation", {
        backend: agent.backend
      });
    }

    this.store.updateAgent(agent.agent_id, { status: "starting", failureReason: null });
    this.emit({
      runId: agent.run_id,
      agentId: agent.agent_id,
      type: "agent.status_changed",
      payload: { status: "starting" }
    });

    const runtimeToken = this.issueAgentToken(agent.agent_id);
    try {
      const handle = await adapter.start({
        agent,
        agentToken: runtimeToken,
        prompt: input.prompt,
        server: input.server,
        model: input.model,
        expectedArtifacts: input.expectedArtifacts,
        attachments: input.attachments,
        metadata: input.metadata
      });
      const updated = this.store.updateAgent(agent.agent_id, {
        backendHandle: handle.data,
        status: "running",
        failureReason: null
      });
      this.emit({
        runId: updated.run_id,
        agentId: updated.agent_id,
        type: "agent.started",
        payload: { backend: updated.backend, title: updated.title }
      });
      this.store.touchHeartbeat(updated.agent_id);
      this.armStatusWatcher(updated);
      return { ...updated, agent_token: runtimeToken };
    } catch (error) {
      const payload = errorToPayload(error);
      const reason = payload.reason as FailureReason;
      const failed = this.store.updateAgent(agent.agent_id, {
        status: "failed",
        failureReason: reason
      });
      this.emit({
        runId: failed.run_id,
        agentId: failed.agent_id,
        type: "agent.failed",
        payload
      });
      return { ...failed, agent_token: runtimeToken };
    }
  }

  async sendMessage(agentId: string, message: string): Promise<{ agent: AgentRecord; delivered: boolean }> {
    const agent = this.getAgent(agentId);
    const adapter = this.adapters.get(agent.backend);
    const handle = this.requireHandle(agent);
    await adapter.sendMessage(handle, { message, metadata: { agentToken: this.issueAgentToken(agentId) } });
    const updated = this.store.updateAgent(agentId, {
      status: "running",
      failureReason: null
    });
    const event = this.emit({
      runId: updated.run_id,
      agentId,
      type: "agent.message",
      payload: { direction: "outbound", size: message.length }
    });
    this.store.touchHeartbeat(agentId, event.created_at);
    this.armStatusWatcher(updated);
    return { agent: updated, delivered: true };
  }

  async readLatest(agentId: string, limit = 1): Promise<unknown[]> {
    const agent = this.getAgent(agentId);
    const adapter = this.adapters.get(agent.backend);
    const messages = await adapter.readLatest(this.requireHandle(agent), { limit });
    this.store.touchHeartbeat(agentId);
    return messages;
  }

  async refreshAgentStatus(agentId: string): Promise<AgentRecord> {
    const agent = this.getAgent(agentId);
    if (agent.unregistered_at || TERMINAL_STATUSES.has(agent.status)) {
      return agent;
    }
    if (
      !agent.backend_handle &&
      (agent.status === "planned" ||
        agent.status === "queued" ||
        agent.status === "starting" ||
        agent.status === "waiting_for_input")
    ) {
      return agent;
    }

    const adapter = this.adapters.get(agent.backend);
    if (!adapter.capabilities().canInspectStatusCheaply) {
      return agent;
    }

    try {
      const snapshot = await adapter.getStatus(this.requireHandle(agent));
      const snapshotFailureReason = snapshot.failureReason ?? null;
      const changed = snapshot.status !== agent.status || snapshotFailureReason !== agent.failure_reason;
      const updated = changed
        ? this.store.updateAgent(agent.agent_id, {
            status: snapshot.status,
            failureReason: snapshotFailureReason
          })
        : this.store.updateAgent(agent.agent_id, {});

      if (changed) {
        this.emit({
          runId: updated.run_id,
          agentId: updated.agent_id,
          type: this.statusEventType(snapshot.status),
          payload: {
            status: snapshot.status,
            failureReason: snapshot.failureReason,
            message: snapshot.message,
            data: snapshot.data
          }
        });
      }
      if (TERMINAL_STATUSES.has(updated.status)) {
        this.disarmStatusWatcher(updated.agent_id);
      }
      this.store.touchHeartbeat(agent.agent_id);
      return updated;
    } catch (error) {
      const payload = errorToPayload(error);
      const failed = this.store.updateAgent(agent.agent_id, {
        status: "failed",
        failureReason: payload.reason as FailureReason
      });
      this.emit({
        runId: failed.run_id,
        agentId: failed.agent_id,
        type: "agent.failed",
        payload
      });
      return failed;
    }
  }

  async pollActiveAgents(runId?: string): Promise<AgentRecord[]> {
    const agents = this.store
      .listAgents({ runId })
      .filter((agent) => !TERMINAL_STATUSES.has(agent.status));
    const refreshed: AgentRecord[] = [];
    for (const agent of agents) {
      refreshed.push(await this.refreshAgentStatus(agent.agent_id));
    }
    await this.checkHeartbeats();
    return refreshed;
  }

  async waitForAgentTerminal(
    agentId: string,
    options: { intervalMs?: number; timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>> {
    const intervalMs = options.intervalMs ?? 5000;
    const startedAt = Date.now();
    while (true) {
      const agent = await this.refreshAgentStatus(agentId);
      await this.checkHeartbeats();
      if (TERMINAL_STATUSES.has(agent.status)) {
        await this.drainDeliveries();
        return {
          timed_out: false,
          terminal: true,
          agent
        };
      }
      if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
        return {
          timed_out: true,
          terminal: false,
          agent
        };
      }
      await sleep(intervalMs);
    }
  }

  async waitForSubscriptionEvent(
    subscriptionId: string,
    options: { intervalMs?: number; timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>> {
    const intervalMs = options.intervalMs ?? 5000;
    const startedAt = Date.now();
    while (true) {
      const subscription = this.store
        .listSubscriptions({})
        .find((entry) => entry.subscription_id === subscriptionId);
      if (!subscription) {
        throw new ControllerError(`Subscription not found: ${subscriptionId}`, "tool_error", {
          subscription_id: subscriptionId
        });
      }

      if (subscription.source_agent_id) {
        await this.refreshAgentStatus(subscription.source_agent_id);
      } else if (subscription.run_id) {
        await this.pollActiveAgents(subscription.run_id);
      }
      await this.checkHeartbeats();

      const refreshed = this.store
        .listSubscriptions({})
        .find((entry) => entry.subscription_id === subscriptionId);
      const events = this.listEvents({
        runId: subscription.run_id ?? undefined,
        agentId: subscription.source_agent_id ?? undefined,
        type: subscription.event_type,
        limit: 20
      }).filter((event) => Date.parse(event.created_at) >= Date.parse(subscription.created_at));
      const deliveredEventId = refreshed?.last_delivered_event_id;
      const event = deliveredEventId
        ? events.find((candidate) => candidate.event_id === deliveredEventId) ?? events[0]
        : events[0];

      if (event) {
        if (deliveredEventId === event.event_id) {
          return {
            timed_out: false,
            matched: true,
            delivered: true,
            subscription: refreshed ?? subscription,
            event
          };
        }

        await this.deliverSubscriptions(event);
        await this.drainDeliveries();
        const afterDelivery = this.store
          .listSubscriptions({})
          .find((entry) => entry.subscription_id === subscriptionId);
        const afterDeliveryEventId = afterDelivery?.last_delivered_event_id;
        if (afterDeliveryEventId === event.event_id) {
          return {
            timed_out: false,
            matched: true,
            delivered: true,
            subscription: afterDelivery ?? refreshed ?? subscription,
            event
          };
        }
      }
      if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
        return {
          timed_out: true,
          matched: Boolean(event),
          delivered: false,
          subscription: refreshed ?? subscription
        };
      }
      await sleep(intervalMs);
    }
  }

  async stopAgent(agentId: string, mode: "graceful" | "interrupt" | "kill" = "graceful"): Promise<AgentRecord> {
    let agent = this.getAgent(agentId);
    const adapter = this.adapters.get(agent.backend);
    if (!agent.backend_handle) {
      const recoveredHandle = this.recoverBackendHandle(agent);
      if (recoveredHandle) {
        agent = this.store.updateAgent(agentId, { backendHandle: recoveredHandle });
      }
    }
    if (!agent.backend_handle) {
      const stopped = this.store.updateAgent(agentId, { status: "stopped", failureReason: null });
      this.emit({
        runId: stopped.run_id,
        agentId,
        type: "agent.stopped",
        payload: { status: "stopped", message: "Agent had no active backend session." }
      });
      return stopped;
    }
    const stopping = this.store.updateAgent(agentId, { status: "stopping" });
    this.emit({
      runId: stopping.run_id,
      agentId,
      type: "agent.status_changed",
      payload: { status: "stopping" }
    });

    try {
      const result = await adapter.stop(this.requireHandle(stopping), { mode });
      const stopped = this.store.updateAgent(agentId, {
        status: result.status,
        failureReason: result.failureReason ?? null
      });
      if (TERMINAL_STATUSES.has(stopped.status)) {
        this.disarmStatusWatcher(agentId);
      }
      this.emit({
        runId: stopped.run_id,
        agentId,
        type: this.statusEventType(stopped.status),
        payload: { status: stopped.status, message: result.message, data: result.data }
      });
      return stopped;
    } catch (error) {
      const payload = errorToPayload(error);
      const failed = this.store.updateAgent(agentId, {
        status: "failed",
        failureReason: payload.reason as FailureReason
      });
      this.emit({ runId: failed.run_id, agentId, type: "agent.failed", payload });
      return failed;
    }
  }

  stopAgents(input: { runId?: string; mode?: "graceful" | "interrupt" | "kill" }): AgentRecord[] {
    const mode = input.mode ?? "graceful";
    const agents = this.store
      .listAgents({ runId: input.runId })
      .filter((agent) => !TERMINAL_STATUSES.has(agent.status));
    const marked: AgentRecord[] = [];
    for (const agent of agents) {
      marked.push(this.store.updateAgent(agent.agent_id, { status: "stopping" }));
      void this.stopAgent(agent.agent_id, mode);
    }
    return marked;
  }

  async unregisterAgent(agentId: string): Promise<AgentRecord> {
    const agent = this.getAgent(agentId);
    const adapter = this.adapters.get(agent.backend);
    if (agent.backend_handle && adapter.unregister) {
      await adapter.unregister(this.requireHandle(agent), { archiveRecord: true });
    }
    const unregistered = this.store.updateAgent(agentId, { unregisteredAt: nowIso() });
    this.disarmStatusWatcher(agentId);
    this.emit({
      runId: unregistered.run_id,
      agentId,
      type: "agent.unregistered",
      payload: { archiveRecord: true }
    });
    return unregistered;
  }

  async unregisterAgents(input: { runId?: string }): Promise<AgentRecord[]> {
    const agents = this.store.listAgents({ runId: input.runId });
    const unregistered: AgentRecord[] = [];
    for (const agent of agents) {
      unregistered.push(await this.unregisterAgent(agent.agent_id));
    }
    return unregistered;
  }

  async agentPurge(agentId: string, options: Partial<PurgeOptions> = {}): Promise<PurgeResult> {
    const resolved = normalizePurgeOptions(options);
    let agent = this.getAgent(agentId);

    if (!resolved.dryRun && isUnsafeToPurge(agent)) {
      if (resolved.stopFirst) {
        this.suppressedDeliveryAgentIds.add(agentId);
        try {
          await this.stopAgentForPurge(agentId);
          agent = this.getAgent(agentId);
        } finally {
          this.suppressedDeliveryAgentIds.delete(agentId);
        }
        if (isUnsafeToPurge(agent)) {
          throw new ControllerError(
            "Refusing to purge because stop_first did not stop the active agent.",
            "tool_error",
            { agent_id: agentId, status: agent.status }
          );
        }
      }
      if (!resolved.force && isUnsafeToPurge(agent)) {
        throw new ControllerError(
          "Refusing to purge an active agent without stop_first or force.",
          "tool_error",
          { agent_id: agentId, status: agent.status }
        );
      }
    }

    const runtimePath = agentRuntimePath(agent.run_id, agent.agent_id);
    const result = createPurgeResult(resolved.dryRun);
    result.purged_agents.push(agent.agent_id);
    result.deleted_rows = mergeRowCounts(result.deleted_rows, this.store.countAgentPurgeRows(agent.agent_id));

    if (resolved.deleteRuntimeFiles) {
      planRuntimeDelete(result, runtimePath, resolved.dryRun);
    }

    if (!resolved.dryRun) {
      this.disarmStatusWatcher(agent.agent_id);
      this.store.purgeAgentRows(agent.agent_id, false);
      if (resolved.deleteRuntimeFiles) {
        deleteRuntimePath(result, runtimePath);
      }
    }

    return result;
  }

  async runPurge(runId: string, options: Partial<PurgeOptions> = {}): Promise<PurgeResult> {
    const resolved = normalizePurgeOptions(options);
    this.getRun(runId);
    let agents = this.store.listAgents({ runId, includeUnregistered: true });
    let unsafeAgents = agents.filter(isUnsafeToPurge);

    if (!resolved.dryRun && unsafeAgents.length > 0 && resolved.stopFirst) {
      this.suppressedDeliveryRunIds.add(runId);
      try {
        for (const agent of unsafeAgents) {
          await this.stopAgentForPurge(agent.agent_id);
        }
        agents = this.store.listAgents({ runId, includeUnregistered: true });
        unsafeAgents = agents.filter(isUnsafeToPurge);
      } finally {
        this.suppressedDeliveryRunIds.delete(runId);
      }
      if (unsafeAgents.length > 0) {
        throw new ControllerError(
          "Refusing to purge because stop_first did not stop every active agent.",
          "tool_error",
          {
            run_id: runId,
            active_agents: unsafeAgents.map((agent) => ({
              agent_id: agent.agent_id,
              status: agent.status
            }))
          }
        );
      }
    }

    if (!resolved.dryRun && unsafeAgents.length > 0 && !resolved.force) {
      throw new ControllerError(
        "Refusing to purge a run with active agents without stop_first or force.",
        "tool_error",
        {
          run_id: runId,
          active_agents: unsafeAgents.map((agent) => ({
            agent_id: agent.agent_id,
            status: agent.status
          }))
        }
      );
    }

    const runtimePath = runRuntimePath(runId);
    const result = createPurgeResult(resolved.dryRun);
    result.purged_runs.push(runId);
    result.purged_agents.push(...agents.map((agent) => agent.agent_id));
    result.deleted_rows = mergeRowCounts(result.deleted_rows, this.store.countRunPurgeRows(runId));

    if (resolved.deleteRuntimeFiles) {
      planRuntimeDelete(result, runtimePath, resolved.dryRun);
    }

    if (!resolved.dryRun) {
      for (const agent of agents) {
        this.disarmStatusWatcher(agent.agent_id);
      }
      this.store.purgeRunRows(runId, false);
      if (resolved.deleteRuntimeFiles) {
        deleteRuntimePath(result, runtimePath);
      }
    }

    return result;
  }

  async maintenancePurgeOld(options: MaintenancePurgeOptions): Promise<PurgeResult> {
    const cutoffIso = new Date(Date.now() - options.olderThanMs).toISOString();
    const stoppedRuns = this.store.listStoppedRunsOlderThan(cutoffIso);
    const unregisteredAgents = this.store.listUnregisteredAgentsOlderThan(
      cutoffIso,
      stoppedRuns.map((run) => run.run_id)
    );
    const result = createPurgeResult(options.dryRun);

    for (const run of stoppedRuns) {
      const runResult = await this.runPurge(run.run_id, {
        ...options
      });
      mergePurgeResult(result, runResult);
    }

    for (const agent of unregisteredAgents) {
      const agentResult = await this.agentPurge(agent.agent_id, {
        ...options
      });
      mergePurgeResult(result, agentResult);
    }

    return result;
  }

  createSubscription(input: {
    runId?: string | null;
    sourceAgentId?: string | null;
    subscriberAgentId: string;
    eventType: EventType;
  }): SubscriptionRecord {
    this.getAgent(input.subscriberAgentId);
    if (input.sourceAgentId) {
      this.getAgent(input.sourceAgentId);
    }
    return this.store.createSubscription(input);
  }

  private createSubscriptionIfMissing(input: {
    runId?: string | null;
    sourceAgentId?: string | null;
    subscriberAgentId: string;
    eventType: EventType;
  }): SubscriptionRecord {
    const existing = this.store
      .listSubscriptions({ runId: input.runId ?? undefined, enabledOnly: true })
      .find(
        (subscription) =>
          subscription.source_agent_id === (input.sourceAgentId ?? null) &&
          subscription.subscriber_agent_id === input.subscriberAgentId &&
          subscription.event_type === input.eventType
      );
    return existing ?? this.createSubscription(input);
  }

  listSubscriptions(input: { runId?: string; enabledOnly?: boolean } = {}): SubscriptionRecord[] {
    return this.store.listSubscriptions(input);
  }

  deleteSubscription(subscriptionId: string): { subscription_id: string; deleted: true } {
    this.store.deleteSubscription(subscriptionId);
    return { subscription_id: subscriptionId, deleted: true };
  }

  createAgentLink(input: {
    runId: string;
    sourceAgentId: string;
    targetAgentId: string;
    type: AgentLinkType;
    label?: string | null;
  }): AgentLinkRecord {
    this.getRun(input.runId);
    const source = this.getAgent(input.sourceAgentId);
    const target = this.getAgent(input.targetAgentId);
    if (source.run_id !== input.runId || target.run_id !== input.runId) {
      throw new ControllerError("Agent links must stay inside a single run.", "tool_error", {
        run_id: input.runId,
        source_agent_id: input.sourceAgentId,
        target_agent_id: input.targetAgentId
      });
    }
    return this.store.createAgentLink(input);
  }

  private createAgentLinkIfMissing(input: {
    runId: string;
    sourceAgentId: string;
    targetAgentId: string;
    type: AgentLinkType;
    label?: string | null;
  }): AgentLinkRecord {
    const expectedLabel = input.label ?? null;
    const existing = this.store
      .listAgentLinks({ runId: input.runId })
      .find(
        (link) =>
          link.source_agent_id === input.sourceAgentId &&
          link.target_agent_id === input.targetAgentId &&
          link.type === input.type &&
          link.label === expectedLabel
      );
    return existing ?? this.createAgentLink(input);
  }

  listAgentLinks(input: { runId?: string; agentId?: string } = {}): AgentLinkRecord[] {
    return this.store.listAgentLinks(input);
  }

  deleteAgentLink(linkId: string): { link_id: string; deleted: true } {
    this.store.deleteAgentLink(linkId);
    return { link_id: linkId, deleted: true };
  }

  createHeartbeat(input: {
    agentId: string;
    idleTimeoutMs: number;
    reminderIntervalMs?: number | null;
  }): HeartbeatRecord {
    this.getAgent(input.agentId);
    return this.store.createHeartbeat(input);
  }

  listHeartbeats(agentId?: string): HeartbeatRecord[] {
    return this.store.listHeartbeats(agentId);
  }

  deleteHeartbeat(heartbeatId: string): { heartbeat_id: string; deleted: true } {
    this.store.deleteHeartbeat(heartbeatId);
    return { heartbeat_id: heartbeatId, deleted: true };
  }

  async checkHeartbeats(): Promise<EventRecord[]> {
    const events: EventRecord[] = [];
    const now = Date.now();
    for (const heartbeat of this.store.listHeartbeats()) {
      const agent = this.store.getAgent(heartbeat.agent_id);
      if (!agent || TERMINAL_STATUSES.has(agent.status)) {
        continue;
      }
      const last = heartbeat.last_event_at ? Date.parse(heartbeat.last_event_at) : Date.parse(agent.updated_at);
      if (Number.isFinite(last) && now - last >= heartbeat.idle_timeout_ms) {
        events.push(
          this.emit({
            runId: agent.run_id,
            agentId: agent.agent_id,
            type: "heartbeat.timeout",
            payload: {
              heartbeat_id: heartbeat.heartbeat_id,
              idleTimeoutMs: heartbeat.idle_timeout_ms,
              lastEventAt: heartbeat.last_event_at
            }
          })
        );
        this.store.touchHeartbeat(agent.agent_id);
      }
    }
    return events;
  }

  createGoal(input: { agentId: string; objective: string }): GoalRecord {
    this.getAgent(input.agentId);
    return this.store.createGoal(input);
  }

  listGoals(agentId?: string): GoalRecord[] {
    return this.store.listGoals(agentId);
  }

  getGoal(goalId: string): GoalRecord {
    const goal = this.store.getGoal(goalId);
    if (!goal) {
      throw new ControllerError(`Goal not found: ${goalId}`, "tool_error", { goalId });
    }
    return goal;
  }

  updateGoal(goalId: string, status: GoalStatus): GoalRecord {
    const goal = this.store.updateGoal(goalId, status);
    const eventType =
      status === "complete" ? "goal.completed" : status === "blocked" ? "goal.blocked" : "goal.continued";
    const agent = this.getAgent(goal.agent_id);
    this.emit({
      runId: agent.run_id,
      agentId: agent.agent_id,
      type: eventType,
      payload: { goal_id: goal.goal_id, status, elapsed_ms: elapsedSince(goal.created_at) }
    });
    return goal;
  }

  deleteGoal(goalId: string): { goal_id: string; deleted: true } {
    this.store.deleteGoal(goalId);
    return { goal_id: goalId, deleted: true };
  }

  async confirmGoal(goalId: string, options: { deferWhileDescendantsRunning?: boolean } = {}): Promise<GoalConfirmationResult> {
    const goal = this.getGoal(goalId);
    const agent = this.getAgent(goal.agent_id);
    const activeDescendants = this.activeDescendants(agent.agent_id);
    const elapsedMs = elapsedSince(goal.created_at);
    if (options.deferWhileDescendantsRunning !== false && activeDescendants.length > 0) {
      this.emit({
        runId: agent.run_id,
        agentId: agent.agent_id,
        type: "goal.confirmation_deferred",
        payload: {
          goal_id: goal.goal_id,
          active_descendant_agent_ids: activeDescendants.map((descendant) => descendant.agent_id),
          elapsed_ms: elapsedMs
        }
      });
      return {
        goal,
        message: "",
        delivered: false,
        deferred: true,
        elapsed_ms: elapsedMs,
        active_descendants: activeDescendants
      };
    }
    const message = withCodexNativeVisibilityReminder(buildGoalConfirmationPrompt(goal.objective), agent);
    await this.sendMessage(agent.agent_id, message);
    this.emit({
      runId: agent.run_id,
      agentId: agent.agent_id,
      type: "goal.confirmation_requested",
      payload: { goal_id: goal.goal_id, elapsed_ms: elapsedMs }
    });
    return {
      goal,
      message,
      delivered: true,
      deferred: false,
      elapsed_ms: elapsedMs,
      active_descendants: []
    };
  }

  async waitForGoalConfirmation(
    goalId: string,
    options: { intervalMs?: number; timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>> {
    const intervalMs = options.intervalMs ?? 5000;
    const startedAt = Date.now();
    while (true) {
      const goal = this.getGoal(goalId);
      const owner = this.getAgent(goal.agent_id);
      const descendants = this.activeDescendants(owner.agent_id);
      for (const descendant of descendants) {
        await this.refreshAgentStatus(descendant.agent_id);
      }
      await this.checkHeartbeats();
      const remaining = this.activeDescendants(owner.agent_id);
      if (remaining.length === 0) {
        return {
          timed_out: false,
          confirmed: true,
          result: await this.confirmGoal(goalId, { deferWhileDescendantsRunning: false })
        };
      }
      if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
        return {
          timed_out: true,
          confirmed: false,
          goal,
          active_descendants: remaining
        };
      }
      await sleep(intervalMs);
    }
  }

  createArtifact(input: {
    runId?: string | null;
    agentId?: string | null;
    label: string;
    path: string;
    expected?: boolean;
  }): ArtifactRecord {
    const artifact = this.store.createArtifact(input);
    this.emit({
      runId: artifact.run_id,
      agentId: artifact.agent_id,
      type: existsSync(artifact.path) ? "artifact.created" : "artifact.updated",
      payload: artifactSummary(artifact)
    });
    return artifact;
  }

  listArtifacts(input: { runId?: string; agentId?: string } = {}): ArtifactRecord[] {
    return this.store.listArtifacts(input);
  }

  createUsageSnapshot(input: {
    runId: string;
    agentId: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    contextUsed?: number | null;
    contextLimit?: number | null;
    source?: string | null;
    model?: string | null;
    capturedAt?: string | null;
  }): UsageSnapshotRecord {
    this.getRun(input.runId);
    const agent = this.getAgent(input.agentId);
    if (agent.run_id !== input.runId) {
      throw new ControllerError("Usage snapshots must stay inside the owning run.", "tool_error", {
        run_id: input.runId,
        agent_id: input.agentId
      });
    }
    return this.store.createUsageSnapshot(input);
  }

  listUsageSnapshots(input: { runId?: string; agentId?: string; limit?: number } = {}): UsageSnapshotRecord[] {
    return this.store.listUsageSnapshots(input);
  }

  readArtifactHeader(path: string, lines = 10): { path: string; exists: boolean; bytes: number; header: string } {
    if (!existsSync(path)) {
      return { path, exists: false, bytes: 0, header: "" };
    }
    const bytes = statSync(path).size;
    const header = readFileSync(path, "utf8").split(/\r?\n/).slice(0, lines).join("\n");
    return { path, exists: true, bytes, header };
  }

  listEvents(input: { runId?: string; agentId?: string; type?: EventType; limit?: number } = {}): EventRecord[] {
    return this.store.listEvents(input);
  }

  async listAgentMessages(agentId: string, options: { limit?: number } = {}): Promise<unknown[]> {
    const agent = this.getAgent(agentId);
    const limit = Math.max(1, options.limit ?? 5);
    if (!agent.backend_handle && !this.recoverBackendHandle(agent)) {
      return controllerEventMessages(agent, this.listAgents({ runId: agent.run_id, includeUnregistered: true }), this.listEvents({ runId: agent.run_id, limit }));
    }
    return this.readLatest(agentId, limit);
  }

  readAgentLogTail(agentId: string, maxChars = 8000): { agent_id: string; exists: boolean; bytes: number; tail: string } {
    const agent = this.getAgent(agentId);
    const logFile = typeof agent.backend_handle?.logFile === "string" ? agent.backend_handle.logFile : null;
    if (!logFile || !existsSync(logFile)) {
      return { agent_id: agentId, exists: false, bytes: 0, tail: "" };
    }
    const bytes = statSync(logFile).size;
    const text = readFileSync(logFile, "utf8");
    return {
      agent_id: agentId,
      exists: true,
      bytes,
      tail: text.slice(Math.max(0, text.length - maxChars))
    };
  }

  getDashboardSnapshot(runId?: string | null): DashboardSnapshot {
    const runs = this.listRuns(100);
    const selectedRunId = runId ?? runs[0]?.run_id ?? null;
    const agents = selectedRunId
      ? this.listAgents({ runId: selectedRunId, includeUnregistered: true })
      : [];
    const agentLinks = selectedRunId ? this.listAgentLinks({ runId: selectedRunId }) : [];
    const flowInstances = selectedRunId ? this.store.listFlowInstances({ runId: selectedRunId }) : [];
    const flowRecordsById = new Map(
      flowInstances
        .map((instance) => this.store.getFlow(instance.flow_record_id))
        .filter((flow): flow is FlowRecord => flow !== null)
        .map((flow) => [flow.flow_record_id, flow])
    );
    const flowSteps = flowInstances.flatMap((instance) =>
      this.store.listFlowStepInstances(instance.flow_instance_id)
    );
    const flowReports = flowInstances.flatMap((instance) =>
      this.store.listFlowStepReports(instance.flow_instance_id)
    );
    const flowTransitions = flowInstances.flatMap((instance) =>
      this.store.listFlowTransitions(instance.flow_instance_id)
    );
    const flowArtifactBindings = flowInstances.flatMap((instance) =>
      this.store.listFlowArtifactBindings(instance.flow_instance_id)
    );
    const subscriptions = selectedRunId ? this.listSubscriptions({ runId: selectedRunId }) : [];
    const agentIds = new Set(agents.map((agent) => agent.agent_id));
    const heartbeats = this.listHeartbeats().filter((heartbeat) => agentIds.has(heartbeat.agent_id));
    const goals = this.listGoals().filter((goal) => agentIds.has(goal.agent_id));
    const artifacts = selectedRunId ? this.listArtifacts({ runId: selectedRunId }) : [];
    const latestEvents = selectedRunId ? this.listEvents({ runId: selectedRunId, limit: 100 }) : [];
    const usageSnapshots = selectedRunId ? this.listUsageSnapshots({ runId: selectedRunId, limit: 1000 }) : [];
    const latestUsageByAgent = latestUsageSnapshotsByAgent(usageSnapshots);
    const statusCounts = emptyStatusCounts();
    for (const agent of agents) {
      statusCounts[agent.status] += 1;
    }

    const now = Date.now();
    const computedAgents = agents.map((agent) => {
      const created = Date.parse(agent.created_at);
      const updated = Date.parse(agent.updated_at);
      const isTerminal = TERMINAL_STATUSES.has(agent.status);
      const elapsedEnd = isTerminal && Number.isFinite(updated) ? updated : now;
      return {
        agent_id: agent.agent_id,
        elapsed_ms: Number.isFinite(created) ? Math.max(0, elapsedEnd - created) : 0,
        status_age_ms: Number.isFinite(updated) ? Math.max(0, now - updated) : 0,
        is_terminal: isTerminal,
        latest_usage: latestUsageByAgent.get(agent.agent_id) ?? null
      };
    });

    return {
      generated_at: new Date(now).toISOString(),
      selected_run_id: selectedRunId,
      runs,
      agents,
      agent_links: agentLinks,
      flows: [...flowRecordsById.values()],
      flow_instances: flowInstances,
      flow_steps: flowSteps,
      flow_reports: flowReports,
      flow_transitions: flowTransitions,
      flow_artifact_bindings: flowArtifactBindings,
      subscriptions,
      heartbeats,
      goals,
      artifacts,
      latest_events: latestEvents,
      computed_agents: computedAgents,
      status_counts: statusCounts,
      usage_totals: usageTotals([...latestUsageByAgent.values()])
    };
  }

  private activateFlowStep(
    config: FlowConfig,
    instance: FlowInstanceRecord,
    stepId: string
  ): FlowStepInstanceRecord {
    const stepConfig = config.steps[stepId];
    if (!stepConfig) {
      throw new ControllerError("Cannot activate undefined flow step.", "tool_error", {
        flow_instance_id: instance.flow_instance_id,
        step_id: stepId
      });
    }
    const bindings = this.store.listFlowArtifactBindings(instance.flow_instance_id);
    const inputArtifacts = resolveInputArtifacts(stepConfig.inputs, bindings);
    const promptSources = resolveStepPromptSources(config, stepId);
    const stepInstanceId = newId("flowstep");
    const run = this.getRun(instance.run_id);
    const describedInputs = this.describeStepInputArtifacts(config, stepConfig, inputArtifacts);
    const outputArtifacts = this.resolveStepOutputArtifacts(config, instance, stepConfig);
    const runtimeContract = this.buildFlowStepRuntimeContract({
      flowId: config.id,
      stepId,
      stepConfig,
      roleConfig: stepConfig.role ? config.roles?.[stepConfig.role] : undefined,
      instance,
      run,
      inputArtifacts: describedInputs,
      outputArtifacts
    });
    const reportingContract = this.buildFlowStepReportingContract({
      stepId,
      stepInstanceId,
      stepConfig,
      outputArtifacts
    });
    const inputJson: Record<string, unknown> = {
      ...inputArtifacts,
      runtime_contract: runtimeContract,
      input_artifacts: describedInputs,
      output_artifacts: outputArtifacts,
      reporting_contract: reportingContract
    };
    if (promptSources.length > 0) {
      inputJson.prompt_sources = promptSources;
    }
    const missing = this.missingRequiredInputArtifacts(stepConfig, bindings);
    const step = this.store.createFlowStepInstance({
      stepInstanceId,
      flowInstanceId: instance.flow_instance_id,
      stepId,
      agentId: stepConfig.agent_id,
      inputJson
    });

    if (missing.length > 0) {
      const summary = `Missing required input artifacts: ${missing.join(", ")}`;
      const blocked = this.store.updateFlowStepInstance(step.step_instance_id, {
        status: "blocked",
        summary,
        completedAt: nowIso()
      });
      this.store.updateFlowInstance(instance.flow_instance_id, {
        status: "blocked",
        currentStepId: stepId
      });
      this.emit({
        runId: instance.run_id,
        agentId: stepConfig.agent_id,
        type: "flow.step_blocked",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          step_instance_id: step.step_instance_id,
          step_id: stepId,
          reason: "missing_required_artifact",
          missing_artifacts: missing
        }
      });
      return blocked;
    }

    this.store.updateFlowInstance(instance.flow_instance_id, {
      status: "active",
      currentStepId: stepId
    });
    this.emit({
      runId: instance.run_id,
      agentId: stepConfig.agent_id,
      type: "flow.step_started",
      payload: {
        flow_instance_id: instance.flow_instance_id,
        step_instance_id: step.step_instance_id,
        step_id: stepId,
        role: stepConfig.role,
        inputs: inputArtifacts,
        runtime_contract: runtimeContract,
        input_artifacts: inputJson.input_artifacts,
        output_artifacts: outputArtifacts,
        prompt_sources: promptSources,
        reporting_contract: reportingContract
      }
    });
    return step;
  }

  private describeStepInputArtifacts(
    config: FlowConfig,
    stepConfig: FlowConfig["steps"][string],
    resolvedInputs: Record<string, string>
  ): Record<string, Record<string, unknown>> {
    const described: Record<string, Record<string, unknown>> = {};
    for (const [inputName, ref] of Object.entries(stepConfig.inputs ?? {})) {
      described[inputName] = {
        artifact: ref.artifact,
        description: config.artifacts?.[ref.artifact]?.description ?? null,
        required: ref.required ?? false,
        path: resolvedInputs[inputName] ?? null
      };
    }
    return described;
  }

  private buildActiveFlowWorkerPrompt(step: FlowStepInstanceRecord): string {
    const input = step.input_json;
    const sections: string[] = [];
    const promptSources = Array.isArray(input.prompt_sources) ? input.prompt_sources : [];
    for (const source of promptSources) {
      if (!source || typeof source !== "object") {
        continue;
      }
      const record = source as Record<string, unknown>;
      const label = [record.scope, record.owner_id, record.prompt_ref].filter(Boolean).join(":");
      if (typeof record.text === "string") {
        sections.push(section(`Prompt ${label || sections.length + 1}`, record.text));
        continue;
      }
      if (typeof record.path === "string") {
        if (!existsSync(record.path) || !statSync(record.path).isFile()) {
          throw new ControllerError("Flow prompt source file is unavailable.", "tool_error", {
            step_instance_id: step.step_instance_id,
            path: record.path
          });
        }
        sections.push(section(`Prompt ${label || record.path}`, readFileSync(record.path, "utf8")));
      }
    }

    const runtimeContract = readMarkdownContract(input.runtime_contract, "Runtime Contract");
    if (runtimeContract) {
      sections.push(runtimeContract);
    }
    const reportingContract = readMarkdownContract(input.reporting_contract, "Reporting Contract");
    if (reportingContract) {
      sections.push(reportingContract);
    }
    sections.push(
      section(
        "Backend Constraints",
        [
          "You are an Agent Control worker executing one flow step.",
          "Use the generated runtime and reporting contracts as the source of truth.",
          "Write the required artifact paths before reporting.",
          "Keep any in-process status terse.",
          "Do not assume the caller is Codex; use Agent Control MCP or CLI reporting exactly as instructed."
        ].join("\n")
      )
    );
    return sections.join("\n\n");
  }

  private resolveStepOutputArtifacts(
    config: FlowConfig,
    instance: FlowInstanceRecord,
    stepConfig: FlowConfig["steps"][string]
  ): Record<string, Record<string, unknown>> {
    const runDir = runRuntimeDir(instance.run_id);
    const outputArtifacts: Record<string, Record<string, unknown>> = {};
    for (const [outputName, ref] of Object.entries(stepConfig.outputs ?? {})) {
      const template = config.artifacts?.[ref.artifact]?.path;
      outputArtifacts[outputName] = {
        artifact: ref.artifact,
        description: config.artifacts?.[ref.artifact]?.description ?? null,
        required: ref.required ?? false,
        path: template ? resolveArtifactPath(template, { runId: instance.run_id, runDir }) : null
      };
    }
    return outputArtifacts;
  }

  private buildFlowStepRuntimeContract(input: {
    flowId: string;
    stepId: string;
    stepConfig: FlowConfig["steps"][string];
    roleConfig: NonNullable<FlowConfig["roles"]>[string] | undefined;
    instance: FlowInstanceRecord;
    run: RunRecord;
    inputArtifacts: Record<string, Record<string, unknown>>;
    outputArtifacts: Record<string, Record<string, unknown>>;
  }): Record<string, unknown> {
    return {
      flow_id: input.flowId,
      flow_instance_id: input.instance.flow_instance_id,
      step_id: input.stepId,
      role: input.stepConfig.role ?? null,
      run: {
        run_id: input.run.run_id,
        title: input.run.title,
        repo_dir: input.run.repo_dir
      },
      worker: {
        agent_id: input.stepConfig.agent_id ?? null,
        role: input.stepConfig.role ?? null,
        backend: input.roleConfig?.backend ?? null,
        model: input.roleConfig?.model ?? null
      },
      input_artifacts: input.inputArtifacts,
      output_artifacts: input.outputArtifacts,
      instructions: [
        "Use the run title/objective and repository directory from this runtime contract.",
        "Read only the input artifacts that are present and relevant to this step.",
        "Write every required output artifact to its assigned path before reporting.",
        "Do not invent artifact paths, filenames, or additional handoff files unless the task itself requires separate repo changes."
      ],
      markdown: buildFlowRuntimeMarkdown({
        flowId: input.flowId,
        flowInstanceId: input.instance.flow_instance_id,
        stepId: input.stepId,
        workerAgentId: input.stepConfig.agent_id ?? null,
        role: input.stepConfig.role ?? null,
        backend: input.roleConfig?.backend ?? null,
        model: input.roleConfig?.model ?? null,
        run: input.run,
        inputArtifacts: input.inputArtifacts,
        outputArtifacts: input.outputArtifacts
      })
    };
  }

  private buildFlowStepReportingContract(input: {
    stepId: string;
    stepInstanceId: string;
    stepConfig: FlowConfig["steps"][string];
    outputArtifacts: Record<string, Record<string, unknown>>;
  }): Record<string, unknown> {
    const toolName = input.stepConfig.report?.tool ?? "flow_step_report";
    const resultSchema = input.stepConfig.report?.schema ?? { type: "object" };
    const resultExample = exampleFromResultSchema(resultSchema);
    const artifactExample = exampleArtifactReport(input.outputArtifacts);
    const mcpInput = {
      step_instance_id: input.stepInstanceId,
      status: "completed",
      result: resultExample,
      artifacts: artifactExample,
      summary: `Compact ${input.stepId} result.`
    };
    const cliCommand = buildFlowReportCliCommand(input.stepInstanceId, resultExample, artifactExample, mcpInput.summary);

    return {
      step_id: input.stepId,
      step_instance_id: input.stepInstanceId,
      preferred: "mcp",
      mcp_tool: {
        name: toolName,
        input: mcpInput
      },
      cli: {
        command: cliCommand
      },
      result_schema: resultSchema,
      result_example: resultExample,
      artifact_example: artifactExample,
      instructions: [
        `Use the Agent Control MCP tool \`${toolName}\` when it is available.`,
        "If MCP tools are not available, use the CLI command shown below.",
        "Report only fields allowed by the result schema. Do not invent result labels.",
        "Use status `completed` when the required artifact was written, even if the structured conclusion represents a blocker.",
        "Use a non-completed status only when you could not write the required artifact or could not produce a valid report."
      ],
      markdown: buildFlowReportingMarkdown({
        toolName,
        mcpInput,
        cliCommand,
        resultSchema,
        outputArtifacts: input.outputArtifacts
      })
    };
  }

  private advanceFlowAfterStep(
    config: FlowConfig,
    instance: FlowInstanceRecord,
    step: FlowStepInstanceRecord,
    result: Record<string, unknown>
  ): FlowStepReportResult {
    const action = resolveStepEventAction(config.steps[step.step_id], step.status);
    if (!action) {
      this.store.updateFlowInstance(instance.flow_instance_id, {
        status: "completed",
        currentStepId: null
      });
      this.emit({
        runId: instance.run_id,
        agentId: step.agent_id,
        type: "flow.completed",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          completed_step_id: step.step_id
        }
      });
      return {
        ...this.getFlowSnapshot(instance.flow_instance_id),
        reported_step: step,
        selected_transition: null,
        active_step: null,
        notification: null
      };
    }

    const context = {
      status: step.status,
      result,
      step: {
        id: step.step_id,
        instance_id: step.step_instance_id
      }
    };
    const selected = action.transitions ? selectTransition(action, context) : null;
    const selectedAction = selected ?? action;
    const transitionId = selected?.id ?? (selectedAction.to ? `${step.step_id}-to-${selectedAction.to}` : "notify");
    let transitionRecord: FlowTransitionRecord | null = null;

    if (selectedAction.to) {
      transitionRecord = this.store.createFlowTransition({
        flowInstanceId: instance.flow_instance_id,
        fromStepInstanceId: step.step_instance_id,
        transitionId,
        targetStepId: selectedAction.to,
        actionJson: selectedAction as unknown as Record<string, unknown>
      });
      this.store.updateFlowStepInstance(step.step_instance_id, { transitionId });
      this.emit({
        runId: instance.run_id,
        agentId: step.agent_id,
        type: "flow.transition_selected",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          from_step_instance_id: step.step_instance_id,
          transition_id: transitionId,
          target_step_id: selectedAction.to
        }
      });
      const active = this.activateFlowStep(config, instance, selectedAction.to);
      return {
        ...this.getFlowSnapshot(instance.flow_instance_id),
        reported_step: step,
        selected_transition: transitionRecord,
        active_step: active.status === "active" ? active : null,
        notification: null
      };
    }

    if (selectedAction.finish) {
      transitionRecord = this.store.createFlowTransition({
        flowInstanceId: instance.flow_instance_id,
        fromStepInstanceId: step.step_instance_id,
        transitionId,
        actionJson: selectedAction as unknown as Record<string, unknown>
      });
      this.store.updateFlowInstance(instance.flow_instance_id, {
        status: "completed",
        currentStepId: null
      });
      this.emit({
        runId: instance.run_id,
        agentId: step.agent_id,
        type: "flow.completed",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          transition_id: transitionId
        }
      });
      if (selectedAction.notify) {
        this.emit({
          runId: instance.run_id,
          agentId: step.agent_id,
          type: "flow.notification",
          payload: {
            flow_instance_id: instance.flow_instance_id,
            from_step_instance_id: step.step_instance_id,
            transition_id: transitionId,
            notify: selectedAction.notify,
            status: "completed",
            message: step.summary ?? "Flow completed."
          }
        });
      }
      return {
        ...this.getFlowSnapshot(instance.flow_instance_id),
        reported_step: step,
        selected_transition: transitionRecord,
        active_step: null,
        notification: selectedAction.notify ?? null
      };
    }

    if (selectedAction.notify) {
      transitionRecord = this.store.createFlowTransition({
        flowInstanceId: instance.flow_instance_id,
        fromStepInstanceId: step.step_instance_id,
        transitionId,
        actionJson: selectedAction as unknown as Record<string, unknown>
      });
      this.store.updateFlowInstance(instance.flow_instance_id, {
        status: "waiting_for_orchestrator",
        currentStepId: null
      });
      this.emit({
        runId: instance.run_id,
        agentId: step.agent_id,
        type: "flow.notification",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          from_step_instance_id: step.step_instance_id,
          transition_id: transitionId,
          notify: selectedAction.notify
        }
      });
      return {
        ...this.getFlowSnapshot(instance.flow_instance_id),
        reported_step: step,
        selected_transition: transitionRecord,
        active_step: null,
        notification: selectedAction.notify
      };
    }

    const blocked = this.store.updateFlowStepInstance(step.step_instance_id, {
      status: "blocked",
      summary: "No matching flow transition action.",
      completedAt: nowIso()
    });
    this.store.updateFlowInstance(instance.flow_instance_id, {
      status: "blocked",
      currentStepId: step.step_id
    });
    this.emit({
      runId: instance.run_id,
      agentId: step.agent_id,
      type: "flow.step_blocked",
      payload: {
        flow_instance_id: instance.flow_instance_id,
        step_instance_id: step.step_instance_id,
        step_id: step.step_id,
        reason: "no_matching_transition"
      }
    });
    return {
      ...this.getFlowSnapshot(instance.flow_instance_id),
      reported_step: blocked,
      selected_transition: null,
      active_step: null,
      notification: "blocked"
    };
  }

  private bindFlowOutputs(
    config: FlowConfig,
    instance: FlowInstanceRecord,
    step: FlowStepInstanceRecord,
    reportedArtifacts: Record<string, string>
  ): Record<string, string> {
    const stepConfig = config.steps[step.step_id];
    const outputBindings: Record<string, string> = {};
    for (const [outputName, ref] of Object.entries(stepConfig.outputs ?? {})) {
      const artifactConfig = config.artifacts?.[ref.artifact];
      const configuredPath = artifactConfig?.path
        ? resolveArtifactPath(artifactConfig.path, {
            runId: instance.run_id,
            runDir: runRuntimeDir(instance.run_id)
          })
        : undefined;
      const path = reportedArtifacts[outputName] ?? reportedArtifacts[ref.artifact] ?? configuredPath;
      if (!path) {
        if (ref.required) {
          throw new ControllerError("Flow step report is missing a required output artifact path.", "missing_artifact", {
            step_id: step.step_id,
            output: outputName,
            artifact: ref.artifact
          });
        }
        continue;
      }
      if (ref.required && !existsSync(path)) {
        throw new ControllerError("Flow step report required output artifact does not exist.", "missing_artifact", {
          step_id: step.step_id,
          output: outputName,
          artifact: ref.artifact,
          path
        });
      }
      const artifact = this.store.createArtifact({
        runId: instance.run_id,
        agentId: step.agent_id,
        label: ref.artifact,
        path,
        expected: false
      });
      this.store.upsertFlowArtifactBinding({
        flowInstanceId: instance.flow_instance_id,
        artifactKey: ref.artifact,
        artifactId: artifact.artifact_id,
        path,
        producedByStepInstanceId: step.step_instance_id
      });
      outputBindings[ref.artifact] = path;
    }
    return outputBindings;
  }

  private finishFlowStep(
    step: FlowStepInstanceRecord,
    status: FlowStepInstanceStatus,
    result: Record<string, unknown>,
    output: Record<string, unknown>,
    transitionId: string | null,
    summary: string | null
  ): FlowStepInstanceRecord {
    return this.store.updateFlowStepInstance(step.step_instance_id, {
      status,
      resultJson: result,
      outputJson: output,
      transitionId,
      summary,
      completedAt: nowIso()
    });
  }

  private missingRequiredInputArtifacts(
    stepConfig: { inputs?: Record<string, { artifact: string; required?: boolean }> },
    bindings: Array<{ artifact_key: string; path: string }>
  ): string[] {
    const byKey = new Map(bindings.map((binding) => [binding.artifact_key, binding.path]));
    const missing: string[] = [];
    for (const [inputName, ref] of Object.entries(stepConfig.inputs ?? {})) {
      if (!ref.required) {
        continue;
      }
      const path = byKey.get(ref.artifact);
      if (!path || !existsSync(path)) {
        missing.push(`${inputName}:${ref.artifact}`);
      }
    }
    return missing;
  }

  private getFlowOrThrow(flowRecordId: string) {
    const flow = this.store.getFlow(flowRecordId);
    if (!flow) {
      throw new ControllerError(`Flow not found: ${flowRecordId}`, "tool_error", { flow_record_id: flowRecordId });
    }
    return flow;
  }

  private getFlowInstanceOrThrow(flowInstanceId: string) {
    const instance = this.store.getFlowInstance(flowInstanceId);
    if (!instance) {
      throw new ControllerError(`Flow instance not found: ${flowInstanceId}`, "tool_error", {
        flow_instance_id: flowInstanceId
      });
    }
    return instance;
  }

  private getFlowStepInstanceOrThrow(stepInstanceId: string) {
    const step = this.store.getFlowStepInstance(stepInstanceId);
    if (!step) {
      throw new ControllerError(`Flow step instance not found: ${stepInstanceId}`, "tool_error", {
        step_instance_id: stepInstanceId
      });
    }
    return step;
  }

  private findReusableFlowInstance(
    runId: string,
    config: FlowConfig
  ): { flow: FlowRecord; instance: FlowInstanceRecord } | null {
    const reusableStatuses = new Set<FlowInstanceRecord["status"]>(["active", "waiting_for_orchestrator", "blocked"]);
    const candidates = this.store
      .listFlowInstances({ runId })
      .slice()
      .reverse();

    for (const instance of candidates) {
      if (!reusableStatuses.has(instance.status)) {
        continue;
      }
      const flow = this.store.getFlow(instance.flow_record_id);
      if (!flow) {
        continue;
      }
      if (flow.flow_id !== config.id) {
        continue;
      }
      if ((flow.version ?? null) !== (config.version ?? null)) {
        continue;
      }
      return { flow, instance };
    }

    return null;
  }

  private emit(input: {
    runId?: string | null;
    agentId?: string | null;
    type: EventType;
    payload?: Record<string, unknown>;
  }): EventRecord {
    const event = this.store.createEvent(input);
    if (!this.isDeliverySuppressed(event)) {
      const delivery = this.deliverSubscriptions(event)
        .catch(() => {
          // Delivery errors should never invalidate the source event.
        })
        .finally(() => {
          this.pendingDeliveries.delete(delivery);
        });
      this.pendingDeliveries.add(delivery);
    }
    return event;
  }

  private isDeliverySuppressed(event: EventRecord): boolean {
    return Boolean(
      (event.run_id && this.suppressedDeliveryRunIds.has(event.run_id)) ||
        (event.agent_id && this.suppressedDeliveryAgentIds.has(event.agent_id))
    );
  }

  private async deliverSubscriptions(event: EventRecord): Promise<void> {
    const subscriptions = this.store
      .listSubscriptions({ enabledOnly: true })
      .filter((subscription) => {
        const runMatches = !subscription.run_id || subscription.run_id === event.run_id;
        const sourceMatches =
          !subscription.source_agent_id || subscription.source_agent_id === event.agent_id;
        return runMatches && sourceMatches && subscription.event_type === event.type;
      });
    const deliveredSubscriberEventKeys = new Set<string>();

    for (const subscription of subscriptions) {
      const deliveryKey = `${event.event_id}:${subscription.subscriber_agent_id}`;
      if (
        deliveredSubscriberEventKeys.has(deliveryKey) ||
        subscription.last_delivered_event_id === event.event_id ||
        this.inFlightSubscriberDeliveries.has(deliveryKey)
      ) {
        continue;
      }
      const subscriber = this.store.getAgent(subscription.subscriber_agent_id);
      if (!subscriber || subscriber.unregistered_at) {
        continue;
      }
      if (!this.store.tryClaimSubscriptionDelivery(subscription.subscription_id, event.event_id)) {
        continue;
      }

      this.inFlightSubscriberDeliveries.add(deliveryKey);
      try {
        const adapter = this.adapters.get(subscriber.backend);
        await adapter.sendMessage(this.requireHandle(subscriber), {
          message: withCodexNativeVisibilityReminder(
            compactEventMessage(
              event,
              subscriber,
              event.agent_id ? this.store.getAgent(event.agent_id) : null
            ),
            subscriber
          )
        });
        const updatedSubscriber = this.store.updateAgent(subscriber.agent_id, {
          status: "running",
          failureReason: null
        });
        this.store.touchHeartbeat(subscriber.agent_id);
        this.armStatusWatcher(updatedSubscriber);
        for (const deliveredSubscription of subscriptions) {
          if (deliveredSubscription.subscriber_agent_id === subscriber.agent_id) {
            this.store.updateSubscriptionDelivery(deliveredSubscription.subscription_id, event.event_id);
          }
        }
        deliveredSubscriberEventKeys.add(deliveryKey);
      } catch (error) {
        this.store.createEvent({
          runId: event.run_id,
          agentId: subscriber.agent_id,
          type: "agent.delivery_failed",
          payload: {
            source_event_id: event.event_id,
            subscription_id: subscription.subscription_id,
            subscriber_agent_id: subscriber.agent_id,
            subscriber_backend: subscriber.backend,
            reason: error instanceof Error ? error.message : String(error)
          }
        });
        this.store.clearSubscriptionDeliveryClaim(subscription.subscription_id, event.event_id);
      } finally {
        this.inFlightSubscriberDeliveries.delete(deliveryKey);
      }
    }
  }

  private requireHandle(agent: AgentRecord): AgentHandle {
    const backendHandle = agent.backend_handle ?? this.recoverBackendHandle(agent);
    if (!backendHandle) {
      throw new ControllerError("Agent has no backend handle.", "tool_error", {
        agent_id: agent.agent_id,
        backend: agent.backend
      });
    }
    if (!agent.backend_handle) {
      this.store.updateAgent(agent.agent_id, { backendHandle });
    }
    return {
      backend: agent.backend,
      id: String(backendHandle.id ?? agent.agent_id),
      data: backendHandle
    };
  }

  private recoverBackendHandle(agent: AgentRecord): Record<string, unknown> | null {
    if (agent.backend !== "opencode-server") {
      return null;
    }

    const runtimePath = agentRuntimePath(agent.run_id, agent.agent_id);
    const metadataFile = join(runtimePath, "opencode-launch.json");
    const pidFile = join(runtimePath, "opencode.pid");
    const logFile = join(runtimePath, "opencode.log");
    const exitFile = join(runtimePath, "opencode-exit.json");
    const expectedArtifacts = this.store
      .listArtifacts({ agentId: agent.agent_id })
      .filter((artifact) => artifact.expected)
      .map((artifact) => artifact.path);

    const metadata = readJsonObject(metadataFile);
    if (metadata) {
      return {
        ...metadata,
        id: metadata.id ?? agent.agent_id,
        server: metadata.server ?? defaultOpenCodeServer(),
        model: metadata.model ?? agent.model ?? DEFAULT_OPENCODE_MODEL,
        title: metadata.title ?? agent.title,
        repoDir: metadata.repoDir ?? agent.repo_dir ?? "",
        pidFile: metadata.pidFile ?? pidFile,
        logFile: metadata.logFile ?? logFile,
        exitFile: metadata.exitFile ?? exitFile,
        metadataFile,
        expectedArtifacts:
          Array.isArray(metadata.expectedArtifacts) && metadata.expectedArtifacts.every((item) => typeof item === "string")
            ? metadata.expectedArtifacts
            : expectedArtifacts
      };
    }

    if (!existsSync(pidFile) && !existsSync(logFile)) {
      return null;
    }

    return {
      id: agent.agent_id,
      server: defaultOpenCodeServer(),
      model: agent.model ?? DEFAULT_OPENCODE_MODEL,
      title: agent.title,
      repoDir: agent.repo_dir ?? "",
      pidFile,
      logFile,
      exitFile,
      metadataFile,
      expectedArtifacts
    };
  }

  private async stopAgentForPurge(agentId: string): Promise<AgentRecord> {
    let stopped = await this.stopAgent(agentId, "interrupt");
    if (isUnsafeToPurge(stopped)) {
      stopped = await this.stopAgent(agentId, "kill");
    }
    return stopped;
  }

  private armStatusWatcher(agent: AgentRecord): void {
    this.disarmStatusWatcher(agent.agent_id);
    const adapter = this.adapters.get(agent.backend);
    if (!adapter.watchStatus || !agent.backend_handle) {
      if (agent.status === "running" && agent.backend_handle) {
        const timers = [3000, 10000, 30000].map((delayMs) =>
          setTimeout(() => {
            void this.refreshAgentStatus(agent.agent_id);
          }, delayMs)
        );
        this.statusWatchers.set(agent.agent_id, () => {
          for (const timer of timers) {
            clearTimeout(timer);
          }
        });
      }
      return;
    }
    const unwatch = adapter.watchStatus(this.requireHandle(agent), () => {
      void this.refreshAgentStatus(agent.agent_id);
    });
    this.statusWatchers.set(agent.agent_id, unwatch);
  }

  private disarmStatusWatcher(agentId: string): void {
    const unwatch = this.statusWatchers.get(agentId);
    if (unwatch) {
      unwatch();
      this.statusWatchers.delete(agentId);
    }
  }

  private statusEventType(status: AgentStatus): EventType {
    if (status === "completed") {
      return "agent.completed";
    }
    if (status === "failed") {
      return "agent.failed";
    }
    if (status === "blocked") {
      return "agent.blocked";
    }
    if (status === "stopped") {
      return "agent.stopped";
    }
    return "agent.status_changed";
  }

  private activeDescendants(agentId: string): AgentRecord[] {
    const root = this.getAgent(agentId);
    const links = this.store
      .listAgentLinks({ runId: root.run_id })
      .filter((link) => link.type === "parent_child");
    const childrenByParent = new Map<string, string[]>();
    for (const link of links) {
      const children = childrenByParent.get(link.source_agent_id) ?? [];
      children.push(link.target_agent_id);
      childrenByParent.set(link.source_agent_id, children);
    }

    const descendants = new Set<string>();
    const queue = [...(childrenByParent.get(agentId) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || descendants.has(next)) {
        continue;
      }
      descendants.add(next);
      queue.push(...(childrenByParent.get(next) ?? []));
    }

    return [...descendants]
      .map((id) => this.store.getAgent(id))
      .filter((agent): agent is AgentRecord => Boolean(agent))
      .filter((agent) => !agent.unregistered_at && !TERMINAL_STATUSES.has(agent.status));
  }
}

export function buildGoalConfirmationPrompt(objective: string): string {
  return `You have an active goal: ${objective}

Reply compactly:
- complete: the goal is done
- continue: useful work remains and you can proceed
- blocked: no useful progress is possible

If blocked, say whether another route, backend, retry, or narrower task could work.`;
}

function elapsedSince(iso: string): number {
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) {
    return 0;
  }
  return Math.max(0, Date.now() - started);
}

function compactEventMessage(event: EventRecord, subscriber: AgentRecord, source: AgentRecord | null): string {
  const status = payloadString(event.payload, "status");
  const message = payloadString(event.payload, "message");
  const failureReason = payloadString(event.payload, "failure_reason") ?? payloadString(event.payload, "reason");
  const data = payloadRecord(event.payload, "data");
  const metadata = payloadRecord(data, "metadata") ?? payloadRecord(source?.backend_handle ?? undefined, "metadata");
  const flowInstanceId =
    payloadString(event.payload, "flow_instance_id") ?? payloadString(metadata, "flow_instance_id");
  const stepInstanceId =
    payloadString(event.payload, "step_instance_id") ?? payloadString(metadata, "step_instance_id");
  const stepId = payloadString(event.payload, "step_id") ?? payloadString(metadata, "step_id");
  const transitionId = payloadString(event.payload, "transition_id");
  const targetStepId = payloadString(event.payload, "target_step_id");
  const notify = payloadString(event.payload, "notify");
  const logFile = payloadString(data, "logFile");
  const serverAvailable = payloadScalar(data, "serverAvailable");
  const pidRunning = payloadScalar(data, "pidRunning");

  const lines = [
    "Agent Control notification",
    "",
    `Event: ${event.type}`,
    `Event ID: ${event.event_id}`,
    `Run: ${event.run_id ?? "none"}`,
    `Source agent: ${formatAgentReference(source, event.agent_id)}`,
    `Subscriber: ${formatAgentReference(subscriber, subscriber.agent_id)}`,
    `Created at: ${event.created_at}`
  ];

  if (status) {
    lines.push(`Status: ${status}`);
  }
  if (message) {
    lines.push(`Message: ${message}`);
  }
  if (failureReason) {
    lines.push(`Failure reason: ${failureReason}`);
  }
  if (flowInstanceId) {
    lines.push(`Flow instance: ${flowInstanceId}`);
  }
  if (stepInstanceId) {
    lines.push(`Step instance: ${stepInstanceId}`);
  }
  if (stepId) {
    lines.push(`Step: ${stepId}`);
  }
  if (transitionId) {
    lines.push(`Transition: ${transitionId}`);
  }
  if (targetStepId) {
    lines.push(`Target step: ${targetStepId}`);
  }
  if (notify) {
    lines.push(`Notify: ${notify}`);
  }
  if (typeof pidRunning !== "undefined") {
    lines.push(`Process running: ${String(pidRunning)}`);
  }
  if (typeof serverAvailable !== "undefined") {
    lines.push(`Backend server available: ${String(serverAvailable)}`);
  }
  if (logFile) {
    lines.push(`Log file: ${logFile}`);
  }

  lines.push("");
  lines.push("Routing instruction:");
  if (subscriber.objective) {
    lines.push(subscriber.objective);
  } else {
    lines.push("Handle this event according to this subscriber's registered role.");
  }
  lines.push("");
  lines.push(
    "Use the event fields above for routing. Keep the response compact and avoid reading full transcripts unless needed."
  );
  if (flowInstanceId) {
    lines.push("For this existing flow, do not call `flow_start` again.");
    lines.push(
      "This notification is the complete instruction for this short re-entry; do not reload skills, docs, flow configs, prompt files, logs, or artifacts unless you need them to resolve the blocker or user-feedback request."
    );
    if (event.type === "flow.notification") {
      lines.push(
        "This is a configured flow notification. Give the user the requested compact feedback or make the explicit manual routing decision requested by the flow."
      );
    } else if (event.type === "flow.step_blocked" || event.type === "agent.delivery_failed") {
      lines.push(
        "This is a blocker. Inspect only the minimum required state, decide whether to retry, route manually, or tell the user what is blocked."
      );
    } else if (event.type === "flow.completed") {
      lines.push("The flow has completed. Give a compact final user-facing update if this thread owns user feedback.");
    } else {
      lines.push(
        "Normal flow advancement is handled by Agent Control. Do not dispatch another step from this notification unless a prior tool result explicitly asks you to."
      );
    }
  }

  return lines.join("\n");
}

function controllerEventMessages(agent: AgentRecord, agents: AgentRecord[], events: EventRecord[]): AgentMessage[] {
  const agentById = new Map(agents.map((item) => [item.agent_id, item]));
  const visibleEvents =
    agent.role === "orchestrator"
      ? events
      : events.filter((event) => !event.agent_id || event.agent_id === agent.agent_id);
  const messages = visibleEvents
    .slice()
    .reverse()
    .map((event): AgentMessage => {
      const source = event.agent_id ? agentById.get(event.agent_id) ?? null : null;
      const status = payloadString(event.payload, "status");
      const message = payloadString(event.payload, "message");
      const reason = payloadString(event.payload, "reason") ?? payloadString(event.payload, "failure_reason");
      const lines = [
        `Controller event: ${event.type}`,
        `Source: ${formatAgentReference(source, event.agent_id)}`,
        `Created at: ${event.created_at}`
      ];
      if (status) {
        lines.push(`Status: ${status}`);
      }
      if (message) {
        lines.push(`Message: ${message}`);
      }
      if (reason) {
        lines.push(`Reason: ${reason}`);
      }
      return {
        id: event.event_id,
        role: event.agent_id === agent.agent_id ? "assistant" : "system",
        text: lines.join("\n"),
        created_at: event.created_at,
        metadata: {
          source: "controller-event-history",
          eventType: event.type,
          eventId: event.event_id,
          payload: event.payload
        }
      };
    });

  if (agent.backend === "codex-thread") {
    messages.unshift({
      id: `missing-handle-${agent.agent_id}`,
      role: "system",
      text:
        "This Codex agent is registered without a backend thread handle, so Agent Control cannot read the Codex app transcript directly. Showing controller event history for this run instead.",
      created_at: agent.created_at,
      metadata: { source: "controller-event-history", reason: "missing-backend-handle" }
    });
  }

  return messages;
}

function withCodexNativeVisibilityReminder(message: string, recipient: AgentRecord): string {
  if (recipient.backend !== "codex-thread") {
    return message;
  }
  const threadId =
    typeof recipient.backend_handle?.thread_id === "string"
      ? recipient.backend_handle.thread_id
      : typeof recipient.backend_handle?.threadId === "string"
        ? recipient.backend_handle.threadId
        : null;
  const target = threadId ? ` Target Codex thread: ${threadId}.` : "";
  return `${message}

Codex Desktop visibility note:${target} This wakeup was delivered through Agent Control using Codex app-server, which is durable but may not live-refresh an already-open Codex Desktop thread. If you are the target Codex thread, start with a short human-readable assistant update, then continue from the event fields above. Do not try to force-refresh this same active turn with native thread tools; native Desktop relays must run from an already-active separate Codex session.`;
}

function formatAgentReference(agent: AgentRecord | null, fallbackId: string | null): string {
  if (!agent) {
    return fallbackId ?? "none";
  }
  const role = agent.role ? `, role: ${agent.role}` : "";
  return `${agent.title} (${agent.agent_id}${role})`;
}

function payloadRecord(payload: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = payload?.[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function payloadString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordString(payload: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function payloadScalar(payload: Record<string, unknown> | undefined, key: string): string | number | boolean | undefined {
  const value = payload?.[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function artifactSummary(artifact: ArtifactRecord): Record<string, unknown> {
  return {
    artifact_id: artifact.artifact_id,
    label: artifact.label,
    path: artifact.path,
    expected: artifact.expected
  };
}

function emptyStatusCounts(): Record<AgentStatus, number> {
  return Object.fromEntries(AGENT_STATUSES.map((status) => [status, 0])) as Record<AgentStatus, number>;
}

function assignFlowStepWorkerAgent(inputJson: Record<string, unknown>, agentId: string): Record<string, unknown> {
  const runtimeContract =
    inputJson.runtime_contract && typeof inputJson.runtime_contract === "object" && !Array.isArray(inputJson.runtime_contract)
      ? (inputJson.runtime_contract as Record<string, unknown>)
      : null;
  if (!runtimeContract) {
    return inputJson;
  }

  const worker =
    runtimeContract.worker && typeof runtimeContract.worker === "object" && !Array.isArray(runtimeContract.worker)
      ? (runtimeContract.worker as Record<string, unknown>)
      : {};
  const markdown =
    typeof runtimeContract.markdown === "string"
      ? runtimeContract.markdown.replace(/^- Worker agent: .*$/m, `- Worker agent: \`${agentId}\``)
      : runtimeContract.markdown;

  return {
    ...inputJson,
    runtime_contract: {
      ...runtimeContract,
      worker: {
        ...worker,
        agent_id: agentId
      },
      markdown
    }
  };
}

function buildFlowRuntimeMarkdown(input: {
  flowId: string;
  flowInstanceId: string;
  stepId: string;
  workerAgentId: string | null;
  role: string | null;
  backend: string | null;
  model: string | null;
  run: RunRecord;
  inputArtifacts: Record<string, Record<string, unknown>>;
  outputArtifacts: Record<string, Record<string, unknown>>;
}): string {
  return [
    "## Runtime Contract",
    "",
    "Use these runtime values as the source of truth for this step. Do not invent artifact names, paths, or extra handoff files.",
    "",
    `- Flow: \`${input.flowId}\``,
    `- Flow instance: \`${input.flowInstanceId}\``,
    `- Step: \`${input.stepId}\``,
    `- Worker agent: ${input.workerAgentId ? `\`${input.workerAgentId}\`` : "assigned at dispatch time"}`,
    `- Role: ${input.role ? `\`${input.role}\`` : "not specified"}`,
    `- Backend: ${input.backend ? `\`${input.backend}\`` : "not specified"}`,
    `- Model: ${input.model ? `\`${input.model}\`` : "not specified"}`,
    `- Run: \`${input.run.run_id}\``,
    `- Objective/title: ${input.run.title}`,
    `- Repository: ${input.run.repo_dir ? `\`${input.run.repo_dir}\`` : "not specified"}`,
    "",
    "Input artifacts:",
    "",
    artifactMarkdownLines(input.inputArtifacts, "No input artifacts for this step."),
    "",
    "Output artifacts:",
    "",
    artifactMarkdownLines(input.outputArtifacts, "No output artifacts for this step."),
    "",
    "Rules:",
    "",
    "- Read only the input artifacts that are present and relevant to this step.",
    "- Write every required output artifact to the assigned path before reporting.",
    "- If an optional input artifact is absent, continue without it unless the step prompt says it is semantically required.",
    "- Do not put runtime paths or artifact lists into long-term prompts; this contract is the active-step source of truth."
  ].join("\n");
}

function artifactMarkdownLines(
  artifacts: Record<string, Record<string, unknown>>,
  emptyText: string
): string {
  const entries = Object.entries(artifacts);
  if (entries.length === 0) {
    return `- ${emptyText}`;
  }
  return entries
    .map(([name, artifact]) => {
      const path = typeof artifact.path === "string" ? `\`${artifact.path}\`` : "not available";
      const required = artifact.required === true ? "required" : "optional";
      const description = typeof artifact.description === "string" ? ` - ${artifact.description}` : "";
      return `- \`${name}\` (${required}): ${path}${description}`;
    })
    .join("\n");
}

function exampleFromResultSchema(
  schema: { required?: string[]; properties?: Record<string, { enum?: unknown[] }> } | undefined
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(schema?.properties ?? {}), ...(schema?.required ?? [])]);
  for (const key of keys) {
    const allowed = schema?.properties?.[key]?.enum;
    result[key] = allowed && allowed.length > 0 ? allowed[0] : `<${key}>`;
  }
  return result;
}

function exampleArtifactReport(
  outputArtifacts: Record<string, Record<string, unknown>>
): Record<string, string> {
  const artifacts: Record<string, string> = {};
  for (const [outputName, descriptor] of Object.entries(outputArtifacts)) {
    artifacts[outputName] =
      typeof descriptor.path === "string" && descriptor.path.length > 0
        ? descriptor.path
        : `<absolute path for ${outputName}>`;
  }
  return artifacts;
}

function buildFlowReportCliCommand(
  stepInstanceId: string,
  result: Record<string, unknown>,
  artifacts: Record<string, string>,
  summary: unknown
): string {
  const parts = [
    agentctlExecutable(),
    "flow",
    "report",
    "--step",
    shellQuote(stepInstanceId),
    "--status",
    "completed",
    "--result-json",
    shellQuote(JSON.stringify(result))
  ];
  for (const [key, path] of Object.entries(artifacts)) {
    parts.push("--artifact", shellQuote(`${key}=${path}`));
  }
  if (typeof summary === "string" && summary.length > 0) {
    parts.push("--summary", shellQuote(summary));
  }
  // Worker chat surfaces capture command stdout. `flow report` normally prints
  // a complete flow snapshot, which is helpful in a terminal but far too noisy
  // inside an agent transcript. Keep stderr visible so failures still surface.
  return `${parts.join(" ")} >/dev/null`;
}

function readMarkdownContract(value: unknown, label: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const markdown = (value as Record<string, unknown>).markdown;
  return typeof markdown === "string" && markdown.trim().length > 0 ? section(label, markdown) : null;
}

function expectedArtifactsFromStep(step: FlowStepInstanceRecord): string[] {
  const outputArtifacts = step.input_json.output_artifacts;
  if (!outputArtifacts || typeof outputArtifacts !== "object" || Array.isArray(outputArtifacts)) {
    return [];
  }
  return Object.values(outputArtifacts)
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const path = (entry as Record<string, unknown>).path;
      return typeof path === "string" ? path : null;
    })
    .filter((path): path is string => Boolean(path));
}

function declaredFlowAgentTitle(flowId: string, role: string): string {
  return `${flowId}: ${role}`;
}

function flowActionTargets(
  action: FlowStepActionConfig,
  fallbackLabel: string
): Array<{ kind: "notify" | "step"; id: string; label: string }> {
  const targets: Array<{ kind: "notify" | "step"; id: string; label: string }> = [];
  if (action.to) {
    targets.push({ kind: "step", id: action.to, label: fallbackLabel });
  }
  if (action.notify) {
    targets.push({ kind: "notify", id: action.notify, label: fallbackLabel });
  }
  for (const transition of action.transitions ?? []) {
    targets.push(...flowActionTargets(transition, transition.id));
  }
  return targets;
}

function section(title: string, body: string): string {
  return `# ${title}\n\n${body.trim()}`;
}

function agentctlExecutable(): string {
  const configured = process.env.AGENT_CONTROL_AGENTCTL_BIN;
  if (configured && configured.length > 0) {
    return configured;
  }

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const bundled = resolve(packageRoot, "bin/agentctl");
  return existsSync(bundled) ? bundled : "agentctl";
}

function buildFlowReportingMarkdown(input: {
  toolName: string;
  mcpInput: Record<string, unknown>;
  cliCommand: string;
  resultSchema: unknown;
  outputArtifacts: Record<string, Record<string, unknown>>;
}): string {
  return [
    "## Agent Control Reporting Contract",
    "",
    `When this step is complete, report the result through Agent Control. Prefer the MCP tool \`${input.toolName}\` when available. If MCP tools are unavailable, use the CLI command shown below exactly as rendered.`,
    "",
    "Do not invent routing labels. The allowed structured result is defined by this schema:",
    "",
    "```json",
    JSON.stringify(input.resultSchema, null, 2),
    "```",
    "",
    "Expected output artifacts:",
    "",
    "```json",
    JSON.stringify(input.outputArtifacts, null, 2),
    "```",
    "",
    "MCP tool input example:",
    "",
    "```json",
    JSON.stringify(input.mcpInput, null, 2),
    "```",
    "",
    "CLI fallback example:",
    "",
    "```bash",
    input.cliCommand,
    "```",
    "",
    "Use `status: \"completed\"` when the required artifact was written, including conclusions that route to blockers or corrections. Use a non-completed status only when you could not write the required artifact or could not produce a valid report.",
    "After reporting, stop. Agent Control may dispatch the next configured step automatically; do not manually route or start another worker from inside this step."
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function latestUsageSnapshotsByAgent(snapshots: UsageSnapshotRecord[]): Map<string, UsageSnapshotRecord> {
  const latest = new Map<string, UsageSnapshotRecord>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.agent_id);
    if (!current || Date.parse(snapshot.captured_at) > Date.parse(current.captured_at)) {
      latest.set(snapshot.agent_id, snapshot);
    }
  }
  return latest;
}

function usageTotals(snapshots: UsageSnapshotRecord[]): DashboardSnapshot["usage_totals"] {
  return {
    input_tokens: nullableSum(snapshots.map((snapshot) => snapshot.input_tokens)),
    output_tokens: nullableSum(snapshots.map((snapshot) => snapshot.output_tokens)),
    total_tokens: nullableSum(snapshots.map((snapshot) => snapshot.total_tokens)),
    context_used: nullableSum(snapshots.map((snapshot) => snapshot.context_used)),
    context_limit: nullableSum(snapshots.map((snapshot) => snapshot.context_limit))
  };
}

function nullableSum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function defaultOpenCodeServer(): string {
  return process.env.DEVFLOW_OPENCODE_SERVER ?? process.env.OPENCODE_SERVER ?? DEFAULT_OPENCODE_SERVER;
}

function normalizePurgeOptions(options: Partial<PurgeOptions>): PurgeOptions {
  return {
    dryRun: options.dryRun ?? false,
    stopFirst: options.stopFirst ?? false,
    force: options.force ?? false,
    deleteRuntimeFiles: options.deleteRuntimeFiles ?? true
  };
}

function isUnsafeToPurge(agent: AgentRecord): boolean {
  return !agent.unregistered_at && !PURGE_SAFE_STATUSES.has(agent.status);
}

function createPurgeResult(dryRun: boolean): PurgeResult {
  return {
    dry_run: dryRun,
    purged_runs: [],
    purged_agents: [],
    deleted_rows: {},
    deleted_runtime_paths: [],
    skipped_runtime_paths: []
  };
}

function mergePurgeResult(target: PurgeResult, source: PurgeResult): void {
  target.purged_runs.push(...source.purged_runs);
  target.purged_agents.push(...source.purged_agents);
  target.deleted_runtime_paths.push(...source.deleted_runtime_paths);
  target.skipped_runtime_paths.push(...source.skipped_runtime_paths);
  target.deleted_rows = mergeRowCounts(target.deleted_rows, source.deleted_rows);
}

function mergeRowCounts(
  left: Record<string, number>,
  right: Record<string, number>
): Record<string, number> {
  const merged = { ...left };
  for (const [table, count] of Object.entries(right)) {
    merged[table] = (merged[table] ?? 0) + count;
  }
  return merged;
}

function planRuntimeDelete(result: PurgeResult, path: string, dryRun: boolean): void {
  if (!isInsideRunsRuntimeRoot(path)) {
    result.skipped_runtime_paths.push(`${path} :: outside controller runtime root`);
    return;
  }
  if (!existsSync(path)) {
    return;
  }
  if (dryRun) {
    result.deleted_runtime_paths.push(path);
  }
}

function deleteRuntimePath(result: PurgeResult, path: string): void {
  if (!isInsideRunsRuntimeRoot(path)) {
    result.skipped_runtime_paths.push(`${path} :: outside controller runtime root`);
    return;
  }
  if (!existsSync(path)) {
    return;
  }
  try {
    rmSync(path, { recursive: true, force: true });
    result.deleted_runtime_paths.push(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.skipped_runtime_paths.push(`${path} :: ${message}`);
  }
}
