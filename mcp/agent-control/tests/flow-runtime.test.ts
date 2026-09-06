import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentController } from "../src/core/controller.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { resolveAdminKey } from "../src/core/identity.js";
import { artifactDigest } from "../src/core/flow-runtime.js";
import type { AgentAdapter, AgentHandle, FlowConfig, StartAgentInput } from "../src/core/types.js";
import { handleTool } from "../src/tools/handlers.js";

class CodexFixture implements AgentAdapter {
  readonly kind = "codex-thread";
  starts: StartAgentInput[] = [];
  capabilities() { return { canStart: true, canSendMessage: true, canReadLatest: true, canStopGracefully: true, canForceStop: true, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: true }; }
  async start(input: StartAgentInput): Promise<AgentHandle> { this.starts.push(input); return { backend: this.kind, id: `thread-${input.agent.agent_id}`, data: { thread_id: `thread-${input.agent.agent_id}` } }; }
  async getStatus() { return { status: "running" as const }; }
  async readLatest() { return []; }
  async sendMessage() {}
  async stop() { return { status: "stopped" as const }; }
  async unregister() {}
}

describe("strict flow runtime", () => {
  let root: string; let store: SqliteStore; let controller: AgentController; let adapter: CodexFixture;
  let owner: ReturnType<AgentController["orchestratorLogin"]>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-runtime-"));
    vi.stubEnv("AGENT_CONTROL_HOME", join(root, "state")); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "fixture-admin");
    vi.stubEnv("CODEX_THREAD_ID", ""); vi.stubEnv("AGENT_CONTROL_REQUESTER_THREAD_ID", "");
    store = new SqliteStore(join(root, "state.sqlite")); adapter = new CodexFixture();
    const registry = new AdapterRegistry(); registry.register(adapter); controller = new AgentController(store, registry);
    owner = controller.orchestratorLogin({ adminKey: resolveAdminKey(), title: "Coordinator", runTitle: "Original objective", repoDir: root, backend: "codex-thread", backendHandle: { thread_id: "coordinator-thread" } });
  });
  afterEach(async () => { await controller.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  function config(): FlowConfig {
    return { id: "strict-fixture", version: "1", policy: { strict: true, plan_artifact: "plan" }, initial_step: "draft", roles: { author: { backend: "codex-thread", prompt: "Persistent owner policy" } }, artifacts: { plan: { path: join(root, "plan.md") } }, steps: {
      draft: { role: "author", prompt: "Draft step", outputs: { plan: { artifact: "plan", required: true } }, on: { completed: { to: "approval" } } },
      approval: { execution: "coordinator", decision: { key: "plan", artifact_key: "plan", authority: "user" }, on: { completed: { transitions: [{ id: "approved", when: { equals: { var: "result.decision", value: "approved" } }, to: "work" }] } } },
      work: { role: "author", prompt: "Implement approved plan", requires: { equals: { var: "decisions.plan.value", value: "approved" } }, on: { completed: { finish: true } } }
    } };
  }
  function start(cfg = config()) { return controller.startFlow({ config: cfg, runId: owner.run.run_id, agentToken: owner.agent_token }); }
  async function dispatch(id: string) {
    const dispatched = await controller.dispatchActiveFlowStep({ flowInstanceId: id, agentToken: owner.agent_token });
    vi.stubEnv("CODEX_THREAD_ID", controller.getAgent(dispatched.agent!.agent_id).backend_handle!.thread_id as string); return dispatched;
  }
  async function draft() {
    const started = start(); await dispatch(started.instance.flow_instance_id); writeFileSync(join(root, "plan.md"), "# Approved plan\n");
    const reported = controller.reportFlowStep({ stepInstanceId: started.active_step!.step_instance_id, status: "completed", summary: "Plan ready" }); return { started, reported };
  }
  function approve(id: string) {
    const snapshot = controller.getFlowSnapshot(id);
    return controller.recordFlowDecision({ flowInstanceId: id, key: "plan", value: "approved", reason: "The user approved this exact plan.", expectedRevision: snapshot.runtime!.revision, artifactDigest: artifactDigest(snapshot.artifact_bindings[0]!.path), agentToken: owner.agent_token });
  }
  it("retains only the current accepted contract in prompts and rejects superseded step reports", async () => {
    const started = start(); const id = started.instance.flow_instance_id;
    controller.updateFlowContext({ flowInstanceId: id, context: "Obsolete acceptance", expectedRevision: 0, agentToken: owner.agent_token });
    controller.updateFlowContext({ flowInstanceId: id, context: "Current complete acceptance", expectedRevision: 1, agentToken: owner.agent_token });
    await dispatch(id);
    expect(() => controller.reportFlowStep({ stepInstanceId: started.active_step!.step_instance_id, status: "completed" })).toThrow(/acceptance changed/);
    const routed = await controller.startFlowStep({ flowInstanceId: id, stepId: "draft", agentToken: owner.agent_token, reason: "Apply amended scope" });
    expect((routed.active_step!.input_json.runtime_contract as any).objective).toBe("Current complete acceptance");
    expect(routed.active_step!.input_json.acceptance_revision).toBe(2);
    await dispatch(id); writeFileSync(join(root, "plan.md"), "plan");
    const next = controller.reportFlowStep({ stepInstanceId: routed.active_step!.step_instance_id, status: "completed", summary: "Correction handled" });
    expect((next.active_step!.input_json.runtime_contract as any).objective).toBe("Current complete acceptance");
    expect(next.active_step!.input_json.correction).toMatchObject({ summary: "Correction handled", from_step_id: "draft" });
    expect(next.runtime!.context_history).toHaveLength(3);
  });
  it("resolves local worker identity without embedding report credentials in prompts", async () => {
    const started = start(); await dispatch(started.instance.flow_instance_id); writeFileSync(join(root, "plan.md"), "plan");
    const identity = process.env.CODEX_THREAD_ID; vi.stubEnv("CODEX_THREAD_ID", "another-thread");
    await expect(handleTool(controller, "flow_step_report", { step_instance_id: started.active_step!.step_instance_id, status: "completed", auto_continue: false })).rejects.toThrow(/assigned worker/);
    vi.stubEnv("CODEX_THREAD_ID", identity!);
    await expect(handleTool(controller, "flow_step_report", { step_instance_id: started.active_step!.step_instance_id, status: "completed", auto_continue: false })).resolves.toBeTruthy();
    expect(adapter.starts[0]!.prompt).not.toMatch(/report_token=|acb_|aca_/);
  });
  it("requires human approval of immutable exact plan bytes", async () => {
    const { started, reported } = await draft(); const id = started.instance.flow_instance_id;
    expect(reported.instance.status).toBe("waiting_for_orchestrator");
    await expect(controller.startFlowStep({ flowInstanceId: id, stepId: "work", agentToken: owner.agent_token })).rejects.toThrow(/decision or milestone/);
    expect(() => controller.recordFlowDecision({ flowInstanceId: id, key: "plan", value: "approved", reason: "yes", expectedRevision: reported.runtime!.revision, artifactDigest: "0".repeat(64), agentToken: owner.agent_token })).toThrow(/exact current artifact digest/);
    writeFileSync(join(root, "plan.md"), "Mutated source"); expect(readFileSync(reported.artifact_bindings[0]!.path, "utf8")).toContain("Approved plan");
    approve(id); expect(controller.getFlowSnapshot(id).instance.current_step_id).toBe("work");
  });
  it("replays identical reports without duplicate transitions and rejects conflicting retries", async () => {
    const { started } = await draft();
    const replay = controller.reportFlowStep({ stepInstanceId: started.active_step!.step_instance_id, status: "completed", summary: "Plan ready" });
    expect(replay.replayed).toBe(true); expect(controller.getFlowSnapshot(started.instance.flow_instance_id).reports).toHaveLength(1);
    expect(() => controller.reportFlowStep({ stepInstanceId: started.active_step!.step_instance_id, status: "completed", summary: "Different" })).toThrow(/different report/);
  });
  it("rolls back report, state and event writes if activation fails", async () => {
    const cfg = config(); cfg.steps.approval.requires = { equals: { var: "state.missing", value: true } };
    const started = start(cfg); await dispatch(started.instance.flow_instance_id); writeFileSync(join(root, "plan.md"), "plan");
    const events = controller.listEvents({ runId: owner.run.run_id }).length;
    expect(() => controller.reportFlowStep({ stepInstanceId: started.active_step!.step_instance_id, status: "completed" })).toThrow(/decision or milestone/);
    const after = controller.getFlowSnapshot(started.instance.flow_instance_id);
    expect(after.steps[0]!.status).toBe("active"); expect(after.reports).toHaveLength(0); expect(after.transitions).toHaveLength(0);
    expect(controller.listEvents({ runId: owner.run.run_id })).toHaveLength(events);
  });
  it("pins prompt bytes and blocks a changed configuration at resume", async () => {
    const path = join(root, "role.md"); writeFileSync(path, "Original role instructions");
    const cfg = config(); cfg.roles!.author = { backend: "codex-thread", prompt_path: path }; const started = start(cfg);
    writeFileSync(path, "Changed role instructions"); await dispatch(started.instance.flow_instance_id);
    expect(adapter.starts[0]!.prompt).toContain("Original role instructions"); expect(adapter.starts[0]!.prompt).not.toContain("Changed role instructions");
    expect(() => start(cfg)).toThrow(/pinned to different/);
  });
  it("never replaces a detached pinned owner silently", async () => {
    const started = start(); const ownerId = controller.getFlowSnapshot(started.instance.flow_instance_id).runtime!.owners.author!;
    store.updateAgent(ownerId, { unregisteredAt: new Date().toISOString() });
    const count = controller.listAgents({ runId: owner.run.run_id, includeUnregistered: true }).length;
    await expect(dispatch(started.instance.flow_instance_id)).rejects.toThrow(/silent replacement/);
    expect(controller.listAgents({ runId: owner.run.run_id, includeUnregistered: true })).toHaveLength(count);
  });
  it("blocks forged closure evidence without committing a report", async () => {
    const cfg = config(); cfg.steps.draft.outputs = {}; cfg.steps.draft.on = { completed: { finish: true, requires_evidence: [{ receipt: "result.receipt", kind: "closure" }] } };
    const started = start(cfg); await dispatch(started.instance.flow_instance_id);
    expect(() => controller.reportFlowStep({ stepInstanceId: started.active_step!.step_instance_id, status: "completed", result: { receipt: "nonexistent" } })).toThrow();
    expect(controller.getFlowSnapshot(started.instance.flow_instance_id).reports).toHaveLength(0);
  });
  it("omits only an already-delivered role prompt on same-owner follow-up", async () => {
    const { started } = await draft(); approve(started.instance.flow_instance_id); await dispatch(started.instance.flow_instance_id);
    expect(adapter.starts[0]!.prompt).toContain("Persistent owner policy"); expect(adapter.starts.at(-1)!.prompt).toContain("Implement approved plan");
    expect(adapter.starts.at(-1)!.prompt).not.toContain("Persistent owner policy");
  });
});
