/**
 * Refreshes only backends that the controller considers cheap before reading a
 * console snapshot. Adapter capability filtering lives in pollActiveAgents;
 * this helper must not bypass it because native collaboration status is pushed
 * through explicit bridge synchronization rather than inspected by the MCP
 * server.
 */
export async function loadConsoleSnapshot(controller, runId) {
    // Following the latest run must not poll every historical backend. Apart
    // from wasting CPU, unavailable old endpoints delay the selected chat.
    const initial = runId ? null : controller.getDashboardSnapshot();
    const latestRunId = initial && typeof initial === "object" && "selected_run_id" in initial
        ? initial.selected_run_id : null;
    const effectiveRunId = runId ?? (typeof latestRunId === "string" ? latestRunId : undefined);
    if (effectiveRunId)
        await controller.pollActiveAgents(effectiveRunId);
    return {
        snapshot: controller.getDashboardSnapshot(runId),
        console: {
            requested_run_id: runId ?? null,
            follow_latest: !runId
        }
    };
}
