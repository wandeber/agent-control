import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { startControlServer } from "../src/control-server.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

afterEach(() => vi.unstubAllEnvs());

it("streams every selected run while reading an agent in the second run", async () => {
  const root = mkdtempSync(join(tmpdir(), "control-multirun-"));
  const db = join(root, "state.sqlite");
  vi.stubEnv("AGENT_CONTROL_HOME", root);
  vi.stubEnv("AGENT_CONTROL_DB", db);
  vi.stubEnv("AGENT_CONTROL_POLL_INTERVAL_MS", "0");
  const store = new SqliteStore(db);
  const a = store.createRun({ title: "First run", repoDir: root });
  const b = store.createRun({ title: "Second run", repoDir: root });
  const agents = [a, b].map(run => store.createAgent({ runId: run.run_id, title: run.title, backend: "manual", status: "completed" }));
  const server = await startControlServer({ host: "localhost", port: 0 });
  const port = (server.server.address() as { port: number }).port;
  const socket = new WebSocket(`ws://localhost:${port}/ws/control`);
  const messages: any[] = [];
  socket.on("message", raw => messages.push(JSON.parse(String(raw))));
  try {
    const result = await fetch(`http://localhost:${port}/api/control/snapshots?run_id=${a.run_id}&run_id=${b.run_id}`).then(response => response.json()) as any[];
    expect(result.map(snapshot => snapshot.selected_run_id)).toEqual([a.run_id, b.run_id]);
    expect(result.map(snapshot => snapshot.agents[0].agent_id)).toEqual(agents.map(agent => agent.agent_id));
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.OPEN));
    socket.send(JSON.stringify({ type: "select", run_ids: [a.run_id, b.run_id], agent_id: agents[1].agent_id }));
    await vi.waitFor(() => expect(messages.some(message => message.snapshots?.length === 2)).toBe(true));
    store.db.prepare("update agents set title = ? where agent_id = ?").run("Changed during work", agents[1].agent_id);
    await vi.waitFor(() => {
      expect(messages.some(message => message.snapshots?.[1]?.agents[0]?.title === "Changed during work")).toBe(true);
      expect(messages.some(message => message.type === "agent_messages" && message.agent_id === agents[1].agent_id)).toBe(true);
    }, { timeout: 4000 });
    messages.length = 0;
    socket.send(JSON.stringify({ type: "select", run_id: a.run_id }));
    await vi.waitFor(() => expect(messages.some(message => message.snapshots?.length === 1 && message.snapshot.selected_run_id === a.run_id)).toBe(true));
  } finally {
    socket.terminate();
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
