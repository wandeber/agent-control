import type {
  DashboardSnapshot,
  FlowConfigRecord,
  FlowConditionConfigRecord,
  FlowInstanceRecord,
  FlowRecord,
  FlowStepActionConfigRecord,
  FlowStepConfigRecord,
  FlowStepInstanceRecord,
  FlowTransitionConfigRecord
} from "./types";
import { compareFlowStepsNewestFirst } from "./flow-steps";
import { phaseWaitingLabel } from "./flow-evidence";

export type FlowVisualNodeKind = "decision" | "finish" | "notify" | "step";
export type FlowVisualStepStatus = FlowStepInstanceRecord["status"] | "planned";

export interface FlowVisualModel {
  flow: FlowRecord;
  instance: FlowInstanceRecord;
  nodes: FlowVisualNode[];
  edges: FlowVisualEdge[];
}

export interface FlowVisualNode {
  id: string;
  kind: FlowVisualNodeKind;
  title: string;
  subtitle: string;
  description: string | null;
  isCurrent: boolean;
  position: { x: number; y: number };
  role: string | null;
  stepId: string | null;
  latestStep: FlowStepInstanceRecord | null;
  instanceCount: number;
  status: FlowVisualStepStatus;
  reportValues: string[];
  inputCount: number;
  outputCount: number;
  waitingLabel?: string | null;
}

export interface FlowVisualEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  tone: "default" | "finish" | "notify" | "taken";
  transitionId: string | null;
  sourceStepId: string | null;
}

type VirtualTargetKind = "finish" | "notify";

const STEP_X_GAP = 332;
const STEP_ROW_HEIGHT = 250;
const STEPS_PER_ROW = 8;
const VIRTUAL_X_GAP = 142;
const VIRTUAL_Y_GAP = 62;

export function buildFlowVisualModel(snapshot: DashboardSnapshot): FlowVisualModel | null {
  const instance = selectFlowInstance(snapshot);
  if (!instance) {
    return null;
  }

  const flow = snapshot.flows.find((candidate) => candidate.flow_record_id === instance.flow_record_id);
  if (!flow) {
    return null;
  }

  const stepOrder = orderFlowSteps(flow.config.initial_step, flow.config.steps);
  const stepsById = new Map(Object.entries(flow.config.steps));
  const stepRuntime = latestFlowStepsByStepId(snapshot, instance.flow_instance_id);
  const nodes = new Map<string, FlowVisualNode>();
  const edges: FlowVisualEdge[] = [];
  const virtualIndexes = new Map<VirtualTargetKind, number>();
  const takenTransitions = takenTransitionKeys(snapshot, instance.flow_instance_id, stepRuntime);

  stepOrder.forEach((stepId, index) => {
    const step = stepsById.get(stepId);
    if (!step) {
      return;
    }
    const runtime = stepRuntime.get(stepId) ?? [];
    const latestStep = runtime[0] ?? null;
    const isCurrent = instance.status !== "completed" && instance.status !== "cancelled" && instance.current_step_id === stepId;
    nodes.set(stepNodeId(stepId), {
      id: stepNodeId(stepId),
      kind: "step",
      title: humanizeStepId(stepId),
      subtitle: step.role ? `${step.role} phase` : "Flow phase",
      description: step.description ?? null,
      isCurrent,
      position: stepPosition(index),
      role: step.role ?? null,
      stepId,
      latestStep,
      instanceCount: runtime.length,
      status: latestStep?.status ?? (isCurrent ? "active" : "planned"),
      reportValues: reportEnumValues(step),
      inputCount: Object.keys(step.inputs ?? {}).length,
      outputCount: Object.keys(step.outputs ?? {}).length,
      waitingLabel: phaseWaitingLabel(instance, stepId, step)
    });
  });

  for (const [stepId, step] of stepsById) {
    for (const [eventName, action] of Object.entries(step.on ?? {})) {
      addActionEdges({
        action,
        edges,
        eventName,
        nodes,
        sourceNodeId: stepNodeId(stepId),
        sourceStepId: stepId,
        stepIndex: stepOrder.indexOf(stepId),
        stepOrder,
        takenTransitions,
        virtualIndexes
      });
    }
  }

  // Manual continuations are recorded by the runtime, not declared in the flow.
  // Include them so an orchestrator handoff never leaves the next phase disconnected.
  const runtimeById = new Map(snapshot.flow_steps.map((step) => [step.step_instance_id, step]));
  for (const transition of snapshot.flow_transitions) {
    if (transition.flow_instance_id !== instance.flow_instance_id || !transition.action_json.manual || !transition.target_step_id) continue;
    const source = runtimeById.get(transition.from_step_instance_id);
    if (!source || !nodes.has(stepNodeId(transition.target_step_id))) continue;
    edges.push({
      id: `manual:${transition.flow_transition_id}`,
      source: stepNodeId(source.step_id),
      target: stepNodeId(transition.target_step_id),
      label: "Orchestrator continuation",
      tone: takenTransitions.has(`${source.step_id}:${transition.transition_id}`) ? "taken" : "default",
      transitionId: transition.transition_id,
      sourceStepId: source.step_id
    });
  }

  const lastTransition = [...snapshot.flow_transitions].reverse()
    .filter((transition) => transition.flow_instance_id === instance.flow_instance_id)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  for (const node of nodes.values()) {
    if (node.kind === "finish") {
      node.status = instance.status === "completed" ? "completed" : "planned";
    }
    if (node.kind === "notify") {
      node.isCurrent = instance.status === "waiting_for_orchestrator" && lastTransition?.action_json.notify === node.role;
      node.status = node.isCurrent ? "active" : "planned";
    }
  }

  return { flow, instance, nodes: [...nodes.values()], edges };
}

function selectFlowInstance(snapshot: DashboardSnapshot): FlowInstanceRecord | null {
  return (
    snapshot.flow_instances.find((instance) => instance.status === "active") ??
    [...snapshot.flow_instances].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0] ??
    null
  );
}

function latestFlowStepsByStepId(
  snapshot: DashboardSnapshot,
  flowInstanceId: string
): Map<string, FlowStepInstanceRecord[]> {
  const grouped = new Map<string, FlowStepInstanceRecord[]>();
  for (const step of snapshot.flow_steps.filter((item) => item.flow_instance_id === flowInstanceId)) {
    grouped.set(step.step_id, [...(grouped.get(step.step_id) ?? []), step]);
  }
  for (const [stepId, steps] of grouped) {
    grouped.set(
      stepId,
      [...steps].sort((a, b) => compareFlowStepsNewestFirst(a, b) || Number(b.status === "active") - Number(a.status === "active"))
    );
  }
  return grouped;
}

function takenTransitionKeys(snapshot: DashboardSnapshot, flowInstanceId: string, stepRuntime: Map<string, FlowStepInstanceRecord[]>): Set<string> {
  const stepsByInstanceId = new Map(snapshot.flow_steps.map((step) => [step.step_instance_id, step]));
  const keys = new Set<string>();
  for (const transition of snapshot.flow_transitions.filter((item) => item.flow_instance_id === flowInstanceId)) {
    const step = stepsByInstanceId.get(transition.from_step_instance_id);
    // Cards represent the latest attempt; highlighted exits must represent that
    // same attempt instead of accumulating incompatible outcomes from retries.
    if (step && stepRuntime.get(step.step_id)?.[0]?.step_instance_id === step.step_instance_id) {
      keys.add(`${step.step_id}:${transition.transition_id}`);
    }
  }
  return keys;
}

function orderFlowSteps(initialStep: string, steps: Record<string, FlowStepConfigRecord>): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const visit = (stepId: string) => {
    if (seen.has(stepId) || !steps[stepId]) {
      return;
    }
    seen.add(stepId);
    ordered.push(stepId);
    for (const target of actionTargets(steps[stepId]?.on)) {
      visit(target);
    }
  };

  visit(initialStep);
  for (const stepId of Object.keys(steps)) {
    visit(stepId);
  }
  return ordered;
}

function actionTargets(on: FlowStepConfigRecord["on"]): string[] {
  const targets: string[] = [];
  for (const action of Object.values(on ?? {})) {
    collectActionTargets(action, targets);
  }
  return targets;
}

function collectActionTargets(action: FlowStepActionConfigRecord, targets: string[]): void {
  if (action.to) {
    targets.push(action.to);
  }
  for (const transition of action.transitions ?? []) {
    collectActionTargets(transition, targets);
  }
}

function addActionEdges(input: {
  action: FlowStepActionConfigRecord;
  edges: FlowVisualEdge[];
  eventName: string;
  nodes: Map<string, FlowVisualNode>;
  sourceNodeId: string;
  sourceStepId: string | null;
  stepIndex: number;
  stepOrder: string[];
  takenTransitions: Set<string>;
  virtualIndexes: Map<VirtualTargetKind, number>;
}) {
  const transitions = input.action.transitions ?? [];
  if (transitions.length > 0) {
    transitions.forEach((transition, index) => {
      addTransitionTargetEdges({
        ...input,
        action: transition,
        edgeIndex: index,
        label: transitionLabel(transition),
        sourceNodeId: input.sourceNodeId,
        transitionId: transition.id
      });
    });
    return;
  }

  addTransitionTargetEdges({
    ...input,
    edgeIndex: 0,
    label: actionLabel(input.action, input.eventName),
    transitionId: fallbackTransitionId(input.sourceStepId, input.action)
  });
}

function addTransitionTargetEdges(input: {
  action: FlowStepActionConfigRecord;
  edgeIndex: number;
  edges: FlowVisualEdge[];
  eventName: string;
  label: string;
  nodes: Map<string, FlowVisualNode>;
  sourceNodeId: string;
  sourceStepId: string | null;
  stepIndex: number;
  stepOrder: string[];
  takenTransitions: Set<string>;
  transitionId: string | null;
  virtualIndexes: Map<VirtualTargetKind, number>;
}) {
  if (input.action.transitions?.length) {
    addActionEdges(input);
    return;
  }

  const target = targetForAction(input.action, input);
  if (!target) {
    return;
  }

  const taken = input.transitionId && input.sourceStepId
    ? input.takenTransitions.has(`${input.sourceStepId}:${input.transitionId}`)
    : false;
  input.edges.push({
    id: `${input.sourceNodeId}->${target.id}:${input.transitionId ?? input.edgeIndex}`,
    source: input.sourceNodeId,
    target: target.id,
    label: input.label,
    tone: taken ? "taken" : target.tone,
    transitionId: input.transitionId,
    sourceStepId: input.sourceStepId
  });
}

function targetForAction(
  action: FlowStepActionConfigRecord,
  input: {
    nodes: Map<string, FlowVisualNode>;
    stepIndex: number;
    stepOrder: string[];
    virtualIndexes: Map<VirtualTargetKind, number>;
  }
): { id: string; tone: FlowVisualEdge["tone"] } | null {
  if (action.to) {
    return { id: stepNodeId(action.to), tone: "default" };
  }
  // Match runtime precedence: a finish can also send a notification.
  if (action.finish) {
    const id = virtualNodeId("finish", "done");
    if (!input.nodes.has(id)) {
      input.nodes.set(id, {
        id,
        kind: "finish",
        title: "Done",
        subtitle: "Flow terminal",
        description: "The selected transition marks the flow as completed.",
        isCurrent: false,
        position: virtualPosition("finish", input.stepOrder.length, 0),
        role: null,
        stepId: null,
        latestStep: null,
        instanceCount: 0,
        status: "planned",
        reportValues: [],
        inputCount: 0,
        outputCount: 0
      });
    }
    return { id, tone: "finish" };
  }
  if (action.notify) {
    const id = virtualNodeId("notify", action.notify);
    if (!input.nodes.has(id)) {
      const index = input.virtualIndexes.get("notify") ?? 0;
      input.virtualIndexes.set("notify", index + 1);
      input.nodes.set(id, {
        id,
        kind: "notify",
        title: humanizeStepId(action.notify),
        subtitle: "Notification target",
        description: "Agent Control notifies this role instead of auto-routing to another phase.",
        isCurrent: false,
        position: virtualPosition("notify", input.stepOrder.length, index),
        role: action.notify,
        stepId: null,
        latestStep: null,
        instanceCount: 0,
        status: "planned",
        reportValues: [],
        inputCount: 0,
        outputCount: 0
      });
    }
    return { id, tone: "notify" };
  }
  return null;
}

function stepNodeId(stepId: string): string {
  return `step:${stepId}`;
}

function stepPosition(index: number): { x: number; y: number } {
  const row = Math.floor(index / STEPS_PER_ROW);
  const column = index % STEPS_PER_ROW;
  return {
    x: column * STEP_X_GAP,
    y: row * STEP_ROW_HEIGHT
  };
}

function virtualPosition(kind: VirtualTargetKind, stepCount: number, index: number): { x: number; y: number } {
  const rowCount = Math.max(1, Math.ceil(Math.max(1, stepCount) / STEPS_PER_ROW));
  const columns = Math.max(1, Math.min(stepCount, STEPS_PER_ROW));
  const centerX = ((columns - 1) * STEP_X_GAP) / 2;
  const kindOffset = kind === "notify" ? -VIRTUAL_X_GAP : VIRTUAL_X_GAP;
  return {
    x: centerX + kindOffset,
    y: rowCount * STEP_ROW_HEIGHT + index * VIRTUAL_Y_GAP
  };
}

function virtualNodeId(kind: VirtualTargetKind, id: string): string {
  return `${kind}:${id}`;
}

function reportEnumValues(step: FlowStepConfigRecord): string[] {
  const conclusion = step.report?.schema?.properties?.conclusion?.enum ?? [];
  return conclusion.map((value) => String(value));
}

function transitionLabel(transition: FlowTransitionConfigRecord): string {
  return transition.when ? conditionLabel(transition.when) : actionLabel(transition, transition.id);
}

function actionLabel(action: FlowStepActionConfigRecord, fallback: string): string {
  if (action.to) {
    return fallback;
  }
  if (action.finish) {
    return action.notify ? `finish and notify ${action.notify}` : "finish";
  }
  if (action.notify) {
    return `notify ${action.notify}`;
  }
  return fallback;
}

function fallbackTransitionId(sourceStepId: string | null, action: FlowStepActionConfigRecord): string | null {
  if (!sourceStepId) {
    return null;
  }
  if (action.to) {
    return `${sourceStepId}-to-${action.to}`;
  }
  return action.notify || action.finish ? "notify" : null;
}

function conditionLabel(condition: FlowConditionConfigRecord): string {
  if ("equals" in condition) {
    if (condition.equals.var === "result.conclusion") {
      return String(condition.equals.value);
    }
    if (condition.equals.var === "result.target_phase") {
      return `target ${String(condition.equals.value)}`;
    }
    return `${shortVar(condition.equals.var)} = ${String(condition.equals.value)}`;
  }
  if ("exists" in condition) {
    return `${shortVar(condition.exists.var)} exists`;
  }
  if ("all" in condition) {
    return condition.all.map(conditionLabel).join(" + ");
  }
  return condition.any.map(conditionLabel).join(" / ");
}

function shortVar(value: string): string {
  return value.split(".").at(-1) ?? value;
}

function humanizeStepId(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

/** Build an authored graph directly; source inspection never needs a fake run. */
export function buildFlowDefinitionGraph(config: FlowConfigRecord): { nodes: FlowVisualNode[]; edges: FlowVisualEdge[] } {
  const stepOrder = orderFlowSteps(config.initial_step, config.steps);
  const nodes = new Map<string, FlowVisualNode>();
  const edges: FlowVisualEdge[] = [];
  const virtualIndexes = new Map<VirtualTargetKind, number>();
  stepOrder.forEach((stepId, index) => {
    const step = config.steps[stepId]!;
    nodes.set(stepNodeId(stepId), { id: stepNodeId(stepId), kind: "step", title: humanizeStepId(stepId),
      subtitle: step.role ?? "Coordinator", description: step.description ?? null, isCurrent: false,
      position: stepPosition(index), role: step.role ?? null, stepId, latestStep: null, instanceCount: 0,
      status: "planned", reportValues: reportEnumValues(step), inputCount: Object.keys(step.inputs ?? {}).length,
      outputCount: Object.keys(step.outputs ?? {}).length });
  });
  for (const [stepId, step] of Object.entries(config.steps)) for (const [eventName, action] of Object.entries(step.on ?? {})) {
    addActionEdges({ action, edges, eventName, nodes, sourceNodeId: stepNodeId(stepId), sourceStepId: stepId,
      stepIndex: stepOrder.indexOf(stepId), stepOrder, takenTransitions: new Set(), virtualIndexes });
  }
  return { nodes: [...nodes.values()], edges };
}
