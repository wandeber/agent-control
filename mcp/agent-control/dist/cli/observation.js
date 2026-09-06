import { parseDurationMs } from "../core/duration.js";
import { collect } from "./shared.js";
export function addRequesterOptions(command) {
    return command
        .option("--requester-thread-id <id>", "Original user conversation to observe this run; defaults to CODEX_THREAD_ID.")
        .option("--requester-event <type>", "Event to observe; repeat for multiple event types.", collect, [])
        .option("--requester-delivery <mode>", "wait (default) or notify using safe in-turn injection.");
}
export function attachRequester(runId, options, deps, agentToken) {
    const auth = deps.authOptions({ allowStoredAdminKey: true });
    return deps.controller.ensureRequester(runId, { requesterThreadId: options.requesterThreadId,
        requesterEventTypes: options.requesterEvent?.length ? options.requesterEvent : undefined,
        requesterDelivery: options.requesterDelivery, agentToken: agentToken ?? auth.agentToken, adminKey: auth.adminKey });
}
export function registerObservationCommands(run, deps) {
    run.command("observe")
        .description("Attach the user's Codex conversation to a run without transferring workflow ownership.")
        .requiredOption("--run <id>", "Run to observe.")
        .option("--thread-id <id>", "Actual Codex thread id; defaults to CODEX_THREAD_ID.")
        .option("--title <title>", "Participant title.")
        .option("--event <type>", "Event to observe; repeat for multiple event types.", collect, [])
        .option("--delivery <mode>", "wait (default) or notify using safe in-turn injection.")
        .action((options) => {
        const auth = deps.authOptions({ allowStoredAdminKey: true });
        deps.output(deps.controller.observeRun({ runId: options.run, threadId: options.threadId, title: options.title,
            eventTypes: options.event.length ? options.event : undefined, delivery: options.delivery, ...auth }));
    });
    run.command("wait")
        .description("Wait for the next subscribed run events using a durable cursor; omit timeout to wait indefinitely.")
        .requiredOption("--run <id>", "Observed run.")
        .requiredOption("--observer-agent-id <id>", "Registered observing participant.")
        .requiredOption("--cursor <cursor>", "Cursor returned by run observe or the previous run wait.")
        .option("--timeout <duration>", "Optional timeout such as 1h.")
        .action(async (options) => {
        const cancellation = new AbortController();
        const abort = () => cancellation.abort(new Error("Observation cancelled"));
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        try {
            deps.output(await deps.controller.waitForRun({ runId: options.run, observerAgentId: options.observerAgentId,
                cursor: options.cursor, timeoutMs: options.timeout ? parseDurationMs(options.timeout) : undefined, signal: cancellation.signal }));
        }
        finally {
            process.removeListener("SIGINT", abort);
            process.removeListener("SIGTERM", abort);
        }
    });
}
