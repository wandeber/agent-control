import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseDurationMs } from "../core/duration.js";
import { defaultControlHome } from "../core/paths.js";
import { collect, DEFAULT_HEARTBEAT_TIMEOUT_MS, DEFAULT_OPENCODE_SERVER, DEFAULT_TERMINAL_SUBSCRIPTION_EVENTS, DEFAULT_WORKER_START_TIMEOUT_MS, DEFAULT_WORKER_WATCH_INTERVAL_MS, DEFAULT_WORKER_WATCH_TIMEOUT_MS, parseIntOption, requireOption, resolveAgentctlPath, uniqueStrings, withTimeout } from "./shared.js";
const WORKER_HANDOFF_TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_WORKER_INPUT_HANDOFFS = 16;
const MAX_WORKER_INPUT_HANDOFF_PAYLOAD_BYTES = 16 * 1024;
const MAX_WORKER_INPUT_HANDOFF_COLLECTION_BYTES = 64 * 1024;
export function registerWorkerCommands(program, deps) {
    const worker = program.command("worker").description("Launch standalone workers through Agent Control.");
    worker
        .command("launch")
        .description("Register/start a worker, wire optional subscriptions, and optionally arm a detached watcher.")
        .option("--backend <backend>", "Backend kind.", "codex-thread")
        .option("--server <url>", "Backend server URL.")
        .option("--repo <dir>", "Repository directory.")
        .option("--repo-dir <dir>", "Repository directory.")
        .option("--dir <dir>", "Repository directory.")
        .option("--model <model>", "Backend model.")
        .option("--reasoning-effort <effort>", "Codex-thread reasoning effort (for example max).")
        .requiredOption("--title <title>", "Worker title.")
        .requiredOption("--prompt-file <path>", "Canonical prompt file. Do not use per-run temporary prompt files.")
        .requiredOption("--phase <name>", "Phase or operation name.")
        .requiredOption("--output-artifact <path>", "Primary expected output artifact path.")
        .option("--agent <agentId>", "Existing agent id to start.")
        .option("--agent-id <agentId>", "Existing agent id to start.")
        .option("--run <runId>", "Existing run id.")
        .option("--run-id <runId>", "Existing run id.")
        .option("--run-title <title>", "Run title to create when no run is inferred.")
        .option("--agent-token <token>", "Caller agent token. Defaults to AGENT_CONTROL_TOKEN.")
        .option("--orchestrator-agent-id <agentId>", "Compatibility parent agent id when no token is available.")
        .option("--subscribe-caller", "Subscribe the caller/orchestrator to worker lifecycle events.")
        .option("--subscriber-agent-id <agentId>", "Subscriber agent to notify.", collect, [])
        .option("--role <role>", "Worker role.")
        .option("--objective <text>", "Worker objective.")
        .option("--heartbeat", "Create an idle heartbeat for the worker.")
        .option("--heartbeat-timeout-ms <ms>", "Idle heartbeat timeout.", parseIntOption)
        .option("--start-timeout-ms <ms>", "Worker start timeout.", parseIntOption, DEFAULT_WORKER_START_TIMEOUT_MS)
        .option("--input-handoffs-json <json>", "Compact workflow handoffs as one validated JSON array.", parseSingleInputHandoffsJsonOption)
        .option("--input-artifact <label=path>", "Input artifact path by label.", collect, [])
        .option("--constraint <text>", "Runtime constraint to include in the worker dispatch.", collect, [])
        .option("--expect-artifact <path>", "Additional expected artifact path.", collect, [])
        .option("--file <path>", "Attachment path.", collect, [])
        .option("--subscribe-event <eventType>", "Additional subscription event type.", collect, [])
        .option("--no-default-terminal-subscriptions", "Do not add default terminal lifecycle subscription events.")
        .option("--watch", "Arm a detached deterministic watcher for the launched worker.")
        .option("--watch-timeout <duration>", "Detached watcher timeout such as 30m or 8h.")
        .option("--watch-timeout-ms <ms>", "Detached watcher timeout in milliseconds.", parseIntOption)
        .option("--watch-interval-ms <ms>", "Detached watcher refresh interval.", parseIntOption, DEFAULT_WORKER_WATCH_INTERVAL_MS)
        .action(async (options) => deps.output(await launchWorker(options, deps)));
}
export function registerWatchCommands(program, deps) {
    const watch = program.command("watch").description("Run detached deterministic waits for existing controller records.");
    watch
        .command("start")
        .description("Start a detached watcher for an agent, subscription, or goal.")
        .option("--agent <agentId>", "Watch this agent until terminal.")
        .option("--agent-id <agentId>", "Watch this agent until terminal.")
        .option("--subscription <subscriptionId>", "Watch this subscription until it receives a matching event.")
        .option("--subscription-id <subscriptionId>", "Watch this subscription until it receives a matching event.")
        .option("--goal <goalId>", "Wait until a goal owner has no active descendants, then request confirmation.")
        .option("--goal-id <goalId>", "Wait until a goal owner has no active descendants, then request confirmation.")
        .option("--then-goal-id <goalId>", "After an agent/subscription wait, run a goal confirmation wait.")
        .option("--allow-then-goal", "Allow chained goal confirmation after a non-goal watcher.")
        .option("--timeout <duration>", "Timeout such as 30m, 12h, or raw milliseconds.")
        .option("--timeout-ms <ms>", "Timeout in milliseconds.", parseIntOption)
        .option("--interval-ms <ms>", "Refresh interval.", parseIntOption, DEFAULT_WORKER_WATCH_INTERVAL_MS)
        .action((options) => deps.output(startDetachedWatch(normalizeWatchStartOptions(options))));
    watch
        .command("run", { hidden: true })
        .requiredOption("--watcher-id <watcherId>", "Watcher id.")
        .requiredOption("--target-kind <kind>", "agent, subscription, or goal.")
        .option("--agent <agentId>", "Agent id.")
        .option("--subscription <subscriptionId>", "Subscription id.")
        .option("--goal <goalId>", "Goal id.")
        .option("--then-goal-id <goalId>", "Goal id to confirm after a non-goal wait.")
        .requiredOption("--result-file <path>", "Path to write the wait result JSON.")
        .requiredOption("--log-file <path>", "Path to append watcher log JSONL.")
        .option("--goal-result-file <path>", "Path to write a chained goal result JSON.")
        .option("--timeout-ms <ms>", "Timeout in milliseconds.", parseIntOption)
        .option("--interval-ms <ms>", "Refresh interval.", parseIntOption, DEFAULT_WORKER_WATCH_INTERVAL_MS)
        .action(async (options) => deps.output(await runDetachedWatch(options, deps)));
}
export async function launchWorker(options, deps) {
    // Validate the complete handoff envelope before authentication can lead to
    // run/agent registration. Invalid workflow state must never reach a backend.
    const normalizedInputHandoffsJson = parseWorkerInputHandoffs(options.inputHandoffsJson);
    if (options.reasoningEffort && options.backend !== "codex-thread") {
        throw new Error("--reasoning-effort is only supported by codex-thread.");
    }
    const auth = deps.authOptions();
    const agentToken = options.agentToken ?? auth.agentToken;
    const caller = agentToken ? deps.controller.requireAgentToken(agentToken) : null;
    const promptFile = assertCanonicalPromptFile(options.promptFile);
    const repoDir = resolveWorkerRepoDir(options);
    const outputArtifact = resolve(options.outputArtifact);
    const additionalExpectedArtifacts = options.expectArtifact.map((path) => resolve(path));
    const expectedArtifacts = uniqueStrings([outputArtifact, ...additionalExpectedArtifacts]);
    const inputArtifacts = parseWorkerInputArtifacts(options.inputArtifact);
    const attachments = options.file.map((path) => resolve(path));
    mkdirSync(dirname(outputArtifact), { recursive: true });
    assertReadableFiles([...inputArtifacts.map((artifact) => artifact.path), ...attachments]);
    const agentId = options.agentId ?? options.agent;
    const model = options.model ?? (!agentId && options.backend === "codex-thread" ? "gpt-5.6-luna" : undefined);
    const reasoningEffort = options.reasoningEffort ?? (model === "gpt-5.6-luna" ? "max" : undefined);
    const runId = options.runId ?? options.run ?? caller?.run_id;
    let workerAgent;
    let createdAgent = false;
    if (agentId) {
        workerAgent = deps.controller.getAgent(agentId);
        if (runId && workerAgent.run_id !== runId) {
            throw new Error(`Agent ${agentId} belongs to ${workerAgent.run_id}, not ${runId}.`);
        }
    }
    else {
        let effectiveRunId = runId;
        if (!effectiveRunId && !agentToken) {
            const run = deps.controller.createRun({
                title: options.runTitle ?? options.title,
                repoDir,
                adminKey: auth.adminKey
            });
            effectiveRunId = run.run_id;
        }
        workerAgent = deps.controller.registerAgent({
            runId: effectiveRunId,
            backend: options.backend,
            title: options.title,
            role: options.role ?? options.phase,
            objective: options.objective,
            repoDir,
            model,
            status: "queued",
            adminKey: auth.adminKey,
            agentToken
        });
        createdAgent = true;
    }
    if (options.orchestratorAgentId && options.orchestratorAgentId !== workerAgent.agent_id) {
        createAgentLinkIfMissing({
            runId: workerAgent.run_id,
            sourceAgentId: options.orchestratorAgentId,
            targetAgentId: workerAgent.agent_id,
            type: "parent_child",
            label: options.role ?? options.phase
        }, deps);
    }
    const artifact = deps.controller.createArtifact({
        runId: workerAgent.run_id,
        agentId: workerAgent.agent_id,
        label: `${options.phase}-output`,
        path: outputArtifact,
        expected: true
    });
    for (const path of additionalExpectedArtifacts) {
        deps.controller.createArtifact({
            runId: workerAgent.run_id,
            agentId: workerAgent.agent_id,
            label: "expected-output",
            path,
            expected: true
        });
    }
    const heartbeat = options.heartbeat || options.heartbeatTimeoutMs
        ? deps.controller.createHeartbeat({
            agentId: workerAgent.agent_id,
            idleTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
        })
        : null;
    const subscriberIds = uniqueStrings([
        ...options.subscriberAgentId,
        ...(options.subscribeCaller
            ? [caller?.agent_id ?? options.orchestratorAgentId].filter((value) => Boolean(value))
            : [])
    ]);
    if (options.subscribeCaller && subscriberIds.length === 0) {
        throw new Error("--subscribe-caller requires --agent-token, AGENT_CONTROL_TOKEN, or --orchestrator-agent-id.");
    }
    const subscriptionEvents = uniqueStrings([
        ...(options.defaultTerminalSubscriptions === false ? [] : DEFAULT_TERMINAL_SUBSCRIPTION_EVENTS),
        ...options.subscribeEvent
    ]);
    const subscriptions = subscriberIds.flatMap((subscriberAgentId) => subscriptionEvents.map((eventType) => deps.controller.createSubscription({
        runId: workerAgent.run_id,
        sourceAgentId: workerAgent.agent_id,
        subscriberAgentId,
        eventType
    })));
    const heartbeatSubscriptions = heartbeat && subscriberIds.length > 0
        ? subscriberIds.map((subscriberAgentId) => deps.controller.createSubscription({
            runId: workerAgent.run_id,
            sourceAgentId: workerAgent.agent_id,
            subscriberAgentId,
            eventType: "heartbeat.timeout"
        }))
        : [];
    const prompt = buildWorkerDispatchPrompt({
        phase: options.phase,
        objective: options.objective,
        repoDir,
        outputArtifact,
        inputArtifacts,
        inputHandoffsJson: normalizedInputHandoffsJson,
        constraints: options.constraint,
        attachments,
        promptFile,
        canonicalPrompt: readFileSync(promptFile, "utf8")
    });
    let started;
    try {
        started = await withTimeout(deps.controller.startAgent({
            agentId: workerAgent.agent_id,
            prompt,
            server: options.server ?? (options.backend === "opencode-server" ? DEFAULT_OPENCODE_SERVER : undefined),
            model,
            metadata: reasoningEffort ? { reasoning_effort: reasoningEffort } : undefined,
            expectedArtifacts,
            attachments,
            agentToken
        }), options.startTimeoutMs, `Timed out while starting worker ${workerAgent.agent_id}.`);
    }
    catch (error) {
        if (createdAgent) {
            await deps.controller.agentPurge(workerAgent.agent_id, { stopFirst: true, force: true }).catch(() => undefined);
        }
        throw error;
    }
    if (started.status !== "running") {
        if (createdAgent) {
            await deps.controller.agentPurge(workerAgent.agent_id, { stopFirst: true, force: true }).catch(() => undefined);
        }
        throw new Error(`Worker ${workerAgent.agent_id} did not enter running state. Current status: ${started.status}.`);
    }
    const watchResult = options.watch
        ? startDetachedWatch({
            target: { kind: "agent", agentId: workerAgent.agent_id },
            timeoutMs: options.watchTimeoutMs ??
                (options.watchTimeout ? parseDurationMs(options.watchTimeout) : DEFAULT_WORKER_WATCH_TIMEOUT_MS),
            intervalMs: options.watchIntervalMs
        })
        : null;
    return {
        run_id: workerAgent.run_id,
        agent_id: workerAgent.agent_id,
        backend: workerAgent.backend,
        title: workerAgent.title,
        state: "running",
        artifact,
        subscriber_agent_ids: subscriberIds,
        heartbeat_id: heartbeat?.heartbeat_id ?? null,
        heartbeat_timeout_ms: heartbeat?.idle_timeout_ms ?? null,
        subscriptions: [...subscriptions, ...heartbeatSubscriptions],
        watch: watchResult
            ? {
                target: "agent",
                agent_id: workerAgent.agent_id,
                detached_watcher: true,
                ...watchResult
            }
            : subscriptions.length > 0
                ? {
                    target: "subscription",
                    subscription_id: subscriptions[0]?.subscription_id ?? null
                }
                : {
                    target: "agent",
                    agent_id: workerAgent.agent_id
                }
    };
}
export function startDetachedWatch(options) {
    const watcherId = `watch_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${process.pid}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    const watcherRoot = resolve(process.env.AGENT_CONTROL_RUNTIME_DIR ?? defaultControlHome(), "watchers", watcherId);
    mkdirSync(watcherRoot, { recursive: true });
    const logFile = join(watcherRoot, "watch.log");
    const resultFile = join(watcherRoot, "result.json");
    const goalResultFile = options.thenGoalId ? join(watcherRoot, "goal-result.json") : undefined;
    const args = [
        "watch",
        "run",
        "--watcher-id",
        watcherId,
        "--target-kind",
        options.target.kind,
        "--result-file",
        resultFile,
        "--log-file",
        logFile,
        "--timeout-ms",
        String(options.timeoutMs),
        "--interval-ms",
        String(options.intervalMs)
    ];
    if (options.target.kind === "agent") {
        args.push("--agent", options.target.agentId);
    }
    else if (options.target.kind === "subscription") {
        args.push("--subscription", options.target.subscriptionId);
    }
    else {
        args.push("--goal", options.target.goalId);
    }
    if (options.thenGoalId) {
        args.push("--then-goal-id", options.thenGoalId, "--goal-result-file", goalResultFile);
    }
    const child = spawn(resolveAgentctlPath(), args, {
        detached: true,
        env: process.env,
        stdio: "ignore"
    });
    child.unref();
    return {
        watcher_id: watcherId,
        state: "watching",
        detach_method: "node-detached",
        pid: child.pid,
        log_file: logFile,
        result_file: resultFile,
        goal_result_file: goalResultFile
    };
}
async function runDetachedWatch(options, deps) {
    const startedAt = new Date().toISOString();
    appendWatcherLog(options.logFile, { watcher_id: options.watcherId, state: "started", started_at: startedAt });
    try {
        const waitOptions = { intervalMs: options.intervalMs, timeoutMs: options.timeoutMs };
        const result = options.targetKind === "agent"
            ? await deps.controller.waitForAgentTerminal(requireOption(options.agent, "--agent"), waitOptions)
            : options.targetKind === "subscription"
                ? await deps.controller.waitForSubscriptionEvent(requireOption(options.subscription, "--subscription"), waitOptions)
                : await deps.controller.waitForGoalConfirmation(requireOption(options.goal, "--goal"), waitOptions);
        mkdirSync(dirname(options.resultFile), { recursive: true });
        writeFileSync(options.resultFile, JSON.stringify(result, null, 2));
        let goalResult = null;
        if (options.thenGoalId) {
            goalResult = await deps.controller.waitForGoalConfirmation(options.thenGoalId, waitOptions);
            if (options.goalResultFile) {
                mkdirSync(dirname(options.goalResultFile), { recursive: true });
                writeFileSync(options.goalResultFile, JSON.stringify(goalResult, null, 2));
            }
        }
        const finishedAt = new Date().toISOString();
        appendWatcherLog(options.logFile, { watcher_id: options.watcherId, state: "finished", finished_at: finishedAt });
        return {
            watcher_id: options.watcherId,
            state: "finished",
            started_at: startedAt,
            finished_at: finishedAt,
            result_file: options.resultFile,
            goal_result_file: options.goalResultFile,
            result,
            goal_result: goalResult
        };
    }
    catch (error) {
        const finishedAt = new Date().toISOString();
        const payload = {
            watcher_id: options.watcherId,
            state: "failed",
            finished_at: finishedAt,
            error: error instanceof Error ? error.message : String(error)
        };
        appendWatcherLog(options.logFile, payload);
        writeFileSync(options.resultFile, JSON.stringify(payload, null, 2));
        throw error;
    }
}
function normalizeWatchStartOptions(options) {
    const agentId = options.agentId ?? options.agent;
    const subscriptionId = options.subscriptionId ?? options.subscription;
    const goalId = options.goalId ?? options.goal;
    const targets = [
        ...(agentId ? [{ kind: "agent", agentId }] : []),
        ...(subscriptionId ? [{ kind: "subscription", subscriptionId }] : []),
        ...(goalId ? [{ kind: "goal", goalId }] : [])
    ];
    if (targets.length !== 1) {
        throw new Error("watch start requires exactly one of --agent, --subscription, or --goal.");
    }
    if (options.thenGoalId && targets[0]?.kind === "goal") {
        throw new Error("--then-goal-id cannot be used with --goal.");
    }
    if (options.thenGoalId && !options.allowThenGoal && process.env.AGENT_CONTROL_ALLOW_THEN_GOAL !== "1") {
        throw new Error("--then-goal-id requires --allow-then-goal or AGENT_CONTROL_ALLOW_THEN_GOAL=1.");
    }
    return {
        target: targets[0],
        timeoutMs: options.timeoutMs ?? (options.timeout ? parseDurationMs(options.timeout) : DEFAULT_WORKER_WATCH_TIMEOUT_MS),
        intervalMs: options.intervalMs,
        thenGoalId: options.thenGoalId
    };
}
function resolveWorkerRepoDir(options) {
    const repoDir = options.repoDir ?? options.repo ?? options.dir;
    if (!repoDir) {
        throw new Error("worker launch requires --repo, --repo-dir, or --dir.");
    }
    const resolved = resolve(repoDir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        throw new Error(`Repository directory not found: ${resolved}`);
    }
    return resolved;
}
function assertCanonicalPromptFile(path) {
    const promptFile = resolve(path);
    if (promptFile.startsWith("/tmp/") || promptFile.startsWith("/private/tmp/")) {
        throw new Error("Use a canonical skill prompt file, not a per-run temporary prompt file.");
    }
    if (!existsSync(promptFile) || !statSync(promptFile).isFile()) {
        throw new Error(`Prompt file not found: ${promptFile}`);
    }
    return promptFile;
}
function parseWorkerInputArtifacts(values) {
    return values.map((value) => {
        const index = value.indexOf("=");
        if (index <= 0 || index === value.length - 1) {
            throw new Error(`Expected label=path input artifact, got: ${value}`);
        }
        return {
            label: value.slice(0, index),
            path: resolve(value.slice(index + 1))
        };
    });
}
function parseSingleInputHandoffsJsonOption(value, previous) {
    if (previous !== undefined) {
        throw new Error("--input-handoffs-json may be provided at most once.");
    }
    return value;
}
function parseWorkerInputHandoffs(value) {
    if (value === undefined) {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch (error) {
        throw new Error(`--input-handoffs-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error("--input-handoffs-json must be a JSON array.");
    }
    if (parsed.length > MAX_WORKER_INPUT_HANDOFFS) {
        throw new Error(`--input-handoffs-json accepts at most ${MAX_WORKER_INPUT_HANDOFFS} handoffs.`);
    }
    if (parsed.length === 0) {
        return undefined;
    }
    const labels = new Set();
    const handoffs = parsed.map((entry, index) => {
        if (!isJsonObject(entry)) {
            throw new Error(`input_handoffs[${index}] must be a JSON object.`);
        }
        const keys = Object.keys(entry);
        if (keys.length !== 3 || !keys.includes("label") || !keys.includes("kind") || !keys.includes("payload")) {
            throw new Error(`input_handoffs[${index}] must contain exactly label, kind, and payload.`);
        }
        const label = entry.label;
        const kind = entry.kind;
        if (typeof label !== "string" || !WORKER_HANDOFF_TOKEN_PATTERN.test(label)) {
            throw new Error(`input_handoffs[${index}].label must match ${WORKER_HANDOFF_TOKEN_PATTERN.source}.`);
        }
        if (typeof kind !== "string" || !WORKER_HANDOFF_TOKEN_PATTERN.test(kind)) {
            throw new Error(`input_handoffs[${index}].kind must match ${WORKER_HANDOFF_TOKEN_PATTERN.source}.`);
        }
        if (labels.has(label)) {
            throw new Error(`input_handoffs contains duplicate label: ${label}.`);
        }
        labels.add(label);
        if (!isJsonObject(entry.payload)) {
            throw new Error(`input_handoffs[${index}].payload must be a JSON object.`);
        }
        // The payload remains opaque to Agent Control. Validate only that rendering
        // preserves its JSON values, then enforce the per-payload byte bound.
        assertLosslessJsonRendering(entry.payload, `input_handoffs[${index}].payload`);
        const payloadJson = serializeJson(entry.payload, `input_handoffs[${index}].payload`);
        const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
        if (payloadBytes > MAX_WORKER_INPUT_HANDOFF_PAYLOAD_BYTES) {
            throw new Error(`input_handoffs[${index}].payload is ${payloadBytes} bytes; maximum is ${MAX_WORKER_INPUT_HANDOFF_PAYLOAD_BYTES}.`);
        }
        return { label, kind, payload: entry.payload };
    });
    const compactJson = serializeJson(handoffs, "input_handoffs");
    const collectionBytes = Buffer.byteLength(compactJson, "utf8");
    if (collectionBytes > MAX_WORKER_INPUT_HANDOFF_COLLECTION_BYTES) {
        throw new Error(`input_handoffs is ${collectionBytes} bytes; maximum is ${MAX_WORKER_INPUT_HANDOFF_COLLECTION_BYTES}.`);
    }
    return compactJson;
}
function isJsonObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function serializeJson(value, path) {
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new Error("value serialized to undefined");
        }
        return serialized;
    }
    catch (error) {
        throw new Error(`${path} cannot be serialized as bounded JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Traverse parsed JSON iteratively so values that JSON.stringify would silently
 * coerce (notably overflowed numbers) fail before the prompt is rendered.
 * Payload keys and string values are deliberately opaque caller-owned data.
 */
function assertLosslessJsonRendering(value, rootPath) {
    const pending = [{ value, path: rootPath }];
    while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current.value === "number" && !Number.isFinite(current.value)) {
            throw new Error(`${current.path} must contain only finite JSON numbers.`);
        }
        if (current.value === null || typeof current.value !== "object") {
            continue;
        }
        if (Array.isArray(current.value)) {
            current.value.forEach((item, index) => pending.push({ value: item, path: `${current.path}[${index}]` }));
            continue;
        }
        for (const [key, nestedValue] of Object.entries(current.value)) {
            pending.push({ value: nestedValue, path: `${current.path}.${key}` });
        }
    }
}
function assertReadableFiles(paths) {
    for (const path of paths) {
        if (!existsSync(path) || !statSync(path).isFile()) {
            throw new Error(`File not found: ${path}`);
        }
    }
}
function buildWorkerDispatchPrompt(input) {
    const lines = [
        "# Delegated Worker Dispatch",
        "",
        `Phase: ${input.phase}`,
        `Objective: ${input.objective ?? "Use the canonical prompt and provided artifacts."}`,
        `Repository: ${input.repoDir}`,
        `Output artifact: ${input.outputArtifact}`,
        "",
        "Input artifacts:",
        ...(input.inputArtifacts.length > 0
            ? input.inputArtifacts.map((artifact) => `- ${artifact.label}: ${artifact.path}`)
            : ["- none"]),
        ...(input.inputHandoffsJson
            ? ["", "Input handoffs:", "```json", input.inputHandoffsJson, "```"]
            : []),
        "",
        "Constraints:",
        ...(input.constraints.length > 0 ? input.constraints.map((constraint) => `- ${constraint}`) : ["- none"]),
        "",
        "Attached files:",
        ...(input.attachments.length > 0 ? input.attachments.map((path) => `- ${path}`) : ["- none"]),
        "",
        "Rules:",
        "- Follow the canonical prompt exactly.",
        "- Write the required output artifact before reporting completion.",
        "- Keep in-process status terse.",
        "- Do not assume the coordinator is Codex unless the backend-specific prompt says so.",
        "",
        `Canonical prompt file: ${input.promptFile}`,
        "",
        "# Canonical Prompt Content",
        "",
        input.canonicalPrompt.trimEnd(),
        ""
    ];
    return lines.join("\n");
}
function createAgentLinkIfMissing(input, deps) {
    const existing = deps.controller
        .listAgentLinks({ runId: input.runId })
        .some((link) => link.source_agent_id === input.sourceAgentId &&
        link.target_agent_id === input.targetAgentId &&
        link.type === input.type &&
        link.label === (input.label ?? null));
    if (!existing) {
        deps.controller.createAgentLink(input);
    }
}
function appendWatcherLog(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(value)}\n`);
}
