import { afterEach, expect, it } from "vitest";
import { AgentAccessStore, accessTurnOverrides } from "../src/core/agent-access.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { approvalRuntime } from "./fixtures/approval-runtime.js";
let runtime: Awaited<ReturnType<typeof approvalRuntime>> | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });
it("keeps intent, exact effective scope, and revision CAS distinct", () => {
  const db = new SqliteStore(":memory:"), store = new AgentAccessStore(db.db);
  try {
    const policy = { sandbox: "workspace", approval_policy: "on-request" } as const;
    expect(store.getAgentAccess("worker")).toMatchObject({ requested: null, effective: null, state: "unverified" });
    const first = store.requestAgentAccess("worker", policy, 0);
    expect(first).toMatchObject({ revision: 1, effective: null, state: "pending" });
    expect(() => store.requestAgentAccess("worker", policy, 0)).toThrow("changed");
    const expected = accessTurnOverrides(policy, "/repo");
    expect(store.confirmAgentAccess("worker", 1, { thread_id: "exact", approval_policy: "on-request", sandbox_policy: { ...expected.sandboxPolicy, writableRoots: ["/other"] } }, expected).state).toBe("pending");
    const confirmed = store.confirmAgentAccess("worker", 1, { thread_id: "exact", approval_policy: "on-request", sandbox_policy: { ...expected.sandboxPolicy, excludeSlashTmp: false } }, expected);
    expect(confirmed).toMatchObject({ state: "applied", effective_revision: 1 });
    store.requestAgentAccess("worker", { sandbox: "read_only", approval_policy: "never" }, 1);
    expect(store.confirmAgentAccess("worker", 1, { thread_id: "stale", approval_policy: "never", sandbox_policy: { type: "dangerFullAccess" } }, expected)).toMatchObject({ state: "pending", revision: 2, effective: { thread_id: "exact" } });
  } finally { db.close(); }
});
it("applies requested access at the next turn and confirms the backend echo", async () => {
  const r = runtime = await approvalRuntime();
  r.controller.requestAgentAccess(r.agent.agent_id, { sandbox: "read_only", approval_policy: "untrusted" }, 0);
  expect(r.calls.filter(call => call.method === "turn/start")).toEqual([]);
  await r.launch();
  expect(r.calls.find(call => call.method === "turn/start")?.params).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" } });
  expect(r.controller.getAgentAccess(r.agent.agent_id)).toMatchObject({ state: "applied", effective_revision: 1, effective: { approval_policy: "untrusted", sandbox_policy: { type: "readOnly" } } });
  r.controller.requestAgentAccess(r.agent.agent_id, { sandbox: "full_access", approval_policy: "never" }, 1);
  expect(r.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  expect(r.controller.getAgentAccess(r.agent.agent_id)).toMatchObject({ state: "pending", effective: { sandbox_policy: { type: "readOnly" } } });
});
it("does not apply changed access while steering an active turn", async () => {
  const r = runtime = await approvalRuntime(); await r.launch();
  r.controller.requestAgentAccess(r.agent.agent_id, { sandbox: "full_access", approval_policy: "never" }, 0);
  await r.controller.sendMessage(r.agent.agent_id, "Continue the same active turn");
  const calls = r.calls.filter(call => call.method === "turn/start");
  expect(calls.at(-1)?.params).not.toHaveProperty("sandboxPolicy");
  expect(calls.at(-1)?.params).not.toHaveProperty("approvalPolicy");
  expect(r.controller.getAgentAccess(r.agent.agent_id).state).toBe("pending");
});
it("keeps first-turn approval alive before the controller commits its handle and handles colliding RPC IDs", async () => {
  const r = runtime = await approvalRuntime({ earlyApproval: true }); await r.launch();
  await expect.poll(() => r.controller.getDashboardSnapshot(r.run.run_id).permission_requests?.length).toBe(1);
  const request = r.controller.getDashboardSnapshot(r.run.run_id).permission_requests![0];
  expect(request.state).toBe("pending");
  r.controller.decidePermission(r.agent.agent_id, request.request_id, "reject");
  await expect.poll(() => r.responses.length).toBe(1);
  expect(r.responses[0].result).toEqual({ decision: "decline" });
});
it("recognizes only a verified implicit cwd when the backend canonicalizes workspace roots", () => {
  const db = new SqliteStore(":memory:"), store = new AgentAccessStore(db.db);
  try {
    const policy = { sandbox: "workspace", approval_policy: "on-request" } as const;
    store.requestAgentAccess("worker", policy, 0);
    const effective = { thread_id: "exact", approval_policy: "on-request", sandbox_policy: { type: "workspaceWrite", writableRoots: [], networkAccess: true } };
    const expected = accessTurnOverrides(policy, "/repo");
    expect(store.confirmAgentAccess("worker", 1, effective, expected).state).toBe("pending");
    expect(store.confirmAgentAccess("worker", 1, effective, { ...expected, implicitCwd: "/repo" }).state).toBe("applied");
    expect(store.getAgentAccess("worker").effective?.sandbox_policy.writableRoots).toEqual([]);
  } finally { db.close(); }
});

it("never reapplies stale handle defaults after a confirmed access change", async () => {
  const r = runtime = await approvalRuntime();
  r.controller.requestAgentAccess(r.agent.agent_id, { sandbox: "read_only", approval_policy: "untrusted" }, 0);
  await r.launch();
  expect(r.controller.getAgentAccess(r.agent.agent_id).state).toBe("applied");
  await r.controller.sendMessage(r.agent.agent_id, "Continue the active read-only turn");
  const last = r.calls.filter(call => call.method === "turn/start").at(-1)!;
  expect(last.params).not.toHaveProperty("sandboxPolicy"); expect(last.params).not.toHaveProperty("approvalPolicy");
  expect(r.controller.getAgentAccess(r.agent.agent_id)).toMatchObject({ state: "applied", effective: { approval_policy: "untrusted", sandbox_policy: { type: "readOnly" } } });
});

it("enables approvals on a default-never worker and keeps native rejection recoverable", async () => {
  const r = runtime = await approvalRuntime({ defaultApproval: "never" }); await r.launch();
  expect(r.controller.getAgent(r.agent.agent_id).backend_handle).not.toHaveProperty("approval_agent_id");
  r.complete(); await r.controller.refreshAgentStatus(r.agent.agent_id);
  r.controller.requestAgentAccess(r.agent.agent_id, { sandbox: "read_only", approval_policy: "on-request" }, 0);
  await r.controller.sendMessage(r.agent.agent_id, "Begin the next turn with approvals");
  r.emit(0, "item/commandExecution/requestApproval", { command: "printf fixture", cwd: r.root, availableDecisions: ["accept", "cancel"] });
  await expect.poll(() => r.controller.getDashboardSnapshot(r.run.run_id).permission_requests?.length).toBe(1);
  const request = r.controller.getDashboardSnapshot(r.run.run_id).permission_requests![0];
  r.controller.decidePermission(r.agent.agent_id, request.request_id, "reject");
  await expect.poll(() => r.responses.length).toBe(1);
  expect((await r.controller.refreshAgentStatus(r.agent.agent_id)).status).toBe("waiting_for_input");
  await r.controller.sendMessage(r.agent.agent_id, "Continue on the same thread");
  expect(r.controller.getAgent(r.agent.agent_id).backend_handle?.thread_id).toBe("fixture-thread");
});
