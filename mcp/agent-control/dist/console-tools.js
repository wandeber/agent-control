/**
 * Refreshes only backends that the controller considers cheap before reading a
 * console snapshot. Adapter capability filtering lives in pollActiveAgents;
 * this helper must not bypass it because native collaboration status is pushed
 * through explicit bridge synchronization rather than inspected by the MCP
 * server.
 */
export async function loadConsoleSnapshot(controller, runId) {
    await controller.pollActiveAgents(runId);
    return {
        snapshot: controller.getDashboardSnapshot(runId),
        console: {
            requested_run_id: runId ?? null,
            follow_latest: !runId
        }
    };
}
