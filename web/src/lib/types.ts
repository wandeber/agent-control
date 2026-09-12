export type AgentStatus =
  | "planned"
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "blocked"
  | "stopping"
  | "stopped"
  | "unknown";

export type EventType =
  | "agent.started"
  | "agent.status_changed"
  | "agent.message"
  | "agent.completed"
  | "agent.failed"
  | "agent.blocked"
  | "agent.stopped"
  | "agent.unregistered"
  | "agent.delivery_failed"
  | "artifact.created"
  | "artifact.updated"
  | "goal.confirmation_requested"
  | "goal.confirmation_deferred"
  | "goal.completed"
  | "goal.continued"
  | "goal.blocked"
  | "flow.started"
  | "flow.step_started"
  | "flow.step_reported"
  | "flow.step_blocked"
  | "flow.transition_selected"
  | "flow.notification"
  | "flow.completed"
  | "heartbeat.timeout"
  | "timer.elapsed";

export type AgentLinkType = "parent_child" | "waits_for" | "subscribed_to" | "blocks" | "handoff";

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
  status: AgentStatus;
  failure_reason: string | null;
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
  status: "active" | "complete" | "continue" | "blocked" | "cancelled";
  created_at: string;
  updated_at: string;
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

export interface UsageSnapshotRecord {
  scope_started_at?: string;
  scope_ended_at?: string | null;
  usage_id: string;
  run_id: string;
  agent_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens?: number | null;
  cache_write_input_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  total_tokens: number | null;
  context_used: number | null;
  context_limit: number | null;
  source: string | null;
  model: string | null;
  captured_at: string;
}

export type FlowInstanceStatus = "active" | "waiting_for_orchestrator" | "blocked" | "completed" | "cancelled";

export type FlowStepInstanceStatus = "active" | "completed" | "blocked" | "failed" | "cancelled";

export interface FlowRecord {
  flow_record_id: string;
  flow_id: string;
  version: string | null;
  description: string | null;
  config: FlowConfigRecord;
  created_at: string;
  updated_at: string;
}

export interface FlowConfigRecord {
  id: string;
  version?: string;
  description?: string;
  initial_step: string;
  artifacts?: Record<string, { path?: string; description?: string }>;
  roles?: Record<string, { backend?: string; model?: string | null; reasoning_effort?: string | null; description?: string; prompt_ref?: string }>;
  prompts?: Record<string, { path?: string; description?: string }>;
  steps: Record<string, FlowStepConfigRecord>;
}

export interface FlowStepConfigRecord {
  execution?: "agent" | "worker" | "coordinator";
  decision?: { key: string; artifact_key?: string; authority?: "user" | "coordinator"; owner?: "requester" | "orchestrator" };
  role?: string;
  agent_id?: string;
  prompt?: string;
  prompt_ref?: string;
  prompt_path?: string;
  description?: string;
  inputs?: Record<string, { artifact: string; required?: boolean }>;
  outputs?: Record<string, { artifact: string; required?: boolean }>;
  report?: FlowReportConfigRecord;
  on?: Record<string, FlowStepActionConfigRecord>;
}

export interface FlowReportConfigRecord {
  tool?: string;
  schema?: {
    type?: "object";
    required?: string[];
    properties?: Record<string, { enum?: Array<string | number | boolean | null> }>;
  };
}

export interface FlowStepActionConfigRecord {
  notify?: string;
  to?: string;
  finish?: boolean;
  transitions?: FlowTransitionConfigRecord[];
}

export interface FlowTransitionConfigRecord extends FlowStepActionConfigRecord {
  id: string;
  when?: FlowConditionConfigRecord;
}

export type FlowConditionConfigRecord =
  | { equals: { var: string; value?: unknown } }
  | { exists: { var: string } }
  | { all: FlowConditionConfigRecord[] }
  | { any: FlowConditionConfigRecord[] };

export interface FlowInstanceRecord {
  flow_instance_id: string;
  flow_record_id: string;
  run_id: string;
  status: FlowInstanceStatus;
  current_step_id: string | null;
  created_at: string;
  updated_at: string;
  runtime?: FlowRuntimeRecord | null;
}

/** Optional for older runs, which have reports but no verified evidence ledger. */
export interface FlowRuntimeRecord {
  revision: number;
  acceptance_revision: number;
  context: string | null;
  config_digest: string;
  state: Record<string, unknown>;
  decisions: Record<string, { value: unknown; reason: string; actor_id: string; acceptance_revision: number; artifact_key?: string; artifact_digest?: string }>;
  evidence: Record<string, string>;
  evidence_summaries?: Record<string, FlowEvidenceSummaryRecord>;
  owners: Record<string, string>;
  correction: Record<string, unknown> | null;
  recovery?: { request_digest: string; role: string; previous_agent_id: string; agent_id: string; reason: string; restart_step_id: string; full_review_required: boolean };
}

export interface FlowEvidenceSummaryRecord {
  receipt_id: string;
  kind: string;
  status: string;
  step_instance_id?: string;
  step_id?: string;
  acceptance_revision?: number;
  summary: {
    reviewed_count?: number;
    carried_count?: number;
    reopened_count?: number;
    executed_check_count?: number;
    reused_check_count?: number;
    reason?: string;
    reviewed_scopes?: string[];
    carried_scopes?: string[];
    reopened_scopes?: Array<{ label: string; reason: string }>;
    executed_checks?: string[];
    reused_checks?: string[];
  };
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
  binding_id: string;
  flow_instance_id: string;
  artifact_key: string;
  artifact_id: string | null;
  path: string;
  produced_by_step_instance_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentComputedState {
  agent_id: string;
  elapsed_ms: number;
  status_age_ms: number;
  is_terminal: boolean;
  latest_usage: UsageSnapshotRecord | null;
  activity?: { kind: "message" | "tool"; text: string; observed_at?: string; state?: "running" | "completed" | "failed" } | null;
}

export interface AccessPolicy { sandbox: "read_only" | "workspace" | "full_access"; approval_policy: "on-request" | "never" | "untrusted" }
export interface AgentAccessSnapshot {
  agent_id: string; requested: AccessPolicy | null;
  effective: { approval_policy: unknown; sandbox_policy: Record<string, unknown>; thread_id: string; observed_at: string } | null;
  revision: number; effective_revision: number | null; state: "pending" | "applied" | "unverified" | "unsupported";
}
export interface PermissionRequest {
  request_id: string; agent_id: string; thread_id: string; turn_id: string; item_id: string;
  kind: "command" | "files" | "permissions"; title: string; reason: string | null;
  reject_interrupts_turn?: boolean;
  scope: Record<string, unknown>; scope_complete: boolean; choices: Array<"approve" | "reject">;
  state: "pending" | "submitting" | "sent" | "resolved" | "unavailable";
  decision: "approve" | "reject" | null; created_at: string;
}

export interface CanvasPosition { agent_id: string; x: number; y: number }
export interface CanvasPositions { run_id: string; revision: number; coordinate_space: "run"; positions: CanvasPosition[]; updated_at: string | null }
export interface DashboardSnapshot {
  canvas_positions?: CanvasPositions;
  agent_access?: AgentAccessSnapshot[];
  permission_requests?: PermissionRequest[];
  costs?: RunCosts;
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

export interface CostAmount { usd: number | null; partial: boolean }
export interface ExchangeRate { usd_per_eur: number; source: string | null; updated_at: string | null }
export interface CostBreakdown {
  input: CostAmount;
  cached: CostAmount;
  cache_write: CostAmount;
  output: CostAmount;
  total: CostAmount;
}
export interface AgentCost extends CostBreakdown {
  agent_id: string;
  model: string;
  pricing_key: string | null;
  rates: { input_per_million: number; cached_input_per_million: number; cache_write_input_per_million: number; output_per_million: number } | null;
}
export interface RunCosts {
  currency: "USD";
  updated_at: string;
  source: string;
  basis: string;
  configuration_valid: boolean;
  override_files: string[];
  model_references?: Record<string, { model: string; source: string; basis: string; updated_at?: string }>;
  exchange?: ExchangeRate;
  agents: AgentCost[];
  models: Array<CostBreakdown & { model: string }>;
  total: CostBreakdown;
}

export interface AgentMessage {
  id?: string;
  role?: string;
  text?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type SocketPayload =
  | { type: "snapshot"; snapshot: DashboardSnapshot; snapshots?: DashboardSnapshot[] }
  | { type: "event"; event: EventRecord }
  | { type: "agent_messages"; agent_id: string; messages: AgentMessage[] }
  | { type: "agent_log"; log: AgentLogTail }
  | { type: "error"; error: string };

export interface AgentLogTail {
  agent_id: string;
  exists: boolean;
  bytes: number;
  tail: string;
}
