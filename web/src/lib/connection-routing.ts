import { TEAM_NODE_ID } from "./graph";
import { agentRoutePath, fitAgentPortShifts, routeAgentConnection } from "./agent-routing";
import { cardBounds, teamBounds, type AgentConnection, type AgentTeam, type GraphCard } from "./team-graph";

const DEFAULT_NODE_WIDTH = 300;
const DEFAULT_NODE_HEIGHT = 132;
const EDGE_ARROW_LENGTH = 12;
const EDGE_ARROW_HALF_WIDTH = 4;
const RELATION_ANCHOR_SIDES: FloatingSide[] = ["left", "right", "top", "bottom"];
type FloatingSide = "bottom" | "left" | "right" | "top";
type RelationRoute = { sourceSide: FloatingSide; targetSide: FloatingSide; sourceTangentShift: number; targetTangentShift: number };
type RoutedRelation = AgentConnection & { route: RelationRoute };
type RoutedEndpoint = { agentId: string; endpoint: "source" | "target"; otherAgentId: string; relation: RoutedRelation; side: FloatingSide };

export function routeConnections(connections: AgentConnection[], cards: GraphCard[], team: AgentTeam | null) {
  const bounds = teamBounds(cards, team);
  const nodes = bounds ? [...cards, bounds.header] : cards;
  const routed: RoutedRelation[] = connections.flatMap((connection) => {
    const source = nodes.find((node) => node.id === connection.source), target = nodes.find((node) => node.id === connection.target);
    if (!source || !target) return [];
    let { sourceSide, targetSide } = chooseInputOutputSides(source, target);
    // A member observes the team through the inside of its shared header.
    if (source.id === TEAM_NODE_ID && team?.members.includes(target.id)) { sourceSide = "bottom"; targetSide = "top"; }
    if (target.id === TEAM_NODE_ID && team?.members.includes(source.id)) { sourceSide = "top"; targetSide = "bottom"; }
    return [{ ...connection, route: { sourceSide, targetSide, sourceTangentShift: 0, targetTangentShift: 0 } }];
  });
  applyAnchorFanoutShifts(routed, nodes);
  return routed.flatMap((connection) => {
    const source = nodes.find((node) => node.id === connection.source)!, target = nodes.find((node) => node.id === connection.target)!;
    const start = sideAnchor(source, connection.route.sourceSide), end = sideAnchor(target, connection.route.targetSide);
    if (tangentAxis(connection.route.sourceSide) === "horizontal") start.x += connection.route.sourceTangentShift;
    else start.y += connection.route.sourceTangentShift;
    if (tangentAxis(connection.route.targetSide) === "horizontal") end.x += connection.route.targetTangentShift;
    else end.y += connection.route.targetTangentShift;
    const points = routeAgentConnection(start, end, directionForSide(connection.route.sourceSide), directionForSide(connection.route.targetSide), nodes.map(cardBounds));
    if (points.length < 2) return [];
    return [{ ...connection, points, path: agentRoutePath(points), startArrow: makeArrowPath(points[0]!, points[1]!), endArrow: makeArrowPath(points.at(-1)!, points.at(-2)!) }];
  });
}
function chooseInputOutputSides(
  source: GraphCard,
  target: GraphCard
): { sourceSide: FloatingSide; targetSide: FloatingSide } {
  const sourceCenter = nodeCenter(source);
  const targetCenter = nodeCenter(target);
  const flowVector = normalizeVector({
    x: targetCenter.x - sourceCenter.x,
    y: targetCenter.y - sourceCenter.y
  });
  const targetToSourceVector = { x: -flowVector.x, y: -flowVector.y };
  let best: { sourceSide: FloatingSide; targetSide: FloatingSide; score: number } | null = null;

  for (const sourceSide of RELATION_ANCHOR_SIDES) {
    for (const targetSide of RELATION_ANCHOR_SIDES) {
      const sourceAnchor = sideAnchor(source, sourceSide);
      const targetAnchor = sideAnchor(target, targetSide);
      const dx = targetAnchor.x - sourceAnchor.x;
      const dy = targetAnchor.y - sourceAnchor.y;
      const length = Math.hypot(dx, dy);
      const sourceDirection = directionForSide(sourceSide);
      const targetDirection = directionForSide(targetSide);
      const sourceAlignment = dot(flowVector, sourceDirection);
      const targetAlignment = dot(targetToSourceVector, targetDirection);
      const axisPenalty = tangentAxis(sourceSide) === tangentAxis(targetSide) ? 0 : 22;
      const score =
        length +
        directionalPenalty(sourceAlignment) +
        directionalPenalty(targetAlignment) +
        axisPenalty;

      if (!best || score < best.score) {
        best = { sourceSide, targetSide, score };
      }
    }
  }

  return best ?? { sourceSide: "right", targetSide: "left" };
}

function applyAnchorFanoutShifts(relations: RoutedRelation[], nodes: GraphCard[]) {
  const groups = new Map<string, RoutedEndpoint[]>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const relation of relations) {
    for (const endpoint of ["source", "target"] as const) {
      const agentId = relation[endpoint];
      const side = endpoint === "source" ? relation.route.sourceSide : relation.route.targetSide;
      const otherAgentId = relation[endpoint === "source" ? "target" : "source"];
      const key = `${agentId}:${side}`;
      const group = groups.get(key) ?? [];
      group.push({ agentId, endpoint, otherAgentId, relation, side }); groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    group.sort((a, b) => compareFanoutEndpoints(a, b, nodeById));
    const node = nodeById.get(group[0]!.agentId);
    if (!node) continue;
    const horizontal = group[0]!.side === "top" || group[0]!.side === "bottom";
    const shifts = fitAgentPortShifts(group.map((_, index) => (index - (group.length - 1) / 2) * 18), horizontal ? nodeWidth(node) : nodeHeight(node));
    group.forEach((endpoint, index) => {
      if (endpoint.endpoint === "source") endpoint.relation.route.sourceTangentShift = shifts[index]!;
      else endpoint.relation.route.targetTangentShift = shifts[index]!;
    });
  }
}

function tangentAxis(side: FloatingSide): "horizontal" | "vertical" {
  return side === "top" || side === "bottom" ? "horizontal" : "vertical";
}

function compareFanoutEndpoints(a: RoutedEndpoint, b: RoutedEndpoint, nodeById: Map<string, GraphCard>): number {
  const aRank = fanoutSortRank(a, nodeById);
  const bRank = fanoutSortRank(b, nodeById);
  if (aRank !== bRank) {
    return aRank - bRank;
  }
  return `${relationSortKey(a.relation)}:${a.endpoint}`.localeCompare(`${relationSortKey(b.relation)}:${b.endpoint}`);
}

function fanoutSortRank(endpoint: RoutedEndpoint, nodeById: Map<string, GraphCard>): number {
  const otherNode = nodeById.get(endpoint.otherAgentId);
  if (!otherNode) {
    return 0;
  }
  const center = nodeCenter(otherNode);
  return endpoint.side === "left" || endpoint.side === "right" ? center.y : center.x;
}

function nodeCenter(node: GraphCard): { x: number; y: number } {
  return {
    x: node.position.x + nodeWidth(node) / 2,
    y: node.position.y + nodeHeight(node) / 2
  };
}

function sideAnchor(node: GraphCard, side: FloatingSide): { x: number; y: number } {
  const width = nodeWidth(node);
  const height = nodeHeight(node);
  if (side === "left") {
    return { x: node.position.x, y: node.position.y + height / 2 };
  }
  if (side === "right") {
    return { x: node.position.x + width, y: node.position.y + height / 2 };
  }
  if (side === "top") {
    return { x: node.position.x + width / 2, y: node.position.y };
  }
  return { x: node.position.x + width / 2, y: node.position.y + height };
}

function nodeWidth(node: GraphCard): number {
  return node.measured?.width ?? DEFAULT_NODE_WIDTH;
}

function nodeHeight(node: GraphCard): number {
  return node.measured?.height ?? DEFAULT_NODE_HEIGHT;
}

function relationSortKey(relation: AgentConnection): string {
  return relation.id;
}

function directionForSide(side: FloatingSide): { x: number; y: number } {
  if (side === "left") return { x: -1, y: 0 };
  if (side === "right") return { x: 1, y: 0 };
  if (side === "top") return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function normalizeVector(vector: { x: number; y: number }): { x: number; y: number } {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

function dot(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return a.x * b.x + a.y * b.y;
}

function directionalPenalty(alignment: number): number {
  return (1 - alignment) * 160;
}

function makeArrowPath(tip: { x: number; y: number }, previousControl: { x: number; y: number }): string {
  const dx = tip.x - previousControl.x;
  const dy = tip.y - previousControl.y;
  const length = Math.hypot(dx, dy) || 1;
  const tangentX = dx / length;
  const tangentY = dy / length;
  const normalX = -tangentY;
  const normalY = tangentX;
  const baseX = tip.x - tangentX * EDGE_ARROW_LENGTH;
  const baseY = tip.y - tangentY * EDGE_ARROW_LENGTH;
  const wing1X = baseX + normalX * EDGE_ARROW_HALF_WIDTH;
  const wing1Y = baseY + normalY * EDGE_ARROW_HALF_WIDTH;
  const wing2X = baseX - normalX * EDGE_ARROW_HALF_WIDTH;
  const wing2Y = baseY - normalY * EDGE_ARROW_HALF_WIDTH;
  return `M ${tip.x},${tip.y} L ${wing1X},${wing1Y} L ${wing2X},${wing2Y} Z`;
}
