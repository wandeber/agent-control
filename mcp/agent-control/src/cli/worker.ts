import { observeLaunchCoordinator, prepareLaunchOwner } from "../core/launch-context.js";
import { addRequesterOptions, attachRequester, type RequesterOptions } from "./observation.js";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { parseDurationMs } from "../core/duration.js";
import { defaultControlHome } from "../core/paths.js";
import type { AgentLinkType, AgentRecord, AgentStartResult, EventType } from "../core/types.js";
import {
  collect,
  type CliDeps,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_OPENCODE_SERVER,
  DEFAULT_TERMINAL_SUBSCRIPTION_EVENTS,
  DEFAULT_WORKER_START_TIMEOUT_MS,
  DEFAULT_WORKER_WATCH_INTERVAL_MS,
  DEFAULT_WORKER_WATCH_TIMEOUT_MS,
  parseIntOption,
  requireOption,
  resolveAgentctlPath,
  uniqueStrings,
  withTimeout
} from "./shared.js";

export type WorkerLaunchOptions = RequesterOptions & {
  backend: string;
  server?: string;
  repo?: string;
  repoDir?: string;
  dir?: string;
  model?: string;
  profile?: string;
  sandbox?: "read_only" | "workspace";
  reasoningEffort?: string;
  title: string;
  promptFile?: string;
  prompt?: string;
  phase: string;
  outputArtifact?: string;
  agent?: string;
  agentId?: string;
  run?: string;
  runId?: string;
  runTitle?: string;
  agentToken?: string;
  orchestratorAgentId?: string;
  subscribeCaller?: boolean;
  subscriberAgentId: string[];
  role?: string;
  objective?: string;
  heartbeat?: boolean;
  heartbeatTimeoutMs?: number;
  startTimeoutMs: number;
  inputHandoffsJson?: string;
  inputArtifact: string[];
  constraint: string[];
  expectArtifact: string[];
  file: string[];
  subscribeEvent: EventType[];
  defaultTerminalSubscriptions?: boolean;
  watch?: boolean;
  watchTimeout?: string;
  watchTimeoutMs?: number;
  watchIntervalMs: number;
};

type WatchTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "flow"; flowInstanceId: string }
  | { kind: "subscription"; subscriptionId: string }
  | { kind: "goal"; goalId: string };

type NormalizedWatchStartOptions = {
  target: WatchTarget;
  timeoutMs: number;
  intervalMs: number;
  thenGoalId?: string;
};

type WatchStartOptions = {
  flow?: string;
  agent?: string;
  agentId?: string;
  subscription?: string;
  subscriptionId?: string;
  goal?: string;
  goalId?: string;
  thenGoalId?: string;
  allowThenGoal?: boolean;
  timeout?: string;
  timeoutMs?: number;
  intervalMs: number;
};

type WatchRunOptions = {
  watcherId: string;
  targetKind: "agent" | "flow" | "subscription" | "goal";
  flow?: string;
  agent?: string;
  subscription?: string;
  goal?: string;
  thenGoalId?: string;
  resultFile: string;
  logFile: string;
  goalResultFile?: string;
  timeoutMs?: number;
  intervalMs: number;
};

type WorkerInputHandoff = {
  label: string;
  kind: string;
  payload: Record<string, unknown>;
};

const WORKER_HANDOFF_TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_WORKER_INPUT_HANDOFFS = 16;
const MAX_WORKER_INPUT_HANDOFF_PAYLOAD_BYTES = 16 * 1024;
const MAX_WORKER_INPUT_HANDOFF_COLLECTION_BYTES = 64 * 1024;

export function registerWorkerCommands(program: Command, deps: CliDeps): void {
  const worker = program.command("worker").description("Launch standalone workers through Agent Control.");

  addRequesterOptions(worker
    .command("launch"))
    .description("Register/start a worker, wire optional subscriptions, and optionally arm a detached watcher.")
    .option("--backend <backend>", "Backend kind; defaults to codex-cli with profile, otherwise codex-thread.")
    .option("--profile <profile>", "Codex CLI profile for any configured provider/model.")
    .option("--sandbox <sandbox>", "read_only or workspace.")
    .option("--server <url>", "Backend server URL.")
    .option("--repo <dir>", "Repository directory.")
    .option("--repo-dir <dir>", "Repository directory.")
    .option("--dir <dir>", "Repository directory.")
    .option("--model <model>", "Backend model.")
    .option("--reasoning-effort <effort>", "Codex-thread reasoning effort (for example max).")
    .requiredOption("--title <title>", "Worker title.")
    .option("--prompt <text>", "Task text for an ad hoc worker; use --prompt-file for a skill-owned canonical prompt.")
    .option("--prompt-file <path>", "Canonical prompt file. Do not use per-run temporary prompt files.")
    .requiredOption("--phase <name>", "Phase or operation name.")
    .option("--output-artifact <path>", "Primary expected output artifact path.")
    .option("--agent <agentId>", "Existing agent id to start.")
    .option("--agent-id <agentId>", "Existing agent id to start.")
    .option("--run <runId>", "Existing run id.")
    .option("--run-id <runId>", "Existing run id.")
    .option("--run-title <title>", "Run title to create when no run is inferred.")
    .option("--agent-token <token>", "Caller agent token. Defaults to AGENT_CONTROL_TOKEN.")
    .option("--orchestrator-agent-id <agentId>", "Compatibility parent agent id when no token is available.")
    .option("--subscribe-caller", "Subscribe the caller/orchestrator to worker lifecycle events.")
    .option("--subscriber-agent-id <agentId>", "Subscriber agent to notify.", collect, [] as string[])
    .option("--role <role>", "Worker role.")
    .option("--objective <text>", "Worker objective.")
    .option("--heartbeat", "Create an idle heartbeat for the worker.")
    .option("--heartbeat-timeout-ms <ms>", "Idle heartbeat timeout.", parseIntOption)
    .option("--start-timeout-ms <ms>", "Worker start timeout.", parseIntOption, DEFAULT_WORKER_START_TIMEOUT_MS)
    .option(
      "--input-handoffs-json <json>",
      "Compact workflow handoffs as one validated JSON array.",
      parseSingleInputHandoffsJsonOption
    )
    .option("--input-artifact <label=path>", "Input artifact path by label.", collect, [] as string[])
    .option("--constraint <text>", "Runtime constraint to include in the worker dispatch.", collect, [] as string[])
    .option("--expect-artifact <path>", "Additional expected artifact path.", collect, [] as string[])
    .option("--file <path>", "Attachment path.", collect, [] as string[])
    .option("--subscribe-event <eventType>", "Additional subscription event type.", collect, [] as EventType[])
    .option("--no-default-terminal-subscriptions", "Do not add default terminal lifecycle subscription events.")
    .option("--watch", "Arm detached supervision (enabled by default).")
    .option("--no-watch", "Use an existing supervisor for an explicit manual or test launch.")
    .option("--watch-timeout <duration>", "Detached watcher timeout such as 30m or 8h.")
    .option("--watch-timeout-ms <ms>", "Detached watcher timeout in milliseconds.", parseIntOption)
    .option("--watch-interval-ms <ms>", "Detached watcher refresh interval.", parseIntOption, DEFAULT_WORKER_WATCH_INTERVAL_MS)
    .action(async (options: WorkerLaunchOptions) => deps.output(await launchWorker(options, deps)));
}

export function registerWatchCommands(program: Command, deps: CliDeps): void {
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
    .action((options: WatchStartOptions) => deps.output(startDetachedWatch(normalizeWatchStartOptions(options))));

  watch
    .command("run", { hidden: true })
    .requiredOption("--watcher-id <watcherId>", "Watcher id.")
    .requiredOption("--target-kind <kind>", "agent, flow, subscription, or goal.")
    .option("--agent <agentId>", "Agent id.")
    .option("--flow <flowInstanceId>", "Supervise all phases of a flow.")
    .option("--subscription <subscriptionId>", "Subscription id.")
    .option("--goal <goalId>", "Goal id.")
    .option("--then-goal-id <goalId>", "Goal id to confirm after a non-goal wait.")
    .requiredOption("--result-file <path>", "Path to write the wait result JSON.")
    .requiredOption("--log-file <path>", "Path to append watcher log JSONL.")
    .option("--goal-result-file <path>", "Path to write a chained goal result JSON.")
    .option("--timeout-ms <ms>", "Timeout in milliseconds.", parseIntOption)
    .option("--interval-ms <ms>", "Refresh interval.", parseIntOption, DEFAULT_WORKER_WATCH_INTERVAL_MS)
    .action(async (options: WatchRunOptions) => deps.output(await runDetachedWatch(options, deps)));
}

export async function launchWorker(options: WorkerLaunchOptions, deps: CliDeps): Promise<Record<string, unknown>> {
  options.backend ??= options.profile ? "codex-cli" : "codex-thread";
  if (options.profile && options.backend !== "codex-cli") throw new Error("--profile requires codex-cli.");
  if (options.sandbox && !["codex-cli", "codex-thread"].includes(options.backend)) throw new Error("--sandbox requires a Codex backend.");
  // Validate the complete handoff envelope before authentication can lead to
  // run/agent registration. Invalid workflow state must never reach a backend.
  const normalizedInputHandoffsJson = parseWorkerInputHandoffs(options.inputHandoffsJson);
  if (options.reasoningEffort && !["codex-thread", "codex-cli"].includes(options.backend)) {
    throw new Error("--reasoning-effort is only supported by codex-thread or codex-cli.");
  }
  const auth = deps.authOptions({ allowStoredAdminKey: true });
  if (Boolean(options.promptFile) === Boolean(options.prompt)) throw new Error("Use exactly one of --prompt-file or --prompt.");
  const promptFile = options.promptFile ? assertCanonicalPromptFile(options.promptFile) : undefined;
  const repoDir = resolveWorkerRepoDir(options);
  const outputArtifact = options.outputArtifact ? resolve(options.outputArtifact) : undefined;
  const additionalExpectedArtifacts = options.expectArtifact.map((path) => resolve(path));
  const expectedArtifacts = uniqueStrings([...(outputArtifact ? [outputArtifact] : []), ...additionalExpectedArtifacts]);
  const inputArtifacts = parseWorkerInputArtifacts(options.inputArtifact);
  const attachments = options.file.map((path) => resolve(path));

  if (outputArtifact) mkdirSync(dirname(outputArtifact), { recursive: true });
  assertReadableFiles([...inputArtifacts.map((artifact) => artifact.path), ...attachments]);

  const agentId = options.agentId ?? options.agent;
  const model = options.model ?? (!agentId && options.backend === "codex-thread" ? "gpt-5.6-luna" : undefined);
  const reasoningEffort = options.reasoningEffort ?? (options.backend === "codex-thread" && model === "gpt-5.6-luna" ? "max" : undefined);
  const owner = prepareLaunchOwner(deps.controller, { title: options.runTitle ?? options.title, repoDir,
    runId: options.runId ?? options.run ?? (agentId ? deps.controller.getAgent(agentId).run_id : undefined),
    agentToken: options.agentToken ?? auth.agentToken, adminKey: auth.adminKey, requesterThreadId: options.requesterThreadId });
  const agentToken = owner.agentToken;
  const caller = owner.agent;
  const runId = owner.runId;
  let workerAgent: AgentRecord;
  let createdAgent = false;

  if (agentId) {
    workerAgent = deps.controller.getAgent(agentId);
    if (runId && workerAgent.run_id !== runId) {
      throw new Error(`Agent ${agentId} belongs to ${workerAgent.run_id}, not ${runId}.`);
    }
  } else {
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
    createAgentLinkIfMissing(
      {
        runId: workerAgent.run_id,
        sourceAgentId: options.orchestratorAgentId,
        targetAgentId: workerAgent.agent_id,
        type: "parent_child",
        label: options.role ?? options.phase
      },
      deps
    );
  }

  const observer = attachRequester(workerAgent.run_id, options, deps, agentToken);
  const coordinatorObserver = observeLaunchCoordinator(deps.controller, owner, workerAgent.run_id, observer);

  const artifact = outputArtifact ? deps.controller.createArtifact({
    runId: workerAgent.run_id,
    agentId: workerAgent.agent_id,
    label: `${options.phase}-output`,
    path: outputArtifact,
    expected: true
  }) : null;

  for (const path of additionalExpectedArtifacts) {
    deps.controller.createArtifact({
      runId: workerAgent.run_id,
      agentId: workerAgent.agent_id,
      label: "expected-output",
      path,
      expected: true
    });
  }

  const heartbeat =
    options.heartbeat || options.heartbeatTimeoutMs
      ? deps.controller.createHeartbeat({
          agentId: workerAgent.agent_id,
          idleTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
        })
      : null;

  const subscriberIds = uniqueStrings([
    ...options.subscriberAgentId,
    ...(options.subscribeCaller
      ? [caller?.agent_id ?? options.orchestratorAgentId].filter((value): value is string => Boolean(value))
      : [])
  ]);
  if (options.subscribeCaller && subscriberIds.length === 0) {
    throw new Error("--subscribe-caller requires --agent-token, AGENT_CONTROL_TOKEN, or --orchestrator-agent-id.");
  }

  const subscriptionEvents = uniqueStrings([
    ...(options.defaultTerminalSubscriptions === false ? [] : DEFAULT_TERMINAL_SUBSCRIPTION_EVENTS),
    ...options.subscribeEvent
  ]) as EventType[];
  const subscriptions = subscriberIds.flatMap((subscriberAgentId) =>
    subscriptionEvents.map((eventType) =>
      deps.controller.createSubscription({
        runId: workerAgent.run_id,
        sourceAgentId: workerAgent.agent_id,
        subscriberAgentId,
        eventType
      })
    )
  );

  const heartbeatSubscriptions =
    heartbeat && subscriberIds.length > 0
      ? subscriberIds.map((subscriberAgentId) =>
          deps.controller.createSubscription({
            runId: workerAgent.run_id,
            sourceAgentId: workerAgent.agent_id,
            subscriberAgentId,
            eventType: "heartbeat.timeout"
          })
        )
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
    canonicalPrompt: promptFile ? readFileSync(promptFile, "utf8") : options.prompt!
  });

  let started: AgentStartResult;
  try {
    started = await withTimeout(
      deps.controller.startAgent({
        agentId: workerAgent.agent_id,
        prompt,
        server: options.server ?? (options.backend === "opencode-server" ? DEFAULT_OPENCODE_SERVER : undefined),
        model,
        metadata: { ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}), ...(options.profile ? { profile: options.profile } : {}), ...(options.sandbox ? { sandbox: options.sandbox } : {}) },
        expectedArtifacts,
        attachments,
        agentToken
      }),
      options.startTimeoutMs,
      `Timed out while starting worker ${workerAgent.agent_id}.`
    );
  } catch (error) {
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

  const watchResult = options.watch !== false
    ? startDetachedWatch({
        target: { kind: "agent", agentId: workerAgent.agent_id },
        timeoutMs:
          options.watchTimeoutMs ??
          (options.watchTimeout ? parseDurationMs(options.watchTimeout) : DEFAULT_WORKER_WATCH_TIMEOUT_MS),
        intervalMs: options.watchIntervalMs
      })
    : null;

  return {
    run_id: workerAgent.run_id,
    observer,
    coordinator_observer: coordinatorObserver,
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

export function startDetachedWatch(options: NormalizedWatchStartOptions): Record<string, unknown> {
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
  } else if (options.target.kind === "flow") {
    args.push("--flow", options.target.flowInstanceId);
  } else if (options.target.kind === "subscription") {
    args.push("--subscription", options.target.subscriptionId);
  } else {
    args.push("--goal", options.target.goalId);
  }
  if (options.thenGoalId) {
    args.push("--then-goal-id", options.thenGoalId, "--goal-result-file", goalResultFile!);
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

async function runDetachedWatch(options: WatchRunOptions, deps: CliDeps): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  appendWatcherLog(options.logFile, { watcher_id: options.watcherId, state: "started", started_at: startedAt });
  try {
    const waitOptions = { intervalMs: options.intervalMs, timeoutMs: options.timeoutMs };
    const result =
      options.targetKind === "agent"
        ? await deps.controller.waitForAgentTerminal(requireOption(options.agent, "--agent"), waitOptions)
        : options.targetKind === "flow"
          ? await deps.controller.waitForFlowTerminal(requireOption(options.flow, "--flow"), waitOptions)
        : options.targetKind === "subscription"
          ? await deps.controller.waitForSubscriptionEvent(requireOption(options.subscription, "--subscription"), waitOptions)
          : await deps.controller.waitForGoalConfirmation(requireOption(options.goal, "--goal"), waitOptions);
    mkdirSync(dirname(options.resultFile), { recursive: true });
    writeFileSync(options.resultFile, JSON.stringify(result, null, 2));

    let goalResult: Record<string, unknown> | null = null;
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
  } catch (error) {
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

function normalizeWatchStartOptions(options: WatchStartOptions): NormalizedWatchStartOptions {
  const agentId = options.agentId ?? options.agent;
  const subscriptionId = options.subscriptionId ?? options.subscription;
  const goalId = options.goalId ?? options.goal;
  const targets: WatchTarget[] = [
    ...(options.flow ? [{ kind: "flow" as const, flowInstanceId: options.flow }] : []),
    ...(agentId ? [{ kind: "agent" as const, agentId }] : []),
    ...(subscriptionId ? [{ kind: "subscription" as const, subscriptionId }] : []),
    ...(goalId ? [{ kind: "goal" as const, goalId }] : [])
  ];
  if (targets.length !== 1) {
    throw new Error("watch start requires exactly one of --agent, --flow, --subscription, or --goal.");
  }
  if (options.thenGoalId && targets[0]?.kind === "goal") {
    throw new Error("--then-goal-id cannot be used with --goal.");
  }
  if (options.thenGoalId && !options.allowThenGoal && process.env.AGENT_CONTROL_ALLOW_THEN_GOAL !== "1") {
    throw new Error("--then-goal-id requires --allow-then-goal or AGENT_CONTROL_ALLOW_THEN_GOAL=1.");
  }
  return {
    target: targets[0]!,
    timeoutMs: options.timeoutMs ?? (options.timeout ? parseDurationMs(options.timeout) : DEFAULT_WORKER_WATCH_TIMEOUT_MS),
    intervalMs: options.intervalMs,
    thenGoalId: options.thenGoalId
  };
}

function resolveWorkerRepoDir(options: Pick<WorkerLaunchOptions, "repo" | "repoDir" | "dir">): string {
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

function assertCanonicalPromptFile(path: string): string {
  const promptFile = resolve(path);
  if (promptFile.startsWith("/tmp/") || promptFile.startsWith("/private/tmp/")) {
    throw new Error("Use a canonical skill prompt file, not a per-run temporary prompt file.");
  }
  if (!existsSync(promptFile) || !statSync(promptFile).isFile()) {
    throw new Error(`Prompt file not found: ${promptFile}`);
  }
  return promptFile;
}

function parseWorkerInputArtifacts(values: string[]): Array<{ label: string; path: string }> {
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

function parseSingleInputHandoffsJsonOption(value: string, previous: string | undefined): string | undefined {
  if (previous !== undefined) {
    throw new Error("--input-handoffs-json may be provided at most once.");
  }
  return value;
}

function parseWorkerInputHandoffs(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
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

  const labels = new Set<string>();
  const handoffs = parsed.map((entry, index): WorkerInputHandoff => {
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
      throw new Error(
        `input_handoffs[${index}].payload is ${payloadBytes} bytes; maximum is ${MAX_WORKER_INPUT_HANDOFF_PAYLOAD_BYTES}.`
      );
    }
    return { label, kind, payload: entry.payload };
  });

  const compactJson = serializeJson(handoffs, "input_handoffs");
  const collectionBytes = Buffer.byteLength(compactJson, "utf8");
  if (collectionBytes > MAX_WORKER_INPUT_HANDOFF_COLLECTION_BYTES) {
    throw new Error(
      `input_handoffs is ${collectionBytes} bytes; maximum is ${MAX_WORKER_INPUT_HANDOFF_COLLECTION_BYTES}.`
    );
  }
  return compactJson;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeJson(value: unknown, path: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("value serialized to undefined");
    }
    return serialized;
  } catch (error) {
    throw new Error(`${path} cannot be serialized as bounded JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Traverse parsed JSON iteratively so values that JSON.stringify would silently
 * coerce (notably overflowed numbers) fail before the prompt is rendered.
 * Payload keys and string values are deliberately opaque caller-owned data.
 */
function assertLosslessJsonRendering(value: unknown, rootPath: string): void {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: rootPath }];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new Error(`${current.path} must contain only finite JSON numbers.`);
    }
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) =>
        pending.push({ value: item, path: `${current.path}[${index}]` })
      );
      continue;
    }

    for (const [key, nestedValue] of Object.entries(current.value)) {
      pending.push({ value: nestedValue, path: `${current.path}.${key}` });
    }
  }
}
function assertReadableFiles(paths: string[]): void {
  for (const path of paths) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`File not found: ${path}`);
    }
  }
}

function buildWorkerDispatchPrompt(input: {
  phase: string;
  objective?: string;
  repoDir: string;
  outputArtifact?: string;
  inputArtifacts: Array<{ label: string; path: string }>;
  inputHandoffsJson?: string;
  constraints: string[];
  attachments: string[];
  promptFile?: string;
  canonicalPrompt: string;
}): string {
  const lines = [
    "# Delegated Worker Dispatch",
    "",
    `Phase: ${input.phase}`,
    `Objective: ${input.objective ?? "Use the canonical prompt and provided artifacts."}`,
    `Repository: ${input.repoDir}`,
    ...(input.outputArtifact ? [`Output artifact: ${input.outputArtifact}`] : []),
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
    ...(input.outputArtifact ? ["- Write the required output artifact before reporting completion."] : ["- Return your result in the final response."]),
    "- Keep in-process status terse.",
    "- Do not assume the coordinator is Codex unless the backend-specific prompt says so.",
    "",
    ...(input.promptFile ? [`Canonical prompt file: ${input.promptFile}`] : []),
    "",
    "# Canonical Prompt Content",
    "",
    input.canonicalPrompt.trimEnd(),
    ""
  ];
  return lines.join("\n");
}

function createAgentLinkIfMissing(
  input: {
    runId: string;
    sourceAgentId: string;
    targetAgentId: string;
    type: AgentLinkType;
    label?: string | null;
  },
  deps: CliDeps
): void {
  const existing = deps.controller
    .listAgentLinks({ runId: input.runId })
    .some(
      (link) =>
        link.source_agent_id === input.sourceAgentId &&
        link.target_agent_id === input.targetAgentId &&
        link.type === input.type &&
        link.label === (input.label ?? null)
    );
  if (!existing) {
    deps.controller.createAgentLink(input);
  }
}

function appendWatcherLog(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}
