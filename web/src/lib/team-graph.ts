import { initialLayout, TEAM_NODE_ID, type GraphRelation } from "./graph";
import type { AgentRecord, DashboardSnapshot } from "./types";
import type { AgentRect } from "./agent-routing";

export interface AgentTeam { id: string; members: string[] }
export interface TeamRelation extends GraphRelation {
  primary?: boolean;
  members?: string[];
  originalRelations?: GraphRelation[];
}
export interface AgentConnection {
  id: string;
  source: string;
  target: string;
  arrowAtSource: boolean;
  arrowAtTarget: boolean;
  relations: TeamRelation[];
}
export interface GraphCard {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
}

export function buildAgentTeam(agents: AgentRecord[]): AgentTeam | null {
  const members = agents.filter((agent) => !["orchestrator", "observer"].includes(agent.role ?? ""))
    .map((agent) => agent.agent_id);
  return members.length ? { id: TEAM_NODE_ID, members } : null;
}

/** Collapse only proven common relationships, before applying view filters. */
export function projectTeamRelations(team: AgentTeam | null, relations: GraphRelation[], primary: GraphRelation[]): TeamRelation[] {
  const primaryIds = new Set(primary.map((relation) => relation.id));
  const projected: TeamRelation[] = [];
  const candidates = new Map<string, { outside: string; outgoing: boolean; relations: GraphRelation[] }>();
  const members = new Set(team?.members);
  for (const relation of relations) {
    if (relation.target === TEAM_NODE_ID) {
      if (team) projected.push({ ...relation, primary: true, members: team.members });
      continue;
    }
    const sourceInside = members.has(relation.source), targetInside = members.has(relation.target);
    if (!team || team.members.length < 2 || sourceInside === targetInside) {
      projected.push({ ...relation, primary: primaryIds.has(relation.id) });
      continue;
    }
    const outside = sourceInside ? relation.target : relation.source;
    // A common type can have different conditions for each member. Preserve
    // those exact directed relations in the detail; do not infer shared filters.
    const key = JSON.stringify([outside, targetInside, relation.type]);
    const group = candidates.get(key) ?? { outside, outgoing: targetInside, relations: [] };
    group.relations.push(relation); candidates.set(key, group);
  }
  for (const [key, group] of candidates) {
    const covered = new Set(group.relations.map((relation) => group.outgoing ? relation.target : relation.source));
    if (team!.members.every((id) => covered.has(id))) {
      projected.push({
        ...group.relations[0]!, id: `team:${key}`,
        source: group.outgoing ? group.outside : team!.id,
        target: group.outgoing ? team!.id : group.outside,
        primary: true, members: team!.members, originalRelations: group.relations
      });
    } else {
      projected.push(...group.relations.map((relation) => ({ ...relation, primary: primaryIds.has(relation.id) })));
    }
  }
  return projected;
}

export function bundleAgentConnections(relations: TeamRelation[], focus: string | null, all: boolean): AgentConnection[] {
  const pairs = new Map<string, TeamRelation[]>();
  for (const relation of relations) {
    if (relation.source === relation.target) continue;
    const id = JSON.stringify([relation.source, relation.target].sort());
    const group = pairs.get(id) ?? [];
    group.push(relation); pairs.set(id, group);
  }
  return [...pairs].filter(([, group]) => all || group.some((relation) => relation.primary ||
    relation.source === focus || relation.target === focus)).map(([id, group]) => {
    const [source, target] = JSON.parse(id) as [string, string];
    // Visibility chooses pairs; all enabled relation types for that pair remain
    // in the detail and contribute their own direction to its arrowheads.
    return { id, source, target, arrowAtSource: group.some((relation) => relation.target === source),
      arrowAtTarget: group.some((relation) => relation.target === target), relations: group };
  });
}

export function teamLayout(snapshot: DashboardSnapshot, primary: GraphRelation[], team: AgentTeam | null) {
  if (!team) return initialLayout(snapshot.agents, primary, snapshot);
  const members = new Set(team.members);
  const inside = snapshot.agents.filter((agent) => members.has(agent.agent_id));
  const outside = snapshot.agents.filter((agent) => !members.has(agent.agent_id));
  const positions = initialLayout(inside, primary.filter((relation) => members.has(relation.source) && members.has(relation.target)), snapshot);
  const minX = Math.min(...[...positions.values()].map((point) => point.x));
  const minY = Math.min(...[...positions.values()].map((point) => point.y));
  const top = Math.ceil(outside.length / 3) * 210 + 170;
  for (const [id, point] of positions) positions.set(id, { x: point.x - minX + 100, y: point.y - minY + top });
  outside.forEach((agent, index) => positions.set(agent.agent_id, { x: 100 + index % 3 * 440, y: 30 + Math.floor(index / 3) * 210 }));
  return positions;
}

export function cardBounds(card: GraphCard): AgentRect {
  return { ...card.position, width: card.measured?.width ?? 300, height: card.measured?.height ?? 132 };
}

export function teamBounds(cards: GraphCard[], team: AgentTeam | null): { frame: AgentRect; header: GraphCard } | null {
  const members = cards.filter((card) => team?.members.includes(card.id)).map(cardBounds);
  if (!members.length) return null;
  const x = Math.min(...members.map((card) => card.x)) - 40;
  const y = Math.min(...members.map((card) => card.y)) - 96;
  const width = Math.max(...members.map((card) => card.x + card.width)) - x + 40;
  const height = Math.max(...members.map((card) => card.y + card.height)) - y + 40;
  return { frame: { x, y, width, height }, header: { id: TEAM_NODE_ID,
    position: { x: x + width / 2 - 110, y: y - 20 }, measured: { width: 220, height: 40 } } };
}

/** Expanding or dragging the team must not imply that an external role joined it. */
export function keepExternalCardsOutsideTeam<T extends GraphCard>(cards: T[], team: AgentTeam | null): T[] {
  const bounds = teamBounds(cards, team);
  if (!bounds || !team) return cards;
  const outside = cards.filter((card) => !team.members.includes(card.id));
  const result = [...cards];
  const intersects = (a: AgentRect, b: AgentRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const reserved = { ...bounds.frame, y: bounds.frame.y - 20, height: bounds.frame.height + 20 };
  for (const card of outside) {
    const rect = cardBounds(card);
    if (!intersects(rect, reserved)) continue;
    const y = reserved.y - rect.height - 40;
    let x = rect.x;
    // Find a free slot above the frame instead of stacking outside cards.
    for (;;) {
      const collision = result.find((other) => other.id !== card.id && !team.members.includes(other.id) &&
        intersects({ ...rect, x, y }, cardBounds(other)));
      if (!collision) break;
      const occupied = cardBounds(collision);
      x = occupied.x + occupied.width + 40;
    }
    result[result.findIndex((other) => other.id === card.id)] = { ...card, position: { x, y } };
  }
  return result;
}
