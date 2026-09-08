import { describe, expect, it, vi } from "vitest";
import { loadConsoleSnapshot } from "../src/console-tools.js";

describe("loadConsoleSnapshot", () => {
  it("returns the snapshot while one slow refresh remains in flight", async () => {
    let finish!: () => void;
    const controller = {
      pollActiveAgents: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })),
      getDashboardSnapshot: () => ({ selected_run_id: "run-42" })
    };
    expect((await loadConsoleSnapshot(controller, "run-42")).snapshot.selected_run_id).toBe("run-42");
    await loadConsoleSnapshot(controller, "run-42");
    expect(controller.pollActiveAgents).toHaveBeenCalledTimes(1);
    finish();
  });

  it("starts refreshing controller-approved adapters when reading a pinned snapshot", async () => {
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

    expect(calls).toEqual(["snapshot:run-42", "poll:run-42"]);
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
    expect(controller.pollActiveAgents).toHaveBeenCalledWith("latest-run");
  });
});
