import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentController } from "../src/core/controller.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { agentConversationThreadId } from "../src/core/agent-conversation-identity.js";
import { withMcpCaller } from "../src/core/caller-context.js";
import { agentRuntimePath } from "../src/core/paths.js";
import { handleTool } from "../src/tools/handlers.js";
import type { AgentAdapter, AgentHandle, FlowConfig, StartAgentInput } from "../src/core/types.js";

class CliFixture implements AgentAdapter {
  constructor(readonly kind = "codex-cli") {}
  readonly threads = new Map<string, string>();
  capabilities() { return { canStart: true, canSendMessage: true, canReadLatest: true, canStopGracefully: true, canForceStop: true, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: true }; }
  async start(input: StartAgentInput): Promise<AgentHandle> {
    const thread = this.threads.get(input.agent.agent_id) ?? randomUUID(); this.threads.set(input.agent.agent_id, thread);
    const dir = join(agentRuntimePath(input.agent.run_id, input.agent.agent_id), "codex-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "running", thread_id: thread, turn_id: randomUUID(), transport: "app-server", updated_at: new Date().toISOString() }));
    // The real CLI handle has an execution directory, not a thread_id field.
    return { backend: this.kind, id: input.agent.agent_id, data: { dir, cwd: input.agent.repo_dir, access_agent_id: input.agent.agent_id } };
  }
  async getStatus() { return { status: "running" as const }; }
  async readLatest() { return []; }
  async sendMessage() {}
  async stop() { return { status: "stopped" as const }; }
  async unregister() {}
}

describe("CLI worker authentication through request-scoped MCP metadata", () => {
  let root: string, controller: AgentController, store: SqliteStore, adapter: CliFixture;
  let owner: ReturnType<AgentController["orchestratorLogin"]>;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cli-mcp-auth-")));
    vi.stubEnv("AGENT_CONTROL_HOME", join(root, "control")); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "fixture-admin");
    vi.stubEnv("CODEX_THREAD_ID", ""); vi.stubEnv("AGENT_CONTROL_TOKEN", ""); vi.stubEnv("AGENT_CONTROL_REQUESTER_THREAD_ID", "");
    store = new SqliteStore(join(root, "state.sqlite")); adapter = new CliFixture();
    const registry = new AdapterRegistry(); registry.register(adapter); registry.register(new CliFixture("codex-thread")); registry.register(new CliFixture("codex-session"));
    controller = new AgentController(store, registry);
    owner = controller.orchestratorLogin({ adminKey: "fixture-admin", title: "Owner", runTitle: "CLI auth fixture", repoDir: root, backend: "codex-thread", backendHandle: { thread_id: "original-requester" } });
  });
  afterEach(async () => { await controller.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  function config(): FlowConfig { return { id: "cli-auth", policy: { strict: true, plan_artifact: "plan", work_packages: {
    approval_decision: "plan", manifest_step: "work", execution_step: "work", integration_step: "finish"
  } }, initial_step: "prepare", roles: { author: { backend: "codex-cli" } }, artifacts: { plan: { path: join(root, "plan.md") } }, steps: {
    prepare: { role: "author", sandbox: "read_only", evidence_operations: ["snapshot_artifact"], outputs: { plan: { artifact: "plan", required: true } }, on: { completed: { to: "work" } } },
    approval: { execution: "coordinator", decision: { key: "plan", artifact_key: "plan" } },
    work: { role: "author", sandbox: "workspace", on: { completed: { to: "finish" } } },
    finish: { execution: "coordinator" }
  } }; }
  async function start() {
    const flow = controller.startFlow({ config: config(), runId: owner.run.run_id, agentToken: owner.agent_token, requesterThreadId: "original-requester" });
    const dispatched = await controller.dispatchActiveFlowStep({ flowInstanceId: flow.instance.flow_instance_id, agentToken: owner.agent_token });
    const agent = controller.getAgent(dispatched.agent!.agent_id);
    return { flow, agent, thread: adapter.threads.get(agent.agent_id)!, statePath: join(String(agent.backend_handle!.dir), "state.json") };
  }
  const tool = (thread: string | undefined, name: string, input: Record<string, unknown>) => withMcpCaller(thread ? { threadId: thread } : undefined, () => handleTool(controller, name, input));
  const ask = (agentId: string) => ({ agent_id: agentId, title: "Scope", request_key: "scope", wait: false, questions: [{ id: "scope", prompt: "Which scope should be used?" }] });

  it("authenticates evidence and reporting from the live CLI state without a worker token", async () => {
    const { flow, agent, thread } = await start(); writeFileSync(join(root, "plan.md"), "# Plan\n");
    expect(agent.backend_handle).not.toHaveProperty("thread_id");
    const evidence = await tool(thread, "flow_evidence", { flow_instance_id: flow.instance.flow_instance_id, step_instance_id: flow.active_step!.step_instance_id, key: "plan", request: { operation: "snapshot_artifact", path: join(root, "plan.md") } }) as any;
    expect(evidence.actor_id).toBe(agent.agent_id);
    await expect(tool(randomUUID(), "flow_step_report", { step_instance_id: flow.active_step!.step_instance_id, status: "completed", auto_continue: false })).rejects.toThrow(/authenticated/);
    await tool(thread, "flow_step_report", { step_instance_id: flow.active_step!.step_instance_id, status: "completed", auto_continue: false });
    expect(controller.getFlowSnapshot(flow.instance.flow_instance_id).instance.current_step_id).toBe("work");
  });
  it("does not borrow the daemon's thread, environment token, or model-supplied arguments", async () => {
    const { agent, thread } = await start();
    vi.stubEnv("CODEX_THREAD_ID", thread); vi.stubEnv("AGENT_CONTROL_TOKEN", controller.issueAgentToken(agent.agent_id));
    await expect(tool(undefined, "question_ask", ask(agent.agent_id))).rejects.toThrow(/authenticated/);
    await expect(tool(randomUUID(), "question_ask", { ...ask(agent.agent_id), threadId: thread })).rejects.toThrow(/authenticated/);
    await expect(tool(thread, "question_ask", { ...ask(agent.agent_id), agent_token: "invalid-token" })).rejects.toThrow();
    const accepted = await tool(thread, "question_ask", ask(agent.agent_id)) as any;
    expect(accepted.question.agent_id).toBe(agent.agent_id);
    expect(JSON.stringify(accepted)).not.toContain(process.env.AGENT_CONTROL_TOKEN);
  });
  it("keeps question ask/get/list/wait private to the real CLI owner", async () => {
    const { agent, thread } = await start();
    const other = controller.registerAgent({ runId: owner.run.run_id, backend: "codex-cli", title: "Other", repoDir: root });
    await controller.startAgent({ agentId: other.agent_id, prompt: "Other worker" }); const otherThread = adapter.threads.get(other.agent_id)!;
    const first = await tool(thread, "question_ask", ask(agent.agent_id)) as any;
    await tool(otherThread, "question_ask", ask(other.agent_id));
    expect((await tool(thread, "question_get", { question_id: first.question.question_id }) as any).agent_id).toBe(agent.agent_id);
    expect((await tool(thread, "question_list", { run_id: owner.run.run_id }) as any).questions).toHaveLength(1);
    expect((await tool(thread, "question_wait", { question_id: first.question.question_id, timeout_ms: 1 }) as any).outcome).toBe("timeout");
    for (const name of ["question_get", "question_wait"]) await expect(tool(otherThread, name, { question_id: first.question.question_id, timeout_ms: 1 })).rejects.toThrow();
    await expect(tool(thread, "question_answer", { question_id: first.question.question_id, answers: { scope: { text: "Worker cannot answer" } } })).rejects.toThrow(/requester/);
    store.updateAgent(agent.agent_id, { unregisteredAt: new Date().toISOString() });
    await expect(tool(thread, "question_get", { question_id: first.question.question_id })).rejects.toThrow();
  });
  it("authenticates attached codex-session questions from host metadata and rejects foreign callers", async () => {
    const thread = randomUUID();
    const attached = controller.registerAgent({ runId: owner.run.run_id, backend: "codex-session", title: "Attached session", role: "worker", status: "running", repoDir: root, backendHandle: { thread_id: thread } });
    expect(agentConversationThreadId(attached)).toBe(thread);
    vi.stubEnv("CODEX_THREAD_ID", thread);
    await expect(tool(undefined, "question_ask", ask(attached.agent_id))).rejects.toThrow(/authenticated/);
    const asked = await tool(thread, "question_ask", ask(attached.agent_id)) as any;
    expect(asked.question.agent_id).toBe(attached.agent_id);
    expect((await tool(thread, "question_get", { question_id: asked.question.question_id }) as any).agent_id).toBe(attached.agent_id);
    expect((await tool(thread, "question_wait", { question_id: asked.question.question_id, timeout_ms: 1 }) as any).outcome).toBe("timeout");
    expect((await tool(thread, "question_list", { run_id: owner.run.run_id }) as any).questions).toHaveLength(1);
    await expect(tool(randomUUID(), "question_get", { question_id: asked.question.question_id })).rejects.toThrow();
    await expect(tool(thread, "question_answer", { question_id: asked.question.question_id, answers: { scope: { text: "Not the requester" } } })).rejects.toThrow(/requester/);
    store.updateAgent(attached.agent_id, { unregisteredAt: new Date().toISOString() });
    await expect(tool(thread, "question_get", { question_id: asked.question.question_id })).rejects.toThrow();
  });
  it("subscribes and waits as the CLI package coordinator without promoting it to operator", async () => {
    const { flow, agent, thread } = await start(); writeFileSync(join(root, "plan.md"), "# Plan\n");
    await tool(thread, "flow_step_report", { step_instance_id: flow.active_step!.step_instance_id, status: "completed", auto_continue: false });
    await controller.dispatchActiveFlowStep({ flowInstanceId: flow.instance.flow_instance_id, agentToken: owner.agent_token });
    const question = await tool(thread, "question_ask", ask(agent.agent_id)) as any;
    const waitInput = { flow_instance_id: flow.instance.flow_instance_id, request: { operation: "wait", timeout_ms: 1 } };
    const first = await tool(thread, "flow_packages", waitInput) as any;
    expect(first.coordinator_observer.thread_id).toBe(thread);
    expect(first.coordinator_observer.observer_agent_id).not.toBe(agent.agent_id);
    expect(controller.getAgent(agent.agent_id).backend).toBe("codex-cli");
    expect(controller.getAgent(agent.agent_id).backend_handle).not.toHaveProperty("thread_id");
    expect(controller.ensureRequester(owner.run.run_id)!.thread_id).toBe("original-requester");
    expect((await tool(thread, "question_list", { run_id: owner.run.run_id }) as any).questions.map((q: any) => q.question_id)).toEqual([question.question.question_id]);
    const ack = { flow_instance_id: flow.instance.flow_instance_id, request: { operation: "ack", cursor: first.cursor } };
    await expect(tool(randomUUID(), "flow_packages", ack)).rejects.toThrow(/identity/);
    await tool(thread, "flow_packages", ack);
    expect((await tool(thread, "flow_packages", waitInput) as any).coordinator_observer.observer_agent_id).toBe(first.coordinator_observer.observer_agent_id);
    await expect(tool(thread, "question_answer", { question_id: question.question.question_id, answers: { scope: { text: "No operator grant" } } })).rejects.toThrow(/requester/);
  });
  it("never trusts a forged handle thread id or another worker's execution directory", async () => {
    const { agent, thread } = await start();
    const other = controller.registerAgent({ runId: owner.run.run_id, backend: "codex-cli", title: "Other", repoDir: root });
    store.updateAgent(other.agent_id, { backendHandle: { ...agent.backend_handle, thread_id: thread, access_agent_id: other.agent_id } });
    await expect(tool(thread, "question_ask", ask(other.agent_id))).rejects.toThrow(/authenticated/);
    expect(agentConversationThreadId(controller.getAgent(other.agent_id))).toBeNull();
  });
  it("delivers package completion events to the CLI owner's control wait until explicit ACK", async () => {
    const { flow, thread } = await start(); writeFileSync(join(root, "plan.md"), "# Plan\n");
    await tool(thread, "flow_step_report", { step_instance_id: flow.active_step!.step_instance_id, status: "completed", auto_continue: false });
    await controller.dispatchActiveFlowStep({ flowInstanceId: flow.instance.flow_instance_id, agentToken: owner.agent_token });
    const waitInput = { flow_instance_id: flow.instance.flow_instance_id, request: { operation: "wait", timeout_ms: 1 } };
    expect((await tool(thread, "flow_packages", waitInput) as any).events).toEqual([]);
    const child = controller.registerAgent({ runId: owner.run.run_id, backend: "codex-cli", title: "Package child", role: "package_writer", repoDir: root });
    const delivered = store.createEvent({ runId: owner.run.run_id, agentId: child.agent_id, type: "flow.notification", payload: {
      flow_instance_id: flow.instance.flow_instance_id, step_id: "work", reason: "package_delivered", package_id: "one", attempt: 1, delivery_id: "fixture-delivery"
    } });
    const batch = await tool(thread, "flow_packages", waitInput) as any;
    expect(batch.events.map((event: any) => event.event_id)).toContain(delivered.event_id);
    expect(batch.processed_cursor).not.toBe(batch.cursor);
    expect(batch.ack_contract).toMatchObject({ tool: "flow_packages", arguments: { flow_instance_id: flow.instance.flow_instance_id, request: { operation: "ack", cursor: batch.cursor } } });
    expect((await tool(thread, "flow_packages", waitInput) as any).events).toEqual(batch.events);
    await tool(thread, batch.ack_contract.tool, batch.ack_contract.arguments);
    const acknowledged = await tool(thread, "flow_packages", waitInput) as any;
    expect(acknowledged.events).toEqual([]); expect(acknowledged.timed_out).toBe(true);
  });
  it("rereads the current thread after supervisor state rotation instead of retaining a stale binding", async () => {
    const { agent, thread, statePath } = await start(); const nextThread = randomUUID();
    writeFileSync(statePath, JSON.stringify({ status: "running", thread_id: nextThread, updated_at: new Date().toISOString() }));
    await expect(tool(thread, "question_ask", ask(agent.agent_id))).rejects.toThrow(/authenticated/);
    expect((await tool(nextThread, "question_ask", ask(agent.agent_id)) as any).question.agent_id).toBe(agent.agent_id);
  });
  it("recovers CLI question ownership after controller restart from durable state alone", async () => {
    const { agent, thread } = await start();
    const asked = await tool(thread, "question_ask", ask(agent.agent_id)) as any;
    await controller.dispose(); store.close();
    store = new SqliteStore(join(root, "state.sqlite"));
    const registry = new AdapterRegistry(); registry.register(new CliFixture()); registry.register(new CliFixture("codex-thread"));
    controller = new AgentController(store, registry);
    expect((await tool(thread, "question_get", { question_id: asked.question.question_id }) as any).agent_id).toBe(agent.agent_id);
    expect((await tool(thread, "question_wait", { question_id: asked.question.question_id, timeout_ms: 1 }) as any).outcome).toBe("timeout");
  });
  it.each(["missing", "malformed", "invalid-thread", "state-symlink", "directory-symlink"])("rejects untrusted CLI state: %s", async kind => {
    const { agent, thread, statePath } = await start();
    if (kind === "missing") rmSync(statePath);
    if (kind === "malformed") writeFileSync(statePath, "not json");
    if (kind === "invalid-thread") writeFileSync(statePath, JSON.stringify({ status: "running", thread_id: "../../someone", updated_at: new Date().toISOString() }));
    if (kind === "state-symlink") { const target = join(root, "copied-state.json"); renameSync(statePath, target); symlinkSync(target, statePath); }
    if (kind === "directory-symlink") { const dir = String(agent.backend_handle!.dir), target = join(root, "copied-execution"); renameSync(dir, target); symlinkSync(target, dir); }
    await expect(tool(thread, "question_ask", ask(agent.agent_id))).rejects.toThrow(/authenticated/);
    expect(agentConversationThreadId(controller.getAgent(agent.agent_id))).toBeNull();
  });
});
