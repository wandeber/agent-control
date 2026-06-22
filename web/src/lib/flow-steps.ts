import type { ArtifactRecord, DashboardSnapshot, EventRecord, FlowStepInstanceRecord } from "./types";

export function agentFlowSteps(snapshot: DashboardSnapshot, agentId: string | null): FlowStepInstanceRecord[] {
  if (!agentId) {
    return [];
  }
  return [...snapshot.flow_steps]
    .filter((step) => step.agent_id === agentId)
    .sort(compareFlowStepsNewestFirst);
}

export function latestAgentFlowStep(snapshot: DashboardSnapshot, agentId: string | null): FlowStepInstanceRecord | null {
  return agentFlowSteps(snapshot, agentId)[0] ?? null;
}

export function compareFlowStepsNewestFirst(a: FlowStepInstanceRecord, b: FlowStepInstanceRecord): number {
  const createdDelta = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return Date.parse(b.updated_at) - Date.parse(a.updated_at);
}

export function eventReferencesFlowStep(event: EventRecord, stepInstanceId: string | null): boolean {
  if (!stepInstanceId) {
    return true;
  }
  return recordContainsValue(event.payload, stepInstanceId, new Set(["step_instance_id", "stepInstanceId"]));
}

export function artifactReferencesFlowStep(
  snapshot: DashboardSnapshot,
  artifact: ArtifactRecord,
  stepInstanceId: string | null
): boolean {
  if (!stepInstanceId) {
    return true;
  }
  return snapshot.flow_artifact_bindings.some(
    (binding) =>
      binding.produced_by_step_instance_id === stepInstanceId &&
      (binding.artifact_id === artifact.artifact_id || binding.path === artifact.path)
  );
}

export function flowStepOptionLabel(step: FlowStepInstanceRecord, index: number): string {
  return `${index + 1}. ${step.step_id} · ${step.status}`;
}

function compareFlowStepsOldestFirst(a: FlowStepInstanceRecord, b: FlowStepInstanceRecord): number {
  return -compareFlowStepsNewestFirst(a, b);
}

export function flowStepOrdinal(snapshot: DashboardSnapshot, step: FlowStepInstanceRecord): number {
  const steps = [...snapshot.flow_steps]
    .filter((candidate) => candidate.agent_id === step.agent_id)
    .sort(compareFlowStepsOldestFirst);
  return steps.findIndex((candidate) => candidate.step_instance_id === step.step_instance_id) + 1;
}

function recordContainsValue(value: unknown, expected: string, keys: Set<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => recordContainsValue(item, expected, keys));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key) && nested === expected) {
      return true;
    }
    if (recordContainsValue(nested, expected, keys)) {
      return true;
    }
  }
  return false;
}
