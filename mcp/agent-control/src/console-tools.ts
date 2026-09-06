export interface ConsoleSnapshotProvider<TSnapshot> {
  pollActiveAgents(runId?: string): Promise<unknown>;
  getDashboardSnapshot(runId?: string | null): TSnapshot;
}

export type ConsoleSnapshotContent<TSnapshot> = Record<string, unknown> & {
  snapshot: TSnapshot;
  console: {
    requested_run_id: string | null;
    follow_latest: boolean;
    action?: "reuse" | "close";
    command_id?: string;
  };
};

/**
 * Refreshes only backends that the controller considers cheap before reading a
 * console snapshot. Adapter capability filtering lives in pollActiveAgents;
 * this helper must not bypass it because native collaboration status is pushed
 * through explicit bridge synchronization rather than inspected by the MCP
 * server.
 */
export async function loadConsoleSnapshot<TSnapshot>(
  controller: ConsoleSnapshotProvider<TSnapshot>,
  runId?: string
): Promise<ConsoleSnapshotContent<TSnapshot>> {
  // Following the latest run must not poll every historical backend. Apart
  // from wasting CPU, unavailable old endpoints delay the selected chat.
  const initial = runId ? null : controller.getDashboardSnapshot();
  const latestRunId = initial && typeof initial === "object" && "selected_run_id" in initial
    ? initial.selected_run_id : null;
  const effectiveRunId = runId ?? (typeof latestRunId === "string" ? latestRunId : undefined);
  if (effectiveRunId) await controller.pollActiveAgents(effectiveRunId);
  return {
    snapshot: controller.getDashboardSnapshot(runId),
    console: {
      requested_run_id: runId ?? null,
      follow_latest: !runId
    }
  };
}
