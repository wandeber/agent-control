import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { approvalRuntime } from "./fixtures/approval-runtime.js";
import { withMcpCaller } from "../src/core/caller-context.js";
import { handleTool } from "../src/tools/handlers.js";
import { prepareLaunchOwner } from "../src/core/launch-context.js";
import { RunWakePolicy } from "../src/core/run-wake-policy.js";

let r: Awaited<ReturnType<typeof approvalRuntime>>;
beforeEach(async () => { vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "operator-test-key"); vi.stubEnv("CODEX_THREAD_ID", "requester"); r = await approvalRuntime(); });
afterEach(async () => { await r.close(); vi.unstubAllEnvs(); });
const auth = { adminKey: "operator-test-key" };
function observe() { return r.controller.observeRun({ runId: r.run.run_id, threadId: "requester", ...auth }); }
async function permission() { await r.launch(); r.emit(); await expect.poll(() => r.controller.listPermissions(r.run.run_id, auth).requests.length).toBe(1); return r.controller.listPermissions(r.run.run_id, auth).requests[0]; }

describe("operator controls", () => {
  it("requires a pinned original requester; worker observation and forged roles cannot confer authority", async () => {
    const worker = r.controller.registerAgent({ runId: r.run.run_id, backend: "codex-thread", title: "Worker", role: "orchestrator", backendHandle: { thread_id: "worker" }, ...auth });
    r.controller.observeRun({ runId: r.run.run_id, threadId: "worker", agentToken: worker.agent_token });
    await expect(withMcpCaller({ threadId: "worker" }, () => handleTool(r.controller, "permission_list", { run_id: r.run.run_id }))).rejects.toThrow("original Codex requester");
    expect(() => withMcpCaller({ threadId: "worker" }, () => r.controller.authorizeRunOperator(r.run.run_id, { agentToken: worker.agent_token }))).toThrow("Worker tokens");
    expect(() => r.controller.authorizeRunOperator(r.run.run_id)).toThrow("original Codex requester");
    const observer = r.controller.observeRun({ runId: r.run.run_id, threadId: "worker", agentToken: worker.agent_token });
    await expect(withMcpCaller({ threadId: "worker" }, () => r.controller.startAgent({ agentId: observer.observer_agent_id, prompt: "No work" }))).rejects.toThrow();
    expect(() => withMcpCaller({ threadId: "worker" }, () => r.controller.authorizeRunOperator(r.run.run_id))).toThrow("original Codex requester");
  });
  it("pins a privileged bootstrap and inherits only its actual parent's operator", () => {
    const owner = withMcpCaller({ threadId: "new-requester" }, () => prepareLaunchOwner(r.controller, { title: "New launch", repoDir: r.root, ...auth }));
    const observation = r.controller.ensureRequester(owner.runId, { agentToken: owner.agentToken })!;
    expect(observation.thread_id).toBe("new-requester");
    expect(() => withMcpCaller({ threadId: "new-requester" }, () => r.controller.authorizeRunOperator(owner.runId))).not.toThrow();
    const child = r.controller.createRun({ title: "Child", agentToken: owner.agentToken });
    r.controller.ensureRequester(child.run_id, { requesterThreadId: "forged", agentToken: owner.agentToken });
    expect(() => withMcpCaller({ threadId: "new-requester" }, () => r.controller.authorizeRunOperator(child.run_id))).not.toThrow();
    expect(() => withMcpCaller({ threadId: "forged" }, () => r.controller.authorizeRunOperator(child.run_id))).toThrow();
  });
  it("fails explicit bad credentials instead of falling back to a valid MCP requester", () => {
    observe();
    expect(() => withMcpCaller({ threadId: "requester" }, () => r.controller.authorizeRunOperator(r.run.run_id))).not.toThrow();
    expect(() => withMcpCaller({ threadId: "requester" }, () => r.controller.authorizeRunOperator(r.run.run_id, { adminKey: "bad" }))).toThrow("Invalid administrator");
    expect(() => withMcpCaller({}, () => r.controller.authorizeRunOperator(r.run.run_id))).toThrow("original Codex requester");
  });
  it("shares the actual native decision through CLI, MCP and UI CAS and recovers its receipt after completion", async () => {
    observe(); const p = await permission();
    expect(JSON.stringify(r.controller.listPermissions(r.run.run_id, auth))).not.toMatch(/connection_id|rpc_id|response_json/);
    const out = await promisify(execFile)(process.execPath, [resolve("dist/cli.js"), "permission", "decide", "--agent", r.agent.agent_id, "--request", p.request_id, "--decision", "approve"], { env: { ...process.env, AGENT_CONTROL_DB: r.dbPath, AGENT_CONTROL_HOME: r.root } });
    expect(JSON.parse(out.stdout)).toMatchObject({ request_id: p.request_id, decision: "approve", state: "submitting" });
    await expect.poll(() => r.responses).toEqual([{ id: 0, result: { decision: "accept" } }]);
    await expect.poll(() => r.controller.listPermissions(r.run.run_id, auth).requests[0].state).toBe("resolved");
    r.store.updateAgent(r.agent.agent_id, { backendHandle: { thread_id: "next-session" }, status: "completed" });
    const receipt = await withMcpCaller({ threadId: "requester" }, () => handleTool(r.controller, "permission_decide", { agent_id: r.agent.agent_id, request_id: p.request_id, decision: "approve" }));
    expect(receipt).toMatchObject({ state: "resolved", decision: "approve" }); expect(r.responses).toHaveLength(1);
    expect(() => r.controller.decidePermission(r.agent.agent_id, p.request_id, "reject")).toThrow();
  });
  it("patches positions atomically, persists across controllers, and rejects foreign/duplicate/invalid/stale updates", async () => {
    observe(); const runId = r.run.run_id;
    const point = { agent_id: r.agent.agent_id, x: -120, y: 350 };
    await withMcpCaller({ threadId: "requester" }, () => handleTool(r.controller, "canvas_positions_set", { run_id: runId, expected_revision: 0, positions: [point] }));
    const foreignRun = r.controller.createRun({ title: "Other", ...auth });
    const foreign = r.controller.registerAgent({ runId: foreignRun.run_id, backend: "codex-thread", title: "Other", ...auth });
    for (const points of [[{ ...point, x: 50 }, { ...point, agent_id: foreign.agent_id }], [point, point], [{ ...point, x: Infinity }]]) expect(() => r.controller.setCanvasPositions(runId, 1, points)).toThrow();
    expect(() => r.controller.setCanvasPositions(runId, 0, [point])).toThrow("Canvas changed");
    const result = await promisify(execFile)(process.execPath, [resolve("dist/cli.js"), "canvas", "positions", "get", "--run", runId], { env: { ...process.env, AGENT_CONTROL_DB: r.dbPath, AGENT_CONTROL_HOME: r.root } });
    expect(JSON.parse(result.stdout)).toMatchObject({ revision: 1, positions: [point], coordinate_space: "run" });
    expect(r.controller.getDashboardSnapshot(runId).canvas_positions?.positions).toEqual([point]);
  });
  it("wakes the requester for live permission events and recovers them on late attach", async () => {
    const observer = observe(); const p = await permission(); await r.controller.refreshAgentStatus(r.agent.agent_id);
    const event = r.controller.getDashboardSnapshot(r.run.run_id).latest_events.find(item => item.payload.permission_request_id === p.request_id)!;
    const policy = new RunWakePolicy(r.store), agent = r.controller.getAgent(observer.observer_agent_id);
    // A flow coordinator does not suppress the original requester's permission decision.
    vi.spyOn(r.store, "listFlowInstances").mockReturnValue([{ flow_instance_id: "active-flow", status: "active" }] as any);
    vi.spyOn(r.store, "listFlowStepInstances").mockReturnValue([{ agent_id: r.agent.agent_id }] as any);
    expect(policy.wakes(event, agent, [])).toBe(true);
    expect(policy.initialSequence(r.run.run_id, agent, [], Number.MAX_SAFE_INTEGER)).toBeLessThan(Number.MAX_SAFE_INTEGER);
    r.controller.decideOperatorPermission(r.agent.agent_id, p.request_id, "reject", auth);
    expect(policy.wakes(event, agent, [])).toBe(false);
    expect(policy.initialSequence(r.run.run_id, agent, [], 999999999)).toBe(999999999);
  });
});
