import { promisify } from "node:util";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  it("instructs fresh and reused non-native flow launches to keep the turn open", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-control-cli-wait-contract-"));
    directories.push(directory);
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    server.on("connection", socket => socket.on("message", raw => {
      const { id, method } = JSON.parse(String(raw));
      if (id === undefined) return;
      const thread = { id: "simulated-thread", cwd: directory, status: { type: "active", activeFlags: [] },
        turns: [{ id: "simulated-turn", status: "inProgress", items: [] }] };
      const result = method === "turn/start" ? { turn: { id: "simulated-turn" } }
        : method.startsWith("thread/") ? { thread } : {};
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    }));
    const config = join(directory, "flow.json");
    writeFileSync(config, JSON.stringify({ id: "cli-wait-contract", initial_step: "work", roles: { worker: { backend: "codex-thread" } },
      steps: { work: { role: "worker", prompt: "Simulated task", on: { reported: { finish: true } } } } }));
    const env = { ...process.env, AGENT_CONTROL_HOME: directory, AGENT_CONTROL_DB: join(directory, "state.sqlite"),
      AGENT_CONTROL_ADMIN_KEY: "cli-contract-test", AGENT_CONTROL_TOKEN: "", CODEX_THREAD_ID: "launch-conversation" };
    const args = ["--import", "tsx", "src/cli.ts", "flow", "launch", "--config-file", config, "--title", "Keep waiting",
      "--repo-dir", directory, "--server", `ws://localhost:${port}`];
    let watcher: number | undefined;
    try {
      const launch = JSON.parse((await promisify(execFile)(process.execPath, args, { cwd: resolve("."), env })).stdout);
      watcher = launch.watch?.pid;
      expect(launch.next).toBe("worker_dispatched_wait_for_run_events");
      expect(launch.reason).toContain("Keep this turn open");
      expect(launch.observer.wait_contract.arguments).toMatchObject({ run_id: launch.run_id, cursor: launch.observer.cursor, timeout_ms: 3_600_000 });
      const reuse = JSON.parse((await promisify(execFile)(process.execPath, [...args, "--run", launch.run_id], { cwd: resolve("."), env })).stdout);
      expect(reuse.next).toBe("worker_already_running_wait_for_run_events");
      expect(reuse.reason).toContain("resume run_wait");
      expect(reuse.observer.observer_agent_id).toBe(launch.observer.observer_agent_id);
    } finally {
      if (watcher) { try { process.kill(watcher, "SIGTERM"); } catch {} }
      for (const client of server.clients) client.terminate();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }, 15_000);

});
