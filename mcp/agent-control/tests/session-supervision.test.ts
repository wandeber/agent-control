import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionSupervision } from "../src/core/session-supervision.js";
import { AgentController } from "../src/core/controller.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import type { AgentAdapter } from "../src/core/types.js";

let directory: string;
const supervisors: SessionSupervision[] = [], controllers: AgentController[] = [], stores: SqliteStore[] = [], children: ChildProcess[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ac-session-supervision-"));
  vi.stubEnv("AGENT_CONTROL_HOME", directory); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "fixture-admin");
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  for (const controller of controllers.splice(0)) await controller.dispose();
  supervisors.splice(0).forEach(s => s.close()); stores.splice(0).forEach(s => s.close());
  vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
function supervise(path: string, reconcile = vi.fn()) {
  const supervisor = new SessionSupervision(path, reconcile); supervisors.push(supervisor); supervisor.start();
  return { supervisor, reconcile };
}
it("elects one owner across 44 instances and transfers supervision on disposal", async () => {
  vi.useFakeTimers();
  const path = join(directory, "state.sqlite"), store = new SqliteStore(path); stores.push(store);
  const instances = Array.from({ length: 44 }, () => supervise(path));
  expect(instances.filter(s => s.supervisor.isOwner)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(instances.reduce((n, s) => n + s.reconcile.mock.calls.length, 0)).toBe(13);
  instances[0].supervisor.close(); await vi.advanceTimersByTimeAsync(5_000);
  expect(instances.filter(s => s.supervisor.isOwner)).toHaveLength(1);
  expect(instances[1].reconcile).toHaveBeenCalledTimes(1);
});
it("recovers the OS lock after an owner crashes without waiting for a lease", async () => {
  const path = join(directory, "state.sqlite"), store = new SqliteStore(path); stores.push(store);
  const module = pathToFileURL(resolve("src/core/session-supervision.ts")).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {SessionSupervision} from ${JSON.stringify(module)}; const s = new SessionSupervision(process.argv[1],()=>{}); s.start(); process.stdout.write(String(s.isOwner)); process.stdin.resume();`, path], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  expect(String((await once(child.stdout!, "data"))[0])).toBe("true");
  vi.useFakeTimers(); const follower = supervise(path); expect(follower.supervisor.isOwner).toBe(false);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  await vi.advanceTimersByTimeAsync(5_000); expect(follower.supervisor.isOwner).toBe(true);
}, 10_000);
it("discovers sessions registered by followers and removes their stale watchers", async () => {
  vi.useFakeTimers();
  const watchStatus = vi.fn(() => vi.fn());
  const adapter = { kind: "codex-session", watchStatus, capabilities: () => ({ canInspectStatusCheaply: true }) } as unknown as AgentAdapter;
  const registry = new AdapterRegistry(); registry.register(adapter);
  const path = join(directory, "state.sqlite");
  for (let i = 0; i < 3; i++) {
    const store = new SqliteStore(path); stores.push(store);
    controllers.push(new AgentController(store, registry));
  }
  const follower = controllers[1], run = follower.createRun({ title: "Shared sessions", adminKey: "fixture-admin" });
  const agent = follower.registerAgent({ runId: run.run_id, backend: "codex-session", title: "Imported", status: "completed", backendHandle: { thread_id: "fixture-thread" } });
  await vi.advanceTimersByTimeAsync(5_000); expect(watchStatus).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000); expect(watchStatus).toHaveBeenCalledTimes(1);
  const unwatch = watchStatus.mock.results[0].value;
  stores[1].updateAgent(agent.agent_id, { unregisteredAt: new Date().toISOString() });
  await vi.advanceTimersByTimeAsync(5_000); expect(unwatch).toHaveBeenCalledTimes(1);
  expect(watchStatus).toHaveBeenCalledTimes(1);
});
