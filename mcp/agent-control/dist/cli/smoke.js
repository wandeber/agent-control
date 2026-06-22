import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRuntimeDir } from "../core/paths.js";
import { DEFAULT_WORKER_START_TIMEOUT_MS, DEFAULT_WORKER_WATCH_INTERVAL_MS, getRecord, getString, parseIntOption, sleep } from "./shared.js";
import { launchWorker } from "./worker.js";
export function registerSmokeCommands(program, deps) {
    const smoke = program.command("smoke").description("Run controlled Agent Control smoke checks.");
    smoke
        .command("worker-launch")
        .description("Create a short manual worker, launch it through worker launch, verify watcher completion, and purge it.")
        .option("--repo <dir>", "Repository directory for the smoke run.", process.cwd())
        .option("--timeout-ms <ms>", "Maximum time to wait for the detached watcher result.", parseIntOption, 10_000)
        .option("--poll-ms <ms>", "Watcher result polling interval.", parseIntOption, 250)
        .option("--keep-run", "Keep the smoke run instead of purging it.")
        .option("--keep-watcher-files", "Keep the detached watcher result files.")
        .action(async (options) => deps.output(await smokeWorkerLaunch(options, deps)));
}
async function smokeWorkerLaunch(options, deps) {
    const repoDir = resolve(options.repo);
    if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
        throw new Error(`Repository directory not found: ${repoDir}`);
    }
    const adminKey = deps.authOptions({ allowStoredAdminKey: true }).adminKey;
    const run = deps.controller.createRun({
        title: `Agent Control worker launch smoke ${new Date().toISOString()}`,
        repoDir,
        adminKey
    });
    const runDir = runRuntimeDir(run.run_id);
    const outputArtifact = join(runDir, "worker-launch-smoke-report.md");
    writeFileSync(outputArtifact, "# Worker Launch Smoke\n\nManual smoke worker completed.\n");
    const worker = deps.controller.registerAgent({
        runId: run.run_id,
        backend: "manual",
        title: "Worker launch smoke worker",
        role: "smoke-worker",
        objective: "Validate agentctl worker launch, detached watcher completion, terminal event recording, and purge cleanup.",
        repoDir,
        model: "manual",
        status: "queued",
        backendHandle: {
            id: "worker-launch-smoke",
            status: "completed",
            message: "Manual smoke worker reached completed status.",
            messages: [
                {
                    id: "worker-launch-smoke-message",
                    role: "assistant",
                    text: "Manual smoke worker completed.",
                    created_at: new Date().toISOString()
                }
            ]
        },
        adminKey
    });
    let response = null;
    try {
        const launch = await launchWorker({
            backend: "manual",
            repo: repoDir,
            model: "manual",
            title: "Worker launch smoke worker",
            promptFile: smokePromptPath(),
            phase: "smoke",
            outputArtifact,
            agentId: worker.agent_id,
            runId: run.run_id,
            startTimeoutMs: DEFAULT_WORKER_START_TIMEOUT_MS,
            inputArtifact: [],
            constraint: ["Smoke check: do not contact external backends."],
            expectArtifact: [],
            file: [],
            subscribeEvent: [],
            defaultTerminalSubscriptions: false,
            subscriberAgentId: [],
            watch: true,
            watchTimeoutMs: options.timeoutMs,
            watchIntervalMs: Math.max(50, Math.min(options.pollMs, DEFAULT_WORKER_WATCH_INTERVAL_MS))
        }, deps);
        const watchResult = getRecord(launch.watch, "watch");
        const resultFile = getString(watchResult.result_file, "watch.result_file");
        const terminalResult = await waitForJsonFile(resultFile, {
            timeoutMs: options.timeoutMs,
            intervalMs: options.pollMs
        });
        const completedEvents = deps.controller.listEvents({
            runId: run.run_id,
            agentId: worker.agent_id,
            type: "agent.completed",
            limit: 10
        });
        const completedEvent = completedEvents[0] ?? null;
        if (!completedEvent) {
            throw new Error("Smoke worker reached terminal state, but no agent.completed event was recorded.");
        }
        let watcherRuntimeDeleted = false;
        if (!options.keepWatcherFiles) {
            rmSync(dirname(resultFile), { recursive: true, force: true });
            watcherRuntimeDeleted = true;
        }
        response = {
            ok: true,
            smoke: "worker-launch",
            run_id: run.run_id,
            agent_id: worker.agent_id,
            watcher: watchResult,
            terminal_result: terminalResult,
            completed_event: completedEvent,
            purged: null,
            watcher_runtime_deleted: watcherRuntimeDeleted
        };
        return response;
    }
    finally {
        if (!options.keepRun) {
            const purged = await deps.controller.runPurge(run.run_id, {
                stopFirst: true,
                force: true,
                deleteRuntimeFiles: true
            });
            if (response) {
                response.purged = purged;
            }
        }
    }
}
function smokePromptPath() {
    const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../smoke/worker-launch-prompt.md");
    if (!existsSync(promptPath)) {
        throw new Error(`Agent Control smoke prompt not found: ${promptPath}`);
    }
    return promptPath;
}
async function waitForJsonFile(path, options) {
    const startedAt = Date.now();
    while (true) {
        if (existsSync(path)) {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            return getRecord(parsed, path);
        }
        if (Date.now() - startedAt >= options.timeoutMs) {
            throw new Error(`Timed out waiting for watcher result file: ${path}`);
        }
        await sleep(Math.max(50, options.intervalMs));
    }
}
