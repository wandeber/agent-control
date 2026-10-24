import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { AgentDefinitionCatalog } from "../src/core/agent-definitions.js";
import { resolveFlowAgentDefinitions } from "../src/core/flow-agent-definitions.js";
import { describe, expect, it } from "vitest";
import { loadFlowConfigFile } from "../src/core/flow-config-loader.js";
import { evaluateCondition, parseFlowConfig, selectTransition } from "../src/core/flow.js";
import type { FlowConditionConfig, FlowConfig } from "../src/core/types.js";

const path = resolve(import.meta.dirname, "../../../flows/development-flow-v1/flow.yaml");
const raw = loadFlowConfigFile(path, { env: {} }) as FlowConfig;
const record = raw as unknown as Record<string, any>;

function route(step: string, result: Record<string, unknown>, state = {}, decisions = {}, packages = { integration_required: false }) {
  return selectTransition(raw.steps[step]!.on!.reported!, { result, state, decisions, packages });
}

// These fixtures exercise the actual declarative router. Receipt verification
// and transaction recovery remain controller/evidence integration concerns.
describe("development-flow-v1 responsibility and routing parity", () => {
  it("retains strict gates through parsing and starts with factual Context", () => {
    const parsed = parseFlowConfig(raw) as unknown as Record<string, any>;
    expect(parsed.policy).toMatchObject({ strict: true, plan_artifact: "plan", work_packages: { approval_decision: "plan_approval", manifest_step: "plan_review", execution_step: "implementation", integration_step: "integration", success_condition: { equals: { var: "result.conclusion", value: "ready" } } } });
    expect(parsed.initial_step).toBe("context");
    expect(parsed.steps.context.role).not.toBe(parsed.steps.analysis.role);
    expect(route("context", { conclusion: "ready" })?.to).toBe("analysis");
  });

  it("hands ready Analysis directly to Planning while preserving clarification and plan review", () => {
    expect(route("analysis", { conclusion: "ready" })?.to).toBe("planning");
    expect(record.steps.analysis_intent).toBeUndefined();
    expect(record.steps.planning.requires).toBeUndefined();
    expect(record.steps.planning.inputs.analysis).toEqual({ artifact: "analysis", required: true });
    for (const step of ["context", "analysis"]) {
      expect(route(step, { conclusion: "needs_clarification" })).toMatchObject({ notify: "orchestrator" });
      expect(route(step, { conclusion: "needs_clarification" })?.to).toBeUndefined();
    }
    expect(record.steps.plan_review.role).toBe(record.steps.analysis.role);
  });

  it("requires exact human plan approval after strict analyst approval", () => {
    expect(route("plan_review", { conclusion: "approved" })).toMatchObject({
      to: "plan_approval",
      requires_evidence: [{ kind: "plan_review", owner_role: "analyst" }]
    });
    expect(record.steps.plan_approval.decision).toEqual({ key: "plan_approval", artifact_key: "plan", authority: "user", owner: "requester" });
    const guard = record.steps.implementation.requires as FlowConditionConfig;
    expect(evaluateCondition(guard, { decisions: {} })).toBe(false);
    expect(evaluateCondition(guard, { decisions: { plan_approval: { value: "approved" } } })).toBe(true);
    expect(route("plan_approval", { decision: "changes_required" })?.to).toBe("planning");
  });

  it("derives external integration from the package group instead of a worker claim", () => {
    expect(route("implementation", { conclusion: "ready", integration_needed: false }, {}, {}, { integration_required: true })?.to).toBe("integration");
    expect(record.steps.implementation.report.schema.required).toEqual(["conclusion"]);
    expect(record.steps.implementation.report.schema.properties.integration_needed).toBeUndefined();
    for (const step of ["validation", "implementation_review", "uat_decision", "uat", "final_review", "closure"]) {
      expect(record.steps[step].requires.all).toContainEqual({ equals: { var: "packages.integrated", value: true } });
    }
    expect(record.steps.integration.requires.all).toContainEqual({ equals: { var: "packages.joined", value: true } });
    expect(route("integration", { conclusion: "needs_package_changes" })?.to).toBe("implementation");
    expect(route("implementation", { conclusion: "ready" })?.to).toBe("validation");
    expect(route("integration", { conclusion: "ready" })?.to).toBe("validation");
  });

  it("returns corrections to one Validation phase without weakening complete coverage", () => {
    expect(record.steps.focused_validation).toBeUndefined();
    expect(record.state.validation_mode).toBeUndefined();
    expect(route("validation", { conclusion: "failed" })?.to).toBe("implementation");
    expect(route("implementation_review", { conclusion: "implementation_changes_needed" })?.to).toBe("implementation");
    expect(route("uat", { conclusion: "implementation_changes_needed" })?.to).toBe("implementation");
    expect(route("uat", { conclusion: "ready" }, {}, { uat_result: { value: "changes_required" } })?.to).toBe("implementation");
    expect(record.steps.validation.role).toBe("validator");
    expect(record.steps.validation.sandbox).toBe("read_only");
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
      to: "implementation"
    });
  });

  it("advances accepted isolated test passes through the same guarded validation routes", () => {
    const conclusion = "accepted_with_isolated_test_passes";
    for (const [state, decisions, requestClosure] of [
      [{ planner_approved: false }, {}, false],
      [{ planner_approved: true, uat_completed: true }, {}, false],
      [{ planner_approved: true, uat_completed: false }, { uat_preference: { value: "prepare" } }, false],
      [{ planner_approved: true, uat_completed: false }, {}, false],
      [{ planner_approved: true, uat_completed: true }, {}, true],
    ] as const) {
      expect(route("validation", { conclusion, request_closure: requestClosure }, state, decisions))
        .toEqual(route("validation", { conclusion: "passed", request_closure: requestClosure }, state, decisions));
    }
    expect(record.steps.validation.evidence_operations).toContain("validation_resolve_isolated_tests");
    expect(record.steps.validation.report.schema.properties.conclusion.enum).toContain(conclusion);
  });

  it("asks once for UAT and preserves the user-selected branch through corrections", () => {
    expect(record.preferences.uat_preference.values).toEqual(["prepare", "skip"]);
    expect(route("uat_decision", { decision: "skip" })).toMatchObject({ to: "final_review", set: { uat_completed: true } });
    expect(route("uat_decision", { decision: "prepare" })?.to).toBe("uat");
    expect(route("uat", { conclusion: "ready" })).toBeNull();
    expect(() => parseFlowConfig({ ...raw, preferences: { ...raw.preferences, invalid: { values: ["approved"], step_id: "missing-phase" } } })).toThrow(/existing step/);
    expect(record.steps.uat_review).toBeUndefined();
    expect(record.preferences.uat_result).toMatchObject({ step_id: "uat", owner: "requester" });
    expect(route("uat", { conclusion: "ready" }, {}, { uat_result: { value: "approved" } })?.to).toBe("final_review");
    expect(route("uat", { conclusion: "ready" }, {}, { uat_result: { value: "changes_required" } })).toMatchObject({ to: "implementation", set: { uat_completed: false } });
    expect(route("validation", { conclusion: "passed" }, { planner_approved: true, uat_completed: false }, { uat_preference: { value: "prepare" } })?.to).toBe("uat");
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
    const catalog = new AgentDefinitionCatalog(resolve(import.meta.dirname, "missing-personal-catalog.json"));
    const effective = resolveFlowAgentDefinitions(parseFlowConfig(raw), catalog);
    expect(raw.roles?.analyst).toMatchObject({ backend: "codex-cli", model: "gpt-6-astra", model_provider: "openai", reasoning_effort: "xhigh", agent_lifecycle: "reuse", prompt_ref: "role_analyst" });
    expect(raw.roles?.analyst.agent_ref).toBeUndefined();
    expect(readFileSync(resolve(import.meta.dirname, "../../../flows/development-flow-v1/roles/analyst.md"), "utf8")).toBe(catalog.resolve("development-analyst").definition.instructions);
    for (const name of ["context", "planner", "implementer", "integrator", "validator", "final_reviewer"]) {
      expect(raw.roles?.[name]).toEqual({ agent_ref: `development-${name.replaceAll("_", "-")}`, agent_lifecycle: "reuse" });
      expect(effective.roles?.[name]).toMatchObject({ backend: "codex-cli", model_provider: "openai", resolved_agent: { definition: { capabilities_mode: "inherit" } } });
    }
    expect(Object.keys(raw.prompts ?? {}).filter(name => name.startsWith("role_"))).toEqual(["role_analyst"]);
    expect(effective.roles?.final_reviewer).toMatchObject({ model: "gpt-6.1-sol", reasoning_effort: "xhigh" });
    expect(record.steps.context.role).toBe("context");
    expect(record.steps.analysis.role).toBe("analyst");
    expect(record.steps.plan_review.role).toBe("analyst");
    expect(effective.roles?.context).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "max" });
    expect(effective.roles?.validator).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "high" });
    for (const name of ["planner", "implementer", "integrator"]) expect(effective.roles?.[name]).toMatchObject({ model: "gpt-6.1-sol", reasoning_effort: "xhigh" });
    expect(record.steps.integration.role).toBe("integrator");
  });
});
