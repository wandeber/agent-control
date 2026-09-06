#!/usr/bin/env node
import { Command } from "commander";
import { registerMarketplaceCommands } from "./cli/marketplace.js";
import { registerSmokeCommands } from "./cli/smoke.js";
import { collect, commanderExitInfo, outputError, parseIntOption, parseJsonObjectOption } from "./cli/shared.js";
import { registerWatchCommands, registerWorkerCommands, startDetachedWatch } from "./cli/worker.js";
import { addRequesterOptions, attachRequester, registerObservationCommands } from "./cli/observation.js";
import { registerWebCommands } from "./cli/web.js";
import { startControlServer } from "./control-server.js";
import { parseDurationMs } from "./core/duration.js";
import { prepareLaunchOwner } from "./core/launch-context.js";
import { createController } from "./core/factory.js";
import { flowConfigJsonSchema } from "./core/flow-config-schema.js";
import { loadFlowConfigFile, parseFlowConfigText } from "./core/flow-config-loader.js";
import { AGENT_CONTROL_ADMIN_KEY_ENV, AGENT_CONTROL_TOKEN_ENV, resolveAdminKey } from "./core/identity.js";
const { controller, store, credentialStore } = createController();
const program = new Command();
program
    .name("agentctl")
    .description("Control local agent workers through the Agent Control core.")
    .version("0.1.7")
    .option("--token <token>", "Agent identity token. Defaults to AGENT_CONTROL_TOKEN.")
    .option("--admin-key <key>", "Agent Control admin key for root/orchestrator operations.");
program.exitOverride();
program.configureOutput({
    outputError: () => undefined
});
program
    .command("backend:list")
    .description("List registered backend adapters.")
    .action(() => output(controller.listBackends()));
const cliDeps = { controller, output, authOptions };
registerWorkerCommands(program, cliDeps);
registerWatchCommands(program, cliDeps);
registerSmokeCommands(program, cliDeps);
registerMarketplaceCommands(program, output);
const auth = program.command("auth").description("Authenticate Agent Control orchestrators.");
auth
    .command("login")
    .requiredOption("--title <title>", "Orchestrator and root run title.")
    .option("--run-title <title>", "Root run title when it should differ from the orchestrator title.")
    .option("--repo-dir <dir>", "Repository directory.")
    .option("--run <runId>", "Existing run id to attach to.")
    .option("--backend <backend>", "Orchestrator backend.", "codex-thread")
    .option("--objective <objective>", "Orchestrator objective.")
    .option("--model <model>", "Model name.")
    .option("--backend-handle-json <json>", "Backend handle JSON for attaching/registering an existing participant.")
    .action((options) => {
    const adminKey = authOptions({ allowStoredAdminKey: true }).adminKey;
    if (!adminKey) {
        throw new Error("auth login requires --admin-key or AGENT_CONTROL_ADMIN_KEY.");
    }
    output(controller.orchestratorLogin({
        adminKey,
        title: options.title,
        runTitle: options.runTitle,
        repoDir: options.repoDir,
        runId: options.run,
        backend: options.backend,
        objective: options.objective,
        model: options.model,
        backendHandle: options.backendHandleJson ? parseJsonObjectOption(options.backendHandleJson) : undefined
    }));
});
auth
    .command("whoami")
    .description("Resolve the current AGENT_CONTROL_TOKEN or --token to its agent.")
    .action(() => {
    const token = authOptions().agentToken;
    if (!token) {
        throw new Error("auth whoami requires --token or AGENT_CONTROL_TOKEN.");
    }
    output(controller.requireAgentToken(token));
});
const run = program.command("run").description("Manage controller runs.");
registerObservationCommands(run, cliDeps);
run
    .command("create")
    .requiredOption("--title <title>", "Run title.")
    .option("--repo-dir <dir>", "Repository directory.")
    .action((options) => {
    const auth = authOptions();
    if (!auth.adminKey && !auth.agentToken) {
        throw new Error("run create requires --admin-key, --token, AGENT_CONTROL_ADMIN_KEY, or AGENT_CONTROL_TOKEN.");
    }
    output(controller.createRun({
        title: options.title,
        repoDir: options.repoDir,
        adminKey: auth.adminKey,
        agentToken: auth.agentToken
    }));
});
run
    .command("list")
    .option("--limit <n>", "Maximum number of runs.", parseIntOption)
    .action((options) => output(controller.listRuns(options.limit, { agentToken: authOptions().agentToken })));
run
    .command("get")
    .requiredOption("--run <runId>", "Run id.")
    .action((options) => output(controller.getRun(options.run, { agentToken: authOptions().agentToken })));
run
    .command("shutdown")
    .requiredOption("--run <runId>", "Run id.")
    .action(async (options) => output(await controller.shutdownRun(options.run)));
run
    .command("purge")
    .requiredOption("--run <runId>", "Run id.")
    .option("--dry-run", "Preview rows and runtime paths without deleting.")
    .option("--stop-first", "Attempt graceful stop before purging active agents.")
    .option("--force", "Allow purge even if agents remain active.")
    .option("--keep-runtime-files", "Keep controller-owned runtime files.")
    .action(async (options) => {
    const result = await controller.runPurge(options.run, {
        dryRun: Boolean(options.dryRun),
        stopFirst: Boolean(options.stopFirst),
        force: Boolean(options.force),
        deleteRuntimeFiles: !options.keepRuntimeFiles
    });
    output(result);
});
const flow = program.command("flow").description("Manage declarative flow instances.");
const flowCatalog = flow.command("catalog").description("Discover flow configs from Agent Control catalogs.");
flowCatalog
    .command("list")
    .description("List flow configs from the default repository flow catalog.")
    .option("--query <query>", "Case-insensitive filter over flow id, directory, description, version, or path.")
    .action((options) => output(controller.listFlowCatalog({ query: options.query })));
flowCatalog
    .command("get")
    .description("Resolve one catalog flow by flow id or directory name.")
    .requiredOption("--flow <flowId>", "Flow id or flow directory name.")
    .action((options) => output(controller.getFlowFromCatalog({ flowId: options.flow })));
flow
    .command("validate")
    .description("Validate a JSON or YAML flow config without creating a run or flow instance.")
    .option("--config-file <path>", "Read flow config JSON/YAML from this file.")
    .option("--config-json <json>", "Flow config JSON object.")
    .option("--config-yaml <yaml>", "Flow config YAML object.")
    .option("--config-stdin", "Read flow config JSON/YAML from stdin.")
    .action(async (options) => {
    output(controller.validateFlowConfig(await readConfigOption(options)));
});
flow
    .command("schema")
    .description("Print the Agent Control flow config JSON Schema.")
    .action(() => output(flowConfigJsonSchema));
addRequesterOptions(flow
    .command("start"))
    .description("Create a flow instance and activate its initial step.")
    .option("--config-file <path>", "Read flow config JSON/YAML from this file.")
    .option("--config-json <json>", "Flow config JSON object.")
    .option("--config-yaml <yaml>", "Flow config YAML object.")
    .option("--config-stdin", "Read flow config JSON/YAML from stdin.")
    .option("--run <runId>", "Existing run id. If omitted, a new run is created.")
    .option("--run-title <title>", "Title for a newly created run.")
    .option("--repo-dir <dir>", "Repository directory for a newly created run.")
    .option("--owner-task-identity <id>", "Optional root CODEX_THREAD_ID binding for a native bridge grant.")
    .option("--owner-task-path <path>", "Canonical root task path for native subagent actions.", "/root")
    .option("--compact", "Print only ids and active step summary.")
    .action(async (options) => {
    const auth = authOptions({ allowStoredAdminKey: true });
    if (!auth.adminKey && !auth.agentToken) {
        throw new Error("flow start requires --admin-key, --token, AGENT_CONTROL_ADMIN_KEY, or AGENT_CONTROL_TOKEN.");
    }
    credentialStore.assertReady();
    const result = controller.startFlow({
        config: await readConfigOption(options),
        requesterThreadId: options.requesterThreadId, requesterEventTypes: options.requesterEvent?.length ? options.requesterEvent : undefined, requesterDelivery: options.requesterDelivery,
        runId: options.run,
        runTitle: options.runTitle,
        repoDir: options.repoDir,
        adminKey: auth.adminKey,
        agentToken: auth.agentToken,
        ownerTaskIdentity: resolveOwnerTaskIdentity(options.ownerTaskIdentity),
        ownerTaskPath: options.ownerTaskPath,
        bridgeCredentialDelivery: "local"
    });
    const bridgeGrant = result.bridge_grant ?? null;
    output(options.compact
        ? compactFlowStartResult(result, bridgeGrant)
        : publicFlowStartResult(result, bridgeGrant));
});
addRequesterOptions(flow
    .command("launch"))
    .description("Authenticate a local orchestrator, start or resume a flow, dispatch the active step, and return.")
    .requiredOption("--config-file <path>", "Read flow config JSON/YAML from this file.")
    .requiredOption("--title <title>", "Run title/objective. This is passed to workers through the runtime contract.")
    .option("--run <runId>", "Existing run id to resume.")
    .option("--repo-dir <dir>", "Repository directory for the run.", process.cwd())
    .option("--orchestrator-title <title>", "Registered orchestrator title.")
    .option("--orchestrator-backend <backend>", "Registered orchestrator backend.", "codex-thread")
    .option("--orchestrator-thread-id <threadId>", "Codex thread id for attaching the visible coordinator.")
    .option("--orchestrator-backend-handle-json <json>", "Explicit orchestrator backend handle JSON.")
    .option("--owner-task-identity <id>", "Optional root CODEX_THREAD_ID binding for the native bridge.")
    .option("--owner-task-path <path>", "Canonical root task path for native subagent actions.", "/root")
    .option("--server <url>", "Optional backend server URL; otherwise use the selected adapter default.")
    .option("--ui-host <host>", "Web console host for the returned ui_url.", "localhost")
    .option("--ui-port <port>", "Web console port for the returned ui_url.", parseIntOption, 3766)
    .option("--ui-api-port <port>", "Web console API port for the returned ui_url.", parseIntOption, 3767)
    .action(async (options) => {
    const launchAuth = authOptions({ allowStoredAdminKey: true });
    const adminKey = launchAuth.adminKey;
    if (!adminKey) {
        throw new Error("flow launch requires --admin-key, AGENT_CONTROL_ADMIN_KEY, or a local stored admin key.");
    }
    credentialStore.assertReady();
    const repoDir = options.repoDir ?? process.cwd();
    const backendHandle = resolveLaunchOrchestratorBackendHandle({ ...options, repoDir });
    const config = await readConfigOption({ configFile: options.configFile });
    controller.validateFlowConfig(config);
    const explicitCoordinator = options.orchestratorThreadId || options.orchestratorBackendHandleJson || options.orchestratorBackend !== "codex-thread";
    const automatic = explicitCoordinator ? null : prepareLaunchOwner(controller, { title: options.title, repoDir,
        runId: options.run, agentToken: launchAuth.agentToken, adminKey, requesterThreadId: options.requesterThreadId });
    const login = automatic ? { agent: automatic.agent, agent_token: automatic.agentToken, run: controller.getRun(automatic.runId) } : controller.orchestratorLogin({
        adminKey,
        title: options.orchestratorTitle ?? `${options.title} orchestrator`,
        runTitle: options.title,
        runId: options.run,
        repoDir,
        backend: options.orchestratorBackend,
        objective: options.title,
        backendHandle
    });
    const observer = attachRequester(login.run.run_id, options, cliDeps, login.agent_token);
    const start = controller.startFlow({
        config,
        runId: login.run.run_id,
        agentToken: login.agent_token,
        ownerTaskIdentity: resolveOwnerTaskIdentity(options.ownerTaskIdentity),
        ownerTaskPath: options.ownerTaskPath,
        bridgeCredentialDelivery: "local"
    });
    const bridgeGrant = start.bridge_grant ?? null;
    const bridgeToken = bridgeGrant
        ? credentialStore.resolveBridgeToken({
            bridgeGrantId: bridgeGrant.bridge_grant_id,
            runId: login.run.run_id,
            orchestratorAgentId: login.agent.agent_id,
            ownerTaskIdentity: resolveOwnerTaskIdentity(options.ownerTaskIdentity),
            ownerTaskPath: options.ownerTaskPath ?? "/root"
        })
        : null;
    const continuation = start.active_step
        ? await controller.continueFlow({
            flowInstanceId: start.instance.flow_instance_id,
            server: options.server,
            agentToken: bridgeToken ? undefined : login.agent_token,
            bridgeToken: bridgeToken ?? undefined
        })
        : null;
    const worker = continuation?.agent;
    const watch = worker && continuation?.action === "dispatched" && worker.backend !== "codex-subagent"
        ? { detached_watcher: true, ...startDetachedWatch({ target: { kind: "flow", flowInstanceId: start.instance.flow_instance_id }, timeoutMs: 3_600_000, intervalMs: 5000 }) } : null;
    output({ ...compactFlowLaunchResult({
            runId: login.run.run_id,
            runTitle: login.run.title,
            orchestratorAgentId: login.agent.agent_id,
            observer,
            start,
            continuation,
            bridgeGrant,
            uiHost: options.uiHost,
            uiPort: options.uiPort,
            uiApiPort: options.uiApiPort
        }), watch });
});
flow
    .command("get")
    .description("Get the current flow snapshot.")
    .requiredOption("--flow <flowInstanceId>", "Flow instance id.")
    .action((options) => output(controller.getFlowSnapshot(options.flow)));
flow
    .command("dispatch-active")
    .description("Dispatch the active flow step to its configured backend worker and return immediately.")
    .requiredOption("--flow <flowInstanceId>", "Flow instance id.")
    .option("--subscriber-agent <agentId>", "Agent to notify on worker terminal events.")
    .option("--server <url>", "Optional backend server URL; otherwise use the selected adapter default.")
    .option("--bridge-grant <grantId>", "Local scoped bridge grant id returned by flow start/launch.")
    .option("--owner-task-path <path>", "Canonical root task path for native subagent actions.", "/root")
    .action(async (options) => {
    const auth = authOptions();
    const bridgeToken = resolveBridgeTokenForFlow(options.flow, options.bridgeGrant, options.ownerTaskPath ?? "/root");
    if (!auth.agentToken && !bridgeToken && !options.subscriberAgent) {
        throw new Error("flow dispatch-active requires --token, --bridge-grant, or --subscriber-agent.");
    }
    output(await controller.dispatchActiveFlowStep({
        flowInstanceId: options.flow,
        subscriberAgentId: options.subscriberAgent,
        server: options.server,
        agentToken: auth.agentToken ?? undefined,
        bridgeToken
    }));
});
flow
    .command("continue")
    .description("Advance a flow deterministically and return immediately.")
    .requiredOption("--flow <flowInstanceId>", "Flow instance id.")
    .option("--subscriber-agent <agentId>", "Optional agent to notify on dispatched worker terminal events.")
    .option("--server <url>", "Optional backend server URL; otherwise use the selected adapter default.")
    .option("--bridge-grant <grantId>", "Local scoped bridge grant id returned by flow start/launch.")
    .option("--owner-task-path <path>", "Canonical root task path for native subagent actions.", "/root")
    .action(async (options) => {
    const auth = authOptions();
    const bridgeToken = resolveBridgeTokenForFlow(options.flow, options.bridgeGrant, options.ownerTaskPath ?? "/root");
    output(await controller.continueFlow({
        flowInstanceId: options.flow,
        subscriberAgentId: options.subscriberAgent,
        server: options.server,
        agentToken: auth.agentToken ?? undefined,
        bridgeToken
    }));
});
flow
    .command("start-step")
    .description("Manually activate a configured flow step after an orchestrator decision.")
    .requiredOption("--flow <flowInstanceId>", "Flow instance id.")
    .requiredOption("--step-id <stepId>", "Configured step id to activate.")
    .option("--from-step <stepInstanceId>", "Previous step instance that led to this manual transition.")
    .option("--transition-id <transitionId>", "Transition id to record.")
    .option("--reason <reason>", "Coordinator context and reason delivered to the manually activated step.")
    .action(async (options) => output(await controller.startFlowStep({
    flowInstanceId: options.flow,
    stepId: options.stepId,
    fromStepInstanceId: options.fromStep,
    transitionId: options.transitionId,
    reason: options.reason
})));
flow
    .command("report")
    .description("Report the result of an active flow step and auto-continue by default.")
    .requiredOption("--step <stepInstanceId>", "Flow step instance id.")
    .requiredOption("--status <status>", "completed, blocked, failed, cancelled, or active.")
    .option("--result-json <json>", "Structured result JSON object.")
    .option("--artifact <key=path>", "Output artifact path by output name or artifact key.", collect, [])
    .option("--summary <summary>", "Compact step summary.")
    .option("--server <url>", "Optional backend server URL when auto-continuing.")
    .option("--no-auto-continue", "Do not dispatch the next active step after reporting.")
    .action(async (options) => output(compactFlowReportResult(await controller.reportFlowStepAndContinue({
    stepInstanceId: options.step,
    status: options.status,
    result: options.resultJson ? parseJsonObjectOption(options.resultJson) : undefined,
    artifacts: parseKeyValueList(options.artifact),
    summary: options.summary,
    server: options.server,
    autoContinue: options.autoContinue
}))));
const action = program.command("action").description("Execute scoped root-bridge actions.");
action
    .command("claim")
    .requiredOption("--action <actionId>", "Orchestrator action id.")
    .option("--bridge-grant <grantId>", "Explicit local scoped bridge grant id.")
    .option("--owner-task-path <path>", "Canonical root task path for native subagent actions.", "/root")
    .action((options) => {
    const actionRef = controller.getOrchestratorActionRef(options.action);
    const result = controller.claimOrchestratorAction({
        actionId: options.action,
        bridgeToken: credentialStore.resolveBridgeToken({
            bridgeGrantId: options.bridgeGrant,
            runId: actionRef.run_id,
            orchestratorAgentId: actionRef.orchestrator_agent_id,
            ownerTaskIdentity: resolveOwnerTaskIdentity(),
            ownerTaskPath: options.ownerTaskPath ?? "/root"
        })
    });
    if (!("action_token" in result)) {
        output(result);
        return;
    }
    const actionRecord = store.getOrchestratorAction(result.action_id);
    if (!actionRecord) {
        throw new Error("Claimed orchestrator action disappeared before local persistence.");
    }
    const actionClaim = credentialStore.persistActionClaim(result, actionRecord);
    output(publicActionClaimResult(result, actionClaim));
});
action
    .command("ack")
    .requiredOption("--action <actionId>", "Claimed orchestrator action id.")
    .option("--action-token <token>", "Explicit action token; normally resolved from the local action-claim ref.")
    .requiredOption("--status <status>", "succeeded or failed.")
    .option("--result-json <json>", "Structured non-secret native result JSON.")
    .option("--error-json <json>", "Structured native failure JSON.")
    .action((options) => {
    if (options.status !== "succeeded" && options.status !== "failed") {
        throw new Error("action ack --status must be succeeded or failed.");
    }
    const actionRef = controller.getOrchestratorActionRef(options.action);
    output(controller.acknowledgeOrchestratorAction({
        actionId: options.action,
        actionToken: options.actionToken ??
            credentialStore.resolveActionToken({
                actionId: options.action,
                runId: actionRef.run_id,
                orchestratorAgentId: actionRef.orchestrator_agent_id
            }),
        status: options.status,
        result: options.resultJson ? parseJsonObjectOption(options.resultJson) : undefined,
        error: options.errorJson ? parseJsonObjectOption(options.errorJson) : undefined
    }));
});
const agent = program.command("agent").description("Manage agents.");
agent
    .command("register")
    .option("--run <runId>", "Run id. Defaults to caller run when --token or AGENT_CONTROL_TOKEN is set.")
    .requiredOption("--backend <backend>", "Backend kind.")
    .requiredOption("--title <title>", "Agent title.")
    .option("--role <role>", "Agent role.")
    .option("--objective <objective>", "Agent objective.")
    .option("--repo-dir <dir>", "Repository directory.")
    .option("--model <model>", "Backend model.")
    .option("--status <status>", "Initial normalized status.")
    .option("--backend-handle-json <json>", "Backend handle JSON for attaching/registering an existing participant.")
    .action((options) => {
    const auth = authOptions();
    if (!auth.adminKey && !auth.agentToken) {
        throw new Error("agent register requires --admin-key, --token, AGENT_CONTROL_ADMIN_KEY, or AGENT_CONTROL_TOKEN.");
    }
    output(controller.registerAgent({
        runId: options.run,
        backend: options.backend,
        title: options.title,
        role: options.role,
        objective: options.objective,
        repoDir: options.repoDir,
        model: options.model,
        status: options.status,
        backendHandle: options.backendHandleJson ? parseJsonObjectOption(options.backendHandleJson) : undefined,
        adminKey: auth.adminKey,
        agentToken: auth.agentToken
    }));
});
addRequesterOptions(agent
    .command("start"))
    .requiredOption("--agent <agentId>", "Agent id.")
    .option("--prompt <prompt>", "Prompt text.")
    .option("--prompt-file <path>", "Read prompt text from this file.")
    .option("--prompt-stdin", "Read prompt text from stdin.")
    .option("--server <url>", "Backend server URL.")
    .option("--model <model>", "Model override.")
    .option("--expected-artifact <path>", "Expected artifact path.", collect, [])
    .option("--attachment <path>", "Attachment path.", collect, [])
    .action(async (options) => {
    if ([options.prompt, options.promptFile, options.promptStdin].filter(Boolean).length > 1) {
        throw new Error("Use only one prompt source: --prompt, --prompt-file, or --prompt-stdin.");
    }
    const prompt = options.promptStdin
        ? await readStdin()
        : options.promptFile
            ? await import("node:fs").then((fs) => fs.readFileSync(options.promptFile, "utf8"))
            : options.prompt;
    output(await controller.startAgent({
        agentId: options.agent,
        requesterThreadId: options.requesterThreadId, requesterEventTypes: options.requesterEvent?.length ? options.requesterEvent : undefined, requesterDelivery: options.requesterDelivery,
        prompt,
        server: options.server,
        model: options.model,
        expectedArtifacts: options.expectedArtifact,
        attachments: options.attachment,
        agentToken: authOptions().agentToken
    }));
});
agent
    .command("wait")
    .description("Block until one agent reaches a terminal status, refreshing status cheaply.")
    .requiredOption("--agent <agentId>", "Agent id.")
    .option("--interval-ms <ms>", "Refresh interval.", parseIntOption, 5000)
    .option("--timeout <duration>", "Timeout such as 30m, 12h, or raw milliseconds.")
    .option("--timeout-ms <ms>", "Timeout in milliseconds.", parseIntOption)
    .option("--allow-blocking-wait", "Allow this foreground process to block while waiting.")
    .action(async (options) => {
    assertBlockingWaitAllowed(options.allowBlockingWait);
    output(await controller.waitForAgentTerminal(options.agent, {
        intervalMs: options.intervalMs,
        timeoutMs: options.timeoutMs ?? (options.timeout ? parseDurationMs(options.timeout) : undefined)
    }));
});
agent
    .command("list")
    .option("--run <runId>", "Run id.")
    .option("--include-unregistered", "Include unregistered agents.")
    .action((options) => output(controller.listAgents({ runId: options.run, includeUnregistered: options.includeUnregistered })));
agent
    .command("get")
    .requiredOption("--agent <agentId>", "Agent id.")
    .action((options) => output(controller.getAgent(options.agent)));
agent
    .command("status")
    .requiredOption("--agent <agentId>", "Agent id.")
    .action(async (options) => output(await controller.refreshAgentStatus(options.agent)));
agent
    .command("send")
    .requiredOption("--agent <agentId>", "Agent id.")
    .requiredOption("--message <message>", "Message text.")
    .action(async (options) => output(await controller.sendMessage(options.agent, options.message)));
agent
    .command("external-sync")
    .description("Synchronize one codex-subagent card from root-owned subagent v2 state.")
    .requiredOption("--agent <agentId>", "Agent Control agent id.")
    .option("--bridge-grant <grantId>", "Explicit local scoped bridge grant id.")
    .option("--owner-task-path <path>", "Canonical root task path for native subagent actions.", "/root")
    .requiredOption("--native-status <status>", "pending_init, running, completed, interrupted, shutdown, errored, or missing.")
    .option("--native-agent-id <id>", "Native Codex subagent id.")
    .option("--native-task-name <name>", "Native task name.")
    .option("--native-task-path <path>", "Canonical native task path.")
    .option("--latest-message <message>", "Private latest message, limited to 4 KiB.")
    .option("--public-activity-json <json>", "Explicit short public card activity: kind, text, optional state and observed_at.")
    .option("--observed-at <timestamp>", "Observation timestamp.")
    .option("--confirmed-absent", "Confirm exact absence after the recovery delay.")
    .action((options) => {
    const scope = controller.getCodexSubagentBridgeScope(options.agent);
    output(controller.syncCodexSubagent({
        agentId: options.agent,
        bridgeToken: credentialStore.resolveBridgeToken({
            bridgeGrantId: options.bridgeGrant,
            runId: scope.run_id,
            orchestratorAgentId: scope.orchestrator_agent_id,
            ownerTaskIdentity: resolveOwnerTaskIdentity(),
            ownerTaskPath: options.ownerTaskPath ?? "/root"
        }),
        nativeAgentId: options.nativeAgentId,
        nativeTaskName: options.nativeTaskName,
        nativeTaskPath: options.nativeTaskPath,
        nativeStatus: options.nativeStatus,
        latestMessage: options.latestMessage,
        publicActivity: options.publicActivityJson ? parseJsonObjectOption(options.publicActivityJson) : undefined,
        observedAt: options.observedAt,
        confirmedAbsent: options.confirmedAbsent
    }));
});
agent
    .command("read-latest")
    .requiredOption("--agent <agentId>", "Agent id.")
    .option("--limit <n>", "Maximum messages.", parseIntOption)
    .action(async (options) => output(await controller.readLatest(options.agent, options.limit ?? 1)));
agent
    .command("stop")
    .option("--agent <agentId>", "Agent id.")
    .option("--run <runId>", "Run id.")
    .option("--all", "Stop all agents.")
    .option("--mode <mode>", "graceful, interrupt, or kill.", "graceful")
    .action(async (options) => {
    if (options.agent) {
        output(await controller.stopAgent(options.agent, options.mode));
        return;
    }
    output(await controller.stopAgents({ runId: options.run, mode: options.mode }));
});
agent
    .command("unregister")
    .option("--agent <agentId>", "Agent id.")
    .option("--run <runId>", "Run id.")
    .option("--all", "Unregister all agents.")
    .action(async (options) => {
    if (options.agent) {
        output(await controller.unregisterAgent(options.agent));
        return;
    }
    output(await controller.unregisterAgents({ runId: options.run }));
});
agent
    .command("purge")
    .requiredOption("--agent <agentId>", "Agent id.")
    .option("--dry-run", "Preview rows and runtime paths without deleting.")
    .option("--stop-first", "Attempt graceful stop before purging an active agent.")
    .option("--force", "Allow purge even if the agent remains active.")
    .option("--keep-runtime-files", "Keep controller-owned runtime files.")
    .action(async (options) => output(await controller.agentPurge(options.agent, {
    dryRun: Boolean(options.dryRun),
    stopFirst: Boolean(options.stopFirst),
    force: Boolean(options.force),
    deleteRuntimeFiles: !options.keepRuntimeFiles
})));
const subscription = program.command("sub").description("Manage subscriptions.");
subscription
    .command("create")
    .option("--subscriber <agentId>", "Subscriber agent id. Defaults to caller when --token or AGENT_CONTROL_TOKEN is set.")
    .requiredOption("--on <eventType>", "Event type.")
    .option("--from <agentId>", "Source agent id.")
    .option("--run <runId>", "Run id.")
    .action((options) => {
    const caller = authOptions().agentToken ? controller.requireAgentToken(authOptions().agentToken) : null;
    if (!options.subscriber && !caller) {
        throw new Error("sub create requires --subscriber or --token/AGENT_CONTROL_TOKEN.");
    }
    output(controller.createSubscription({
        subscriberAgentId: options.subscriber ?? caller.agent_id,
        eventType: options.on,
        sourceAgentId: options.from,
        runId: options.run ?? caller?.run_id
    }));
});
subscription
    .command("list")
    .option("--run <runId>", "Run id.")
    .option("--enabled-only", "Only enabled subscriptions.")
    .action((options) => {
    const caller = authOptions().agentToken ? controller.requireAgentToken(authOptions().agentToken) : null;
    output(controller.listSubscriptions({ runId: options.run ?? caller?.run_id, enabledOnly: options.enabledOnly }));
});
subscription
    .command("delete")
    .requiredOption("--subscription <subscriptionId>", "Subscription id.")
    .action((options) => output(controller.deleteSubscription(options.subscription)));
subscription
    .command("wait")
    .description("Block until a subscription's matching event exists, refreshing the source agent when possible.")
    .requiredOption("--subscription <subscriptionId>", "Subscription id.")
    .option("--interval-ms <ms>", "Refresh interval.", parseIntOption, 5000)
    .option("--timeout <duration>", "Timeout such as 30m, 12h, or raw milliseconds.")
    .option("--timeout-ms <ms>", "Timeout in milliseconds.", parseIntOption)
    .option("--allow-blocking-wait", "Allow this foreground process to block while waiting.")
    .action(async (options) => {
    assertBlockingWaitAllowed(options.allowBlockingWait);
    output(await controller.waitForSubscriptionEvent(options.subscription, {
        intervalMs: options.intervalMs,
        timeoutMs: options.timeoutMs ?? (options.timeout ? parseDurationMs(options.timeout) : undefined)
    }));
});
const link = program.command("link").description("Manage visual relationships between agents.");
link
    .command("create")
    .option("--run <runId>", "Run id. Defaults to caller run when --token or AGENT_CONTROL_TOKEN is set.")
    .requiredOption("--source <agentId>", "Source agent id.")
    .requiredOption("--target <agentId>", "Target agent id.")
    .requiredOption("--type <type>", "parent_child, waits_for, subscribed_to, blocks, or handoff.")
    .option("--label <label>", "Optional label.")
    .action((options) => {
    const caller = authOptions().agentToken ? controller.requireAgentToken(authOptions().agentToken) : null;
    if (!options.run && !caller) {
        throw new Error("link create requires --run or --token/AGENT_CONTROL_TOKEN.");
    }
    output(controller.createAgentLink({
        runId: options.run ?? caller.run_id,
        sourceAgentId: options.source,
        targetAgentId: options.target,
        type: options.type,
        label: options.label
    }));
});
link
    .command("list")
    .option("--run <runId>", "Run id.")
    .option("--agent <agentId>", "Agent id.")
    .action((options) => {
    const caller = authOptions().agentToken ? controller.requireAgentToken(authOptions().agentToken) : null;
    output(controller.listAgentLinks({ runId: options.run ?? caller?.run_id, agentId: options.agent }));
});
link
    .command("delete")
    .requiredOption("--link <linkId>", "Link id.")
    .action((options) => output(controller.deleteAgentLink(options.link)));
const heartbeat = program.command("heartbeat").description("Manage heartbeats.");
heartbeat
    .command("create")
    .requiredOption("--agent <agentId>", "Agent id.")
    .requiredOption("--idle-timeout-ms <ms>", "Idle timeout.", parseIntOption)
    .option("--reminder-interval-ms <ms>", "Reminder interval.", parseIntOption)
    .action((options) => output(controller.createHeartbeat({
    agentId: options.agent,
    idleTimeoutMs: options.idleTimeoutMs,
    reminderIntervalMs: options.reminderIntervalMs
})));
heartbeat
    .command("list")
    .option("--agent <agentId>", "Agent id.")
    .action((options) => output(controller.listHeartbeats(options.agent)));
heartbeat
    .command("delete")
    .requiredOption("--heartbeat <heartbeatId>", "Heartbeat id.")
    .action((options) => output(controller.deleteHeartbeat(options.heartbeat)));
const goal = program.command("goal").description("Manage goals.");
goal
    .command("register")
    .option("--agent <agentId>", "Agent id. Defaults to caller when --token or AGENT_CONTROL_TOKEN is set.")
    .requiredOption("--objective <objective>", "Goal objective.")
    .action((options) => {
    const caller = authOptions().agentToken ? controller.requireAgentToken(authOptions().agentToken) : null;
    if (!options.agent && !caller) {
        throw new Error("goal register requires --agent or --token/AGENT_CONTROL_TOKEN.");
    }
    output(controller.createGoal({ agentId: options.agent ?? caller.agent_id, objective: options.objective }));
});
goal
    .command("get")
    .requiredOption("--goal <goalId>", "Goal id.")
    .action((options) => output(controller.getGoal(options.goal)));
goal
    .command("confirm")
    .requiredOption("--goal <goalId>", "Goal id.")
    .option("--no-defer-while-descendants-running", "Ask for confirmation immediately even when child agents are still active.")
    .action(async (options) => output(await controller.confirmGoal(options.goal, {
    deferWhileDescendantsRunning: options.deferWhileDescendantsRunning
})));
goal
    .command("wait-confirm")
    .requiredOption("--goal <goalId>", "Goal id.")
    .option("--interval-ms <ms>", "Refresh interval.", parseIntOption, 5000)
    .option("--timeout <duration>", "Timeout such as 30m, 12h, or raw milliseconds.")
    .option("--timeout-ms <ms>", "Timeout in milliseconds.", parseIntOption)
    .option("--allow-blocking-wait", "Allow this foreground process to block while waiting.")
    .action(async (options) => {
    assertBlockingWaitAllowed(options.allowBlockingWait);
    output(await controller.waitForGoalConfirmation(options.goal, {
        intervalMs: options.intervalMs,
        timeoutMs: options.timeoutMs ?? (options.timeout ? parseDurationMs(options.timeout) : undefined)
    }));
});
goal
    .command("update")
    .requiredOption("--goal <goalId>", "Goal id.")
    .requiredOption("--status <status>", "Goal status.")
    .action((options) => output(controller.updateGoal(options.goal, options.status)));
goal
    .command("unregister")
    .requiredOption("--goal <goalId>", "Goal id.")
    .action((options) => output(controller.deleteGoal(options.goal)));
const usage = program.command("usage").description("Manage optional agent usage snapshots.");
usage
    .command("record")
    .requiredOption("--run <runId>", "Run id.")
    .requiredOption("--agent <agentId>", "Agent id.")
    .option("--input-tokens <n>", "Input tokens.", parseIntOption)
    .option("--output-tokens <n>", "Output tokens.", parseIntOption)
    .option("--total-tokens <n>", "Total tokens.", parseIntOption)
    .option("--context-used <n>", "Context tokens used.", parseIntOption)
    .option("--context-limit <n>", "Context token limit.", parseIntOption)
    .option("--source <source>", "Metric source.")
    .option("--model <model>", "Model name.")
    .action((options) => output(controller.createUsageSnapshot({
    runId: options.run,
    agentId: options.agent,
    inputTokens: options.inputTokens,
    outputTokens: options.outputTokens,
    totalTokens: options.totalTokens,
    contextUsed: options.contextUsed,
    contextLimit: options.contextLimit,
    source: options.source,
    model: options.model
})));
usage
    .command("list")
    .option("--run <runId>", "Run id.")
    .option("--agent <agentId>", "Agent id.")
    .option("--limit <n>", "Maximum snapshots.", parseIntOption)
    .action((options) => output(controller.listUsageSnapshots({ runId: options.run, agentId: options.agent, limit: options.limit })));
program
    .command("event:list")
    .option("--run <runId>", "Run id.")
    .option("--agent <agentId>", "Agent id.")
    .option("--type <eventType>", "Event type.")
    .option("--limit <n>", "Maximum events.", parseIntOption)
    .action((options) => output(controller.listEvents({ runId: options.run, agentId: options.agent, type: options.type, limit: options.limit })));
program
    .command("artifact:register")
    .requiredOption("--label <label>", "Artifact label.")
    .requiredOption("--path <path>", "Artifact path.")
    .option("--run <runId>", "Run id.")
    .option("--agent <agentId>", "Agent id.")
    .option("--expected", "Mark as expected.")
    .action((options) => output(controller.createArtifact({
    label: options.label,
    path: options.path,
    runId: options.run,
    agentId: options.agent,
    expected: options.expected
})));
program
    .command("artifact:read-header")
    .requiredOption("--path <path>", "Artifact path.")
    .option("--lines <n>", "Header lines.", parseIntOption)
    .action((options) => output(controller.readArtifactHeader(options.path, options.lines ?? 10)));
program
    .command("poll")
    .description("Refresh active agents and check heartbeats once.")
    .option("--run <runId>", "Run id.")
    .action(async (options) => output(await controller.pollActiveAgents(options.run)));
const server = program.command("server").description("Run the local Agent Control API and WebSocket server.");
server
    .command("start")
    .option("--host <host>", "Host to bind.", "localhost")
    .option("--port <port>", "Port to bind.", parseIntOption, 3766)
    .action(async (options) => {
    const running = await startControlServer({ host: options.host, port: options.port });
    console.error(`Agent Control API listening on http://${options.host}:${options.port}`);
    await new Promise((resolveShutdown) => {
        const stop = () => {
            void running.close().finally(resolveShutdown);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
});
registerWebCommands(program, output);
const maintenance = program.command("maintenance").description("Maintenance operations.");
maintenance
    .command("purge-old")
    .requiredOption("--older-than <duration>", "Age threshold such as 30m, 12h, 7d, or raw milliseconds.")
    .option("--dry-run", "Preview rows and runtime paths without deleting.")
    .option("--stop-first", "Attempt graceful stop before purging active agents.")
    .option("--force", "Allow purge even if selected agents remain active.")
    .option("--keep-runtime-files", "Keep controller-owned runtime files.")
    .action(async (options) => {
    const result = await controller.maintenancePurgeOld({
        olderThanMs: parseDurationMs(options.olderThan),
        dryRun: Boolean(options.dryRun),
        stopFirst: Boolean(options.stopFirst),
        force: Boolean(options.force),
        deleteRuntimeFiles: !options.keepRuntimeFiles
    });
    output(result);
});
program.hook("postAction", async () => {
    await controller.dispose();
    store.close();
});
program.parseAsync(process.argv).catch((error) => {
    const commanderExit = commanderExitInfo(error);
    void controller.dispose().finally(() => {
        store.close();
        if (commanderExit?.code === "commander.helpDisplayed" || commanderExit?.code === "commander.version") {
            process.exit(commanderExit.exitCode);
        }
        outputError(error);
        process.exit(commanderExit?.exitCode ?? 1);
    });
});
function authOptions(optionsOverride = {}) {
    const options = program.opts();
    const adminKey = options.adminKey ?? process.env[AGENT_CONTROL_ADMIN_KEY_ENV];
    return {
        agentToken: options.token ?? process.env[AGENT_CONTROL_TOKEN_ENV],
        adminKey: adminKey ?? (optionsOverride.allowStoredAdminKey ? resolveAdminKey() : undefined)
    };
}
function resolveOwnerTaskIdentity(explicitIdentity) {
    const normalized = (explicitIdentity ?? process.env.CODEX_THREAD_ID)?.trim();
    return normalized ? normalized : null;
}
function output(value) {
    console.log(JSON.stringify(value, null, 2));
}
function compactFlowStartResult(result, bridgeGrant) {
    return {
        observer: result.observer ?? null,
        flow_record_id: result.flow.flow_record_id,
        flow_id: result.flow.flow_id,
        flow_instance_id: result.instance.flow_instance_id,
        run_id: result.instance.run_id,
        status: result.instance.status,
        reused: Boolean(result.reused),
        active_step: result.active_step
            ? {
                step_instance_id: result.active_step.step_instance_id,
                step_id: result.active_step.step_id,
                status: result.active_step.status
            }
            : null,
        blocked_reason: result.blocked_reason,
        bridge_grant: bridgeGrant
    };
}
function publicFlowStartResult(result, bridgeGrant) {
    const { bridge_credential: _privateCredential, ...publicResult } = result;
    return { ...publicResult, bridge_grant: bridgeGrant };
}
function publicActionClaimResult(result, actionClaim) {
    const { action_token: _privateActionToken, ...publicResult } = result;
    return { ...publicResult, action_claim: actionClaim };
}
function resolveBridgeTokenForFlow(flowInstanceId, bridgeGrantId, ownerTaskPath) {
    const snapshot = controller.getFlowSnapshot(flowInstanceId);
    const orchestratorAgentId = snapshot.instance.orchestrator_agent_id;
    if (!orchestratorAgentId) {
        if (bridgeGrantId) {
            throw new Error("Flow instance has no orchestrator binding for the requested bridge grant.");
        }
        return null;
    }
    const binding = {
        runId: snapshot.instance.run_id,
        orchestratorAgentId,
        ownerTaskIdentity: resolveOwnerTaskIdentity(),
        ownerTaskPath
    };
    return bridgeGrantId
        ? credentialStore.resolveBridgeToken({ ...binding, bridgeGrantId })
        : credentialStore.findBridgeToken(binding);
}
function compactFlowLaunchResult(input) {
    const activeStep = input.continuation?.active_step ?? input.start.active_step ?? null;
    const agent = input.continuation?.agent ?? null;
    const next = flowLaunchNext(input.start, input.continuation);
    return {
        next,
        reason: flowLaunchReason(next, input.continuation),
        run_id: input.runId,
        run_title: input.runTitle,
        orchestrator_agent_id: input.orchestratorAgentId,
        observer: input.observer ?? null,
        flow_id: input.start.flow.flow_id,
        flow_record_id: input.start.flow.flow_record_id,
        flow_instance_id: input.start.instance.flow_instance_id,
        flow_status: input.continuation?.instance.status ?? input.start.instance.status,
        flow_reused: Boolean(input.start.reused),
        continuation_action: input.continuation?.action ?? null,
        bridge_grant: input.bridgeGrant,
        orchestrator_action: input.continuation?.orchestrator_action ?? null,
        active_step: activeStep
            ? {
                step_instance_id: activeStep.step_instance_id,
                step_id: activeStep.step_id,
                agent_id: activeStep.agent_id,
                status: activeStep.status
            }
            : null,
        worker_agent_id: agent?.agent_id ?? activeStep?.agent_id ?? null,
        dispatched_agent_id: input.continuation?.action === "dispatched" ? agent?.agent_id ?? null : null,
        agent: agent
            ? {
                agent_id: agent.agent_id,
                role: agent.role,
                status: agent.status,
                backend: agent.backend,
                model: agent.model
            }
            : null,
        expected_artifacts: input.continuation?.dispatch?.expected_artifacts ?? [],
        prompt_size: input.continuation?.dispatch?.prompt_size ?? null,
        watcher_id: null,
        blocked_reason: input.continuation?.blocked_reason ?? input.start.blocked_reason,
        notification: input.continuation?.notification ?? null,
        ui_url: buildFlowUiUrl({
            host: input.uiHost,
            port: input.uiPort,
            apiPort: input.uiApiPort,
            runId: input.runId
        })
    };
}
function flowLaunchNext(start, continuation) {
    if (!continuation) {
        return start.instance.status === "completed" ? "flow_completed" : "no_active_step";
    }
    switch (continuation.action) {
        case "dispatched":
            return "worker_dispatched_end_turn_until_agent_control_wakeup";
        case "orchestrator_action_required":
            return "native_subagent_action_required";
        case "waiting_for_report":
            return "worker_already_running_end_turn_until_agent_control_wakeup";
        case "start_in_progress":
            return "worker_start_in_progress_end_turn_until_agent_control_wakeup";
        case "start_superseded":
            return "flow_route_advanced_during_worker_start";
        case "waiting_for_orchestrator":
            return "orchestrator_action_required";
        case "blocked":
            return "flow_blocked";
        case "completed":
            return "flow_completed";
        case "cancelled":
            return "flow_cancelled";
        case "no_active_step":
            return "no_active_step";
    }
}
function flowLaunchReason(next, continuation) {
    if (continuation?.blocked_reason) {
        return continuation.blocked_reason;
    }
    const reasons = {
        worker_dispatched_end_turn_until_agent_control_wakeup: "A worker was dispatched; end the current turn until Agent Control wakes the coordinator.",
        worker_already_running_end_turn_until_agent_control_wakeup: "The active step already has a running worker; end the current turn until its report is available.",
        worker_start_in_progress_end_turn_until_agent_control_wakeup: "Another controller owns the durable backend-start lease; end the current turn until it completes.",
        flow_route_advanced_during_worker_start: "The flow advanced while an older backend start was unresolved; Agent Control retained the newer route and cleaned up the late worker.",
        orchestrator_action_required: "The flow reached a configured orchestrator decision point.",
        native_subagent_action_required: "A scoped native subagent action must be claimed, executed with the root collaboration tool, and acknowledged.",
        flow_blocked: "The flow is blocked and needs intervention.",
        flow_completed: "The flow completed.",
        flow_cancelled: "The flow was cancelled.",
        no_active_step: "No active flow step is available to dispatch."
    };
    return reasons[next] ?? next;
}
function buildFlowUiUrl(input) {
    const params = new URLSearchParams({ apiPort: String(input.apiPort), run_id: input.runId });
    return `http://${input.host}:${input.port}/?${params.toString()}`;
}
function compactFlowReportResult(result) {
    return {
        flow_instance_id: result.report.instance.flow_instance_id,
        flow_status: result.report.instance.status,
        reported_step: {
            step_instance_id: result.report.reported_step.step_instance_id,
            step_id: result.report.reported_step.step_id,
            status: result.report.reported_step.status,
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
                        status: result.continuation.agent.status
                    }
                    : null,
                dispatch: result.continuation.dispatch
                    ? {
                        expected_artifacts: result.continuation.dispatch.expected_artifacts,
                        prompt_size: result.continuation.dispatch.prompt_size
                    }
                    : null,
                blocked_reason: result.continuation.blocked_reason,
                notification: result.continuation.notification,
                orchestrator_action: result.continuation.orchestrator_action
            }
            : null
    };
}
function assertBlockingWaitAllowed(allowBlockingWait) {
    if (allowBlockingWait || process.env.AGENT_CONTROL_ALLOW_BLOCKING_WAIT === "1") {
        return;
    }
    throw new Error("Blocking waits are disabled by default. Pass --allow-blocking-wait only for explicit manual/debug waits or short opt-in foreground waits. Normal long-running orchestrators should use detached watchers/subscriptions.");
}
async function readStdin() {
    let text = "";
    for await (const chunk of process.stdin) {
        text += chunk;
    }
    return text;
}
function resolveLaunchOrchestratorBackendHandle(options) {
    if (options.orchestratorBackendHandleJson) {
        return parseJsonObjectOption(options.orchestratorBackendHandleJson);
    }
    if ((options.orchestratorBackend ?? "codex-thread") !== "codex-thread") {
        return undefined;
    }
    const threadId = options.orchestratorThreadId ?? process.env.CODEX_THREAD_ID;
    return threadId
        ? {
            thread_id: threadId,
            agent_control_role: "orchestrator",
            cwd: options.repoDir ?? process.cwd()
        }
        : undefined;
}
async function readConfigOption(options) {
    if ([options.configFile, options.configJson, options.configYaml, options.configStdin].filter(Boolean).length !== 1) {
        throw new Error("Use exactly one config source: --config-file, --config-json, --config-yaml, or --config-stdin.");
    }
    if (options.configFile) {
        return loadFlowConfigFile(options.configFile);
    }
    if (options.configStdin) {
        return parseFlowConfigText(await readStdin(), { format: "yaml" });
    }
    if (options.configYaml) {
        return parseFlowConfigText(options.configYaml, { format: "yaml" });
    }
    return parseFlowConfigText(options.configJson, { format: "json" });
}
function parseKeyValueList(values) {
    if (values.length === 0) {
        return undefined;
    }
    const parsed = {};
    for (const value of values) {
        const separatorIndex = value.indexOf("=");
        if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
            throw new Error(`Expected key=value artifact entry, got: ${value}`);
        }
        parsed[value.slice(0, separatorIndex)] = value.slice(separatorIndex + 1);
    }
    return parsed;
}
