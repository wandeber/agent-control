import { buildRelations, primaryAgentRelations } from "./graph";
import { buildAgentTeam, cardBounds, keepExternalCardsOutsideTeam, projectTeamRelations, teamBounds, teamLayout, type AgentTeam, type GraphCard } from "./team-graph";
import type { DashboardSnapshot } from "./types";

export function buildRunGraph(snapshot: DashboardSnapshot) {
  const relations = buildRelations(snapshot);
  const primary = primaryAgentRelations(snapshot, relations);
  const team = buildAgentTeam(snapshot.agents);
  return { snapshot, team, primary, projected: projectTeamRelations(team, relations, primary) };
}

export function runGraphBounds(cards: GraphCard[], team: AgentTeam | null) {
  const rects = cards.map(cardBounds);
  const bounds = teamBounds(cards, team);
  if (bounds) rects.push(bounds.frame, cardBounds(bounds.header));
  if (!rects.length) return { x: 0, y: 0, width: 420, height: 220 };
  const x = Math.min(...rects.map(rect => rect.x)) - 40;
  const y = Math.min(...rects.map(rect => rect.y)) - 72;
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x + 40,
    height: Math.max(...rects.map(rect => rect.y + rect.height)) - y + 40 };
}

/** Layout each team independently before placing the runs on a shared canvas. */
export function multiRunLayout(groups: ReturnType<typeof buildRunGraph>[]) {
  const positions = new Map<string, { x: number; y: number }>();
  let offsetX = 0;
  for (const { snapshot, primary, team } of groups) {
    const layout = teamLayout(snapshot, primary, team);
    // The run origin comes from automatic layout, never from edited bounds.
    // Otherwise moving the leftmost (or only) card cancels its own displacement.
    const automatic = runGraphBounds(snapshot.agents.map(agent => ({ id: agent.agent_id, position: layout.get(agent.agent_id) ?? { x: 0, y: 0 } })), team);
    for (const point of snapshot.canvas_positions?.positions ?? []) layout.set(point.agent_id, { x: point.x, y: point.y });
    const cards = snapshot.agents.map(agent => ({ id: agent.agent_id, position: layout.get(agent.agent_id) ?? { x: 0, y: 0 } }));
    const bounds = runGraphBounds(cards, team);
    for (const card of cards) positions.set(card.id, groups.length > 1
      ? { x: card.position.x - automatic.x + offsetX, y: card.position.y - automatic.y }
      : card.position);
    offsetX += Math.max(automatic.width, bounds.x + bounds.width - automatic.x) + 120;
  }
  return positions;
}

export function multiRunBounds(groups: ReturnType<typeof buildRunGraph>[], cards: GraphCard[]) {
  let nextX = 0;
  return groups.map(group => {
    const ids = new Set(group.snapshot.agents.map(agent => agent.agent_id));
    const members = cards.filter(card => ids.has(card.id));
    const bounds = runGraphBounds(members, group.team);
    if (!members.length) bounds.x = nextX;
    nextX = bounds.x + bounds.width + 120;
    return bounds;
  });
}

/** Reserve space when a run grows, moving whole later diagrams together. */
export function keepRunsSeparate<T extends GraphCard>(groups: ReturnType<typeof buildRunGraph>[], cards: T[]): T[] {
  if (groups.length < 2) return cards;
  let nextX: number | null = null;
  const result: T[] = [];
  for (const group of groups) {
    const ids = new Set(group.snapshot.agents.map(agent => agent.agent_id));
    const members = cards.filter(card => ids.has(card.id));
    const bounds = runGraphBounds(members, group.team);
    const shift: number = nextX === null ? 0 : Math.max(0, nextX - bounds.x);
    const left: number = members.length ? bounds.x + shift : nextX ?? 0;
    result.push(...members.map(card => shift ? { ...card, position: { ...card.position, x: card.position.x + shift } } : card));
    nextX = left + bounds.width + 120;
  }
  return result;
}
