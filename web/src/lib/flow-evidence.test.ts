import { describe, expect, it } from "vitest";
import { buildFlowEvidenceView, phaseWaitingLabel } from "./flow-evidence";
import type { DashboardSnapshot, FlowEvidenceSummaryRecord, FlowRuntimeRecord, FlowStepInstanceRecord } from "./types";

function step(id: string, phase = "expert_review", time = "2026-09-06T12:00:00Z"): FlowStepInstanceRecord {
  return { step_instance_id: id, step_id: phase, flow_instance_id: "flow-1", agent_id: null, status: "completed", input_json: {}, output_json: {}, result_json: { conclusion: "approved" }, transition_id: null, summary: "Approved", created_at: time, updated_at: time, completed_at: time };
}

function runtime(): FlowRuntimeRecord {
  return { revision: 1, acceptance_revision: 1, context: "", config_digest: "private-config-digest", state: {}, decisions: {}, evidence: {}, evidence_summaries: {}, owners: {}, correction: null };
}

function evidenceSnapshot(withRuntime = true): DashboardSnapshot {
  return {
    flows: [{ flow_record_id: "definition", flow_id: "development", version: "1", description: null, created_at: "", updated_at: "", config: {
      id: "development", initial_step: "expert_review", steps: {
        expert_review: {},
        plan_approval: { execution: "coordinator", decision: { key: "approve_plan", artifact_key: "plan", authority: "user" } }
      }
    } }],
    flow_instances: [{ flow_instance_id: "flow-1", flow_record_id: "definition", run_id: "run-1", status: "active", current_step_id: "expert_review", created_at: "", updated_at: "2026-09-06T12:00:00Z", ...(withRuntime ? { runtime: runtime() } : {}) }],
    flow_steps: [step("review-1")],
    flow_reports: []
  } as unknown as DashboardSnapshot;
}

function addReceipt(snapshot: DashboardSnapshot, key: string, receipt: Partial<FlowEvidenceSummaryRecord> = {}) {
  const record = { receipt_id: key, kind: "expert_review", status: "approved", step_instance_id: "review-1", summary: {}, ...receipt };
  snapshot.flow_instances[0]!.runtime!.evidence[key] = record.receipt_id;
  snapshot.flow_instances[0]!.runtime!.evidence_summaries![key] = record;
}

describe("phase evidence provenance", () => {
  it("does not convert completed legacy reports into verified evidence", () => {
    const view = buildFlowEvidenceView(evidenceSnapshot(false), { stepInstanceId: "review-1" })!;
    expect(view.available).toBe(false);
    expect(view.receipts).toEqual([]);
    expect(view.decision).toBeNull();
  });

  it("shows named retained scopes, reopened causes and reused checks from controller receipts", () => {
    const snapshot = evidenceSnapshot();
    addReceipt(snapshot, "expert", { summary: {
      reviewed_scopes: ["Checkout totals"], carried_scopes: ["Login guard"],
      reopened_scopes: [{ label: "Invoice mapping", reason: "The price schema changed" }],
      reused_checks: ["Login regression"], executed_checks: ["Invoice regression"]
    } });
    const view = buildFlowEvidenceView(snapshot, { stepInstanceId: "review-1" })!;
    expect(view.receipts[0]?.sections).toEqual([
      { title: "Reviewed in this attempt", items: ["Checkout totals"] },
      { title: "Carried forward in this review", items: ["Login guard"] },
      { title: "Reopened for review", items: ["Invoice mapping — The price schema changed"] },
      { title: "Checks executed", items: ["Invoice regression"] },
      { title: "Checks reused", items: ["Login regression"] }
    ]);
  });

  it("ignores unknown, removed and mismatching receipts and deduplicates aliases", () => {
    const snapshot = evidenceSnapshot();
    addReceipt(snapshot, "expert");
    addReceipt(snapshot, "alias", { receipt_id: "expert" });
    addReceipt(snapshot, "removed");
    addReceipt(snapshot, "wrong-id");
    addReceipt(snapshot, "unknown", { status: "self_reported" });
    delete snapshot.flow_instances[0]!.runtime!.evidence.removed;
    snapshot.flow_instances[0]!.runtime!.evidence["wrong-id"] = "other-receipt";
    expect(buildFlowEvidenceView(snapshot)!.receipts).toHaveLength(1);
  });

  it("does not carry a prior attempt's approval into its reopened phase", () => {
    const snapshot = evidenceSnapshot();
    addReceipt(snapshot, "expert");
    snapshot.flow_steps.push(step("review-2", "expert_review", "2026-09-06T13:00:00Z"));
    expect(buildFlowEvidenceView(snapshot)!.receipts).toEqual([]);
    const history = buildFlowEvidenceView(snapshot, { stepInstanceId: "review-1" })!;
    expect(history.history).toBe(true);
    expect(history.receipts).toHaveLength(1);
    expect(buildFlowEvidenceView(snapshot, { stepInstanceId: "unknown-attempt" })).toBeNull();
  });

  it("does not assign flow-wide evidence to a phase with no producing attempt", () => {
    const snapshot = evidenceSnapshot();
    addReceipt(snapshot, "unscoped", { step_instance_id: undefined, step_id: "expert_review" });
    const view = buildFlowEvidenceView(snapshot)!;
    expect(view.receipts).toEqual([]);
    expect(view.unscopedEvidence).toBe(true);
  });

  it("shows user decisions without needing an agent and keeps historical phases separate", () => {
    const snapshot = evidenceSnapshot();
    const instance = snapshot.flow_instances[0]!;
    instance.current_step_id = "plan_approval";
    instance.status = "waiting_for_orchestrator";
    snapshot.flow_steps.push({ ...step("approval-1", "plan_approval"), status: "active" });
    expect(buildFlowEvidenceView(snapshot)!.decision).toBe("Approve plan");
    expect(buildFlowEvidenceView(snapshot, { stepInstanceId: "review-1" })!.decision).toBeNull();
    expect(phaseWaitingLabel(instance, "plan_approval", snapshot.flows[0]!.config.steps.plan_approval)).toBe("Waiting for your decision");
    expect(phaseWaitingLabel(instance, "expert_review", {})).toBeNull();
  });

  it("distinguishes requester and orchestrator reviews from user decisions without relying on phase names", () => {
    const snapshot = evidenceSnapshot();
    const instance = snapshot.flow_instances[0]!;
    instance.status = "waiting_for_orchestrator";
    const config = snapshot.flows[0]!.config.steps.expert_review!;
    config.execution = "coordinator";
    config.decision = { key: "custom_intent_check", authority: "coordinator", owner: "requester" };
    let view = buildFlowEvidenceView(snapshot)!;
    expect(view.decision).toBeNull();
    expect(view.waitingLabel).toBe("Waiting for clarification owner review");
    expect(view.continuation).toContain("The conversation that clarified the request");
    config.decision.owner = "orchestrator";
    view = buildFlowEvidenceView(snapshot)!;
    expect(view.decision).toBeNull();
    expect(view.waitingLabel).toBe("Waiting for coordinator review");
    delete config.decision.authority;
    expect(buildFlowEvidenceView(snapshot)!.waitingLabel).toBe("Waiting for Codex");
    expect(buildFlowEvidenceView(snapshot)!.decision).toBeNull();
  });

  it("shows explicit recovery without exposing its internal identities", () => {
    const snapshot = evidenceSnapshot();
    snapshot.flow_instances[0]!.runtime!.recovery = { request_digest: "private-recovery-digest", role: "expert", previous_agent_id: "old-private-id", agent_id: "new-private-id", reason: "The previous review owner became unavailable.", restart_step_id: "expert_review", full_review_required: true };
    const view = buildFlowEvidenceView(snapshot)!;
    expect(view.recovery).toEqual({ reason: "The previous review owner became unavailable.", fullReviewRequired: true });
    expect(JSON.stringify(view)).not.toContain("private-");
  });

  it("shows the current handoff reason without presenting normal forward progress as a rollback", () => {
    const snapshot = evidenceSnapshot();
    snapshot.flow_instances[0]!.runtime!.correction = { from_step_id: "validation", summary: "Full checks passed", result: { conclusion: "passed" } };
    expect(buildFlowEvidenceView(snapshot)!.correction).toEqual({ title: "Phase handoff from Validation", text: "Full checks passed" });
    snapshot.flow_instances[0]!.status = "blocked";
    expect(buildFlowEvidenceView(snapshot)!.correction?.title).toBe("Phase handoff from Validation");
    expect(buildFlowEvidenceView(snapshot)!.continuation).toContain("This flow is paused.");
  });

  it("keeps prepared carry eligibility distinct from an approved review and tolerates missing detail", () => {
    const snapshot = evidenceSnapshot();
    addReceipt(snapshot, "scope", { kind: "review_scope", status: "prepared", summary: { carried_count: 2, reviewed_count: -3, reopened_count: Number.NaN } });
    expect(buildFlowEvidenceView(snapshot)!.receipts[0]?.sections).toEqual([
      { title: "Eligible to carry forward", items: ["2 scopes · names not recorded"] }
    ]);
  });

  it("labels evidence from older requirements instead of claiming it still validates the result", () => {
    const snapshot = evidenceSnapshot();
    addReceipt(snapshot, "expert", { acceptance_revision: 0 });
    expect(buildFlowEvidenceView(snapshot)!.receipts[0]?.notice).toBe("These records belong to a different version of the accepted requirements and do not validate the current result.");
  });
});
