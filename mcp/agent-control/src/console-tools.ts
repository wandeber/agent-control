export interface ConsoleSnapshotProvider<TSnapshot> {
  pollActiveAgents(runId?: string): Promise<unknown>;
  getDashboardSnapshot(runId?: string | null): TSnapshot;
}

export type ConsoleSnapshotContent<TSnapshot> = Record<string, unknown> & {
  snapshot: TSnapshot;
  console: {
    requested_run_id: string | null;
    follow_latest: boolean;
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
  await controller.pollActiveAgents(runId);
  return {
    snapshot: controller.getDashboardSnapshot(runId),
    console: {
      requested_run_id: runId ?? null,
      follow_latest: !runId
    }
  };
}
