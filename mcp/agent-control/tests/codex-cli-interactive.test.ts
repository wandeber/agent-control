import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInteractiveProfile, interactiveProfileOverrides } from "../src/adapters/codex-interactive-profile.js";
import { CodexAppServerClient } from "../src/adapters/codex-thread-adapter.js";
import { PermissionRequests, permissionOwnerMatches } from "../src/core/permission-requests.js";
import { approvalRuntime } from "./fixtures/approval-runtime.js";

const roots: string[] = [];
let runtime: Awaited<ReturnType<typeof approvalRuntime>> | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temp = () => { const path = mkdtempSync(join(tmpdir(), "ac-interactive-test-")); roots.push(path); return path; };

it("preserves profile identity, nested project precedence and disabled layers", () => {
  const profile = { model: "requested", features: { browser_use: true, memories: false }, mcp_servers: { "server.with.dots": { enabled: true } } };
  const config = interactiveProfileOverrides(profile, { layers: [
    { name: { type: "project" }, config: { model: "untrusted" }, disabledReason: "Untrusted project" },
    { name: { type: "project" }, config: { model: "nearest", features: { browser_use: false } } },
    { name: { type: "project" }, config: { model: "parent", features: { apps: false } } },
    { name: { type: "user" }, config: { model: "base" } }
  ] });
  expect(config).toEqual({ model: "nearest", features: { browser_use: false, memories: false, apps: false }, mcp_servers: profile.mcp_servers });
  expect(profile.model).toBe("requested");
  expect(() => interactiveProfileOverrides(profile, {})).toThrow("precedence");
});

it("accepts the path-free profile subset and rejects drift or settings it cannot preserve", () => {
  const path = join(temp(), "fixture.config.toml");
  writeFileSync(path, 'model="fixture"\nmodel_provider="local"\n[features]\nbrowser_use=true\n[mcp_servers.browser]\nenabled=true\n[sandbox_workspace_write]\nnetwork_access=false\n');
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  expect(readInteractiveProfile(path, hash)).toMatchObject({ model: "fixture", sandbox_workspace_write: { network_access: false } });
  writeFileSync(path, 'model="changed"\n');
  expect(() => readInteractiveProfile(path, hash)).toThrow("changed");
  writeFileSync(path, '[mcp_servers.browser]\ncommand="./relative-command"\n');
  expect(() => readInteractiveProfile(path)).toThrow("mcp_servers.browser");
});

it("binds CLI approval to the registered private runtime and exact native turn", () => {
  const dir = temp();
  const agent = { backend: "codex-cli", backend_handle: { dir } };
  const request = { thread_id: "same-session", turn_id: "native-turn" };
  writeFileSync(join(dir, "state.json"), JSON.stringify({ transport: "app-server", status: "running", thread_id: request.thread_id, runtime_turn_id: request.turn_id }));
  expect(permissionOwnerMatches(agent, request)).toBe(true);
  expect(permissionOwnerMatches(agent, { ...request, turn_id: "other-turn" })).toBe(false);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ transport: "app-server", status: "completed", thread_id: request.thread_id, runtime_turn_id: request.turn_id }));
  expect(permissionOwnerMatches(agent, request)).toBe(false);
});

it("holds the cancellation fence through one wire decision", async () => {
  const r = runtime = await approvalRuntime();
  const store = new PermissionRequests(r.store.db);
  r.store.updateAgent(r.agent.agent_id, { status: "running", backendHandle: { thread_id: "owned-thread" } });
  store.create("owned-connection", 0, { agent_id: r.agent.agent_id, thread_id: "owned-thread", turn_id: "turn", item_id: "item", kind: "command", title: "Fixture", reason: null,
    scope: { command: "fixture" }, scope_complete: true, choices: ["approve", "reject"] });
  const request = store.list([r.agent.agent_id])[0];
  store.decide(request.request_id, r.agent.agent_id, "approve");
  const second = new Database(r.dbPath); second.pragma("busy_timeout=0");
  let writes = 0;
  try {
    store.dispatchDecisions("owned-connection", () => {
      expect(() => second.prepare("update agents set status='stopping' where agent_id=?").run(r.agent.agent_id)).toThrow(/locked/);
      writes++;
    });
    store.dispatchDecisions("owned-connection", () => { writes++; });
    expect(writes).toBe(1);
    second.prepare("update agents set status='stopping' where agent_id=?").run(r.agent.agent_id);
    expect(store.dispatchDecisions("owned-connection", () => { writes++; })).toEqual([]);
    expect(store.get(request.request_id)?.state).toBe("unavailable");
  } finally { second.close(); }
});

it("waits for an owned stdio process that ignores graceful termination before releasing it", async () => {
  const dir = temp(), pidFile = join(dir, "pid");
  const script = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM',()=>{}); const readline=require('node:readline').createInterface({input:process.stdin}); readline.on('line',line=>{const request=JSON.parse(line); if(request.id!==undefined) process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n');}); setInterval(()=>{},1000);`;
  const client = new CodexAppServerClient("stdio://", undefined, { executable: process.execPath, args: ["-e", script, pidFile], cwd: dir, detached: true });
  try {
    await client.initialize();
    const pid = Number(readFileSync(pidFile, "utf8"));
    await client.closeAndWait();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await client.closeAndWait(); }
});
