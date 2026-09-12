import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../src/adapters/codex-thread-adapter.js";
import { CodexSessionAdapter, readCodexSession, sessionBaseline, sessionUsage } from "../src/adapters/codex-session.js";
import { createDefaultAdapterRegistry } from "../src/adapters/registry.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AgentController } from "../src/core/controller.js";
import { attachWorkerTool } from "../src/tools/attach.js";
import { withMcpCaller } from "../src/core/caller-context.js";

const thread = "11111111-1111-4111-8111-111111111111";
const requester = "22222222-2222-4222-8222-222222222222";
describe("existing Codex session observation", () => {
  let home: string, path: string, controller: AgentController, store: SqliteStore;
  const row = (type: string, payload: unknown) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + "\n";
  const usage = (input: number) => row("event_msg", { type: "token_count", info: { total_token_usage: {
    input_tokens: input, cached_input_tokens: input / 2, cache_write_input_tokens: 0, output_tokens: input / 10,
    reasoning_output_tokens: input / 20, total_tokens: input * 1.1 } } });
  beforeEach(() => {
    vi.spyOn(CodexAppServerClient.prototype, "initialize").mockResolvedValue();
    vi.spyOn(CodexAppServerClient.prototype, "request").mockRejectedValue(new Error("Control endpoint disconnected"));
    home = mkdtempSync(join(tmpdir(), "codex-attach-"));
    vi.stubEnv("CODEX_HOME", home); vi.stubEnv("AGENT_CONTROL_HOME", home); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "test-admin");
    mkdirSync(join(home, "sessions")); path = join(home, "sessions", `rollout-${thread}.jsonl`);
    writeFileSync(path, row("session_meta", { id: thread, cwd: home, model_provider: "openai" }) + row("turn_context", { model: "yoda" }) + usage(100));
    store = new SqliteStore(join(home, "state.sqlite")); controller = new AgentController(store, createDefaultAdapterRegistry());
  });
  afterEach(async () => { await controller.dispose(); store.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
  it("attaches an active session once and returns completion events without launching any work", async () => {
    appendFileSync(path, row("event_msg", { type: "task_started", turn_id: "turn-1" }));
    const attach = (extra = {}) => withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: thread, ...extra }));
    const first = await attach();
    expect(first.agent.status).toBe("running"); expect(first.observer?.thread_id).toBe(requester);
    expect(first.capabilities.stop).toBe(false);
    const again = await attach({ run_id: first.run_id });
    expect(again.reused).toBe(true); expect(again.agent.agent_id).toBe(first.agent.agent_id);
    expect(controller.listAgents({ runId: first.run_id }).filter(a => a.backend_handle?.thread_id === thread)).toHaveLength(1);
    const observation = first.observer!;
    appendFileSync(path, row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "DONE" }] }) + usage(200) + row("event_msg", { type: "task_complete", turn_id: "turn-1" }));
    await controller.refreshAgentStatus(first.agent.agent_id);
    const result = await controller.waitForRun({ runId: first.run_id, observerAgentId: observation.observer_agent_id, cursor: observation.cursor, timeoutMs: 100 });
    expect(result.events.some(e => e.type === "agent.completed")).toBe(true);
    const adapter = new CodexSessionAdapter(), handle = { backend: adapter.kind, id: thread, data: first.agent.backend_handle! };
    expect((await adapter.readLatest(handle, { limit: 1 }))[0]?.text).toBe("DONE");
    expect(adapter.readUsage(handle)?.input_tokens).toBe(100);
    expect((await adapter.stop(handle)).status).toBe("stopped");
    appendFileSync(path, row("event_msg", { type: "task_started", turn_id: "turn-2" }));
    expect((await controller.refreshAgentStatus(first.agent.agent_id)).status).toBe("running");
  });
  it("reports a local aborted turn as resumable input and wakes the existing control observer", async () => {
    appendFileSync(path, row("event_msg", { type: "task_started", turn_id: "active" }));
    const attached = await withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: thread }));
    appendFileSync(path, row("event_msg", { type: "turn_aborted", turn_id: "active" }));
    const result = await controller.waitForRun({ runId: attached.run_id, observerAgentId: attached.observer!.observer_agent_id,
      cursor: attached.observer!.cursor, timeoutMs: 3000 });
    expect(result.timed_out).toBe(false);
    expect(result.completion).toBeNull();
    expect(controller.getAgent(attached.agent.agent_id).status).toBe("waiting_for_input");
    expect(controller.listEvents({ runId: attached.run_id, limit: 100 }).some(event => event.payload.reason === "turn_interrupted" && event.payload.status === "waiting_for_input")).toBe(true);
  });
  it("interrupts the preferred app-server even while its local rollout still shows an older completed turn", async () => {
    appendFileSync(path, row("event_msg", { type: "task_complete", turn_id: "old" }));
    const request = vi.mocked(CodexAppServerClient.prototype.request);
    request.mockImplementation(async method => method === "thread/read" ? { thread: { id: thread, cwd: home, status: { type: "active" }, turns: [{ id: "new-active", status: "inProgress" }] } } : {});
    const attached = await withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: thread, server: "ws://localhost:1234" }));
    await controller.stopAgent(attached.agent.agent_id, "interrupt");
    expect(request).toHaveBeenCalledWith("turn/interrupt", { threadId: thread, turnId: "new-active" });
  });
  it("requires readable exact identity before creating a run", async () => {
    await expect(attachWorkerTool(controller, { thread_id: requester })).rejects.toThrow("not readable");
    expect(controller.listRuns()).toHaveLength(0);
    expect(readCodexSession("../../other")).toBeNull();
  });
  it("keeps missing terminal evidence unknown and tolerates partial trailing records", async () => {
    appendFileSync(path, '{"type":');
    expect(readCodexSession(thread)?.status).toBe("unknown");
  });
  it("counts native requester usage only after the registration baseline", () => {
    const baseline = sessionBaseline(thread)!;
    appendFileSync(path, usage(200));
    const result = sessionUsage({ backend: "codex-thread", id: thread, data: { thread_id: thread, agent_control_role: "observer", usage_baseline: baseline } });
    expect(result).toMatchObject({ input_tokens: 100, cached_input_tokens: 50, output_tokens: 10, reasoning_output_tokens: 5, model: "yoda" });
    expect(sessionUsage({ backend: "codex-thread", id: thread, data: { thread_id: thread, agent_control_role: "observer" } })).toBeNull();
  });
  it("does not attribute a mixed-model native session's entire cost to the last model", () => {
    appendFileSync(path, row("turn_context", { model: "gpt-6-astra" }) + usage(200));
    expect(sessionUsage({ backend: "codex-thread", id: thread, data: { thread_id: thread } })?.model).toBe("Mixed models");
  });
  it("restores subscriptions after restart and retains every completion between reads", async () => {
    const attached = await withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: thread }));
    await controller.dispose();
    controller = new AgentController(store, createDefaultAdapterRegistry());
    appendFileSync(path, row("event_msg", { type: "task_started", turn_id: "one" }) + row("event_msg", { type: "task_complete", turn_id: "one" }) +
      row("event_msg", { type: "task_started", turn_id: "two" }) + row("event_msg", { type: "task_complete", turn_id: "two" }));
    const observer = attached.observer!;
    const result = await controller.waitForRun({ runId: attached.run_id, observerAgentId: observer.observer_agent_id, cursor: observer.cursor, timeoutMs: 3000 });
    expect(result.events.filter(e => e.type === "agent.completed")).toHaveLength(2);
    await controller.refreshAgentStatus(attached.agent.agent_id);
    expect(controller.listEvents({ runId: attached.run_id, limit: 100 }).filter(e => e.type === "agent.completed")).toHaveLength(2);
  });
  it("keeps failed interruption recoverable and skips the attached worker during run shutdown", async () => {
    appendFileSync(path, row("event_msg", { type: "task_started" }));
    const attached = await withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: thread }));
    await expect(controller.stopAgent(attached.agent.agent_id, "interrupt")).rejects.toThrow("Control endpoint disconnected");
    expect((await controller.refreshAgentStatus(attached.agent.agent_id)).status).toBe("running");
    await controller.shutdownRun(attached.run_id);
    expect(readCodexSession(thread)?.status).toBe("running");
    expect(controller.listEvents({ runId: attached.run_id, limit: 100 }).some(e => e.type === "agent.failed")).toBe(false);
  });
  it("steers and interrupts a loaded owner, then continues its same idle identity", async () => {
    let active = true;
    const request = vi.mocked(CodexAppServerClient.prototype.request);
    request.mockImplementation(async (method) => method === "thread/read" ? { thread: { id: thread, cwd: home, modelProvider: "softec", status: { type: active ? "active" : "idle" }, turns: active ? [{ id: "active-turn", status: "inProgress" }] : [] } } : {});
    const attached = await withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: thread, server: "ws://localhost:1234" }));
    expect(attached.capabilities).toMatchObject({ send_message: true, stop: true, resume: true });
    await controller.sendMessage(attached.agent.agent_id, "Review this finding");
    expect(request).toHaveBeenCalledWith("turn/steer", { threadId: thread, expectedTurnId: "active-turn", input: [{ type: "text", text: "Review this finding", text_elements: [] }] });
    await controller.stopAgent(attached.agent.agent_id, "interrupt");
    expect(request).toHaveBeenCalledWith("turn/interrupt", { threadId: thread, turnId: "active-turn" });
    active = false;
    await controller.sendMessage(attached.agent.agent_id, "Continue");
    expect(request).toHaveBeenCalledWith("turn/start", { threadId: thread, input: [{ type: "text", text: "Continue", text_elements: [] }] });
    expect(request.mock.calls.some(([method]) => method === "thread/start" || method === "thread/resume")).toBe(false);
  });
  it("refuses a duplicate writer at an unrelated endpoint and resumes only after terminal evidence", async () => {
    appendFileSync(path, row("event_msg", { type: "task_started" }));
    const request = vi.mocked(CodexAppServerClient.prototype.request);
    request.mockImplementation(async method => method === "thread/read" ? { thread: { id: thread, modelProvider: "softec", status: { type: "notLoaded" } } } : {});
    const attached = await withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: thread }));
    const adapter = new CodexSessionAdapter();
    const handle = { backend: "codex-session", id: thread, data: { thread_id: thread, cli_configuration_valid: true } };
    await expect(adapter.sendMessage(handle, { message: "Hello" })).rejects.toThrow("does not own the active session");
    expect(request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    appendFileSync(path, row("event_msg", { type: "task_complete" }));
    await adapter.sendMessage(handle, { message: "Continue" });
    expect(request).toHaveBeenCalledWith("thread/resume", { threadId: thread, model: "yoda", modelProvider: "openai", cwd: home });
  });
  it("attaches a remote identity without local files and emits completion from its endpoint", async () => {
    const remoteId = "33333333-3333-4333-8333-333333333333";
    let active = true;
    vi.mocked(CodexAppServerClient.prototype.request).mockImplementation(async () => ({ thread: { id: remoteId, cwd: "/remote/project", status: { type: active ? "active" : "idle" }, turns: [{ id: "remote-turn", status: active ? "inProgress" : "completed", items: [] }] } }));
    const attached = await withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: remoteId, server: "wss://remote.example/control" }));
    expect(attached.agent.backend_handle?.remote_session).toBe(true);
    expect(attached.capabilities.send_message).toBe(true);
    active = false;
    await controller.refreshAgentStatus(attached.agent.agent_id);
    expect(controller.listEvents({ runId: attached.run_id, limit: 100 }).some(event => event.type === "agent.completed")).toBe(true);
    const again = await withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: remoteId, run_id: attached.run_id, server: "wss://other.example/control" }));
    expect(again.agent.agent_id).toBe(attached.agent.agent_id);
    expect(again.agent.backend_handle?.app_server_url).toBe("wss://other.example/control");
  });
  it("wakes on a queue failure once and recovers current status after a later success without deleting history", async () => {
    const attached = await withMcpCaller({ threadId: requester }, () => attachWorkerTool(controller, { thread_id: thread }));
    const queue = join(home, "attached-cli", thread); mkdirSync(queue, { recursive: true });
    writeFileSync(join(queue, "01.json"), JSON.stringify({ state: "failed", id: "01" }));
    expect((await controller.refreshAgentStatus(attached.agent.agent_id)).status).toBe("blocked");
    const observer = attached.observer!;
    const result = await controller.waitForRun({ runId: attached.run_id, observerAgentId: observer.observer_agent_id, cursor: observer.cursor, timeoutMs: 100 });
    expect(result.events.some(event => event.type === "agent.blocked")).toBe(true);
    await controller.refreshAgentStatus(attached.agent.agent_id);
    expect(controller.listEvents({ runId: attached.run_id, limit: 100 }).filter(event => event.type === "agent.blocked")).toHaveLength(1);
    appendFileSync(path, row("event_msg", { type: "task_complete" }));
    writeFileSync(join(queue, "02.json"), JSON.stringify({ state: "completed", id: "02" }));
    expect((await controller.refreshAgentStatus(attached.agent.agent_id)).status).toBe("completed");
    expect(JSON.parse(readFileSync(join(queue, "01.json"), "utf8")).state).toBe("failed");
  });
  it("does not relabel mixed-model usage or charge history when an attached baseline is missing", () => {
    const baseline = { ...sessionBaseline(thread)!, captured_at: "2000-01-01T00:00:00.000Z" };
    appendFileSync(path, row("turn_context", { model: "anakin" }) + usage(200) + row("turn_context", { model: "yoda" }) + usage(300));
    const handle = { backend: "codex-session", id: thread, data: { thread_id: thread, observation_only: true, usage_baseline: baseline } };
    expect(sessionUsage(handle)?.model).toBe("Mixed models");
    expect(sessionUsage({ ...handle, data: { thread_id: thread, observation_only: true } })).toBeNull();
  });
});
