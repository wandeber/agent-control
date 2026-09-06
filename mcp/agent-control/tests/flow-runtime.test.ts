import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  async function draft(cfg = config()) {
    const started = start(cfg); await dispatch(started.instance.flow_instance_id); writeFileSync(join(root, "plan.md"), "# Approved plan\n");
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
  it("gives strict read-only workers an MCP-only blocked handback contract", async () => {
    const cfg = config(); cfg.steps.draft.sandbox = "read_only"; cfg.steps.draft.outputs = {};
    const started = start(cfg); await dispatch(started.instance.flow_instance_id);
    const contract = started.active_step!.input_json.reporting_contract as Record<string, any>;
    expect(contract.cli).toBeUndefined();
    expect(contract.markdown).toContain("AGENT_CONTROL_BLOCKED:");
    expect(contract.markdown).not.toContain("CLI fallback example");
    expect(adapter.starts[0]!.prompt).toContain("Do not retry repeatedly, switch to CLI or shell reporting");
    expect(adapter.starts[0]!.prompt).not.toContain("use the shown local CLI command");
    expect((started.active_step!.input_json.runtime_contract as Record<string, any>).capability_failure_contract.handback_prefix).toBe("AGENT_CONTROL_BLOCKED:");
  });
  it.each(["AGENT_CONTROL_BLOCKED: flow_evidence | Host requires approval.", "Worker stopped without a report."])("notifies run_wait of terminal missing reports without flow_continue: %s", async finalText => {
    const started = start(); await dispatch(started.instance.flow_instance_id);
    const observer = controller.observeRun({ runId: owner.run.run_id, threadId: "waiting-user", eventTypes: ["flow.step_blocked"], agentToken: owner.agent_token });
    vi.spyOn(adapter, "getStatus").mockResolvedValue({ status: "completed", data: { activity: { kind: "message", text: finalText } } } as any);
    const observed = await controller.waitForRun({ runId: owner.run.run_id, observerAgentId: observer.observer_agent_id, cursor: observer.cursor, timeoutMs: 1000, intervalMs: 1 });
    expect(observed.events.some(event => event.type === "flow.step_blocked")).toBe(true);
    const snapshot = controller.getFlowSnapshot(started.instance.flow_instance_id);
    expect(snapshot.instance.status).toBe("blocked"); expect(snapshot.reports).toHaveLength(0);
    const events = controller.listEvents({ runId: owner.run.run_id, type: "flow.step_blocked" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.reason).toBe(finalText.startsWith("AGENT_CONTROL_BLOCKED:") ? "worker_capability_unavailable" : "terminal_agent_missing_flow_report");
    if (finalText.startsWith("AGENT_CONTROL_BLOCKED:")) expect(events[0]!.payload.failure_source).toBe("worker_reported");
    await controller.pollActiveAgents(owner.run.run_id);
    expect(controller.listEvents({ runId: owner.run.run_id, type: "flow.step_blocked" })).toHaveLength(1);
  });
  it("does not reinterpret a valid reported phase as a terminal capability failure", async () => {
    const { started } = await draft();
    vi.spyOn(adapter, "getStatus").mockResolvedValue({ status: "completed", data: { activity: { kind: "message", text: "AGENT_CONTROL_BLOCKED: unrelated later message" } } } as any);
    await controller.pollActiveAgents(owner.run.run_id);
    expect(controller.getFlowSnapshot(started.instance.flow_instance_id).instance.status).toBe("waiting_for_orchestrator");
    expect(controller.listEvents({ runId: owner.run.run_id, type: "flow.step_blocked" })).toHaveLength(0);
  });

  it("requires human approval of immutable exact plan bytes", async () => {
    const { started, reported } = await draft(); const id = started.instance.flow_instance_id;
    expect(reported.instance.status).toBe("waiting_for_orchestrator");
    await expect(controller.startFlowStep({ flowInstanceId: id, stepId: "work", agentToken: owner.agent_token })).rejects.toThrow(/decision or milestone/);
    expect(() => controller.recordFlowDecision({ flowInstanceId: id, key: "plan", value: "approved", reason: "yes", expectedRevision: reported.runtime!.revision, artifactDigest: "0".repeat(64), agentToken: owner.agent_token })).toThrow(/exact current artifact digest/);
    writeFileSync(join(root, "plan.md"), "Mutated source"); expect(readFileSync(reported.artifact_bindings[0]!.snapshot_path!, "utf8")).toContain("Approved plan");
    expect(() => approve(id)).toThrow(/outside its producing report/);
    writeFileSync(join(root, "plan.md"), "# Approved plan\n");
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
  it("recovers a detached role with a fresh identity and an idempotent full-review requirement", async () => {
    const cfg = config(); cfg.steps.draft.evidence_operations = ["prepare_plan", "record_plan_review"];
    const started = start(cfg); await dispatch(started.instance.flow_instance_id);
    const before = controller.getFlowSnapshot(started.instance.flow_instance_id); const previous = before.runtime!.owners.author!;
    store.updateAgent(previous, { unregisteredAt: new Date().toISOString() });
    const input = { flowInstanceId: started.instance.flow_instance_id, role: "author", restartStepId: "draft", reason: "Owner was lost; perform a fresh full review.", expectedRevision: before.runtime!.revision, agentToken: owner.agent_token };
    const recovered = controller.recoverFlowOwner(input);
    expect(recovered.runtime!.owners.author).not.toBe(previous); expect(recovered.runtime!.recovery?.full_review_required).toBe(true);
    expect(recovered.steps.find(step => step.step_instance_id === started.active_step!.step_instance_id)?.status).toBe("cancelled");
    expect(controller.recoverFlowOwner(input).runtime!.owners.author).toBe(recovered.runtime!.owners.author);
    await dispatch(started.instance.flow_instance_id);
    await expect(controller.executeFlowEvidence({ flowInstanceId: started.instance.flow_instance_id, key: "plan", request: { operation: "prepare_plan", checkpoint_id: "replacement", plan_path: join(root, "plan.md"), previous: "old-owner" } })).rejects.toThrow(/full checkpoint/);
  });

  it("keeps requester-owned decisions with the original conversation rather than the executor", async () => {
    const cfg = config(); cfg.steps.draft = { execution: "coordinator", decision: { key: "intent", authority: "coordinator", owner: "requester" }, on: { completed: { finish: true } } };
    const started = controller.startFlow({ config: cfg, runId: owner.run.run_id, agentToken: owner.agent_token, requesterThreadId: "original-user-thread" });
    const snapshot = controller.getFlowSnapshot(started.instance.flow_instance_id);
    const decision = { flowInstanceId: started.instance.flow_instance_id, key: "intent", value: "approved", reason: "The analysis preserves the user's clarified intent.", expectedRevision: snapshot.runtime!.revision };
    expect(() => controller.recordFlowDecision({ ...decision, agentToken: owner.agent_token })).toThrow(/different conversation/);
    vi.stubEnv("CODEX_THREAD_ID", "original-user-thread");
    const approved = controller.recordFlowDecision(decision);
    expect("instance" in approved && approved.instance.status).toBe("completed");
    expect(controller.getFlowSnapshot(started.instance.flow_instance_id).runtime!.decisions.intent).toMatchObject({ authority: "coordinator", source: "coordinator_review", actor_id: started.observer!.observer_agent_id });
  });

  it("rejects a worker-selected plan substitute before creating evidence", async () => {
    const cfg = config(); cfg.steps.work.evidence_operations = ["prepare_plan"];
    const { started } = await draft(cfg); approve(started.instance.flow_instance_id); await dispatch(started.instance.flow_instance_id);
    const substitute = join(root, "substitute.md"); writeFileSync(substitute, "Unapproved substitute");
    await expect(controller.executeFlowEvidence({ flowInstanceId: started.instance.flow_instance_id, key: "wrong", request: { operation: "prepare_plan", checkpoint_id: "wrong", plan_path: substitute } })).rejects.toThrow(/worker-selected substitute/);
    expect(controller.getFlowSnapshot(started.instance.flow_instance_id).runtime!.evidence).toEqual({});
  });

  it("reads historical receipts without republishing their provenance during plan corrections", async () => {
    const cfg = config(); cfg.steps.work.evidence_operations = ["snapshot_artifact", "read_receipt"];
    const { started } = await draft(cfg); const id = started.instance.flow_instance_id;
    approve(id); await dispatch(id);
    const receipt = await controller.executeFlowEvidence({ flowInstanceId: id, key: "original", request: { operation: "snapshot_artifact", path: join(root, "plan.md") } });
    const before = controller.getFlowSnapshot(id).runtime!;
    writeFileSync(join(root, "plan.md"), "Work in progress; not yet reported.");
    const read = await controller.executeFlowEvidence({ flowInstanceId: id, key: "new-alias-must-not-be-written", request: { operation: "read_receipt", receipt_id: receipt.receipt_id } });
    expect(read).toEqual(receipt);
    expect(controller.getFlowSnapshot(id).runtime).toEqual(before);
    await expect(controller.executeFlowEvidence({ flowInstanceId: id, key: "new", request: { operation: "snapshot_artifact", path: join(root, "plan.md") } })).rejects.toThrow(/outside its producing report/);
  });

  it("lets a replacement planner perform a full review using real current complete validation", async () => {
    const repo = join(root, "repo"); mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
    writeFileSync(join(repo, "plan.md"), "# Plan\n\n<!-- hdt-section: work -->\n## Work\n\nUpdate value.\n");
    writeFileSync(join(repo, "value.txt"), "before\n");
    execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
    writeFileSync(join(repo, "value.txt"), "after\n");
    owner = controller.orchestratorLogin({ adminKey: resolveAdminKey(), title: "Evidence coordinator", runTitle: "Implement value", repoDir: repo, backend: "codex-thread", backendHandle: { thread_id: "evidence-coordinator" } });
    const cfg = config(); cfg.artifacts!.plan.path = join(repo, "plan.md");
    cfg.steps.work.evidence_operations = ["prepare_result", "validation_run", "record_review"]; cfg.steps.work.evidence_gates = ["planner"];
    const started = start(cfg); const id = started.instance.flow_instance_id;
    await dispatch(id); controller.reportFlowStep({ stepInstanceId: started.active_step!.step_instance_id, status: "completed" }); approve(id); await dispatch(id);
    const before = controller.getFlowSnapshot(id); store.updateAgent(before.runtime!.owners.author!, { unregisteredAt: new Date().toISOString() });
    controller.recoverFlowOwner({ flowInstanceId: id, role: "author", restartStepId: "work", reason: "Recover planner with full review", expectedRevision: before.runtime!.revision, agentToken: owner.agent_token });
    await dispatch(id);
    await controller.executeFlowEvidence({ flowInstanceId: id, key: "result", request: { operation: "prepare_result", checkpoint_id: "new-planner", plan_path: join(repo, "plan.md"), paths: ["value.txt"] } });
    const checks = await controller.executeFlowEvidence({ flowInstanceId: id, key: "validation", request: { operation: "validation_run", checkpoint_id: "new-planner",
      checks: [{ check_id: "unit", argv: [process.execPath, "-e", "process.stdout.write('passed')"], sandbox: "workspace", context_complete: true, volatile: false }],
      coverage: { validation_mode: "complete_gate", path_packages: { "value.txt": "package" }, surfaces: [{ surface_id: "package", kind: "package", check_ids: ["unit"], no_applicable_checks_reason: null }] } } });
    const review = await controller.executeFlowEvidence({ flowInstanceId: id, key: "planner", request: { operation: "record_review", checkpoint_id: "new-planner", gate: "planner", source_receipt_ids: [checks.receipt_id], draft: {
      verdict: "approved", summary: "Reviewed the complete affected result.", blocking_findings: [], non_blocking_findings: [], required_corrections: [], prior_finding_results: [],
      recommended_next_phase: "post_planner_choice", recommended_rollback_phase: null, impact_analysis: null,
      coverage_ledger: { mode: "full", surfaces: { package: { paths: ["value.txt"], disposition: "reviewed", status: "validated", depends_on: [], invariants: ["The result implements the plan."], finding_ids: [] } }, surface_transitions: [], limitations: [] }
    } } });
    expect(review.kind).toBe("planner_review"); expect(review.status).toBe("approved");
    expect(controller.getFlowSnapshot(id).runtime!.recovery?.full_review_required).toBe(false);
  }, 30_000);

  it.each([false, true])("recovers a legacy report/activation gap without replaying its worker (transition persisted=%s)", async (transitionPersisted) => {
    const cfg: FlowConfig = { id: "legacy-recovery", initial_step: "one", roles: { author: { backend: "codex-thread" } }, steps: {
      one: { role: "author", prompt: "First worker phase", on: { completed: { to: "two" } } },
      two: { role: "author", prompt: "Second worker phase", on: { completed: { finish: true } } }
    } };
    const started = start(cfg); await dispatch(started.instance.flow_instance_id); const step = started.active_step!;
    // Represent the published runtime's durable cut after a successful report
    // and before activation. This is state injection, not a process-kill test.
    store.createFlowStepReport({ stepInstanceId: step.step_instance_id, status: "completed", resultJson: {}, artifactsJson: {}, summary: "First phase done" });
    store.updateFlowStepInstance(step.step_instance_id, { status: "completed", resultJson: {}, summary: "First phase done", completedAt: new Date().toISOString() });
    if (transitionPersisted) store.createFlowTransition({ flowInstanceId: started.instance.flow_instance_id, fromStepInstanceId: step.step_instance_id, transitionId: "one-to-two", targetStepId: "two", actionJson: { to: "two" } });
    const recovered = await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id, agentToken: owner.agent_token });
    expect(recovered.action).toBe("dispatched"); expect(adapter.starts).toHaveLength(2);
    expect(adapter.starts.at(-1)!.prompt).toContain("Second worker phase");
    expect(adapter.starts.at(-1)!.prompt).not.toContain("First worker phase");
    await controller.continueFlow({ flowInstanceId: started.instance.flow_instance_id, agentToken: owner.agent_token });
    expect(adapter.starts).toHaveLength(2); expect(controller.getFlowSnapshot(started.instance.flow_instance_id).transitions).toHaveLength(1);
  });

});
