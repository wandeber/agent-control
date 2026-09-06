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

// Status updates must never block reading the already persisted dashboard.
// One in-flight refresh per controller/run avoids duplicate backend work.
const refreshes = new WeakMap<object, Set<string>>();

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
  if (effectiveRunId) {
    let pending = refreshes.get(controller);
    if (!pending) { pending = new Set(); refreshes.set(controller, pending); }
    if (!pending.has(effectiveRunId)) {
      pending.add(effectiveRunId);
      void controller.pollActiveAgents(effectiveRunId).catch(() => {
        // Backend availability is reflected by detail reads; retain the snapshot.
      }).finally(() => pending.delete(effectiveRunId));
    }
  }
  return {
    snapshot: controller.getDashboardSnapshot(runId),
    console: {
      requested_run_id: runId ?? null,
      follow_latest: !runId
    }
  };
}
