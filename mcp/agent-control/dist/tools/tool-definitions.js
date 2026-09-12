import { QUESTION_TOOLS } from "./questions.js";
import { permissionListSchema, permissionDecideSchema, canvasGetSchema, canvasSetSchema } from "./schemas.js";
import { flowPackagesRequestJsonSchema } from "../core/flow-packages.js";
import { evidenceRequestJsonSchema } from "../core/evidence/service.js";
import { AGENT_LINK_TYPES, AGENT_STATUSES, EVENT_TYPES, FLOW_STEP_INSTANCE_STATUSES } from "../core/types.js";
import { ORCHESTRATOR_ACTION_ID_RE } from "../core/ids.js";
import { workerAttachSchema } from "./schemas.js";
import { flowPackagesSchema, flowContextUpdateSchema, flowOwnerRecoverSchema, flowDecisionSchema, flowEvidenceSchema, runAckSchema, workerLaunchSchema, flowLaunchSchema, agentLinkCreateSchema, agentLinkDeleteSchema, agentLinkListSchema, agentIdSchema, agentListSchema, agentReadLatestSchema, agentRegisterSchema, agentPurgeSchema, agentSendSchema, agentStartSchema, agentStopSchema, agentWaitSchema, agentExternalSyncSchema, artifactReadHeaderSchema, artifactRegisterSchema, emptySchema, eventListSchema, flowCatalogGetSchema, flowCatalogListSchema, flowContinueSchema, flowDispatchActiveSchema, flowGetSchema, flowStartSchema, flowStepReportSchema, flowStepStartSchema, flowValidateConfigSchema, goalGetSchema, goalRegisterSchema, goalUpdateSchema, goalWaitConfirmationSchema, heartbeatCreateSchema, heartbeatDeleteSchema, heartbeatListSchema, maintenancePurgeOldSchema, orchestratorLoginSchema, orchestratorActionAckSchema, orchestratorActionClaimSchema, runObserveSchema, runWaitSchema, runCreateSchema, runIdSchema, runListSchema, runPurgeSchema, subscriptionCreateSchema, subscriptionDeleteSchema, subscriptionListSchema, subscriptionWaitSchema } from "./schemas.js";
import { booleanProperty, enumProperty, numberProperty, objectSchema, stringArrayProperty, stringProperty } from "./json-schema.js";
const requesterProperties = {
    requester_thread_id: stringProperty("Original user conversation; resolved from the run/parent or CODEX_THREAD_ID when omitted."),
    requester_event_types: { type: "array", items: { type: "string", enum: [...EVENT_TYPES] }, description: "Optional explicit filter; new observers subscribe to all supported events." },
    requester_delivery: enumProperty(["wait", "notify"], "Default wait; consume the returned observer cursor through run_wait.")
};
const flowIdentityProperties = { flow_instance_id: stringProperty("Flow instance id."), agent_token: stringProperty("Authenticated caller token if the local Codex thread identity is unavailable."), admin_key: stringProperty("Local coordinator administration credential; never place it in prompts or artifacts.") };
const operatorProperties = { admin_key: stringProperty("Explicit local administrator credential. Omit when the host identifies the original requester; never include credentials in prompts."), agent_token: stringProperty("Worker tokens are not operator authorization and will be rejected.") };
const positionProperties = { agent_id: stringProperty("Agent in this run."), x: numberProperty("Run-local canvas x coordinate."), y: numberProperty("Run-local canvas y coordinate.") };
export const TOOL_DEFINITIONS = [
    ...QUESTION_TOOLS,
    { name: "permission_list", description: "Read real native permission requests, their exact scope, supported choices and delivery state for a run. Original Codex requester or explicit local admin only. Review before deciding; incomplete scope cannot be approved.", inputSchema: objectSchema({ ...operatorProperties, run_id: stringProperty("Run id.") }, ["run_id"]), schema: permissionListSchema },
    { name: "permission_decide", description: "Submit an authorized approve/reject decision for one real, currently owned native request. Requires user authorization for that scope or an explicit delegation to assess safe requests. Never grants blanket access. Idempotent same decision; conflicting/stale decisions fail. submitting means recorded, sent means handed to Codex, resolved means native acknowledgment. Resume run_wait after handling the event.", inputSchema: objectSchema({ ...operatorProperties, agent_id: stringProperty("Request owner."), request_id: stringProperty("Exact native request id from permission_list."), decision: enumProperty(["approve", "reject"], "Decision for the displayed scope.") }, ["agent_id", "request_id", "decision"]), schema: permissionDecideSchema },
    { name: "canvas_positions_get", description: "Read persisted per-run agent positions and CAS revision. Empty positions mean automatic layout. Coordinates exclude multi-run frame offsets; only real agent nodes can be positioned. Original requester or explicit local admin only.", inputSchema: objectSchema({ ...operatorProperties, run_id: stringProperty("Run id.") }, ["run_id"]), schema: canvasGetSchema },
    { name: "canvas_positions_set", description: "Atomically move agent nodes in the shared canvas using the revision returned by canvas_positions_get. Patches listed agents, preserves others. UI refreshes without losing camera or selection. Coordinates are run-local, not viewport pixels. A stale revision requires a fresh read and a deliberate retry.", inputSchema: objectSchema({ ...operatorProperties, run_id: stringProperty("Run id."), expected_revision: numberProperty("Current revision."), positions: { type: "array", minItems: 1, maxItems: 1000, items: objectSchema(positionProperties, ["agent_id", "x", "y"]) } }, ["run_id", "expected_revision", "positions"]), schema: canvasSetSchema },
    { name: "worker_attach", description: "Register an existing Codex session by thread_id without relaunching it. Automatically registers and subscribes the original conversation. Discover the owning app-server through server (local or remote); returns current per-session messaging/interruption/continuation capabilities. Use agent_send_message to steer active turns or continue idle sessions, agent_stop mode=interrupt to interrupt only the current turn. For independently started local CLI work, messages are durably queued until its current turn and exclusive writer finish, then continue the exact UUID/profile. A queued receipt is not delivery or a reply. agent_stop mode=interrupt preserves queued continuations and signals only the reverified exclusive CLI process; graceful (default) or kill requests definitive cancellation and cancels pending messages. Existing active writers are never duplicated. If neither control route is available, reconnect to the owning endpoint or configure the original profile. Keep the conversation turn open and resume run_wait after user interruptions.", inputSchema: objectSchema({ ...requesterProperties,
            thread_id: stringProperty("Actual existing Codex thread UUID."), title: stringProperty("Optional participant title."),
            server: stringProperty("Owning Codex app-server endpoint, including a configured remote WebSocket endpoint."),
            profile: stringProperty("Original matching CLI profile if it cannot be discovered from the live writer; preserves external provider credentials and configuration."),
            auth_token_file: stringProperty("Local credential file for that endpoint; do not put credentials into prompts."),
            run_id: stringProperty("Existing run; omit to establish a run."), admin_key: stringProperty("Optional local authorization."), agent_token: stringProperty("Optional owner identity.")
        }, ["thread_id"]), schema: workerAttachSchema },
    { name: "flow_owner_recover", description: "Explicitly replace a stopped or detached pinned role owner. Creates a fresh identity, records the recovery reason, restarts a configured step for that role, and requires a full review before incremental evidence reuse. Active unrelated work cannot be replaced.", inputSchema: objectSchema({ ...flowIdentityProperties, role: stringProperty("Pinned role to recover."), restart_step_id: stringProperty("Configured step belonging to that role."), reason: stringProperty("Explicit reason for owner replacement."), expected_revision: numberProperty("Current flow runtime revision.") }, ["flow_instance_id", "role", "restart_step_id", "reason", "expected_revision"]), schema: flowOwnerRecoverSchema },
    { name: "flow_context_update", description: "Replace the complete current acceptance contract with compare-and-swap revision; retain unchanged requirements in the supplied contract. History remains immutable and is not replayed into every prompt. Prior approval evidence becomes stale; route affected work before accepting more reports.", inputSchema: objectSchema({ ...flowIdentityProperties, context: stringProperty("Complete current accepted objective, constraints and acceptance criteria."), expected_revision: numberProperty("Current flow runtime revision.") }, ["flow_instance_id", "context", "expected_revision"]), schema: flowContextUpdateSchema },
    { name: "flow_packages", description: "Define approved disjoint work packages, launch ready branches in parallel, deliver immutable worker results, accept a batch and launch successors, recover or cancel generations, verify consolidation, and wait/ack the authenticated launching thread’s durable event subscription. Wait uses up to one hour and returns a separate explicit ACK contract; it never acknowledges processing automatically. Package children report only through deliver, never the parent flow_step_report. Read current state with flow_get.", inputSchema: objectSchema({ ...flowIdentityProperties, request: flowPackagesRequestJsonSchema }, ["flow_instance_id", "request"]), schema: flowPackagesSchema },
    { name: "flow_decision", description: "Record an explicit human gate decision or configured preference. Artifact gates require the exact current artifact digest; decisions never arise from elapsed time. Completes the active coordinator gate through declared transitions.", inputSchema: objectSchema({ ...flowIdentityProperties, key: stringProperty("Configured decision key."), value: {}, reason: stringProperty("The user's explicit decision and its context."), expected_revision: numberProperty("Current flow runtime revision."), artifact_key: stringProperty("Configured artifact key."), artifact_digest: stringProperty("Exact current artifact SHA-256 reviewed by the user."), package_manifest_digest: stringProperty("Exact package manifest digest displayed together with the approved plan.") }, ["flow_instance_id", "key", "value", "reason", "expected_revision"]), schema: flowDecisionSchema },
    { name: "flow_evidence", description: "Prepare immutable checkpoints, compose strict incremental reviews, execute or reuse verified validation checks, or verify closure. Identity and acceptance/plan revisions are supplied by the controller; only operations authorized for the active step are accepted. Returns a compact receipt and registers it under key for declarative guards.", inputSchema: objectSchema({ ...flowIdentityProperties, key: stringProperty("Evidence registry key used by flow guards."), step_instance_id: stringProperty("Current step generation."), request: evidenceRequestJsonSchema }, ["flow_instance_id", "key", "request"]), schema: flowEvidenceSchema },
    { name: "run_ack", description: "Acknowledge a delivered event cursor after handling its events. Persists processed progress for safe reattachment; never acknowledges undelivered events.", inputSchema: objectSchema({ run_id: stringProperty("Run id."), observer_agent_id: stringProperty("Observer identity."), cursor: stringProperty("Delivered observer-bound cursor."), wake_on: enumProperty(["control", "all"], "Preserve the delivered wait policy in the next contract."), agent_token: stringProperty("Authorized observer or owner token."), admin_key: stringProperty("Local administrator credential.") }, ["run_id", "observer_agent_id", "cursor"]), schema: runAckSchema },
    {
        name: "worker_launch",
        description: "Launch an ad hoc worker with any explicitly requested model or configured Codex CLI profile; no flow or predefined flow agent is required. Native default is Codex Luna Max. Automatically creates local coordinator/run identity, registers the original user conversation, subscribes it to all events and starts detached supervision. Return observer contains the cursor for run_wait. No separate login, registration or observe call is needed. Keep this turn open while work remains: use the wait_contract for your own thread (coordinator_observer for a separate executor, observer for the requester), answer user messages in commentary even on another topic, then resume run_wait with the latest processed cursor and a one-hour timeout. Do not rely on notify to wake an ended turn.",
        inputSchema: objectSchema({ ...requesterProperties, approval_policy: enumProperty(["on-request"], "Interactive permission requests for managed codex-thread or codex-cli workers. Defaults unchanged; CLI uses the same session through its owned app-server transport."), title: stringProperty("Worker title."),
            prompt: stringProperty("Ad hoc task text; choose prompt or prompt_file."), prompt_file: stringProperty("Existing canonical skill prompt file."),
            repo_dir: stringProperty("Repository directory."), run_id: stringProperty("Optional existing run."),
            backend: stringProperty("Default codex-cli when profile is supplied, otherwise codex-thread."), profile: stringProperty("Existing Codex CLI profile, e.g. softec-yoda. Requires codex-cli; its model is preserved unless explicitly overridden."), sandbox: stringProperty("read_only or workspace."), model: stringProperty("Requested model; default Luna only for codex-thread, never overrides a CLI profile."), reasoning_effort: stringProperty("Default max for Luna."),
            server: stringProperty("Optional explicit backend endpoint."), phase: stringProperty("Task phase."), role: stringProperty("Worker role."),
            objective: stringProperty("Bounded objective."), output_artifact: stringProperty("Optional report destination."),
            input_handoffs: { type: "array", items: { type: "object" }, description: "Compact structured handoffs." },
            input_artifacts: stringArrayProperty("Label=path inputs."), constraints: stringArrayProperty("Task constraints."),
            expected_artifacts: stringArrayProperty("Expected output files."), attachments: stringArrayProperty("File attachments."),
            watch: booleanProperty("Detached supervision is enabled by default. Disable only with an existing supervisor."),
            admin_key: stringProperty("Optional explicit admin authorization."), agent_token: stringProperty("Optional existing caller identity.")
        }, ["title"]), schema: workerLaunchSchema
    },
    {
        name: "flow_launch",
        description: "Launch and dispatch a flow in one call using config or a catalog flow_id. Automatically establishes local owner identity, registers/subscribes the original user conversation to all events before dispatch and returns its run_wait cursor. Keeps native bridge authority with the coordinator. Keep this turn open while work remains; after responding to any user message, resume run_wait using your own thread's wait_contract (coordinator_observer for a separate executor, observer for the requester) and its latest processed cursor with a one-hour timeout. Notify cannot reliably wake an ended turn.",
        inputSchema: objectSchema({ ...requesterProperties, title: stringProperty("Run objective/title."),
            config: { type: "object", description: "Flow config; choose config or flow_id." }, acceptance_context: stringProperty("Complete clarified objective, constraints and acceptance criteria; stored atomically before the first worker starts."), flow_id: stringProperty("Bundled/user catalog flow id."),
            repo_dir: stringProperty("Repository directory."), run_id: stringProperty("Optional existing run."), server: stringProperty("Optional explicit backend endpoint."),
            admin_key: stringProperty("Optional explicit admin authorization."), agent_token: stringProperty("Optional existing caller identity."),
            owner_task_identity: stringProperty("Native bridge owner identity."), owner_task_path: stringProperty("Native bridge owner task path.")
        }, ["title"]), schema: flowLaunchSchema
    },
    {
        name: "run_observe",
        description: "Identify the user conversation in a run and subscribe to all supported events by default or an explicit filter without transferring workflow or native bridge ownership. Default delivery is through run_wait; notify uses safe in-turn injection only.",
        inputSchema: objectSchema({ run_id: stringProperty("Run to observe."), thread_id: stringProperty("Actual Codex thread id; defaults to current CODEX_THREAD_ID."),
            title: stringProperty("Participant title."), event_types: { type: "array", items: { type: "string", enum: [...EVENT_TYPES] } },
            delivery: enumProperty(["wait", "notify"], "wait or notify; default wait."), admin_key: stringProperty("Admin authorization."), agent_token: stringProperty("Authorized caller identity.") }, ["run_id"]),
        schema: runObserveSchema
    },
    {
        name: "run_wait",
        description: "Keep this tool call pending while work runs; a subscription alone does not wait. Default control wakes for decisions owned by this thread, intervention and aggregate completion; an executing coordinator also receives routing events. Use all only for explicitly requested individual events. Acknowledge handled deliveries with run_ack; omit cursor to resume durable processed progress. Omit timeout for indefinite wait or use 3600000 for one hour. Tool cancellation ends only this wait. After answering new user input, resume with the last processed cursor unless the user explicitly pauses or cancels supervision. Preserve all active runs. A timeout or unrelated topic is not completion; keep the turn open and reattach. Each response provides the next wait_contract. completion reports the outcome only when all registered work and descendants settle. A single worker/flow completion is not whole-run completion; closed only closes that observation. Do not relay routine progress or create monitoring automations.",
        inputSchema: objectSchema({ run_id: stringProperty("Observed run."), observer_agent_id: stringProperty("Observing participant id."),
            wake_on: enumProperty(["control", "all"], "Default control: role-aware actionable events and whole-work completion. All: each subscribed event, including individual worker completions."),
            cursor: stringProperty("Explicit replay cursor; omit to resume durable acknowledged progress."), timeout_ms: numberProperty("Optional positive timeout; 3600000 is one hour."), limit: numberProperty("Maximum batch size, up to 100.") }, ["run_id", "observer_agent_id"]),
        schema: runWaitSchema
    },
    {
        name: "backend_list",
        description: "List registered backend adapters and their capability flags.",
        inputSchema: objectSchema({}),
        schema: emptySchema
    },
    {
        name: "flow_validate_config",
        description: "Validate a declarative Agent Control flow config without starting it.",
        inputSchema: objectSchema({
            config: { type: "object", description: "Flow config object." }
        }, ["config"]),
        schema: flowValidateConfigSchema
    },
    {
        name: "flow_catalog_list",
        description: "List bundled and user flow catalogs plus .agents/flows from explicit repo_dir. Project flow IDs replace matching installed IDs.",
        inputSchema: objectSchema({
            repo_dir: stringProperty("Absolute project directory; discovers .agents/flows and .agents/models.toml."),
            query: stringProperty("Optional case-insensitive filter over flow id, directory, description, version, or path.")
        }),
        schema: flowCatalogListSchema
    },
    {
        name: "flow_catalog_get",
        description: "Resolve a flow by ID or directory name, with project-local shadowing and deterministic .agents/models.toml overrides when repo_dir is supplied.",
        inputSchema: objectSchema({ repo_dir: stringProperty("Absolute project directory for local catalog and model overrides."), flow_id: stringProperty("Flow id or flow directory name.") }, ["flow_id"]),
        schema: flowCatalogGetSchema
    },
    {
        name: "flow_start",
        description: "Create a flow instance, bind it to a run, and activate the initial step. Native codex-subagent flows return one scoped bridge credential at creation time.",
        inputSchema: objectSchema({
            ...requesterProperties,
            config: { type: "object", description: "Flow config object." },
            run_id: stringProperty("Existing run id. If omitted, a new run is created."),
            run_title: stringProperty("Title for a newly created run."),
            repo_dir: stringProperty("Repository directory for a newly created run."),
            admin_key: stringProperty("Admin key for creating a root run."),
            agent_token: stringProperty("Agent identity token. Creates a child run when run_id is omitted."),
            owner_task_identity: stringProperty("Optional CODEX_THREAD_ID binding for the root task."),
            owner_task_path: stringProperty("Canonical root task path. Defaults to /root.")
        }, ["config"]),
        schema: flowStartSchema
    },
    {
        name: "flow_get",
        description: "Get the current flow instance snapshot: config, steps, reports, transitions, and artifact bindings.",
        inputSchema: objectSchema({ flow_instance_id: stringProperty("Flow instance id.") }, ["flow_instance_id"]),
        schema: flowGetSchema
    },
    {
        name: "flow_dispatch_active",
        description: "Dispatch the active flow step to its configured backend worker, optionally subscribe an orchestrator to terminal events, and return immediately. The caller keeps its turn open and resumes run_wait after user replies or event processing while work remains.",
        inputSchema: objectSchema({
            flow_instance_id: stringProperty("Flow instance id."),
            subscriber_agent_id: stringProperty("Agent to notify on worker terminal events."),
            server: stringProperty("Backend server URL for server-backed adapters."),
            agent_token: stringProperty("Optional agent identity token for the coordinator."),
            bridge_token: stringProperty("Scoped native bridge token returned once by flow_start.")
        }, ["flow_instance_id"]),
        schema: flowDispatchActiveSchema
    },
    {
        name: "flow_continue",
        description: "Advance a flow deterministically: dispatch the active unassigned step, wait when a step is already running, or stop at configured notifications and blockers.",
        inputSchema: objectSchema({
            flow_instance_id: stringProperty("Flow instance id."),
            subscriber_agent_id: stringProperty("Optional agent to notify on the dispatched worker's terminal events."),
            server: stringProperty("Backend server URL for server-backed adapters."),
            agent_token: stringProperty("Optional agent identity token for access checks."),
            bridge_token: stringProperty("Scoped native bridge token returned once by flow_start.")
        }, ["flow_instance_id"]),
        schema: flowContinueSchema
    },
    {
        name: "orchestrator_action_claim",
        description: "Claim one scoped native subagent action for 60 seconds. A successful claim returns the private request and one-time action token; claims during the lease return already_claimed without either secret.",
        inputSchema: objectSchema({
            action_id: {
                ...stringProperty("Orchestrator action id from a public action reference."),
                pattern: ORCHESTRATOR_ACTION_ID_RE.source
            },
            bridge_token: stringProperty("Scoped bridge token for the action's run and orchestrator.")
        }, ["action_id", "bridge_token"]),
        schema: orchestratorActionClaimSchema
    },
    {
        name: "orchestrator_action_ack",
        description: "Acknowledge a claimed native action with its rotated action token. Identical acknowledgements are idempotent; conflicting acknowledgements are rejected.",
        inputSchema: objectSchema({
            action_id: {
                ...stringProperty("Claimed orchestrator action id."),
                pattern: ORCHESTRATOR_ACTION_ID_RE.source
            },
            action_token: stringProperty("One-time token returned by the successful claim."),
            status: enumProperty(["succeeded", "failed"], "Native tool execution result."),
            result: { type: "object", description: "Structured non-secret native result." },
            error: { type: "object", description: "Structured failure details." }
        }, ["action_id", "action_token", "status"]),
        schema: orchestratorActionAckSchema
    },
    {
        name: "agent_external_sync",
        description: "Synchronize one codex-subagent card from root-owned subagent v2 state without semantically completing its flow step.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent Control agent id."),
            bridge_token: stringProperty("Scoped bridge token for this agent's run."),
            native_agent_id: stringProperty("Native Codex subagent id when known."),
            native_task_name: stringProperty("Native task name when known."),
            native_task_path: stringProperty("Canonical native task path when known."),
            native_status: enumProperty(["pending_init", "running", "completed", "interrupted", "shutdown", "errored", "missing"], "Observed subagent v2 status."),
            latest_message: stringProperty("Private latest message, limited to 4 KiB and excluded from dashboards/events."),
            public_activity: { type: ["object", "null"], description: "Explicit public card summary, never hidden reasoning or raw logs. Null clears it.",
                properties: { kind: { type: "string", enum: ["message", "tool"] }, text: { type: "string", maxLength: 240 },
                    state: { type: "string", enum: ["running", "completed", "failed"] }, observed_at: { type: "string", format: "date-time" } }, required: ["kind", "text"] },
            observed_at: stringProperty("Observation timestamp. Defaults to now."),
            confirmed_absent: booleanProperty("Confirm exact absence after the recovery delay.")
        }, ["agent_id", "bridge_token", "native_status"]),
        schema: agentExternalSyncSchema
    },
    {
        name: "flow_step_report",
        description: "Report the result of an active flow step. The controller validates result schema, required artifacts, selects the next transition, and auto-continues by default.",
        inputSchema: objectSchema({
            step_instance_id: stringProperty("Active flow step instance id."),
            agent_token: stringProperty("Assigned worker or coordinator identity, normally resolved from the local Codex thread."),
            status: enumProperty(FLOW_STEP_INSTANCE_STATUSES, "Flow step result status."),
            result: { type: "object", description: "Structured result payload used by transition conditions." },
            artifacts: { type: "object", description: "Output artifact paths by output name or artifact key." },
            summary: stringProperty("Compact human summary of the step result."),
            server: stringProperty("Backend server URL for server-backed adapters when auto-continuing."),
            auto_continue: booleanProperty("Whether to dispatch the next active step automatically. Defaults to true.")
        }, ["step_instance_id", "status"]),
        schema: flowStepReportSchema
    },
    {
        name: "flow_step_start",
        description: "Manually activate a configured flow step, typically after a notify/orchestrator decision. Required inputs are validated before the step becomes active.",
        inputSchema: objectSchema({
            flow_instance_id: stringProperty("Flow instance id."),
            step_id: stringProperty("Configured step id to activate."),
            agent_token: stringProperty("Authenticated coordinator identity."),
            admin_key: stringProperty("Local administrator credential."),
            from_step_instance_id: stringProperty("Optional previous step instance that led to this manual transition."),
            transition_id: stringProperty("Optional transition id to record."),
            reason: stringProperty("Optional coordinator context and transition reason delivered to the manually activated step.")
        }, ["flow_instance_id", "step_id"]),
        schema: flowStepStartSchema
    },
    {
        name: "orchestrator_login",
        description: "Authenticate a root orchestrator with the local admin key and return an Agent Control identity token.",
        inputSchema: objectSchema({
            admin_key: stringProperty("Agent Control admin key."),
            title: stringProperty("Orchestrator and root run title."),
            run_title: stringProperty("Optional root run title when it should differ from the orchestrator title."),
            repo_dir: stringProperty("Optional repository directory."),
            run_id: stringProperty("Optional existing run id to attach to."),
            backend: stringProperty("Optional orchestrator backend. Defaults to codex-thread."),
            objective: stringProperty("Optional orchestrator objective."),
            model: stringProperty("Optional model."),
            backend_handle: { type: "object", description: "Optional backend handle for the orchestrator." }
        }, ["admin_key", "title"]),
        schema: orchestratorLoginSchema
    },
    {
        name: "run_create",
        description: "Create a controller run.",
        inputSchema: objectSchema({
            title: stringProperty("Run title."),
            repo_dir: stringProperty("Optional repository directory."),
            admin_key: stringProperty("Admin key for creating a root run."),
            agent_token: stringProperty("Agent identity token. Creates a child run of the caller's current run.")
        }, ["title"]),
        schema: runCreateSchema
    },
    {
        name: "run_list",
        description: "List recent controller runs.",
        inputSchema: objectSchema({
            limit: numberProperty("Maximum number of runs."),
            agent_token: stringProperty("Optional agent identity token for scoped run visibility.")
        }),
        schema: runListSchema
    },
    {
        name: "run_get",
        description: "Get one controller run.",
        inputSchema: objectSchema({ run_id: stringProperty("Run id."), agent_token: stringProperty("Optional agent identity token.") }, ["run_id"]),
        schema: runIdSchema
    },
    {
        name: "run_shutdown",
        description: "Stop active agents in a run. Returns stopped agents plus scoped native actions; the run remains stopping until every native worker is terminal.",
        inputSchema: objectSchema({ run_id: stringProperty("Run id.") }, ["run_id"]),
        schema: runIdSchema
    },
    {
        name: "agent_register",
        description: "Register an agent participant.",
        inputSchema: objectSchema({
            run_id: stringProperty("Run id."),
            backend: stringProperty("Backend kind, such as opencode-server or codex-thread."),
            title: stringProperty("Agent title."),
            role: stringProperty("Optional short role."),
            objective: stringProperty("Optional objective."),
            repo_dir: stringProperty("Optional repository directory."),
            model: stringProperty("Optional backend model."),
            status: enumProperty(AGENT_STATUSES, "Optional initial normalized status."),
            backend_handle: { type: "object", description: "Optional backend handle for attached agents." },
            admin_key: stringProperty("Optional admin key for manual/root registration."),
            agent_token: stringProperty("Optional caller identity token. Infers run_id and parent_child hierarchy.")
        }, ["backend", "title"]),
        schema: agentRegisterSchema
    },
    {
        name: "agent_start",
        description: "Start a registered agent and automatically attach its run requester before dispatch. Returns observer.wait_contract for run_wait. Keep this turn open while work remains; answer user messages in commentary and resume the one-hour event wait with the latest processed cursor.",
        inputSchema: objectSchema({
            ...requesterProperties,
            agent_id: stringProperty("Agent id."),
            prompt: stringProperty("Worker prompt. Required for OpenCode starts."),
            server: stringProperty("Backend server URL, required for OpenCode."),
            model: stringProperty("Optional model override."),
            expected_artifacts: stringArrayProperty("Expected artifact paths."),
            attachments: stringArrayProperty("Files to attach to the backend message."),
            metadata: { type: "object", description: "Backend metadata." },
            agent_token: stringProperty("Optional caller identity token for access checks.")
        }, ["agent_id"]),
        schema: agentStartSchema
    },
    {
        name: "agent_list",
        description: "List registered agents.",
        inputSchema: objectSchema({
            run_id: stringProperty("Optional run id."),
            include_unregistered: booleanProperty("Include unregistered agents.")
        }),
        schema: agentListSchema
    },
    {
        name: "agent_get",
        description: "Get one agent record.",
        inputSchema: objectSchema({ agent_id: stringProperty("Agent id.") }, ["agent_id"]),
        schema: agentIdSchema
    },
    {
        name: "agent_status",
        description: "Refresh and return one agent status.",
        inputSchema: objectSchema({ agent_id: stringProperty("Agent id.") }, ["agent_id"]),
        schema: agentIdSchema
    },
    {
        name: "agent_send_message",
        description: "Send a compact message to the exact existing agent. Busy managed or attached Codex CLI sessions queue it behind the current turn; delivered=false, queued=true and message_id confirm acceptance, not delivery or completion. Continue run_wait using the same observer/cursor. Do not cancel a worker merely to send a follow-up.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent id."),
            message: stringProperty("Message text.")
        }, ["agent_id", "message"]),
        schema: agentSendSchema
    },
    {
        name: "agent_read_latest",
        description: "Read the latest messages from an agent without streaming the full transcript.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent id."),
            limit: numberProperty("Maximum messages to return.")
        }, ["agent_id"]),
        schema: agentReadLatestSchema
    },
    {
        name: "agent_wait",
        description: "Block until one agent reaches a terminal status, refreshing status cheaply. Use for explicit manual/debug waits or short opt-in foreground waits. Normal long-running orchestrators should use detached watchers/subscriptions.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent id."),
            interval_ms: numberProperty("Refresh interval in milliseconds."),
            timeout_ms: numberProperty("Timeout in milliseconds."),
            allow_blocking_wait: booleanProperty("Required true to acknowledge a foreground blocking wait.")
        }, ["agent_id"]),
        schema: agentWaitSchema
    },
    {
        name: "agent_stop",
        description: "Stop one agent, all agents in a run, or all registered agents. interrupt is recoverable current-turn interruption: retain the session, context and pending follow-ups, then continue that same agent and run observer. Requires backend canInterrupt; unsupported interruption never falls back to cancellation. graceful (default) and kill are definitive cancellation and block new work. Bulk calls await every result and retain scoped native actions.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent id."),
            run_id: stringProperty("Run id."),
            all: booleanProperty("Stop all registered agents."),
            mode: enumProperty(["graceful", "interrupt", "kill"], "interrupt: recoverable current turn; graceful (default) or kill: definitive cancellation.")
        }),
        schema: agentStopSchema
    },
    {
        name: "agent_unregister",
        description: "Unregister one agent, all agents in a run, or all registered agents.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent id."),
            run_id: stringProperty("Run id."),
            all: booleanProperty("Unregister all registered agents."),
            mode: enumProperty(["graceful", "interrupt", "kill"], "Ignored; accepted for shape parity.")
        }),
        schema: agentStopSchema
    },
    {
        name: "agent_purge",
        description: "Physically delete one agent's controller rows and controller-owned runtime files.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent id."),
            stop_first: booleanProperty("Attempt graceful stop before purging an active agent."),
            force: booleanProperty("Allow purge even if the agent remains active."),
            dry_run: booleanProperty("Preview rows and runtime paths without deleting."),
            delete_runtime_files: booleanProperty("Delete controller-owned runtime files. Defaults to true.")
        }, ["agent_id"]),
        schema: agentPurgeSchema
    },
    {
        name: "subscription_create",
        description: "Subscribe one agent to source events.",
        inputSchema: objectSchema({
            run_id: stringProperty("Optional run scope."),
            source_agent_id: stringProperty("Optional source agent id."),
            subscriber_agent_id: stringProperty("Subscriber agent id. Defaults to caller when agent_token is provided."),
            event_type: enumProperty(EVENT_TYPES, "Event type to deliver."),
            agent_token: stringProperty("Optional caller identity token.")
        }, ["event_type"]),
        schema: subscriptionCreateSchema
    },
    {
        name: "subscription_list",
        description: "List subscriptions.",
        inputSchema: objectSchema({
            run_id: stringProperty("Optional run id."),
            enabled_only: booleanProperty("Only enabled subscriptions."),
            agent_token: stringProperty("Optional agent identity token. Defaults listing to caller's run.")
        }),
        schema: subscriptionListSchema
    },
    {
        name: "subscription_delete",
        description: "Delete a subscription.",
        inputSchema: objectSchema({ subscription_id: stringProperty("Subscription id.") }, ["subscription_id"]),
        schema: subscriptionDeleteSchema
    },
    {
        name: "subscription_wait",
        description: "Block until a subscription's matching event exists, refreshing the source agent when possible. Use this when the current coordinator must stay in its turn and receive the event directly; set allow_blocking_wait=true. The result includes matched and delivered, so an event is still returned when the subscriber backend cannot receive an inbound message. Normal long-running orchestrators may use detached watchers instead.",
        inputSchema: objectSchema({
            subscription_id: stringProperty("Subscription id."),
            interval_ms: numberProperty("Refresh interval in milliseconds."),
            timeout_ms: numberProperty("Timeout in milliseconds."),
            allow_blocking_wait: booleanProperty("Required true to acknowledge a foreground blocking wait.")
        }, ["subscription_id"]),
        schema: subscriptionWaitSchema
    },
    {
        name: "link_create",
        description: "Create an explicit visual relationship between two agents.",
        inputSchema: objectSchema({
            run_id: stringProperty("Optional run id. Defaults to caller run when agent_token is provided."),
            source_agent_id: stringProperty("Source agent id."),
            target_agent_id: stringProperty("Target agent id."),
            type: enumProperty(AGENT_LINK_TYPES, "Relationship type."),
            label: stringProperty("Optional relationship label."),
            agent_token: stringProperty("Optional caller identity token.")
        }, ["source_agent_id", "target_agent_id", "type"]),
        schema: agentLinkCreateSchema
    },
    {
        name: "link_list",
        description: "List explicit visual relationships between agents.",
        inputSchema: objectSchema({
            run_id: stringProperty("Optional run id."),
            agent_id: stringProperty("Optional source/target agent filter."),
            agent_token: stringProperty("Optional agent identity token. Defaults listing to caller's run.")
        }),
        schema: agentLinkListSchema
    },
    {
        name: "link_delete",
        description: "Delete an explicit visual relationship.",
        inputSchema: objectSchema({
            link_id: stringProperty("Relationship link id."),
            agent_token: stringProperty("Optional caller identity token.")
        }, ["link_id"]),
        schema: agentLinkDeleteSchema
    },
    {
        name: "heartbeat_create",
        description: "Create an idle-time heartbeat expectation for an agent.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent id."),
            idle_timeout_ms: numberProperty("Idle timeout in milliseconds."),
            reminder_interval_ms: numberProperty("Optional reminder interval in milliseconds.")
        }, ["agent_id", "idle_timeout_ms"]),
        schema: heartbeatCreateSchema
    },
    {
        name: "heartbeat_list",
        description: "List heartbeats.",
        inputSchema: objectSchema({ agent_id: stringProperty("Optional agent id.") }),
        schema: heartbeatListSchema
    },
    {
        name: "heartbeat_delete",
        description: "Delete a heartbeat.",
        inputSchema: objectSchema({ heartbeat_id: stringProperty("Heartbeat id.") }, ["heartbeat_id"]),
        schema: heartbeatDeleteSchema
    },
    {
        name: "goal_register",
        description: "Register an active goal for an agent.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent id."),
            objective: stringProperty("Goal objective."),
            agent_token: stringProperty("Optional caller identity token. Defaults owner to caller.")
        }, ["objective"]),
        schema: goalRegisterSchema
    },
    {
        name: "goal_get",
        description: "Get a goal.",
        inputSchema: objectSchema({ goal_id: stringProperty("Goal id.") }, ["goal_id"]),
        schema: goalGetSchema
    },
    {
        name: "goal_confirm",
        description: "Ask the goal owner whether the goal is complete, should continue, or is blocked. Defers by default while child agents are active.",
        inputSchema: objectSchema({
            goal_id: stringProperty("Goal id."),
            defer_while_descendants_running: booleanProperty("Defer confirmation while parent_child descendants are active.")
        }, ["goal_id"]),
        schema: goalGetSchema
    },
    {
        name: "goal_wait_confirm",
        description: "Wait in deterministic code until the goal owner has no active child descendants, then ask for goal completion confirmation. Use for explicit manual/debug waits or short opt-in foreground waits. Normal long-running orchestrators should use detached watchers/subscriptions.",
        inputSchema: objectSchema({
            goal_id: stringProperty("Goal id."),
            interval_ms: numberProperty("Refresh interval in milliseconds."),
            timeout_ms: numberProperty("Timeout in milliseconds."),
            timeout: stringProperty("Timeout such as 30m, 12h, or raw milliseconds."),
            allow_blocking_wait: booleanProperty("Required true to acknowledge a foreground blocking wait.")
        }, ["goal_id"]),
        schema: goalWaitConfirmationSchema
    },
    {
        name: "goal_update",
        description: "Update goal status.",
        inputSchema: objectSchema({
            goal_id: stringProperty("Goal id."),
            status: enumProperty(["active", "complete", "continue", "blocked", "cancelled"], "Goal status.")
        }, ["goal_id", "status"]),
        schema: goalUpdateSchema
    },
    {
        name: "goal_unregister",
        description: "Delete a goal from active tracking.",
        inputSchema: objectSchema({ goal_id: stringProperty("Goal id.") }, ["goal_id"]),
        schema: goalGetSchema
    },
    {
        name: "event_list",
        description: "List controller events.",
        inputSchema: objectSchema({
            run_id: stringProperty("Optional run id."),
            agent_id: stringProperty("Optional agent id."),
            type: enumProperty(EVENT_TYPES, "Optional event type."),
            limit: numberProperty("Maximum events to return.")
        }),
        schema: eventListSchema
    },
    {
        name: "run_purge",
        description: "Physically delete one run, its agents, related controller rows, and controller-owned runtime files.",
        inputSchema: objectSchema({
            run_id: stringProperty("Run id."),
            stop_first: booleanProperty("Attempt graceful stop before purging active agents."),
            force: booleanProperty("Allow purge even if agents remain active."),
            dry_run: booleanProperty("Preview rows and runtime paths without deleting."),
            delete_runtime_files: booleanProperty("Delete controller-owned runtime files. Defaults to true.")
        }, ["run_id"]),
        schema: runPurgeSchema
    },
    {
        name: "maintenance_purge_old",
        description: "Purge old stopped runs and old unregistered agents.",
        inputSchema: objectSchema({
            older_than: stringProperty("Age threshold such as 30m, 12h, 7d, or raw milliseconds."),
            stop_first: booleanProperty("Attempt graceful stop before purging active agents."),
            force: booleanProperty("Allow purge even if selected agents remain active."),
            dry_run: booleanProperty("Preview rows and runtime paths without deleting."),
            delete_runtime_files: booleanProperty("Delete controller-owned runtime files. Defaults to true.")
        }, ["older_than"]),
        schema: maintenancePurgeOldSchema
    },
    {
        name: "artifact_register",
        description: "Register an artifact path for event tracking.",
        inputSchema: objectSchema({
            run_id: stringProperty("Optional run id."),
            agent_id: stringProperty("Optional agent id."),
            label: stringProperty("Artifact label."),
            path: stringProperty("Artifact path."),
            expected: booleanProperty("Whether the artifact is expected.")
        }, ["label", "path"]),
        schema: artifactRegisterSchema
    },
    {
        name: "artifact_read_header",
        description: "Read only the first lines of an artifact.",
        inputSchema: objectSchema({
            path: stringProperty("Artifact path."),
            lines: numberProperty("Maximum header lines.")
        }, ["path"]),
        schema: artifactReadHeaderSchema
    }
];
