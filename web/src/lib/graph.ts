import type {
  AgentComputedState,
  AgentLinkRecord,
  AgentLinkType,
  AgentRecord,
  DashboardSnapshot,
  SubscriptionRecord
} from "./types";
import { buildFlowVisualModel } from "./flow-graph";
import { flowDiagramEdges } from "./flow-diagram";

export type RenderableAgentLinkType = Exclude<AgentLinkType, "waits_for">;

export interface GraphRelation {
  id: string;
  source: string;
  target: string;
  type: RenderableAgentLinkType;
  label: string;
  emphasized?: boolean;
  details?: string;
}

export const RENDERABLE_RELATION_TYPES: RenderableAgentLinkType[] = [
  "parent_child",
  "subscribed_to",
  "handoff",
  "blocks"
];

export const RELATION_META: Record<
  RenderableAgentLinkType,
  { label: string; color: string; dash?: string; directed?: boolean; marker: string }
> = {
  parent_child: { label: "Hierarchy", color: "#64748b", directed: true, marker: "#64748b" },
  subscribed_to: { label: "Subscribed", color: "#3b82f6", directed: true, marker: "#3b82f6" },
  blocks: { label: "Blocks", color: "#fb6b5f", directed: true, marker: "#fb6b5f" },
  handoff: { label: "Handoff", color: "#14b8a6", directed: true, marker: "#14b8a6" }
};

export function isRenderableRelationType(type: AgentLinkType): type is RenderableAgentLinkType {
  return (RENDERABLE_RELATION_TYPES as AgentLinkType[]).includes(type);
}

export function computedByAgent(snapshot: DashboardSnapshot): Map<string, AgentComputedState> {
  return new Map(snapshot.computed_agents.map((item) => [item.agent_id, item]));
}

export function buildRelations(snapshot: DashboardSnapshot): GraphRelation[] {
  const relations: GraphRelation[] = snapshot.agent_links
    .filter((link): link is AgentLinkRecord & { type: RenderableAgentLinkType } =>
      isRenderableRelationType(link.type)
    )
    .map((link) => ({
      id: link.link_id,
      source: link.source_agent_id,
      target: link.target_agent_id,
      type: link.type,
      label: link.label ?? RELATION_META[link.type].label
    }));

  const relationKeys = new Set(relations.map((link) => relationKey(link)));
  const subscriptionRelations = snapshot.subscriptions
    .filter((subscription): subscription is SubscriptionRecord & { source_agent_id: string } =>
      Boolean(subscription.source_agent_id) && subscription.enabled
    )
    .map((subscription) => ({
      id: `subscription-${subscription.subscription_id}`,
      source: subscription.subscriber_agent_id,
      target: subscription.source_agent_id,
      type: "subscribed_to" as const,
      label: subscription.event_type.replace("agent.", "")
    }))
    .filter((relation) => !relationKeys.has(relationKey(relation)));

  for (const relation of subscriptionRelations) {
    pushUniqueRelation(relations, relationKeys, relation);
  }

  for (const observer of snapshot.run_observers ?? []) {
    if (!observer.event_types.length) continue;
    for (const agent of snapshot.agents) {
      if (agent.run_id !== observer.run_id || agent.agent_id === observer.observer_agent_id || agent.role === "observer") continue;
      pushUniqueRelation(relations, relationKeys, {
        id: `observe:${observer.observer_agent_id}:${agent.agent_id}`,
        source: observer.observer_agent_id, target: agent.agent_id, type: "subscribed_to",
        label: `Run events: ${observer.event_types.join(", ")}`
      });
    }
  }

  const ids = new Set(snapshot.agents.map((agent) => agent.agent_id));
  return relations.filter((relation) => ids.has(relation.source) && ids.has(relation.target) && relation.source !== relation.target);
}

export function focusedAgentId(snapshot: DashboardSnapshot, selected: string | null): string | null {
  if (snapshot.agents.some((agent) => agent.agent_id === selected)) return selected;
  const phase = snapshot.flow_steps.find((step) => snapshot.flow_instances.some((instance) =>
    instance.flow_instance_id === step.flow_instance_id && instance.current_step_id === step.step_id &&
    ["active", "blocked"].includes(instance.status) && ["active", "blocked"].includes(step.status)) &&
    snapshot.agents.some((agent) => agent.agent_id === step.agent_id && ["running", "starting", "blocked", "waiting_for_input"].includes(agent.status)));
  const active = snapshot.agents.find((agent) => agent.agent_id === phase?.agent_id) ??
    snapshot.agents.find((agent) => agent.status === "running" && !["observer", "orchestrator"].includes(agent.role ?? "")) ??
    snapshot.agents.find((agent) => agent.status === "running" && agent.role !== "observer") ??
    snapshot.agents.find((agent) => ["starting", "waiting_for_input", "blocked"].includes(agent.status) && agent.role !== "observer");
  return active?.agent_id ?? null;
}

export function primaryAgentRelations(snapshot: DashboardSnapshot, relations: GraphRelation[]): GraphRelation[] {
  const model = buildFlowVisualModel(snapshot);
  if (!model) {
    // Free workers have no declared phase order: retain real structural links.
    return relations.filter((relation) => relation.type === "parent_child" || relation.type === "handoff");
  }
  const agentForNode = new Map(model.nodes.map((node) => {
    const explicit = node.stepId ? model.flow.config.steps[node.stepId]?.agent_id : null;
    const candidates = snapshot.agents.filter((agent) => agent.role === node.role && !agent.unregistered_at);
    return [node.id, node.latestStep?.agent_id ?? explicit ?? (candidates.length === 1 ? candidates[0]!.agent_id : null)];
  }));
  const pairs = new Set(flowDiagramEdges(model.nodes, model.edges).filter((edge) => !edge.alternative)
    .map((edge) => `${agentForNode.get(edge.source)}:${agentForNode.get(edge.target)}`));
  const participants = new Set([...agentForNode.values()].filter(Boolean));
  return relations.filter((relation) => relation.type === "handoff" && pairs.has(`${relation.source}:${relation.target}`) ||
    relation.type === "parent_child" && !participants.has(relation.target));
}

export function visibleAgentRelations(relations: GraphRelation[], primary: GraphRelation[], focus: string | null, all: boolean): GraphRelation[] {
  const primaryIds = new Set(primary.map((relation) => relation.id));
  const groups = new Map<string, GraphRelation[]>();
  for (const relation of relations) {
    if (!all && relation.source !== focus && relation.target !== focus && !primaryIds.has(relation.id)) continue;
    const key = relationKey(relation);
    groups.set(key, [...(groups.get(key) ?? []), relation]);
  }
  // Conditions sharing endpoints use one arrow; every condition remains in its tooltip.
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const emphasized = first.source === focus || first.target === focus;
    const labels = [...new Set(group.map((relation) => relation.label))];
    return { ...first, emphasized, label: all || emphasized ? `${RELATION_META[first.type].label}${labels.length > 1 ? ` · ${labels.length} routes` : ""}` : "",
      details: labels.join("\n") };
  });
}

export function initialLayout(agents: AgentRecord[], relations: GraphRelation[], snapshot?: DashboardSnapshot) {
  const model = snapshot ? buildFlowVisualModel(snapshot) : null;
  if (model) {
    // A role can return in several phases, producing cycles. Use first phase
    // appearance for placement while keeping the real directed relationships.
    const roles = [...new Set(model.nodes.filter((node) => node.kind === "step").map((node) => node.role))];
    const ordered = [...agents].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role));
    return new Map(ordered.map((agent, index) => {
      const row = Math.floor(index / 3), column = row % 2 ? 2 - index % 3 : index % 3;
      return [agent.agent_id, { x: 80 + column * 440, y: 70 + row * 240 }];
    }));
  }
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const agent of agents) {
    incoming.set(agent.agent_id, 0);
    outgoing.set(agent.agent_id, []);
  }
  for (const relation of relations) {
    if (!incoming.has(relation.target) || !outgoing.has(relation.source)) {
      continue;
    }
    incoming.set(relation.target, (incoming.get(relation.target) ?? 0) + 1);
    outgoing.get(relation.source)?.push(relation.target);
  }

  const roots = agents.filter((agent) => (incoming.get(agent.agent_id) ?? 0) === 0);
  const queue = roots.length > 0 ? [...roots] : [...agents.slice(0, 1)];
  const depth = new Map<string, number>();
  for (const root of queue) {
    depth.set(root.agent_id, 0);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextDepth = (depth.get(current.agent_id) ?? 0) + 1;
    for (const next of outgoing.get(current.agent_id) ?? []) {
      if (!depth.has(next) || nextDepth < (depth.get(next) ?? 0)) {
        depth.set(next, nextDepth);
        const nextAgent = agents.find((agent) => agent.agent_id === next);
        if (nextAgent) {
          queue.push(nextAgent);
        }
      }
    }
  }

  const lanes = new Map<number, AgentRecord[]>();
  for (const agent of agents) {
    const lane = depth.get(agent.agent_id) ?? 0;
    lanes.set(lane, [...(lanes.get(lane) ?? []), agent]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const orderedLanes = [...lanes.entries()].sort(([a], [b]) => a - b);
  for (const [lane, laneAgents] of orderedLanes) {
    laneAgents
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .forEach((agent, index) => {
        positions.set(agent.agent_id, {
          x: 80 + lane * 340,
          y: 70 + index * 178 + (lane % 2) * 44
        });
      });
  }
  return positions;
}

function relationKey(relation: Pick<GraphRelation, "source" | "target" | "type">) {
  return `${relation.source}:${relation.target}:${relation.type}`;
}

function pushUniqueRelation(
  relations: GraphRelation[],
  relationKeys: Set<string>,
  relation: GraphRelation
) {
  const key = relationKey(relation);
  if (relationKeys.has(key)) {
    return;
  }
  relations.push(relation);
  relationKeys.add(key);
}
