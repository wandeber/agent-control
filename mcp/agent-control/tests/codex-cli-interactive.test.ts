import { afterEach, expect, it, vi } from "vitest";
import { runInteractiveCliTurn } from "../src/adapters/codex-cli-interactive.js";
import { AgentAccessStore } from "../src/core/agent-access.js";
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
afterEach(async () => { await runtime?.close(); runtime = undefined; vi.unstubAllEnvs(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
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

it("passes the controller home, database, and worker credential to owned app-server processes", async () => {
  const dir = temp();
  vi.stubEnv("AGENT_CONTROL_HOME", join(dir, "home"));
  vi.stubEnv("AGENT_CONTROL_DB", join(dir, "controller.sqlite"));
  vi.stubEnv("AGENT_CONTROL_TOKEN", "worker-token");
  const script = `const readline=require('node:readline').createInterface({input:process.stdin}); readline.on('line',line=>{const request=JSON.parse(line); if(request.id!==undefined) process.stdout.write(JSON.stringify({id:request.id,result:{home:process.env.AGENT_CONTROL_HOME,db:process.env.AGENT_CONTROL_DB,token:process.env.AGENT_CONTROL_TOKEN}})+'\\n');});`;
  const client = new CodexAppServerClient("stdio://", undefined, {
    executable: process.execPath,
    args: ["-e", script],
    cwd: dir
  });
  try {
    await client.initialize();
    await expect(client.request("environment/read", {})).resolves.toEqual({
      home: join(dir, "home"),
      db: join(dir, "controller.sqlite"),
      token: "worker-token"
    });
  } finally {
    await client.closeAndWait();
  }
});

it.each(["read_only", "workspace"] as const)("caps a resumed flow %s phase despite broader persisted access", async sandbox => {
 const dir = temp(), executable = join(dir, 'fixture-codex'), callsPath = join(dir, 'calls.jsonl');
 const dbPath = join(dir, 'state.sqlite'), db = new Database(dbPath);
 const access = new AgentAccessStore(db);
 access.requestAgentAccess('owner', { sandbox: 'full_access', approval_policy: 'on-request' }, 0);
 // The protocol fixture deliberately returns the old, broader policy on resume.
 // The next turn must carry the phase boundary explicitly, not echo that policy.
 writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({input: process.stdin});
let policy = {type:'workspaceWrite', writableRoots:['/old-root'], networkAccess:false, excludeSlashTmp:true};
let approval = 'on-request';
lines.on('line', line => {
 const request = JSON.parse(line);
 if (request.id === undefined) return;
 fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(request) + '\\n');
 let result = {};
 if (request.method === 'thread/resume') result = {thread:{id:'same-thread'}, cwd:${JSON.stringify(dir)}, model:'fixture', modelProvider:'local', approvalPolicy:approval, sandbox:policy};
 if (request.method === 'turn/start') {
  policy = request.params.sandboxPolicy; approval = request.params.approvalPolicy;
  result = {turn:{id:'next-turn',status:'completed'}};
 }
 process.stdout.write(JSON.stringify({id:request.id,result}) + '\\n');
});`, { mode: 0o700 });
 const events: Record<string, unknown>[] = [], threads: string[] = [];
 try {
  const result = await runInteractiveCliTurn({ executable, cwd: dir, prompt: 'next phase', model: 'fixture', model_provider: 'local', model_provider_override: 'local',
   sandbox, approval_policy: 'on-request', agent_id: 'owner', db_path: dbPath,
   flow_instance_id: 'flow', flow_writable_root: join(dir, 'artifacts') }, {
    session: 'same-thread', event: event => events.push(event), thread: id => threads.push(id),
    turn: () => {}, heartbeat: () => {}, stop: () => undefined, dispatch: send => send()
   });
  expect(result).toEqual({thread_id:'same-thread',status:'completed'});
  expect(threads).toEqual(['same-thread']);
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.some(call => call.method === 'thread/start')).toBe(false);
  expect(calls.find(call => call.method === 'thread/resume').params.config).toMatchObject({model_provider:'local'});
  const turn = calls.filter(call => call.method === 'turn/start');
  expect(turn).toHaveLength(1);
  if (sandbox === 'read_only') {
   expect(turn[0].params).toMatchObject({approvalPolicy:'never',sandboxPolicy:{type:'readOnly'}});
   expect(turn[0].params.sandboxPolicy).toEqual({type:'readOnly'});
  } else {
   expect(turn[0].params.sandboxPolicy).toEqual({type:'workspaceWrite',writableRoots:[dir,join(dir,'artifacts')],networkAccess:false,excludeSlashTmp:true});
  }
  expect(access.getAgentAccess('owner')).toMatchObject({state:'pending',effective_revision:null});
  expect(events.some(event => event.type === 'error')).toBe(false);
 } finally { db.close(); }
});
