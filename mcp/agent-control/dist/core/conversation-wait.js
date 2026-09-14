/** Model-facing continuation guidance; launching itself remains non-blocking. */
export function conversationWaitContract(runId, observerAgentId, wakeOn = "control") {
    return {
        turn_policy: "keep_open_while_work_pending",
        tool: "run_wait",
        arguments: { run_id: runId, observer_agent_id: observerAgentId, timeout_ms: 3_600_000, wake_on: wakeOn },
        instruction: "While any supervised Agent Control work remains pending, keep this Codex turn open. " +
            "Use the observation for your own thread: a separate executor uses coordinator_observer, the original conversation uses observer. " +
            "Immediately call this pending tool after launch. Subscription alone is not a wait. " +
            "The control wake policy selects decisions owned by this conversation, necessary intervention and whole-work completion; " +
            "an executing coordinator also receives routing events. Use all only when the user asks for individual events or worker updates. " +
            "Use timeout_ms: 3600000 (one hour) as the normal value on every run_wait. Do not shorten it unless the user explicitly requests a shorter timeout or grants discretion to choose. Do not lengthen it merely because the host supports more; depart from one hour only for a user instruction or a concrete reason within granted discretion. Preserve that accepted timeout policy on reentry after user messages, handled events, errors or timeout. " +
            "The minimum applies to the configured timeout, not elapsed waiting: matching actionable events, failures, blockers and aggregate completion return early. " +
            "Inspect errors and event outcomes, take the authorized next action, and ask the user only when their intervention is needed. " +
            "Outer tool yields, UI responsiveness and commentary cadence do not shorten this inner timeout. " +
            "When an async wrapper yields, retain and resume its existing pending call; do not start a duplicate run_wait. " +
            "Without that user exception, do not replace the at-least-one-hour wait with 60-second polling or a 30-minute fallback. " +
            "If the host cannot sustain at least one hour, report that transport limitation instead of silently shortening it without user authorization. " +
            "After a delivered event batch, handle required actions and explicitly call run_ack only after successfully handling all events through its cursor. " +
            "When a wait returns or is actually interrupted, start the next run_wait under the accepted timeout policy if work remains. " +
            "A user message (including another topic) that leaves the call pending requires resuming that call, not acknowledging undelivered events or starting another wait. " +
            "Fetching events or receiving a notification never acknowledges processing. Omit the cursor to recover the durable processed position, " +
            "as these reusable wait arguments do. Pass a cursor explicitly only for intentional replay or a known processed position; " +
            "do not keep reusing the initial launch cursor after ACK. A cancelled wait or tool error does not acknowledge events or cancel workers. " +
            "An unrelated user message or timeout does not cancel the work. Preserve every active run and its own observer/cursor; " +
            "wait on multiple runs concurrently when supported. Answer user questions in commentary; if the wait was interrupted, " +
            "reattach to the same run and observer with the durable processed cursor and accepted timeout policy (at least 3600000 ms absent the explicit user exception). Otherwise resume its existing pending call. " +
            "Do not poll state, relay routine progress, or create monitoring automations. " +
            "Only completion confirms all registered work in this run and its descendants has settled; check its outcome. " +
            "A single worker/flow event or closed observation is not proof of success. " +
            "Notify delivery is informational and cannot reliably wake an ended turn. " +
            "Finish the turn only when all supervised work is resolved or the user explicitly pauses or cancels supervision."
    };
}
