import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFlowConfigFile } from "../src/core/flow-config-loader.js";
import { evaluateCondition, parseFlowConfig, selectTransition } from "../src/core/flow.js";
import type { FlowConditionConfig, FlowConfig } from "../src/core/types.js";

const path = resolve(import.meta.dirname, "../../../flows/development-flow-v1/flow.yaml");
const raw = loadFlowConfigFile(path, { env: {} }) as FlowConfig;
const record = raw as unknown as Record<string, any>;

function route(step: string, result: Record<string, unknown>, state = {}, decisions = {}) {
  return selectTransition(raw.steps[step]!.on!.reported!, { result, state, decisions });
}

// These fixtures exercise the actual declarative router. Receipt verification
// and transaction recovery remain controller/evidence integration concerns.
describe("development-flow-v1 responsibility and routing parity", () => {
  it("retains strict gates through parsing and starts with factual Context", () => {
    const parsed = parseFlowConfig(raw) as unknown as Record<string, any>;
    expect(parsed.policy).toMatchObject({ strict: true, plan_artifact: "plan" });
    expect(parsed.initial_step).toBe("context");
    expect(parsed.steps.context.role).toBe(parsed.steps.analysis.role);
    expect(route("context", { conclusion: "ready" })?.to).toBe("analysis");
  });

  it("keeps the clarification-owner intention decision separate from plan review", () => {
    expect(route("analysis", { conclusion: "ready" })?.to).toBe("analysis_intent");
    expect(record.steps.analysis_intent).toMatchObject({
      execution: "coordinator",
      decision: { key: "analysis_intent", artifact_key: "analysis", authority: "coordinator" }
    });
    expect(route("analysis_intent", { decision: "changes_required" })?.to).toBe("analysis");
    expect(record.steps.plan_review.role).toBe(record.steps.analysis.role);
  });

  it("requires exact human plan approval after strict analyst approval", () => {
    expect(route("plan_review", { conclusion: "approved" })).toMatchObject({
      to: "plan_approval",
      requires_evidence: [{ kind: "plan_review", owner_role: "analyst" }]
    });
    expect(record.steps.plan_approval.decision).toEqual({ key: "plan_approval", artifact_key: "plan", authority: "user" });
    const guard = record.steps.implementation.requires as FlowConditionConfig;
    expect(evaluateCondition(guard, { decisions: {} })).toBe(false);
    expect(evaluateCondition(guard, { decisions: { plan_approval: { value: "approved" } } })).toBe(true);
    expect(route("plan_approval", { decision: "changes_required" })?.to).toBe("planning");
  });

  it("integrates only when multiple outputs need consolidation", () => {
    expect(route("implementation", { conclusion: "ready", integration_needed: true })?.to).toBe("integration");
    expect(route("implementation", { conclusion: "ready", integration_needed: false }, { validation_mode: "complete_gate" })?.to).toBe("validation");
    expect(route("implementation", { conclusion: "ready", integration_needed: false }, { validation_mode: "focused_recheck" })?.to).toBe("focused_validation");
  });

  it("keeps focused passes distinct from the complete gate", () => {
    expect(route("focused_validation", { conclusion: "passed" })?.to).toBe("validation");
    expect(route("validation", { conclusion: "failed" })).toMatchObject({ to: "implementation", set: { validation_mode: "focused_recheck" } });
    expect(record.steps.validation.role).toBe("validator");
    expect(record.steps.validation.sandbox).toBe("read_only");
    expect(route("focused_validation", { conclusion: "passed" })).toMatchObject({ requires_evidence: [{ validation_mode: "focused" }] });
    expect(route("validation", { conclusion: "passed" }, { planner_approved: false })).toMatchObject({ requires_evidence: [{ validation_mode: "complete_gate" }] });
  });

  it("preserves first planner approval and bypasses it on expert corrections", () => {
    expect(route("validation", { conclusion: "passed" }, { planner_approved: false })?.to).toBe("implementation_review");
    expect(route("implementation_review", { conclusion: "approved" })).toMatchObject({
      to: "uat_decision", set: { planner_approved: true },
      requires_evidence: [{ kind: "planner_review", owner_role: "planner" }]
    });
    expect(route("validation", { conclusion: "passed" }, { planner_approved: true, uat_completed: true })?.to).toBe("final_review");
    expect(route("final_review", { conclusion: "changes_required", target_phase: "implementation" })).toMatchObject({
      to: "implementation", set: { validation_mode: "focused_recheck" }
    });
  });

  it("asks once for UAT and preserves the user-selected branch through corrections", () => {
    expect(record.preferences.uat_preference.values).toEqual(["prepare", "skip"]);
    expect(route("uat_decision", { decision: "skip" })).toMatchObject({ to: "final_review", set: { uat_completed: true } });
    expect(route("uat_decision", { decision: "prepare" })?.to).toBe("uat_preparation");
    expect(route("uat_preparation", { conclusion: "ready" })?.to).toBe("uat_review");
    expect(route("uat_review", { decision: "changes_required" })).toMatchObject({ to: "implementation", set: { uat_completed: false } });
    expect(route("validation", { conclusion: "passed" }, { planner_approved: true, uat_completed: false }, { uat_preference: { value: "prepare" } })?.to).toBe("uat_preparation");
  });

  it("stops automatic expert corrections under an explicit single-review preference", () => {
    expect(route("final_review", { conclusion: "changes_required", target_phase: "implementation" }, {}, { review_mode: { value: "single_review" } })).toMatchObject({ notify: "orchestrator" });
    expect(route("final_review", { conclusion: "changes_required", target_phase: "planning" })?.to).toBe("planning");
  });

  it("requires independent expert receipts and a separate verified closure", () => {
    expect(route("final_review", { conclusion: "approved", target_phase: "done" })).toMatchObject({
      to: "closure", requires_evidence: [{ kind: "expert_review", owner_role: "final_reviewer" }]
    });
    expect(route("final_review", { conclusion: "approved", target_phase: "done" })?.finish).toBeUndefined();
    expect(record.steps.closure.execution).toBe("coordinator");
    expect(route("closure", { conclusion: "verified" })).toMatchObject({ finish: true, requires_evidence: [{ receipt: "evidence.closure", kind: "closure" }] });
    expect(record.steps.final_review.evidence_gates).toEqual(["expert"]);
    expect(record.steps.implementation_review.evidence_gates).toEqual(["planner"]);
    expect(record.steps.implementation.evidence_gates).toBeUndefined();
  });

  it("keeps only real document artifacts and preserves configured worker models", () => {
    expect(Object.keys(raw.artifacts ?? {}).sort()).toEqual(["analysis", "context", "plan", "uat_guide"]);
    expect(raw.roles?.final_reviewer?.model).toBe("gpt-5.5");
    for (const name of ["analyst", "planner", "implementer", "validator"]) {
      expect(raw.roles?.[name]).toMatchObject({ backend: "codex-thread", model: "gpt-5.6-luna", reasoning_effort: "max", agent_lifecycle: "reuse" });
    }
  });
});
