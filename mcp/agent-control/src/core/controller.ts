import { CodexSessionAdapter } from "../adapters/codex-session.js";
import { FlowPackages, flowPackagesRequestSchema, type FlowPackagesRequest, type FlowPackagesToolRequest, type PackageGroup, type PackageContext } from "./flow-packages.js";
import { FlowRuntime, artifactDigest, digest, pinFlowConfig } from "./flow-runtime.js";
import { EvidenceService, type EvidenceRequest, type EvidenceReceiptKind } from "./evidence/service.js";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControllerError, errorToPayload } from "./errors.js";
import { currentCodexThreadId } from "./caller-context.js";
import { RunObservation, isPassiveObserver, type ObserveRunInput, type WaitRunInput, type AcknowledgeRunInput, type RequesterInput } from "./run-observation.js";
import { parseActivity, activityText, type AgentActivity } from "./agent-activity.js";
import {
  evaluateCondition,
  parseFlowConfig,
  resolveFlowAgentLifecycle,
  resolveArtifactPath,
  resolveInputArtifacts,
  resolveStepPromptSources,
  resolveStepEventAction,
  selectTransition,
  validateStepResult
} from "./flow.js";
import { getFlowFromCatalog, listFlowCatalog, type FlowCatalogGetResult, type FlowCatalogListResult } from "./flow-catalog.js";
import {
  generateActionToken,
  generateAgentToken,
  generateBridgeToken,
  hashToken,
  verifyAdminKey,
  resolveAdminKey
} from "./identity.js";
import { isBridgeGrantId, isOrchestratorActionId, newId, nowIso } from "./ids.js";
import type { LocalCredentialStore } from "./local-credential-store.js";
import { agentRuntimePath, isInsideRunsRuntimeRoot, runRuntimeDir, runRuntimePath } from "./paths.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type {
  AgentAdapter,
  AgentHandle,
  AgentLinkRecord,
  AgentLinkType,
  AgentMessage,
  AgentRecord,
  AgentStartAttemptRecord,
  AgentStartState,
  AgentStopResult,
  AgentStatus,
  AgentStartResult,
  AgentSendResult,
  AgentWithToken,
  AgentOperationResult,
  AgentStatusSnapshot,
  ArtifactRecord,
  BridgeCredential,
  BridgeGrantRecord,
  CodexSubagentForkTurns,
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
  FlowStepCleanupResult,
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
  OrchestratorActionAcknowledgementResult,
  OrchestratorActionClaimResult,
  OrchestratorActionOperation,
  OrchestratorActionRecord,
  OrchestratorActionRef,
  PublicBridgeGrantRef,
  PurgeOptions,
  PurgeResult,
  RunRecord,
  RunShutdownResult,
  SubscriptionRecord,
  StopResult,
  UsageSnapshotRecord
} from "./types.js";
import { AGENT_STATUSES, EVENT_TYPES } from "./types.js";

const TERMINAL_STATUSES = new Set<AgentStatus>(["completed", "failed", "blocked", "stopped"]);
const PURGE_SAFE_STATUSES = new Set<AgentStatus>(["planned", "completed", "failed", "blocked", "stopped"]);
const STOP_INTENT_AGENT_STATUSES = new Set<AgentStatus>(["stopping", "stopped"]);
const STOP_INTENT_RUN_STATUSES = new Set(["stopping", "stopped"]);
const DEFAULT_OPENCODE_SERVER = "http://localhost:53910";
const CODEX_SUBAGENT_BACKEND = "codex-subagent";
const ORCHESTRATOR_ACTION_CLAIM_LEASE_MS = 60_000;
const NON_NATIVE_START_ATTEMPT_LEASE_MS = 60_000;
const ACCEPTED_WORK_LEASE_MS = 60_000;
const ACCEPTED_WORK_LEASE_RENEW_INTERVAL_MS = 20_000;
const EXTERNAL_MISSING_CONFIRMATION_MS = 5_000;
const MAX_EXTERNAL_LATEST_MESSAGE_BYTES = 4 * 1024;
const DEFAULT_NATIVE_ACTION_DELIVERY_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;
const MAX_NATIVE_ACTION_DELIVERY_RETRIES = 5;
const DEFAULT_CODEX_THREAD_DELIVERY_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 120_000] as const;
const MAX_CODEX_THREAD_DELIVERY_RETRIES = 5;
const SUBSCRIPTION_WAIT_DELIVERY_TIMEOUT_MS = 5_000;

interface ControllerEventInput {
  eventId?: string;
  runId?: string | null;
  agentId?: string | null;
  type: EventType;
  payload?: Record<string, unknown>;
}

interface AgentControllerOptions {
  /** Override the bounded native-owner retry backoff, primarily for deterministic tests. */
  nativeActionDeliveryRetryDelaysMs?: readonly number[];
  /** Override terminal notification retries for Codex thread subscribers. */
  codexThreadDeliveryRetryDelaysMs?: readonly number[];
}

export class AgentController {
  private readonly controllerInstanceId = newId("controller");
  private readonly observations: RunObservation;
  private readonly flowRuntime: FlowRuntime;
  private disposing = false;
  private disposeTask: Promise<void> | null = null;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly backgroundAbort = new AbortController();
  private readonly statusWatchers = new Map<string, () => void>();
  private readonly pendingDeliveries = new Set<Promise<void>>();
  private readonly inFlightSubscriberDeliveries = new Set<string>();
  private readonly nativeActionDeliveryRetryTasks = new Map<string, Promise<void>>();
  private readonly codexThreadDeliveryRetryTasks = new Map<string, Promise<void>>();
  private readonly suppressedDeliveryRunIds = new Set<string>();
  private readonly suppressedDeliveryAgentIds = new Set<string>();
  private readonly nativeActionDeliveryRetryDelaysMs: readonly number[];
  private readonly codexThreadDeliveryRetryDelaysMs: readonly number[];

  constructor(
    private readonly store: SqliteStore,
    private readonly adapters: AdapterRegistry,
    private readonly credentialStore: LocalCredentialStore | null = null,
    options: AgentControllerOptions = {}
  ) {
    this.observations = new RunObservation(store, this, adapters);
    this.flowRuntime = new FlowRuntime(store);
    const configuredDelays =
      options.nativeActionDeliveryRetryDelaysMs ??
      DEFAULT_NATIVE_ACTION_DELIVERY_RETRY_DELAYS_MS;
    this.nativeActionDeliveryRetryDelaysMs = configuredDelays
      .slice(0, MAX_NATIVE_ACTION_DELIVERY_RETRIES)
      .map((delay) => {
        if (!Number.isFinite(delay) || delay < 0) {
          throw new Error("Native action delivery retry delays must be finite non-negative numbers.");
        }
        return delay;
      });
    const configuredCodexThreadDelays =
      options.codexThreadDeliveryRetryDelaysMs ?? DEFAULT_CODEX_THREAD_DELIVERY_RETRY_DELAYS_MS;
    this.codexThreadDeliveryRetryDelaysMs = configuredCodexThreadDelays
      .slice(0, MAX_CODEX_THREAD_DELIVERY_RETRIES)
      .map((delay) => {
        if (!Number.isFinite(delay) || delay < 0) {
          throw new Error("Codex thread delivery retry delays must be finite non-negative numbers.");
        }
        return delay;
      });
    // A process may die after persisting an adapter invocation boundary but
    // before recording its response. Expired owners become ambiguity once at
    // startup; linked deliveries are released from process ownership without
    // becoming retryable, so recovery never duplicates possibly accepted I/O.
    const recoveredAcceptedWorkAgents = this.store.recoverExpiredAgentAcceptedWork();
    const startupCleanupAgentIds = new Set(
      this.reconcilePersistedStartAttemptHandlesAtStartup()
    );
    // Manual flow routing and shutdown persist `stopping` before external I/O.
    // Re-drive every such worker on startup so a crash between the durable
    // transition and adapter/native cleanup cannot strand an abandoned worker.
    for (const agent of this.store.listAgents({ includeUnregistered: true })) {
      if (agent.status === "stopping") {
        startupCleanupAgentIds.add(agent.agent_id);
      }
    }
    for (const event of this.reconcileTerminalStoppingRunsAtStartup()) {
      this.scheduleEventDelivery(event);
    }
    for (const agentId of startupCleanupAgentIds) {
      this.scheduleAgentStopCleanup(agentId);
    }
    for (const agent of recoveredAcceptedWorkAgents) {
      if (agent.status !== "unknown" || !agent.backend_handle) {
        continue;
      }
      try {
        if (this.adapters.get(agent.backend).capabilities().canInspectStatusCheaply) {
          this.armStatusWatcher(agent);
        }
      } catch {
        // Missing/temporarily unavailable adapters must not prevent startup.
        // The durable unknown state remains visible for an explicit refresh.
      }
    }
    for (const agent of this.store.listAgents()) {
      if (agent.backend === "codex-session" && !agent.unregistered_at && agent.backend_handle) this.armStatusWatcher(agent);
    }
    this.redrivePendingNativeActionOwnerWakeups();
  }

  /**
   * A completed attempt is durable proof that its backend returned a handle.
   * Restore that handle before any stop/shutdown logic can mistake a restarted
   * controller for a safe no-session state. Superseded attempts always require
   * compensation unless the agent is already terminal; this pass performs no
   * external I/O and leaves that work to the normal stop path.
   */
  private reconcilePersistedStartAttemptHandlesAtStartup(): string[] {
    return this.store.immediateTransaction(() => {
      const cleanupAgentIds = new Set<string>();
      for (const listedAgent of this.store.listAgents({ includeUnregistered: true })) {
        const attempt = this.store.getLatestCompletedAgentStartAttemptWithHandle(
          listedAgent.agent_id
        );
        if (!attempt?.handle_json) {
          continue;
        }
        const agent = listedAgent;
        const run = this.store.getRun(agent.run_id);
        if (!run) {
          continue;
        }
        const stopIntent =
          agent.status === "stopping" ||
          agent.status === "stopped" ||
          run.status === "stopping" ||
          run.status === "stopped";
        const supersededRoute = attempt.phase === "superseded";
        const cleanupIntent = stopIntent || supersededRoute;
        if (agent.backend_handle) {
          if (
            agent.status === "stopping" ||
            (run.status === "stopping" && !TERMINAL_STATUSES.has(agent.status)) ||
            (supersededRoute && !TERMINAL_STATUSES.has(agent.status))
          ) {
            if (run.status === "stopped") {
              this.store.updateRunStatus(run.run_id, "stopping");
            }
            if (agent.status !== "stopping") {
              this.store.updateAgent(agent.agent_id, {
                status: "stopping",
                failureReason: agent.failure_reason
              });
            }
            cleanupAgentIds.add(agent.agent_id);
          }
          continue;
        }
        if (run.status === "stopped") {
          this.store.updateRunStatus(run.run_id, "stopping");
        }
        this.store.updateAgent(agent.agent_id, {
          backendHandle: attempt.handle_json,
          status: cleanupIntent ? "stopping" : agent.status,
          failureReason: agent.failure_reason
        });
        if (cleanupIntent) {
          cleanupAgentIds.add(agent.agent_id);
        }
      }
      return [...cleanupAgentIds];
    });
  }

  /** Track fire-and-reconcile cleanup so tests and orderly shutdown can drain it. */
  private scheduleAgentStopCleanup(agentId: string): void {
    const cleanup = this.stopAgent(agentId)
      .then(() => undefined)
      .catch(() => {
        // stopAgent durably preserves unresolved cleanup state. Startup and a
        // manual route must not roll back because external stop I/O failed.
      })
      .finally(() => {
        this.pendingDeliveries.delete(cleanup);
      });
    this.pendingDeliveries.add(cleanup);
  }

  /**
   * Repair the legacy crash window where the last agent stop committed but the
   * run-level projection did not. A write reservation makes the all-terminal
   * predicate and run update one decision; any live agent keeps the run in
   * `stopping` for normal cleanup instead of being papered over at startup.
   */
  private reconcileTerminalStoppingRunsAtStartup(): EventRecord[] {
    const pendingEvents: EventRecord[] = [];
    this.store.immediateTransaction(() => {
      for (const run of this.store.listRunsByStatus("stopping")) {
        this.finalizeStoppingRunIfTerminal(run.run_id, (event) => {
          pendingEvents.push(this.store.createEvent(event));
        });
      }
    });
    return pendingEvents;
  }

  observeRun(input: ObserveRunInput) {
    return this.observations.observe(input);
  }

  ensureRequester(runId: string, input: RequesterInput & { agentToken?: string | null; adminKey?: string | null } = {}) {
    return this.observations.ensure(runId, input);
  }

  acknowledgeRunEvents(input: AcknowledgeRunInput) { return this.observations.acknowledge(input); }

  waitForRun(input: WaitRunInput) {
    return this.observations.wait(input);
  }

  reconnectAttachedSession(agentId: string, connection: Record<string, unknown>): AgentRecord {
    const agent = this.getAgent(agentId);
    if (agent.backend !== "codex-session") return agent;
    const updated = this.store.updateAgent(agentId, { backendHandle: { ...agent.backend_handle, ...connection } });
    this.armStatusWatcher(updated);
    return updated;
  }

  private isAttachedParticipant(agent: AgentRecord): boolean {
    return agent.backend === "codex-session" || isPassiveObserver(agent) || this.observations.isAttached(agent.agent_id);
  }

  private samePublicActivity(previous: AgentActivity | undefined, value: unknown): boolean {
    const activity = parseActivity(value);
    return activity ? previous?.kind === activity.kind && previous.text === activity.text && previous.state === activity.state &&
      (activity.observed_at === undefined || previous.observed_at === activity.observed_at) : previous === undefined;
  }

  private saveActivity(agent: AgentRecord, value: unknown): void {
    const activity = parseActivity(value);
    if (!activity) {
      this.store.db.prepare("delete from agent_activity where agent_id = ?").run(agent.agent_id);
      return;
    }
    const existing = this.readActivity(agent);
    if (existing?.kind === activity.kind && existing.text === activity.text && existing.state === activity.state && existing.observed_at === activity.observed_at) return;
    this.store.db.prepare("insert into agent_activity values (?, ?) on conflict(agent_id) do update set activity_json = excluded.activity_json")
      .run(agent.agent_id, JSON.stringify({ ...activity, work_generation: agent.work_generation }));
  }

  private readActivity(agent: AgentRecord): AgentActivity | undefined {
    const row = this.store.db.prepare("select activity_json from agent_activity where agent_id = ?").get(agent.agent_id) as { activity_json: string } | undefined;
    if (!row) return undefined;
    const value = JSON.parse(row.activity_json);
    return value.work_generation === agent.work_generation ? parseActivity(value) ?? undefined : undefined;
  }

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

  /** Stop local supervision without stopping durable workers or detaching observers. */
  dispose(): Promise<void> {
    if (this.disposeTask) return this.disposeTask;
    this.disposing = true;
    this.backgroundAbort.abort();
    for (const agentId of this.statusWatchers.keys()) this.disarmStatusWatcher(agentId);
    this.disposeTask = (async () => {
      while (this.backgroundTasks.size || this.pendingDeliveries.size) {
        await Promise.allSettled([...this.backgroundTasks, ...this.pendingDeliveries]);
      }
    })();
    return this.disposeTask;
  }

  runBackground(task: () => Promise<unknown>): void {
    if (this.disposing) return;
    const pending = Promise.resolve().then(task).then(() => undefined).catch(() => {
      // Background refresh is best-effort; explicit operations report errors.
    }).finally(() => this.backgroundTasks.delete(pending));
    this.backgroundTasks.add(pending);
  }

  private async backgroundDelay(ms: number): Promise<boolean> {
    if (this.disposing) return false;
    return new Promise((resolveDelay) => {
      const finish = (elapsed: boolean) => {
        clearTimeout(timer);
        this.backgroundAbort.signal.removeEventListener("abort", abort);
        resolveDelay(elapsed);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(true), ms);
      this.backgroundAbort.signal.addEventListener("abort", abort, { once: true });
    });
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

  startFlow(input: RequesterInput & {
    config: unknown;
    runId?: string | null;
    runTitle?: string | null;
    acceptanceContext?: string | null;
    repoDir?: string | null;
    adminKey?: string | null;
    agentToken?: string | null;
    ownerTaskIdentity?: string | null;
    ownerTaskPath?: string | null;
    /**
     * `raw` keeps the direct MCP two-stage exchange. `local` writes the bridge
     * secret through LocalCredentialStore before the initialization transaction
     * commits and returns only its public reference.
     */
    bridgeCredentialDelivery?: "raw" | "local";
  }): FlowStartResult {
    const config = pinFlowConfig(parseFlowConfig(input.config));
    const caller = input.agentToken ? this.requireAgentToken(input.agentToken) : null;
    const requiresNativeBridge = flowUsesCodexSubagents(config);
    const persistBridgeCredentialLocally = input.bridgeCredentialDelivery === "local";
    if (requiresNativeBridge && (!caller || caller.role !== "orchestrator")) {
      throw new ControllerError(
        "A codex-subagent flow must be launched by an authenticated orchestrator agent.",
        "auth_required",
        { backend: CODEX_SUBAGENT_BACKEND }
      );
    }
    if (requiresNativeBridge && persistBridgeCredentialLocally && !this.credentialStore) {
      throw new ControllerError(
        "Local bridge credential delivery requires a configured local credential store.",
        "tool_error",
        { backend: CODEX_SUBAGENT_BACKEND }
      );
    }
    const run = input.runId
      ? this.getRun(input.runId, { agentToken: input.agentToken ?? undefined })
      : this.createRun({
          title: input.runTitle ?? config.description ?? config.id,
          repoDir: input.repoDir,
          adminKey: input.adminKey,
          agentToken: input.agentToken
        });
    const observer = this.ensureRequester(run.run_id, input);
    if (input.runId) {
      const reusable = this.findReusableFlowInstance(run.run_id, config);
      if (reusable) {
        let bridgeGrant: PublicBridgeGrantRef | undefined;
        if (requiresNativeBridge && caller) {
          if (reusable.instance.orchestrator_agent_id !== caller.agent_id) {
            throw new ControllerError(
              "The reusable native flow belongs to a different orchestrator.",
              "auth_required",
              { flow_instance_id: reusable.instance.flow_instance_id }
            );
          }
          const ownerTaskIdentity = normalizeOptionalIdentity(
            input.ownerTaskIdentity ?? currentCodexThreadId() ?? null
          );
          const ownerTaskPath = normalizeOwnerTaskPath(input.ownerTaskPath ?? "/root");
          const originatingGrant = this.resolveNativeFlowBridgeGrant(
            reusable.instance
          );
          if (
            originatingGrant.owner_task_path !== ownerTaskPath ||
            (ownerTaskIdentity &&
              originatingGrant.owner_task_identity !== ownerTaskIdentity)
          ) {
            throw new ControllerError(
              "The reusable native flow requires one active bridge grant for the current task binding.",
              "auth_required",
              {
                flow_instance_id: reusable.instance.flow_instance_id,
                originating_bridge_grant_id:
                  reusable.instance.originating_bridge_grant_id,
                requested_owner_task_path: ownerTaskPath
              }
            );
          }
          bridgeGrant = publicBridgeGrantRefFromGrant(originatingGrant);
        }
        if (caller) {
          this.ensureFlowOwnerSubscriptions(run.run_id, caller.agent_id);
        }
        const activeStep = this.store
          .listFlowStepInstances(reusable.instance.flow_instance_id)
          .find((step) => step.status === "active") ?? null;
        return {
          observer,
          flow: reusable.flow,
          instance: reusable.instance,
          active_step: activeStep,
          reused: true,
          blocked_reason: reusable.instance.status === "blocked" ? "blocked" : undefined,
          bridge_grant: bridgeGrant
        };
      }
    }
    const pendingEvents: EventRecord[] = [];
    const initialized = this.store.transaction(() => {
      const flow = this.store.createFlow(config);
      let bridgeCredential: BridgeCredential | undefined;
      let bridgeGrant: PublicBridgeGrantRef | undefined;
      let originatingBridgeGrantId: string | null = null;
      if (requiresNativeBridge && caller) {
        const rawBridgeToken = generateBridgeToken();
        const grant = this.store.createBridgeGrant({
          runId: run.run_id,
          orchestratorAgentId: caller.agent_id,
          ownerTaskIdentity: normalizeOptionalIdentity(
            input.ownerTaskIdentity ?? currentCodexThreadId() ?? null
          ),
          ownerTaskPath: normalizeOwnerTaskPath(input.ownerTaskPath ?? "/root"),
          tokenHash: hashToken(rawBridgeToken)
        });
        originatingBridgeGrantId = grant.bridge_grant_id;
        bridgeCredential = bridgeCredentialFromGrant(grant, rawBridgeToken);
      }
      // The flow and its first executable native action share one immutable
      // causal grant. Persist the binding in the same transaction that creates
      // the grant and instance, before any step can be dispatched or reused.
      const instance = this.store.createFlowInstance({
        flowRecordId: flow.flow_record_id,
        runId: run.run_id,
        orchestratorAgentId: caller?.agent_id ?? null,
        originatingBridgeGrantId,
        currentStepId: config.initial_step
      });
      this.flowRuntime.initialize(instance.flow_instance_id, config, input.acceptanceContext ?? run.title);
      const declaredOwners = this.ensureDeclaredFlowAgents({
        config,
        instanceId: instance.flow_instance_id,
        flowId: flow.flow_id,
        run,
        caller,
        agentToken: input.agentToken ?? null
      });
      const runtimeState = this.flowRuntime.get(instance.flow_instance_id)!;
      runtimeState.decision_owners = { requester: observer?.observer_agent_id ?? null, orchestrator: caller?.agent_id ?? null };
      runtimeState.owners = Object.fromEntries([...declaredOwners].map(([role, agent]) => [role, agent.agent_id]));
      this.flowRuntime.save(instance.flow_instance_id, runtimeState);
      if (caller) {
        this.ensureFlowOwnerSubscriptions(run.run_id, caller.agent_id);
      }

      // Event rows participate in the same transaction, but delivery is
      // deferred until commit. A failed declared backend or activation can
      // therefore never publish a flow whose instance/grant was rolled back.
      const queueEvent = (event: ControllerEventInput): void => {
        pendingEvents.push(this.store.createEvent(event));
      };
      queueEvent({
        runId: run.run_id,
        type: "flow.started",
        payload: {
          flow_instance_id: instance.flow_instance_id,
          flow_record_id: flow.flow_record_id,
          flow_id: flow.flow_id,
          initial_step: config.initial_step
        }
      });
      const activeStep = this.activateFlowStep(flow.config, instance, config.initial_step, {
        eventSink: queueEvent
      });

      // Persist only after every database initialization step has succeeded,
      // while the bridge grant is still visible on this SQLite connection. A
      // filesystem failure rolls the whole transaction back, so the next CLI
      // attempt cannot reuse a flow whose only bridge secret was never stored.
      if (bridgeCredential && persistBridgeCredentialLocally) {
        bridgeGrant = this.credentialStore!.persistBridgeCredential(bridgeCredential);
        bridgeCredential = undefined;
      }
      return { flow, instance, activeStep, bridgeCredential, bridgeGrant };
    });
    for (const event of pendingEvents) {
      this.scheduleEventDelivery(event);
    }
    return {
      observer,
      flow: initialized.flow,
      instance: this.getFlowInstanceOrThrow(initialized.instance.flow_instance_id),
      active_step: initialized.activeStep.status === "active" ? initialized.activeStep : null,
      reused: false,
      blocked_reason:
        initialized.activeStep.status === "blocked"
          ? String(initialized.activeStep.summary ?? "blocked")
          : undefined,
      bridge_grant: initialized.bridgeGrant,
      bridge_credential: initialized.bridgeCredential
    };
  }

  /** Identity comes from the local host's MCP request context or CLI environment,
   * never an agent id in a model-generated report payload. */
  private flowCaller(agentToken?: string | null, expectedIds?: Array<string | null>): AgentRecord | null {
    if (agentToken) return this.requireAgentToken(agentToken);
    const threadId = currentCodexThreadId();
    if (!threadId) return null;
    const matches = this.store.listAgents().filter(agent => !agent.unregistered_at && (!expectedIds || expectedIds.includes(agent.agent_id)) &&
      (agent.backend_handle?.thread_id === threadId || (agent.backend === CODEX_SUBAGENT_BACKEND && agent.backend_handle?.native_agent_id === threadId)));
    return matches.length === 1 ? matches[0]! : null;
  }

  private requireFlowCoordinator(instance: FlowInstanceRecord, input: { agentToken?: string | null; adminKey?: string | null }): string {
    if (input.adminKey && verifyAdminKey(input.adminKey)) return instance.orchestrator_agent_id ?? "local-admin";
    const caller = this.flowCaller(input.agentToken, [instance.orchestrator_agent_id]);
    if (!caller || caller.agent_id !== instance.orchestrator_agent_id || caller.unregistered_at) throw new ControllerError("This flow decision requires its authenticated coordinator.", "auth_required");
    return caller.agent_id;
  }

  private packageContext(flowId: string, verifyPlan = true): PackageContext {
    const instance = this.getFlowInstanceOrThrow(flowId); const flow = this.getFlowOrThrow(instance.flow_record_id);
    const policy = flow.config.policy?.work_packages;
    if (!policy || !flow.config.policy?.strict || !flow.config.policy.plan_artifact) throw new ControllerError("This flow does not declare strict work packages.", "tool_error");
    const state = this.flowRuntime.get(flowId)!; const run = this.getRun(instance.run_id);
    const binding = this.store.listFlowArtifactBindings(flowId).find(item => item.artifact_key === flow.config.policy!.plan_artifact);
    if (!run.repo_dir || !binding) throw new ControllerError("Work packages require the bound plan and consolidated repository.", "tool_error");
    return { flowId, runId: run.run_id, repo: realpathSync(run.repo_dir), root: join(runRuntimeDir(run.run_id), "packages", flowId), planPath: binding.path,
      planRevision: verifyPlan ? this.boundFlowArtifactDigest(instance, flow.config.policy.plan_artifact) : state.artifacts?.[flow.config.policy.plan_artifact]?.sha256 ?? "unplanned",
      acceptanceRevision: state.acceptance_revision, stepId: instance.current_step_id, parentAgentId: state.owners[flow.config.steps[policy.execution_step].role ?? ""] ?? instance.orchestrator_agent_id!, policy, config: flow.config, approval: state.decisions[policy.approval_decision] };
  }

  private packageRuntime(auth: { agentToken?: string | null; adminKey?: string | null } = {}): FlowPackages {
    return new FlowPackages({ store: this.store, runtime: this.flowRuntime,
      context: (id, verify) => this.packageContext(id, verify),
      authorize: (id, purpose, assignedId) => {
        const instance = this.getFlowInstanceOrThrow(id); const context = this.packageContext(id, false);
        const active = this.store.listFlowStepInstances(id).find(step => step.status === "active");
        const expected = purpose === "deliver" ? [assignedId ?? null] : [instance.orchestrator_agent_id, active?.agent_id ?? null];
        const caller = this.flowCaller(auth.agentToken, expected);
        if (purpose !== "deliver" && auth.adminKey && verifyAdminKey(auth.adminKey)) return instance.orchestrator_agent_id ?? "local-admin";
        if (!caller || !expected.includes(caller.agent_id) || purpose === "deliver" && caller.agent_id !== assignedId) throw new ControllerError("This package operation requires its assigned worker or authenticated coordinator.", "auth_required");
        if (caller.agent_id !== instance.orchestrator_agent_id && purpose !== "deliver" && active?.input_json.acceptance_revision !== context.acceptanceRevision) throw new ControllerError("The package coordinator attempt belongs to obsolete acceptance.", "tool_error");
        return caller.agent_id;
      },
      register: (context, entry) => { const role = context.config.roles![entry.role]!; const { agent_token: _secret, ...agent } = this.registerAgent({ runId: context.runId, backend: role.backend!, title: `${entry.title} (${entry.id})`, role: entry.role, objective: entry.title, repoDir: entry.worktree, model: role.model }); this.createAgentLinkIfMissing({ runId: context.runId, sourceAgentId: context.parentAgentId, targetAgentId: agent.agent_id, type: "parent_child", label: entry.id }); return agent; },
      start: async (context, entry, branch) => {
        const state = this.flowRuntime.get(context.flowId)!; const role = context.config.roles![entry.role]!;
        const rolePrompt = role.prompt ?? (role.prompt_ref ? context.config.prompts?.[role.prompt_ref]?.text : "") ?? "";
        const dependencies = entry.depends_on.map(id => ({ package_id: id, delivery: state.packages?.branches[id]?.delivery }));
        const prompt = [rolePrompt, "You own one approved work package, not the parent flow phase. Do not call flow_step_report, route phases, approve packages, or spawn workers. Use the assigned worktree and write only its declared paths. Read the bound plan and dependency delivery snapshots before working. Do not alter the source dependency worktrees or integration checkout.",
          JSON.stringify({ objective: state.context, flow_instance_id: context.flowId, package: entry, attempt: branch.attempt, plan_path: context.planPath, plan_revision: context.planRevision, dependencies, correction: state.correction, retry_reason: branch.reason, previous_delivery: branch.prior_attempts?.at(-1)?.delivery }),
          "When the expected files are ready, call flow_packages with the exact contract below. The tool snapshots the actual delivered files; after success, stop and return a concise final message. Do not continue editing after delivery.",
          JSON.stringify({ flow_instance_id: context.flowId, request: { operation: "deliver", package_id: entry.id, attempt: branch.attempt, summary: "Brief delivery result." } }), STRICT_FLOW_CAPABILITY_FAILURE].join("\n\n");
        this.ensureRequester(context.runId);
        this.createAgentLinkIfMissing({ runId: context.runId, sourceAgentId: context.parentAgentId, targetAgentId: branch.agent_id!, type: "parent_child", label: entry.id });
        return this.startAgent({ agentId: branch.agent_id!, prompt, model: role.model ?? undefined, metadata: { sandbox: "workspace", ...(role.reasoning_effort ? { reasoning_effort: role.reasoning_effort } : {}), phase: context.policy.execution_step, parent_agent_id: context.parentAgentId, package_flow_instance_id: context.flowId, package_id: entry.id, package_attempt: branch.attempt } });
      },
      agent: id => this.getAgent(id), refresh: async id => { const agent = await this.refreshAgentStatus(id); this.packageRuntime().reconcile(agent); return agent; }, stop: id => this.stopAgent(id),
      verifyResult: (context, id) => new EvidenceService({ rootDir: join(runRuntimeDir(context.runId), "evidence") }).verifyResultManifestSync(this.evidenceContext(this.getFlowInstanceOrThrow(context.flowId), "package-integration", "integration"), id),
      emit: (context, reason, detail) => {
        const group = this.flowRuntime.get(context.flowId)?.packages; const packageId = typeof detail.package_id === "string" ? detail.package_id : undefined;
        const branch = packageId ? group?.branches[packageId] : undefined;
        const packageProgress = { ...(packageId ? { package_id: packageId, label: group?.manifest.find(item => item.id === packageId)?.title, status: branch?.state, generation: branch?.attempt } : {}), required_count: group?.manifest.filter(item => item.required).length ?? 0, accepted_count: group?.manifest.filter(item => item.required && group.branches[item.id]?.state === "accepted").length ?? 0, ...(typeof detail.reason === "string" ? { reason: detail.reason } : {}) };
        this.emit({ runId: context.runId, agentId: branch?.agent_id, type: "flow.notification", payload: { flow_instance_id: context.flowId, step_id: context.stepId, reason, ...detail, package_progress: packageProgress } });
        if (reason === "package_blocked") this.emit({ runId: context.runId, agentId: branch?.agent_id, type: "flow.step_blocked", payload: { flow_instance_id: context.flowId, step_id: context.policy.execution_step, reason, package_progress: packageProgress } });
      }
    });
  }

  private packageObserver(flowId: string, auth: { agentToken?: string | null; adminKey?: string | null }) {
    const instance = this.getFlowInstanceOrThrow(flowId); const context = this.packageContext(flowId, false);
    const requesterId = this.flowRuntime.get(flowId)?.decision_owners?.requester ?? null;
    const expected = [instance.orchestrator_agent_id, context.parentAgentId, requesterId];
    const caller = this.flowCaller(auth.agentToken, expected);
    const threadId = caller?.backend === "codex-thread" ? caller.backend_handle?.thread_id : null;
    if (!caller || !expected.includes(caller.agent_id) || typeof threadId !== "string" || !threadId) throw new ControllerError("Package supervision requires the actual launching Codex conversation identity.", "auth_required");
    // Register before dispatch so even a fast first delivery is in this
    // observer's history. This never replaces the original requester binding.
    this.ensureRequester(context.runId);
    for (const branch of Object.values(this.flowRuntime.get(flowId)?.packages?.branches ?? {})) if (branch.agent_id) this.packageRuntime().reconcile(this.getAgent(branch.agent_id));
    return { ...this.observeRun({ runId: context.runId, threadId, title: `Package coordinator: ${caller.title}`, eventTypes: [...EVENT_TYPES], delivery: "wait", adminKey: resolveAdminKey() }), wait_contract: packageWaitContract(flowId) };
  }

  executeFlowPackages(input: { flowInstanceId: string; request: FlowPackagesRequest; agentToken?: string | null; adminKey?: string | null; signal?: AbortSignal }): Promise<PackageGroup & { coordinator_observer?: ReturnType<AgentController["packageObserver"]>; wait_contract?: ReturnType<typeof packageWaitContract> }>;
  executeFlowPackages(input: { flowInstanceId: string; request: FlowPackagesToolRequest; agentToken?: string | null; adminKey?: string | null; signal?: AbortSignal }): Promise<unknown>;
  async executeFlowPackages(input: { flowInstanceId: string; request: FlowPackagesToolRequest; agentToken?: string | null; adminKey?: string | null; signal?: AbortSignal }): Promise<unknown> {
    const request = flowPackagesRequestSchema.parse(input.request);
    const observer = ["launch", "accept", "retry", "wait", "ack"].includes(request.operation) ? this.packageObserver(input.flowInstanceId, input) : undefined;
    const waitContract = packageWaitContract(input.flowInstanceId);
    if (request.operation === "wait") {
      const result = await this.waitForRun({ runId: observer!.run_id, observerAgentId: observer!.observer_agent_id, cursor: request.cursor, timeoutMs: request.timeout_ms ?? 3_600_000, signal: input.signal });
      return { ...result, coordinator_observer: observer, wait_contract: result.closed ? null : waitContract,
        ...("ack_contract" in result && result.ack_contract ? { ack_contract: { tool: "flow_packages", arguments: { flow_instance_id: input.flowInstanceId, request: { operation: "ack", cursor: result.cursor } }, instruction: "Acknowledge this cursor only after handling every event in this batch, then wait again." } } : {}) };
    }
    if (request.operation === "ack") {
      // The cursor is signed and checked by the existing observer protocol;
      // its observer is derived from the authenticated thread, never submitted.
      const result = this.acknowledgeRunEvents({ runId: observer!.run_id, observerAgentId: observer!.observer_agent_id, cursor: request.cursor, adminKey: resolveAdminKey() });
      return { ...result, coordinator_observer: observer, wait_contract: waitContract };
    }
    const group = await this.packageRuntime(input).execute(input.flowInstanceId, request);
    return { ...group, ...(observer ? { coordinator_observer: observer, wait_contract: waitContract } : {}) };
  }

  updateFlowContext(input: { flowInstanceId: string; context: string; expectedRevision: number; agentToken?: string | null; adminKey?: string | null }) {
    return this.store.immediateTransaction(() => {
      const instance = this.getFlowInstanceOrThrow(input.flowInstanceId);
      const actorId = this.requireFlowDecisionActor(instance, { owner: this.flowRuntime.get(instance.flow_instance_id)?.decision_owners?.requester ? "requester" : "orchestrator" }, input);
      if (!input.context.trim()) throw new ControllerError("Acceptance context must not be empty.", "tool_error");
      const runtime = this.flowRuntime.changeContext(instance.flow_instance_id, input.context, actorId, input.expectedRevision);
      this.emit({ runId: instance.run_id, agentId: instance.orchestrator_agent_id, type: "flow.notification", payload: { flow_instance_id: instance.flow_instance_id, reason: "acceptance_updated", acceptance_revision: runtime.acceptance_revision } });
      return { flow_instance_id: instance.flow_instance_id, runtime };
    });
  }

  recoverFlowOwner(input: { flowInstanceId: string; role: string; restartStepId: string; reason: string; expectedRevision: number; agentToken?: string | null; adminKey?: string | null }): FlowSnapshot {
    return this.store.immediateTransaction(() => {
      const instance = this.getFlowInstanceOrThrow(input.flowInstanceId);
      this.requireFlowCoordinator(instance, input);
      const flow = this.getFlowOrThrow(instance.flow_record_id);
      if (!flow.config.policy?.strict) throw new ControllerError("Explicit owner recovery requires a strict flow with pinned role ownership.", "tool_error");
      const state = this.flowRuntime.get(instance.flow_instance_id)!;
      const requestDigest = digest({ role: input.role, restart_step: input.restartStepId, reason: input.reason, expected_revision: input.expectedRevision });
      if (state.recovery?.request_digest === requestDigest) return this.getFlowSnapshot(instance.flow_instance_id);
      if (state.revision !== input.expectedRevision) throw new ControllerError("Flow state changed before owner recovery; read the current state before retrying.", "tool_error");
      const roleConfig = flow.config.roles?.[input.role];
      const stepConfig = flow.config.steps[input.restartStepId];
      const previousId = state.owners[input.role];
      if (!previousId || !roleConfig?.backend || !stepConfig || stepConfig.role !== input.role || !input.reason.trim()) throw new ControllerError("Recovery must select the pinned role and one of its configured steps with an explicit reason.", "tool_error");
      const previous = this.getAgent(previousId);
      if (!previous.unregistered_at && !TERMINAL_STATUSES.has(previous.status)) throw new ControllerError("Stop or detach the previous role owner before replacing it; recovery does not interrupt active work implicitly.", "tool_error");
      const activeSteps = this.store.listFlowStepInstances(instance.flow_instance_id).filter(step => step.status === "active");
      if (activeSteps.some(step => step.agent_id && step.agent_id !== previousId)) throw new ControllerError("Another worker owns the active phase; recover the missing owner after that work reaches a handoff.", "tool_error");
      const { agent_token: _privateToken, ...replacement } = this.registerAgent({ runId: instance.run_id, backend: roleConfig.backend,
        title: declaredFlowAgentTitle(`${flow.flow_id}/${instance.flow_instance_id}/recovery-${state.revision + 1}`, input.role),
        role: input.role, objective: state.context ?? this.getRun(instance.run_id).title, repoDir: this.getRun(instance.run_id).repo_dir,
        model: roleConfig.model, status: "planned", ...(input.agentToken ? { agentToken: input.agentToken } : { adminKey: input.adminKey ?? undefined }) });
      for (const active of activeSteps) this.store.updateFlowStepInstance(active.step_instance_id, { status: "cancelled", summary: `Explicit owner recovery: ${input.reason}`, completedAt: nowIso() });
      state.owners[input.role] = replacement.agent_id;
      state.revision += 1;
      state.recovery = { request_digest: requestDigest, role: input.role, previous_agent_id: previousId, agent_id: replacement.agent_id,
        reason: input.reason, restart_step_id: input.restartStepId, full_review_required: true };
      state.correction = { from_step_id: instance.current_step_id, summary: input.reason, reason: "explicit_owner_recovery", role: input.role, full_review_required: true };
      this.flowRuntime.save(instance.flow_instance_id, state);
      const next = this.activateFlowStep(flow.config, instance, input.restartStepId);
      this.emit({ runId: instance.run_id, agentId: replacement.agent_id, type: "flow.notification", payload: { flow_instance_id: instance.flow_instance_id, step_instance_id: next.step_instance_id, reason: "owner_recovered", role: input.role, previous_agent_id: previousId, full_review_required: true, summary: input.reason } });
      return this.getFlowSnapshot(instance.flow_instance_id);
    });
  }

  private requireFlowDecisionActor(instance: FlowInstanceRecord, declaration: { owner?: "requester" | "orchestrator" }, input: { agentToken?: string | null; adminKey?: string | null }): string {
    const ownerKind = declaration.owner ?? "orchestrator";
    const ownerId = this.flowRuntime.get(instance.flow_instance_id)?.decision_owners?.[ownerKind] ?? (ownerKind === "orchestrator" ? instance.orchestrator_agent_id : null);
    if (!ownerId) throw new ControllerError("This decision requires the original requesting conversation to be identified at launch.", "auth_required");
    const caller = this.flowCaller(input.agentToken, [ownerId]);
    if (!caller || caller.agent_id !== ownerId) throw new ControllerError("This decision belongs to a different conversation; its configured owner must record it.", "auth_required");
    return caller.agent_id;
  }

  recordFlowDecision(input: { flowInstanceId: string; key: string; value: unknown; reason: string; expectedRevision: number; artifactKey?: string; artifactDigest?: string; packageManifestDigest?: string; agentToken?: string | null; adminKey?: string | null }) {
    return this.store.immediateTransaction(() => {
      const instance = this.getFlowInstanceOrThrow(input.flowInstanceId);
      const flow = this.getFlowOrThrow(instance.flow_record_id);
      const state = this.flowRuntime.get(instance.flow_instance_id)!;
      if (state.revision !== input.expectedRevision) throw new ControllerError("The flow revision changed before this decision; read the current gate first.", "tool_error");
      const step = this.store.listFlowStepInstances(instance.flow_instance_id).find(item => item.status === "active" && flow.config.steps[item.step_id].decision?.key === input.key);
      const declaration = step ? flow.config.steps[step.step_id].decision : flow.config.preferences?.[input.key];
      if (!declaration || !input.reason.trim()) throw new ControllerError("This decision is not a configured active gate or preference, or has no human decision record.", "tool_error");
      if ("values" in declaration && declaration.values && !declaration.values.includes(input.value as string)) throw new ControllerError("Decision is outside configured preference values.", "tool_error");
      const actorId = this.requireFlowDecisionActor(instance, declaration, input);
      const authority = "authority" in declaration ? declaration.authority ?? "user" : "user";
      const artifactKey = declaration.artifact_key;
      if (input.artifactKey && input.artifactKey !== artifactKey) throw new ControllerError("Decision artifact differs from its configured gate.", "tool_error");
      const binding = artifactKey ? this.store.listFlowArtifactBindings(instance.flow_instance_id).find(item => item.artifact_key === artifactKey) : null;
      const boundDigest = binding ? this.boundFlowArtifactDigest(instance, artifactKey!) : undefined;
      if (artifactKey && (!binding || !input.artifactDigest || input.artifactDigest !== boundDigest)) throw new ControllerError("The human decision must name the exact current artifact digest.", "tool_error");
      const packageManifestDigest = flow.config.policy?.work_packages?.approval_decision === input.key && input.value === (flow.config.policy.work_packages.approval_value ?? "approved") ? this.packageRuntime(input).approval(this.packageContext(instance.flow_instance_id), input.packageManifestDigest) : undefined;
      state.decisions[input.key] = { ...(packageManifestDigest ? { package_manifest_digest: packageManifestDigest } : {}), value: input.value, reason: input.reason, actor_id: actorId, authority, source: authority === "coordinator" ? "coordinator_review" : "user_reply", acceptance_revision: state.acceptance_revision, ...(artifactKey ? { artifact_key: artifactKey, artifact_digest: boundDigest } : {}) };
      state.revision += 1;
      this.flowRuntime.save(instance.flow_instance_id, state);
      this.emit({ runId: instance.run_id, agentId: instance.orchestrator_agent_id, type: "flow.notification", payload: { flow_instance_id: instance.flow_instance_id, reason: "human_decision_recorded", decision_key: input.key, decision: input.value } });
      return step ? this.reportFlowStep({ stepInstanceId: step.step_instance_id, status: "completed", result: { decision: input.value }, summary: input.reason, reportToken: this.flowRuntime.capability(step.step_instance_id) }) : { flow_instance_id: instance.flow_instance_id, runtime: state };
    });
  }

  private flowConditionContext(instance: FlowInstanceRecord): Record<string, unknown> {
    const state = this.flowRuntime.get(instance.flow_instance_id);
    if (!state) return {};
    const bindings = this.store.listFlowArtifactBindings(instance.flow_instance_id);
    const decisions = Object.fromEntries(Object.entries(state.decisions).filter(([, decision]) => {
      if (decision.acceptance_revision !== state.acceptance_revision) return false;
      if (!decision.artifact_key) return true;
      const binding = bindings.find(item => item.artifact_key === decision.artifact_key);
      try { return Boolean(binding && this.boundFlowArtifactDigest(instance, decision.artifact_key!) === decision.artifact_digest); } catch { return false; }
    }));
    return { state: state.state, decisions, evidence: state.evidence, acceptance_revision: state.acceptance_revision, ...(this.getFlowOrThrow(instance.flow_record_id).config.policy?.work_packages ? { packages: this.packageRuntime().condition(instance.flow_instance_id) } : {}) };
  }

  private boundFlowArtifactDigest(instance: FlowInstanceRecord, key: string): string {
    const binding = this.store.listFlowArtifactBindings(instance.flow_instance_id).find(item => item.artifact_key === key);
    if (!binding) throw new ControllerError("Required bound artifact is missing.", "missing_artifact", { artifact: key });
    const current = artifactDigest(binding.path);
    const recorded = this.flowRuntime.get(instance.flow_instance_id)?.artifacts?.[key];
    if (this.getFlowOrThrow(instance.flow_record_id).config.policy?.strict && (!recorded || recorded.path !== binding.path || recorded.sha256 !== current || artifactDigest(recorded.snapshot_path) !== recorded.sha256)) throw new ControllerError("A bound artifact changed outside its producing report; restore or explicitly report the new revision before proceeding.", "tool_error", { artifact: key });
    return current;
  }

  private evidenceContext(instance: FlowInstanceRecord, actorId: string, actorRole: string, historicalRead = false) {
    const state = this.flowRuntime.get(instance.flow_instance_id)!;
    const run = this.getRun(instance.run_id);
    if (!run.repo_dir) throw new ControllerError("Evidence requires a repository directory.", "tool_error");
    const config = this.getFlowOrThrow(instance.flow_record_id).config;
    const planKey = config.policy?.plan_artifact;
    const binding = planKey ? this.store.listFlowArtifactBindings(instance.flow_instance_id).find(item => item.artifact_key === planKey) : null;
    return { runId: instance.run_id, flowInstanceId: instance.flow_instance_id, repoPath: run.repo_dir, actorId, actorRole,
      acceptanceRevision: String(state.acceptance_revision), planRevision: binding && !historicalRead ? this.boundFlowArtifactDigest(instance, planKey!) : "unplanned" };
  }

  async executeFlowEvidence(input: { flowInstanceId: string; key: string; request: EvidenceRequest; stepInstanceId?: string; reportToken?: string; agentToken?: string | null; adminKey?: string | null }) {
    const instance = this.getFlowInstanceOrThrow(input.flowInstanceId);
    const config = this.getFlowOrThrow(instance.flow_record_id).config;
    const step = input.stepInstanceId ? this.getFlowStepInstanceOrThrow(input.stepInstanceId) : this.store.listFlowStepInstances(instance.flow_instance_id).find(item => item.status === "active");
    if (!step || step.flow_instance_id !== instance.flow_instance_id || step.status !== "active") throw new ControllerError("Evidence requires a current step generation in this flow.", "tool_error");
    const stepConfig = config.steps[step.step_id];
    if (input.request.operation !== "read_receipt" && step.input_json.acceptance_revision !== this.flowRuntime.get(instance.flow_instance_id)?.acceptance_revision) throw new ControllerError("The acceptance changed after this step started; evidence cannot be authored for the new contract by an obsolete attempt.", "tool_error");
    let actorId: string;
    if (stepConfig.execution === "coordinator") actorId = this.requireFlowCoordinator(instance, input);
    else {
      const caller = this.flowCaller(input.agentToken, [step.agent_id]);
      if (!caller || caller.agent_id !== step.agent_id) this.flowRuntime.verifyCapability(step.step_instance_id, input.reportToken);
      if (!step.agent_id) throw new ControllerError("Evidence requires the pinned assigned worker.", "auth_required");
      actorId = step.agent_id;
    }
    if (config.policy?.strict && !stepConfig.evidence_operations?.includes(input.request.operation)) throw new ControllerError("This evidence operation is not authorized for the current step.", "auth_required");
    if (input.request.operation === "record_review" && !stepConfig.evidence_gates?.includes(input.request.gate)) throw new ControllerError("This step cannot author this review gate.", "auth_required");
    const recovery = this.flowRuntime.get(instance.flow_instance_id)?.recovery;
    if (recovery?.full_review_required && recovery.agent_id === actorId) {
      if ((input.request.operation === "prepare_result" || input.request.operation === "prepare_plan") && input.request.previous) throw new ControllerError("A replacement review owner must start a full checkpoint without inheriting another owner's evidence.", "tool_error");
      if (input.request.operation === "record_review" || input.request.operation === "record_plan_review") {
        if ((input.request.draft.coverage_ledger as Record<string, unknown> | undefined)?.mode !== "full") throw new ControllerError("The replacement owner must complete a full review before incremental reuse is enabled.", "tool_error");
        // Mechanical proof remains usable; only semantic approval from the
        // previous owner is forbidden as a replacement review's carry source.
        for (const sourceId of input.request.source_receipt_ids ?? []) new EvidenceService({ rootDir: join(runRuntimeDir(instance.run_id), "evidence") }).verifyReceiptSync(
          this.evidenceContext(instance, actorId, stepConfig.role ?? "coordinator"), sourceId,
          { kind: "validation", requireCurrent: true, requireApproved: true, validationMode: "complete_gate" });
      }
    }
    if (input.request.operation === "prepare_plan" || input.request.operation === "prepare_result") {
      const planKey = config.policy?.plan_artifact;
      const binding = this.store.listFlowArtifactBindings(instance.flow_instance_id).find(item => item.artifact_key === planKey);
      if (!binding || resolve(input.request.plan_path) !== resolve(binding.path)) throw new ControllerError("Evidence must use the flow's exact bound plan artifact, not a worker-selected substitute.", "tool_error");
    }
    // Historical receipt reads verify their original revisions in the service.
    // A working plan edit must not prevent reading the findings that caused it.
    const context = this.evidenceContext(instance, actorId, stepConfig.role ?? "coordinator", input.request.operation === "read_receipt");
    const service = new EvidenceService({ rootDir: join(runRuntimeDir(instance.run_id), "evidence") });
    const receipt = await service.execute(context, input.request);
    if (input.request.operation === "read_receipt") return receipt;
    return this.store.immediateTransaction(() => {
      const current = this.getFlowStepInstanceOrThrow(step.step_instance_id);
      const state = this.flowRuntime.get(instance.flow_instance_id)!;
      if ((current.agent_id && (current.agent_id !== actorId || this.getAgent(current.agent_id).unregistered_at)) || current.status !== "active" || String(state.acceptance_revision) !== context.acceptanceRevision || this.evidenceContext(instance, actorId, stepConfig.role ?? "coordinator").planRevision !== context.planRevision) throw new ControllerError("Work changed while evidence was being prepared; its receipt cannot advance this flow.", "tool_error");
      if (state.recovery?.agent_id === actorId && ["plan_review", "planner_review", "expert_review"].includes(receipt.kind)) state.recovery.full_review_required = false;
      state.evidence[input.key] = receipt.receipt_id;
      state.evidence_summaries ??= {};
      state.evidence_summaries[input.key] = { receipt_id: receipt.receipt_id, kind: receipt.kind, status: receipt.status, step_instance_id: step.step_instance_id, acceptance_revision: state.acceptance_revision, summary: receipt.summary };
      state.revision += 1;
      this.flowRuntime.save(instance.flow_instance_id, state);
      this.emit({ runId: instance.run_id, agentId: step.agent_id, type: "flow.notification", payload: { flow_instance_id: instance.flow_instance_id, step_instance_id: step.step_instance_id, reason: "evidence_recorded", evidence: state.evidence_summaries[input.key] } });
      return receipt;
    });
  }

  private assertFlowRequirements(instance: FlowInstanceRecord, requirements: { requires?: import("./types.js").FlowConditionConfig; requires_evidence?: import("./types.js").FlowEvidenceRequirement[] }, extra: Record<string, unknown> = {}): void {
    const context = { ...this.flowConditionContext(instance), ...extra };
    if (requirements.requires && !evaluateCondition(requirements.requires, context)) throw new ControllerError("This phase is waiting for its configured decision or milestone.", "tool_error");
    for (const requirement of requirements.requires_evidence ?? []) {
      const receiptId = requirement.receipt.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, context);
      if (typeof receiptId !== "string") throw new ControllerError("Required verified evidence is missing.", "tool_error", { receipt: requirement.receipt });
      const ownerId = requirement.owner_role ? this.flowRuntime.get(instance.flow_instance_id)?.owners[requirement.owner_role] : undefined;
      if (requirement.owner_role && !ownerId) throw new ControllerError("Evidence has no pinned review owner.", "tool_error");
      const receipt = new EvidenceService({ rootDir: join(runRuntimeDir(instance.run_id), "evidence") }).verifyReceiptSync(
        this.evidenceContext(instance, instance.orchestrator_agent_id ?? "coordinator", "coordinator"), receiptId,
        { kind: requirement.kind as EvidenceReceiptKind | undefined, requireCurrent: requirement.require_current ?? true, requireApproved: requirement.require_approved ?? true, actorId: ownerId, validationMode: requirement.validation_mode });
      if (requirement.validation_mode) {
        const mechanical = receipt.payload.mechanical_report as Record<string, unknown> | undefined;
        if (receipt.kind !== "validation" || mechanical?.validation_mode !== requirement.validation_mode) throw new ControllerError("The validation receipt does not cover the required mechanical gate.", "tool_error");
      }
    }
  }

  getFlowSnapshot(flowInstanceId: string): FlowSnapshot {
    const instance = this.getFlowInstanceOrThrow(flowInstanceId);
    const flow = this.getFlowOrThrow(instance.flow_record_id);
    return {
      flow,
      instance,
      runtime: this.flowRuntime.get(flowInstanceId),
      steps: this.store.listFlowStepInstances(flowInstanceId),
      reports: this.store.listFlowStepReports(flowInstanceId),
      transitions: this.store.listFlowTransitions(flowInstanceId),
      artifact_bindings: this.store.listFlowArtifactBindings(flowInstanceId).map(binding => ({ ...binding, ...(this.flowRuntime.get(flowInstanceId)?.artifacts?.[binding.artifact_key] ?? {}) }))
    };
  }

  async startFlowStep(input: {
    flowInstanceId: string;
    stepId: string;
    fromStepInstanceId?: string | null;
    transitionId?: string | null;
    reason?: string | null;
    agentToken?: string | null;
    adminKey?: string | null;
  }): Promise<FlowStepStartResult> {
    const pendingEvents: EventRecord[] = [];
    const transition = this.store.immediateTransaction(() => {
      const queueEvent = (event: ControllerEventInput): void => {
        pendingEvents.push(this.store.createEvent(event));
      };
      const instance = this.getFlowInstanceOrThrow(input.flowInstanceId);
      const flow = this.getFlowOrThrow(instance.flow_record_id);
      if (flow.config.policy?.strict) this.requireFlowCoordinator(instance, input);
      if (flowUsesCodexSubagents(flow.config)) {
        // Manual routing can cancel workers and enqueue cleanup, so it must
        // prove the flow's immutable native owner before its first write too.
        this.resolveNativeFlowBridgeGrant(instance);
      }
      if (!flow.config.steps[input.stepId]) {
        throw new ControllerError("Cannot start undefined flow step.", "tool_error", {
          flow_instance_id: input.flowInstanceId,
          step_id: input.stepId
        });
      }
      const retainedAgentId = this.manualRouteRetainedAgentId(
        flow,
        instance,
        input.stepId
      );
      const cleanupTargets = new Map<string, AgentRecord>();

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
        queueEvent({
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

      // A manual route is authoritative over every prior active generation.
      // Cancelling each old step and persisting its worker's stop predicate in
      // this same write transaction closes both directions of the race: neither
      // a late backend response nor a controller crash can leave the abandoned
      // worker looking owned by the new route.
      const abandonedSteps = this.store
        .listFlowStepInstances(instance.flow_instance_id)
        .filter((step) => step.status === "active");
      const abandonedStepIds = new Set(
        abandonedSteps.map((step) => step.step_instance_id)
      );
      for (const activeStep of abandonedSteps) {
        this.store.updateFlowStepInstance(activeStep.step_instance_id, {
          status: "cancelled",
          summary: `Superseded by manual start of ${input.stepId}.`,
          completedAt: nowIso()
        });
        if (
          activeStep.agent_id &&
          activeStep.agent_id !== retainedAgentId &&
          !this.agentHasOtherActiveFlowOwnership(
            activeStep.agent_id,
            instance.run_id,
            abandonedStepIds
          ) &&
          !cleanupTargets.has(activeStep.agent_id)
        ) {
          const candidate = this.getAgent(activeStep.agent_id);
          if (!TERMINAL_STATUSES.has(candidate.status)) {
            cleanupTargets.set(
              activeStep.agent_id,
              this.prepareAbandonedFlowWorkerCleanupInTransaction(candidate, queueEvent)
            );
          }
        }
      }

      const active = this.activateFlowStep(flow.config, instance, input.stepId, {
        // A manual route is also the coordinator's handoff boundary. Preserve the
        // complete decision context so a retried worker receives clarified user
        // answers or concrete corrections instead of repeating work from the
        // unchanged run title alone.
        coordinatorContext: input.reason ?? null,
        eventSink: queueEvent
      });
      return {
        result: {
          ...this.getFlowSnapshot(instance.flow_instance_id),
          selected_transition: transitionRecord,
          active_step: active.status === "active" ? active : null,
          notification: active.status === "blocked" ? "blocked" : null
        },
        cleanupTargets: [...cleanupTargets.values()]
      };
    });
    for (const event of pendingEvents) {
      this.scheduleEventDelivery(event);
    }
    const stoppedWorkers = await Promise.all(
      transition.cleanupTargets.map((agent) => this.stopAgent(agent.agent_id))
    );
    const cleanup: FlowStepCleanupResult[] = stoppedWorkers.map((stopped) => {
      const action = stopped.orchestrator_action ?? null;
      return {
        agent_id: stopped.agent_id,
        status: stopped.status,
        failure_reason: stopped.failure_reason,
        orchestrator_action: action
      };
    });
    return {
      ...transition.result,
      cleanup
    };
  }

  /** Resolve the one persistent worker that the manually selected step retains. */
  private manualRouteRetainedAgentId(
    flow: FlowRecord,
    instance: FlowInstanceRecord,
    stepId: string
  ): string | null {
    const stepConfig = flow.config.steps[stepId];
    if (stepConfig.agent_id) {
      return stepConfig.agent_id;
    }
    const roleConfig = stepConfig.role ? flow.config.roles?.[stepConfig.role] : undefined;
    if (resolveFlowAgentLifecycle(roleConfig?.agent_lifecycle) !== "reuse") {
      return null;
    }
    if (flow.config.policy?.strict) return this.flowRuntime.get(instance.flow_instance_id)?.owners[stepConfig.role ?? stepId] ?? null;
    return (
      this.findDeclaredFlowAgent(
        instance.run_id,
        flow.flow_id,
        stepConfig.role,
        roleConfig?.backend
      )?.agent_id ?? null
    );
  }

  /** Do not stop a reusable worker that another concurrently active flow owns. */
  private agentHasOtherActiveFlowOwnership(
    agentId: string,
    runId: string,
    abandonedStepIds: ReadonlySet<string>
  ): boolean {
    return this.store
      .listFlowInstances({ runId })
      .filter((flowInstance) => flowInstance.status === "active")
      .flatMap((flowInstance) =>
        this.store.listFlowStepInstances(flowInstance.flow_instance_id)
      )
      .some(
        (step) =>
          step.agent_id === agentId &&
          step.status === "active" &&
          !abandonedStepIds.has(step.step_instance_id)
      );
  }

  /**
   * Persist cleanup authority for an abandoned worker while the manual route's
   * BEGIN IMMEDIATE reservation is still held. External adapter I/O happens only
   * after commit, but every restart can recover from the durable `stopping`
   * state (or the atomically terminal handleless/prepared state).
   */
  private prepareAbandonedFlowWorkerCleanupInTransaction(
    candidate: AgentRecord,
    eventSink: (event: ControllerEventInput) => void
  ): AgentRecord {
    let agent = candidate;
    const adapter = this.adapters.get(agent.backend);
    if (adapter.capabilities().requiresOrchestratorAction) {
      agent = this.recoverCodexSubagentSpawnHandle(agent);
      return this.prepareCodexSubagentStopInTransaction(agent, {
        scope: "flow_route",
        recordStopIntent: true
      }).agent;
    }
    if (!agent.backend_handle) {
      const recoveredHandle = this.recoverBackendHandle(agent);
      if (recoveredHandle) {
        agent = this.store.updateAgent(agent.agent_id, {
          backendHandle: recoveredHandle
        });
      }
    }
    if (!agent.backend_handle) {
      return this.prepareHandlelessNonNativeStartStopInTransaction(
        agent.agent_id,
        eventSink
      ).agent;
    }
    return this.store.updateAgent(agent.agent_id, {
      status: "stopping",
      failureReason: agent.failure_reason
    });
  }

  async dispatchActiveFlowStep(input: {
    flowInstanceId: string;
    subscriberAgentId?: string | null;
    server?: string | null;
    agentToken?: string | null;
    bridgeToken?: string | null;
  }): Promise<FlowDispatchActiveResult> {
    const snapshot = this.getFlowSnapshot(input.flowInstanceId);
    const nativeFlowBridgeGrant = flowUsesCodexSubagents(snapshot.flow.config)
      ? this.resolveNativeFlowBridgeGrant(snapshot.instance)
      : null;

    const activeStep = this.activeFlowStepOrThrow(snapshot, input.flowInstanceId);
    if (snapshot.flow.config.steps[activeStep.step_id].execution === "coordinator") throw new ControllerError("This phase is waiting for the coordinator; it does not launch a worker.", "tool_error");
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
    const bridgeGrant = input.bridgeToken
      ? this.requireBridgeToken(input.bridgeToken, {
          runId: snapshot.instance.run_id,
          orchestratorAgentId: snapshot.instance.orchestrator_agent_id,
          bridgeGrantId: nativeFlowBridgeGrant?.bridge_grant_id ?? null
        })
      : null;
    if (!caller && !bridgeGrant) {
      throw new ControllerError("flow_dispatch_active requires agent_token, bridge_token, or subscriber_agent_id.", "auth_required", {
        flow_instance_id: input.flowInstanceId
      });
    }
    if (caller && !this.canAgentAccessRun(caller, snapshot.instance.run_id)) {
      throw new ControllerError(`Run not accessible: ${snapshot.instance.run_id}`, "auth_required", {
        run_id: snapshot.instance.run_id
      });
    }
    // Keep authorization precedence at the public boundary; the internal
    // dispatcher repeats this policy check immediately before any mutation.
    this.assertNewWorkAllowed(snapshot.instance.run_id, "flow_dispatch_active");

    const dispatched = await this.dispatchActiveFlowStepInternal({
      snapshot,
      activeStep,
      subscriberAgentId: input.subscriberAgentId ?? null,
      server: input.server ?? null,
      agentToken: input.agentToken ?? null,
      bridgeGrantId: bridgeGrant?.bridge_grant_id ?? null
    });
    if (bridgeGrant && dispatched.orchestrator_action) {
      this.assertOrchestratorActionGrant(
        dispatched.orchestrator_action,
        bridgeGrant.bridge_grant_id
      );
    }
    return dispatched;
  }

  async continueFlow(input: {
    flowInstanceId: string;
    subscriberAgentId?: string | null;
    server?: string | null;
    agentToken?: string | null;
    bridgeToken?: string | null;
  }): Promise<FlowContinueResult> {
    const snapshot = this.getFlowSnapshot(input.flowInstanceId);
    const nativeFlowBridgeGrant = flowUsesCodexSubagents(snapshot.flow.config)
      ? this.resolveNativeFlowBridgeGrant(snapshot.instance)
      : null;
    const bridgeGrant = input.bridgeToken
      ? this.requireBridgeToken(input.bridgeToken, {
          runId: snapshot.instance.run_id,
          orchestratorAgentId: snapshot.instance.orchestrator_agent_id,
          bridgeGrantId: nativeFlowBridgeGrant?.bridge_grant_id ?? null
        })
      : null;
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
    if (
      flowUsesCodexSubagents(snapshot.flow.config) &&
      !bridgeGrant &&
      !input.agentToken &&
      !input.subscriberAgentId
    ) {
      throw new ControllerError("A codex-subagent flow continuation requires its scoped bridge token.", "auth_required", {
        flow_instance_id: input.flowInstanceId
      });
    }
    const continued = await this.continueFlowInternal({
      flowInstanceId: input.flowInstanceId,
      subscriberAgentId: input.subscriberAgentId ?? null,
      server: input.server ?? null,
      agentToken: input.agentToken ?? null,
      bridgeGrantId: bridgeGrant?.bridge_grant_id ?? null
    });
    if (bridgeGrant && continued.orchestrator_action) {
      this.assertOrchestratorActionGrant(
        continued.orchestrator_action,
        bridgeGrant.bridge_grant_id
      );
    }
    return continued;
  }

  async reportFlowStepAndContinue(input: {
    stepInstanceId: string;
    status: FlowStepInstanceStatus;
    result?: Record<string, unknown>;
    artifacts?: Record<string, string>;
    summary?: string | null;
    server?: string | null;
    autoContinue?: boolean;
    reportToken?: string;
    agentToken?: string;
  }): Promise<FlowStepReportAndContinueResult> {
    const report = this.reportFlowStep(input);
    if (input.autoContinue === false || report.replayed || !report.active_step) {
      return { report, continuation: null };
    }
    const continuation = await this.continueFlowInternal({
      flowInstanceId: report.instance.flow_instance_id,
      server: input.server ?? null
    });
    if (continuation.orchestrator_action) {
      this.notifyFlowOwnerOfNativeAction(report, continuation);
    }
    return { report, continuation };
  }

  private notifyFlowOwnerOfNativeAction(
    report: FlowStepReportResult,
    continuation: FlowContinueResult
  ): void {
    const action = continuation.orchestrator_action;
    const ownerAgentId = report.instance.orchestrator_agent_id;
    if (!action || !ownerAgentId) {
      return;
    }
    if (
      action.run_id !== report.instance.run_id ||
      action.flow_instance_id !== report.instance.flow_instance_id
    ) {
      throw new ControllerError(
        "Automatic continuation returned a native action outside the reported flow.",
        "tool_error",
        {
          action_id: action.action_id,
          flow_instance_id: report.instance.flow_instance_id
        }
      );
    }

    const eventId = `event_${action.action_id.slice("action_".length)}`;
    const existing = this.store.getEvent(eventId);
    if (existing) {
      const durableAction = this.store.getOrchestratorAction(action.action_id);
      if (!durableAction || !this.nativeActionWakeMatches(existing, durableAction)) {
        throw new ControllerError(
          "Native action event id resolved to a conflicting notification.",
          "tool_error",
          { action_id: action.action_id, event_id: eventId }
        );
      }
      this.scheduleEventDelivery(existing);
      return;
    }
    this.ensureFlowOwnerSubscriptions(report.instance.run_id, ownerAgentId);
    this.emit({
      // Action ids and event ids use the same 80-bit random suffix. Mapping the
      // prefix creates one durable wakeup row per action without persisting an
      // additional secret or adding a second mutable notification state.
      eventId,
      runId: report.instance.run_id,
      agentId: report.reported_step.agent_id,
      type: "flow.notification",
      payload: {
        flow_instance_id: report.instance.flow_instance_id,
        step_instance_id: action.step_instance_id,
        step_id: continuation.active_step?.step_id ?? null,
        notify: "orchestrator",
        reason: "native_orchestrator_action_required",
        status: action.status,
        message: `Native orchestrator action ${action.action_id} (${action.operation}) is required to continue the flow.`,
        orchestrator_action: action
      }
    });
  }

  /**
   * Wake the flow owner for a native interrupt created while abandoning a
   * manually superseded step. The deterministic event id makes retries and
   * controller restarts reuse one safe notification without exposing the
   * private interrupt target or any bridge/action credential.
   */
  private notifyFlowOwnerOfNativeCleanupAction(
    instance: FlowInstanceRecord,
    abandonedStep: FlowStepInstanceRecord,
    action: OrchestratorActionRef
  ): void {
    const ownerAgentId = instance.orchestrator_agent_id;
    if (!ownerAgentId) {
      return;
    }
    if (
      action.run_id !== instance.run_id ||
      action.flow_instance_id !== instance.flow_instance_id ||
      action.agent_id !== abandonedStep.agent_id
    ) {
      throw new ControllerError(
        "Manual route cleanup returned a native action outside the abandoned flow step.",
        "tool_error",
        {
          action_id: action.action_id,
          flow_instance_id: instance.flow_instance_id,
          step_instance_id: abandonedStep.step_instance_id
        }
      );
    }
    const eventId = `event_${action.action_id.slice("action_".length)}`;
    const existing = this.store.getEvent(eventId);
    if (existing) {
      const durableAction = this.store.getOrchestratorAction(action.action_id);
      if (!durableAction || !this.nativeActionWakeMatches(existing, durableAction)) {
        throw new ControllerError(
          "Native cleanup action event id resolved to a conflicting notification.",
          "tool_error",
          { action_id: action.action_id, event_id: eventId }
        );
      }
      this.scheduleEventDelivery(existing);
      return;
    }
    this.ensureFlowOwnerSubscriptions(instance.run_id, ownerAgentId);
    this.emit({
      eventId,
      runId: instance.run_id,
      agentId: abandonedStep.agent_id,
      type: "flow.notification",
      payload: {
        flow_instance_id: instance.flow_instance_id,
        step_instance_id: action.step_instance_id,
        step_id: abandonedStep.step_id,
        notify: "orchestrator",
        reason: "native_orchestrator_action_required",
        status: action.status,
        message: `Native orchestrator action ${action.action_id} (${action.operation}) is required to clean a manually superseded flow worker.`,
        orchestrator_action: action
      }
    });
  }

  /** Recover flow context for interrupt actions created by stop/restart paths. */
  private notifyFlowOwnerOfNativeCleanupActionRef(
    action: OrchestratorActionRef
  ): void {
    if (
      action.operation !== "interrupt_agent" ||
      !action.flow_instance_id ||
      !action.step_instance_id
    ) {
      return;
    }
    const instance = this.store.getFlowInstance(action.flow_instance_id);
    const step = this.store.getFlowStepInstance(action.step_instance_id);
    if (
      !instance ||
      !step ||
      !step.summary?.startsWith("Superseded by manual start of ")
    ) {
      return;
    }
    this.notifyFlowOwnerOfNativeCleanupAction(instance, step, action);
  }

  private async dispatchActiveFlowStepInternal(input: {
    snapshot: FlowSnapshot;
    activeStep: FlowStepInstanceRecord;
    subscriberAgentId?: string | null;
    server?: string | null;
    agentToken?: string | null;
    bridgeGrantId?: string | null;
  }): Promise<FlowDispatchActiveResult> {
    const snapshot = input.snapshot;
    const activeStep = input.activeStep;
    const flowBridgeGrant = flowUsesCodexSubagents(snapshot.flow.config)
      ? this.resolveNativeFlowBridgeGrant(
          snapshot.instance,
          input.bridgeGrantId ?? null
        )
      : null;
    this.assertNewWorkAllowed(snapshot.instance.run_id, "flow_dispatch_active");
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
    if (stepConfig.sandbox === "read_only" && backend !== "codex-thread") throw new ControllerError("This backend cannot enforce the configured read-only step sandbox.", "unsupported_operation");
    this.adapters.get(backend);
    const run = this.getRun(snapshot.instance.run_id);
    const expectedArtifacts = expectedArtifactsFromStep(activeStep);
    const lifecycle = resolveFlowAgentLifecycle(roleConfig?.agent_lifecycle);
    const resolved = this.resolveFlowStepDispatchAgent({
      snapshot,
      activeStep,
      run,
      backend,
      agentToken: input.agentToken ?? null
    });
    const freshStartEvidence =
      lifecycle === "fresh_per_step"
        ? this.resolveFreshFlowStepStartEvidence(
            resolved.agent.agent_id,
            resolved.step.step_instance_id
          )
        : null;
    const registered = freshStartEvidence?.agent ?? resolved.agent;
    let effectiveStartAttempt = freshStartEvidence?.startAttempt ?? null;
    let responseStep = resolved.step;
    if (freshStartEvidence?.startAttempt?.phase === "ambiguous") {
      const ambiguity = this.blockFlowStepForAmbiguousStart(
        resolved.step,
        registered,
        freshStartEvidence.startAttempt
      );
      responseStep = ambiguity.step;
      effectiveStartAttempt = ambiguity.attempt;
    }
    if (
      freshStartEvidence?.startAttempt?.phase === "cancelled" ||
      freshStartEvidence?.startAttempt?.phase === "failed"
    ) {
      const terminal = this.blockFlowStepForTerminalStartAttempt(
        resolved.step,
        registered,
        freshStartEvidence.startAttempt
      );
      const terminalState = terminal.blocked
        ? startStateFromAttemptPhase(terminal.attempt.phase)
        : "superseded";
      return {
        flow_instance_id: snapshot.instance.flow_instance_id,
        step: {
          step_instance_id: terminal.step.step_instance_id,
          step_id: terminal.step.step_id,
          status: terminal.step.status,
          agent_id: terminal.step.agent_id
        },
        agent: {
          agent_id: terminal.agent.agent_id,
          run_id: terminal.agent.run_id,
          backend: terminal.agent.backend,
          title: terminal.agent.title,
          role: terminal.agent.role,
          status: terminal.agent.status,
          failure_reason: terminal.agent.failure_reason
        },
        subscriptions: [],
        expected_artifacts: expectedArtifacts,
        prompt_size: 0,
        orchestrator_action: null,
        start_state: terminalState
      };
    }
    // Recheck stop authority after resolving the durable assignment and before
    // creating relationships or starting backend work. The assignment helper
    // performs the same check while holding the write reservation.
    this.assertNewWorkAllowed(run.run_id, "flow_dispatch_active", registered);
    const subscriber = input.subscriberAgentId ? this.getAgent(input.subscriberAgentId) : null;
    // Automatic continuation has no worker token or explicit subscriber. A
    // fresh step still belongs to the flow owner, so recover that durable
    // owner from the flow instance instead of dropping its relationships.
    const owner =
      subscriber ??
      (lifecycle === "fresh_per_step" && snapshot.instance.orchestrator_agent_id
        ? this.getAgent(snapshot.instance.orchestrator_agent_id)
        : null);
    if (owner && owner.agent_id !== registered.agent_id) {
      this.createAgentLinkIfMissing({
        runId: registered.run_id,
        sourceAgentId: owner.agent_id,
        targetAgentId: registered.agent_id,
        type: "parent_child",
        label: stepConfig.role ?? null
      });
    }
    if (lifecycle === "fresh_per_step") {
      this.createFreshFlowStepHandoffLinks({
        snapshot,
        activeStep: resolved.step,
        agent: registered,
        owner
      });
    }
    const subscriptions: SubscriptionRecord[] = [];
    if (owner && owner.agent_id !== registered.agent_id) {
      for (const eventType of ["agent.completed", "agent.failed", "agent.blocked", "agent.stopped"] as EventType[]) {
        subscriptions.push(
          this.createSubscriptionIfMissing({
            runId: run.run_id,
            sourceAgentId: registered.agent_id,
            subscriberAgentId: owner.agent_id,
            eventType
          })
        );
      }
    }
    const shouldStart = lifecycle !== "fresh_per_step" || !freshStartEvidence?.hasDurableStartEvidence;
    // Rebuild the prompt on normal replays to preserve response diagnostics,
    // but never let a later missing prompt file hide an already-durable action
    // or session. When work still needs to start, construction remains a hard
    // gate and a failure leaves the assigned fresh worker eligible for retry.
    let prompt: string | null = null;
    try {
      prompt = this.buildActiveFlowWorkerPrompt(resolved.step);
    } catch (error) {
      if (shouldStart) {
        throw error;
      }
    }

    let started: AgentStartResult;
    if (!shouldStart) {
      // An assignment is not start evidence: a process can die after assigning
      // the fresh worker but before prompt construction or backend dispatch.
      // Only the evidence resolved above makes a replay idempotent. Surface an
      // open native action exactly; all other evidence preserves the agent as-is.
      started = freshStartEvidence?.openAction
        ? {
            ...this.getAgent(registered.agent_id),
            orchestrator_action: orchestratorActionRef(freshStartEvidence.openAction)
          }
        : this.getAgent(registered.agent_id);
    } else {
      started = await this.startAgent({
        agentId: registered.agent_id,
        prompt: prompt!,
        server: backend === CODEX_SUBAGENT_BACKEND ? undefined : input.server ?? (backend === "opencode-server" ? defaultOpenCodeServer() : undefined),
        model: roleConfig?.model ?? undefined,
        expectedArtifacts,
        metadata: {
          flow_instance_id: snapshot.instance.flow_instance_id,
          step_instance_id: activeStep.step_instance_id,
          step_id: activeStep.step_id,
          ...(stepConfig.sandbox ? { sandbox: stepConfig.sandbox, flow_writable_root: runRuntimeDir(snapshot.instance.run_id) } : {}),
          ...(roleConfig?.reasoning_effort ? { reasoning_effort: roleConfig.reasoning_effort } : {})
        },
        agentToken: input.agentToken,
        bridgeGrantId:
          flowBridgeGrant?.bridge_grant_id ?? input.bridgeGrantId ?? null,
        forkTurns: roleConfig?.backend_options?.codex_subagent?.fork_turns
      });
    }
    if (started.start_state === "ambiguous" && lifecycle === "fresh_per_step") {
      const ambiguousAttempt = this.store.resolveAgentStartAttempt(
        registered.agent_id,
        resolved.step.step_instance_id
      );
      if (ambiguousAttempt?.phase === "ambiguous") {
        const ambiguity = this.blockFlowStepForAmbiguousStart(
          resolved.step,
          this.getAgent(registered.agent_id),
          ambiguousAttempt
        );
        responseStep = ambiguity.step;
        effectiveStartAttempt = ambiguity.attempt;
        if (!ambiguity.blocked && ambiguity.attempt?.phase === "succeeded") {
          started = { ...this.getAgent(registered.agent_id), start_state: "started" };
        }
      }
    }
    if (
      lifecycle === "fresh_per_step" &&
      (started.start_state === "cancelled" || started.start_state === "failed")
    ) {
      const terminalAttempt = this.store.getAgentStartAttemptForStep(
        registered.agent_id,
        resolved.step.step_instance_id
      );
      if (
        terminalAttempt?.phase === "cancelled" ||
        terminalAttempt?.phase === "failed"
      ) {
        const terminal = this.blockFlowStepForTerminalStartAttempt(
          resolved.step,
          this.getAgent(registered.agent_id),
          terminalAttempt
        );
        responseStep = terminal.step;
        effectiveStartAttempt = terminal.attempt;
        started = {
          ...terminal.agent,
          start_state: terminal.blocked
            ? startStateFromAttemptPhase(terminal.attempt.phase)
            : "superseded"
        };
      }
    }
    const agent = "agent_token" in started
      ? (({ agent_token: _agentToken, ...safeAgent }) => safeAgent)(started)
      : started;

    return {
      flow_instance_id: snapshot.instance.flow_instance_id,
      step: {
        step_instance_id: responseStep.step_instance_id,
        step_id: responseStep.step_id,
        status: responseStep.status,
        agent_id: responseStep.agent_id
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
      prompt_size: prompt?.length ?? 0,
      orchestrator_action:
        "orchestrator_action" in started ? started.orchestrator_action ?? null : null,
      start_state:
        "start_state" in started
          ? started.start_state ?? null
          : effectiveStartAttempt
            ? startStateFromAttemptPhase(effectiveStartAttempt.phase)
            : null
    };
  }

  /** Repair only the old report/activation gap; never replay a worker or upgrade a legacy approval. */
  private recoverLegacyCompletedFlowStep(flowInstanceId: string): boolean {
    return this.store.immediateTransaction(() => {
      const snapshot = this.getFlowSnapshot(flowInstanceId);
      if (snapshot.flow.config.policy?.strict || snapshot.instance.status !== "active" || snapshot.steps.some(step => step.status === "active")) return false;
      const step = snapshot.steps.at(-1);
      if (!step || step.status !== "completed") return false;
      const report = snapshot.reports.filter(item => item.step_instance_id === step.step_instance_id).at(-1);
      if (!report || report.status !== "completed" || !stableJsonEquals(report.result_json, step.result_json)) return false;
      const action = resolveStepEventAction(snapshot.flow.config.steps[step.step_id], "completed");
      if (!action) return false;
      const context = { ...this.flowConditionContext(snapshot.instance), status: "completed", result: step.result_json, step: { id: step.step_id, instance_id: step.step_instance_id } };
      const selected = action.transitions ? selectTransition(action, context) : null;
      if (action.transitions && !selected) return false;
      const selectedAction = selected ?? action;
      const prior = snapshot.transitions.filter(item => item.from_step_instance_id === step.step_instance_id).at(-1);
      if (prior) {
        // A persisted transition is authority only when it exactly matches the
        // original flow config and the committed report; a manual route is not
        // guessed or replayed as an automatic transition after interruption.
        if (prior.action_json.manual || !stableJsonEquals(prior.action_json, selectedAction) || !selectedAction.to || prior.target_step_id !== selectedAction.to) return false;
        if (snapshot.steps.some(item => item.created_at > step.created_at)) return false;
        const state = this.flowRuntime.get(flowInstanceId) ?? this.flowRuntime.initialize(flowInstanceId, snapshot.flow.config);
        state.correction = { from_step_id: step.step_id, from_step_instance_id: step.step_instance_id, status: step.status, result: step.result_json, summary: report.summary, artifacts: step.output_json, transition_id: prior.transition_id };
        state.revision += 1;
        this.flowRuntime.save(flowInstanceId, state);
        this.activateFlowStep(snapshot.flow.config, snapshot.instance, selectedAction.to);
      } else {
        this.advanceFlowAfterStep(snapshot.flow.config, snapshot.instance, step, step.result_json);
      }
      this.emit({ runId: snapshot.instance.run_id, type: "flow.notification", payload: { flow_instance_id: flowInstanceId, from_step_instance_id: step.step_instance_id, reason: "interrupted_transition_recovered", target_step_id: selectedAction.to ?? null, summary: "Recovered the committed step handoff without repeating its worker." } });
      return true;
    });
  }

  private async continueFlowInternal(input: {
    flowInstanceId: string;
    subscriberAgentId?: string | null;
    server?: string | null;
    agentToken?: string | null;
    bridgeGrantId?: string | null;
  }): Promise<FlowContinueResult> {
    const snapshot = this.getFlowSnapshot(input.flowInstanceId);
    const instance = snapshot.instance;
    if (flowUsesCodexSubagents(snapshot.flow.config)) {
      // Continuation may block a step, refresh lifecycle state, assign a
      // worker, or create an action. Reject a token from another task binding
      // before any of those durable effects can happen.
      this.resolveNativeFlowBridgeGrant(instance, input.bridgeGrantId ?? null);
    }
    if (instance.status === "waiting_for_orchestrator") {
      return this.flowContinuationResult(snapshot, "waiting_for_orchestrator", {
        notification: "orchestrator"
      });
    }
    if (instance.status === "blocked") {
      const blockedStep = snapshot.steps.find(
        (step) => step.status === "blocked" && step.step_id === instance.current_step_id
      );
      if (blockedStep?.agent_id) {
        const attempt = this.store.resolveAgentStartAttempt(
          blockedStep.agent_id,
          blockedStep.step_instance_id
        );
        if (
          attempt?.phase === "ambiguous" &&
          blockedStep.summary?.startsWith(`Backend start attempt ${attempt.start_attempt_id} `)
        ) {
          return this.flowContinuationResult(snapshot, "blocked", {
            activeStep: blockedStep,
            agent: this.getAgent(blockedStep.agent_id),
            blockedReason: "backend_start_ambiguous",
            notification: "automatic_backend_start_retry_disabled"
          });
        }
        if (
          (attempt?.phase === "cancelled" || attempt?.phase === "failed") &&
          blockedStep.summary?.startsWith(
            `Backend start attempt ${attempt.start_attempt_id} ${attempt.phase} `
          )
        ) {
          return this.flowContinuationResult(snapshot, "blocked", {
            activeStep: blockedStep,
            agent: this.getAgent(blockedStep.agent_id),
            blockedReason: `backend_start_${attempt.phase}`
          });
        }
      }
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
      if (this.recoverLegacyCompletedFlowStep(instance.flow_instance_id)) return this.continueFlowInternal(input);
      return this.flowContinuationResult(snapshot, "no_active_step", {
        blockedReason: "no_active_step"
      });
    }

    const run = this.getRun(instance.run_id);
    const activeStepConfig = snapshot.flow.config.steps[activeStep.step_id];
    if (activeStepConfig.execution === "coordinator") return this.flowContinuationResult(snapshot, "waiting_for_orchestrator", { activeStep, notification: "coordinator_gate" });
    const activeStepBackend = activeStepConfig?.role
      ? snapshot.flow.config.roles?.[activeStepConfig.role]?.backend
      : null;
    const activeStepLifecycle = resolveFlowAgentLifecycle(
      activeStepConfig?.role
        ? snapshot.flow.config.roles?.[activeStepConfig.role]?.agent_lifecycle
        : undefined
    );
    const freshStartEvidence =
      activeStep.agent_id && activeStepLifecycle === "fresh_per_step"
        ? this.resolveFreshFlowStepStartEvidence(
            activeStep.agent_id,
            activeStep.step_instance_id
          )
        : null;
    if (freshStartEvidence?.startAttempt?.phase === "ambiguous") {
      const ambiguity = this.blockFlowStepForAmbiguousStart(
        activeStep,
        freshStartEvidence.agent,
        freshStartEvidence.startAttempt
      );
      if (!ambiguity.blocked) {
        // The original lease owner committed a valid handle between evidence
        // resolution and the blocking CAS. Re-read instead of publishing a
        // stale ambiguity or suppressing the now-running worker.
        return this.continueFlowInternal(input);
      }
      return this.flowContinuationResult(this.getFlowSnapshot(input.flowInstanceId), "blocked", {
        activeStep: ambiguity.step,
        agent: freshStartEvidence.agent,
        blockedReason: "backend_start_ambiguous"
      });
    }
    if (
      freshStartEvidence?.startAttempt?.phase === "cancelled" ||
      freshStartEvidence?.startAttempt?.phase === "failed"
    ) {
      const terminal = this.blockFlowStepForTerminalStartAttempt(
        activeStep,
        freshStartEvidence.agent,
        freshStartEvidence.startAttempt
      );
      if (!terminal.blocked) {
        return this.continueFlowInternal(input);
      }
      return this.flowContinuationResult(
        this.getFlowSnapshot(input.flowInstanceId),
        "blocked",
        {
          activeStep: terminal.step,
          agent: terminal.agent,
          blockedReason: `backend_start_${terminal.attempt.phase}`
        }
      );
    }
    const startAttemptInProgress = Boolean(
      freshStartEvidence?.startAttempt &&
        (freshStartEvidence.startAttempt.phase === "invoking" ||
          (freshStartEvidence.startAttempt.phase === "prepared" &&
            Date.parse(freshStartEvidence.startAttempt.lease_expires_at) > Date.now()))
    );
    const shouldRecoverFreshStart = Boolean(
      activeStep.agent_id &&
      activeStepLifecycle === "fresh_per_step" &&
      !freshStartEvidence?.hasDurableStartEvidence
    );
    let prospectiveAgent: AgentRecord | null = null;
    if (activeStep.agent_id) {
      prospectiveAgent = freshStartEvidence?.agent ?? this.getAgent(activeStep.agent_id);
    } else if (
      activeStepConfig &&
      activeStepLifecycle === "reuse"
    ) {
      prospectiveAgent = this.findDeclaredFlowAgent(
        run.run_id,
        snapshot.flow.flow_id,
        activeStepConfig.role,
        activeStepBackend
      );
    }
    // An assigned worker with durable start evidence is handled below by the
    // established report/terminal contract. A fresh assignment without that
    // evidence is about to retry new work, so its own stop intent must block
    // dispatch just like a reusable declared worker on an unassigned step.
    const stopBlockReason = this.newWorkStopBlockReason(
      run,
      activeStep.agent_id && !shouldRecoverFreshStart ? null : prospectiveAgent
    );
    if (stopBlockReason) {
      if (activeStep.agent_id) {
        const openActions = this.store
          .listOrchestratorActions({ agentId: activeStep.agent_id })
          .filter(
            (action) =>
              action.agent_id === activeStep.agent_id &&
              action.step_instance_id === activeStep.step_instance_id &&
              (action.status === "pending" || action.status === "claimed")
          );
        // Stop intent forbids returning pending work-starting actions for
        // execution. An interrupt remains executable, while an already-claimed
        // action remains visible only so its original owner can finish the ACK
        // cleanup protocol with the token it already holds.
        const cleanupAction =
          openActions.filter((action) => action.operation === "interrupt_agent").at(-1) ??
          openActions
            .filter(
              (action) =>
                action.status === "claimed" && action.operation !== "interrupt_agent"
            )
            .at(-1) ??
          null;
        if (cleanupAction) {
          return this.flowContinuationResult(snapshot, "orchestrator_action_required", {
            activeStep,
            agent: this.getAgent(activeStep.agent_id),
            orchestratorAction: orchestratorActionRef(cleanupAction)
          });
        }
      }
      return this.flowContinuationResult(snapshot, "blocked", {
        activeStep,
        agent: prospectiveAgent,
        blockedReason: stopBlockReason
      });
    }

    if (startAttemptInProgress && activeStep.agent_id) {
      return this.flowContinuationResult(snapshot, "start_in_progress", {
        activeStep,
        agent: prospectiveAgent,
        notification: "backend_start_in_progress"
      });
    }

    if (activeStep.agent_id && !shouldRecoverFreshStart) {
      // Native stop intent is part of flow continuation state as well as the
      // action acknowledgement response. This lets a coordinator recover the
      // exact interrupt after losing an ACK response or restarting, instead of
      // leaving a real late-spawned worker hidden behind `waiting_for_report`.
      const pendingNativeAction = this.store.findOpenOrchestratorAction(activeStep.agent_id, [
        "spawn_agent",
        "send_message",
        "followup_task",
        "interrupt_agent"
      ]);
      if (pendingNativeAction && pendingNativeAction.step_instance_id === activeStep.step_instance_id) {
        return this.flowContinuationResult(snapshot, "orchestrator_action_required", {
          activeStep,
          agent: this.getAgent(activeStep.agent_id),
          orchestratorAction: orchestratorActionRef(pendingNativeAction)
        });
      }
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
            blockedReason: this.workerCapabilityFailure(agent) ? "worker_capability_unavailable" : "terminal_agent_missing_flow_report"
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
      agentToken: input.agentToken ?? null,
      bridgeGrantId: input.bridgeGrantId ?? null
    });
    const dispatchedAgent = this.getAgent(String(dispatch.agent.agent_id));
    const durableDispatchAction = dispatch.orchestrator_action
      ? this.orchestratorActionAfterNewWorkProjection(
          dispatch.orchestrator_action.action_id,
          dispatch.orchestrator_action.agent_id
        ).action
      : null;
    const durableDispatch = {
      ...dispatch,
      orchestrator_action: durableDispatchAction
    };
    if (durableDispatch.start_state === "superseded") {
      const currentSnapshot = this.getFlowSnapshot(input.flowInstanceId);
      return this.flowContinuationResult(currentSnapshot, "start_superseded", {
        activeStep: currentSnapshot.steps.find((step) => step.status === "active") ?? null,
        agent: dispatchedAgent,
        dispatch: durableDispatch,
        notification: "flow_route_advanced_during_backend_start"
      });
    }
    if (
      durableDispatch.start_state === "cancelled" ||
      durableDispatch.start_state === "failed"
    ) {
      const currentSnapshot = this.getFlowSnapshot(input.flowInstanceId);
      return this.flowContinuationResult(currentSnapshot, "blocked", {
        activeStep:
          currentSnapshot.steps.find(
            (step) => step.step_instance_id === activeStep.step_instance_id
          ) ?? null,
        agent: dispatchedAgent,
        dispatch: durableDispatch,
        blockedReason: `backend_start_${durableDispatch.start_state}`
      });
    }
    if (durableDispatch.start_state === "ambiguous") {
      return this.flowContinuationResult(this.getFlowSnapshot(input.flowInstanceId), "blocked", {
        activeStep: this.getFlowStepInstanceOrThrow(activeStep.step_instance_id),
        agent: dispatchedAgent,
        dispatch: durableDispatch,
        blockedReason: "backend_start_ambiguous"
      });
    }
    if (durableDispatch.start_state === "in_progress") {
      return this.flowContinuationResult(
        this.getFlowSnapshot(input.flowInstanceId),
        "start_in_progress",
        {
          activeStep: this.getFlowStepInstanceOrThrow(activeStep.step_instance_id),
          agent: dispatchedAgent,
          dispatch: durableDispatch,
          notification: "backend_start_in_progress"
        }
      );
    }
    if (TERMINAL_STATUSES.has(dispatchedAgent.status) && dispatchedAgent.status !== "completed") {
      const blockedStep = this.blockFlowStepForMissingReport(activeStep, dispatchedAgent);
      return this.flowContinuationResult(this.getFlowSnapshot(input.flowInstanceId), "blocked", {
        activeStep: blockedStep,
        agent: dispatchedAgent,
        dispatch: durableDispatch,
        blockedReason: `agent_start_${dispatchedAgent.status}`
      });
    }
    const postDispatchStopReason = this.newWorkStopBlockReason(
      this.getRun(dispatchedAgent.run_id),
      dispatchedAgent
    );
    if (postDispatchStopReason && !durableDispatchAction) {
      return this.flowContinuationResult(
        this.getFlowSnapshot(input.flowInstanceId),
        "blocked",
        {
          activeStep: this.getFlowStepInstanceOrThrow(activeStep.step_instance_id),
          agent: dispatchedAgent,
          dispatch: durableDispatch,
          blockedReason: postDispatchStopReason
        }
      );
    }
    const orchestratorAction = durableDispatchAction;
    const continuationAction = orchestratorAction
      ? "orchestrator_action_required"
      : dispatchedAgent.backend === CODEX_SUBAGENT_BACKEND
        ? "waiting_for_report"
        : "dispatched";
    return this.flowContinuationResult(
      this.getFlowSnapshot(input.flowInstanceId),
      continuationAction,
      {
        activeStep: this.getFlowStepInstanceOrThrow(activeStep.step_instance_id),
        agent: dispatchedAgent,
        dispatch: durableDispatch,
        orchestratorAction
      }
    );
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
      orchestratorAction?: OrchestratorActionRef | null;
    } = {}
  ): FlowContinueResult {
    const candidateAction =
      options.orchestratorAction ?? options.dispatch?.orchestrator_action ?? null;
    const orchestratorAction = candidateAction
      ? this.orchestratorActionAfterNewWorkProjection(
          candidateAction.action_id,
          candidateAction.agent_id
        ).action
      : null;
    const durableAgent = candidateAction
      ? this.getAgent(candidateAction.agent_id)
      : options.agent ?? null;
    let resolvedAction = action;
    let resolvedBlockedReason = options.blockedReason ?? null;
    if (resolvedAction === "orchestrator_action_required" && !orchestratorAction) {
      const stopReason = durableAgent
        ? this.newWorkStopBlockReason(this.getRun(durableAgent.run_id), durableAgent)
        : null;
      if (stopReason || (durableAgent && TERMINAL_STATUSES.has(durableAgent.status))) {
        resolvedAction = "blocked";
        resolvedBlockedReason =
          stopReason ?? `orchestrator_action_unavailable_agent_${durableAgent!.status}`;
      } else {
        resolvedAction = "waiting_for_report";
      }
    }
    if (resolvedAction === "orchestrator_action_required" && orchestratorAction) {
      // Automatic handoff notifications are durable, but a process can exit
      // after the first delivery attempt. Re-encountering the same open action
      // is therefore a deterministic recovery trigger for its one event row.
      this.redriveNativeActionOwnerWake(orchestratorAction);
    }
    const durableDispatch = options.dispatch
      ? { ...options.dispatch, orchestrator_action: orchestratorAction }
      : null;
    return {
      flow_instance_id: snapshot.instance.flow_instance_id,
      action: resolvedAction,
      instance: snapshot.instance,
      active_step:
        options.activeStep ?? snapshot.steps.find((step) => step.status === "active") ?? null,
      dispatch: durableDispatch,
      agent: durableAgent,
      notification: options.notification ?? null,
      blocked_reason: resolvedBlockedReason,
      orchestrator_action: orchestratorAction
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
      const stepConfig = snapshot.flow.config.steps[activeStep.step_id];
      const roleConfig = stepConfig?.role
        ? snapshot.flow.config.roles?.[stepConfig.role]
        : undefined;
      if (resolveFlowAgentLifecycle(roleConfig?.agent_lifecycle) !== "fresh_per_step") {
        throw new ControllerError("Active flow step already has an assigned agent.", "tool_error", {
          flow_instance_id: flowInstanceId,
          step_instance_id: activeStep.step_instance_id,
          agent_id: activeStep.agent_id
        });
      }
    }
    return activeStep;
  }

  private newWorkStopBlockReason(run: RunRecord, agent?: AgentRecord | null): string | null {
    if (STOP_INTENT_RUN_STATUSES.has(run.status)) {
      return `run_${run.status}_no_new_work`;
    }
    if (agent && STOP_INTENT_AGENT_STATUSES.has(agent.status)) {
      return `agent_${agent.status}_no_new_work`;
    }
    return null;
  }

  private assertNewWorkAllowed(
    runId: string,
    operation: "flow_dispatch_active" | "agent_start" | "agent_send_message",
    agent?: AgentRecord | null
  ): void {
    const run = this.getRun(runId);
    const blockedReason = this.newWorkStopBlockReason(run, agent);
    if (!blockedReason) {
      return;
    }
    throw new ControllerError(
      `Durable stop intent blocks ${operation}; no new work may be started or dispatched.`,
      "tool_error",
      {
        reason: "durable_stop_intent",
        blocked_reason: blockedReason,
        operation,
        run_id: run.run_id,
        run_status: run.status,
        agent_id: agent?.agent_id ?? null,
        agent_status: agent?.status ?? null
      }
    );
  }

  private requireCreatedOrchestratorAction(
    action: OrchestratorActionRecord | null,
    agent: AgentRecord,
    operation: "agent_start" | "agent_send_message" | null
  ): OrchestratorActionRecord {
    if (action) {
      return action;
    }
    const current = this.getAgent(agent.agent_id);
    if (operation) {
      // The SQLite INSERT predicate, rather than this re-read, is the authority.
      // Re-reading only turns its null result into the same stable public error
      // used by the controller's fast preflight path.
      this.assertNewWorkAllowed(current.run_id, operation, current);
    }
    throw new ControllerError(
      "SQLite rejected orchestrator action creation because its durable prerequisites changed.",
      "tool_error",
      {
        agent_id: current.agent_id,
        run_id: current.run_id,
        orchestrator_action_operation: operation
      }
    );
  }

  private orchestratorActionAfterNewWorkProjection(
    actionId: string,
    agentId: string
  ): { agent: AgentRecord; action: OrchestratorActionRef | null } {
    const agent = this.getAgent(agentId);
    const action = this.store.getOrchestratorAction(actionId);
    if (!action || (action.status !== "pending" && action.status !== "claimed")) {
      return { agent, action: null };
    }
    if (
      action.status === "pending" &&
      action.operation !== "interrupt_agent" &&
      this.hasDurableStopIntent(agent)
    ) {
      // A pending work action becomes unclaimable as soon as durable stop wins,
      // even if another process has not yet projected its cancellation into
      // this controller's earlier record. Do not surface it as executable.
      return { agent, action: null };
    }
    return { agent, action: orchestratorActionRef(action) };
  }

  private openOrchestratorActionRef(actionId: string): OrchestratorActionRef | null {
    const action = this.store.getOrchestratorAction(actionId);
    return action && (action.status === "pending" || action.status === "claimed")
      ? orchestratorActionRef(action)
      : null;
  }

  private optionalOpenOrchestratorActionRef(
    action: OrchestratorActionRef | null | undefined
  ): OrchestratorActionRef | undefined {
    return action
      ? this.openOrchestratorActionRef(action.action_id) ?? undefined
      : undefined;
  }

  private workerCapabilityFailure(agent: AgentRecord): string | null {
    const activity = this.readActivity(agent);
    const prefix = "AGENT_CONTROL_BLOCKED:";
    return activity?.kind === "message" && activity.text.startsWith(prefix)
      ? activity.text.slice(prefix.length).trim() || "Required Agent Control tool was unavailable."
      : null;
  }

  /** Backend completion is not a semantic report. Surface a missing handback
   * from status polling too, so an event observer need not call flow_continue. */
  private reconcileTerminalStrictFlowWorker(agent: AgentRecord): void {
    if (!TERMINAL_STATUSES.has(agent.status)) return;
    this.packageRuntime().reconcile(agent);
    for (const instance of this.store.listFlowInstances({ runId: agent.run_id })) {
      if (!this.getFlowOrThrow(instance.flow_record_id).config.policy?.strict) continue;
      for (const step of this.store.listFlowStepInstances(instance.flow_instance_id)) {
        if (step.status !== "active" || step.agent_id !== agent.agent_id) continue;
        if (this.store.listFlowStepReports(instance.flow_instance_id).some(report => report.step_instance_id === step.step_instance_id)) continue;
        this.blockFlowStepForMissingReport(step, agent);
      }
    }
  }

  private blockFlowStepForMissingReport(
    step: FlowStepInstanceRecord,
    agent: AgentRecord
  ): FlowStepInstanceRecord {
    const current = this.getFlowStepInstanceOrThrow(step.step_instance_id);
    if (current.status !== "active") return current;
    const capabilityFailure = this.workerCapabilityFailure(agent);
    const summary = capabilityFailure
      ? `Worker reported an unavailable Agent Control capability: ${capabilityFailure}`
      : `Worker ${agent.agent_id} reached terminal status ${agent.status} without reporting the flow step result.`;
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
        reason: capabilityFailure ? "worker_capability_unavailable" : "terminal_agent_missing_flow_report",
        summary,
        ...(capabilityFailure ? { failure_source: "worker_reported", capability_failure: capabilityFailure } : {}),
        agent_status: agent.status
      }
    });
    return blocked;
  }

  /**
   * Persist the safety stop for an invocation whose backend outcome is
   * unknowable. The attempt id in the summary lets a valid late response from
   * the original lease owner clear only this specific block.
   */
  private blockFlowStepForAmbiguousStart(
    step: FlowStepInstanceRecord,
    agent: AgentRecord,
    attempt: AgentStartAttemptRecord
  ): {
    step: FlowStepInstanceRecord;
    attempt: AgentStartAttemptRecord | null;
    blocked: boolean;
  } {
    const summary = `Backend start attempt ${attempt.start_attempt_id} crossed the invocation boundary but did not persist a valid handle. Automatic retry is disabled to prevent a duplicate backend session.`;
    const transition = this.store.immediateTransaction(() => {
      const currentAttempt = this.store.getAgentStartAttemptForStep(
        attempt.agent_id,
        attempt.step_instance_id,
        attempt.generation
      );
      const currentStep = this.getFlowStepInstanceOrThrow(step.step_instance_id);
      const currentInstance = this.getFlowInstanceOrThrow(step.flow_instance_id);
      if (currentAttempt?.phase !== "ambiguous") {
        return {
          step: currentStep,
          attempt: currentAttempt,
          blocked: false,
          emitted: false
        };
      }
      if (
        currentStep.status === "blocked" &&
        currentStep.summary?.startsWith(
          `Backend start attempt ${currentAttempt.start_attempt_id} `
        )
      ) {
        const stillOwnsFlowBlock =
          currentInstance.status === "blocked" &&
          currentInstance.current_step_id === currentStep.step_id &&
          !this.store.hasFlowStepInstanceAfter(currentStep.step_instance_id) &&
          !this.store
            .listFlowStepInstances(currentStep.flow_instance_id)
            .some((candidate) => candidate.status === "active");
        return {
          step: currentStep,
          attempt: currentAttempt,
          blocked: stillOwnsFlowBlock,
          emitted: false
        };
      }
      if (
        currentStep.status !== "active" ||
        currentInstance.status !== "active" ||
        currentInstance.current_step_id !== currentStep.step_id ||
        this.store.hasFlowStepInstanceAfter(currentStep.step_instance_id) ||
        this.store
          .listFlowStepInstances(currentStep.flow_instance_id)
          .some(
            (candidate) =>
              candidate.step_instance_id !== currentStep.step_instance_id &&
              candidate.status === "active"
          )
      ) {
        return {
          step: currentStep,
          attempt: currentAttempt,
          blocked: false,
          emitted: false
        };
      }
      const blockedStep = this.store.updateFlowStepInstance(step.step_instance_id, {
        status: "blocked",
        summary,
        completedAt: nowIso()
      });
      this.store.updateFlowInstance(step.flow_instance_id, {
        status: "blocked",
        currentStepId: step.step_id
      });
      return {
        step: blockedStep,
        attempt: currentAttempt,
        blocked: true,
        emitted: true
      };
    });
    if (!transition.emitted || !transition.attempt) {
      return transition;
    }
    this.emit({
      runId: agent.run_id,
      agentId: agent.agent_id,
      type: "flow.step_blocked",
      payload: {
        flow_instance_id: step.flow_instance_id,
        step_instance_id: step.step_instance_id,
        step_id: step.step_id,
        reason: "backend_start_ambiguous",
        start_attempt_id: transition.attempt.start_attempt_id,
        attempt_phase: transition.attempt.phase,
        invocation_started_at: transition.attempt.invocation_started_at,
        message: transition.attempt.error_json?.message ?? summary
      }
    });
    return transition;
  }

  /**
   * Project a durable terminal start attempt into visible flow state without
   * invoking the adapter. The active-step ownership predicate and agent
   * terminal projection share one write reservation, so a concurrent manual
   * route either wins completely or leaves one precise blocked step.
   */
  private blockFlowStepForTerminalStartAttempt(
    step: FlowStepInstanceRecord,
    agent: AgentRecord,
    attempt: AgentStartAttemptRecord
  ): {
    step: FlowStepInstanceRecord;
    agent: AgentRecord;
    attempt: AgentStartAttemptRecord;
    blocked: boolean;
  } {
    if (attempt.phase !== "cancelled" && attempt.phase !== "failed") {
      throw new ControllerError(
        "Terminal start blocking requires a cancelled or failed attempt.",
        "tool_error",
        { start_attempt_id: attempt.start_attempt_id, phase: attempt.phase }
      );
    }
    const reason = `backend_start_${attempt.phase}`;
    const summary = `Backend start attempt ${attempt.start_attempt_id} ${attempt.phase} before adapter invocation.`;
    const transition = this.store.immediateTransaction(() => {
      const currentStep = this.getFlowStepInstanceOrThrow(step.step_instance_id);
      const currentAttempt = this.store.getAgentStartAttemptForStep(
        agent.agent_id,
        step.step_instance_id
      );
      const instance = this.getFlowInstanceOrThrow(step.flow_instance_id);
      const currentAgent = this.getAgent(agent.agent_id);
      if (
        currentStep.status !== "active" ||
        instance.status !== "active" ||
        instance.current_step_id !== currentStep.step_id ||
        !currentAttempt ||
        currentAttempt.start_attempt_id !== attempt.start_attempt_id ||
        currentAttempt.phase !== attempt.phase
      ) {
        return {
          step: currentStep,
          agent: currentAgent,
          attempt: currentAttempt ?? attempt,
          blocked: false
        };
      }
      const terminalAgent =
        currentAgent.backend_handle || TERMINAL_STATUSES.has(currentAgent.status)
          ? currentAgent
          : this.store.updateAgent(currentAgent.agent_id, {
              status: attempt.phase === "cancelled" ? "stopped" : "failed",
              failureReason: attempt.phase === "cancelled" ? null : "unknown"
            });
      const blockedStep = this.store.updateFlowStepInstance(step.step_instance_id, {
        status: "blocked",
        summary,
        completedAt: nowIso()
      });
      this.store.updateFlowInstance(step.flow_instance_id, {
        status: "blocked",
        currentStepId: step.step_id
      });
      return {
        step: blockedStep,
        agent: terminalAgent,
        attempt: currentAttempt,
        blocked: true
      };
    });
    if (!transition.blocked) {
      return transition;
    }
    this.emit({
      runId: transition.agent.run_id,
      agentId: transition.agent.agent_id,
      type: "flow.step_blocked",
      payload: {
        flow_instance_id: step.flow_instance_id,
        step_instance_id: step.step_instance_id,
        step_id: step.step_id,
        reason,
        start_attempt_id: transition.attempt.start_attempt_id,
        attempt_phase: transition.attempt.phase,
        message: transition.attempt.error_json?.message ?? summary
      }
    });
    return transition;
  }

  /**
   * Decide whether any completed non-native start still belongs to its flow
   * route. This method runs inside the same BEGIN IMMEDIATE transaction that
   * persists the returned handle, so a manual route and backend response cannot
   * each commit from the same stale flow snapshot. Only a response that crosses
   * the ambiguity boundary may reopen its own exact ambiguity block.
   */
  private reconcileStartFlowOwnershipInTransaction(
    attempt: AgentStartAttemptRecord,
    recoverExactAmbiguityBlock: boolean
  ): {
    outcome: "already_active" | "recovered" | "superseded";
    step: FlowStepInstanceRecord;
    reason: string;
  } {
    const marker = `Backend start attempt ${attempt.start_attempt_id} `;
    const step = this.getFlowStepInstanceOrThrow(attempt.step_instance_id);
    const instance = this.getFlowInstanceOrThrow(attempt.flow_instance_id);
    const laterStepExists = this.store.hasFlowStepInstanceAfter(step.step_instance_id);
    const transitionExists = this.store
      .listFlowTransitions(instance.flow_instance_id)
      .some((transition) => transition.from_step_instance_id === step.step_instance_id);
    const reportExists = this.store
      .listFlowStepReports(instance.flow_instance_id)
      .some((report) => report.step_instance_id === step.step_instance_id);
    const otherActiveStepExists = this.store
      .listFlowStepInstances(instance.flow_instance_id)
      .some(
        (candidate) =>
          candidate.step_instance_id !== step.step_instance_id && candidate.status === "active"
      );
    if (laterStepExists || transitionExists || reportExists || otherActiveStepExists) {
      return {
        outcome: "superseded",
        step,
        reason: laterStepExists
          ? "later_flow_step_exists"
          : transitionExists
            ? "flow_transition_already_selected"
            : reportExists
              ? "flow_step_already_reported"
              : "another_flow_step_is_active"
      };
    }
    if (
      instance.status === "active" &&
      instance.current_step_id === step.step_id &&
      step.status === "active" &&
      step.agent_id === attempt.agent_id
    ) {
      return { outcome: "already_active", step, reason: "original_step_still_active" };
    }
    if (
      !recoverExactAmbiguityBlock ||
      instance.status !== "blocked" ||
      instance.current_step_id !== step.step_id ||
      step.status !== "blocked" ||
      step.agent_id !== attempt.agent_id ||
      !step.summary?.startsWith(marker)
    ) {
      return {
        outcome: "superseded",
        step,
        reason: `flow_${instance.status}_or_block_replaced`
      };
    }
    const recovered = this.store.updateFlowStepInstance(step.step_instance_id, {
      status: "active",
      summary: `Late backend start attempt ${attempt.start_attempt_id} reconciled and resumed.`,
      completedAt: null
    });
    this.store.updateFlowInstance(step.flow_instance_id, {
      status: "active",
      currentStepId: step.step_id
    });
    return { outcome: "recovered", step: recovered, reason: "exact_ambiguity_block_recovered" };
  }

  private emitLateStartFlowRecovery(
    attempt: AgentStartAttemptRecord,
    agent: AgentRecord
  ): void {
    this.emit({
      runId: agent.run_id,
      agentId: agent.agent_id,
      type: "flow.step_started",
      payload: {
        flow_instance_id: attempt.flow_instance_id,
        step_instance_id: attempt.step_instance_id,
        start_attempt_id: attempt.start_attempt_id,
        reason: "late_backend_start_reconciled"
      }
    });
  }

  reportFlowStep(input: {
    stepInstanceId: string; status: FlowStepInstanceStatus; result?: Record<string, unknown>;
    artifacts?: Record<string, string>; summary?: string | null; reportToken?: string; agentToken?: string;
  }): FlowStepReportResult {
    return this.store.immediateTransaction(() => {
      const step = this.getFlowStepInstanceOrThrow(input.stepInstanceId);
      const instance = this.getFlowInstanceOrThrow(step.flow_instance_id);
      const flow = this.getFlowOrThrow(instance.flow_record_id);
      if (flow.config.policy?.strict) {
        const caller = this.flowCaller(input.agentToken, [step.agent_id, ...(flow.config.steps[step.step_id].execution === "coordinator" ? [instance.orchestrator_agent_id] : [])]);
        if (!caller || (caller.agent_id !== step.agent_id && !(flow.config.steps[step.step_id].execution === "coordinator" && caller.agent_id === instance.orchestrator_agent_id))) this.flowRuntime.verifyCapability(step.step_instance_id, input.reportToken);
        const state = this.flowRuntime.get(instance.flow_instance_id)!;
        const decision = flow.config.steps[step.step_id].decision;
        if (decision && !Object.is(state.decisions[decision.key]?.value, input.result?.decision)) throw new ControllerError("Record the configured decision before reporting this gate.", "tool_error");
        if (step.input_json.acceptance_revision !== state.acceptance_revision) throw new ControllerError("The acceptance changed after this step started; route the revised work before reporting.", "tool_error");
        if (step.agent_id && this.getAgent(step.agent_id).unregistered_at) throw new ControllerError("The assigned flow owner is detached.", "tool_error");
      }
      const requestDigest = digest({ status: input.status, result: input.result ?? {}, artifacts: input.artifacts ?? {}, summary: input.summary ?? null });
      const replay = this.flowRuntime.replay<FlowStepReportResult>(input.stepInstanceId, requestDigest);
      if (replay) return { ...replay, replayed: true };
      const response = this.reportFlowStepInTransaction(input);
      this.flowRuntime.recordResponse(input.stepInstanceId, requestDigest, response);
      return response;
    });
  }

  private reportFlowStepInTransaction(input: {
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

    if (flow.config.policy?.strict && input.status === "completed") {
      validateStepResult(stepConfig.report?.schema, result);
      if (flow.config.policy.work_packages?.execution_step === existingStep.step_id && (!flow.config.policy.work_packages.success_condition || evaluateCondition(flow.config.policy.work_packages.success_condition, { result, status: input.status }))) this.packageRuntime().assertJoin(this.packageContext(instance.flow_instance_id));
      if (flow.config.policy.work_packages?.integration_step === existingStep.step_id && (!flow.config.policy.work_packages.success_condition || evaluateCondition(flow.config.policy.work_packages.success_condition, { result, status: input.status }))) this.packageRuntime().assertIntegrated(this.packageContext(instance.flow_instance_id));
      this.assertFlowRequirements(instance, stepConfig, { result, step: existingStep });
    }

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
      if (flow.config.policy?.strict) throw error;
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

  async shutdownRun(runId: string): Promise<RunShutdownResult> {
    const shutdownAgents = this.store.listAgents({ runId });
    this.store.transaction(() => {
      // Persist run-level stop intent in the same write transaction that makes
      // every unclaimed native message action unclaimable. If a claim won the
      // race first, the affected worker is marked stopping so its later ACK is
      // reconciled as uncertain work followed by one deterministic interrupt.
      this.store.updateRunStatus(runId, "stopping");
      for (const agent of shutdownAgents.filter(
        (candidate) => candidate.backend === CODEX_SUBAGENT_BACKEND
      )) {
        this.prepareCodexSubagentStopInTransaction(agent, {
          scope: "run_shutdown",
          recordStopIntent: !TERMINAL_STATUSES.has(agent.status)
        });
      }
    });
    const stopped = await this.stopAgents({ runId, mode: "graceful" });
    const durableStopped = stopped.map((result) => {
      const current = this.getAgent(result.agent_id);
      const action = result.orchestrator_action
        ? this.openOrchestratorActionRef(result.orchestrator_action.action_id)
        : null;
      return action ? { ...current, orchestrator_action: action } : current;
    });
    const orchestratorActions = durableStopped.flatMap((agent) =>
      "orchestrator_action" in agent && agent.orchestrator_action
        ? [agent.orchestrator_action]
        : []
    );
    let pendingAgentIds = this.store
      .listAgents({ runId })
      .filter((agent) => !this.isAttachedParticipant(agent) && !TERMINAL_STATUSES.has(agent.status))
      .map((agent) => agent.agent_id);
    let complete = pendingAgentIds.length === 0;
    let run = this.store.updateRunStatus(runId, complete ? "stopped" : "stopping");
    if (!complete) {
      const finalized = this.finalizeStoppingRunIfTerminal(runId);
      if (finalized) {
        run = finalized;
        pendingAgentIds = [];
        complete = true;
      }
    }
    this.emit({
      runId,
      type: "timer.elapsed",
      payload: {
        action: complete ? "run_shutdown" : "run_shutdown_pending",
        stopped_agents: this.store
          .listAgents({ runId })
          .filter((agent) => TERMINAL_STATUSES.has(agent.status)).length,
        pending_agents: pendingAgentIds.length,
        orchestrator_actions: orchestratorActions.length
      }
    });
    return {
      run,
      stopped: durableStopped,
      orchestrator_actions: orchestratorActions,
      pending_agent_ids: pendingAgentIds,
      complete
    };
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
    if (input.backend === CODEX_SUBAGENT_BACKEND && input.model?.trim()) {
      throw new ControllerError(
        "codex-subagent inherits the root model and does not support model overrides.",
        "unsupported_operation",
        { backend: input.backend, option: "model" }
      );
    }
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
    if (agent.backend === "codex-session" && agent.backend_handle) this.armStatusWatcher(agent);
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

  requireBridgeToken(
    bridgeToken: string | null | undefined,
    binding: {
      runId?: string | null;
      orchestratorAgentId?: string | null;
      bridgeGrantId?: string | null;
    } = {}
  ): BridgeGrantRecord {
    const value = bridgeToken?.trim();
    if (!value) {
      throw new ControllerError("Bridge token is required.", "auth_required");
    }
    const grant = this.store.getBridgeGrantByTokenHash(hashToken(value));
    const expired = grant?.expires_at ? Date.parse(grant.expires_at) <= Date.now() : false;
    if (!grant || grant.revoked_at || expired) {
      throw new ControllerError("Invalid or expired Agent Control bridge token.", "auth_required");
    }
    if (binding.runId && grant.run_id !== binding.runId) {
      throw new ControllerError("Bridge token is scoped to another run.", "auth_required", {
        run_id: binding.runId
      });
    }
    if (
      binding.orchestratorAgentId &&
      grant.orchestrator_agent_id !== binding.orchestratorAgentId
    ) {
      throw new ControllerError("Bridge token is scoped to another orchestrator.", "auth_required", {
        orchestrator_agent_id: binding.orchestratorAgentId
      });
    }
    if (
      binding.bridgeGrantId &&
      grant.bridge_grant_id !== binding.bridgeGrantId
    ) {
      throw new ControllerError(
        "Bridge token belongs to a different bridge task binding.",
        "auth_required",
        {
          bridge_grant_id: binding.bridgeGrantId,
          requested_bridge_grant_id: grant.bridge_grant_id
        }
      );
    }
    this.store.touchBridgeGrant(grant.bridge_grant_id);
    return grant;
  }

  claimOrchestratorAction(input: {
    actionId: string;
    bridgeToken: string;
  }): OrchestratorActionClaimResult {
    const bridgeToken = input.bridgeToken.trim();
    if (!bridgeToken) {
      throw new ControllerError("Bridge token is required.", "auth_required");
    }
    const rawActionToken = generateActionToken();
    const claimedAt = nowIso();
    const leaseExpiresAt = new Date(
      Date.parse(claimedAt) + ORCHESTRATOR_ACTION_CLAIM_LEASE_MS
    ).toISOString();
    const claimed = this.store.claimOrchestratorAction({
      actionId: input.actionId,
      bridgeTokenHash: hashToken(bridgeToken),
      actionTokenHash: hashToken(rawActionToken),
      claimedAt,
      leaseExpiresAt
    });

    if (claimed.type === "authorization_failed") {
      throw new ControllerError(
        "Invalid, expired, revoked, or incorrectly scoped Agent Control bridge token.",
        "auth_required",
        { action_id: input.actionId, reason: claimed.reason }
      );
    }
    if (claimed.type === "already_claimed") {
      return {
        status: "already_claimed",
        action_id: claimed.action.action_id,
        retry_after_ms: Math.max(1, Math.ceil(claimed.retryAfterMs))
      };
    }
    if (claimed.type === "unavailable") {
      const blockedByStopIntent = claimed.reason === "stop_intent";
      throw new ControllerError(
        blockedByStopIntent
          ? "Durable stop intent blocks this work-starting orchestrator action."
          : "Orchestrator action is not claimable.",
        "tool_error",
        {
          action_id: input.actionId,
          status: claimed.action?.status ?? "missing",
          reason: blockedByStopIntent ? "durable_stop_intent" : claimed.reason
        }
      );
    }

    return {
      action_id: claimed.action.action_id,
      action_token: rawActionToken,
      operation: claimed.action.operation,
      backend: CODEX_SUBAGENT_BACKEND,
      run_id: claimed.action.run_id,
      orchestrator_agent_id: claimed.action.orchestrator_agent_id,
      agent_id: claimed.action.agent_id,
      flow_instance_id: claimed.action.flow_instance_id,
      step_instance_id: claimed.action.step_instance_id,
      request: claimed.action.payload_json
    };
  }

  getOrchestratorActionRef(actionId: string): OrchestratorActionRef {
    return orchestratorActionRef(this.getOrchestratorActionOrThrow(actionId));
  }

  getCodexSubagentBridgeScope(agentId: string): {
    run_id: string;
    orchestrator_agent_id: string;
  } {
    const agent = this.getAgent(agentId);
    if (agent.backend !== CODEX_SUBAGENT_BACKEND) {
      throw new ControllerError("Agent does not use the codex-subagent bridge.", "unsupported_operation", {
        agent_id: agent.agent_id,
        backend: agent.backend
      });
    }
    const context = this.bridgeContextForAgent(agent);
    return { run_id: agent.run_id, orchestrator_agent_id: context.orchestratorAgentId };
  }

  acknowledgeOrchestratorAction(input: {
    actionId: string;
    actionToken: string;
    status: "succeeded" | "failed";
    result?: Record<string, unknown> | null;
    error?: Record<string, unknown> | null;
  }): OrchestratorActionAcknowledgementResult {
    const actionTokenHash = hashToken(input.actionToken.trim());
    const result = input.result ?? null;
    const error = input.error ?? null;
    const pendingEvents: EventRecord[] = [];
    const acknowledged = this.store.immediateTransaction(() => {
      const queueEvent = (event: ControllerEventInput): void => {
        pendingEvents.push(this.store.createEvent(event));
      };
      let action = this.getOrchestratorActionOrThrow(input.actionId);
      if (!action.action_token_hash || action.action_token_hash !== actionTokenHash) {
        throw new ControllerError("Invalid or rotated orchestrator action token.", "auth_required", {
          action_id: action.action_id
        });
      }

      let newlyCompleted = false;
      if (action.status === "succeeded" || action.status === "failed") {
        if (
          action.status !== input.status ||
          !stableJsonEquals(action.result_json, result) ||
          !stableJsonEquals(action.error_json, error)
        ) {
          throw new ControllerError(
            "Conflicting acknowledgement for completed orchestrator action.",
            "tool_error",
            {
              action_id: action.action_id,
              current_status: action.status,
              requested_status: input.status
            }
          );
        }
      } else {
        if (action.status !== "claimed") {
          throw new ControllerError(
            "Orchestrator action must be claimed before acknowledgement.",
            "tool_error",
            { action_id: action.action_id, status: action.status }
          );
        }
        if (input.status === "succeeded" && action.operation === "spawn_agent") {
          this.validateSpawnAcknowledgement(action, result, this.getAgent(action.agent_id));
        }
        const completion = this.store.completeOrchestratorAction({
          actionId: action.action_id,
          actionTokenHash,
          status: input.status,
          resultJson: result,
          errorJson: error
        });
        action = completion.action;
        newlyCompleted = completion.changed;
        if (!action.action_token_hash || action.action_token_hash !== actionTokenHash) {
          throw new ControllerError(
            "Invalid or rotated orchestrator action token.",
            "auth_required",
            { action_id: action.action_id }
          );
        }
        if (
          action.status !== input.status ||
          !stableJsonEquals(action.result_json, result) ||
          !stableJsonEquals(action.error_json, error)
        ) {
          throw new ControllerError(
            "Conflicting acknowledgement for completed orchestrator action.",
            "tool_error",
            {
              action_id: action.action_id,
              current_status: action.status,
              requested_status: input.status
            }
          );
        }
      }

      // Completion, causal interpretation, agent projection, optional cleanup
      // creation, and run finalization must commit together. A terminal native
      // sync can now win before this transaction (and be preserved) or after it
      // (and supersede it), but never between the ACK's read and write.
      const applied: {
        agent: AgentRecord;
        orchestratorAction?: OrchestratorActionRef;
      } = newlyCompleted
        ? this.applyOrchestratorActionAcknowledgement(action, queueEvent)
        : (() => {
            const currentAgent = this.getAgent(action.agent_id);
            const replayedAgent = this.followupAcknowledgementStartsNewerTurn(
              action,
              currentAgent
            )
              ? this.applySuccessfulCodexSubagentMessageAcknowledgement(
                  action,
                  queueEvent
                )
              : this.mergeTerminalSpawnAcknowledgement(action, currentAgent);
            return { agent: replayedAgent };
          })();
      const reconciled = this.reconcileAcknowledgedActionStopIntent(
        action,
        applied.agent,
        queueEvent
      );
      if (TERMINAL_STATUSES.has(reconciled.agent.status)) {
        this.finalizeStoppingRunIfTerminal(reconciled.agent.run_id, queueEvent);
      }
      return {
        action,
        agent: reconciled.agent,
        orchestratorAction: reconciled.orchestratorAction ?? applied.orchestratorAction
      };
    });
    for (const event of pendingEvents) {
      this.scheduleEventDelivery(event);
    }
    const agent = this.getAgent(acknowledged.agent.agent_id);
    const cleanupAction = this.optionalOpenOrchestratorActionRef(
      acknowledged.orchestratorAction
    );
    return {
      action: orchestratorActionRef(acknowledged.action),
      agent,
      ...(cleanupAction ? { orchestrator_action: cleanupAction } : {})
    };
  }

  syncCodexSubagent(input: {
    agentId: string;
    bridgeToken: string;
    nativeAgentId?: string | null;
    nativeTaskName?: string | null;
    nativeTaskPath?: string | null;
    nativeStatus:
      | "pending_init"
      | "running"
      | "completed"
      | "interrupted"
      | "shutdown"
      | "errored"
      | "missing";
    latestMessage?: string | null;
    publicActivity?: unknown;
    observedAt?: string | null;
    confirmedAbsent?: boolean;
  }): {
    agent: AgentRecord;
    native_status: string;
    observed_at: string;
    orchestrator_action?: OrchestratorActionRef;
  } {
    const agent = this.getAgent(input.agentId);
    if (input.publicActivity !== undefined && input.publicActivity !== null && !parseActivity(input.publicActivity)) {
      throw new ControllerError("Public activity must be a short public message or tool description.", "tool_error");
    }
    if (agent.backend !== CODEX_SUBAGENT_BACKEND) {
      throw new ControllerError("External native sync requires a codex-subagent agent.", "unsupported_operation", {
        agent_id: agent.agent_id,
        backend: agent.backend
      });
    }
    const context = this.bridgeContextForAgent(agent);
    const bridgeGrant = this.requireBridgeToken(input.bridgeToken, {
      runId: agent.run_id,
      orchestratorAgentId: context.orchestratorAgentId,
      bridgeGrantId: context.originatingBridgeGrantId
    });
    if (bridgeGrant.bridge_grant_id !== context.originatingBridgeGrantId) {
      throw new ControllerError(
        "Native agent belongs to a different bridge task binding.",
        "auth_required",
        {
          agent_id: agent.agent_id,
          originating_bridge_grant_id: context.originatingBridgeGrantId,
          requested_bridge_grant_id: bridgeGrant.bridge_grant_id
        }
      );
    }
    const observedAt = normalizeObservedAt(input.observedAt);
    if (
      input.latestMessage !== undefined &&
      input.latestMessage !== null &&
      Buffer.byteLength(input.latestMessage, "utf8") > MAX_EXTERNAL_LATEST_MESSAGE_BYTES
    ) {
      throw new ControllerError("latest_message exceeds the 4 KiB native sync limit.", "tool_error", {
        agent_id: agent.agent_id,
        max_bytes: MAX_EXTERNAL_LATEST_MESSAGE_BYTES
      });
    }

    const pendingEvents: EventRecord[] = [];
    const synchronized = this.store.immediateTransaction(() => {
      const queueEvent = (event: ControllerEventInput): void => {
        pendingEvents.push(this.store.createEvent(event));
      };
      const current = this.getAgent(agent.agent_id);
      if (current.backend !== CODEX_SUBAGENT_BACKEND) {
        throw new ControllerError(
          "External native sync requires a codex-subagent agent.",
          "unsupported_operation",
          { agent_id: current.agent_id, backend: current.backend }
        );
      }
      const handle = current.backend_handle ?? {};
      assertMatchingNativeIdentity(handle, input);
      const existing = this.store.getCodexSubagentExternalState(current.agent_id);
      const nativeAgentId = input.nativeAgentId ?? recordString(handle, "native_agent_id");
      const nativeTaskName = input.nativeTaskName ?? recordString(handle, "native_task_name");
      const nativeTaskPath =
        input.nativeTaskPath ??
        recordString(handle, "native_task_path") ??
        recordString(handle, "expected_task_path");
      const existingLatestMessage =
        typeof existing?.latest_message === "string" ? existing.latest_message : null;
      const latestMessage =
        input.latestMessage === undefined ? existingLatestMessage : input.latestMessage;
      const existingObservedAt = nullableRecordString(existing, "observed_at");
      if (existingObservedAt) {
        const ordering = Date.parse(observedAt) - Date.parse(existingObservedAt);
        if (ordering < 0) {
          const existingNativeStatus =
            nullableRecordString(existing, "native_status") ?? input.nativeStatus;
          const reconciled = this.reconcileNativeObservationStopIntent(
            current,
            existingNativeStatus,
            existingObservedAt,
            queueEvent
          );
          return {
            agent: reconciled.agent,
            nativeStatus: existingNativeStatus,
            observedAt: existingObservedAt,
            orchestratorAction: reconciled.orchestratorAction
          };
        }
        if (ordering === 0) {
          const sameObservation =
            nullableRecordString(existing, "native_status") === input.nativeStatus &&
            nullableRecordString(existing, "native_agent_id") === (nativeAgentId ?? null) &&
            nullableRecordString(existing, "native_task_name") === (nativeTaskName ?? null) &&
            nullableRecordString(existing, "native_task_path") === (nativeTaskPath ?? null) &&
            existingLatestMessage === (latestMessage ?? null) &&
            (input.publicActivity === undefined || this.samePublicActivity(this.readActivity(current), input.publicActivity));
          if (!sameObservation) {
            throw new ControllerError(
              "Conflicting native observations cannot share the same observed_at timestamp.",
              "tool_error",
              { agent_id: current.agent_id, observed_at: observedAt }
            );
          }
          const reconciled = this.reconcileNativeObservationStopIntent(
            current,
            input.nativeStatus,
            observedAt,
            queueEvent
          );
          return {
            agent: reconciled.agent,
            nativeStatus: input.nativeStatus,
            observedAt: existingObservedAt,
            orchestratorAction: reconciled.orchestratorAction
          };
        }
      }

      const sameMissingIdentity =
        input.nativeStatus === "missing" &&
        existing?.native_status === "missing" &&
        nullableRecordString(existing, "native_agent_id") === (nativeAgentId ?? null) &&
        nullableRecordString(existing, "native_task_path") === (nativeTaskPath ?? null);
      const missingSince =
        input.nativeStatus === "missing"
          ? sameMissingIdentity
            ? nullableRecordString(existing, "missing_since") ?? observedAt
            : observedAt
          : null;
      const missingObservationCount =
        input.nativeStatus === "missing"
          ? sameMissingIdentity
            ? Number(existing?.missing_observation_count ?? 0) + 1
            : 1
          : 0;
      let mapped = mapCodexSubagentStatus(input.nativeStatus);
      if (input.nativeStatus === "missing") {
        const elapsed = Math.max(0, Date.parse(observedAt) - Date.parse(missingSince!));
        const confirmedByRepeatedExactMiss =
          missingObservationCount >= 2 && elapsed >= EXTERNAL_MISSING_CONFIRMATION_MS;
        const confirmedByExplicitCheck =
          Boolean(input.confirmedAbsent) && elapsed >= EXTERNAL_MISSING_CONFIRMATION_MS;
        mapped = {
          status: "unknown",
          failureReason:
            confirmedByRepeatedExactMiss || confirmedByExplicitCheck
              ? "backend_unavailable"
              : null
        };
      }

      const preserveStopIntent =
        !TERMINAL_STATUSES.has(mapped.status) && this.hasDurableStopIntent(current);
      const projectedStatus: AgentStatus = preserveStopIntent ? "stopping" : mapped.status;
      const projectedFailureReason = preserveStopIntent
        ? mapped.failureReason ?? current.failure_reason
        : mapped.failureReason;
      const safeHandle = {
        ...handle,
        ...(nativeAgentId ? { native_agent_id: nativeAgentId } : {}),
        ...(nativeTaskName ? { native_task_name: nativeTaskName } : {}),
        ...(nativeTaskPath ? { native_task_path: nativeTaskPath } : {})
      };
      this.store.upsertCodexSubagentExternalState({
        agentId: current.agent_id,
        nativeAgentId,
        nativeTaskName,
        nativeTaskPath,
        nativeStatus: input.nativeStatus,
        latestMessage,
        observedAt,
        missingSince,
        missingObservationCount
      });
      if (input.publicActivity !== undefined) {
        const activity = parseActivity(input.publicActivity);
        const previous = this.readActivity(current);
        const originalTimestamp = activity?.observed_at ??
          (this.samePublicActivity(previous, activity) ? previous?.observed_at : undefined) ?? observedAt;
        this.saveActivity(current, activity ? { ...activity, observed_at: originalTimestamp } : null);
      }
      const cancelledInterruptActionIds = TERMINAL_STATUSES.has(projectedStatus)
        ? this.cancelPendingCodexSubagentInterruptsForTerminalSync(
            current,
            input.nativeStatus,
            observedAt
          )
        : [];
      const changed =
        current.status !== projectedStatus ||
        current.failure_reason !== projectedFailureReason;
      const updated = this.store.updateAgent(current.agent_id, {
        backendHandle: safeHandle,
        status: projectedStatus,
        failureReason: projectedFailureReason
      });
      this.store.touchHeartbeat(updated.agent_id, observedAt);
      if (changed) {
        queueEvent({
          runId: updated.run_id,
          agentId: updated.agent_id,
          type: this.statusEventType(updated.status),
          payload: {
            status: updated.status,
            failureReason: updated.failure_reason,
            native_status: input.nativeStatus,
            ...(cancelledInterruptActionIds.length > 0
              ? { cancelled_interrupt_action_ids: cancelledInterruptActionIds }
              : {})
          }
        });
      }
      if (TERMINAL_STATUSES.has(updated.status)) {
        this.reconcileTerminalStrictFlowWorker(updated);
        this.finalizeStoppingRunIfTerminal(updated.run_id, queueEvent);
      }
      const reconciled = preserveStopIntent
        ? this.reconcileNativeObservationStopIntent(
            updated,
            input.nativeStatus,
            observedAt,
            queueEvent
          )
        : { agent: updated };
      return {
        agent: reconciled.agent,
        nativeStatus: input.nativeStatus,
        observedAt,
        orchestratorAction: reconciled.orchestratorAction
      };
    });
    for (const event of pendingEvents) {
      this.scheduleEventDelivery(event);
    }
    if (TERMINAL_STATUSES.has(synchronized.agent.status)) {
      this.disarmStatusWatcher(synchronized.agent.agent_id);
    }
    const cleanupAction = this.optionalOpenOrchestratorActionRef(
      synchronized.orchestratorAction
    );
    return {
      agent: synchronized.agent,
      native_status: synchronized.nativeStatus,
      observed_at: synchronized.observedAt,
      ...(cleanupAction
        ? { orchestrator_action: cleanupAction }
        : {})
    };
  }

  private cancelPendingCodexSubagentInterruptsForTerminalSync(
    agent: AgentRecord,
    nativeStatus: string,
    observedAt: string
  ): string[] {
    // Call only inside the terminal-sync BEGIN IMMEDIATE transaction. A claim
    // that committed first remains `claimed` and is retained for idempotent
    // ACK; otherwise this cancellation commits atomically with terminal agent
    // truth, so no pending cleanup can be returned or re-driven afterward.
    const cancelledAt = nowIso();
    return this.store
      .listOrchestratorActions({ agentId: agent.agent_id })
      .filter(
        (action) =>
          action.agent_id === agent.agent_id &&
          action.run_id === agent.run_id &&
          action.operation === "interrupt_agent" &&
          action.status === "pending" &&
          // A cleanup created after the observed terminal instant may protect
          // newer uncertain work and must survive. With an implicit observedAt,
          // call ordering guarantees equality still follows action creation.
          Date.parse(action.created_at) <= Date.parse(observedAt)
      )
      .flatMap((action) => {
        const cancellation = this.store.cancelUnclaimedOrchestratorAction({
          actionId: action.action_id,
          errorJson: {
            reason: "native_terminal_observation_superseded_interrupt",
            native_status: nativeStatus,
            observed_at: observedAt,
            message:
              "Authoritative native terminal status made this unclaimed cleanup interrupt unnecessary."
          },
          cancelledAt
        });
        return cancellation.changed ? [cancellation.action.action_id] : [];
      });
  }

  private assertSupportedCodexSubagentStart(
    agent: AgentRecord,
    input: {
      prompt?: string;
      server?: string;
      model?: string;
      attachments?: string[];
      metadata?: Record<string, unknown>;
      forkTurns?: CodexSubagentForkTurns;
    }
  ): void {
    if (!input.prompt?.trim()) {
      throw new ControllerError("codex-subagent spawn requires a worker message.", "tool_error", {
        agent_id: agent.agent_id
      });
    }
    if (input.model?.trim() || agent.model?.trim()) {
      throw new ControllerError(
        "codex-subagent inherits the root model and does not support model overrides.",
        "unsupported_operation",
        { backend: agent.backend, option: "model" }
      );
    }
    if (input.server?.trim()) {
      throw new ControllerError("codex-subagent does not accept a backend server override.", "unsupported_operation", {
        backend: agent.backend,
        option: "server"
      });
    }
    if (input.attachments && input.attachments.length > 0) {
      throw new ControllerError("codex-subagent does not support attachment overrides.", "unsupported_operation", {
        backend: agent.backend,
        option: "attachments"
      });
    }
    const allowedMetadata = new Set(["flow_instance_id", "step_instance_id", "step_id"]);
    const unsupportedMetadata = Object.keys(input.metadata ?? {}).filter((key) => !allowedMetadata.has(key));
    if (unsupportedMetadata.length > 0) {
      throw new ControllerError("Unsupported codex-subagent start option.", "unsupported_operation", {
        backend: agent.backend,
        options: unsupportedMetadata.sort()
      });
    }
    if (input.forkTurns && !isCodexSubagentForkTurns(input.forkTurns)) {
      throw new ControllerError("Unsupported codex-subagent fork_turns value.", "unsupported_operation", {
        backend: agent.backend,
        fork_turns: input.forkTurns
      });
    }
  }

  private recoverCodexSubagentSpawnHandle(agent: AgentRecord): AgentRecord {
    if (agent.backend_handle) {
      return agent;
    }
    const succeededSpawn = this.store
      .listOrchestratorActions({ agentId: agent.agent_id })
      .filter(
        (action) =>
          action.agent_id === agent.agent_id &&
          action.operation === "spawn_agent" &&
          action.status === "succeeded"
      )
      .at(-1);
    if (!succeededSpawn) {
      return agent;
    }
    // A durable successful spawn ACK already passed identity validation. If a
    // prior controller process stopped between the action commit and handle
    // projection, reconstructing that projection prevents a duplicate native
    // task and lets the next flow step reuse the real worker safely.
    return this.store.updateAgent(agent.agent_id, {
      backendHandle: this.spawnBackendHandle(succeededSpawn, agent)
    });
  }

  private assertCodexSubagentHasNoPriorSpawnForAnotherStep(
    agent: AgentRecord,
    metadata?: Record<string, unknown>
  ): void {
    const stepInstanceId = requiredRecordString(metadata, "step_instance_id");
    const priorSpawn = this.store
      .listOrchestratorActions({ agentId: agent.agent_id })
      .filter(
        (action) =>
          action.agent_id === agent.agent_id &&
          action.operation === "spawn_agent" &&
          // Failed and cancelled actions authoritatively prove that no native
          // worker was created. Pending, claimed, and succeeded actions remain
          // fail-closed because they may already represent a real native task.
          (action.status === "pending" ||
            action.status === "claimed" ||
            action.status === "succeeded")
      )
      .at(-1);
    if (priorSpawn && priorSpawn.step_instance_id !== stepInstanceId) {
      throw new ControllerError(
        "Refusing to spawn a second native task because this declared agent already has a spawn action but no recoverable handle.",
        "tool_error",
        {
          agent_id: agent.agent_id,
          existing_action_id: priorSpawn.action_id,
          existing_step_instance_id: priorSpawn.step_instance_id,
          requested_step_instance_id: stepInstanceId
        }
      );
    }
  }

  private enqueueCodexSubagentSpawn(input: {
    agent: AgentRecord;
    prompt?: string;
    metadata?: Record<string, unknown>;
    bridgeGrantId?: string | null;
    forkTurns?: CodexSubagentForkTurns;
  }): OrchestratorActionRef {
    const flowInstanceId = requiredRecordString(input.metadata, "flow_instance_id");
    const stepInstanceId = requiredRecordString(input.metadata, "step_instance_id");
    const stepId = requiredRecordString(input.metadata, "step_id");
    const instance = this.getFlowInstanceOrThrow(flowInstanceId);
    const step = this.getFlowStepInstanceOrThrow(stepInstanceId);
    if (
      instance.run_id !== input.agent.run_id ||
      step.flow_instance_id !== instance.flow_instance_id ||
      step.agent_id !== input.agent.agent_id
    ) {
      throw new ControllerError("codex-subagent spawn metadata does not match its assigned flow step.", "tool_error", {
        agent_id: input.agent.agent_id,
        flow_instance_id: flowInstanceId,
        step_instance_id: stepInstanceId
      });
    }
    if (!instance.orchestrator_agent_id) {
      throw new ControllerError("Native flow instance has no bound orchestrator.", "auth_required", {
        flow_instance_id: instance.flow_instance_id
      });
    }
    const idempotencyKey = `spawn:${stepInstanceId}`;
    const existingAction = this.store.getOrchestratorActionByIdempotencyKey(idempotencyKey);
    if (existingAction && !existingAction.originating_bridge_grant_id) {
      throw new ControllerError(
        "Existing native action has no provable originating bridge grant.",
        "auth_required",
        { action_id: existingAction.action_id }
      );
    }
    const grant = this.resolveNativeFlowBridgeGrant(
      instance,
      input.bridgeGrantId ?? null
    );
    if (
      existingAction &&
      existingAction.originating_bridge_grant_id !== grant.bridge_grant_id
    ) {
      throw new ControllerError(
        "Existing native action belongs to a different bridge task binding.",
        "auth_required",
        { action_id: existingAction.action_id }
      );
    }
    const taskName = deterministicCodexSubagentTaskName(
      input.agent.role ?? stepId,
      stepInstanceId
    );
    const expectedTaskPath = `${grant.owner_task_path}/${taskName}`;
    const request = {
      task_name: taskName,
      expected_task_path: expectedTaskPath,
      message: input.prompt!,
      fork_turns: input.forkTurns ?? "none"
    };
    const action = this.requireCreatedOrchestratorAction(
      this.store.createOrGetOrchestratorAction({
        idempotencyKey,
        runId: instance.run_id,
        orchestratorAgentId: instance.orchestrator_agent_id,
        originatingBridgeGrantId: grant.bridge_grant_id,
        agentId: input.agent.agent_id,
        flowInstanceId: instance.flow_instance_id,
        stepInstanceId,
        operation: "spawn_agent",
        payloadJson: request
      }),
      input.agent,
      "agent_start"
    );
    if (!stableJsonEquals(action.payload_json, request)) {
      throw new ControllerError("Spawn idempotency key resolved to a different native request.", "tool_error", {
        action_id: action.action_id,
        step_instance_id: stepInstanceId
      });
    }
    return orchestratorActionRef(action);
  }

  private enqueueCodexSubagentMessage(
    agent: AgentRecord,
    message: string
  ): Extract<AgentOperationResult<never>, { type: "orchestrator_action_required" }> {
    const context = this.bridgeContextForAgent(agent);
    const grant = this.resolveActionBridgeGrant({
      runId: agent.run_id,
      orchestratorAgentId: context.orchestratorAgentId,
      bridgeGrantId: context.originatingBridgeGrantId
    });
    const target = codexSubagentTarget(agent);
    const operation: OrchestratorActionOperation =
      agent.status === "running" || agent.status === "starting" ? "send_message" : "followup_task";
    const action = this.requireCreatedOrchestratorAction(
      this.store.createOrGetOrchestratorAction({
        idempotencyKey: `${operation}:${agent.agent_id}:${newId("request")}`,
        runId: agent.run_id,
        orchestratorAgentId: context.orchestratorAgentId,
        originatingBridgeGrantId: grant.bridge_grant_id,
        agentId: agent.agent_id,
        flowInstanceId: context.flowInstanceId,
        stepInstanceId: context.stepInstanceId,
        operation,
        payloadJson: { target, message }
      }),
      agent,
      "agent_send_message"
    );
    return { type: "orchestrator_action_required", action: orchestratorActionRef(action) };
  }

  private enqueueCodexSubagentStepMessage(input: {
    agent: AgentRecord;
    prompt: string;
    metadata: Record<string, unknown>;
    bridgeGrantId?: string | null;
    operation: "send_message" | "followup_task";
  }): OrchestratorActionRef {
    const flowInstanceId = requiredRecordString(input.metadata, "flow_instance_id");
    const stepInstanceId = requiredRecordString(input.metadata, "step_instance_id");
    const stepId = requiredRecordString(input.metadata, "step_id");
    const instance = this.getFlowInstanceOrThrow(flowInstanceId);
    const step = this.getFlowStepInstanceOrThrow(stepInstanceId);
    if (
      instance.run_id !== input.agent.run_id ||
      step.flow_instance_id !== instance.flow_instance_id ||
      step.step_id !== stepId ||
      step.agent_id !== input.agent.agent_id
    ) {
      throw new ControllerError(
        "codex-subagent reused-task metadata does not match its assigned flow step.",
        "tool_error",
        {
          agent_id: input.agent.agent_id,
          flow_instance_id: flowInstanceId,
          step_instance_id: stepInstanceId
        }
      );
    }
    if (!instance.orchestrator_agent_id) {
      throw new ControllerError("Native flow instance has no bound orchestrator.", "auth_required", {
        flow_instance_id: instance.flow_instance_id
      });
    }
    const request = {
      target: codexSubagentTarget(input.agent),
      message: input.prompt
    };
    const idempotencyKey = `step-message:${stepInstanceId}`;
    const existing = this.store.getOrchestratorActionByIdempotencyKey(idempotencyKey);
    if (existing && !existing.originating_bridge_grant_id) {
      throw new ControllerError(
        "Existing native action has no provable originating bridge grant.",
        "auth_required",
        { action_id: existing.action_id }
      );
    }
    const grant = this.resolveNativeFlowBridgeGrant(
      instance,
      input.bridgeGrantId ?? null
    );
    const nativeTaskFlowInstanceId = recordString(
      input.agent.backend_handle,
      "flow_instance_id"
    );
    if (nativeTaskFlowInstanceId !== instance.flow_instance_id) {
      throw new ControllerError(
        "Existing native task belongs to a different flow task binding.",
        "auth_required",
        {
          agent_id: input.agent.agent_id,
          native_task_flow_instance_id: nativeTaskFlowInstanceId,
          requested_flow_instance_id: instance.flow_instance_id
        }
      );
    }
    // A persistent native worker can be reused across steps of its own flow,
    // but never adopted by a sibling flow/grant merely because both reference
    // the same logical agent row.
    this.resolveNativeFlowBridgeGrant(
      this.getFlowInstanceOrThrow(nativeTaskFlowInstanceId),
      grant.bridge_grant_id
    );
    if (
      existing &&
      existing.originating_bridge_grant_id !== grant.bridge_grant_id
    ) {
      throw new ControllerError(
        "Existing native action belongs to a different bridge task binding.",
        "auth_required",
        { action_id: existing.action_id }
      );
    }
    if (existing) {
      if (
        existing.run_id !== instance.run_id ||
        existing.orchestrator_agent_id !== instance.orchestrator_agent_id ||
        existing.originating_bridge_grant_id !== grant.bridge_grant_id ||
        existing.agent_id !== input.agent.agent_id ||
        existing.flow_instance_id !== instance.flow_instance_id ||
        existing.step_instance_id !== step.step_instance_id ||
        (existing.operation !== "send_message" && existing.operation !== "followup_task") ||
        !stableJsonEquals(existing.payload_json, request)
      ) {
        throw new ControllerError(
          "Reused-task idempotency key resolved to a different native request.",
          "tool_error",
          { action_id: existing.action_id, step_instance_id: stepInstanceId }
        );
      }
      return orchestratorActionRef(existing);
    }

    const action = this.requireCreatedOrchestratorAction(
      this.store.createOrGetOrchestratorAction({
        idempotencyKey,
        runId: instance.run_id,
        orchestratorAgentId: instance.orchestrator_agent_id,
        originatingBridgeGrantId: grant.bridge_grant_id,
        agentId: input.agent.agent_id,
        flowInstanceId: instance.flow_instance_id,
        stepInstanceId: step.step_instance_id,
        operation: input.operation,
        payloadJson: request
      }),
      input.agent,
      "agent_start"
    );
    if (
      (action.operation !== "send_message" && action.operation !== "followup_task") ||
      !stableJsonEquals(action.payload_json, request)
    ) {
      throw new ControllerError(
        "Reused-task idempotency key resolved to a different native request.",
        "tool_error",
        { action_id: action.action_id, step_instance_id: stepInstanceId }
      );
    }
    return orchestratorActionRef(action);
  }

  private enqueueCodexSubagentInterrupt(
    agent: AgentRecord,
    idempotencyKey = `interrupt:${agent.agent_id}:${newId("request")}`,
    causalAction?: OrchestratorActionRecord | null
  ): Extract<AgentOperationResult<never>, { type: "orchestrator_action_required" }> {
    const context = this.bridgeContextForAgent(agent);
    if (causalAction && !causalAction.originating_bridge_grant_id) {
      throw new ControllerError(
        "Causal native action has no provable originating bridge grant.",
        "auth_required",
        { agent_id: agent.agent_id, action_id: causalAction.action_id }
      );
    }
    const causalBridgeGrantId =
      causalAction?.originating_bridge_grant_id ??
      context.originatingBridgeGrantId;
    const causalFlowInstanceId =
      causalAction?.flow_instance_id ?? context.flowInstanceId;
    const causalStepInstanceId =
      causalAction?.step_instance_id ?? context.stepInstanceId;
    const causalOrchestratorAgentId =
      causalAction?.orchestrator_agent_id ?? context.orchestratorAgentId;
    if (causalAction) {
      if (!causalAction.flow_instance_id || !causalAction.step_instance_id) {
        throw new ControllerError(
          "Causal native action has no provable flow task binding.",
          "auth_required",
          { action_id: causalAction.action_id }
        );
      }
      const causalFlow = this.getFlowInstanceOrThrow(
        causalAction.flow_instance_id
      );
      const causalStep = this.getFlowStepInstanceOrThrow(
        causalAction.step_instance_id
      );
      if (
        causalAction.agent_id !== agent.agent_id ||
        causalAction.run_id !== agent.run_id ||
        causalFlow.orchestrator_agent_id !== causalOrchestratorAgentId ||
        causalStep.flow_instance_id !== causalFlow.flow_instance_id ||
        causalStep.agent_id !== agent.agent_id
      ) {
        throw new ControllerError(
          "Causal native action does not match its flow worker binding.",
          "auth_required",
          { action_id: causalAction.action_id }
        );
      }
      this.resolveNativeFlowBridgeGrant(causalFlow, causalBridgeGrantId);
    }
    const existing = this.store.findOpenOrchestratorAction(agent.agent_id, ["interrupt_agent"]);
    if (existing) {
      if (!existing.originating_bridge_grant_id) {
        throw new ControllerError(
          "Open native cleanup action has no provable bridge task binding.",
          "auth_required",
          { action_id: existing.action_id }
        );
      }
      if (existing.originating_bridge_grant_id !== causalBridgeGrantId) {
        throw new ControllerError(
          "Open native cleanup action belongs to a different bridge task binding.",
          "auth_required",
          {
            action_id: existing.action_id,
            originating_bridge_grant_id: existing.originating_bridge_grant_id,
            requested_bridge_grant_id: causalBridgeGrantId
          }
        );
      }
      if (
        existing.flow_instance_id !== causalFlowInstanceId ||
        existing.step_instance_id !== causalStepInstanceId
      ) {
        throw new ControllerError(
          "Open native cleanup action belongs to a different flow task binding.",
          "auth_required",
          { action_id: existing.action_id }
        );
      }
      // Existing cleanup remains owned by its originating task across restart
      // or grant rotation. Resolving that exact grant also rejects a revoked or
      // expired owner instead of silently transferring the interrupt.
      this.resolveActionBridgeGrant({
        runId: agent.run_id,
        orchestratorAgentId: causalOrchestratorAgentId,
        bridgeGrantId: causalBridgeGrantId
      });
      return { type: "orchestrator_action_required", action: orchestratorActionRef(existing) };
    }
    const grant = this.resolveActionBridgeGrant({
      runId: agent.run_id,
      orchestratorAgentId: causalOrchestratorAgentId,
      bridgeGrantId: causalBridgeGrantId
    });
    const target = codexSubagentTarget(agent);
    let generationKey = idempotencyKey;
    for (let generation = 0; generation < 64; generation += 1) {
      const action = this.requireCreatedOrchestratorAction(
        this.store.createOrGetOrchestratorAction({
          idempotencyKey: generationKey,
          runId: agent.run_id,
          orchestratorAgentId: causalOrchestratorAgentId,
          originatingBridgeGrantId: grant.bridge_grant_id,
          agentId: agent.agent_id,
          flowInstanceId: causalFlowInstanceId,
          stepInstanceId: causalStepInstanceId,
          operation: "interrupt_agent",
          payloadJson: { target }
        }),
        agent,
        null
      );
      if (action.status === "pending" || action.status === "claimed") {
        return { type: "orchestrator_action_required", action: orchestratorActionRef(action) };
      }
      // A terminal action can never be returned as executable work. Chaining
      // the next idempotency key from its durable id produces one stable retry
      // generation across ACK replay and controller restarts.
      generationKey = `${idempotencyKey}:after:${action.action_id}`;
    }
    throw new ControllerError(
      "Interrupt reconciliation exceeded its deterministic generation limit.",
      "tool_error",
      { agent_id: agent.agent_id, idempotency_key: idempotencyKey }
    );
  }

  private resolveActionBridgeGrant(input: {
    runId: string;
    orchestratorAgentId: string;
    bridgeGrantId: string;
  }): BridgeGrantRecord {
    if (!isBridgeGrantId(input.bridgeGrantId)) {
      throw new ControllerError("Invalid bridge grant id.", "tool_error", {
        bridge_grant_id: input.bridgeGrantId
      });
    }
    const grant = this.store.getBridgeGrant(input.bridgeGrantId);
    const expired = grant?.expires_at ? Date.parse(grant.expires_at) <= Date.now() : false;
    if (
      !grant ||
      grant.revoked_at ||
      expired ||
      grant.run_id !== input.runId ||
      grant.orchestrator_agent_id !== input.orchestratorAgentId
    ) {
      throw new ControllerError("No active scoped bridge grant is available for this native action.", "auth_required", {
        run_id: input.runId,
        orchestrator_agent_id: input.orchestratorAgentId
      });
    }
    return grant;
  }

  /**
   * Resolve the immutable task binding of one native flow. Null legacy rows
   * remain intentionally unusable: selecting a newer grant by recency would
   * transfer authority between independent orchestrator tasks.
   */
  private resolveNativeFlowBridgeGrant(
    instance: FlowInstanceRecord,
    requestedBridgeGrantId: string | null = null
  ): BridgeGrantRecord {
    if (!instance.orchestrator_agent_id) {
      throw new ControllerError(
        "Native flow instance has no bound orchestrator.",
        "auth_required",
        { flow_instance_id: instance.flow_instance_id }
      );
    }
    if (!instance.originating_bridge_grant_id) {
      throw new ControllerError(
        "Native flow instance has no provable originating bridge grant.",
        "auth_required",
        { flow_instance_id: instance.flow_instance_id }
      );
    }
    if (
      requestedBridgeGrantId &&
      requestedBridgeGrantId !== instance.originating_bridge_grant_id
    ) {
      throw new ControllerError(
        "Native flow belongs to a different bridge task binding.",
        "auth_required",
        {
          flow_instance_id: instance.flow_instance_id,
          originating_bridge_grant_id: instance.originating_bridge_grant_id,
          requested_bridge_grant_id: requestedBridgeGrantId
        }
      );
    }
    return this.resolveActionBridgeGrant({
      runId: instance.run_id,
      orchestratorAgentId: instance.orchestrator_agent_id,
      bridgeGrantId: instance.originating_bridge_grant_id
    });
  }

  private assertOrchestratorActionGrant(
    actionRef: OrchestratorActionRef,
    bridgeGrantId: string
  ): void {
    const action = this.store.getOrchestratorAction(actionRef.action_id);
    if (!action || action.originating_bridge_grant_id !== bridgeGrantId) {
      throw new ControllerError(
        "Native action belongs to a different bridge task binding.",
        "auth_required",
        {
          action_id: actionRef.action_id,
          originating_bridge_grant_id: action?.originating_bridge_grant_id ?? null,
          requested_bridge_grant_id: bridgeGrantId
        }
      );
    }
  }

  private bridgeContextForAgent(agent: AgentRecord): {
    flowInstanceId: string;
    stepInstanceId: string | null;
    orchestratorAgentId: string;
    originatingBridgeGrantId: string;
  } {
    const handleFlowInstanceId = recordString(agent.backend_handle, "flow_instance_id");
    const candidates = this.store
      .listFlowInstances({ runId: agent.run_id })
      .filter((instance) => !handleFlowInstanceId || instance.flow_instance_id === handleFlowInstanceId)
      .reverse();
    for (const instance of candidates) {
      if (!instance.orchestrator_agent_id) {
        continue;
      }
      const step = this.store
        .listFlowStepInstances(instance.flow_instance_id)
        .filter((entry) => entry.agent_id === agent.agent_id)
        .at(-1);
      if (step) {
        if (!instance.originating_bridge_grant_id) {
          throw new ControllerError(
            "Native flow instance has no provable originating bridge grant.",
            "auth_required",
            { flow_instance_id: instance.flow_instance_id }
          );
        }
        return {
          flowInstanceId: instance.flow_instance_id,
          stepInstanceId: step.step_instance_id,
          orchestratorAgentId: instance.orchestrator_agent_id,
          originatingBridgeGrantId: instance.originating_bridge_grant_id
        };
      }
    }
    throw new ControllerError("codex-subagent agent is not bound to an orchestrated flow step.", "tool_error", {
      agent_id: agent.agent_id
    });
  }

  private getOrchestratorActionOrThrow(actionId: string): OrchestratorActionRecord {
    if (!isOrchestratorActionId(actionId)) {
      throw new ControllerError("Invalid orchestrator action id.", "tool_error", {
        action_id: actionId
      });
    }
    const action = this.store.getOrchestratorAction(actionId);
    if (!action) {
      throw new ControllerError(`Orchestrator action not found: ${actionId}`, "tool_error", {
        action_id: actionId
      });
    }
    return action;
  }

  private validateSpawnAcknowledgement(
    action: OrchestratorActionRecord,
    result: Record<string, unknown> | null,
    agent: AgentRecord
  ): void {
    const nativeAgentId = recordString(result, "native_agent_id");
    const nativeTaskPath = recordString(result, "native_task_path");
    if (!nativeAgentId && !nativeTaskPath) {
      throw new ControllerError(
        "Successful spawn acknowledgement requires native_agent_id or native_task_path.",
        "tool_error",
        { action_id: action.action_id }
      );
    }
    const expectedTaskPath = requiredRecordString(action.payload_json, "expected_task_path");
    if (nativeTaskPath && nativeTaskPath !== expectedTaskPath) {
      throw new ControllerError("Spawn acknowledgement returned an unexpected canonical task path.", "tool_error", {
        action_id: action.action_id,
        expected_task_path: expectedTaskPath,
        native_task_path: nativeTaskPath
      });
    }
    const nativeTaskName = recordString(result, "native_task_name");
    const expectedTaskName = requiredRecordString(action.payload_json, "task_name");
    if (nativeTaskName && nativeTaskName !== expectedTaskName) {
      throw new ControllerError("Spawn acknowledgement returned an unexpected native task name.", "tool_error", {
        action_id: action.action_id,
        expected_task_name: expectedTaskName,
        native_task_name: nativeTaskName
      });
    }

    // External sync may legitimately observe the native worker before the
    // root task ACK reaches Agent Control. Treat that already-stored identity
    // as authoritative and reject a contradictory ACK before completing the
    // durable action; otherwise the ACK could silently replace newer native
    // truth while preserving the logical terminal status.
    const storedHandle = agent.backend_handle ?? {};
    const identityComparisons: Array<[
      string,
      string | null | undefined,
      string | null | undefined
    ]> = [
      ["native_agent_id", recordString(storedHandle, "native_agent_id"), nativeAgentId],
      ["native_task_name", recordString(storedHandle, "native_task_name"), nativeTaskName],
      ["native_task_path", recordString(storedHandle, "native_task_path"), nativeTaskPath]
    ];
    for (const [field, stored, acknowledged] of identityComparisons) {
      if (stored && acknowledged && stored !== acknowledged) {
        throw new ControllerError(
          "Spawn acknowledgement identity conflicts with the stored native agent handle.",
          "auth_required",
          {
            action_id: action.action_id,
            field,
            agent_expected: stored,
            acknowledged
          }
        );
      }
    }
    const storedTaskName = recordString(storedHandle, "native_task_name");
    const storedTaskPath = recordString(storedHandle, "native_task_path");
    if (
      (storedTaskName && storedTaskName !== expectedTaskName) ||
      (storedTaskPath && storedTaskPath !== expectedTaskPath)
    ) {
      throw new ControllerError(
        "Stored native identity does not match the claimed spawn request.",
        "auth_required",
        { action_id: action.action_id }
      );
    }
  }

  private applyOrchestratorActionAcknowledgement(
    action: OrchestratorActionRecord,
    eventSink?: (event: ControllerEventInput) => void
  ): {
    agent: AgentRecord;
    orchestratorAction?: OrchestratorActionRef;
  } {
    const agent = this.getAgent(action.agent_id);
    if (TERMINAL_STATUSES.has(agent.status)) {
      if (this.followupAcknowledgementStartsNewerTurn(action, agent)) {
        return {
          agent: this.applySuccessfulCodexSubagentMessageAcknowledgement(action, eventSink)
        };
      }
      // External sync is the native lifecycle authority unless durable action
      // ordering proves that a successful follow-up started a newer turn. A
      // delayed ACK for every other action, or an observation made after the
      // follow-up claim, must not rewrite newer lifecycle/failure truth.
      return { agent: this.mergeTerminalSpawnAcknowledgement(action, agent) };
    }
    if (
      (action.operation === "send_message" || action.operation === "followup_task") &&
      this.hasDurableStopIntent(agent)
    ) {
      return {
        agent: agent.backend_handle ? agent : this.recoverCodexSubagentSpawnHandle(agent)
      };
    }
    if (action.status === "failed") {
      if (action.operation === "interrupt_agent") {
        const cleanupPending = this.markCodexSubagentCleanupPending(
          agent,
          "native_interrupt_failed",
          action,
          eventSink
        );
        const stopping = this.store.updateAgent(cleanupPending.agent_id, {
          failureReason: "tool_error"
        });
        return { agent: stopping };
      }
      const failed = this.store.updateAgent(agent.agent_id, {
        status: "failed",
        failureReason: "tool_error"
      });
      this.recordControllerEvent(
        {
          runId: failed.run_id,
          agentId: failed.agent_id,
          type: "agent.failed",
          payload: {
            reason: "tool_error",
            action_id: action.action_id,
            operation: action.operation
          }
        },
        eventSink
      );
      return { agent: failed };
    }

    if (action.operation === "spawn_agent") {
      const handle = this.spawnBackendHandle(action, agent);
      const stopWasRequested = this.hasDurableStopIntent(agent);
      const projected = stopWasRequested
        ? {
            agent: this.store.updateAgent(agent.agent_id, {
              backendHandle: handle,
              status: "stopping",
              failureReason: null
            }),
            changed: true
          }
        : this.store.updateAgentForNewWork(agent.agent_id, {
            backendHandle: handle,
            status: "running",
            failureReason: null
          });
      const updated = projected.changed
        ? projected.agent
        : this.store.updateAgent(agent.agent_id, {
            backendHandle: handle,
            status: "stopping",
            failureReason: projected.agent.failure_reason
          });
      const cleanupRequired = this.hasDurableStopIntent(updated);
      this.recordControllerEvent(
        {
          runId: updated.run_id,
          agentId: updated.agent_id,
          type: cleanupRequired ? "agent.status_changed" : "agent.started",
          payload: cleanupRequired
            ? {
                status: "stopping",
                reason: "native_spawn_acknowledged_after_stop",
                action_id: action.action_id
              }
            : { backend: CODEX_SUBAGENT_BACKEND, action_id: action.action_id }
        },
        eventSink
      );
      this.store.touchHeartbeat(updated.agent_id);
      return { agent: updated };
    }

    if (action.operation === "send_message" || action.operation === "followup_task") {
      return {
        agent: this.applySuccessfulCodexSubagentMessageAcknowledgement(action, eventSink)
      };
    }

    // An interrupt acknowledgement confirms only that the native tool accepted
    // the request. The agent remains stopping until external sync observes the
    // actual interrupted/shutdown state.
    return {
      agent: this.markCodexSubagentCleanupPending(
        agent,
        "native_interrupt_acknowledged_pending_terminal_sync",
        action,
        eventSink
      )
    };
  }

  private followupAcknowledgementStartsNewerTurn(
    action: OrchestratorActionRecord,
    agent: AgentRecord
  ): boolean {
    if (
      action.operation !== "followup_task" ||
      action.status !== "succeeded" ||
      !action.claimed_at ||
      !TERMINAL_STATUSES.has(agent.status)
    ) {
      return false;
    }
    const runStatus = this.store.getRun(agent.run_id)?.status;
    if (
      runStatus === "stopping" ||
      runStatus === "stopped" ||
      this.store.getOrchestratorActionByIdempotencyKey(
        `interrupt:stop-message:${action.action_id}`
      )
    ) {
      // Run state and the deterministic interrupt key are durable stop
      // generations. Once either exists, no observation ordering may revive
      // the acknowledged message action after terminal synchronization.
      return false;
    }
    const externalState = this.store.getCodexSubagentExternalState(agent.agent_id);
    const nativeStatus = nullableRecordString(externalState, "native_status");
    const observedAt = nullableRecordString(externalState, "observed_at");
    if (!nativeStatus || !observedAt) {
      return false;
    }
    const mapped = mapCodexSubagentStatus(nativeStatus);
    if (mapped.status !== agent.status || mapped.failureReason !== agent.failure_reason) {
      return false;
    }
    const observedAtMs = Date.parse(observedAt);
    const claimedAtMs = Date.parse(action.claimed_at);
    return (
      Number.isFinite(observedAtMs) &&
      Number.isFinite(claimedAtMs) &&
      // Millisecond precision cannot order an observation equal to the claim
      // after execution of the not-yet-issued follow-up. Equality therefore
      // belongs to the previous turn; only a strictly newer observation wins.
      observedAtMs <= claimedAtMs
    );
  }

  private applySuccessfulCodexSubagentMessageAcknowledgement(
    action: OrchestratorActionRecord,
    eventSink?: (event: ControllerEventInput) => void
  ): AgentRecord {
    const projection = this.store.updateAgentForNewWork(action.agent_id, {
      status: "running",
      failureReason: null
    });
    const running = projection.agent;
    if (!projection.changed) {
      return running;
    }
    this.recordControllerEvent(
      {
        runId: running.run_id,
        agentId: running.agent_id,
        type: "agent.message",
        payload: {
          direction: "outbound",
          action_id: action.action_id,
          operation: action.operation
        }
      },
      eventSink
    );
    this.store.touchHeartbeat(running.agent_id);
    return running;
  }

  private mergeTerminalSpawnAcknowledgement(
    action: OrchestratorActionRecord,
    agent: AgentRecord
  ): AgentRecord {
    if (
      !TERMINAL_STATUSES.has(agent.status) ||
      action.operation !== "spawn_agent" ||
      action.status !== "succeeded"
    ) {
      return agent;
    }
    const backendHandle = this.spawnBackendHandle(action, agent);
    return stableJsonEquals(agent.backend_handle, backendHandle)
      ? agent
      : this.store.updateAgent(agent.agent_id, { backendHandle });
  }

  private spawnBackendHandle(
    action: OrchestratorActionRecord,
    agent: AgentRecord
  ): Record<string, unknown> {
    const result = action.result_json ?? {};
    const existing = agent.backend_handle ?? {};
    const expectedTaskPath = requiredRecordString(action.payload_json, "expected_task_path");
    const nativeAgentId =
      recordString(existing, "native_agent_id") ?? recordString(result, "native_agent_id");
    return {
      ...existing,
      flow_instance_id: action.flow_instance_id,
      step_instance_id: action.step_instance_id,
      expected_task_path: expectedTaskPath,
      native_task_path:
        recordString(existing, "native_task_path") ??
        recordString(result, "native_task_path") ??
        expectedTaskPath,
      native_task_name:
        recordString(existing, "native_task_name") ??
        recordString(result, "native_task_name") ??
        requiredRecordString(action.payload_json, "task_name"),
      ...(nativeAgentId ? { native_agent_id: nativeAgentId } : {})
    };
  }

  private hasDurableStopIntent(agent: AgentRecord): boolean {
    const runStatus = this.store.getRun(agent.run_id)?.status;
    return (
      STOP_INTENT_AGENT_STATUSES.has(agent.status) ||
      (runStatus !== undefined && STOP_INTENT_RUN_STATUSES.has(runStatus))
    );
  }

  private hasCodexSubagentTarget(agent: AgentRecord): boolean {
    return Boolean(
      recordString(agent.backend_handle, "native_task_path") ??
        recordString(agent.backend_handle, "native_agent_id") ??
        recordString(agent.backend_handle, "expected_task_path")
    );
  }

  private reconcileNativeObservationStopIntent(
    agent: AgentRecord,
    nativeStatus: string,
    observedAt: string,
    eventSink?: (event: ControllerEventInput) => void
  ): { agent: AgentRecord; orchestratorAction?: OrchestratorActionRef } {
    const mapped = mapCodexSubagentStatus(nativeStatus);
    if (TERMINAL_STATUSES.has(mapped.status) || !this.hasDurableStopIntent(agent)) {
      return { agent };
    }
    const orchestratorAction = this.hasCodexSubagentTarget(agent)
      ? this.enqueueCodexSubagentInterrupt(
          agent,
          `interrupt:stop-observation:${agent.agent_id}:${observedAt}`
        ).action
      : null;
    const stopping = this.markCodexSubagentCleanupPending(
      agent,
      "native_nonterminal_observed_after_stop",
      undefined,
      eventSink
    );
    if (!orchestratorAction) {
      // A claimed spawn can still lack an acknowledged target. Its later ACK
      // re-enters the same stop reconciliation and will create the interrupt
      // once the canonical native identity is available.
      return { agent: stopping };
    }
    return {
      agent: stopping,
      orchestratorAction
    };
  }

  private markCodexSubagentCleanupPending(
    agent: AgentRecord,
    reason: string,
    action?: OrchestratorActionRecord,
    eventSink?: (event: ControllerEventInput) => void
  ): AgentRecord {
    const applyProjection = () => {
      const run = this.getRun(agent.run_id);
      if (run.status === "stopped") {
        // A late native observation/ACK can prove that work exists after the
        // run was provisionally finalized. Reopening only to stopping keeps it
        // honest until terminal external sync completes cleanup.
        this.store.updateRunStatus(run.run_id, "stopping");
      }
      const current = this.getAgent(agent.agent_id);
      return {
        statusChanged: current.status !== "stopping",
        agent: this.store.updateAgent(current.agent_id, {
          status: "stopping",
          failureReason: current.failure_reason
        })
      };
    };
    const projection = this.store.db.inTransaction
      ? applyProjection()
      : this.store.transaction(applyProjection);
    const stopping = projection.agent;
    if (projection.statusChanged) {
      this.recordControllerEvent(
        {
          runId: stopping.run_id,
          agentId: stopping.agent_id,
          type: "agent.status_changed",
          payload: {
            status: "stopping",
            reason,
            ...(action
              ? {
                  action_id: action.action_id,
                  action_status: action.status,
                  operation: action.operation
                }
              : {})
          }
        },
        eventSink
      );
    }
    return stopping;
  }

  private reconcileAcknowledgedActionStopIntent(
    action: OrchestratorActionRecord,
    agent: AgentRecord,
    eventSink?: (event: ControllerEventInput) => void
  ): { agent: AgentRecord; orchestratorAction?: OrchestratorActionRef } {
    const recovered = agent.backend_handle
      ? agent
      : this.recoverCodexSubagentSpawnHandle(agent);
    if (!this.hasDurableStopIntent(recovered)) {
      return { agent: recovered };
    }
    const orchestratorAction = this.stopCleanupActionForAcknowledgedAction(
      action,
      recovered
    );
    if (!orchestratorAction) {
      return { agent: recovered };
    }
    return {
      agent: this.markCodexSubagentCleanupPending(
        recovered,
        action.operation === "spawn_agent"
          ? "native_spawn_acknowledged_after_stop"
          : "native_message_acknowledged_after_stop",
        action,
        eventSink
      ),
      orchestratorAction
    };
  }

  private stopCleanupActionForAcknowledgedAction(
    action: OrchestratorActionRecord,
    agent: AgentRecord
  ): OrchestratorActionRef | null {
    if (!agent.backend_handle || !this.hasCodexSubagentTarget(agent)) {
      return null;
    }
    if (this.terminalNativeObservationCoversAction(action, agent)) {
      return null;
    }
    if (action.operation === "spawn_agent" && action.status === "succeeded") {
      return this.lateSpawnStopInterruptForAcknowledgedAction(action, agent);
    }
    if (
      (action.operation === "send_message" || action.operation === "followup_task") &&
      (action.status === "succeeded" || action.status === "failed")
    ) {
      return this.messageStopInterruptForAcknowledgedAction(action, agent);
    }
    return null;
  }

  private terminalNativeObservationCoversAction(
    action: OrchestratorActionRecord,
    agent: AgentRecord
  ): boolean {
    if (!action.completed_at) {
      return false;
    }
    const externalState = this.store.getCodexSubagentExternalState(agent.agent_id);
    const nativeStatus = nullableRecordString(externalState, "native_status");
    const observedAt = nullableRecordString(externalState, "observed_at");
    if (!nativeStatus || !observedAt || !TERMINAL_STATUSES.has(mapCodexSubagentStatus(nativeStatus).status)) {
      return false;
    }
    const observedAtMs = Date.parse(observedAt);
    const actionCompletedAtMs = Date.parse(action.completed_at);
    return (
      Number.isFinite(observedAtMs) &&
      Number.isFinite(actionCompletedAtMs) &&
      // Equality is not enough to prove ordering at millisecond precision.
      observedAtMs > actionCompletedAtMs
    );
  }

  private interruptCompletionCoversAction(
    interrupt: OrchestratorActionRecord,
    action: OrchestratorActionRecord
  ): boolean {
    if (
      interrupt.operation !== "interrupt_agent" ||
      interrupt.status !== "succeeded" ||
      !action.originating_bridge_grant_id ||
      interrupt.originating_bridge_grant_id !==
        action.originating_bridge_grant_id ||
      interrupt.flow_instance_id !== action.flow_instance_id ||
      interrupt.step_instance_id !== action.step_instance_id ||
      !interrupt.completed_at ||
      !action.completed_at
    ) {
      return false;
    }
    const interruptCompletedAtMs = Date.parse(interrupt.completed_at);
    const actionCompletedAtMs = Date.parse(action.completed_at);
    return (
      Number.isFinite(interruptCompletedAtMs) &&
      Number.isFinite(actionCompletedAtMs) &&
      // Equality cannot prove which operation completed last at SQLite's
      // millisecond timestamp precision, so only a strict later ACK covers the
      // acknowledged work.
      interruptCompletedAtMs > actionCompletedAtMs
    );
  }

  private hasSuccessfulInterruptCoverage(
    agentId: string,
    action: OrchestratorActionRecord
  ): boolean {
    return this.store
      .listOrchestratorActions({ agentId })
      .some(
        (candidate) =>
          candidate.agent_id === agentId &&
          this.interruptCompletionCoversAction(candidate, action)
      );
  }

  private lateSpawnStopInterruptForAcknowledgedAction(
    action: OrchestratorActionRecord,
    agent: AgentRecord
  ): OrchestratorActionRef | null {
    // The first ACK may have reused an observation-triggered interrupt rather
    // than the late-spawn base key. Completion ordering, not key provenance,
    // is the durable proof that any successful interrupt covered this work.
    if (this.hasSuccessfulInterruptCoverage(agent.agent_id, action)) {
      return null;
    }
    const openInterrupt = this.store.findOpenOrchestratorAction(agent.agent_id, [
      "interrupt_agent"
    ]);
    if (openInterrupt) {
      this.assertCleanupActionSharesOrigin(openInterrupt, action);
      return orchestratorActionRef(openInterrupt);
    }

    const baseKey = `interrupt:late-spawn:${action.action_id}`;
    let generationKey = baseKey;
    for (let generation = 0; generation < 64; generation += 1) {
      const existing = this.store.getOrchestratorActionByIdempotencyKey(generationKey);
      if (!existing) {
        return this.enqueueCodexSubagentInterrupt(
          agent,
          generationKey,
          action
        ).action;
      }
      this.assertCleanupActionSharesOrigin(existing, action);
      if (existing.status === "pending" || existing.status === "claimed") {
        return orchestratorActionRef(existing);
      }
      if (this.interruptCompletionCoversAction(existing, action)) {
        return null;
      }
      // Failed/cancelled interrupts and successful interrupts that completed
      // no later than the spawn ACK cannot prove cleanup. Deriving the next
      // key from the terminal action makes the retry exact across ACK replay
      // and controller restarts without ever returning a terminal action.
      generationKey = `${baseKey}:after:${existing.action_id}`;
    }
    throw new ControllerError(
      "Late-spawn stop reconciliation exceeded its deterministic generation limit.",
      "tool_error",
      { action_id: action.action_id, agent_id: agent.agent_id }
    );
  }

  private messageStopInterruptForAcknowledgedAction(
    action: OrchestratorActionRecord,
    agent: AgentRecord
  ): OrchestratorActionRef | null {
    if (this.hasSuccessfulInterruptCoverage(agent.agent_id, action)) {
      return null;
    }
    const openInterrupt = this.store.findOpenOrchestratorAction(agent.agent_id, [
      "interrupt_agent"
    ]);
    if (openInterrupt) {
      this.assertCleanupActionSharesOrigin(openInterrupt, action);
      return orchestratorActionRef(openInterrupt);
    }

    const baseKey = `interrupt:stop-message:${action.action_id}`;
    const baseInterrupt = this.store.getOrchestratorActionByIdempotencyKey(baseKey);
    if (baseInterrupt) {
      this.assertCleanupActionSharesOrigin(baseInterrupt, action);
    }
    if (baseInterrupt && this.interruptCompletionCoversAction(baseInterrupt, action)) {
      return null;
    }

    // This chain can only be created after the message action is durably
    // completed. A succeeded member therefore proves that its interrupt was
    // issued after the uncertain work; failed/cancelled members deterministically
    // advance to one next generation without duplicating on ACK replay.
    const postAckBaseKey = `${baseKey}:post-ack`;
    let generationKey = postAckBaseKey;
    for (let generation = 0; generation < 64; generation += 1) {
      const existing = this.store.getOrchestratorActionByIdempotencyKey(generationKey);
      if (!existing) {
        return this.enqueueCodexSubagentInterrupt(
          agent,
          generationKey,
          action
        ).action;
      }
      this.assertCleanupActionSharesOrigin(existing, action);
      if (existing.status === "pending" || existing.status === "claimed") {
        return orchestratorActionRef(existing);
      }
      if (existing.status === "succeeded") {
        return null;
      }
      generationKey = `${postAckBaseKey}:after:${existing.action_id}`;
    }
    throw new ControllerError(
      "Message stop reconciliation exceeded its deterministic generation limit.",
      "tool_error",
      { action_id: action.action_id, agent_id: agent.agent_id }
    );
  }

  /** Reject cleanup replay that would cross from one task grant to another. */
  private assertCleanupActionSharesOrigin(
    cleanup: OrchestratorActionRecord,
    cause: OrchestratorActionRecord
  ): void {
    if (
      !cause.originating_bridge_grant_id ||
      cleanup.originating_bridge_grant_id !==
        cause.originating_bridge_grant_id ||
      cleanup.flow_instance_id !== cause.flow_instance_id ||
      cleanup.step_instance_id !== cause.step_instance_id
    ) {
      throw new ControllerError(
        "Native cleanup action belongs to a different bridge task binding.",
        "auth_required",
        {
          action_id: cleanup.action_id,
          cause_action_id: cause.action_id,
          originating_bridge_grant_id:
            cleanup.originating_bridge_grant_id,
          cause_bridge_grant_id: cause.originating_bridge_grant_id
        }
      );
    }
  }

  canAgentAccessRun(agent: AgentRecord, runId: string): boolean {
    return this.filterRunsForAgent(this.store.listRuns(5000), agent).some((run) => run.run_id === runId);
  }

  /**
   * Decide whether a fresh step has crossed the backend-start boundary using
   * durable facts only. The step assignment and transient statuses are written
   * before backend dispatch, so `queued`, `planned`, or `starting` cannot prove
   * that a thread/task exists. Conversely, any per-step native action, stored
   * or recoverable handle, terminal outcome, or `agent.started` event proves a
   * prior attempt far enough along that replaying start could duplicate work.
   */
  private resolveFreshFlowStepStartEvidence(
    agentId: string,
    stepInstanceId: string
  ): {
    agent: AgentRecord;
    openAction: OrchestratorActionRecord | null;
    startAttempt: AgentStartAttemptRecord | null;
    hasDurableStartEvidence: boolean;
  } {
    let agent = this.getAgent(agentId);
    const stepActions = this.store
      .listOrchestratorActions({ agentId })
      .filter(
        (action) =>
          action.agent_id === agentId &&
          action.step_instance_id === stepInstanceId &&
          (action.operation === "spawn_agent" ||
            action.operation === "send_message" ||
            action.operation === "followup_task")
      );
    const openAction =
      stepActions
        .filter((action) => action.status === "pending" || action.status === "claimed")
        .at(-1) ?? null;

    if (!agent.backend_handle && agent.backend === CODEX_SUBAGENT_BACKEND) {
      agent = this.recoverCodexSubagentSpawnHandle(agent);
    }
    const unresolvedStartAttempt = this.store.getAgentStartAttemptForStep(
      agentId,
      stepInstanceId
    );
    let authoritativeHandleRecovered = false;
    let authoritativeHandle = agent.backend_handle;
    if (!agent.backend_handle) {
      const recoveredHandle = this.recoverBackendHandle(agent);
      if (recoveredHandle) {
        authoritativeHandle = recoveredHandle;
        authoritativeHandleRecovered = true;
        if (
          !unresolvedStartAttempt ||
          (unresolvedStartAttempt.phase !== "invoking" &&
            unresolvedStartAttempt.phase !== "ambiguous")
        ) {
          agent = this.store.updateAgent(agent.agent_id, {
            backendHandle: recoveredHandle
          });
        }
      }
    }

    const hasStartedEvent =
      this.store.listEvents({ agentId, type: "agent.started", limit: 1 }).length > 0;
    let startAttempt = unresolvedStartAttempt;
    if (
      (authoritativeHandleRecovered ||
        (agent.backend === "opencode-server" && Boolean(authoritativeHandle))) &&
      authoritativeHandle &&
      startAttempt &&
      (startAttempt.phase === "invoking" || startAttempt.phase === "ambiguous")
    ) {
      // OpenCode launch metadata is controller-owned proof that a concrete
      // backend session exists. Reconcile it before lease expiry can turn the
      // same invocation into a false ambiguity block.
      const completion = this.completeNonNativeStartAttemptWithHandle({
        attempt: startAttempt,
        handle: authoritativeHandle
      });
      startAttempt = completion.attempt;
      agent = completion.agent;
      if (completion.flowRecovered) {
        this.emitLateStartFlowRecovery(completion.attempt, completion.agent);
      }
      if (completion.cleanupRequired) {
        this.scheduleAgentStopCleanup(completion.agent.agent_id);
      }
      if (completion.completed && !completion.cleanupRequired) {
        this.emit({
          runId: agent.run_id,
          agentId: agent.agent_id,
          type: "agent.started",
          payload: {
            backend: agent.backend,
            title: agent.title,
            reason: "authoritative_backend_handle_recovered"
          }
        });
        this.store.touchHeartbeat(agent.agent_id);
        this.armStatusWatcher(agent);
      }
    } else {
      startAttempt = this.store.resolveAgentStartAttempt(agentId, stepInstanceId);
    }
    const attemptCrossedInvocationBoundary = Boolean(
      startAttempt &&
        (startAttempt.phase === "invoking" ||
          startAttempt.phase === "succeeded" ||
          startAttempt.phase === "superseded" ||
          startAttempt.phase === "failed" ||
          startAttempt.phase === "ambiguous")
    );
    return {
      agent,
      openAction,
      startAttempt,
      hasDurableStartEvidence:
        Boolean(agent.backend_handle) ||
        stepActions.length > 0 ||
        attemptCrossedInvocationBoundary ||
        TERMINAL_STATUSES.has(agent.status) ||
        hasStartedEvent
    };
  }

  /**
   * Resolve one durable worker assignment while holding SQLite's write
   * reservation. `fresh_per_step` never consults the persistent role card:
   * its deterministic title contains the step-instance id and the new record
   * starts without a backend handle, which forces codex-thread to call
   * `thread/start` instead of adding a turn to an earlier review thread.
   */
  private resolveFlowStepDispatchAgent(input: {
    snapshot: FlowSnapshot;
    activeStep: FlowStepInstanceRecord;
    run: RunRecord;
    backend: string;
    agentToken: string | null;
  }): { agent: AgentRecord; step: FlowStepInstanceRecord } {
    return this.store.immediateTransaction(() => {
      const step = this.getFlowStepInstanceOrThrow(input.activeStep.step_instance_id);
      if (
        step.flow_instance_id !== input.snapshot.instance.flow_instance_id ||
        step.status !== "active"
      ) {
        throw new ControllerError(
          "Flow step is no longer the active dispatch target.",
          "tool_error",
          {
            flow_instance_id: input.snapshot.instance.flow_instance_id,
            step_instance_id: step.step_instance_id,
            status: step.status
          }
        );
      }
      if (step.agent_id) {
        const assigned = this.getAgent(step.agent_id);
        if (assigned.unregistered_at || assigned.run_id !== input.run.run_id || assigned.backend !== input.backend) {
          throw new ControllerError(
            "Assigned flow worker does not match the active step backend or run.",
            "tool_error",
            {
              step_instance_id: step.step_instance_id,
              agent_id: assigned.agent_id,
              expected_backend: input.backend,
              actual_backend: assigned.backend
            }
          );
        }
        return { agent: assigned, step };
      }

      this.assertNewWorkAllowed(input.run.run_id, "flow_dispatch_active");
      const stepConfig = input.snapshot.flow.config.steps[step.step_id];
      const role = stepConfig.role;
      const roleConfig = role ? input.snapshot.flow.config.roles?.[role] : undefined;
      const lifecycle = resolveFlowAgentLifecycle(roleConfig?.agent_lifecycle);
      let agent: AgentRecord | null = null;

      if (lifecycle === "fresh_per_step") {
        const title = freshFlowStepAgentTitle(
          input.snapshot.flow.flow_id,
          role ?? step.step_id,
          step.step_id,
          step.step_instance_id
        );
        // The exact-title lookup is recovery for a partially migrated or
        // manually repaired database. Under normal execution registration and
        // assignment are in this same transaction, so no orphan can escape.
        agent =
          this.store
            .listAgents({ runId: input.run.run_id })
            .find(
              (candidate) =>
                !candidate.unregistered_at &&
                candidate.backend === input.backend &&
                candidate.role === (role ?? null) &&
                candidate.title === title
            ) ?? null;
        if (!agent) {
          const { agent_token: _agentToken, ...created } = this.registerAgent({
            runId: input.run.run_id,
            backend: input.backend,
            title,
            role,
            objective: input.run.title,
            repoDir: input.run.repo_dir,
            model: roleConfig?.model,
            // Never pass or copy a backend handle here. A fresh lifecycle is
            // an Agent Control identity boundary and a backend context boundary.
            agentToken: input.agentToken
          });
          agent = created;
        }
      } else if (input.snapshot.flow.config.policy?.strict) {
        const ownerId = this.flowRuntime.get(input.snapshot.instance.flow_instance_id)?.owners[role ?? step.step_id];
        if (!ownerId) throw new ControllerError("The flow role has no pinned owner; explicit recovery is required.", "tool_error");
        agent = this.getAgent(ownerId);
        if (agent.unregistered_at || agent.backend !== input.backend || agent.run_id !== input.run.run_id) throw new ControllerError("The pinned role owner is unavailable; silent replacement is forbidden.", "tool_error");
      } else {
        agent =
          this.findDeclaredFlowAgent(
            input.run.run_id,
            input.snapshot.flow.flow_id,
            role,
            input.backend
          ) ??
          this.registerAgent({
            runId: input.run.run_id,
            backend: input.backend,
            title: declaredFlowAgentTitle(input.snapshot.flow.flow_id, role ?? step.step_id),
            role,
            objective: input.run.title,
            repoDir: input.run.repo_dir,
            model: roleConfig?.model,
            agentToken: input.agentToken
          });
      }

      this.assertNewWorkAllowed(input.run.run_id, "flow_dispatch_active", agent);
      const assigned = this.store.updateFlowStepInstance(step.step_instance_id, {
        agentId: agent.agent_id,
        inputJson: assignFlowStepWorkerAgent(step.input_json, agent.agent_id)
      });
      return { agent, step: assigned };
    });
  }

  /**
   * Persistent role cards can be linked when the flow starts. Fresh cards do
   * not exist yet, so materialize their real incoming/outgoing handoffs when
   * the step is dispatched. The latest transition targeting the active step
   * is its concrete predecessor; rerunning a review therefore links reviewer
   * N to the distinct reviewer N+1 rather than to a synthetic role node.
   */
  private createFreshFlowStepHandoffLinks(input: {
    snapshot: FlowSnapshot;
    activeStep: FlowStepInstanceRecord;
    agent: AgentRecord;
    owner: AgentRecord | null;
  }): void {
    const runId = input.snapshot.instance.run_id;
    const incoming = this.store
      .listFlowTransitions(input.snapshot.instance.flow_instance_id)
      .filter((transition) => transition.target_step_id === input.activeStep.step_id)
      .at(-1);
    if (incoming) {
      const sourceStep = this.store.getFlowStepInstance(incoming.from_step_instance_id);
      if (sourceStep?.agent_id && sourceStep.agent_id !== input.agent.agent_id) {
        this.createAgentLinkIfMissing({
          runId,
          sourceAgentId: sourceStep.agent_id,
          targetAgentId: input.agent.agent_id,
          type: "handoff",
          label: incoming.transition_id
        });
      }
    }

    const stepConfig = input.snapshot.flow.config.steps[input.activeStep.step_id];
    for (const [eventName, action] of Object.entries(stepConfig.on ?? {})) {
      for (const target of flowActionTargets(action, eventName)) {
        let targetAgent: AgentRecord | null = null;
        if (target.kind === "notify") {
          if (
            input.owner &&
            (input.owner.role === target.id || target.id === "orchestrator")
          ) {
            targetAgent = input.owner;
          } else {
            const targetRole = input.snapshot.flow.config.roles?.[target.id];
            if (resolveFlowAgentLifecycle(targetRole?.agent_lifecycle) === "reuse") {
              targetAgent = this.findDeclaredFlowAgent(
                runId,
                input.snapshot.flow.flow_id,
                target.id,
                targetRole?.backend
              );
            }
          }
        } else {
          const targetStep = input.snapshot.flow.config.steps[target.id];
          const targetRole = targetStep?.role
            ? input.snapshot.flow.config.roles?.[targetStep.role]
            : undefined;
          if (targetStep && resolveFlowAgentLifecycle(targetRole?.agent_lifecycle) === "reuse") {
            const explicit = targetStep.agent_id
              ? this.store.getAgent(targetStep.agent_id)
              : null;
            targetAgent =
              explicit && !explicit.unregistered_at && explicit.run_id === runId
                ? explicit
                : this.findDeclaredFlowAgent(
                    runId,
                    input.snapshot.flow.flow_id,
                    targetStep.role,
                    targetRole?.backend
                  );
          }
        }
        if (!targetAgent || targetAgent.agent_id === input.agent.agent_id) {
          continue;
        }
        this.createAgentLinkIfMissing({
          runId,
          sourceAgentId: input.agent.agent_id,
          targetAgentId: targetAgent.agent_id,
          type: "handoff",
          label: target.label
        });
      }
    }
  }

  private ensureDeclaredFlowAgents(input: {
    config: FlowConfig;
    flowId: string;
    instanceId?: string;
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
      // Fresh roles are instantiated only when a concrete step instance is
      // dispatched. Pre-registering one here would create an unused persistent
      // card and would make later steps accidentally share its backend handle.
      if (resolveFlowAgentLifecycle(roleConfig?.agent_lifecycle) === "fresh_per_step") {
        continue;
      }
      const explicit = this.explicitDeclaredAgentForRole(input.config, input.run.run_id, role);
      if (explicit) {
        roleAgents.set(role, explicit);
        continue;
      }
      if (!roleConfig?.backend) {
        continue;
      }
      const existing = input.config.policy?.strict ? null : this.findDeclaredFlowAgent(input.run.run_id, input.flowId, role, roleConfig.backend);
      if (existing) {
        roleAgents.set(role, existing);
        continue;
      }

      const planned = this.registerAgent({
        runId: input.run.run_id,
        backend: roleConfig.backend,
        title: declaredFlowAgentTitle(input.config.policy?.strict ? `${input.flowId}/${input.instanceId}` : input.flowId, role),
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

  /**
   * Commit the backend handle and start-attempt outcome as one lifecycle
   * decision. Stop intent and a superseding flow route both project the agent
   * directly to `stopping`, making the handle restart-safe before compensation
   * performs any external I/O.
   */
  private completeNonNativeStartAttemptWithHandle(input: {
    attempt: AgentStartAttemptRecord;
    handle: Record<string, unknown>;
  }): {
    completed: boolean;
    attempt: AgentStartAttemptRecord;
    agent: AgentRecord;
    cleanupRequired: boolean;
    cleanupReason: string | null;
    flowRecovered: boolean;
    startState: AgentStartState;
  } {
    return this.store.immediateTransaction(() => {
      const completion = this.store.completeAgentStartAttemptSuccess({
        startAttemptId: input.attempt.start_attempt_id,
        claimOwnerId: input.attempt.claim_owner_id,
        handle: input.handle
      });
      let agent = this.getAgent(input.attempt.agent_id);
      let attempt = completion.attempt;
      let flowRecovered = false;

      /**
       * Persist the concrete returned handle before compensating it outside the
       * transaction. Reopening a fully stopped run to `stopping` is intentional:
       * the adapter response is new proof that a live session may exist.
       */
      const requireCleanup = (
        reason: string,
        startState: AgentStartState
      ): {
        completed: boolean;
        attempt: AgentStartAttemptRecord;
        agent: AgentRecord;
        cleanupRequired: true;
        cleanupReason: string;
        flowRecovered: false;
        startState: AgentStartState;
      } => {
        const run = this.getRun(agent.run_id);
        if (run.status === "stopped") {
          this.store.updateRunStatus(run.run_id, "stopping");
        }
        agent = this.store.updateAgent(agent.agent_id, {
          backendHandle: input.handle,
          status: "stopping",
          failureReason: agent.failure_reason
        });
        return {
          completed: completion.completed,
          attempt,
          agent,
          cleanupRequired: true,
          cleanupReason: reason,
          flowRecovered: false,
          startState
        };
      };

      if (completion.completed) {
        // Route ownership is validated for every successful adapter response,
        // not only for attempts that had already crossed into ambiguity.
        const flowDecision = this.reconcileStartFlowOwnershipInTransaction(
          attempt,
          completion.previousPhase === "ambiguous"
        );
        flowRecovered = flowDecision.outcome === "recovered";
        if (flowDecision.outcome === "superseded") {
          attempt = this.store.markAgentStartAttemptSuperseded({
            startAttemptId: attempt.start_attempt_id,
            claimOwnerId: attempt.claim_owner_id,
            handle: input.handle,
            reason: flowDecision.reason
          }).attempt;
          return requireCleanup(
            `late_backend_start_superseded:${flowDecision.reason}`,
            "superseded"
          );
        }
        if (this.hasDurableStopIntent(agent)) {
          return requireCleanup(
            "durable_stop_won_backend_start",
            startStateFromAttemptPhase(attempt.phase)
          );
        }
        const projection = this.store.updateAgentForNewWork(agent.agent_id, {
          backendHandle: input.handle,
          status: "running",
          failureReason: null
        });
        if (projection.changed) {
          return {
            completed: true,
            attempt: completion.attempt,
            agent: projection.agent,
            cleanupRequired: false,
            cleanupReason: null,
            flowRecovered,
            startState: "started"
          };
        }
        agent = projection.agent;
        return requireCleanup(
          "durable_stop_won_backend_start_projection",
          startStateFromAttemptPhase(attempt.phase)
        );
      }

      const startState = startStateFromAttemptPhase(attempt.phase);
      if (attempt.phase === "succeeded") {
        // Another controller may have completed this exact invocation from
        // authoritative backend metadata. Preserve that controller's durable
        // handle and report a coherent success instead of `in_progress`.
        const flowDecision = this.reconcileStartFlowOwnershipInTransaction(
          attempt,
          false
        );
        if (flowDecision.outcome === "superseded") {
          attempt = this.store.markAgentStartAttemptSuperseded({
            startAttemptId: attempt.start_attempt_id,
            claimOwnerId: attempt.claim_owner_id,
            handle: input.handle,
            reason: flowDecision.reason
          }).attempt;
          return requireCleanup(
            `late_backend_start_superseded:${flowDecision.reason}`,
            "superseded"
          );
        }
        if (this.hasDurableStopIntent(agent)) {
          return requireCleanup("durable_stop_won_backend_start", startState);
        }
        const durableHandle = agent.backend_handle ?? attempt.handle_json;
        if (!durableHandle) {
          // A succeeded attempt is required to retain its handle. Treat a
          // corrupt/migrated row conservatively as a live response that must be
          // stopped instead of fabricating an in-progress state.
          return requireCleanup("succeeded_start_missing_durable_handle", startState);
        }
        const projection = this.store.updateAgentForNewWork(agent.agent_id, {
          backendHandle: durableHandle,
          status: "running",
          failureReason: null
        });
        if (projection.changed) {
          return {
            completed: false,
            attempt,
            agent: projection.agent,
            cleanupRequired: false,
            cleanupReason: null,
            flowRecovered: false,
            startState
          };
        }
        agent = projection.agent;
        return requireCleanup("durable_stop_won_reconciled_start", startState);
      }

      // Any other current phase means this response no longer owns a start
      // completion CAS. It still returned a concrete session, so compensate it
      // while preserving the exact durable phase in the public start state.
      return requireCleanup(
        `backend_start_response_after_${attempt.phase}`,
        startState
      );
    });
  }

  async startAgent(input: Parameters<AgentController["startAgentExecution"]>[0] & RequesterInput): Promise<AgentStartResult> {
    const agent = this.getAgent(input.agentId);
    const observer = this.ensureRequester(agent.run_id, input);
    const result = await this.startAgentExecution(input);
    return { ...result, observer };
  }

  private async startAgentExecution(input: {
    agentId: string;
    prompt?: string;
    server?: string;
    model?: string;
    expectedArtifacts?: string[];
    attachments?: string[];
    metadata?: Record<string, unknown>;
    agentToken?: string | null;
    bridgeGrantId?: string | null;
    forkTurns?: CodexSubagentForkTurns;
  }): Promise<AgentStartResult> {
    let agent = this.getAgent(input.agentId);
    if (this.isAttachedParticipant(agent)) throw new ControllerError("An attached conversation cannot be started as a worker.", "unsupported_operation");
    if (input.agentToken) {
      const caller = this.requireAgentToken(input.agentToken);
      if (!this.canAgentAccessRun(caller, agent.run_id)) {
        throw new ControllerError(`Agent not accessible: ${agent.agent_id}`, "auth_required", {
          agent_id: agent.agent_id
        });
      }
    }
    // This guard deliberately lives outside the start try/catch. A durable
    // stop rejection is policy state, not a backend failure, and therefore
    // must never rewrite a stopping/stopped agent to failed.
    this.assertNewWorkAllowed(agent.run_id, "agent_start", agent);
    const adapter = this.adapters.get(agent.backend);
    const capabilities = adapter.capabilities();
    if (!capabilities.canStart && !agent.backend_handle) {
      throw new ControllerError(`Backend cannot start agents: ${agent.backend}`, "unsupported_operation", {
        backend: agent.backend
      });
    }

    let runtimeToken: string | null = null;
    let startAttempt: AgentStartAttemptRecord | null = null;
    let invocationBegan = false;
    try {
      if (capabilities.requiresOrchestratorAction) {
        this.assertSupportedCodexSubagentStart(agent, input);
        agent = this.recoverCodexSubagentSpawnHandle(agent);
        let nativeStepOperation: "send_message" | "followup_task" | null = null;
        let nativeActionWasKnown = false;
        if (agent.backend_handle) {
          const stepInstanceId = requiredRecordString(input.metadata, "step_instance_id");
          const existingStepAction = this.store.getOrchestratorActionByIdempotencyKey(
            `step-message:${stepInstanceId}`
          );
          nativeActionWasKnown = Boolean(existingStepAction);
          nativeStepOperation =
            existingStepAction?.operation === "send_message" ||
            existingStepAction?.operation === "followup_task"
              ? existingStepAction.operation
              : "followup_task";
        } else {
          this.assertCodexSubagentHasNoPriorSpawnForAnotherStep(agent, input.metadata);
          const stepInstanceId = requiredRecordString(input.metadata, "step_instance_id");
          nativeActionWasKnown = Boolean(
            this.store.getOrchestratorActionByIdempotencyKey(`spawn:${stepInstanceId}`)
          );
        }
        const action = nativeStepOperation
          ? this.enqueueCodexSubagentStepMessage({
              agent,
              prompt: input.prompt!,
              metadata: input.metadata!,
              bridgeGrantId: input.bridgeGrantId,
              operation: nativeStepOperation
            })
          : this.enqueueCodexSubagentSpawn({
              agent,
              prompt: input.prompt,
              metadata: input.metadata,
              bridgeGrantId: input.bridgeGrantId,
              forkTurns: input.forkTurns
            });
        // The action-open check and status projection share one SQLite write
        // reservation. An ACK that commits first is therefore final and can no
        // longer be overwritten by this dispatcher's stale pre-ACK snapshot.
        const projection = this.projectNativeActionForNewWork({
          actionId: action.action_id,
          agentId: agent.agent_id,
          actionWasKnown: nativeActionWasKnown
        });
        agent = projection.agent;
        const surfaced = this.orchestratorActionAfterNewWorkProjection(
          action.action_id,
          agent.agent_id
        );
        return surfaced.action
          ? { ...surfaced.agent, orchestrator_action: surfaced.action }
          : surfaced.agent;
      }

      const flowInstanceId = nullableRecordString(input.metadata, "flow_instance_id");
      const stepInstanceId = nullableRecordString(input.metadata, "step_instance_id");
      if (flowInstanceId && stepInstanceId) {
        const claim = this.store.claimAgentStartAttempt({
          agentId: agent.agent_id,
          flowInstanceId,
          stepInstanceId,
          generation: 1,
          leaseExpiresAt: new Date(
            Date.now() + NON_NATIVE_START_ATTEMPT_LEASE_MS
          ).toISOString()
        });
        if (claim.type === "stop_intent") {
          this.assertNewWorkAllowed(agent.run_id, "agent_start", this.getAgent(agent.agent_id));
          throw new ControllerError(
            "Agent start attempt was rejected by durable stop intent.",
            "tool_error",
            { agent_id: agent.agent_id, run_id: agent.run_id }
          );
        }
        startAttempt = claim.attempt;
        if (claim.type === "in_progress") {
          return { ...this.getAgent(agent.agent_id), start_state: "in_progress" };
        }
        if (claim.type === "ambiguous") {
          return { ...this.getAgent(agent.agent_id), start_state: "ambiguous" };
        }
        if (claim.type === "terminal") {
          return {
            ...this.getAgent(agent.agent_id),
            start_state: startStateFromAttemptPhase(claim.attempt.phase)
          };
        }
      }

      const statusChanged = agent.status !== "starting" || agent.failure_reason !== null;
      const startingProjection = this.store.updateAgentForNewWork(agent.agent_id, {
        status: "starting",
        failureReason: null
      }, {
        advanceWorkGeneration: true
      });
      agent = startingProjection.agent;
      if (!startingProjection.changed) {
        this.assertNewWorkAllowed(agent.run_id, "agent_start", agent);
        throw new ControllerError(
          "Agent start lost its durable new-work projection race.",
          "tool_error",
          { agent_id: agent.agent_id, run_id: agent.run_id }
        );
      }
      if (statusChanged) {
        this.emit({
          runId: agent.run_id,
          agentId: agent.agent_id,
          type: "agent.status_changed",
          payload: { status: "starting" }
        });
      }
      runtimeToken = this.issueAgentToken(agent.agent_id);
      if (startAttempt) {
        const boundary = this.store.beginAgentStartAttempt({
          startAttemptId: startAttempt.start_attempt_id,
          claimOwnerId: startAttempt.claim_owner_id,
          leaseExpiresAt: new Date(
            Date.now() + NON_NATIVE_START_ATTEMPT_LEASE_MS
          ).toISOString()
        });
        startAttempt = boundary.attempt;
        if (!boundary.began) {
          const current = this.getAgent(agent.agent_id);
          return {
            ...current,
            agent_token: runtimeToken,
            start_state: startStateFromAttemptPhase(boundary.attempt.phase)
          };
        }
        invocationBegan = true;
      }
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
      let updated: AgentRecord;
      if (startAttempt) {
        const completion = this.completeNonNativeStartAttemptWithHandle({
          attempt: startAttempt,
          handle: handle.data
        });
        if (!completion.completed) {
          if (completion.cleanupRequired) {
            return this.reconcileLateNonNativeStartAfterStop(
              completion.agent,
              handle,
              adapter,
              runtimeToken!,
              completion.cleanupReason ?? "late_backend_start_cleanup_required",
              completion.startState
            );
          }
          return {
            ...completion.agent,
            agent_token: runtimeToken!,
            start_state: completion.startState
          };
        }
        if (completion.cleanupRequired) {
          return this.reconcileLateNonNativeStartAfterStop(
            completion.agent,
            handle,
            adapter,
            runtimeToken!,
            completion.cleanupReason ?? "late_backend_start_cleanup_required",
            completion.startState
          );
        }
        updated = completion.agent;
        if (completion.flowRecovered) {
          this.emitLateStartFlowRecovery(completion.attempt, updated);
        }
        const durableAfterCompletion = this.getAgent(updated.agent_id);
        if (this.hasDurableStopIntent(durableAfterCompletion)) {
          return {
            ...durableAfterCompletion,
            agent_token: runtimeToken!,
            start_state: completion.startState
          };
        }
        updated = durableAfterCompletion;
      } else {
        const postStartProjection = this.store.updateAgentForNewWork(agent.agent_id, {
          backendHandle: handle.data,
          status: "running",
          failureReason: null
        });
        if (!postStartProjection.changed) {
          return this.reconcileLateNonNativeStartAfterStop(
            postStartProjection.agent,
            handle,
            adapter,
            runtimeToken!
          );
        }
        updated = postStartProjection.agent;
      }
      this.emit({
        runId: updated.run_id,
        agentId: updated.agent_id,
        type: "agent.started",
        payload: { backend: updated.backend, title: updated.title }
      });
      this.store.touchHeartbeat(updated.agent_id);
      this.armStatusWatcher(updated);
      return { ...updated, agent_token: runtimeToken!, start_state: "started" };
    } catch (error) {
      const payload = errorToPayload(error);
      if (startAttempt) {
        if (invocationBegan) {
          startAttempt = this.store.markAgentStartAttemptAmbiguous({
            startAttemptId: startAttempt.start_attempt_id,
            claimOwnerId: startAttempt.claim_owner_id,
            error: {
              ...payload,
              reason: "backend_start_outcome_ambiguous",
              invocation_started_at: startAttempt.invocation_started_at
            }
          });
        } else {
          this.store.releasePreparedAgentStartAttempt({
            startAttemptId: startAttempt.start_attempt_id,
            claimOwnerId: startAttempt.claim_owner_id,
            error: {
              ...payload,
              reason: "backend_start_failed_before_invocation"
            }
          });
        }
      }
      const current = this.getAgent(agent.agent_id);
      if (this.hasDurableStopIntent(current)) {
        // A stop that wins while start is pending is lifecycle authority. A
        // backend failure or an atomic action-creation rejection must not
        // overwrite that durable state with `failed`.
        if (runtimeToken) {
          return {
            ...current,
            agent_token: runtimeToken,
            ...(startAttempt && invocationBegan
              ? { start_state: startStateFromAttemptPhase(startAttempt.phase) }
              : {})
          };
        }
        throw error;
      }
      if (startAttempt && !invocationBegan) {
        // The adapter call provably never began. Leave the prepared attempt
        // immediately reclaimable instead of converting transient local
        // preparation failure into terminal start evidence.
        throw error;
      }
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
      if (runtimeToken) {
        return {
          ...failed,
          agent_token: runtimeToken,
          ...(startAttempt && invocationBegan
            ? { start_state: startStateFromAttemptPhase(startAttempt.phase) }
            : {})
        };
      }
      throw error;
    }
  }

  private async reconcileLateNonNativeStartAfterStop(
    agent: AgentRecord,
    handle: AgentHandle,
    adapter: AgentAdapter,
    runtimeToken: string,
    cleanupReason = "durable_stop_won_backend_start",
    startState?: AgentStartState
  ): Promise<AgentWithToken> {
    const reconciled = await this.reconcileLateNonNativeWorkAfterStop(
      agent,
      handle,
      adapter,
      "start",
      cleanupReason
    );
    return {
      ...reconciled,
      agent_token: runtimeToken,
      ...(startState ? { start_state: startState } : {})
    };
  }

  private async reconcileLateNonNativeWorkAfterStop(
    agent: AgentRecord,
    handle: AgentHandle,
    adapter: AgentAdapter,
    work: "start" | "send",
    cleanupReason = `backend_${work}_completed_after_stop`
  ): Promise<AgentRecord> {
    const beforeStatus = agent.status;
    const stopping = this.store.immediateTransaction(() => {
      const run = this.getRun(agent.run_id);
      if (run.status === "stopped") {
        // Shutdown may have finalized while the backend call was awaiting.
        // Reopen only to `stopping`; the compensating stop below is now the
        // cleanup authority for the backend session that just became live.
        this.store.updateRunStatus(run.run_id, "stopping");
      }
      const current = this.getAgent(agent.agent_id);
      return this.store.updateAgent(current.agent_id, {
        backendHandle: handle.data,
        status: "stopping",
        failureReason: current.failure_reason
      });
    });
    if (beforeStatus !== "stopping") {
      this.emit({
        runId: stopping.run_id,
        agentId: stopping.agent_id,
        type: "agent.status_changed",
        payload: {
          status: "stopping",
          reason: cleanupReason
        }
      });
    }

    let stopResult: StopResult;
    try {
      stopResult = await adapter.stop(handle, { mode: "graceful" });
    } catch (error) {
      const payload = errorToPayload(error);
      const unresolved = this.store.updateAgent(stopping.agent_id, {
        backendHandle: handle.data,
        status: "stopping",
        failureReason: payload.reason as FailureReason
      });
      this.emit({
        runId: unresolved.run_id,
        agentId: unresolved.agent_id,
        type: "agent.status_changed",
        payload: {
          status: "stopping",
          reason: `compensating_stop_after_late_${work}_failed`,
          cleanup_reason: cleanupReason,
          message: payload.error
        }
      });
      return unresolved;
    }
    const status = TERMINAL_STATUSES.has(stopResult.status)
      ? stopResult.status
      : "stopping";
    return this.commitAgentStopProjection(
      stopping.agent_id,
      {
        backendHandle: handle.data,
        status,
        failureReason: stopResult.failureReason ?? null
      },
      {
        status,
        reason: `compensating_stop_after_late_${work}`,
        cleanup_reason: cleanupReason,
        message: stopResult.message,
        data: stopResult.data
      }
    );
  }

  private nativeActionMayPrepareAgent(
    agent: AgentRecord,
    action: OrchestratorActionRecord,
    actionWasKnown: boolean
  ): boolean {
    if (this.hasDurableStopIntent(agent)) {
      return false;
    }
    if (!TERMINAL_STATUSES.has(agent.status)) {
      return true;
    }
    const externalObservedAt = nullableRecordString(
      this.store.getCodexSubagentExternalState(agent.agent_id),
      "observed_at"
    );
    // A terminal observation from the previous step predates a newly-created
    // follow-up and is intentionally cleared so the task can resume. A
    // terminal observation at/after an already-open action is newer lifecycle
    // truth and must survive dispatch retries just like it survives late ACKs.
    if (!externalObservedAt) {
      return true;
    }
    const ordering = Date.parse(externalObservedAt) - Date.parse(action.created_at);
    return ordering < 0 || (ordering === 0 && !actionWasKnown);
  }

  /**
   * Serialize a handleless stop with the non-native start boundary. Prepared
   * work is provably cancellable; invoking or ambiguous work may already own a
   * backend session and therefore remains `stopping` until the original call
   * supplies a handle for compensating stop.
   */
  private prepareHandlelessNonNativeStartStop(agentId: string): {
    outcome: "safe_without_session" | "backend_start_uncertain";
    agent: AgentRecord;
    attempt: AgentStartAttemptRecord | null;
  } {
    const pendingEvents: EventRecord[] = [];
    const prepared = this.store.immediateTransaction(() => {
      return this.prepareHandlelessNonNativeStartStopInTransaction(
        agentId,
        (event) => {
          pendingEvents.push(this.store.createEvent(event));
        }
      );
    });
    for (const event of pendingEvents) {
      this.scheduleEventDelivery(event);
    }
    return prepared;
  }

  /**
   * Cancel every pre-invocation attempt and project the logical worker to its
   * matching terminal state under the caller's write reservation. Keeping both
   * writes in one transaction prevents another controller from observing a
   * cancelled attempt while the agent card still looks queued/startable.
   */
  private prepareHandlelessNonNativeStartStopInTransaction(
    agentId: string,
    eventSink: (event: ControllerEventInput) => void
  ): {
    outcome: "safe_without_session" | "backend_start_uncertain";
    agent: AgentRecord;
    attempt: AgentStartAttemptRecord | null;
  } {
    const attempts = this.store.cancelPreparedAgentStartAttempts(agentId, {
      reason: "agent_stop_before_backend_start_invocation",
      message: "The prepared backend start was cancelled before its invocation boundary."
    });
    const attempt =
      attempts
        .filter((candidate) =>
          candidate.phase === "invoking" || candidate.phase === "ambiguous"
        )
        .at(-1) ??
      attempts.at(-1) ??
      null;
    const current = this.getAgent(agentId);
    if (attempt && (attempt.phase === "invoking" || attempt.phase === "ambiguous")) {
      const run = this.getRun(current.run_id);
      if (run.status === "stopped") {
        this.store.updateRunStatus(run.run_id, "stopping");
      }
      return {
        outcome: "backend_start_uncertain" as const,
        agent: this.store.updateAgent(agentId, {
          status: "stopping",
          failureReason: current.failure_reason
        }),
        attempt
      };
    }
    const stopped = TERMINAL_STATUSES.has(current.status)
      ? current
      : this.store.updateAgent(agentId, {
          status: "stopped",
          failureReason: null
        });
    if (stopped.status === "stopped") {
      this.recordControllerEvent(
        {
          eventId: agentStoppedEventId(stopped),
          runId: stopped.run_id,
          agentId: stopped.agent_id,
          type: "agent.stopped",
          payload: {
            status: "stopped",
            message: "Prepared backend start was cancelled before adapter invocation."
          }
        },
        eventSink
      );
      this.finalizeStoppingRunIfTerminal(stopped.run_id, eventSink);
    }
    return {
      outcome: "safe_without_session" as const,
      agent: stopped,
      attempt
    };
  }

  private projectNativeActionForNewWork(input: {
    actionId: string;
    agentId: string;
    actionWasKnown: boolean;
  }): { agent: AgentRecord; action: OrchestratorActionRecord | null } {
    const pendingEvents: EventRecord[] = [];
    const projection = this.store.immediateTransaction(() => {
      const action = this.store.getOrchestratorAction(input.actionId);
      const agent = this.getAgent(input.agentId);
      if (
        !action ||
        action.agent_id !== agent.agent_id ||
        (action.status !== "pending" && action.status !== "claimed") ||
        !this.nativeActionMayPrepareAgent(agent, action, input.actionWasKnown)
      ) {
        return { agent, action };
      }

      const pendingStatus: AgentStatus =
        action.operation === "send_message" ? "running" : "starting";
      const statusChanged =
        agent.status !== pendingStatus || agent.failure_reason !== null;
      const updated = this.store.updateAgentForOpenOrchestratorAction(
        action.action_id,
        agent.agent_id,
        {
          status: pendingStatus,
          failureReason: null
        }
      );
      if (updated.changed && statusChanged) {
        pendingEvents.push(
          this.store.createEvent({
            runId: updated.agent.run_id,
            agentId: updated.agent.agent_id,
            type: "agent.status_changed",
            payload: { status: pendingStatus, operation: action.operation }
          })
        );
      }
      return { agent: updated.agent, action: updated.action };
    });
    for (const event of pendingEvents) {
      this.scheduleEventDelivery(event);
    }
    return projection;
  }

  private acceptedWorkLeaseExpiresAt(): string {
    return new Date(Date.now() + ACCEPTED_WORK_LEASE_MS).toISOString();
  }

  /**
   * Keep ownership alive only while this controller is awaiting adapter I/O.
   * The timer is unref'd so it never keeps a process alive. A crash stops
   * renewals; a restarted controller can then convert the stale invocation to
   * ambiguity without replaying it. Renewal loss deliberately stops this
   * heartbeat because another durable transition already owns the attempt.
   */
  private maintainAcceptedWorkLease(agentId: string, acceptanceKey: string): () => void {
    let active = true;
    const timer = setInterval(() => {
      if (!active) {
        return;
      }
      try {
        const renewed = this.store.renewAgentAcceptedWorkLease({
          agentId,
          acceptanceKey,
          claimOwnerId: this.controllerInstanceId,
          leaseExpiresAt: this.acceptedWorkLeaseExpiresAt()
        });
        if (!renewed) {
          active = false;
          clearInterval(timer);
        }
      } catch {
        // A transient SQLite writer can delay one renewal. Keep the timer alive
        // so the next interval can renew unless recovery has already won.
      }
    }, ACCEPTED_WORK_LEASE_RENEW_INTERVAL_MS);
    timer.unref();
    return () => {
      if (!active) {
        return;
      }
      active = false;
      clearInterval(timer);
    };
  }

  async sendMessage(agentId: string, message: string): Promise<AgentSendResult> {
    const agent = this.getAgent(agentId);
    if (this.isAttachedParticipant(agent)) {
      const adapter = this.adapters.get(agent.backend);
      if (agent.backend === "codex-session") {
        const receipt = await (adapter as CodexSessionAdapter).sendMessageWithReceipt(this.requireHandle(agent), message);
        this.armStatusWatcher(agent);
        return { agent: await this.refreshAgentStatus(agentId), ...receipt };
      }
      if (!adapter.stageNotification) throw new ControllerError("Safe notification staging is unavailable.", "unsupported_operation");
      await adapter.stageNotification(this.requireHandle(agent), { message });
      return { agent, delivered: true };
    }
    this.assertNewWorkAllowed(agent.run_id, "agent_send_message", agent);
    const adapter = this.adapters.get(agent.backend);
    const capabilities = adapter.capabilities();
    if (!capabilities.canSendMessage) {
      throw new ControllerError(
        `Backend cannot deliver messages: ${agent.backend}`,
        "unsupported_operation",
        { backend: agent.backend, agent_id: agent.agent_id }
      );
    }
    if (capabilities.requiresOrchestratorAction) {
      const operation = this.enqueueCodexSubagentMessage(agent, message);
      this.projectNativeActionForNewWork({
        actionId: operation.action.action_id,
        agentId,
        actionWasKnown: false
      });
      const surfaced = this.orchestratorActionAfterNewWorkProjection(
        operation.action.action_id,
        agentId
      );
      return {
        agent: surfaced.agent,
        delivered: false,
        orchestrator_action: surfaced.action
      };
    }

    const handle = this.requireHandle(agent);
    const sendAttemptId = newId("sendattempt");
    const acceptanceKey = `send:${agentId}:${sendAttemptId}`;
    // Crossing the adapter invocation boundary makes acceptance uncertain even
    // if the eventual response rejects. Fence older status observations and
    // make this attempt inspectable before I/O, without overriding a stop that
    // already won the same SQLite reservation.
    const acceptedAttempt = this.store.advanceAgentWorkGenerationForAcceptedWork(
      agentId,
      acceptanceKey,
      {
        claimOwnerId: this.controllerInstanceId,
        leaseExpiresAt: this.acceptedWorkLeaseExpiresAt(),
        projectStatus: "running",
        failureReason: null
      }
    );
    if (acceptedAttempt.type === "stop_intent") {
      throw new ControllerError(
        "Durable stop intent blocks this agent message.",
        "tool_error",
        {
          agent_id: agentId,
          run_id: acceptedAttempt.agent.run_id,
          reason: "durable_stop_intent"
        }
      );
    }
    if (acceptedAttempt.type === "already_accepted") {
      // A durable key means an earlier process may already have crossed the
      // adapter boundary. Never turn an idempotency replay into duplicate I/O.
      throw new ControllerError(
        "This physical send attempt already has durable acceptance evidence.",
        "tool_error",
        { agent_id: agentId, reason: "accepted_work_already_recorded" }
      );
    }
    const attemptWorkGeneration = acceptedAttempt.agent.work_generation;
    const attemptWorkRevision = acceptedAttempt.agent.work_revision;
    const stopLeaseHeartbeat = this.maintainAcceptedWorkLease(agentId, acceptanceKey);
    try {
      await adapter.sendMessage(handle, {
        message,
        metadata: { agentToken: this.issueAgentToken(agentId) }
      });
    } catch (error) {
      stopLeaseHeartbeat();
      const payload = errorToPayload(error);
      const pendingEvents: EventRecord[] = [];
      const uncertainty = this.store.immediateTransaction(() => {
        const completion = this.store.completeAgentAcceptedWorkAttempt({
          agentId,
          acceptanceKey,
          claimOwnerId: this.controllerInstanceId,
          outcome: "ambiguous",
          status: "unknown",
          failureReason: "unknown"
        });
        if (
          completion.attemptOwnedAgent &&
          completion.agent.status === "unknown"
        ) {
          pendingEvents.push(
            this.store.createEvent({
              runId: completion.agent.run_id,
              agentId,
              type: "agent.status_changed",
              payload: {
                status: "unknown",
                failure_reason: "unknown",
                reason: "backend_send_outcome_ambiguous",
                send_attempt_id: sendAttemptId,
                work_generation: attemptWorkGeneration,
                work_revision_before_completion: attemptWorkRevision,
                work_revision: completion.agent.work_revision,
                adapter_error: payload.error,
                adapter_failure_reason: payload.reason
              }
            })
          );
        }
        return completion;
      });
      for (const event of pendingEvents) {
        this.scheduleEventDelivery(event);
      }
      if (this.hasDurableStopIntent(uncertainty.agent)) {
        // A rejected response does not prove the backend rejected the message;
        // it may have revived the session and then lost the response. Under
        // durable stop intent, compensate before preserving the caller error.
        await this.reconcileLateNonNativeWorkAfterStop(
          uncertainty.agent,
          handle,
          adapter,
          "send"
        );
      } else if (
        uncertainty.attemptOwnedAgent &&
        uncertainty.agent.status === "unknown" &&
        capabilities.canInspectStatusCheaply
      ) {
        this.store.touchHeartbeat(agentId);
        this.armStatusWatcher(uncertainty.agent);
      }
      throw error;
    }
    stopLeaseHeartbeat();
    const completion = this.store.completeAgentAcceptedWorkAttempt({
      agentId,
      acceptanceKey,
      claimOwnerId: this.controllerInstanceId,
      outcome: "succeeded",
      status: "running",
      failureReason: null
    });
    const completedAfterStop = this.hasDurableStopIntent(completion.agent);
    const event = this.emit({
      runId: completion.agent.run_id,
      agentId,
      type: "agent.message",
      payload: {
        direction: "outbound",
        size: message.length,
        completed_after_stop: completedAfterStop,
        superseded_by_newer_work:
          !completion.attemptOwnedAgent && !completedAfterStop,
        send_attempt_id: sendAttemptId,
        work_generation: attemptWorkGeneration,
        work_revision: completion.agent.work_revision
      }
    });
    if (completion.attemptOwnedAgent && !completedAfterStop) {
      this.store.touchHeartbeat(agentId, event.created_at);
      this.armStatusWatcher(completion.agent);
      return { agent: completion.agent, delivered: true };
    }
    if (!completedAfterStop) {
      // Another physical attempt advanced the generation while this one was in
      // flight. Its projection owns the card; this completed attempt must not
      // rewrite or compensate that newer work.
      return { agent: completion.agent, delivered: true };
    }
    // A backend may accept the send by reviving a session after shutdown's
    // earlier stop already returned. Logical state preservation is not enough:
    // stop the actual handle again and keep durable state in `stopping` until
    // that compensating cleanup reaches a terminal result.
    const reconciled = await this.reconcileLateNonNativeWorkAfterStop(
      completion.agent,
      handle,
      adapter,
      "send"
    );
    return { agent: reconciled, delivered: true };
  }

  async readLatest(agentId: string, limit = 1): Promise<unknown[]> {
    const agent = this.getAgent(agentId);
    const adapter = this.adapters.get(agent.backend);
    const messages = await adapter.readLatest(this.requireHandle(agent), { limit });
    const latest = [...messages].reverse().find((message) => {
      if (message.role !== "assistant" || !activityText(message.text)) return false;
      const metadata = message.metadata ?? {};
      if (metadata.source === "opencode-log-tail") return false;
      return [metadata.type, metadata.kind, metadata.itemType].every((kind) =>
        kind === undefined || kind === "text" || kind === "message" || kind === "agentMessage");
    });
    const current = this.getAgent(agentId);
    if (latest && agent.backend !== "codex-thread" && this.readActivity(current)?.state !== "running" && current.work_generation === agent.work_generation && current.work_revision === agent.work_revision) {
      this.saveActivity(current, { kind: "message", text: latest.text, observed_at: latest.created_at });
    }
    this.store.touchHeartbeat(agentId);
    return messages;
  }

  async refreshAgentStatus(agentId: string): Promise<AgentRecord> {
    const agent = this.getAgent(agentId);
    if (agent.unregistered_at || (agent.backend !== "codex-session" && TERMINAL_STATUSES.has(agent.status))) {
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

    // Status inspection crosses an external I/O boundary. Stop authority may
    // already exist now, or another controller may persist it while getStatus
    // is in flight. Remember the first observation and re-read under a SQLite
    // write reservation before applying the backend snapshot.
    const durableStopIntentBeforeStatusRead = this.hasDurableStopIntent(agent);
    const observedWorkGeneration = agent.work_generation;
    const observedWorkRevision = agent.work_revision;
    const observedBackendHandle = agent.backend_handle;
    let snapshot: AgentStatusSnapshot;
    try {
      snapshot = await adapter.getStatus(this.requireHandle(agent));
    } catch (error) {
      const payload = errorToPayload(error);
      const pendingEvents: EventRecord[] = [];
      const projection = this.store.immediateTransaction(() => {
        let current = this.getAgent(agent.agent_id);
        if (
          current.unregistered_at ||
          (current.backend !== "codex-session" && TERMINAL_STATUSES.has(current.status)) ||
          current.work_generation !== observedWorkGeneration ||
          current.work_revision !== observedWorkRevision ||
          !stableJsonEquals(current.backend_handle, observedBackendHandle)
        ) {
          // The failed observation belongs to stale lifecycle state. In
          // particular, never overwrite a concurrently completed stop or a
          // replacement backend session with an error from the old handle.
          return { agent: current, ordinaryFailure: false, rearmUncertainty: false };
        }
        const invoking = this.store.resolveInvokingAgentAcceptedWork(
          current.agent_id,
          current.work_generation,
          current.work_revision
        );
        if (invoking.type === "live") {
          // The refresh observed the exact revision currently crossing adapter
          // I/O. Neither an inspection error nor a terminal snapshot can prove
          // that this send was rejected. Its completion will advance the
          // revision and establish the next safe projection boundary.
          return { agent: current, ordinaryFailure: false, rearmUncertainty: true };
        }
        if (invoking.type === "recovered_ambiguous") {
          // Recovery advanced the revision and projected uncertainty. Continue
          // this same error path against that durable state so a transport
          // failure cannot turn an abandoned, possibly accepted send into a
          // definitive agent failure.
          current = invoking.agent;
        }
        const cleanupPending =
          durableStopIntentBeforeStatusRead || this.hasDurableStopIntent(current);
        if (cleanupPending) {
          const unresolved = this.store.updateAgent(current.agent_id, {
            status: "stopping",
            failureReason: payload.reason as FailureReason
          });
          pendingEvents.push(
            this.store.createEvent({
              runId: unresolved.run_id,
              agentId: unresolved.agent_id,
              type: "agent.status_changed",
              payload: {
                status: "stopping",
                reason: "status_refresh_failed_during_cleanup",
                failure_reason: payload.reason,
                error: payload.error
              }
            })
          );
          return { agent: unresolved, ordinaryFailure: false, rearmUncertainty: false };
        }
        if (
          current.status === "unknown" &&
          this.store.agentHasAmbiguousAcceptedWork(
            current.agent_id,
            current.work_generation
          )
        ) {
          // A transport/status inspection error cannot disprove work whose
          // adapter response was already ambiguous. Preserve the inspectable
          // uncertainty so a later healthy refresh can reconcile backend truth.
          const uncertain = this.store.updateAgent(current.agent_id, {
            status: "unknown",
            failureReason: current.failure_reason ?? "unknown"
          });
          pendingEvents.push(
            this.store.createEvent({
              runId: uncertain.run_id,
              agentId: uncertain.agent_id,
              type: "agent.status_changed",
              payload: {
                status: "unknown",
                failure_reason: uncertain.failure_reason,
                reason: "status_refresh_failed_during_work_uncertainty",
                work_generation: uncertain.work_generation,
                work_revision: uncertain.work_revision,
                adapter_error: payload.error,
                adapter_failure_reason: payload.reason
              }
            })
          );
          return { agent: uncertain, ordinaryFailure: false, rearmUncertainty: true };
        }
        if (payload.reason === "backend_unavailable") {
          // A disconnected server is not evidence that its task failed. Keep
          // exact ownership and allow the next read to reconcile backend truth.
          // Do not reset the watcher here: that would turn its bounded probes
          // into an endless three-second retry loop while nobody is observing.
          return { agent: current, ordinaryFailure: false, rearmUncertainty: false };
        }
        const failed = this.store.updateAgent(current.agent_id, {
          status: "failed",
          failureReason: payload.reason as FailureReason
        });
        pendingEvents.push(
          this.store.createEvent({
            runId: failed.run_id,
            agentId: failed.agent_id,
            type: "agent.failed",
            payload
          })
        );
        this.reconcileTerminalStrictFlowWorker(failed);
        this.finalizeStoppingRunIfTerminal(failed.run_id, (event) => {
          pendingEvents.push(this.store.createEvent(event));
        });
        return { agent: failed, ordinaryFailure: true, rearmUncertainty: false };
      });
      for (const event of pendingEvents) {
        this.scheduleEventDelivery(event);
      }
      if (projection.ordinaryFailure) {
        this.disarmStatusWatcher(projection.agent.agent_id);
      } else if (
        projection.rearmUncertainty &&
        adapter.capabilities().canInspectStatusCheaply
      ) {
        this.armStatusWatcher(projection.agent);
      }
      return projection.agent;
    }

    const pendingEvents: EventRecord[] = [];
    const projection = this.store.immediateTransaction(() => {
      let current = this.getAgent(agent.agent_id);
      if (
        current.unregistered_at ||
        (current.backend !== "codex-session" && TERMINAL_STATUSES.has(current.status)) ||
        current.work_generation !== observedWorkGeneration ||
        current.work_revision !== observedWorkRevision ||
        !stableJsonEquals(current.backend_handle, observedBackendHandle)
      ) {
        // The snapshot was taken from lifecycle state that no longer owns this
        // record. Preserve the newer projection rather than reviving a terminal
        // worker or applying an old handle's status to a replacement session.
        return { agent: current, projectedTerminal: false, deferredInvoking: false };
      }
      const invoking = this.store.resolveInvokingAgentAcceptedWork(
        current.agent_id,
        current.work_generation,
        current.work_revision
      );
      if (invoking.type === "live") {
        // Defer every projection, including apparently terminal backend state,
        // until the in-flight acceptance has durably recorded its outcome.
        // This also preserves `stopping` if cleanup won after getStatus began.
        return { agent: current, projectedTerminal: false, deferredInvoking: true };
      }
      if (invoking.type === "recovered_ambiguous") {
        // This healthy snapshot was obtained by the restarted controller from
        // the same backend handle. After atomically closing the expired owner
        // as ambiguity, it may safely reconcile backend truth in this pass.
        current = invoking.agent;
      }
      const cleanupPending =
        durableStopIntentBeforeStatusRead || this.hasDurableStopIntent(current);
      const snapshotFailureReason = snapshot.failureReason ?? null;
      if (cleanupPending && !TERMINAL_STATUSES.has(snapshot.status)) {
        // A nonterminal backend observation proves cleanup is not complete; it
        // cannot revoke the durable stop predicate. Preserve an existing stop
        // diagnostic unless the adapter supplied a more specific one.
        const failureReason = snapshotFailureReason ?? current.failure_reason;
        const unresolved = this.store.updateAgent(current.agent_id, {
          status: "stopping",
          failureReason
        });
        pendingEvents.push(
          this.store.createEvent({
            runId: unresolved.run_id,
            agentId: unresolved.agent_id,
            type: "agent.status_changed",
            payload: {
              status: "stopping",
              reason: "backend_nonterminal_observed_during_cleanup",
              observed_status: snapshot.status,
              failure_reason: failureReason,
              message: snapshot.message,
              data: snapshot.data
            }
          })
        );
        this.store.touchHeartbeat(current.agent_id);
        return { agent: unresolved, projectedTerminal: false, deferredInvoking: false };
      }

      // A terminal status from the same backend handle is authoritative proof
      // that cleanup completed. Without stop intent, retain the ordinary status
      // refresh behavior.
      if (snapshot.data && Object.prototype.hasOwnProperty.call(snapshot.data, "activity")) {
        this.saveActivity(current, snapshot.data.activity);
      }
      const changed =
        snapshot.status !== current.status ||
        snapshotFailureReason !== current.failure_reason;
      let updated = changed
        ? this.store.updateAgent(current.agent_id, {
            status: snapshot.status,
            failureReason: snapshotFailureReason
          })
        : this.store.updateAgent(current.agent_id, {});
      if (current.backend === "codex-session" && typeof snapshot.data?.observed_event_index === "number") {
        const events = snapshot.data.observed_events as Array<{ index: number; type: EventType; turn_id?: string; text?: string }>;
        for (const event of events ?? []) pendingEvents.push(this.store.createEvent({ runId: current.run_id, agentId: current.agent_id,
          type: event.type, payload: { turn_id: event.turn_id, text: event.text, source: "codex.rollout" } }));
        updated = this.store.updateAgent(current.agent_id, { backendHandle: { ...current.backend_handle, observed_event_index: snapshot.data.observed_event_index } });
      }
      if (changed && (current.backend !== "codex-session" || current.backend_handle?.remote_session || snapshot.status === "blocked" || current.status === "blocked")) {
        pendingEvents.push(
          this.store.createEvent({
            runId: updated.run_id,
            agentId: updated.agent_id,
            type: this.statusEventType(snapshot.status),
            payload: {
              status: snapshot.status,
              failureReason: snapshot.failureReason,
              message: snapshot.message,
              data: snapshot.data
            }
          })
        );
      }
      const projectedTerminal = TERMINAL_STATUSES.has(updated.status);
      if (projectedTerminal) {
        this.reconcileTerminalStrictFlowWorker(updated);
        this.finalizeStoppingRunIfTerminal(updated.run_id, (event) => {
          pendingEvents.push(this.store.createEvent(event));
        });
      }
      this.store.touchHeartbeat(current.agent_id);
      return { agent: updated, projectedTerminal, deferredInvoking: false };
    });
    for (const event of pendingEvents) {
      this.scheduleEventDelivery(event);
    }
    if (projection.projectedTerminal && projection.agent.backend !== "codex-session") {
      this.disarmStatusWatcher(projection.agent.agent_id);
    } else if (
      projection.deferredInvoking &&
      adapter.capabilities().canInspectStatusCheaply
    ) {
      this.armStatusWatcher(projection.agent);
    }
    return projection.agent;
  }

  async pollActiveAgents(runId?: string): Promise<AgentRecord[]> {
    const agents = this.store
      .listAgents({ runId })
      .filter((agent) => !this.isAttachedParticipant(agent) && !TERMINAL_STATUSES.has(agent.status));
    const refreshed: AgentRecord[] = [];
    for (const agent of agents) {
      refreshed.push(await this.refreshAgentStatus(agent.agent_id));
    }
    await this.checkHeartbeats();
    return refreshed;
  }

  async waitForFlowTerminal(flowInstanceId: string, input: { intervalMs?: number; timeoutMs?: number } = {}) {
    const started = Date.now();
    while (true) {
      const snapshot = this.getFlowSnapshot(flowInstanceId);
      await this.pollActiveAgents(snapshot.instance.run_id);
      const current = this.getFlowSnapshot(flowInstanceId);
      if (["completed", "cancelled"].includes(current.instance.status) || this.getRun(current.instance.run_id).status === "stopped") return { flow: current, timed_out: false };
      if (input.timeoutMs !== undefined && Date.now() - started >= input.timeoutMs) return { flow: current, timed_out: true };
      await sleep(input.intervalMs ?? 5000);
    }
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

        // A blocking wait is the in-turn wakeup path for coordinators. The
        // subscriber backend may be unable to receive an inbound message (for
        // example, an already-running Codex Desktop turn), so never make the
        // model wait indefinitely for physical delivery to succeed.
        await settleWithin(
          this.deliverSubscriptions(event),
          SUBSCRIPTION_WAIT_DELIVERY_TIMEOUT_MS
        );
        const afterDelivery = this.store
          .listSubscriptions({})
          .find((entry) => entry.subscription_id === subscriptionId);
        const afterDeliveryEventId = afterDelivery?.last_delivered_event_id;
        return {
          timed_out: false,
          matched: true,
          delivered: afterDeliveryEventId === event.event_id,
          subscription: afterDelivery ?? refreshed ?? subscription,
          event
        };
      }

      // Check durable events before refreshing the backend. This lets a
      // coordinator consume a terminal event that Agent Control already
      // recorded even when the worker's external status endpoint is gone.
      if (subscription.source_agent_id) {
        await this.refreshAgentStatus(subscription.source_agent_id);
      } else if (subscription.run_id) {
        await this.pollActiveAgents(subscription.run_id);
      }
      await this.checkHeartbeats();
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

  private prepareCodexSubagentStopInTransaction(
    agent: AgentRecord,
    input: {
      scope: "agent_stop" | "run_shutdown" | "flow_route";
      recordStopIntent: boolean;
    }
  ): {
    agent: AgentRecord;
    cancelledActionIds: string[];
    stopCauseAction: OrchestratorActionRecord | null;
  } {
    const current = this.getAgent(agent.agent_id);
    const workStartingActions = this.store
      .listOrchestratorActions({ agentId: current.agent_id })
      .filter(
        (action) =>
          action.agent_id === current.agent_id &&
          ((action.operation === "send_message" || action.operation === "followup_task") ||
            (input.scope !== "agent_stop" && action.operation === "spawn_agent")) &&
          (action.status === "pending" || action.status === "claimed")
      );
    const cancelledAt = nowIso();
    const resolvedActions = workStartingActions.map((action) =>
      action.status === "pending"
        ? this.store.cancelUnclaimedOrchestratorAction({
            actionId: action.action_id,
            errorJson:
              action.operation === "spawn_agent"
                ? {
                    reason: "agent_stopped_before_spawn",
                    scope: input.scope,
                    message:
                      input.scope === "flow_route"
                        ? "The native spawn action was cancelled before execution because its flow step was manually superseded."
                        : "The native spawn action was cancelled before execution because durable run stop intent was recorded."
                  }
                : {
                    reason: "native_message_cancelled_by_stop",
                    scope: input.scope,
                    message:
                      "The native message action was cancelled before execution because durable stop intent was recorded."
                  },
            cancelledAt
          }).action
        : action
    );
    const claimedActionExists = resolvedActions.some((action) => action.status === "claimed");
    const updated = input.recordStopIntent || claimedActionExists
      ? this.store.updateAgent(current.agent_id, {
          status: "stopping",
          failureReason: current.failure_reason
        })
      : current;
    return {
      agent: updated,
      cancelledActionIds: resolvedActions
        .filter((action) => action.status === "cancelled")
        .map((action) => action.action_id),
      stopCauseAction: this.latestNativeMessageStopCauseAction(current.agent_id)
    };
  }

  private latestNativeMessageStopCauseAction(
    agentId: string
  ): OrchestratorActionRecord | null {
    const latestMessageAction = this.store
      .listOrchestratorActions({ agentId })
      .filter(
        (action) =>
          action.agent_id === agentId &&
          (action.operation === "send_message" || action.operation === "followup_task")
      )
      .at(-1);
    if (
      latestMessageAction?.status === "claimed" ||
      (latestMessageAction?.status === "cancelled" &&
        recordString(latestMessageAction.error_json, "reason") ===
          "native_message_cancelled_by_stop")
    ) {
      return latestMessageAction;
    }
    return null;
  }

  private prepareHandlelessCodexSubagentStop(agentId: string):
    | {
        outcome: "stopped";
        agent: AgentRecord;
        cancelledActionId: string | null;
      }
    | {
        outcome: "spawn_resolution_pending";
        agent: AgentRecord;
        spawnAction: OrchestratorActionRecord;
      }
    | {
        outcome: "handle_available";
        agent: AgentRecord;
      } {
    const pendingEvents: EventRecord[] = [];
    const prepared = this.store.immediateTransaction(() => {
      const projectStopped = (
        stopped: AgentRecord,
        cancelledActionId: string | null
      ) => {
        pendingEvents.push(
          this.store.createEvent({
            eventId: agentStoppedEventId(stopped),
            runId: stopped.run_id,
            agentId: stopped.agent_id,
            type: "agent.stopped",
            payload: {
              status: "stopped",
              message: cancelledActionId
                ? "Pending native spawn was cancelled before execution."
                : "Native worker had no executed spawn action.",
              ...(cancelledActionId
                ? { cancelled_action_id: cancelledActionId }
                : {})
            }
          })
        );
        this.finalizeStoppingRunIfTerminal(stopped.run_id, (event) => {
          pendingEvents.push(this.store.createEvent(event));
        });
        return {
          outcome: "stopped" as const,
          agent: stopped,
          cancelledActionId
        };
      };
      const current = this.getAgent(agentId);
      // Recording the stop predicate before inspecting spawn actions makes the
      // two possible cross-process orders deterministic. BEGIN IMMEDIATE means
      // a spawn that committed first is visible and cancellable below; when
      // this transaction wins first, action creation observes `stopping` and
      // its guarded INSERT returns no row.
      const stopping = this.store.updateAgent(current.agent_id, {
        status: "stopping",
        failureReason: null
      });
      if (stopping.backend_handle) {
        return { outcome: "handle_available" as const, agent: stopping };
      }

      const spawnAction = this.store
        .listOrchestratorActions({ agentId: stopping.agent_id })
        .filter(
          (action) =>
            action.agent_id === stopping.agent_id &&
            action.operation === "spawn_agent"
        )
        .at(-1) ?? null;
      if (spawnAction?.status === "pending") {
        const cancellation = this.store.cancelUnclaimedOrchestratorAction({
          actionId: spawnAction.action_id,
          errorJson: {
            reason: "agent_stopped_before_spawn",
            message:
              "The logical worker was stopped before its native spawn action was claimed."
          }
        });
        if (
          cancellation.action.status === "cancelled" ||
          cancellation.action.status === "failed"
        ) {
          return projectStopped(
            this.store.updateAgent(stopping.agent_id, {
              status: "stopped",
              failureReason: null
            }),
            cancellation.action.action_id
          );
        }
        return {
          outcome: "spawn_resolution_pending" as const,
          agent: stopping,
          spawnAction: cancellation.action
        };
      }
      if (spawnAction?.status === "claimed") {
        return {
          outcome: "spawn_resolution_pending" as const,
          agent: stopping,
          spawnAction
        };
      }
      if (spawnAction?.status === "succeeded") {
        // The ACK may have committed between stopAgent's initial handle read
        // and this transaction. Recover its validated native identity while
        // the stop predicate is held, then continue through normal interrupt
        // cleanup instead of pretending no backend session exists.
        return {
          outcome: "handle_available" as const,
          agent: this.store.updateAgent(stopping.agent_id, {
            backendHandle: this.spawnBackendHandle(spawnAction, stopping),
            status: "stopping",
            failureReason: null
          })
        };
      }
      return projectStopped(
        this.store.updateAgent(stopping.agent_id, {
          status: "stopped",
          failureReason: null
        }),
        null
      );
    });
    for (const event of pendingEvents) {
      this.scheduleEventDelivery(event);
    }
    return prepared;
  }

  async stopAgent(
    agentId: string,
    mode: "graceful" | "interrupt" | "kill" = "graceful"
  ): Promise<AgentStopResult> {
    let agent = this.getAgent(agentId);
    if (agent.backend === "codex-session") {
      const adapter = this.adapters.get(agent.backend);
      await adapter.stop(this.requireHandle(agent), { mode });
      return this.refreshAgentStatus(agentId);
    }
    if (this.isAttachedParticipant(agent)) return agent;
    // Capture intent before this call writes its own transient `stopping`
    // projection. A manual route, run shutdown, or earlier cleanup attempt has
    // already made cleanup durable; an ordinary first-time stop has not. That
    // distinction decides whether an adapter error may become terminal or must
    // remain retryable across another explicit call or controller restart.
    const durableStopIntentAtEntry = this.hasDurableStopIntent(agent);
    const adapter = this.adapters.get(agent.backend);
    const requiresOrchestratorAction = Boolean(adapter.capabilities().requiresOrchestratorAction);
    if (!agent.backend_handle) {
      const recoveredHandle = this.recoverBackendHandle(agent);
      if (recoveredHandle) {
        const succeededAttempt = this.store.getLatestCompletedAgentStartAttemptWithHandle(
          agent.agent_id
        );
        agent = this.store.immediateTransaction(() => {
          if (agent.status === "stopped" && succeededAttempt?.handle_json) {
            const run = this.getRun(agent.run_id);
            if (run.status === "stopped") {
              this.store.updateRunStatus(run.run_id, "stopping");
            }
            return this.store.updateAgent(agentId, {
              backendHandle: recoveredHandle,
              status: "stopping",
              failureReason: agent.failure_reason
            });
          }
          return this.store.updateAgent(agentId, { backendHandle: recoveredHandle });
        });
      }
    }
    if (
      !requiresOrchestratorAction &&
      !agent.backend_handle &&
      TERMINAL_STATUSES.has(agent.status)
    ) {
      return agent;
    }
    if (!requiresOrchestratorAction && !agent.backend_handle) {
      const prepared = this.prepareHandlelessNonNativeStartStop(agent.agent_id);
      agent = prepared.agent;
      if (prepared.outcome === "backend_start_uncertain") {
        this.emit({
          runId: agent.run_id,
          agentId: agent.agent_id,
          type: "agent.status_changed",
          payload: {
            status: "stopping",
            reason: "backend_start_outcome_uncertain",
            start_attempt_id: prepared.attempt?.start_attempt_id ?? null,
            attempt_phase: prepared.attempt?.phase ?? null
          }
        });
        return agent;
      }
      if (agent.status === "stopped") {
        return agent;
      }
    }
    if (TERMINAL_STATUSES.has(agent.status)) {
      if (!requiresOrchestratorAction) {
        return agent;
      }
      const prepared = this.store.immediateTransaction(() =>
        this.prepareCodexSubagentStopInTransaction(agent, {
          scope: "agent_stop",
          recordStopIntent: false
        })
      );
      if (TERMINAL_STATUSES.has(prepared.agent.status)) {
        return prepared.agent;
      }
      agent = prepared.agent;
    }
    if (requiresOrchestratorAction && mode === "kill") {
      throw new ControllerError("codex-subagent does not support force stop.", "unsupported_operation", {
        backend: agent.backend,
        mode
      });
    }
    if (requiresOrchestratorAction && !agent.backend_handle) {
      const prepared = this.prepareHandlelessCodexSubagentStop(agent.agent_id);
      if (prepared.outcome === "stopped") {
        return prepared.agent;
      }
      if (prepared.outcome === "spawn_resolution_pending") {
        // A claimed spawn may already have created a native worker even when
        // its acknowledgement/handle has not reached this controller. Never
        // invent an interrupt target or claim the logical worker is stopped.
        return this.markNativeSpawnStopUncertain(
          prepared.agent,
          prepared.spawnAction
        );
      }
      agent = prepared.agent;
    }
    if (!agent.backend_handle && !requiresOrchestratorAction) {
      return this.stopAgentWithoutBackendSession(agent, "Agent had no active backend session.");
    }
    const nativeStopPreparation = requiresOrchestratorAction
      ? this.store.immediateTransaction(() =>
          this.prepareCodexSubagentStopInTransaction(agent, {
            scope: "agent_stop",
            recordStopIntent: true
          })
        )
      : null;
    const stopping = nativeStopPreparation?.agent ??
      this.store.updateAgent(agentId, { status: "stopping" });
    this.emit({
      runId: stopping.run_id,
      agentId,
      type: "agent.status_changed",
      payload: {
        status: "stopping",
        ...(nativeStopPreparation?.cancelledActionIds.length
          ? { cancelled_action_ids: nativeStopPreparation.cancelledActionIds }
          : {})
      }
    });

    let result: StopResult;
    try {
      let operation: AgentOperationResult<StopResult>;
      if (requiresOrchestratorAction) {
        const stopCauseAction = nativeStopPreparation?.stopCauseAction ??
          this.latestNativeMessageStopCauseAction(agent.agent_id);
        operation = stopCauseAction
          ? this.enqueueCodexSubagentInterrupt(
              stopping,
              `interrupt:stop-message:${stopCauseAction.action_id}`,
              stopCauseAction
            )
          : this.enqueueCodexSubagentInterrupt(stopping);
      } else {
        operation = {
          type: "completed",
          value: await adapter.stop(this.requireHandle(stopping), { mode })
        };
      }
      if (operation.type === "orchestrator_action_required") {
        const durableAction = this.openOrchestratorActionRef(operation.action.action_id);
        const current = this.getAgent(stopping.agent_id);
        if (durableAction) {
          this.notifyFlowOwnerOfNativeCleanupActionRef(durableAction);
        }
        return durableAction
          ? { ...current, orchestrator_action: durableAction }
          : current;
      }
      result = operation.value;
    } catch (error) {
      const payload = errorToPayload(error);
      if (requiresOrchestratorAction) {
        const unresolved = this.store.updateAgent(agentId, {
          status: "stopping",
          failureReason: payload.reason as FailureReason
        });
        this.emit({
          runId: unresolved.run_id,
          agentId,
          type: "agent.status_changed",
          payload: { status: "stopping", reason: payload.reason, message: payload.message }
        });
        return unresolved;
      }
      if (durableStopIntentAtEntry) {
        // External stop I/O is not transactional. Once cleanup intent already
        // exists, treating a transient adapter error as terminal would suppress
        // both startup redrive and an explicit retry while the backend session
        // may still be alive. Keep the durable predicate and expose the last
        // failure without recursively retrying in this controller instance.
        const unresolved = this.store.updateAgent(agentId, {
          status: "stopping",
          failureReason: payload.reason as FailureReason
        });
        this.emit({
          runId: unresolved.run_id,
          agentId,
          type: "agent.status_changed",
          payload: {
            status: "stopping",
            reason: "external_stop_retry_pending",
            failure_reason: payload.reason,
            error: payload.error
          }
        });
        return unresolved;
      }
      const failed = this.store.updateAgent(agentId, {
        status: "failed",
        failureReason: payload.reason as FailureReason
      });
      this.emit({ runId: failed.run_id, agentId, type: "agent.failed", payload });
      return failed;
    }
    return this.commitAgentStopProjection(
      agentId,
      {
        status: result.status,
        failureReason: result.failureReason ?? null
      },
      { status: result.status, message: result.message, data: result.data }
    );
  }

  async stopAgents(input: {
    runId?: string;
    mode?: "graceful" | "interrupt" | "kill";
  }): Promise<AgentStopResult[]> {
    const mode = input.mode ?? "graceful";
    const agents = this.store
      .listAgents({ runId: input.runId })
      .filter((agent) => !this.isAttachedParticipant(agent) && !TERMINAL_STATUSES.has(agent.status));
    return Promise.all(agents.map((agent) => this.stopAgent(agent.agent_id, mode)));
  }

  /**
   * Commit backend stop truth, its lifecycle event, and any last-agent run
   * finalization under one write reservation. This removes the crash window
   * where a terminal agent row could survive beside a permanently `stopping`
   * run. Watcher teardown remains an after-commit in-memory side effect.
   */
  private commitAgentStopProjection(
    agentId: string,
    patch: {
      backendHandle?: Record<string, unknown> | null;
      status: AgentStatus;
      failureReason: FailureReason | null;
    },
    payload: Record<string, unknown>
  ): AgentRecord {
    const pendingEvents: EventRecord[] = [];
    const projected = this.store.immediateTransaction(() => {
      const updated = this.store.updateAgent(agentId, patch);
      pendingEvents.push(
        this.store.createEvent({
          runId: updated.run_id,
          agentId: updated.agent_id,
          type: this.statusEventType(updated.status),
          // Bind stop evidence to the actual generation/handle, including a
          // late start whose compensating stop precedes package reconciliation.
          payload: { ...payload, work_generation: updated.work_generation, backend_handle_sha256: digest(updated.backend_handle) }
        })
      );
      if (TERMINAL_STATUSES.has(updated.status)) {
        this.finalizeStoppingRunIfTerminal(updated.run_id, (event) => {
          pendingEvents.push(this.store.createEvent(event));
        });
      }
      return updated;
    });
    if (TERMINAL_STATUSES.has(projected.status)) {
      this.disarmStatusWatcher(projected.agent_id);
    }
    for (const event of pendingEvents) {
      this.scheduleEventDelivery(event);
    }
    return projected;
  }

  private stopAgentWithoutBackendSession(
    agent: AgentRecord,
    message: string,
    cancelledActionId?: string
  ): AgentRecord {
    return this.commitAgentStopProjection(
      agent.agent_id,
      { status: "stopped", failureReason: null },
      {
        status: "stopped",
        message,
        ...(cancelledActionId ? { cancelled_action_id: cancelledActionId } : {})
      }
    );
  }

  private markNativeSpawnStopUncertain(
    agent: AgentRecord,
    spawnAction: OrchestratorActionRecord
  ): AgentStopResult {
    const stopping = this.store.updateAgent(agent.agent_id, {
      status: "stopping",
      failureReason: null
    });
    this.emit({
      runId: stopping.run_id,
      agentId: stopping.agent_id,
      type: "agent.status_changed",
      payload: {
        status: "stopping",
        reason: "native_spawn_resolution_pending",
        action_id: spawnAction.action_id,
        action_status: spawnAction.status
      }
    });
    return { ...stopping, orchestrator_action: orchestratorActionRef(spawnAction) };
  }

  private finalizeStoppingRunIfTerminal(
    runId: string,
    eventSink?: (event: ControllerEventInput) => void
  ): RunRecord | null {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "stopping") {
      return null;
    }
    const pending = this.store
      .listAgents({ runId })
      .filter((agent) => !this.isAttachedParticipant(agent) && !TERMINAL_STATUSES.has(agent.status));
    if (pending.length > 0) {
      return null;
    }
    const stopped = this.store.updateRunStatus(runId, "stopped");
    this.recordControllerEvent({
      runId,
      type: "timer.elapsed",
      payload: { action: "run_shutdown_completed", stopped_agents: this.store.listAgents({ runId }).length }
    }, eventSink);
    return stopped;
  }

  async unregisterAgent(agentId: string): Promise<AgentRecord> {
    const agent = this.getAgent(agentId);
    const adapter = this.adapters.get(agent.backend);
    if (!this.isAttachedParticipant(agent) && agent.backend_handle && adapter.unregister) {
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
    const credentialTargets = !resolved.dryRun && this.credentialStore
      ? {
          bridges: this.store.listBridgeGrants({ orchestratorAgentId: agent.agent_id }),
          actions: this.store.listOrchestratorActions({ agentId: agent.agent_id })
        }
      : null;
    const result = createPurgeResult(resolved.dryRun);
    result.purged_agents.push(agent.agent_id);
    result.deleted_rows = mergeRowCounts(result.deleted_rows, this.store.countAgentPurgeRows(agent.agent_id));

    if (resolved.deleteRuntimeFiles) {
      planRuntimeDelete(result, runtimePath, resolved.dryRun);
    }

    if (!resolved.dryRun) {
      this.disarmStatusWatcher(agent.agent_id);
      this.store.purgeAgentRows(agent.agent_id, false);
      if (credentialTargets && this.credentialStore) {
        result.credential_cleanup_diagnostics.push(
          ...this.credentialStore.cleanupCredentials(credentialTargets)
        );
      }
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
    const credentialTargets = !resolved.dryRun && this.credentialStore
      ? {
          bridges: this.store.listBridgeGrants({ runId }),
          actions: this.store.listOrchestratorActions({ runId })
        }
      : null;
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
      if (credentialTargets && this.credentialStore) {
        result.credential_cleanup_diagnostics.push(
          ...this.credentialStore.cleanupCredentials(credentialTargets)
        );
      }
      if (resolved.deleteRuntimeFiles) {
        deleteRuntimePath(result, runtimePath);
      }
    }

    return result;
  }

  revokeBridgeGrant(bridgeGrantId: string): {
    bridge_grant_id: string;
    revoked_at: string;
    credential_cleanup_diagnostics: PurgeResult["credential_cleanup_diagnostics"];
  } {
    if (!isBridgeGrantId(bridgeGrantId)) {
      throw new ControllerError("Invalid bridge grant id.", "tool_error", {
        bridge_grant_id: bridgeGrantId
      });
    }
    const current = this.store.getBridgeGrant(bridgeGrantId);
    if (!current) {
      throw new ControllerError("Bridge grant not found.", "tool_error", {
        bridge_grant_id: bridgeGrantId
      });
    }
    const revoked = this.store.revokeBridgeGrant(bridgeGrantId);
    if (!revoked?.revoked_at) {
      throw new ControllerError("Bridge grant could not be revoked.", "tool_error", {
        bridge_grant_id: bridgeGrantId
      });
    }
    return {
      bridge_grant_id: revoked.bridge_grant_id,
      revoked_at: revoked.revoked_at,
      credential_cleanup_diagnostics: this.credentialStore
        ? this.credentialStore.cleanupCredentials({ bridges: [revoked] })
        : []
    };
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
          !this.observations.ownsSubscription(subscription.subscription_id) &&
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
    if (agent.backend === CODEX_SUBAGENT_BACKEND) {
      const eventMessages = controllerEventMessages(
        agent,
        this.listAgents({ runId: agent.run_id, includeUnregistered: true }),
        this.listEvents({ runId: agent.run_id, limit: Math.max(limit * 2, limit) })
      );
      const externalMessage = codexSubagentExternalMessage(
        agent,
        this.store.getCodexSubagentExternalState(agent.agent_id)
      );
      return [...eventMessages, ...(externalMessage ? [externalMessage] : [])]
        .sort(
          (left, right) =>
            Date.parse(left.created_at) - Date.parse(right.created_at) || left.id.localeCompare(right.id)
        )
        .slice(-limit);
    }
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
    const agentIds = new Set(agents.map((agent) => agent.agent_id));
    // Global subscriptions also apply to the selected run. Limit this projection
    // to visible participants without changing the subscription listing API.
    const subscriptions = selectedRunId ? this.listSubscriptions().filter((subscription) =>
      (!subscription.run_id || subscription.run_id === selectedRunId) &&
      agentIds.has(subscription.subscriber_agent_id) &&
      (!subscription.source_agent_id || agentIds.has(subscription.source_agent_id))) : [];
    const heartbeats = this.listHeartbeats().filter((heartbeat) => agentIds.has(heartbeat.agent_id));
    const goals = this.listGoals().filter((goal) => agentIds.has(goal.agent_id));
    const artifacts = selectedRunId ? this.listArtifacts({ runId: selectedRunId }) : [];
    const latestEvents = selectedRunId ? this.listEvents({ runId: selectedRunId, limit: 100 }) : [];
    const usageSnapshots = selectedRunId ? this.listUsageSnapshots({ runId: selectedRunId, limit: 1000 }) : [];
    const latestUsageByAgent = latestUsageSnapshotsByAgent(usageSnapshots);
    for (const agent of agents) {
      if (!agent.backend_handle) continue;
      try {
        const observation = this.adapters.get(agent.backend).readUsage?.(this.requireHandle(agent));
        if (observation) latestUsageByAgent.set(agent.agent_id, {
          ...observation, usage_id: `adapter:${agent.agent_id}`, agent_id: agent.agent_id, run_id: agent.run_id
        });
      } catch { /* Usage is optional; retain stored observations if the backend is unavailable. */ }
    }
    // Multiple identities may refer to one physical thread; count its usage only once per run.
    const usageThreads = new Set<string>();
    for (const agent of agents) {
      const threadId = agent.backend_handle?.thread_id;
      if (typeof threadId !== "string" || !latestUsageByAgent.has(agent.agent_id)) continue;
      if (usageThreads.has(threadId)) latestUsageByAgent.delete(agent.agent_id);
      else usageThreads.add(threadId);
    }
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
        latest_usage: latestUsageByAgent.get(agent.agent_id) ?? null,
        activity: this.readActivity(agent)
      };
    });

    return {
      generated_at: new Date(now).toISOString(),
      selected_run_id: selectedRunId,
      run_observers: selectedRunId ? this.observations.listPublic(selectedRunId) : [],
      runs,
      agents,
      agent_links: agentLinks,
      flows: [...flowRecordsById.values()],
      flow_instances: flowInstances.map(instance => ({ ...instance, runtime: this.flowRuntime.get(instance.flow_instance_id) })),
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
    stepId: string,
    activation: {
      coordinatorContext?: string | null;
      eventSink?: (event: ControllerEventInput) => void;
    } = {}
  ): FlowStepInstanceRecord {
    const emitEvent =
      activation.eventSink ??
      ((event: ControllerEventInput): void => {
        this.emit(event);
      });
    const stepConfig = config.steps[stepId];
    if (!stepConfig) {
      throw new ControllerError("Cannot activate undefined flow step.", "tool_error", {
        flow_instance_id: instance.flow_instance_id,
        step_id: stepId
      });
    }
    if (!this.flowRuntime.get(instance.flow_instance_id)) this.flowRuntime.initialize(instance.flow_instance_id, config);
    if (activation.coordinatorContext?.trim()) {
      if (config.policy?.strict) {
        const state = this.flowRuntime.get(instance.flow_instance_id)!;
        state.correction = { from_step_id: instance.current_step_id, summary: activation.coordinatorContext.trim(), manual: true };
        state.revision += 1;
        this.flowRuntime.save(instance.flow_instance_id, state);
      } else this.flowRuntime.changeContext(instance.flow_instance_id, activation.coordinatorContext.trim(), instance.orchestrator_agent_id);
    }
    const runtimeState = this.flowRuntime.get(instance.flow_instance_id)!;
    this.assertFlowRequirements(instance, stepConfig);
    const bindings = this.store.listFlowArtifactBindings(instance.flow_instance_id);
    const inputArtifacts = resolveInputArtifacts(stepConfig.inputs, bindings);
    if (config.policy?.strict) for (const ref of Object.values(stepConfig.inputs ?? {})) if (bindings.some(binding => binding.artifact_key === ref.artifact)) this.boundFlowArtifactDigest(instance, ref.artifact);
    const promptSources = resolveStepPromptSources(config, stepId);
    const stepInstanceId = newId("flowstep");
    const run = this.getRun(instance.run_id);
    const describedInputs = this.describeStepInputArtifacts(config, stepConfig, inputArtifacts);
    const outputArtifacts = this.resolveStepOutputArtifacts(config, instance, stepConfig);
    const coordinatorContext = runtimeState.context;
    const runtimeContract = this.buildFlowStepRuntimeContract({
      flowId: config.id,
      stepId,
      stepConfig,
      roleConfig: stepConfig.role ? config.roles?.[stepConfig.role] : undefined,
      instance,
      run,
      coordinatorContext,
      inputArtifacts: describedInputs,
      outputArtifacts
    });
    const reportingContract = this.buildFlowStepReportingContract({
      strict: Boolean(config.policy?.strict),
      stepId,
      stepInstanceId,
      stepConfig,
      outputArtifacts
    });
    const inputJson: Record<string, unknown> = {
      ...inputArtifacts,
      acceptance_revision: runtimeState.acceptance_revision,
      config_digest: runtimeState.config_digest,
      correction: runtimeState.correction,
      runtime_contract: runtimeContract,
      input_artifacts: describedInputs,
      output_artifacts: outputArtifacts,
      reporting_contract: reportingContract
    };
    if (coordinatorContext) {
      inputJson.coordinator_context = coordinatorContext;
    }
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
      emitEvent({
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
      status: stepConfig.execution === "coordinator" ? "waiting_for_orchestrator" : "active",
      currentStepId: stepId
    });
    if (stepConfig.execution === "coordinator") emitEvent({ runId: instance.run_id, type: "flow.notification", payload: { flow_instance_id: instance.flow_instance_id, step_instance_id: step.step_instance_id, step_id: stepId, reason: "coordinator_gate", decision: stepConfig.decision ?? null } });
    emitEvent({
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
        coordinator_context: coordinatorContext,
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
    const currentFlow = this.getFlowOrThrow(this.getFlowInstanceOrThrow(step.flow_instance_id).flow_record_id);
    const priorOwnedStep = currentFlow.config.policy?.strict && step.agent_id ? this.store.listFlowStepInstances(step.flow_instance_id).find(prior => prior.step_instance_id !== step.step_instance_id && prior.agent_id === step.agent_id && prior.status === "completed" && prior.input_json.config_digest === step.input_json.config_digest) : null;
    for (const source of promptSources) {
      if (!source || typeof source !== "object") {
        continue;
      }
      const record = source as Record<string, unknown>;
      if (priorOwnedStep && record.scope === "role") continue;
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
    const backendConstraints = [
      "You are an Agent Control worker executing one flow step.",
      "Use the generated runtime and reporting contracts as the source of truth.",
      "Write the required artifact paths before reporting.",
      "Keep any in-process status terse.",
      currentFlow.config.policy?.strict ? "Use only the assigned Agent Control MCP tools for evidence and reporting." : "Do not assume the caller is Codex; use Agent Control MCP or CLI reporting exactly as instructed."
    ];
    const runtimeContractRecord =
      input.runtime_contract && typeof input.runtime_contract === "object" && !Array.isArray(input.runtime_contract)
        ? (input.runtime_contract as Record<string, unknown>)
        : undefined;
    const runtimeWorker = payloadRecord(runtimeContractRecord, "worker");
    if (payloadString(runtimeWorker, "backend") === CODEX_SUBAGENT_BACKEND) {
      backendConstraints.push(
        "Do not call native collaboration/subagent tools and do not spawn sibling agents.",
        "Perform only this assigned step, write its required artifacts, call `flow_step_report`, and then end."
      );
    }
    sections.push(
      section(
        "Backend Constraints",
        backendConstraints.join("\n")
      )
    );
    const instance = this.getFlowInstanceOrThrow(step.flow_instance_id);
    const config = this.getFlowOrThrow(instance.flow_record_id).config;
    if (config.policy?.strict) sections.push(section("Report identity", "Report from this assigned Codex thread. Agent Control derives the worker identity from the local tool process. Never copy credentials into prompts, artifacts or reports. " + STRICT_FLOW_CAPABILITY_FAILURE));
    if (input.correction) sections.push(section("Transition cause", JSON.stringify(input.correction)));
    const state = this.flowRuntime.get(step.flow_instance_id);
    if (state?.recovery?.agent_id === step.agent_id && state.recovery.full_review_required) sections.push(section("Explicit owner recovery", "You are the new owner after a visible recovery. Perform a full review with a fresh checkpoint and no prior-owner source receipts. Do not inherit or carry earlier approval merely because the role name is unchanged."));
    if (state && Object.keys(state.evidence).length) sections.push(section("Evidence references", JSON.stringify({ evidence: state.evidence, summaries: state.evidence_summaries })));
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
    coordinatorContext: string | null;
    inputArtifacts: Record<string, Record<string, unknown>>;
    outputArtifacts: Record<string, Record<string, unknown>>;
  }): Record<string, unknown> {
    const strict = this.getFlowOrThrow(input.instance.flow_record_id).config.policy?.strict;
    const objective = strict ? input.coordinatorContext ?? input.run.title : buildEffectiveFlowObjective(input.run.title, input.coordinatorContext);
    const objectiveSource = input.coordinatorContext ? "coordinator_context_over_run_title" : "run_title";
    return {
      flow_id: input.flowId,
      flow_instance_id: input.instance.flow_instance_id,
      step_id: input.stepId,
      role: input.stepConfig.role ?? null,
      objective,
      objective_source: objectiveSource,
      coordinator_context: input.coordinatorContext,
      evidence: this.flowRuntime.get(input.instance.flow_instance_id)?.evidence ?? {},
      evidence_summaries: this.flowRuntime.get(input.instance.flow_instance_id)?.evidence_summaries ?? {},
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
      ...(strict ? { capability_failure_contract: { handback_prefix: "AGENT_CONTROL_BLOCKED:", behavior: STRICT_FLOW_CAPABILITY_FAILURE } } : {}),
      instructions: [
        input.coordinatorContext
          ? "Use `objective` as the source of truth. Its coordinator context supersedes the original run title wherever it adds, clarifies, or conflicts."
          : "Use `objective` and the repository directory from this runtime contract as the source of truth.",
        "Read only the input artifacts that are present and relevant to this step.",
        "Write every required output artifact to its assigned path before reporting.",
        "Do not invent artifact paths, filenames, or additional handoff files unless the task itself requires separate repo changes.",
        ...(strict ? [STRICT_FLOW_CAPABILITY_FAILURE] : [])
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
        objective,
        objectiveSource,
        inputArtifacts: input.inputArtifacts,
        outputArtifacts: input.outputArtifacts
      }) + (strict ? `\n\n### Required tool capability\n\n${STRICT_FLOW_CAPABILITY_FAILURE}` : "")
    };
  }

  private buildFlowStepReportingContract(input: {
    strict: boolean;
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
    const cliCommand = input.strict ? undefined : buildFlowReportCliCommand(input.stepInstanceId, resultExample, artifactExample, mcpInput.summary);

    return {
      step_id: input.stepId,
      step_instance_id: input.stepInstanceId,
      preferred: "mcp",
      mcp_tool: {
        name: toolName,
        input: mcpInput
      },
      ...(cliCommand ? { cli: { command: cliCommand } } : {}),
      result_schema: resultSchema,
      result_example: resultExample,
      artifact_example: artifactExample,
      instructions: [
        `Use the Agent Control MCP tool \`${toolName}\` when it is available.`,
        input.strict ? STRICT_FLOW_CAPABILITY_FAILURE : "If MCP tools are not available, use the CLI command shown below.",
        "Report only fields allowed by the result schema. Do not invent result labels.",
        input.strict ? "Use status `completed` only for valid step work with the required evidence and artifacts. A required-tool capability failure is a blocked handback, never a semantic completion." : "Use status `completed` when the required artifact was written, even if the structured conclusion represents a blocker.",
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
      if (config.policy?.strict) throw new ControllerError("Strict flows require an explicit terminal transition and verified guards.", "tool_error");
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
      ...this.flowConditionContext(instance),
      status: step.status,
      result,
      step: {
        id: step.step_id,
        instance_id: step.step_instance_id
      }
    };
    const selected = action.transitions ? selectTransition(action, context) : null;
    const selectedAction = selected ?? action;
    if (action.transitions && !selected && config.policy?.strict) throw new ControllerError("No declared transition matches this report.", "tool_error");
    this.assertFlowRequirements(instance, selectedAction, context);
    const runtimeState = this.flowRuntime.get(instance.flow_instance_id)!;
    if (selectedAction.set) Object.assign(runtimeState.state, selectedAction.set);
    runtimeState.revision += 1;
    runtimeState.correction = { from_step_id: step.step_id, from_step_instance_id: step.step_instance_id, status: step.status, result, summary: step.summary, artifacts: step.output_json, transition_id: selected?.id ?? null };
    this.flowRuntime.save(instance.flow_instance_id, runtimeState);
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
      const reportedPath = reportedArtifacts[outputName] ?? reportedArtifacts[ref.artifact];
      // An omitted optional output is not a claim to have produced a prior file.
      if (!ref.required && !reportedPath) continue;
      let path = reportedPath ?? configuredPath;
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
      if (!existsSync(path)) {
        throw new ControllerError("Flow step report output artifact does not exist.", "missing_artifact", {
          step_id: step.step_id,
          output: outputName,
          artifact: ref.artifact,
          path
        });
      }
      if (config.policy?.strict && existsSync(path)) {
        const priorBinding = this.store.listFlowArtifactBindings(instance.flow_instance_id).find(binding => binding.artifact_key === ref.artifact);
        if ((configuredPath && resolve(path) !== resolve(configuredPath)) || (priorBinding && resolve(path) !== resolve(priorBinding.path))) throw new ControllerError("A strict artifact must keep its configured canonical path across revisions.", "tool_error");
        if (!statSync(path).isFile()) throw new ControllerError("Flow artifacts must be regular files.", "missing_artifact");
        const content = readFileSync(path);
        const contentDigest = artifactDigest(path);
        const directory = join(runRuntimeDir(instance.run_id), "flow-artifacts", instance.flow_instance_id, digest(ref.artifact));
        mkdirSync(directory, { recursive: true });
        const immutablePath = join(directory, `${contentDigest}${extname(path)}`);
        if (!existsSync(immutablePath)) writeFileSync(immutablePath, content, { flag: "wx", mode: 0o444 });
        if (artifactDigest(immutablePath) !== contentDigest) throw new ControllerError("The immutable artifact store contains conflicting content.", "tool_error");
        const state = this.flowRuntime.get(instance.flow_instance_id)!;
        state.artifacts ??= {};
        state.artifacts[ref.artifact] = { path, sha256: contentDigest, snapshot_path: immutablePath, produced_by_step_instance_id: step.step_instance_id };
        this.flowRuntime.save(instance.flow_instance_id, state);
      }
      const artifact = this.store.createArtifact({
        runId: instance.run_id,
        agentId: step.agent_id,
        label: ref.artifact,
        path: this.flowRuntime.get(instance.flow_instance_id)?.artifacts?.[ref.artifact]?.snapshot_path ?? path,
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
      if ((config.policy?.strict || flow.config.policy?.strict) && digest(flow.config) !== digest(config)) throw new ControllerError("The active flow is pinned to different configuration or prompt bytes; explicit migration is required.", "tool_error");
      return { flow, instance };
    }

    return null;
  }

  private emit(input: ControllerEventInput): EventRecord {
    const event = this.store.createEvent(input);
    this.scheduleEventDelivery(event);
    return event;
  }

  private recordControllerEvent(
    input: ControllerEventInput,
    eventSink?: (event: ControllerEventInput) => void
  ): void {
    if (eventSink) {
      eventSink(input);
      return;
    }
    this.emit(input);
  }

  private redrivePendingNativeActionOwnerWakeups(): void {
    for (const action of this.store
      .listOrchestratorActions()
      .filter((candidate) => candidate.status === "pending" || candidate.status === "claimed")) {
      this.redriveNativeActionOwnerWake(orchestratorActionRef(action));
    }
  }

  private redriveNativeActionOwnerWake(action: OrchestratorActionRef): void {
    const durableAction = this.store.getOrchestratorAction(action.action_id);
    if (
      !durableAction ||
      (durableAction.status !== "pending" && durableAction.status !== "claimed")
    ) {
      return;
    }
    const event = this.store.getEvent(
      `event_${durableAction.action_id.slice("action_".length)}`
    );
    if (!event || !this.nativeActionWakeMatches(event, durableAction)) {
      return;
    }
    this.scheduleEventDelivery(event);
  }

  private nativeActionWakeMatches(
    event: EventRecord,
    action: OrchestratorActionRecord
  ): boolean {
    const eventAction = payloadRecord(event.payload, "orchestrator_action");
    return Boolean(
      event.type === "flow.notification" &&
        event.payload.reason === "native_orchestrator_action_required" &&
        event.run_id === action.run_id &&
        eventAction?.action_id === action.action_id &&
        eventAction.flow_instance_id === action.flow_instance_id &&
        eventAction.step_instance_id === action.step_instance_id
    );
  }

  private scheduleEventDelivery(event: EventRecord): void {
    this.store.afterCommit(() => {
      if (!this.isDeliverySuppressed(event)) {
        const delivery = Promise.all([this.deliverSubscriptions(event), this.observations.notify(event)])
          .then(() => undefined)
          .catch(() => {
            // Delivery errors should never invalidate the source event.
          })
          .finally(() => {
            this.pendingDeliveries.delete(delivery);
          });
        this.pendingDeliveries.add(delivery);
      }
    });
  }

  private scheduleNativeActionOwnerWakeRetry(
    event: EventRecord,
    subscriberAgentId: string,
    deliveryKey: string
  ): void {
    if (
      this.disposing || this.nativeActionDeliveryRetryDelaysMs.length === 0 ||
      this.nativeActionDeliveryRetryTasks.has(deliveryKey)
    ) {
      return;
    }

    let retryTask!: Promise<void>;
    retryTask = (async () => {
      for (const delayMs of this.nativeActionDeliveryRetryDelaysMs) {
        if (!await this.backgroundDelay(delayMs)) return;
        if (
          this.nativeActionWakeWasDelivered(event.event_id, subscriberAgentId) ||
          !this.nativeActionWakeIsStillRequired(event)
        ) {
          return;
        }
        await this.deliverSubscriptions(event);
        if (this.nativeActionWakeWasDelivered(event.event_id, subscriberAgentId)) {
          return;
        }
      }
    })()
      .catch(() => {
        // The retry loop is best-effort and bounded. A later flow resume will
        // deterministically re-drive the same event without duplicating it.
      })
      .finally(() => {
        this.nativeActionDeliveryRetryTasks.delete(deliveryKey);
        this.pendingDeliveries.delete(retryTask);
      });
    this.nativeActionDeliveryRetryTasks.set(deliveryKey, retryTask);
    this.pendingDeliveries.add(retryTask);
  }

  private scheduleCodexThreadDeliveryRetry(
    event: EventRecord,
    subscriberAgentId: string,
    deliveryKey: string
  ): void {
    if (
      this.codexThreadDeliveryRetryDelaysMs.length === 0 ||
      this.codexThreadDeliveryRetryTasks.has(deliveryKey)
    ) {
      return;
    }

    let retryTask!: Promise<void>;
    retryTask = (async () => {
      for (const delayMs of this.codexThreadDeliveryRetryDelaysMs) {
        await sleep(delayMs);
        if (
          this.codexThreadDeliveryWasDelivered(event.event_id, subscriberAgentId) ||
          !this.codexThreadDeliveryIsStillRequired(event, subscriberAgentId)
        ) {
          return;
        }
        await this.deliverSubscriptions(event);
        if (this.codexThreadDeliveryWasDelivered(event.event_id, subscriberAgentId)) {
          return;
        }
      }
    })()
      .catch(() => {
        // Delivery retries are best-effort and bounded. The durable
        // subscription row remains available for a later controller poll.
      })
      .finally(() => {
        this.codexThreadDeliveryRetryTasks.delete(deliveryKey);
        this.pendingDeliveries.delete(retryTask);
      });
    this.codexThreadDeliveryRetryTasks.set(deliveryKey, retryTask);
    this.pendingDeliveries.add(retryTask);
  }

  private codexThreadDeliveryWasDelivered(eventId: string, subscriberAgentId: string): boolean {
    return this.store
      .listSubscriptions({ enabledOnly: true })
      .some(
        (subscription) =>
          subscription.subscriber_agent_id === subscriberAgentId &&
          subscription.last_delivered_event_id === eventId
      );
  }

  private codexThreadDeliveryIsStillRequired(
    event: EventRecord,
    subscriberAgentId: string
  ): boolean {
    return this.store
      .listSubscriptions({ enabledOnly: true })
      .some((subscription) => {
        const runMatches = !subscription.run_id || subscription.run_id === event.run_id;
        const sourceMatches =
          !subscription.source_agent_id || subscription.source_agent_id === event.agent_id;
        return (
          subscription.subscriber_agent_id === subscriberAgentId &&
          subscription.event_type === event.type &&
          runMatches &&
          sourceMatches &&
          subscription.last_delivered_event_id !== event.event_id
        );
      });
  }

  private nativeActionWakeWasDelivered(eventId: string, subscriberAgentId: string): boolean {
    return this.store
      .listSubscriptions({ enabledOnly: true })
      .some(
        (subscription) =>
          subscription.subscriber_agent_id === subscriberAgentId &&
          subscription.last_delivered_event_id === eventId
      );
  }

  private nativeActionWakeIsStillRequired(event: EventRecord): boolean {
    const eventAction = payloadRecord(event.payload, "orchestrator_action");
    const actionId = eventAction?.action_id;
    if (typeof actionId !== "string") {
      return false;
    }
    const action = this.store.getOrchestratorAction(actionId);
    if (
      !action ||
      (action.status !== "pending" && action.status !== "claimed") ||
      !this.nativeActionWakeMatches(event, action)
    ) {
      return false;
    }
    if (action.operation === "send_message" || action.operation === "followup_task") {
      const agent = this.store.getAgent(action.agent_id);
      const run = this.store.getRun(action.run_id);
      if (
        agent?.status === "stopping" ||
        run?.status === "stopping" ||
        run?.status === "stopped"
      ) {
        return false;
      }
    }
    return true;
  }

  private isDeliverySuppressed(event: EventRecord): boolean {
    return Boolean(
      (event.run_id && this.suppressedDeliveryRunIds.has(event.run_id)) ||
        (event.agent_id && this.suppressedDeliveryAgentIds.has(event.agent_id))
    );
  }

  private async deliverSubscriptions(event: EventRecord): Promise<void> {
    const isNativeActionWake = Boolean(
      event.type === "flow.notification" &&
      event.payload.reason === "native_orchestrator_action_required"
    );
    if (isNativeActionWake && !this.nativeActionWakeIsStillRequired(event)) {
      return;
    }
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
      if (this.observations.coversEvent(subscription.subscriber_agent_id, event) || this.observations.ownsSubscription(subscription.subscription_id)) continue;
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
      const deliveryAdapter = this.adapters.get(subscriber.backend);
      const capabilities = deliveryAdapter.capabilities();
      if (!capabilities.canSendMessage || capabilities.requiresOrchestratorAction) {
        // Subscription delivery has no scoped native-action acknowledgement
        // contract. Refuse unsupported/manual/native-direct adapters visibly,
        // without inventing physical work or advancing the agent fence.
        const claim = this.store.claimSubscriptionDelivery({
          eventId: event.event_id,
          subscriberAgentId: subscriber.agent_id,
          claimOwnerId: this.controllerInstanceId
        });
        if (!claim.claimed) {
          continue;
        }
        const reason = capabilities.requiresOrchestratorAction
          ? "subscriber_requires_orchestrator_action"
          : "subscriber_cannot_receive_messages";
        this.store.immediateTransaction(() => {
          this.store.failSubscriptionDelivery({
            eventId: event.event_id,
            subscriberAgentId: subscriber.agent_id,
            claimOwnerId: this.controllerInstanceId,
            claimAttempt: claim.delivery.claim_attempt,
            error: {
              reason,
              backend: subscriber.backend,
              message: "Subscriber backend does not support direct subscription delivery."
            }
          });
          this.store.createEvent({
            runId: event.run_id,
            agentId: subscriber.agent_id,
            type: "agent.delivery_failed",
            payload: {
              source_event_id: event.event_id,
              subscription_id: subscription.subscription_id,
              subscriber_agent_id: subscriber.agent_id,
              subscriber_backend: subscriber.backend,
              delivery_attempt: claim.delivery.claim_attempt,
              reason,
              failure_reason: "unsupported_operation"
            }
          });
        });
        deliveredSubscriberEventKeys.add(deliveryKey);
        continue;
      }

      let deliveryHandle: AgentHandle;
      try {
        deliveryHandle = this.requireHandle(subscriber);
      } catch (error) {
        const claim = this.store.claimSubscriptionDelivery({
          eventId: event.event_id,
          subscriberAgentId: subscriber.agent_id,
          claimOwnerId: this.controllerInstanceId
        });
        if (!claim.claimed) {
          continue;
        }
        // A duplicate matching row must not turn one logical failure into
        // another physical attempt during the same delivery pass.
        deliveredSubscriberEventKeys.add(deliveryKey);
        const payload = errorToPayload(error);
        this.store.immediateTransaction(() => {
          this.store.releaseSubscriptionDelivery({
            eventId: event.event_id,
            subscriberAgentId: subscriber.agent_id,
            claimOwnerId: this.controllerInstanceId,
            claimAttempt: claim.delivery.claim_attempt,
            error: payload
          });
          this.store.createEvent({
            runId: event.run_id,
            agentId: subscriber.agent_id,
            type: "agent.delivery_failed",
            payload: {
              source_event_id: event.event_id,
              subscription_id: subscription.subscription_id,
              subscriber_agent_id: subscriber.agent_id,
              subscriber_backend: subscriber.backend,
              delivery_attempt: claim.delivery.claim_attempt,
              reason: payload.error,
              failure_reason: payload.reason
            }
          });
        });
        continue;
      }

      const claim = this.store.claimSubscriptionDelivery({
        eventId: event.event_id,
        subscriberAgentId: subscriber.agent_id,
        claimOwnerId: this.controllerInstanceId
      });
      if (!claim.claimed) {
        continue;
      }
      // The durable claim coalesces rows and processes. This local marker also
      // coalesces duplicate rows after a released failure in this same pass;
      // an explicit re-drive owns any later physical retry.
      deliveredSubscriberEventKeys.add(deliveryKey);
      if (isNativeActionWake && !this.nativeActionWakeIsStillRequired(event)) {
        this.store.failSubscriptionDelivery({
          eventId: event.event_id,
          subscriberAgentId: subscriber.agent_id,
          claimOwnerId: this.controllerInstanceId,
          claimAttempt: claim.delivery.claim_attempt,
          error: { reason: "native_action_wake_no_longer_required" }
        });
        continue;
      }

      this.inFlightSubscriberDeliveries.add(deliveryKey);
      const deliveryAttempt = claim.delivery.claim_attempt;
      const deliveryAttemptId = `deliveryattempt_${deliveryAttempt}`;
      const acceptanceKey =
        `subscription-delivery:${deliveryKey}:attempt:${deliveryAttempt}`;
      let deliveryInvocationBegan = false;
      let deliveryInvocationReturned = false;
      let deliveryAttemptWorkGeneration: number | null = null;
      let deliveryAttemptWorkRevision: number | null = null;
      let stopDeliveryLeaseHeartbeat: (() => void) | null = null;
      try {
        const deliveryMessage = withCodexNativeVisibilityReminder(
          compactEventMessage(
            event,
            subscriber,
            event.agent_id ? this.store.getAgent(event.agent_id) : null
          ),
          subscriber
        );
        // The logical claim attempt is durable and shared across controllers;
        // it therefore gives each actual adapter invocation a distinct,
        // deterministic refresh-fence identity.
        const acceptedAttempt = this.store.beginSubscriptionDeliveryAttempt({
          eventId: event.event_id,
          subscriberAgentId: subscriber.agent_id,
          claimOwnerId: this.controllerInstanceId,
          claimAttempt: deliveryAttempt,
          acceptanceKey,
          acceptanceLeaseExpiresAt: this.acceptedWorkLeaseExpiresAt()
        });
        if (!acceptedAttempt.began) {
          continue;
        }
        deliveryAttemptWorkGeneration = acceptedAttempt.agent.work_generation;
        deliveryAttemptWorkRevision = acceptedAttempt.agent.work_revision;
        deliveryInvocationBegan = true;
        stopDeliveryLeaseHeartbeat = this.maintainAcceptedWorkLease(
          subscriber.agent_id,
          acceptanceKey
        );
        await deliveryAdapter.sendMessage(deliveryHandle, {
          message: deliveryMessage
        });
        deliveryInvocationReturned = true;
        stopDeliveryLeaseHeartbeat();
        const completion = this.store.immediateTransaction(() => {
          const acceptedCompletion = this.store.completeAgentAcceptedWorkAttempt({
            agentId: subscriber.agent_id,
            acceptanceKey,
            claimOwnerId: this.controllerInstanceId,
            outcome: "succeeded",
            status: "running",
            failureReason: null
          });
          const logicalCompletion = this.store.completeSubscriptionDelivery({
            event,
            subscriberAgentId: subscriber.agent_id,
            claimOwnerId: this.controllerInstanceId,
            claimAttempt: deliveryAttempt
          });
          if (!logicalCompletion.completed) {
            throw new Error(
              `Subscription delivery lost its invocation claim: ${deliveryKey}`
            );
          }
          return acceptedCompletion;
        });
        if (
          completion.attemptOwnedAgent &&
          !this.hasDurableStopIntent(completion.agent)
        ) {
          this.store.touchHeartbeat(subscriber.agent_id);
          this.armStatusWatcher(completion.agent);
        } else if (this.hasDurableStopIntent(completion.agent)) {
          // Delivery may have revived the same backend session after stop won
          // the database race. Completion advanced the attempt revision without
          // reviving logical state, so compensate the physical session now.
          await this.reconcileLateNonNativeWorkAfterStop(
            completion.agent,
            deliveryHandle,
            deliveryAdapter,
            "send",
            "subscription_delivery_completed_after_stop"
          );
        }
      } catch (error) {
        stopDeliveryLeaseHeartbeat?.();
        if (deliveryInvocationReturned) {
          // The adapter explicitly returned success. Never release this
          // logical delivery for another physical send merely because local
          // persistence or post-send reconciliation failed.
          throw error;
        }
        const payload = errorToPayload(error);
        const failure = this.store.immediateTransaction(() => {
          const completion = deliveryInvocationBegan
            ? this.store.completeAgentAcceptedWorkAttempt({
                agentId: subscriber.agent_id,
                acceptanceKey,
                claimOwnerId: this.controllerInstanceId,
                outcome: "ambiguous",
                status: "unknown",
                failureReason: "unknown"
              })
            : null;
          const released = this.store.releaseSubscriptionDelivery({
            eventId: event.event_id,
            subscriberAgentId: subscriber.agent_id,
            claimOwnerId: this.controllerInstanceId,
            claimAttempt: deliveryAttempt,
            error: payload
          });
          const failureEvent = this.store.createEvent({
            runId: event.run_id,
            agentId: subscriber.agent_id,
            type: "agent.delivery_failed",
            payload: {
              source_event_id: event.event_id,
              subscription_id: subscription.subscription_id,
              subscriber_agent_id: subscriber.agent_id,
              subscriber_backend: subscriber.backend,
              delivery_attempt_id: deliveryAttemptId,
              delivery_attempt: deliveryAttempt,
              work_generation: deliveryAttemptWorkGeneration,
              work_revision_before_completion: deliveryAttemptWorkRevision,
              work_revision: completion?.agent.work_revision ?? null,
              reason: payload.error,
              failure_reason: payload.reason
            }
          });
          return { completion, released, failureEvent };
        });
        if (failure.completion) {
          if (this.hasDurableStopIntent(failure.completion.agent)) {
            // A rejected delivery response is not proof that the subscriber
            // session rejected the message. Its ambiguity revision invalidates
            // same-attempt refreshes while this stop compensates possible work.
            await this.reconcileLateNonNativeWorkAfterStop(
              failure.completion.agent,
              deliveryHandle,
              deliveryAdapter,
              "send",
              "subscription_delivery_rejected_after_stop"
            );
          } else if (
            failure.completion.attemptOwnedAgent &&
            failure.completion.agent.status === "unknown" &&
            capabilities.canInspectStatusCheaply
          ) {
            this.armStatusWatcher(failure.completion.agent);
          }
        }
        if (
          subscriber.backend === "codex-thread" &&
          this.nativeActionWakeIsStillRequired(event)
        ) {
          this.scheduleNativeActionOwnerWakeRetry(
            event,
            subscriber.agent_id,
            deliveryKey
          );
        }
        if (
          subscriber.backend === "codex-thread" &&
          (event.type === "agent.completed" ||
            event.type === "agent.failed" ||
            event.type === "agent.blocked" ||
            event.type === "agent.stopped")
        ) {
          this.scheduleCodexThreadDeliveryRetry(event, subscriber.agent_id, deliveryKey);
        }
      } finally {
        stopDeliveryLeaseHeartbeat?.();
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
    const completedStart = this.store.getLatestCompletedAgentStartAttemptWithHandle(
      agent.agent_id
    );
    if (completedStart?.handle_json) {
      return completedStart.handle_json;
    }
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
        // Recover inspection/stop state without inventing a model for a future prompt.
        model: metadata.model ?? agent.model ?? "",
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
      model: agent.model ?? "",
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
    if (this.disposing) return;
    this.disarmStatusWatcher(agent.agent_id);
    const adapter = this.adapters.get(agent.backend);
    if (!adapter.watchStatus || !agent.backend_handle) {
      if (
        (agent.status === "running" || agent.status === "unknown") &&
        agent.backend_handle
      ) {
        const timers = [3000, 10000, 30000].map((delayMs) =>
          setTimeout(() => {
            this.runBackground(() => this.refreshAgentStatus(agent.agent_id));
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
      this.runBackground(() => this.refreshAgentStatus(agent.agent_id));
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
      .filter((agent) => !agent.unregistered_at && !this.isAttachedParticipant(agent) && !TERMINAL_STATUSES.has(agent.status));
  }
}

function flowUsesCodexSubagents(config: FlowConfig): boolean {
  return Object.values(config.steps).some((step) => {
    const role = step.role ? config.roles?.[step.role] : undefined;
    return role?.backend === CODEX_SUBAGENT_BACKEND;
  });
}

function normalizeOwnerTaskPath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^\/root(?:\/[a-z0-9_]+)*$/.test(trimmed)) {
    throw new ControllerError("owner_task_path must be an absolute canonical task path.", "tool_error", {
      owner_task_path: value
    });
  }
  return trimmed;
}

function bridgeCredentialFromGrant(grant: BridgeGrantRecord, rawToken: string): BridgeCredential {
  return {
    bridge_grant_id: grant.bridge_grant_id,
    bridge_token: rawToken,
    run_id: grant.run_id,
    orchestrator_agent_id: grant.orchestrator_agent_id,
    owner_task_identity: grant.owner_task_identity,
    owner_task_path: grant.owner_task_path,
    created_at: grant.created_at,
    expires_at: grant.expires_at
  };
}

function publicBridgeGrantRefFromGrant(grant: BridgeGrantRecord): PublicBridgeGrantRef {
  return {
    bridge_grant_id: grant.bridge_grant_id,
    run_id: grant.run_id,
    orchestrator_agent_id: grant.orchestrator_agent_id,
    owner_task_identity: grant.owner_task_identity,
    owner_task_path: grant.owner_task_path,
    created_at: grant.created_at,
    expires_at: grant.expires_at
  };
}

function normalizeOptionalIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function orchestratorActionRef(action: OrchestratorActionRecord): OrchestratorActionRef {
  return {
    action_id: action.action_id,
    operation: action.operation,
    status: action.status,
    run_id: action.run_id,
    orchestrator_agent_id: action.orchestrator_agent_id,
    agent_id: action.agent_id,
    flow_instance_id: action.flow_instance_id,
    step_instance_id: action.step_instance_id
  };
}

function stableJsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJsonValue(left)) === JSON.stringify(sortJsonValue(right));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)])
    );
  }
  return value;
}

function isCodexSubagentForkTurns(value: string): value is CodexSubagentForkTurns {
  return value === "none" || value === "all" || /^[1-9]\d*$/.test(value);
}

function deterministicCodexSubagentTaskName(role: string, stepInstanceId: string): string {
  const roleSlug = role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36) || "worker";
  const instanceSuffix = stepInstanceId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-12);
  return `${roleSlug}_${instanceSuffix || "step"}`;
}

function requiredRecordString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = recordString(record, key);
  if (!value) {
    throw new ControllerError(`Missing required native bridge field: ${key}.`, "tool_error", { field: key });
  }
  return value;
}

function nullableRecordString(record: Record<string, unknown> | null | undefined, key: string): string | null {
  return recordString(record, key) ?? null;
}

function startStateFromAttemptPhase(
  phase: AgentStartAttemptRecord["phase"]
): AgentStartState {
  switch (phase) {
    case "prepared":
    case "invoking":
      return "in_progress";
    case "ambiguous":
      return "ambiguous";
    case "succeeded":
      return "started";
    case "superseded":
      return "superseded";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function codexSubagentTarget(agent: AgentRecord): string {
  const target =
    recordString(agent.backend_handle, "native_task_path") ??
    recordString(agent.backend_handle, "native_agent_id") ??
    recordString(agent.backend_handle, "expected_task_path");
  if (!target) {
    throw new ControllerError("codex-subagent has no recoverable native target.", "tool_error", {
      agent_id: agent.agent_id
    });
  }
  return target;
}

function normalizeObservedAt(value: string | null | undefined): string {
  if (!value) {
    return nowIso();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControllerError("observed_at must be a valid timestamp.", "tool_error", {
      observed_at: value
    });
  }
  return new Date(parsed).toISOString();
}

function assertMatchingNativeIdentity(
  handle: Record<string, unknown>,
  input: {
    nativeAgentId?: string | null;
    nativeTaskName?: string | null;
    nativeTaskPath?: string | null;
  }
): void {
  const comparisons: Array<[string, string | null | undefined]> = [
    ["native_agent_id", input.nativeAgentId],
    ["native_task_name", input.nativeTaskName],
    ["native_task_path", input.nativeTaskPath]
  ];
  for (const [key, observed] of comparisons) {
    const expected = recordString(handle, key);
    if (expected && observed && expected !== observed) {
      throw new ControllerError("Native sync identity conflicts with the stored agent handle.", "auth_required", {
        field: key,
        agent_expected: expected,
        observed
      });
    }
  }
}

function mapCodexSubagentStatus(nativeStatus: string): {
  status: AgentStatus;
  failureReason: FailureReason | null;
} {
  switch (nativeStatus) {
    case "pending_init":
      return { status: "starting", failureReason: null };
    case "running":
      return { status: "running", failureReason: null };
    case "completed":
      return { status: "completed", failureReason: null };
    case "interrupted":
    case "shutdown":
      return { status: "stopped", failureReason: null };
    case "errored":
      return { status: "failed", failureReason: "tool_error" };
    case "missing":
      return { status: "unknown", failureReason: null };
    default:
      throw new ControllerError("Unsupported native_status.", "unsupported_operation", {
        native_status: nativeStatus
      });
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
  const failureReason = payloadString(event.payload, "failure_reason");
  const reason = payloadString(event.payload, "reason");
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
  const orchestratorAction = payloadRecord(event.payload, "orchestrator_action");
  const orchestratorActionId = payloadString(orchestratorAction, "action_id");
  const orchestratorActionOperation = payloadString(orchestratorAction, "operation");
  const orchestratorActionStatus = payloadString(orchestratorAction, "status");
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
  if (reason) {
    lines.push(`Reason: ${reason}`);
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
  if (orchestratorActionId) {
    lines.push(`Orchestrator action: ${orchestratorActionId}`);
  }
  if (orchestratorActionOperation) {
    lines.push(`Orchestrator operation: ${orchestratorActionOperation}`);
  }
  if (orchestratorActionStatus) {
    lines.push(`Orchestrator action status: ${orchestratorActionStatus}`);
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
      "This notification is a routing update within the existing supervision contract. Reuse instructions already in context; load only the state or references needed for this event."
    );
    if (
      event.type === "flow.notification" &&
      reason === "native_orchestrator_action_required"
    ) {
      lines.push(
        "A native orchestrator action is ready. Claim and execute the safe action reference above, then continue the existing flow."
      );
    } else if (event.type === "flow.notification") {
      lines.push(
        "This is a configured flow notification. Give the user the requested compact feedback or make the explicit manual routing decision requested by the flow."
      );
    } else if (event.type === "flow.step_blocked" || event.type === "agent.delivery_failed") {
      lines.push(
        "This is a blocker. Inspect only the minimum required state, decide whether to retry, route manually, or tell the user what is blocked."
      );
    } else if (event.type === "flow.completed") {
      lines.push("This flow has completed. If this thread owns user feedback, give a compact update in commentary while any other supervised work remains, then resume its event wait. A final response is allowed only when all supervised work is resolved or the user explicitly pauses or cancels supervision.");
    } else {
      lines.push(
        "Normal flow advancement is handled by Agent Control. Do not dispatch another step from this notification unless a prior tool result explicitly asks you to."
      );
    }
  }

  return lines.join("\n");
}

function codexSubagentExternalMessage(
  agent: AgentRecord,
  state: Record<string, unknown> | null
): AgentMessage | null {
  const latestMessage = nullableRecordString(state, "latest_message");
  const observedAt = nullableRecordString(state, "observed_at");
  if (latestMessage === null || !observedAt) {
    return null;
  }
  return {
    id: `native-external-${agent.agent_id}`,
    role: "assistant",
    text: latestMessage,
    created_at: observedAt,
    metadata: {
      source: "codex-subagent-external-sync",
      native_status: nullableRecordString(state, "native_status"),
      native_agent_id: nullableRecordString(state, "native_agent_id"),
      native_task_path: nullableRecordString(state, "native_task_path")
    }
  };
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

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
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
  objective: string;
  objectiveSource: string;
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
    `- Objective source: \`${input.objectiveSource}\``,
    `- Repository: ${input.run.repo_dir ? `\`${input.run.repo_dir}\`` : "not specified"}`,
    "",
    "Effective objective (source of truth):",
    "",
    input.objective,
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

function buildEffectiveFlowObjective(runTitle: string, coordinatorContext: string | null): string {
  if (!coordinatorContext) {
    return runTitle;
  }

  return [
    "Base objective:",
    runTitle,
    "",
    "Latest coordinator context (authoritative wherever it adds, clarifies, or conflicts):",
    coordinatorContext
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
  schema: { required?: string[]; properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(schema?.properties ?? {}), ...(schema?.required ?? [])]);
  for (const key of keys) {
    const property = schema?.properties?.[key];
    const allowed = property?.enum;
    // Keep generated examples type-valid without asserting optional routing flags.
    const samples: Record<string, unknown> = { boolean: false, number: 0, object: {}, array: [], null: null };
    result[key] = allowed?.length ? allowed[0] : property?.type && property.type in samples ? samples[property.type] : `<${key}>`;
  }
  return result;
}

function exampleArtifactReport(
  outputArtifacts: Record<string, Record<string, unknown>>
): Record<string, string> {
  const artifacts: Record<string, string> = {};
  for (const [outputName, descriptor] of Object.entries(outputArtifacts)) {
    // Optional documents are reported only if the worker actually produced them.
    if (descriptor.required !== true) continue;
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

function freshFlowStepAgentTitle(
  flowId: string,
  role: string,
  stepId: string,
  stepInstanceId: string
): string {
  return `${flowId}: ${role} [${stepId}:${stepInstanceId}]`;
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

function packageWaitContract(flowInstanceId: string) {
  return { turn_policy: "keep_open_while_work_pending", tool: "flow_packages", arguments: { flow_instance_id: flowInstanceId, request: { operation: "wait", timeout_ms: 3_600_000 } },
    instruction: "Keep this Codex turn open while supervised packages remain pending. Use this wait contract after launch, after a timeout, and after answering a user message in commentary. Handle the returned events, explicitly call the returned flow_packages ack contract, then wait again. Fetching never acknowledges processing. Omit cursor to resume the durable processed position; the original requesting conversation remains separately subscribed. A timeout or unrelated user message does not cancel the work. End only when supervision is resolved or explicitly paused or cancelled." };
}

const STRICT_FLOW_CAPABILITY_FAILURE = "If a required Agent Control tool is unavailable, requires approval, is denied by host policy, or returns auth_required, stop this step immediately. Do not retry repeatedly, switch to CLI or shell reporting, write controller files or the database, search for step IDs or credentials, change tool approval settings, or claim completion. Return exactly one concise final line: AGENT_CONTROL_BLOCKED: <tool name> | <brief observed reason>. Report the observed limitation without guessing whether the host or controller caused it; the coordinator will handle recovery.";

function buildFlowReportingMarkdown(input: {
  toolName: string;
  mcpInput: Record<string, unknown>;
  cliCommand?: string;
  resultSchema: unknown;
  outputArtifacts: Record<string, Record<string, unknown>>;
}): string {
  return [
    "## Agent Control Reporting Contract",
    "",
    `When this step is complete, report the result through Agent Control using the MCP tool \`${input.toolName}\`. ${input.cliCommand ? "If MCP tools are unavailable, use the CLI command shown below exactly as rendered." : STRICT_FLOW_CAPABILITY_FAILURE}`,
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
    "MCP tool input example (replace illustrative values with the actual outcome; include optional artifacts only when written):",
    "",
    "```json",
    JSON.stringify(input.mcpInput, null, 2),
    "```",
    "",
    ...(input.cliCommand ? ["CLI fallback example:", "", "```bash", input.cliCommand, "```", ""] : []),
    input.cliCommand ? "Use `status: \"completed\"` when the required artifact was written, including conclusions that route to blockers or corrections. Use a non-completed status only when you could not write the required artifact or could not produce a valid report." : "Use `status: \"completed\"` only for valid step work with required evidence and artifacts. A required-tool capability failure is a blocked handback, never a semantic completion.",
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

/** One stopped event per durable work generation makes stop retries idempotent. */
function agentStoppedEventId(agent: AgentRecord): string {
  return `event_agent_stopped_${agent.agent_id}_${agent.work_generation}`;
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
    skipped_runtime_paths: [],
    credential_cleanup_diagnostics: []
  };
}

function mergePurgeResult(target: PurgeResult, source: PurgeResult): void {
  target.purged_runs.push(...source.purged_runs);
  target.purged_agents.push(...source.purged_agents);
  target.deleted_runtime_paths.push(...source.deleted_runtime_paths);
  target.skipped_runtime_paths.push(...source.skipped_runtime_paths);
  target.credential_cleanup_diagnostics.push(...source.credential_cleanup_diagnostics);
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
