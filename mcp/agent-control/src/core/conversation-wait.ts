/** Model-facing continuation guidance; launching itself remains non-blocking. */
export function conversationWaitContract(runId: string, observerAgentId: string) {
  return {
    turn_policy: "keep_open_while_work_pending" as const,
    tool: "run_wait" as const,
    arguments: { run_id: runId, observer_agent_id: observerAgentId, timeout_ms: 3_600_000 },
    instruction: "While any supervised Agent Control work remains pending, keep this Codex turn open. " +
      "Use the observation for your own thread: a separate executor uses coordinator_observer, the original conversation uses observer. " +
      "After launch, an event batch, a timeout, or a user message (including another topic), respond in commentary when useful, " +
      "explicitly call run_ack after successfully handling all events through the returned cursor, then call run_wait again. " +
      "Fetching events or receiving a notification never acknowledges processing. Omit the cursor to recover the durable processed position, " +
      "as these reusable wait arguments do. Pass a cursor explicitly only for intentional replay or a known processed position; " +
      "do not keep reusing the initial launch cursor after ACK. Use a one-hour timeout, or 30 minutes if the host requires it. " +
      "An unrelated user message or timeout does not cancel the work. Preserve every active run and its own observer/cursor; " +
      "wait on multiple runs concurrently when supported. You may end each update with a localized sentence such as " +
      "'The <flow> flow is still running; I am continuing to wait.' " +
      "Notify delivery is informational and cannot reliably wake an ended turn. " +
      "Finish the turn only when all supervised work is resolved or the user explicitly pauses or cancels supervision."
  };
}
