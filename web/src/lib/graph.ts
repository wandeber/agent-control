import type {
  AgentComputedState,
  AgentLinkRecord,
  AgentLinkType,
  AgentRecord,
  DashboardSnapshot,
  SubscriptionRecord
} from "./types";

export type RenderableAgentLinkType = Exclude<AgentLinkType, "waits_for">;

export interface GraphRelation {
  id: string;
  source: string;
  target: string;
  type: RenderableAgentLinkType;
  label: string;
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
  subscribed_to: { label: "Subscribed", color: "#3b82f6", dash: "3 4", directed: true, marker: "#3b82f6" },
  blocks: { label: "Blocks", color: "#fb6b5f", dash: "8 3", directed: true, marker: "#fb6b5f" },
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
      Boolean(subscription.source_agent_id)
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

  return relations;
}

export function initialLayout(agents: AgentRecord[], relations: GraphRelation[]) {
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
