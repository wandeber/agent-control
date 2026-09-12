import { afterEach, describe, expect, it } from "vitest";
import { approvalRuntime } from "./fixtures/approval-runtime.js";
import { PermissionRequests } from "../src/core/permission-requests.js";
import { startControlServer } from "../src/control-server.js";
import type { AddressInfo } from "node:net";

let runtime: Awaited<ReturnType<typeof approvalRuntime>> | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });
async function ready() { runtime = await approvalRuntime(); await runtime.launch(); return runtime; }
async function request(r: Awaited<ReturnType<typeof ready>>, id = 0) {
  r.emit(id);
  await expect.poll(() => r.controller.getDashboardSnapshot(r.run.run_id).permission_requests?.length).toBe(id + 1);
  return r.controller.getDashboardSnapshot(r.run.run_id).permission_requests!.at(-1)!;
}

describe("real Codex approval callbacks", () => {
  it("shares a single CAS decision, preserves numeric zero, and resolves only after backend acknowledgement", async () => {
    const r = await ready(), p = await request(r);
    expect(r.calls.find(call => call.method === "turn/start")?.params.approvalPolicy).toBe("on-request");
    expect(p).toMatchObject({ state: "pending", scope_complete: true, scope: { command: "printf 'Protocol fixture only\\n'" } });
    const selected = r.controller.decidePermission(r.agent.agent_id, p.request_id, "approve");
    expect(selected.state).toBe("submitting");
    expect(() => r.controller.decidePermission(r.agent.agent_id, p.request_id, "reject")).toThrow("no longer pending");
    await expect.poll(() => r.responses).toEqual([{ id: 0, result: { decision: "accept" } }]);
    await expect.poll(() => r.controller.getDashboardSnapshot(r.run.run_id).permission_requests![0].state).toBe("resolved");
  });
  it("denies requested permissions with the actual permissions response shape", async () => {
    const r = await ready(); r.emit(7, "item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
    await expect.poll(() => r.controller.getDashboardSnapshot(r.run.run_id).permission_requests?.length).toBe(1);
    const p = r.controller.getDashboardSnapshot(r.run.run_id).permission_requests![0];
    r.controller.decidePermission(r.agent.agent_id, p.request_id, "reject");
    await expect.poll(() => r.responses).toEqual([{ id: 7, result: { permissions: {}, scope: "turn" } }]);
  });
  it("reads the exact file item and disables approval for missing scope", async () => {
    const r = await ready(); r.emit(4, "item/fileChange/requestApproval", {});
    await expect.poll(() => r.controller.getDashboardSnapshot(r.run.run_id).permission_requests?.length).toBe(1);
    const p = r.controller.getDashboardSnapshot(r.run.run_id).permission_requests![0];
    expect(p.scope_complete).toBe(false);
    expect(() => r.controller.decidePermission(r.agent.agent_id, p.request_id, "approve")).toThrow("visible request scope");
    r.controller.decidePermission(r.agent.agent_id, p.request_id, "reject");
    await expect.poll(() => r.responses.length).toBe(1);
  });
  it("never sends a decision after durable cancellation or a stale lease", async () => {
    const r = await ready(), p = await request(r);
    r.controller.decidePermission(r.agent.agent_id, p.request_id, "approve");
    r.store.updateAgent(r.agent.agent_id, { status: "stopping" });
    await expect.poll(() => r.controller.getDashboardSnapshot(r.run.run_id).permission_requests![0].state).toBe("unavailable");
    expect(r.responses).toEqual([]);
    const row = new PermissionRequests(r.store.db).get(p.request_id)!;
    r.store.db.prepare("update permission_requests set state='pending', lease_until=? where request_id=?").run(Date.now() - 1, p.request_id);
    new PermissionRequests(r.store.db).heartbeat(row.connection_id);
    expect(new PermissionRequests(r.store.db).get(p.request_id)?.state).toBe("unavailable");
  });
  it("emits each request independently while the agent remains waiting", async () => {
    const r = await ready(); await request(r); await r.controller.refreshAgentStatus(r.agent.agent_id);
    expect(r.controller.getAgent(r.agent.agent_id).status).toBe("waiting_for_input");
    await request(r, 1); await r.controller.refreshAgentStatus(r.agent.agent_id);
    const events = r.controller.getDashboardSnapshot(r.run.run_id).latest_events.filter(event => event.payload.reason === "backend_permission_request_updated");
    expect(new Set(events.map(event => event.payload.permission_request_id)).size).toBe(2);
    await r.controller.refreshAgentStatus(r.agent.agent_id);
    expect(r.controller.getDashboardSnapshot(r.run.run_id).latest_events.filter(event => event.payload.reason === "backend_permission_request_updated")).toHaveLength(2);
  });
  it("invalidates disconnected requests instead of replaying their IDs", async () => {
    const r = await ready(); await request(r); r.disconnect();
    await expect.poll(() => r.controller.getDashboardSnapshot(r.run.run_id).permission_requests![0].state).toBe("unavailable");
    expect(r.responses).toEqual([]);
  });
  it("requires actual configured browser origin and a scoped capability", async () => {
    const r = await ready(), p = await request(r);
    const oldHome = process.env.AGENT_CONTROL_HOME, oldDb = process.env.AGENT_CONTROL_DB;
    process.env.AGENT_CONTROL_HOME = r.root; process.env.AGENT_CONTROL_DB = r.dbPath;
    const api = await startControlServer({ host: "localhost", port: 0 }); api.setUiOrigin("http://localhost:3888");
    const base = `http://localhost:${(api.server.address() as AddressInfo).port}/api/control/permissions`;
    const body = JSON.stringify({ agent_id: r.agent.agent_id, request_id: p.request_id, decision: "reject" });
    const call = (route: string, headers = {}) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    try {
      expect((await call("access", { origin: "https://unrelated.example" })).status).toBe(403);
      const headers = { origin: "http://localhost:3888" };
      expect((await call("decide", headers)).status).toBe(403);
      const access = await call("access", headers); expect(access.status).toBe(200);
      const { token } = await access.json() as { token: string };
      expect((await call("decide", { ...headers, "X-Agent-Control-Permission": token })).status).toBe(200);
      await expect.poll(() => r.responses).toEqual([{ id: 0, result: { decision: "decline" } }]);
    } finally { await api.close(); if (oldHome === undefined) delete process.env.AGENT_CONTROL_HOME; else process.env.AGENT_CONTROL_HOME = oldHome; if (oldDb === undefined) delete process.env.AGENT_CONTROL_DB; else process.env.AGENT_CONTROL_DB = oldDb; }
  });
});

it("uses native cancel when decline is unavailable and preserves recoverable continuation", async () => {
  const r = await ready(); r.emit(8, "item/commandExecution/requestApproval", { command: "printf fixture", cwd: r.root,
    availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["printf"] } }, "cancel"] });
  await expect.poll(() => r.controller.getDashboardSnapshot(r.run.run_id).permission_requests?.length).toBe(1);
  const p = r.controller.getDashboardSnapshot(r.run.run_id).permission_requests![0];
  expect(p).toMatchObject({ reject_interrupts_turn: true, choices: ["approve", "reject"] });
  r.controller.decidePermission(r.agent.agent_id, p.request_id, "reject");
  await expect.poll(() => r.responses).toEqual([{ id: 8, result: { decision: "cancel" } }]);
  expect((await r.controller.refreshAgentStatus(r.agent.agent_id)).status).toBe("waiting_for_input");
  await r.controller.sendMessage(r.agent.agent_id, "Continue after rejected command");
  expect(r.controller.getAgent(r.agent.agent_id).status).toBe("running");
});

it("wakes the same default control observer for consecutive permission requests", async () => {
  const r = await ready();
  const observer = r.controller.observeRun({ runId: r.run.run_id, threadId: "permission-observer-fixture", agentToken: r.controller.issueAgentToken(r.agent.agent_id) });
  const wait = (cursor: string) => r.controller.waitForRun({ runId: r.run.run_id, observerAgentId: observer.observer_agent_id, cursor, timeoutMs: 100, intervalMs: 10 });
  await request(r); await r.controller.refreshAgentStatus(r.agent.agent_id);
  const first = await wait(observer.cursor);
  expect(first.timed_out).toBe(false);
  await request(r, 1); await r.controller.refreshAgentStatus(r.agent.agent_id);
  const second = await wait(first.cursor);
  expect(second.timed_out).toBe(false);
  expect(second.events.some(event => event.type === "agent.status_changed")).toBe(true);
});
