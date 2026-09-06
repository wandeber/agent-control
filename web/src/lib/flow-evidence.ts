import { compareFlowStepsNewestFirst } from "./flow-steps";
import type { DashboardSnapshot, FlowEvidenceSummaryRecord, FlowInstanceRecord } from "./types";

export interface FlowEvidenceView {
  title: string;
  history: boolean;
  available: boolean;
  decision: string | null;
  continuation: string | null;
  correction: { title: string; text: string } | null;
  receipts: Array<{ title: string; status: string; notice: string | null; reason: string | null; sections: Array<{ title: string; items: string[] }> }>;
  unscopedEvidence: boolean;
}

const RECEIPT_TITLES: Record<string, string> = {
  artifact: "Artifact", plan_checkpoint: "Plan checkpoint", result_checkpoint: "Result checkpoint",
  review_scope: "Review scope", plan_delta: "Plan changes", plan_review: "Plan review",
  planner_review: "Implementation review", expert_review: "Expert review", plan_projection: "Plan excerpt",
  validation: "Mechanical checks", closure: "Closure verification"
};
const RECEIPT_STATUS: Record<string, string> = {
  prepared: "Prepared", approved: "Approved", rejected: "Changes required",
  passed: "Passed", failed: "Failed", verified: "Verified"
};

/** Never promote an old enum report or an unrelated receipt to verified evidence. */
export function buildFlowEvidenceView(snapshot: DashboardSnapshot, selection: {
  flowInstanceId?: string | null;
  stepId?: string | null;
  stepInstanceId?: string | null;
} = {}): FlowEvidenceView | null {
  const exactStep = selection.stepInstanceId
    ? snapshot.flow_steps.find((step) => step.step_instance_id === selection.stepInstanceId)
    : null;
  if (selection.stepInstanceId && !exactStep) return null;
  const instance = selectInstance(snapshot, exactStep?.flow_instance_id ?? selection.flowInstanceId);
  if (!instance) return null;
  const flow = snapshot.flows.find((candidate) => candidate.flow_record_id === instance.flow_record_id);
  const stepId = exactStep?.step_id ?? selection.stepId ?? instance.current_step_id;
  const step = exactStep ?? [...snapshot.flow_steps].filter((candidate) =>
    candidate.flow_instance_id === instance.flow_instance_id && candidate.step_id === stepId
  ).sort(compareFlowStepsNewestFirst)[0];
  const latestAttempt = stepId ? [...snapshot.flow_steps].filter((candidate) =>
    candidate.flow_instance_id === instance.flow_instance_id && candidate.step_id === stepId
  ).sort(compareFlowStepsNewestFirst)[0] : null;
  const history = Boolean(step && latestAttempt && step.step_instance_id !== latestAttempt.step_instance_id);
  const current = !history && instance.status !== "completed" && instance.status !== "cancelled" && Boolean(stepId && instance.current_step_id === stepId);
  const config = stepId ? flow?.config.steps[stepId] : null;
  const runtime = instance.runtime;
  const allReceipts = Object.entries(runtime?.evidence_summaries ?? {}).filter(([key, receipt]) =>
    runtime?.evidence[key] === receipt.receipt_id && RECEIPT_TITLES[receipt.kind] && RECEIPT_STATUS[receipt.status]
  ).map(([, receipt]) => receipt);
  // Receipt IDs are reused across aliases. Show each receipt once and only for
  // its producing attempt; matching a phase name alone can conceal a retry.
  const seen = new Set<string>();
  const scopedReceipts = allReceipts.filter((receipt) => {
    if (seen.has(receipt.receipt_id)) return false;
    const belongs = step ? receipt.step_instance_id === step.step_instance_id : !stepId;
    if (belongs) seen.add(receipt.receipt_id);
    return belongs;
  });
  const waiting = current && instance.status === "waiting_for_orchestrator";
  const correction = current ? runtime?.correction : null;
  const reason = text(correction?.summary);
  const source = text(correction?.from_step_id);

  return {
    title: stepId ? humanizePhase(stepId) : "Flow",
    history,
    available: Boolean(runtime),
    decision: waiting && config?.decision ? humanizePhase(config.decision.key) : null,
    continuation: current && instance.status === "blocked"
      ? "This flow is paused. Check the Codex conversation for the required recovery action."
      : waiting && !config?.decision ? "Waiting for the Codex conversation to continue the flow." : null,
    correction: reason ? {
      title: `Phase handoff${source ? ` from ${humanizePhase(source)}` : ""}`,
      text: reason
    } : null,
    receipts: scopedReceipts.map((receipt) => receiptView(receipt, runtime?.acceptance_revision)),
    unscopedEvidence: Boolean(stepId && allReceipts.some((receipt) => !receipt.step_instance_id))
  };
}

function selectInstance(snapshot: DashboardSnapshot, id?: string | null): FlowInstanceRecord | null {
  if (id) return snapshot.flow_instances.find((instance) => instance.flow_instance_id === id) ?? null;
  return snapshot.flow_instances.find((instance) => instance.status === "active" || instance.status === "waiting_for_orchestrator")
    ?? [...snapshot.flow_instances].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0] ?? null;
}

function receiptView(receipt: FlowEvidenceSummaryRecord, acceptanceRevision?: number): FlowEvidenceView["receipts"][number] {
  const summary = receipt.summary ?? {};
  const sections: FlowEvidenceView["receipts"][number]["sections"] = [];
  const add = (title: string, values: unknown, count: unknown, noun: string) => {
    const items = strings(values);
    if (items.length === 0 && typeof count === "number" && Number.isSafeInteger(count) && count > 0) {
      items.push(`${count} ${noun}${count === 1 ? "" : "s"} · names not recorded`);
    }
    if (items.length > 0) sections.push({ title, items });
  };
  add("Reviewed in this attempt", summary.reviewed_scopes, summary.reviewed_count, "scope");
  add(receipt.status === "prepared" ? "Eligible to carry forward" : "Carried forward in this review", summary.carried_scopes, summary.carried_count, "scope");
  const reopened = Array.isArray(summary.reopened_scopes) ? summary.reopened_scopes.flatMap((item) => {
    const label = text(item?.label);
    const reason = text(item?.reason);
    return label ? [`${label}${reason ? ` — ${reason}` : ""}`] : [];
  }) : [];
  add("Reopened for review", reopened, summary.reopened_count, "scope");
  add("Checks executed", summary.executed_checks, summary.executed_check_count, "check");
  add("Checks reused", summary.reused_checks, summary.reused_check_count, "check");
  const notice = receipt.acceptance_revision !== undefined && receipt.acceptance_revision !== acceptanceRevision
    ? "These records belong to a different version of the accepted requirements and do not validate the current result."
    : null;
  return { title: RECEIPT_TITLES[receipt.kind]!, status: RECEIPT_STATUS[receipt.status]!, notice, reason: text(summary.reason), sections };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.flatMap((item) => text(item) ? [text(item)!] : []))] : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function humanizePhase(value: string): string {
  const label = value.replaceAll(/[_-]+/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function phaseWaitingLabel(instance: FlowInstanceRecord, stepId: string, step?: { decision?: { key: string }; execution?: string }): string | null {
  if (instance.current_step_id !== stepId || instance.status !== "waiting_for_orchestrator") return null;
  return step?.decision ? "Waiting for your decision" : step?.execution === "coordinator" ? "Waiting for Codex" : null;
}
