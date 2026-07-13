import { AGENT_LINK_TYPES, AGENT_STATUSES, EVENT_TYPES, FLOW_STEP_INSTANCE_STATUSES } from "../core/types.js";
import { agentLinkCreateSchema, agentLinkDeleteSchema, agentLinkListSchema, agentIdSchema, agentListSchema, agentReadLatestSchema, agentRegisterSchema, agentPurgeSchema, agentSendSchema, agentStartSchema, agentStopSchema, agentWaitSchema, artifactReadHeaderSchema, artifactRegisterSchema, emptySchema, eventListSchema, flowCatalogGetSchema, flowCatalogListSchema, flowContinueSchema, flowDispatchActiveSchema, flowGetSchema, flowStartSchema, flowStepReportSchema, flowStepStartSchema, flowValidateConfigSchema, goalGetSchema, goalRegisterSchema, goalUpdateSchema, goalWaitConfirmationSchema, heartbeatCreateSchema, heartbeatDeleteSchema, heartbeatListSchema, maintenancePurgeOldSchema, orchestratorLoginSchema, runCreateSchema, runIdSchema, runListSchema, runPurgeSchema, subscriptionCreateSchema, subscriptionDeleteSchema, subscriptionListSchema, subscriptionWaitSchema } from "./schemas.js";
import { booleanProperty, enumProperty, numberProperty, objectSchema, stringArrayProperty, stringProperty } from "./json-schema.js";
export const TOOL_DEFINITIONS = [
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
        description: "List flow configs from Agent Control's bundled and user flow catalogs. Bundled flows come from the repository flows directory; user flows default to ~/.agent-control/flows.",
        inputSchema: objectSchema({
            query: stringProperty("Optional case-insensitive filter over flow id, directory, description, version, or path.")
        }),
        schema: flowCatalogListSchema
    },
    {
        name: "flow_catalog_get",
        description: "Resolve one flow from Agent Control's default catalog by flow id or directory name and return its config path plus loaded config.",
        inputSchema: objectSchema({ flow_id: stringProperty("Flow id or flow directory name.") }, ["flow_id"]),
        schema: flowCatalogGetSchema
    },
    {
        name: "flow_start",
        description: "Create a flow instance, bind it to a run, and activate the initial step. This does not start backend workers by itself.",
        inputSchema: objectSchema({
            config: { type: "object", description: "Flow config object." },
            run_id: stringProperty("Existing run id. If omitted, a new run is created."),
            run_title: stringProperty("Title for a newly created run."),
            repo_dir: stringProperty("Repository directory for a newly created run."),
            admin_key: stringProperty("Admin key for creating a root run."),
            agent_token: stringProperty("Agent identity token. Creates a child run when run_id is omitted.")
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
        description: "Dispatch the active flow step to its configured backend worker, optionally subscribe an orchestrator to terminal events, and return immediately. This is the normal non-polling coordinator operation.",
        inputSchema: objectSchema({
            flow_instance_id: stringProperty("Flow instance id."),
            subscriber_agent_id: stringProperty("Agent to notify on worker terminal events."),
            server: stringProperty("Backend server URL for server-backed adapters."),
            agent_token: stringProperty("Optional agent identity token for the coordinator.")
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
            agent_token: stringProperty("Optional agent identity token for access checks.")
        }, ["flow_instance_id"]),
        schema: flowContinueSchema
    },
    {
        name: "flow_step_report",
        description: "Report the result of an active flow step. The controller validates result schema, required artifacts, selects the next transition, and auto-continues by default.",
        inputSchema: objectSchema({
            step_instance_id: stringProperty("Active flow step instance id."),
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
            from_step_instance_id: stringProperty("Optional previous step instance that led to this manual transition."),
            transition_id: stringProperty("Optional transition id to record."),
            reason: stringProperty("Optional compact reason for the manual transition.")
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
        description: "Stop active agents in a run and mark the run stopped.",
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
        description: "Start a registered agent through its backend.",
        inputSchema: objectSchema({
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
        description: "Send a compact message to an agent.",
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
        description: "Stop one agent, all agents in a run, or all registered agents.",
        inputSchema: objectSchema({
            agent_id: stringProperty("Agent id."),
            run_id: stringProperty("Run id."),
            all: booleanProperty("Stop all registered agents."),
            mode: enumProperty(["graceful", "interrupt", "kill"], "Stop mode.")
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
        description: "Block until a subscription's matching event exists, refreshing the source agent when possible. Use for explicit manual/debug waits or short opt-in foreground waits. Normal long-running orchestrators should use detached watchers/subscriptions.",
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
