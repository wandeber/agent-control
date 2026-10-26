import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { AgentController } from "../src/core/controller.js";
import { createDefaultAdapterRegistry } from "../src/adapters/registry.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

let directory: string, child: ChildProcess | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true });
});
it.each(["EOF", "SIGTERM"])("cancels a pending one-hour MCP wait and exits cleanly on %s", async ending => {
  directory = mkdtempSync(join(tmpdir(), "ac-stdio-lifecycle-"));
  vi.stubEnv("AGENT_CONTROL_HOME", directory); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "fixture-admin");
  const database = join(directory, "state.sqlite"), store = new SqliteStore(database);
  const controller = new AgentController(store, createDefaultAdapterRegistry());
  let observation: ReturnType<AgentController["observeRun"]>;
  try {
    const run = controller.createRun({ title: "Wait cancellation", adminKey: "fixture-admin" });
    controller.registerAgent({ runId: run.run_id, backend: "manual", title: "Durable work", status: "running", backendHandle: { status: "running" } });
    observation = controller.observeRun({ runId: run.run_id, threadId: "fixture-observer", adminKey: "fixture-admin" });
  } finally { await controller.dispose(); store.close(); }
  child = spawn(process.execPath, ["--import", "tsx", resolve("src/index.ts")], { stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: directory, CODEX_THREAD_ID: "", AGENT_CONTROL_REQUESTER_THREAD_ID: "", AGENT_CONTROL_TOKEN: "",
      AGENT_CONTROL_DB: database, AGENT_CONTROL_POLL_INTERVAL_MS: "1" } });
  const exited = once(child, "exit"); let stderr = ""; child.stderr!.on("data", data => stderr += data);
  const pending = new Map<number, (message: any) => void>();
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", line => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  const send = (id: number, method: string, params: unknown) => {
    const response = new Promise<any>(resolve => pending.set(id, resolve));
    child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return response;
  };
  await send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shutdown-fixture", version: "1" } });
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  let waitCompleted = false;
  const waiting = send(2, "tools/call", { name: "run_wait", arguments: observation!.wait_contract.arguments }).then(message => { waitCompleted = true; return message; });
  await send(3, "tools/call", { name: "backend_list", arguments: {} });
  expect(waitCompleted).toBe(false);
  if (ending === "EOF") child.stdin!.end(); else child.kill("SIGTERM");
  expect(await exited).toEqual([0, null]);
  expect(waitCompleted).toBe(true);
  expect((await waiting).result.isError).toBe(true);
  expect(stderr).toBe(""); lines.close();
  const reopened = new SqliteStore(database);
  try { expect(reopened.listAgents().find(agent => agent.title === "Durable work")?.status).toBe("running"); }
  finally { reopened.close(); }
}, 10_000);
