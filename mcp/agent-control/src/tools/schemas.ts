import { flowPackagesRequestSchema } from "../core/flow-packages.js";
import { evidenceRequestSchema } from "../core/evidence/service.js";
import { z } from "zod";
import { ORCHESTRATOR_ACTION_ID_RE } from "../core/ids.js";
import { AGENT_LINK_TYPES, AGENT_STATUSES, EVENT_TYPES, FLOW_STEP_INSTANCE_STATUSES } from "../core/types.js";

const requesterFields = {
  requester_thread_id: z.string().min(1).optional(),
  requester_event_types: z.array(z.enum(EVENT_TYPES)).min(1).optional(),
  requester_delivery: z.enum(["wait", "notify"]).optional()
};
export const workerAttachSchema = z.object({
  ...requesterFields, profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).optional(), server: z.string().min(1).optional(), auth_token_file: z.string().min(1).optional(), thread_id: z.string().uuid(), title: z.string().min(1).optional(), run_id: z.string().min(1).optional(),
  admin_key: z.string().min(1).optional(), agent_token: z.string().min(1).optional()
});
export const workerLaunchSchema = z.object({
  approval_policy: z.literal("on-request").optional(),
  ...requesterFields, title: z.string().min(1), prompt: z.string().min(1).optional(), prompt_file: z.string().min(1).optional(),
  repo_dir: z.string().min(1).optional(), run_id: z.string().min(1).optional(), backend: z.string().min(1).optional(),
  profile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(), sandbox: z.enum(["read_only", "workspace"]).optional(),
  model: z.string().min(1).optional(), reasoning_effort: z.string().min(1).optional(), server: z.string().min(1).optional(),
  phase: z.string().min(1).optional(), role: z.string().min(1).optional(), objective: z.string().min(1).optional(),
  output_artifact: z.string().min(1).optional(), input_handoffs: z.array(z.unknown()).optional(),
  input_artifacts: z.array(z.string()).optional(), constraints: z.array(z.string()).optional(),
  expected_artifacts: z.array(z.string()).optional(), attachments: z.array(z.string()).optional(), watch: z.boolean().optional(),
  admin_key: z.string().min(1).optional(), agent_token: z.string().min(1).optional()
}).refine(v => Boolean(v.prompt) !== Boolean(v.prompt_file), "Provide exactly one of prompt or prompt_file.");
export const flowLaunchSchema = z.object({
  ...requesterFields, title: z.string().min(1), acceptance_context: z.string().min(1).optional(), config: z.record(z.unknown()).optional(), flow_id: z.string().min(1).optional(),
  repo_dir: z.string().min(1).optional(), run_id: z.string().min(1).optional(), server: z.string().min(1).optional(),
  admin_key: z.string().min(1).optional(), agent_token: z.string().min(1).optional(),
  owner_task_identity: z.string().min(1).optional(), owner_task_path: z.string().min(1).optional()
}).refine(v => Boolean(v.config) !== Boolean(v.flow_id), "Provide exactly one of config or flow_id.");

export const runObserveSchema = z.object({
  run_id: z.string().min(1), thread_id: z.string().min(1).optional(), title: z.string().min(1).optional(),
  event_types: z.array(z.enum(EVENT_TYPES)).min(1).optional(), delivery: z.enum(["wait", "notify"]).optional(),
  admin_key: z.string().min(1).optional(), agent_token: z.string().min(1).optional()
});
export const runWaitSchema = z.object({
  run_id: z.string().min(1), observer_agent_id: z.string().min(1), cursor: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().optional(), limit: z.number().int().positive().max(100).optional(),
  wake_on: z.enum(["control", "all"]).optional()
});

export const emptySchema = z.object({});

export const runCreateSchema = z.object({
  title: z.string().min(1),
  repo_dir: z.string().min(1).optional(),
  admin_key: z.string().min(1).optional(),
  agent_token: z.string().min(1).optional()
});

export const runIdSchema = z.object({
  run_id: z.string().min(1),
  agent_token: z.string().min(1).optional()
});

export const runListSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  agent_token: z.string().min(1).optional()
});

export const agentRegisterSchema = z.object({
  run_id: z.string().min(1).optional(),
  backend: z.string().min(1),
  title: z.string().min(1),
  role: z.string().min(1).optional(),
  objective: z.string().min(1).optional(),
  repo_dir: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  status: z.enum(AGENT_STATUSES).optional(),
  backend_handle: z.record(z.unknown()).optional(),
  admin_key: z.string().min(1).optional(),
  agent_token: z.string().min(1).optional()
});

export const agentIdSchema = z.object({
  agent_id: z.string().min(1)
});

export const agentListSchema = z.object({
  run_id: z.string().min(1).optional(),
  include_unregistered: z.boolean().optional()
});

export const agentStartSchema = z.object({
  ...requesterFields,
  agent_id: z.string().min(1),
  prompt: z.string().min(1).optional(),
  server: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  expected_artifacts: z.array(z.string().min(1)).optional(),
  attachments: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
  agent_token: z.string().min(1).optional()
});

export const agentSendSchema = z.object({
  agent_id: z.string().min(1),
  message: z.string().min(1)
});

export const agentReadLatestSchema = z.object({
  agent_id: z.string().min(1),
  limit: z.number().int().positive().max(20).optional()
});

export const agentWaitSchema = z.object({
  agent_id: z.string().min(1),
  interval_ms: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  allow_blocking_wait: z.boolean().optional()
});

export const agentStopSchema = z.object({
  agent_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  all: z.boolean().optional(),
  mode: z.enum(["graceful", "interrupt", "kill"]).optional()
});

export const agentPurgeSchema = z.object({
  agent_id: z.string().min(1),
  stop_first: z.boolean().optional(),
  force: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  delete_runtime_files: z.boolean().optional()
});

export const runPurgeSchema = z.object({
  run_id: z.string().min(1),
  stop_first: z.boolean().optional(),
  force: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  delete_runtime_files: z.boolean().optional()
});

export const maintenancePurgeOldSchema = z.object({
  older_than: z.string().min(1),
  stop_first: z.boolean().optional(),
  force: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  delete_runtime_files: z.boolean().optional()
});

export const subscriptionCreateSchema = z.object({
  run_id: z.string().min(1).optional(),
  source_agent_id: z.string().min(1).optional(),
  subscriber_agent_id: z.string().min(1).optional(),
  event_type: z.enum(EVENT_TYPES),
  agent_token: z.string().min(1).optional()
});

export const subscriptionListSchema = z.object({
  run_id: z.string().min(1).optional(),
  enabled_only: z.boolean().optional(),
  agent_token: z.string().min(1).optional()
});

export const subscriptionDeleteSchema = z.object({
  subscription_id: z.string().min(1)
});

export const subscriptionWaitSchema = z.object({
  subscription_id: z.string().min(1),
  interval_ms: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  allow_blocking_wait: z.boolean().optional()
});

export const heartbeatCreateSchema = z.object({
  agent_id: z.string().min(1),
  idle_timeout_ms: z.number().int().positive(),
  reminder_interval_ms: z.number().int().positive().optional()
});

export const heartbeatListSchema = z.object({
  agent_id: z.string().min(1).optional()
});

export const heartbeatDeleteSchema = z.object({
  heartbeat_id: z.string().min(1)
});

export const goalRegisterSchema = z.object({
  agent_id: z.string().min(1).optional(),
  objective: z.string().min(1),
  agent_token: z.string().min(1).optional()
});

export const goalGetSchema = z.object({
  goal_id: z.string().min(1),
  defer_while_descendants_running: z.boolean().optional()
});

export const goalWaitConfirmationSchema = z.object({
  goal_id: z.string().min(1),
  interval_ms: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  timeout: z.string().min(1).optional(),
  allow_blocking_wait: z.boolean().optional()
});

export const goalUpdateSchema = z.object({
  goal_id: z.string().min(1),
  status: z.enum(["active", "complete", "continue", "blocked", "cancelled"])
});

export const eventListSchema = z.object({
  run_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  type: z.enum(EVENT_TYPES).optional(),
  limit: z.number().int().positive().max(500).optional()
});

export const orchestratorLoginSchema = z.object({
  admin_key: z.string().min(1),
  title: z.string().min(1),
  run_title: z.string().min(1).optional(),
  acceptance_context: z.string().min(1).optional(),
  repo_dir: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  backend: z.string().min(1).optional(),
  objective: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  backend_handle: z.record(z.unknown()).optional()
});

export const agentLinkCreateSchema = z.object({
  run_id: z.string().min(1).optional(),
  source_agent_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  type: z.enum(AGENT_LINK_TYPES),
  label: z.string().min(1).optional(),
  agent_token: z.string().min(1).optional()
});

export const agentLinkListSchema = z.object({
  run_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  agent_token: z.string().min(1).optional()
});

export const agentLinkDeleteSchema = z.object({
  link_id: z.string().min(1),
  agent_token: z.string().min(1).optional()
});

export const artifactRegisterSchema = z.object({
  run_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  label: z.string().min(1),
  path: z.string().min(1),
  expected: z.boolean().optional()
});

export const artifactReadHeaderSchema = z.object({
  path: z.string().min(1),
  lines: z.number().int().positive().max(100).optional()
});

export const flowValidateConfigSchema = z.object({
  config: z.record(z.unknown())
});

export const flowCatalogListSchema = z.object({
  repo_dir: z.string().optional(),
  query: z.string().min(1).optional()
});

export const flowCatalogGetSchema = z.object({
  repo_dir: z.string().optional(),
  flow_id: z.string().min(1)
});

export const flowStartSchema = z.object({
  acceptance_context: z.string().min(1).optional(),
  ...requesterFields,
  config: z.record(z.unknown()),
  run_id: z.string().min(1).optional(),
  run_title: z.string().min(1).optional(),
  repo_dir: z.string().min(1).optional(),
  admin_key: z.string().min(1).optional(),
  agent_token: z.string().min(1).optional(),
  owner_task_identity: z.string().min(1).optional(),
  owner_task_path: z.string().min(1).optional()
});

export const flowGetSchema = z.object({
  flow_instance_id: z.string().min(1)
});

export const flowDispatchActiveSchema = z.object({
  flow_instance_id: z.string().min(1),
  subscriber_agent_id: z.string().min(1).optional(),
  server: z.string().min(1).optional(),
  agent_token: z.string().min(1).optional(),
  bridge_token: z.string().min(1).optional()
});

export const flowContinueSchema = z.object({
  flow_instance_id: z.string().min(1),
  subscriber_agent_id: z.string().min(1).optional(),
  server: z.string().min(1).optional(),
  agent_token: z.string().min(1).optional(),
  bridge_token: z.string().min(1).optional()
});

export const flowStepStartSchema = z.object({
  agent_token: z.string().min(1).optional(),
  admin_key: z.string().min(1).optional(),
  flow_instance_id: z.string().min(1),
  step_id: z.string().min(1),
  from_step_instance_id: z.string().min(1).optional(),
  transition_id: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
});

export const flowStepReportSchema = z.object({
  agent_token: z.string().min(1).optional(),
  step_instance_id: z.string().min(1),
  status: z.enum(FLOW_STEP_INSTANCE_STATUSES),
  result: z.record(z.unknown()).optional(),
  artifacts: z.record(z.string().min(1)).optional(),
  summary: z.string().min(1).optional(),
  server: z.string().min(1).optional(),
  auto_continue: z.boolean().optional()
});

export const orchestratorActionClaimSchema = z.object({
  action_id: z.string().regex(ORCHESTRATOR_ACTION_ID_RE),
  bridge_token: z.string().min(1)
});

export const orchestratorActionAckSchema = z.object({
  action_id: z.string().regex(ORCHESTRATOR_ACTION_ID_RE),
  action_token: z.string().min(1),
  status: z.enum(["succeeded", "failed"]),
  result: z.record(z.unknown()).optional(),
  error: z.record(z.unknown()).optional()
});

export const agentExternalSyncSchema = z.object({
  agent_id: z.string().min(1),
  bridge_token: z.string().min(1),
  native_agent_id: z.string().min(1).optional(),
  native_task_name: z.string().min(1).optional(),
  native_task_path: z.string().min(1).optional(),
  native_status: z.enum([
    "pending_init",
    "running",
    "completed",
    "interrupted",
    "shutdown",
    "errored",
    "missing"
  ]),
  latest_message: z.string().optional(),
  public_activity: z.object({ kind: z.enum(["message", "tool"]), text: z.string().min(1).max(240),
    state: z.enum(["running", "completed", "failed"]).optional(), observed_at: z.string().datetime().optional() }).nullable().optional(),
  observed_at: z.string().min(1).optional(),
  confirmed_absent: z.boolean().optional()
});

export const agentStatusEnum = z.enum(AGENT_STATUSES);

const flowCoordinatorFields = { flow_instance_id: z.string().min(1), agent_token: z.string().min(1).optional(), admin_key: z.string().min(1).optional() };
export const flowContextUpdateSchema = z.object({ ...flowCoordinatorFields, context: z.string().min(1), expected_revision: z.number().int().nonnegative() });
export const flowDecisionSchema = z.object({ ...flowCoordinatorFields, key: z.string().min(1), value: z.unknown(), reason: z.string().min(1), expected_revision: z.number().int().nonnegative(), artifact_key: z.string().optional(), artifact_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(), package_manifest_digest: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export const flowEvidenceSchema = z.object({ ...flowCoordinatorFields, key: z.string().min(1), request: evidenceRequestSchema, step_instance_id: z.string().optional() });
export const runAckSchema = z.object({ wake_on: z.enum(["control", "all"]).optional(), run_id: z.string().min(1), observer_agent_id: z.string().min(1), cursor: z.string().min(1), agent_token: z.string().optional(), admin_key: z.string().optional() });

export const flowOwnerRecoverSchema = z.object({ ...flowCoordinatorFields, role: z.string().min(1), restart_step_id: z.string().min(1), reason: z.string().min(1), expected_revision: z.number().int().nonnegative() });

export const flowPackagesSchema = z.object({ ...flowCoordinatorFields, request: flowPackagesRequestSchema }).strict();

const operatorFields = { admin_key: z.string().min(1).optional(), agent_token: z.string().min(1).optional() };
export const permissionListSchema = z.object({ ...operatorFields, run_id: z.string().min(1) }).strict();
export const permissionDecideSchema = z.object({ ...operatorFields, agent_id: z.string().min(1), request_id: z.string().min(1), decision: z.enum(["approve", "reject"]) }).strict();
export const canvasGetSchema = permissionListSchema;
export const canvasSetSchema = z.object({ ...operatorFields, run_id: z.string().min(1), expected_revision: z.number().int().nonnegative(),
  positions: z.array(z.object({ agent_id: z.string().min(1), x: z.number().finite().min(-1e6).max(1e6), y: z.number().finite().min(-1e6).max(1e6) }).strict()).min(1).max(1000) }).strict();
