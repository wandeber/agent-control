import { describe, expect, it, vi } from "vitest";
import { loadConsoleSnapshot } from "../src/console-tools.js";

describe("loadConsoleSnapshot", () => {
  it("refreshes controller-approved adapters before reading a pinned snapshot", async () => {
    const calls: string[] = [];
    const controller = {
      pollActiveAgents: vi.fn(async (runId?: string) => {
        calls.push(`poll:${runId ?? "latest"}`);
      }),
      getDashboardSnapshot: vi.fn((runId?: string | null) => {
        calls.push(`snapshot:${runId ?? "latest"}`);
        return { selected_run_id: runId ?? "latest-run" };
      })
    };

    const result = await loadConsoleSnapshot(controller, "run-42");

    expect(calls).toEqual(["poll:run-42", "snapshot:run-42"]);
    expect(result).toEqual({
      snapshot: { selected_run_id: "run-42" },
      console: { requested_run_id: "run-42", follow_latest: false }
    });
  });

  it("marks an unpinned snapshot as following the latest run", async () => {
    const controller = {
      pollActiveAgents: vi.fn(async () => undefined),
      getDashboardSnapshot: vi.fn(() => ({ selected_run_id: "latest-run" }))
    };

    const result = await loadConsoleSnapshot(controller);

    expect(result.console).toEqual({ requested_run_id: null, follow_latest: true });
  });
});
