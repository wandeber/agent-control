export const AGENT_STATUSES = [
  "planned",
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "blocked",
  "stopping",
  "stopped",
  "unknown"
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const FAILURE_REASONS = [
  "backend_unavailable",
  "auth_required",
  "permission_required",
  "timeout",
  "idle_timeout",
  "missing_artifact",
  "stale_artifact",
  "tool_error",
  "worker_reported_blocker",
  "unsupported_operation",
  "unknown"
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * Durable phases for a non-native backend start. `prepared` is the only phase
 * that may be reclaimed after its lease expires because no adapter call has
 * crossed the invocation boundary yet. An expired `invoking` attempt becomes
 * `ambiguous`: the backend may have accepted the request, so automatic retry
 * would risk creating a duplicate session.
 * `succeeded` retains a route-owned handle; `superseded` retains a concrete
 * handle that must be compensated because its original route lost ownership.
 */
export const AGENT_START_ATTEMPT_PHASES = [
  "prepared",
  "invoking",
  "succeeded",
  "superseded",
  "failed",
  "ambiguous",
  "cancelled"
] as const;

export type AgentStartAttemptPhase = (typeof AGENT_START_ATTEMPT_PHASES)[number];

export interface AgentStartAttemptRecord {
  start_attempt_id: string;
  agent_id: string;
  flow_instance_id: string;
  step_instance_id: string;
  generation: number;
  phase: AgentStartAttemptPhase;
  claim_owner_id: string;
  lease_expires_at: string;
  invocation_started_at: string | null;
  handle_json: Record<string, unknown> | null;
  error_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export const EVENT_TYPES = [
  "agent.started",
  "agent.status_changed",
  "agent.message",
  "agent.completed",
  "agent.failed",
  "agent.blocked",
  "agent.stopped",
  "agent.unregistered",
  "agent.delivery_failed",
  "artifact.created",
  "artifact.updated",
  "goal.confirmation_requested",
  "goal.confirmation_deferred",
  "goal.completed",
  "goal.continued",
  "goal.blocked",
  "flow.started",
  "flow.step_started",
  "flow.step_reported",
  "flow.step_blocked",
  "flow.transition_selected",
  "flow.notification",
  "flow.completed",
  "heartbeat.timeout",
  "timer.elapsed"
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type GoalStatus = "active" | "complete" | "continue" | "blocked" | "cancelled";

export const AGENT_LINK_TYPES = [
  "parent_child",
  "waits_for",
  "subscribed_to",
  "blocks",
  "handoff"
] as const;

export type AgentLinkType = (typeof AGENT_LINK_TYPES)[number];

export const FLOW_INSTANCE_STATUSES = [
  "active",
  "waiting_for_orchestrator",
  "blocked",
  "completed",
  "cancelled"
] as const;

export type FlowInstanceStatus = (typeof FLOW_INSTANCE_STATUSES)[number];

export const FLOW_STEP_INSTANCE_STATUSES = [
  "active",
  "completed",
  "blocked",
  "failed",
  "cancelled"
] as const;

export type FlowStepInstanceStatus = (typeof FLOW_STEP_INSTANCE_STATUSES)[number];

export interface RunRecord {
  run_id: string;
  title: string;
  repo_dir: string | null;
  parent_run_id: string | null;
  created_by_agent_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentRecord {
  agent_id: string;
  run_id: string;
  backend: string;
  title: string;
  role: string | null;
  objective: string | null;
  repo_dir: string | null;
  model: string | null;
  backend_handle: Record<string, unknown> | null;
  /** Monotonic fence for status observations made across backend I/O. */
  work_generation: number;
  /** Changes when the current physical work attempt enters or leaves I/O. */
  work_revision: number;
  status: AgentStatus;
  failure_reason: FailureReason | null;
  unregistered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRecord {
  event_id: string;
  run_id: string | null;
  agent_id: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface SubscriptionRecord {
  subscription_id: string;
  run_id: string | null;
  source_agent_id: string | null;
  subscriber_agent_id: string;
  event_type: EventType;
  enabled: boolean;
  last_delivered_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export type SubscriptionDeliveryStatus =
  | "pending"
  | "claimed"
  | "invoking"
  | "ambiguous"
  | "delivered"
  | "failed";

/** Durable logical delivery shared by duplicate subscriptions and controllers. */
export interface SubscriptionDeliveryRecord {
  event_id: string;
  subscriber_agent_id: string;
  status: SubscriptionDeliveryStatus;
  claim_attempt: number;
  claim_owner_id: string | null;
  claimed_at: string | null;
  last_error: Record<string, unknown> | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HeartbeatRecord {
  heartbeat_id: string;
  agent_id: string;
  idle_timeout_ms: number;
  reminder_interval_ms: number | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalRecord {
  goal_id: string;
  agent_id: string;
  objective: string;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

export interface GoalConfirmationResult {
  goal: GoalRecord;
  message: string;
  delivered: boolean;
  deferred: boolean;
  elapsed_ms: number;
  active_descendants: AgentRecord[];
}

export interface ArtifactRecord {
  artifact_id: string;
  run_id: string | null;
  agent_id: string | null;
  label: string;
  path: string;
  expected: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentLinkRecord {
  link_id: string;
  run_id: string;
  source_agent_id: string;
  target_agent_id: string;
  type: AgentLinkType;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentTokenRecord {
  token_id: string;
  agent_id: string;
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
}

export interface BridgeGrantRecord {
  bridge_grant_id: string;
  run_id: string;
  orchestrator_agent_id: string;
  owner_task_identity: string | null;
  owner_task_path: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * The raw bridge token is intentionally returned only when a flow creates the
 * grant. Persisted records and every later public response expose metadata but
 * never reproduce this credential.
 */
export interface BridgeCredential {
  bridge_grant_id: string;
  bridge_token: string;
  run_id: string;
  orchestrator_agent_id: string;
  owner_task_identity: string | null;
  owner_task_path: string;
  created_at: string;
  expires_at: string | null;
}

export interface PublicBridgeGrantRef extends Omit<BridgeCredential, "bridge_token"> {}

export interface PublicActionClaimRef {
  action_id: string;
  run_id: string;
  orchestrator_agent_id: string;
  claim_attempt: number;
  lease_expires_at: string;
}

export interface CredentialCleanupDiagnostic {
  kind: "bridge" | "action_claim";
  id: string;
  code: "credential_cleanup_failed" | "credential_store_invalid_record";
}

export const ORCHESTRATOR_ACTION_OPERATIONS = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "interrupt_agent"
] as const;

export type OrchestratorActionOperation = (typeof ORCHESTRATOR_ACTION_OPERATIONS)[number];

export const ORCHESTRATOR_ACTION_STATUSES = [
  "pending",
  "claimed",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export type OrchestratorActionStatus = (typeof ORCHESTRATOR_ACTION_STATUSES)[number];

export interface OrchestratorActionRecord {
  action_id: string;
  idempotency_key: string;
  run_id: string;
  orchestrator_agent_id: string;
  agent_id: string;
  flow_instance_id: string | null;
  step_instance_id: string | null;
  operation: OrchestratorActionOperation;
  status: OrchestratorActionStatus;
  payload_json: Record<string, unknown>;
  result_json: Record<string, unknown> | null;
  error_json: Record<string, unknown> | null;
  /** Exact bridge grant authorized to execute this action. */
  originating_bridge_grant_id: string | null;
  claimed_by_bridge_grant_id: string | null;
  claim_owner_identity: string | null;
  claim_attempt: number;
  claimed_at: string | null;
  claim_lease_expires_at: string | null;
  action_token_hash: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** A deliberately compact action reference safe for events and normal APIs. */
export interface OrchestratorActionRef {
  action_id: string;
  operation: OrchestratorActionOperation;
  status: OrchestratorActionStatus;
  run_id: string;
  orchestrator_agent_id: string;
  agent_id: string;
  flow_instance_id: string | null;
  step_instance_id: string | null;
}

export interface OrchestratorActionAcknowledgementResult {
  action: OrchestratorActionRef;
  agent: AgentRecord;
  /**
   * Follow-up work that became possible only after the acknowledged action
   * supplied a native target. In particular, a late spawn acknowledgement can
   * expose the interrupt required by a stop request that arrived during spawn.
   */
  orchestrator_action?: OrchestratorActionRef;
}

export type AgentStopResult = AgentRecord & {
  orchestrator_action?: OrchestratorActionRef;
};

export interface RunShutdownResult {
  run: RunRecord;
  stopped: AgentStopResult[];
  orchestrator_actions: OrchestratorActionRef[];
  pending_agent_ids: string[];
  complete: boolean;
}

export type CodexSubagentForkTurns = "none" | "all" | `${number}`;

export interface OrchestratorActionClaimedEnvelope {
  action_id: string;
  action_token: string;
  operation: OrchestratorActionOperation;
  backend: "codex-subagent";
  run_id: string;
  orchestrator_agent_id: string;
  agent_id: string;
  flow_instance_id: string | null;
  step_instance_id: string | null;
  request: Record<string, unknown>;
}

export type OrchestratorActionClaimResult =
  | OrchestratorActionClaimedEnvelope
  | { status: "already_claimed"; action_id: string; retry_after_ms: number };

/**
 * Adapters are normalized internally to these two outcomes. Existing backends
 * are immediately unwrapped at the controller boundary so the opt-in native
 * bridge does not change their established public response shapes.
 */
export type AgentOperationResult<T> =
  | { type: "completed"; value: T }
  | { type: "orchestrator_action_required"; action: OrchestratorActionRef };

export type AgentWithToken = AgentRecord & {
  agent_token: string;
};

export type AgentWithOrchestratorAction = AgentRecord & {
  orchestrator_action: OrchestratorActionRef;
};

export type AgentStartState =
  | "started"
  | "in_progress"
  | "ambiguous"
  | "superseded"
  | "cancelled"
  | "failed";

export type AgentStartResult = (
  | AgentWithToken
  | AgentWithOrchestratorAction
  | (AgentRecord & { agent_token?: never; orchestrator_action?: never })
) & { start_state?: AgentStartState; observer?: RunObserverResult | null };

export type AgentSendResult =
  | { agent: AgentRecord; delivered: true }
  | {
      agent: AgentRecord;
      delivered: false;
      orchestrator_action: OrchestratorActionRef | null;
    };

export interface OrchestratorLoginResult {
  run: RunRecord;
  agent: AgentRecord;
  agent_token: string;
}

export interface UsageSnapshotRecord {
  usage_id: string;
  run_id: string;
  agent_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  context_used: number | null;
  context_limit: number | null;
  source: string | null;
  model: string | null;
  captured_at: string;
}

export interface FlowRecord {
  flow_record_id: string;
  flow_id: string;
  version: string | null;
  description: string | null;
  config: FlowConfig;
  created_at: string;
  updated_at: string;
}

export interface FlowInstanceRecord {
  runtime?: import("./flow-runtime.js").FlowRuntimeState | null;
  flow_instance_id: string;
  flow_record_id: string;
  run_id: string;
  orchestrator_agent_id: string | null;
  originating_bridge_grant_id: string | null;
  status: FlowInstanceStatus;
  current_step_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowStepInstanceRecord {
  step_instance_id: string;
  flow_instance_id: string;
  step_id: string;
  agent_id: string | null;
  status: FlowStepInstanceStatus;
  input_json: Record<string, unknown>;
  output_json: Record<string, unknown>;
  result_json: Record<string, unknown>;
  transition_id: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface FlowStepReportRecord {
  report_id: string;
  step_instance_id: string;
  status: FlowStepInstanceStatus;
  result_json: Record<string, unknown>;
  artifacts_json: Record<string, unknown>;
  summary: string | null;
  created_at: string;
}

export interface FlowTransitionRecord {
  flow_transition_id: string;
  flow_instance_id: string;
  from_step_instance_id: string;
  transition_id: string;
  target_step_id: string | null;
  action_json: Record<string, unknown>;
  created_at: string;
}

export interface FlowArtifactBindingRecord {
  sha256?: string;
  snapshot_path?: string;
  binding_id: string;
  flow_instance_id: string;
  artifact_key: string;
  artifact_id: string | null;
  path: string;
  produced_by_step_instance_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowConfig {
  id: string;
  version?: string;
  description?: string;
  initial_step: string;
  policy?: { strict?: boolean; plan_artifact?: string };
  preferences?: Record<string, { values: string[]; artifact_key?: string; owner?: "requester" | "orchestrator" }>;
  state?: Record<string, unknown>;
  prompts?: Record<string, FlowPromptConfig>;
  artifacts?: Record<string, FlowArtifactConfig>;
  roles?: Record<string, FlowRoleConfig>;
  steps: Record<string, FlowStepConfig>;
}

export interface FlowPromptConfig {
  path?: string;
  text?: string;
  description?: string;
}

export interface FlowPromptReferenceConfig {
  prompt?: string;
  prompt_ref?: string;
  prompt_path?: string;
}

export type FlowAgentLifecycle = "reuse" | "fresh_per_step";

export interface FlowRoleConfig {
  backend?: string;
  model?: string | null;
  reasoning_effort?: string | null;
  agent_lifecycle?: FlowAgentLifecycle;
  backend_options?: {
    codex_subagent?: {
      fork_turns?: CodexSubagentForkTurns;
    };
  };
  description?: string;
  prompt?: string;
  prompt_ref?: string;
  prompt_path?: string;
}

export interface FlowArtifactConfig {
  path?: string;
  description?: string;
}

export interface FlowEvidenceRequirement {
  receipt: string;
  kind?: string;
  require_current?: boolean;
  require_approved?: boolean;
  owner_role?: string;
  validation_mode?: "focused" | "complete_gate";
}

export interface FlowStepConfig {
  execution?: "worker" | "coordinator";
  sandbox?: "read_only" | "workspace";
  evidence_operations?: string[];
  evidence_gates?: Array<"planner" | "expert">;
  decision?: { key: string; artifact_key?: string; authority?: "user" | "coordinator"; owner?: "requester" | "orchestrator" };
  requires?: FlowConditionConfig;
  requires_evidence?: FlowEvidenceRequirement[];
  role?: string;
  agent_id?: string;
  prompt?: string;
  prompt_ref?: string;
  prompt_path?: string;
  description?: string;
  inputs?: Record<string, FlowArtifactReferenceConfig>;
  outputs?: Record<string, FlowArtifactReferenceConfig>;
  report?: FlowReportConfig;
  on?: Record<string, FlowStepActionConfig>;
}

export interface FlowArtifactReferenceConfig {
  artifact: string;
  required?: boolean;
}

export interface FlowReportConfig {
  tool?: string;
  schema?: FlowResultSchemaConfig;
}

export interface FlowResultSchemaConfig {
  type?: "object";
  required?: string[];
  properties?: Record<string, FlowResultPropertyConfig>;
}

export interface FlowResultPropertyConfig {
  type?: "string" | "number" | "boolean" | "object" | "array" | "null";
  enum?: Array<string | number | boolean | null>;
}

export interface FlowStepActionConfig {
  requires?: FlowConditionConfig;
  requires_evidence?: FlowEvidenceRequirement[];
  set?: Record<string, unknown>;
  notify?: string;
  to?: string;
  finish?: boolean;
  transitions?: FlowTransitionConfig[];
}

export interface FlowTransitionConfig extends FlowStepActionConfig {
  id: string;
  when?: FlowConditionConfig;
}

export type FlowConditionConfig =
  | { equals: { var: string; value?: unknown } }
  | { exists: { var: string } }
  | { all: FlowConditionConfig[] }
  | { any: FlowConditionConfig[] };

export type RunObserverResult = ReturnType<import("./run-observation.js").RunObservation["observe"]>;

export interface FlowStartResult {
  observer?: RunObserverResult | null;
  flow: FlowRecord;
  instance: FlowInstanceRecord;
  active_step: FlowStepInstanceRecord | null;
  reused?: boolean;
  blocked_reason?: string;
  bridge_grant?: PublicBridgeGrantRef;
  bridge_credential?: BridgeCredential;
}

export interface FlowSnapshot {
  runtime?: import("./flow-runtime.js").FlowRuntimeState | null;
  flow: FlowRecord;
  instance: FlowInstanceRecord;
  steps: FlowStepInstanceRecord[];
  reports: FlowStepReportRecord[];
  transitions: FlowTransitionRecord[];
  artifact_bindings: FlowArtifactBindingRecord[];
}

export interface FlowStepReportResult extends FlowSnapshot {
  replayed?: boolean;
  reported_step: FlowStepInstanceRecord;
  selected_transition: FlowTransitionRecord | null;
  active_step: FlowStepInstanceRecord | null;
  notification: string | null;
}

export interface FlowStepStartResult extends FlowSnapshot {
  selected_transition: FlowTransitionRecord | null;
  active_step: FlowStepInstanceRecord | null;
  notification: string | null;
  /**
   * Safe lifecycle projections for workers abandoned by the manual route.
   * Native cleanup exposes only the compact action reference, never bridge or
   * action credentials and never the private native request payload.
   */
  cleanup: FlowStepCleanupResult[];
}

export interface FlowStepCleanupResult {
  agent_id: string;
  status: AgentStatus;
  failure_reason: FailureReason | null;
  orchestrator_action: OrchestratorActionRef | null;
}

export interface FlowDispatchActiveResult {
  flow_instance_id: string;
  step: Record<string, unknown>;
  agent: Record<string, unknown>;
  subscriptions: Array<Record<string, unknown>>;
  expected_artifacts: string[];
  prompt_size: number;
  orchestrator_action: OrchestratorActionRef | null;
  start_state: AgentStartState | null;
}

export type FlowContinueAction =
  | "dispatched"
  | "orchestrator_action_required"
  | "waiting_for_report"
  | "start_in_progress"
  | "start_superseded"
  | "waiting_for_orchestrator"
  | "blocked"
  | "completed"
  | "cancelled"
  | "no_active_step";

export interface FlowContinueResult {
  flow_instance_id: string;
  action: FlowContinueAction;
  instance: FlowInstanceRecord;
  active_step: FlowStepInstanceRecord | null;
  dispatch: FlowDispatchActiveResult | null;
  agent: AgentRecord | null;
  notification: string | null;
  blocked_reason: string | null;
  orchestrator_action: OrchestratorActionRef | null;
}

export interface FlowStepReportAndContinueResult {
  report: FlowStepReportResult;
  continuation: FlowContinueResult | null;
}

export interface AgentComputedState {
  activity?: import("./agent-activity.js").AgentActivity;
  agent_id: string;
  elapsed_ms: number;
  status_age_ms: number;
  is_terminal: boolean;
  latest_usage: UsageSnapshotRecord | null;
}

export interface DashboardSnapshot {
  run_observers?: Array<{ observer_agent_id: string; run_id: string; event_types: EventType[]; delivery: "wait" | "notify" }>;
  generated_at: string;
  selected_run_id: string | null;
  runs: RunRecord[];
  agents: AgentRecord[];
  agent_links: AgentLinkRecord[];
  flows: FlowRecord[];
  flow_instances: FlowInstanceRecord[];
  flow_steps: FlowStepInstanceRecord[];
  flow_reports: FlowStepReportRecord[];
  flow_transitions: FlowTransitionRecord[];
  flow_artifact_bindings: FlowArtifactBindingRecord[];
  subscriptions: SubscriptionRecord[];
  heartbeats: HeartbeatRecord[];
  goals: GoalRecord[];
  artifacts: ArtifactRecord[];
  latest_events: EventRecord[];
  computed_agents: AgentComputedState[];
  status_counts: Record<AgentStatus, number>;
  usage_totals: {
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    context_used: number | null;
    context_limit: number | null;
  };
}

export interface PurgeOptions {
  dryRun: boolean;
  stopFirst: boolean;
  force: boolean;
  deleteRuntimeFiles: boolean;
}

export interface MaintenancePurgeOptions extends PurgeOptions {
  olderThanMs: number;
}

export interface PurgeResult {
  dry_run: boolean;
  purged_runs: string[];
  purged_agents: string[];
  deleted_rows: Record<string, number>;
  deleted_runtime_paths: string[];
  skipped_runtime_paths: string[];
  credential_cleanup_diagnostics: CredentialCleanupDiagnostic[];
}

export interface AgentCapabilities {
  canStart: boolean;
  canSendMessage: boolean;
  canReadLatest: boolean;
  canStopGracefully: boolean;
  canForceStop: boolean;
  canStreamMessages: boolean;
  canInspectStatusCheaply: boolean;
  canAttachExisting: boolean;
  requiresOrchestratorAction?: boolean;
  canInterrupt?: boolean;
}

export interface AgentHandle {
  backend: string;
  id: string;
  data: Record<string, unknown>;
}

export interface StartAgentInput {
  agent: AgentRecord;
  agentToken?: string;
  prompt?: string;
  server?: string;
  model?: string;
  expectedArtifacts?: string[];
  attachments?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentMessageInput {
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AgentMessage {
  id: string;
  role: string;
  text: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface AgentStatusSnapshot {
  status: AgentStatus;
  failureReason?: FailureReason;
  message?: string;
  updatedAt?: string;
  data?: Record<string, unknown>;
}

export interface ReadLatestOptions {
  limit: number;
}

export interface StopOptions {
  mode: "graceful" | "interrupt" | "kill";
}

export interface StopResult {
  status: AgentStatus;
  failureReason?: FailureReason;
  message?: string;
  data?: Record<string, unknown>;
}

export interface UnregisterOptions {
  archiveRecord: boolean;
}

export interface AgentAdapter {
  /** Append an observation without creating a competing turn. No fallback is allowed. */
  stageNotification?(handle: AgentHandle, message: AgentMessageInput): Promise<void>;
  kind: string;
  capabilities(): AgentCapabilities;
  start(input: StartAgentInput): Promise<AgentHandle>;
  sendMessage(handle: AgentHandle, message: AgentMessageInput): Promise<void>;
  getStatus(handle: AgentHandle): Promise<AgentStatusSnapshot>;
  readLatest(handle: AgentHandle, options: ReadLatestOptions): Promise<AgentMessage[]>;
  stop(handle: AgentHandle, options: StopOptions): Promise<StopResult>;
  watchStatus?(
    handle: AgentHandle,
    onChange: (snapshot: AgentStatusSnapshot) => void | Promise<void>
  ): () => void;
  unregister?(handle: AgentHandle, options: UnregisterOptions): Promise<void>;
}
