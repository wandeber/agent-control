import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/storage/sqlite-store.js";

describe("observer launch CLI", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("registers the original conversation before the first native phase without launching native work", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-control-observer-cli-"));
    directories.push(directory);
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "flow", "launch",
      "--config-file", "tests/fixtures/codex-subagent-flow.yaml", "--title", "Observer CLI contract",
      "--repo-dir", directory, "--requester-thread-id", "original-thread", "--requester-event", "flow.completed"
    ], { cwd: resolve("."), encoding: "utf8", env: { ...process.env, AGENT_CONTROL_HOME: directory,
      AGENT_CONTROL_DB: join(directory, "state.sqlite"), AGENT_CONTROL_ADMIN_KEY: "observer-cli-test-admin",
      AGENT_CONTROL_TOKEN: "", CODEX_THREAD_ID: "owner-thread" } }));
    expect(result.observer).toMatchObject({ thread_id: "original-thread", event_types: ["flow.completed"], delivery: "wait" });
    const store = new SqliteStore(join(directory, "state.sqlite"));
    try {
      const agents = store.listAgents({ runId: result.run_id });
      expect(agents.find((agent) => agent.agent_id === result.orchestrator_agent_id)?.backend_handle?.thread_id).toBe("owner-thread");
      const observer = agents.find((agent) => agent.agent_id === result.observer.observer_agent_id)!;
      expect(observer.role).toBe("observer");
      expect(store.db.prepare("select count(*) n from bridge_grants where orchestrator_agent_id = ?").get(observer.agent_id)).toEqual({ n: 0 });
      const start = store.db.prepare("select start_sequence from run_observers where observer_agent_id = ?").get(observer.agent_id) as { start_sequence: number };
      const firstPhase = store.db.prepare("select o.sequence from events e join event_order o using(event_id) where e.run_id = ? and e.type = 'flow.step_started'").get(result.run_id) as { sequence: number };
      expect(firstPhase.sequence).toBeGreaterThan(start.start_sequence);
      expect(result.orchestrator_action).toMatchObject({ operation: "spawn_agent", status: "pending" });
    } finally { store.close(); }
  });
});
