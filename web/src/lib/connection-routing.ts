import { TEAM_NODE_ID } from "./graph";
import { agentRoutePath, routeAgentConnection } from "./agent-routing";
import { cardBounds, teamBounds, type AgentConnection, type AgentTeam, type GraphCard } from "./team-graph";

const DEFAULT_NODE_WIDTH = 300;
const DEFAULT_NODE_HEIGHT = 132;
const EDGE_ARROW_LENGTH = 12;
const EDGE_ARROW_HALF_WIDTH = 4;
const RELATION_ANCHOR_SIDES: FloatingSide[] = ["left", "right", "top", "bottom"];
type FloatingSide = "bottom" | "left" | "right" | "top";
type RelationRoute = { sourceSide: FloatingSide; targetSide: FloatingSide };
type RoutedRelation = AgentConnection & { route: RelationRoute };

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
    return [{ ...connection, route: { sourceSide, targetSide } }];
  });
  return routed.flatMap((connection) => {
    const source = nodes.find((node) => node.id === connection.source)!, target = nodes.find((node) => node.id === connection.target)!;
    const start = sideAnchor(source, connection.route.sourceSide), end = sideAnchor(target, connection.route.targetSide);
    const points = routeAgentConnection(start, end, directionForSide(connection.route.sourceSide), directionForSide(connection.route.targetSide), nodes.map(cardBounds));
    if (points.length < 2) return [];
    return [{ ...connection, startPortKey: portKey(connection.source, connection.route.sourceSide), endPortKey: portKey(connection.target, connection.route.targetSide), points, path: agentRoutePath(points), startArrow: makeArrowPath(points[0]!, points[1]!), endArrow: makeArrowPath(points.at(-1)!, points.at(-2)!) }];
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

function tangentAxis(side: FloatingSide): "horizontal" | "vertical" {
  return side === "top" || side === "bottom" ? "horizontal" : "vertical";
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


export interface ConnectionJunction {
  id: string;
  nodeId: string;
  side: FloatingSide;
  path: string;
  arrow: string | null;
  connectionIds: string[];
  relations: AgentConnection["relations"];
}

function portKey(nodeId: string, side: FloatingSide): string {
  return `junction:${JSON.stringify([nodeId, side])}`;
}

/** Merge incoming and outgoing branches at one point on each card side. */
export function connectionJunctions(routes: ReturnType<typeof routeConnections>): ConnectionJunction[] {
  const ports = new Map<string, ConnectionJunction & { length: number }>();
  for (const route of routes) {
    for (const endpoint of ["source", "target"] as const) {
      const source = endpoint === "source";
      const id = source ? route.startPortKey : route.endPortKey;
      const side = source ? route.route.sourceSide : route.route.targetSide;
      const tip = source ? route.points[0]! : route.points.at(-1)!;
      const next = source ? route.points[1]! : route.points.at(-2)!;
      const length = Math.min(24, Math.hypot(next.x - tip.x, next.y - tip.y));
      const incoming = source ? route.arrowAtSource : route.arrowAtTarget;
      const port = ports.get(id) ?? { id, nodeId: route[endpoint], side, path: "", arrow: null,
        connectionIds: [], relations: [], length };
      port.length = Math.min(port.length, length);
      const direction = directionForSide(side);
      port.path = agentRoutePath([tip, { x: tip.x + direction.x * port.length, y: tip.y + direction.y * port.length }]);
      if (incoming) port.arrow = source ? route.startArrow : route.endArrow;
      port.connectionIds.push(route.id);
      for (const relation of route.relations) if (!port.relations.some((existing) => existing.id === relation.id)) port.relations.push(relation);
      ports.set(id, port);
    }
  }
  // Single connections already expose their own interaction and arrowheads.
  return [...ports.values()].filter((port) => port.connectionIds.length > 1);
}
