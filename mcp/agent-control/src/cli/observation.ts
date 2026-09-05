import type { Command } from "commander";
import type { EventType } from "../core/types.js";
import { parseDurationMs } from "../core/duration.js";
import { collect, type CliDeps } from "./shared.js";

export interface RequesterOptions {
  requesterThreadId?: string;
  requesterEvent?: EventType[];
  requesterDelivery?: "wait" | "notify";
}

export function addRequesterOptions(command: Command): Command {
  return command
    .option("--requester-thread-id <id>", "Original user conversation to observe this run; defaults to CODEX_THREAD_ID.")
    .option("--requester-event <type>", "Event to observe; repeat for multiple event types.", collect, [] as EventType[])
    .option("--requester-delivery <mode>", "wait (default) or notify using safe in-turn injection.");
}

export function attachRequester(runId: string, options: RequesterOptions, deps: CliDeps, agentToken?: string) {
  const threadId = options.requesterThreadId ?? process.env.CODEX_THREAD_ID;
  if (!threadId) {
    if (options.requesterEvent?.length) throw new Error("Requester subscriptions require the actual requester thread id.");
    return null;
  }
  const auth = deps.authOptions({ allowStoredAdminKey: true });
  return deps.controller.observeRun({ runId, threadId, agentToken: agentToken ?? auth.agentToken,
    adminKey: auth.adminKey, delivery: options.requesterDelivery,
    eventTypes: options.requesterEvent?.length ? options.requesterEvent : undefined });
}

export function registerObservationCommands(run: Command, deps: CliDeps): void {
  run.command("observe")
    .description("Attach the user's Codex conversation to a run without transferring workflow ownership.")
    .requiredOption("--run <id>", "Run to observe.")
    .option("--thread-id <id>", "Actual Codex thread id; defaults to CODEX_THREAD_ID.")
    .option("--title <title>", "Participant title.")
    .option("--event <type>", "Event to observe; repeat for multiple event types.", collect, [] as EventType[])
    .option("--delivery <mode>", "wait (default) or notify using safe in-turn injection.")
    .action((options: { run: string; threadId?: string; title?: string; event: EventType[]; delivery: "wait" | "notify" }) => {
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
    .action(async (options: { run: string; observerAgentId: string; cursor: string; timeout?: string }) => {
      const cancellation = new AbortController();
      const abort = () => cancellation.abort(new Error("Observation cancelled"));
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        deps.output(await deps.controller.waitForRun({ runId: options.run, observerAgentId: options.observerAgentId,
          cursor: options.cursor, timeoutMs: options.timeout ? parseDurationMs(options.timeout) : undefined, signal: cancellation.signal }));
      } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
      }
    });
}
