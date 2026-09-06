import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { AgentController } from "../src/core/controller.js";
import { loadFlowConfigFile } from "../src/core/flow-config-loader.js";
import { artifactDigest } from "../src/core/flow-runtime.js";
import { resolveAdminKey } from "../src/core/identity.js";
import { runRuntimeDir } from "../src/core/paths.js";
import type { EvidenceReceipt, EvidenceRequest } from "../src/core/evidence/service.js";
import type { AgentAdapter, AgentHandle, AgentStatus, StartAgentInput } from "../src/core/types.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

// Only model execution is replaced. The actual bundled YAML, controller,
// SQLite transitions, canonical HDT provider, and command executor run normally.
class ScriptedCodex implements AgentAdapter {
  readonly kind = "codex-thread";
  starts: StartAgentInput[] = [];
  statuses = new Map<string, AgentStatus>();
  capabilities() { return { canStart: true, canSendMessage: true, canReadLatest: true, canStopGracefully: true, canForceStop: true, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: true }; }
  async start(input: StartAgentInput): Promise<AgentHandle> { this.starts.push(input); return { backend: this.kind, id: input.agent.agent_id, data: { thread_id: `fixture-${input.agent.agent_id}` } }; }
  async getStatus(handle: AgentHandle) { return { status: this.statuses.get(handle.id) ?? "running" as const }; }
  async readLatest() { return []; }
  async sendMessage() {}
  async stop(handle: AgentHandle) { this.statuses.set(handle.id, "stopped"); return { status: "stopped" as const }; }
  async unregister() {}
}

const planText = (work = "Set value to after.") => `# Plan\n\nFixture scope.\n\n<!-- hdt-section: work -->\n## Work\n\n${work}\n\n<!-- hdt-section: notes -->\n## Notes\n\nPreserve unrelated files.\n`;
const acceptance = "Goal: update value.txt. Scope: only value.txt. Preserve unrelated.txt. Acceptance: value contains after. UAT preference: skip.";
let root: string, repo: string, id: string, store: SqliteStore, controller: AgentController, adapter: ScriptedCodex;
let coordinator: ReturnType<AgentController["orchestratorLogin"]>;
let lastValidation: EvidenceReceipt;
let taskPackages: Record<string, string>;
type PackageSpec = { id: string; title: string; role: string; worktree: string; paths: string[]; deliverables: string[]; depends_on?: string[]; required?: boolean };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ac-default-lifecycle-")); repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Flow fixture"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "alpha.txt"), "before\n"); writeFileSync(join(repo, "beta.txt"), "before\n");
  writeFileSync(join(repo, "value.txt"), "before\n"); writeFileSync(join(repo, "unrelated.txt"), "preserved\n");
  execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "baseline"]);
  vi.stubEnv("AGENT_CONTROL_HOME", join(root, "state")); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "fixture-admin");
  vi.stubEnv("CODEX_THREAD_ID", ""); vi.stubEnv("AGENT_CONTROL_REQUESTER_THREAD_ID", "");
  store = new SqliteStore(join(root, "state.sqlite")); adapter = new ScriptedCodex();
  const registry = new AdapterRegistry(); registry.register(adapter); controller = new AgentController(store, registry);
  coordinator = controller.orchestratorLogin({ adminKey: resolveAdminKey(), title: "Conversation", runTitle: "Update value", repoDir: repo, backend: "codex-thread", backendHandle: { thread_id: "executor-thread" } });
  id = ""; taskPackages = { "value.txt": "work" };
});
function startFixture(acceptedContext = acceptance) {
  const flow = controller.startFlow({ config: loadFlowConfigFile(resolve(import.meta.dirname, "../../../flows/development-flow-v1/flow.yaml"), { env: {} }), runId: coordinator.run.run_id, acceptanceContext: acceptedContext, agentToken: coordinator.agent_token, requesterThreadId: "conversation-thread" });
  id = flow.instance.flow_instance_id;
}
afterEach(async () => { await controller.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function snapshot() { if (!id) startFixture(); return controller.getFlowSnapshot(id); }
function current() { const step = snapshot().steps.find(item => item.status === "active"); expect(step).toBeDefined(); return step!; }
function artifact(key: string) { const binding = snapshot().artifact_bindings.find(item => item.artifact_key === key); expect(binding).toBeDefined(); return binding!.path; }
function output(key: string) { const path = join(runRuntimeDir(coordinator.run.run_id), `${key}.md`); mkdirSync(runRuntimeDir(coordinator.run.run_id), { recursive: true }); return path; }
async function enter(expected: string) {
  expect(current().step_id).toBe(expected);
  const dispatched = await controller.dispatchActiveFlowStep({ flowInstanceId: id, agentToken: coordinator.agent_token });
  expect(dispatched.agent).toBeDefined();
  vi.stubEnv("CODEX_THREAD_ID", controller.getAgent(dispatched.agent!.agent_id).backend_handle!.thread_id as string);
  return current();
}
function report(result: Record<string, unknown>) { return controller.reportFlowStep({ stepInstanceId: current().step_instance_id, status: "completed", result, summary: `Fixture ${current().step_id} result` }); }
function decision(key: string, value: string, artifactKey?: string) {
  vi.stubEnv("CODEX_THREAD_ID", "conversation-thread");
  return controller.recordFlowDecision({ flowInstanceId: id, key, value, reason: `${key}: ${value}; explicit fixture decision on current content.`, expectedRevision: snapshot().runtime!.revision,
    ...(artifactKey ? { artifactKey, artifactDigest: artifactDigest(artifact(artifactKey)) } : {}),
    ...(key === "plan_approval" ? { packageManifestDigest: snapshot().runtime!.packages!.manifest_digest } : {}) });
}
async function evidence(key: string, request: EvidenceRequest) { return controller.executeFlowEvidence({ flowInstanceId: id, key, request, stepInstanceId: current().step_instance_id }); }
function sectionDraft(ids: string[], verdict = "approved", mode = "full") {
  return { verdict, coverage_ledger: { mode, sections: Object.fromEntries(ids.map(section => [section, { disposition: "reviewed", status: verdict === "approved" || section !== "work" ? "validated" : "finding", depends_on: [], invariants: [`${section} preserves acceptance.`] }])), deleted_section_ids_reviewed: [], limitations: [] },
    ...(mode === "incremental" ? { impact_analysis: { summary: "Work changed; notes are independent.", additionally_affected_section_ids: [] } } : {}) };
}
async function reviewPlan(checkpoint = "plan-1", previous?: string, approved = true, packages: PackageSpec[] = []) {
  await enter("plan_review");
  const prepared = await evidence(`checkpoint-${checkpoint}`, { operation: "prepare_plan", checkpoint_id: checkpoint, plan_path: artifact("plan"), ...(previous ? { previous } : {}) });
  let ids = Object.keys(prepared.payload.sections);
  if (previous) {
    const delta = await evidence(`delta-${checkpoint}`, { operation: "diff_plan", from_checkpoint_id: previous, to_checkpoint_id: checkpoint });
    ids = delta.payload.required_review_section_ids;
  }
  const receipt = await evidence("plan_review", { operation: "record_plan_review", checkpoint_id: checkpoint, draft: sectionDraft(ids, approved ? "approved" : "rework_required", previous ? "incremental" : "full") });
  if (approved) await controller.executeFlowPackages({ flowInstanceId: id, request: { operation: "define", packages } });
  report({ conclusion: approved ? "approved" : "needs_plan_changes", evidence_receipt_id: receipt.receipt_id });
  return receipt;
}
async function toImplementation(planCorrection = false, packages: PackageSpec[] = [], planDocument = planText()) {
  await enter("context"); writeFileSync(output("context"), `# Context\nAffected files: ${Object.keys(taskPackages).join(", ")}.\n`); report({ conclusion: "ready" });
  await enter("analysis"); writeFileSync(output("analysis"), "# Analysis\nUpdate the accepted files while preserving unrelated content.\n"); report({ conclusion: "ready" });
  expect(current().step_id).toBe("analysis_intent"); decision("analysis_intent", "approved", "analysis");
  await enter("planning"); writeFileSync(output("plan"), planDocument); report({ conclusion: "ready" });
  const originalPath = artifact("plan");
  if (planCorrection) {
    const rejected = await reviewPlan("plan-1", undefined, false); expect(rejected.status).toBe("rejected");
    await enter("planning"); writeFileSync(output("plan"), planText("Set value to after and verify the exact output.")); report({ conclusion: "ready" });
    expect(artifact("plan")).toBe(originalPath);
    const revised = await reviewPlan("plan-2", "plan-1"); expect(revised.source_receipt_ids).toContain(rejected.receipt_id);
    expect(revised.summary.carried_scopes).toContain("notes");
  } else await reviewPlan("plan-1", undefined, true, packages);
  expect(current().step_id).toBe("plan_approval"); decision("plan_approval", "approved", "plan");
  expect(current().step_id).toBe("implementation");
}
async function prepareResult(checkpoint: string, previous?: string) {
  return evidence(`checkpoint-${checkpoint}`, { operation: "prepare_result", checkpoint_id: checkpoint, plan_path: artifact("plan"), paths: Object.keys(taskPackages), ...(previous ? { previous } : {}) });
}
async function validate(checkpoint = "result-1", mode: "focused" | "complete_gate" = "complete_gate", previous?: string, reuse: string[] = []) {
  await enter(mode === "focused" ? "focused_validation" : "validation");
  const existing = snapshot().runtime!.evidence[`checkpoint-${checkpoint}`];
  if (existing) {
    const source = await evidence("read-checkpoint", { operation: "read_receipt", receipt_id: existing });
    expect(source.checkpoint_id).toBe(checkpoint);
  } else await prepareResult(checkpoint, previous);
  const receipt = await evidence(mode === "focused" ? "focused_validation" : "validation", {
    operation: "validation_run", checkpoint_id: checkpoint,
    checks: [{ check_id: "value-check", argv: [process.execPath, "-e", `const fs=require("node:fs"); for(const path of ${JSON.stringify(Object.keys(taskPackages))}) if(!fs.readFileSync(path,"utf8").startsWith("after")) process.exit(1)`], sandbox: "workspace", volatile: false, context_complete: true }],
    coverage: { validation_mode: mode, path_packages: taskPackages, surfaces: [...new Set(Object.values(taskPackages))].map(surface_id => ({ surface_id, kind: "package" as const, check_ids: ["value-check"], no_applicable_checks_reason: null })) }, source_receipt_ids: reuse
  });
  expect(receipt.status).toBe("passed");
  report({ conclusion: "passed", evidence_receipt_id: receipt.receipt_id });
  if (mode === "complete_gate") lastValidation = receipt;
  return receipt;
}
function resultDraft(gate: "planner" | "expert", rework = false, successor = false) {
  const finding = { finding_id: "value-detail", kind: "finding", summary: "The result needs the exact suffix.", impact: "The requested value is incomplete.", recommended_action: "Write after-corrected.", evidence: ["value.txt:1"], affected_surface_ids: ["work"], severity: "medium" };
  return { verdict: rework ? "rework_required" : "approved", summary: "Reviewed the complete affected result and invariant.",
    blocking_findings: rework ? [finding] : [], non_blocking_findings: [], required_corrections: rework ? [{ finding_id: finding.finding_id, action: "Write after-corrected." }] : [],
    prior_finding_results: successor ? [{ finding_id: "value-detail", result: "resolved", evidence: ["value.txt now contains after-corrected."], reviewed_surface_ids: ["work"] }] : [],
    recommended_next_phase: rework ? "implementation" : gate === "planner" ? "post_planner_choice" : "closure", recommended_rollback_phase: rework ? "implementation" : null,
    coverage_ledger: { mode: successor ? "incremental" : "full", surfaces: Object.fromEntries([...new Set(Object.values(taskPackages))].map(surface => [surface, { paths: Object.keys(taskPackages).filter(path => taskPackages[path] === surface), disposition: "reviewed", status: rework ? "finding" : "validated", depends_on: [], invariants: ["The value implements the accepted plan."], finding_ids: rework ? [finding.finding_id] : [] }])), surface_transitions: [], limitations: [] },
    impact_analysis: successor ? { summary: "The corrected value is the only affected surface.", additionally_affected_surface_ids: [] } : null,
    ...(gate === "expert" ? { safe_to_close: !rework } : {})
  };
}
async function planner() {
  await enter("implementation_review");
  const receipt = await evidence("implementation_review", { operation: "record_review", checkpoint_id: "result-1", gate: "planner", source_receipt_ids: [lastValidation.receipt_id], draft: resultDraft("planner") });
  report({ conclusion: "approved", evidence_receipt_id: receipt.receipt_id });
  expect(snapshot().runtime!.state.planner_approved).toBe(true);
  decision("uat_preference", "skip");
}
async function expert(checkpoint = "result-1", rework = false, successor = false) {
  await enter("final_review");
  const receipt = await evidence("final_review", { operation: "record_review", checkpoint_id: checkpoint, gate: "expert", draft: resultDraft("expert", rework, successor) });
  report({ conclusion: rework ? "changes_required" : "approved", target_phase: rework ? "implementation" : "done", evidence_receipt_id: receipt.receipt_id });
  return receipt;
}
async function close(expertReceipt: EvidenceReceipt) {
  expect(current().step_id).toBe("closure"); vi.stubEnv("CODEX_THREAD_ID", "executor-thread");
  const receipt = await controller.executeFlowEvidence({ flowInstanceId: id, key: "closure", request: { operation: "verify_closure", expert_receipt_id: expertReceipt.receipt_id, validation_receipt_id: lastValidation.receipt_id }, stepInstanceId: current().step_instance_id, agentToken: coordinator.agent_token });
  expect(receipt.status).toBe("verified"); report({ conclusion: "verified" });
  expect(snapshot().instance.status).toBe("completed");
  expect(readFileSync(join(repo, "unrelated.txt"), "utf8")).toBe("preserved\n");
}

// These disposable worktrees model Codex-provisioned checkouts. Production
// package launch receives existing Codex worktrees and never creates them.
function packageFixture(): PackageSpec[] {
  taskPackages = { "alpha.txt": "alpha", "beta.txt": "beta" };
  startFixture("Goal: update alpha.txt and beta.txt to after. Scope: independent alpha and beta packages. Preserve value.txt and unrelated.txt. Acceptance: both values contain after. UAT preference: skip.");
  return ["alpha", "beta"].map(packageId => {
    const worktree = join(root, `${packageId}-tree`);
    execFileSync("git", ["-C", repo, "worktree", "add", "--quiet", "--detach", worktree, "HEAD"]);
    return { id: packageId, title: `Update ${packageId}`, role: "implementer", worktree, paths: [`${packageId}.txt`], deliverables: [`${packageId}.txt`] };
  });
}
const packagePlan = "# Plan\n\nTwo disjoint packages.\n\n<!-- hdt-section: alpha -->\n## Alpha\n\nSet alpha.txt to after.\n\n<!-- hdt-section: beta -->\n## Beta\n\nSet beta.txt to after.\n\n<!-- hdt-section: notes -->\n## Notes\n\nJoin both accepted deliveries and consolidate their exact contents before validation. Preserve value.txt and unrelated.txt.\n";
function packages(request: Parameters<AgentController["executeFlowPackages"]>[0]["request"]) {
  return controller.executeFlowPackages({ flowInstanceId: id, request });
}
function asAgent(agentId: string) {
  vi.stubEnv("CODEX_THREAD_ID", controller.getAgent(agentId).backend_handle!.thread_id as string);
}

describe("bundled default flow with actual evidence and closure", () => {

  it("joins two approved packages and verifies exact consolidation through closure", async () => {
    const manifest = packageFixture();
    await toImplementation(false, manifest, packagePlan);
    const approvedManifest = snapshot().runtime!.packages!.manifest_digest;
    const step = await enter("implementation");
    const ownerThread = process.env.CODEX_THREAD_ID!;
    const launched = await packages({ operation: "launch" });
    expect(Object.values(launched.branches).map(branch => branch.state)).toEqual(["running", "running"]);
    expect(new Set(Object.values(launched.branches).map(branch => branch.agent_id)).size).toBe(2);
    expect(snapshot().runtime!.packages!.manifest_digest).toBe(approvedManifest);
    const deliveries: Array<{ package_id: string; delivery_id: string }> = [];
    for (const entry of manifest) {
      const branch = launched.branches[entry.id]!;
      writeFileSync(join(entry.worktree, `${entry.id}.txt`), `after-${entry.id}\n`);
      asAgent(branch.agent_id!);
      // Child delivery authority cannot report the parent phase as complete.
      expect(() => controller.reportFlowStep({ stepInstanceId: step.step_instance_id, status: "completed", result: { conclusion: "ready" } })).toThrow();
      const delivered = await packages({ operation: "deliver", package_id: entry.id, attempt: branch.attempt, summary: `${entry.id} completed within its approved scope.` });
      deliveries.push({ package_id: entry.id, delivery_id: delivered.branches[entry.id]!.delivery!.delivery_id });
      adapter.statuses.set(branch.agent_id!, "completed");
    }
    vi.stubEnv("CODEX_THREAD_ID", ownerThread);
    const accepted = await packages({ operation: "accept", deliveries, reason: "Both exact deliveries satisfy their approved package contracts." });
    expect(Object.values(accepted.branches).every(branch => branch.state === "accepted")).toBe(true);
    // Even a false worker claim cannot bypass runtime-derived integration.
    report({ conclusion: "ready", integration_needed: false });
    await enter("integration");
    expect(() => report({ conclusion: "ready" })).toThrow(/integration/i);
    for (const branch of Object.values(accepted.branches)) {
      for (const file of branch.delivery!.files) writeFileSync(join(repo, file.path), readFileSync(file.snapshot_path!));
    }
    const checkpoint = await prepareResult("result-1");
    const integrated = await packages({ operation: "integrate", result_receipt_id: checkpoint.receipt_id });
    expect(integrated.integration).toMatchObject({ manifest_digest: approvedManifest, result_receipt_id: checkpoint.receipt_id, delivery_ids: deliveries.map(item => item.delivery_id).sort() });
    report({ conclusion: "ready" });
    await validate(); await planner(); await close(await expert());
    expect(readFileSync(join(repo, "value.txt"), "utf8")).toBe("before\n");
    const packageAgents = Object.values(accepted.branches).map(branch => controller.getAgent(branch.agent_id!));
    expect(packageAgents.every(agent => agent.run_id === coordinator.run.run_id)).toBe(true);
    expect(store.db.prepare("select thread_id from run_requesters where run_id = ?").get(coordinator.run.run_id)).toEqual({ thread_id: "conversation-thread" });
    expect(snapshot().runtime!.decision_owners!.requester).not.toBe(snapshot().runtime!.decision_owners!.orchestrator);
  }, 60_000);

  it("blocks an omitted, pending, or failed required package from leaving implementation", async () => {
    const manifest = packageFixture();
    await toImplementation(false, manifest, packagePlan); await enter("implementation");
    const ownerThread = process.env.CODEX_THREAD_ID!;
    expect(() => report({ conclusion: "ready" })).toThrow(/package|join|accepted/i);
    const launched = await packages({ operation: "launch" });
    const alpha = launched.branches.alpha!;
    writeFileSync(join(manifest[0]!.worktree, "alpha.txt"), "after-alpha\n"); asAgent(alpha.agent_id!);
    const delivered = await packages({ operation: "deliver", package_id: "alpha", attempt: alpha.attempt, summary: "Alpha delivered." });
    adapter.statuses.set(alpha.agent_id!, "completed"); vi.stubEnv("CODEX_THREAD_ID", ownerThread);
    await packages({ operation: "accept", deliveries: [{ package_id: "alpha", delivery_id: delivered.branches.alpha!.delivery!.delivery_id }], reason: "Alpha is correct; beta remains required." });
    expect(() => report({ conclusion: "ready" })).toThrow(/package|join|active|accepted/i);
    const beta = launched.branches.beta!;
    adapter.statuses.set(beta.agent_id!, "failed");
    // A failed backend with no immutable delivery cannot be accepted or joined.
    await expect(packages({ operation: "accept", deliveries: [{ package_id: "beta", delivery_id: "missing-delivery" }], reason: "Failure must not count as delivery." })).rejects.toThrow(/delivered|successful|package/i);
    expect(() => report({ conclusion: "ready" })).toThrow(/package|join|accepted/i);
    expect(current().step_id).toBe("implementation");
  }, 60_000);

  it("keeps the original requester’s analysis decision separate from its executing coordinator", async () => {
    await enter("context"); writeFileSync(output("context"), "# Context\nFixture facts.\n"); report({ conclusion: "ready" });
    await enter("analysis"); writeFileSync(output("analysis"), "# Analysis\nPreserve accepted intent.\n"); report({ conclusion: "ready" });
    const owners = snapshot().runtime!.decision_owners!;
    expect(owners.requester).not.toBe(owners.orchestrator);
    expect(() => controller.recordFlowDecision({ flowInstanceId: id, key: "analysis_intent", value: "approved", reason: "Executor claims approval", expectedRevision: snapshot().runtime!.revision, artifactDigest: artifactDigest(artifact("analysis")), agentToken: coordinator.agent_token })).toThrow(/different conversation/);
    decision("analysis_intent", "approved", "analysis");
    expect(snapshot().runtime!.decisions.analysis_intent).toMatchObject({ actor_id: owners.requester, authority: "coordinator", source: "coordinator_review" });
    expect(current().step_id).toBe("planning");
  });

  it("executes Context through verified closure without dispatching decision workers", async () => {
    await toImplementation(); await enter("implementation"); writeFileSync(join(repo, "value.txt"), "after\n"); report({ conclusion: "ready" });
    await validate(); await planner(); const review = await expert(); await close(review);
    expect(adapter.starts).toHaveLength(8);
    expect(snapshot().runtime!.context).toBe(acceptance);
    expect(snapshot().reports.map(item => item.result_json.conclusion)).toContain("verified");
  }, 60_000);

  it("preserves a stable plan path and authenticated incremental review across plan correction", async () => {
    await toImplementation(true);
    expect(snapshot().steps.filter(item => item.step_id === "planning")).toHaveLength(2);
    expect(snapshot().steps.filter(item => item.step_id === "plan_approval")).toHaveLength(1);
  }, 60_000);

  it("rechecks expert corrections with focused then complete evidence and skips the approved planner", async () => {
    await toImplementation(); await enter("implementation"); writeFileSync(join(repo, "value.txt"), "after\n"); report({ conclusion: "ready" });
    await validate(); await planner(); const first = await expert("result-1", true);
    const originalExpert = snapshot().runtime!.owners.final_reviewer;
    await enter("implementation"); writeFileSync(join(repo, "value.txt"), "after-corrected\n"); report({ conclusion: "ready" });
    const focused = await validate("result-2", "focused", "result-1");
    const complete = await validate("result-2", "complete_gate", "result-1", [focused.receipt_id]);
    expect(complete.summary.reused_check_count).toBe(1);
    expect(current().step_id).toBe("final_review");
    expect(snapshot().steps.filter(item => item.step_id === "implementation_review")).toHaveLength(1);
    const approved = await expert("result-2", false, true);
    expect(approved.source_receipt_ids).toContain(first.receipt_id);
    expect(snapshot().runtime!.owners.final_reviewer).toBe(originalExpert);
    await close(approved);
  }, 60_000);
});
