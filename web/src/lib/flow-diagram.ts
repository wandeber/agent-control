import type { FlowVisualEdge, FlowVisualNode } from "./flow-graph";

export const PHASE_WIDTH = 264;
export const PHASE_HEIGHT = 80;
export const PHASE_GAP = 76;
export const QUESTION_HEIGHT = 156;
export function flowNodeSize(kind: FlowVisualNode["kind"]): { width: number; height: number } {
  return { width: PHASE_WIDTH, height: kind === "decision" ? QUESTION_HEIGHT : PHASE_HEIGHT };
}
export type Point = { x: number; y: number };
export interface DiagramNode {
  id: string;
  position: Point;
  width: number;
  height: number;
  kind?: FlowVisualNode["kind"];
}
export interface DiagramEdge extends FlowVisualEdge {
  conditions: string;
  alternative: boolean;
}
export interface DiagramRoute {
  edge: DiagramEdge;
  points: Point[];
  labelPoint: Point;
}

export function flowDiagramEdges(nodes: FlowVisualNode[], edges: FlowVisualEdge[]): DiagramEdge[] {
  const kinds = new Map(nodes.map((node) => [node.id, node.kind]));
  const ranks = new Map(nodes.filter((node) => node.kind === "step" || (node.kind === "decision" && !node.questionOriginNodeId)).map((node, index) => [node.id, index]));
  const groups = new Map<string, FlowVisualEdge[]>();
  for (const edge of edges) {
    const key = `${edge.source}->${edge.target}`;
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }
  return [...groups.entries()].map(([id, group]) => {
    const edge = group[0]!;
    const sourceRank = ranks.get(edge.source);
    const targetRank = ranks.get(edge.target);
    const backward = sourceRank !== undefined && targetRank !== undefined && targetRank <= sourceRank;
    const hasPhaseExit = edges.some((item) => item.source === edge.source && kinds.get(item.target) !== "notify");
    const labels = [...new Set(group.map((item) => item.label.replaceAll("_", " ")))];
    return {
      ...edge,
      id,
      conditions: labels.join(" / "),
      // The destination is already visible at the arrowhead. Keep long routing
      // conditions available in the tooltip without repeating the target name.
      label: labels.map((label) => label.replace(/ \+ target .+$/, "")).filter((label, index, all) => all.indexOf(label) === index).join(" / "),
      tone: group.some((item) => item.tone === "taken") ? "taken" : edge.tone,
      alternative: kinds.get(edge.source) !== "decision" && (backward || (kinds.get(edge.target) === "notify" && hasPhaseExit))
    };
  });
}

export function flowDiagramPositions(nodes: FlowVisualNode[], columns = 1): Map<string, Point> {
  const steps = nodes.filter((node) => node.kind === "step" || (node.kind === "decision" && !node.questionOriginNodeId));
  let nextY = 0;
  const positions = new Map(steps.map((node, index) => {
    const row = Math.floor(index / columns);
    const column = row % 2 === 0 ? index % columns : columns - 1 - index % columns;
    const y = columns === 1 ? nextY : row * (QUESTION_HEIGHT + PHASE_GAP);
    nextY += flowNodeSize(node.kind).height + PHASE_GAP;
    return [node.id, { x: column * (PHASE_WIDTH + 116), y }] as const;
  }));
  nodes.filter((node) => node.kind === "notify").forEach((node, index) => {
    positions.set(node.id, columns === 1
      ? { x: PHASE_WIDTH + 216, y: index * (PHASE_HEIGHT + PHASE_GAP) }
      : { x: index * (PHASE_WIDTH + 116), y: 150 });
  });
  const last = positions.get(steps.at(-1)?.id ?? "") ?? { x: 0, y: 0 };
  nodes.filter((node) => node.kind === "finish").forEach((node, index) => {
    positions.set(node.id, { x: last.x, y: last.y + flowNodeSize(steps.at(-1)?.kind ?? "step").height + PHASE_GAP + index * (PHASE_HEIGHT + PHASE_GAP) });
  });
  nodes.filter(node => node.questionOriginNodeId).forEach((node, index) => {
    const origin = positions.get(node.questionOriginNodeId!) ?? { x: 0, y: 0 };
    positions.set(node.id, { x: columns * (PHASE_WIDTH + 116) + 200 + index * (PHASE_WIDTH + 80), y: origin.y });
  });
  return positions;
}

export function visibleFlowDiagramEdges(edges: DiagramEdge[], focusedNodeId: string | null, allRoutes: boolean): DiagramEdge[] {
  return edges.filter((edge) => allRoutes || !edge.alternative || edge.source === focusedNodeId || edge.tone === "taken");
}

export function routeFlowDiagram(edges: DiagramEdge[], nodes: DiagramNode[]): DiagramRoute[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const left = Math.min(0, ...nodes.map((node) => node.position.x));
  const groups = new Map<string, DiagramEdge[]>();
  for (const edge of edges) groups.set(edge.source, [...(groups.get(edge.source) ?? []), edge]);
  const incoming = new Map<string, DiagramEdge[]>();
  for (const edge of edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  const returnLanes: Array<Array<{ top: number; bottom: number }>> = [];
  let rightLane = 0;
  let overheadLane = 0;
  const wrapped = new Set(nodes.filter((node) => node.kind === "step" || node.kind === "decision").map((node) => node.position.x)).size > 1;
  const routes: DiagramRoute[] = edges.flatMap((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) return [];
    const arrivals = incoming.get(edge.target) ?? [];
    const arrivalShift = target.kind === "decision" ? 0 : Math.max(-target.height / 2 + 12, Math.min(target.height / 2 - 12, (arrivals.indexOf(edge) - (arrivals.length - 1) / 2) * 12));
    const sourceCenter = { x: source.position.x + source.width / 2, y: source.position.y + source.height / 2 };
    const targetCenter = { x: target.position.x + target.width / 2, y: target.position.y + target.height / 2 };
    let points: Point[];
    let labelPoint: Point;
    const vertical = Math.abs(sourceCenter.x - targetCenter.x) < Math.max(source.width, target.width) / 2;
    const inBetween = nodes.some((node) => node.id !== source.id && node.id !== target.id &&
      node.position.y > source.position.y && node.position.y < target.position.y &&
      Math.abs(node.position.x - source.position.x) < source.width);
    if (vertical && target.position.y >= source.position.y + source.height && !inBetween) {
      const start = { x: sourceCenter.x, y: source.position.y + source.height };
      const end = { x: targetCenter.x, y: target.position.y };
      const midY = (start.y + end.y) / 2;
      points = [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
      labelPoint = { x: (start.x + end.x) / 2 + 94, y: midY };
    } else if (vertical) {
      // Give each return its own lane. Shared lines make the origin ambiguous.
      const interval = { top: Math.min(sourceCenter.y, targetCenter.y) - 32, bottom: Math.max(sourceCenter.y, targetCenter.y) + 32 };
      let lane = returnLanes.findIndex((items) => items.every((item) => item.bottom < interval.top || item.top > interval.bottom));
      if (lane === -1) { lane = returnLanes.length; returnLanes.push([]); }
      returnLanes[lane]!.push(interval);
      const laneX = left - 112 - lane * 168;
      const siblings = groups.get(edge.source) ?? [];
      const shift = source.kind === "decision" ? 0 : (siblings.indexOf(edge) - (siblings.length - 1) / 2) * 10;
      const start = { x: source.position.x, y: sourceCenter.y + shift };
      const end = { x: target.position.x, y: targetCenter.y + (target.kind === "decision" ? 0 : source.id === target.id ? 24 : arrivalShift) };
      points = [start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end];
      labelPoint = { x: laneX, y: (start.y + end.y) / 2 };
    } else {
      const rightward = targetCenter.x > sourceCenter.x;
      const start = { x: source.position.x + (rightward ? source.width : 0), y: sourceCenter.y };
      const end = { x: target.position.x + (rightward ? 0 : target.width), y: targetCenter.y + arrivalShift };
      const midX = Math.max(Math.min(start.x, end.x) + 16, Math.min(Math.max(start.x, end.x) - 16, (start.x + end.x) / 2 + (rightLane++ % 6) * 12));
      points = [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
      labelPoint = Math.abs(start.y - end.y) < 40
        ? { x: (start.x + end.x) / 2, y: start.y - 28 }
        : { x: midX, y: (start.y + end.y) / 2 };
    }
    const crossesCard = points.slice(1).some((end, index) => nodes.some((node) => {
      if (node.id === source.id || node.id === target.id) return false;
      const start = points[index]!;
      return start.x === end.x
        ? start.x > node.position.x && start.x < node.position.x + node.width && Math.max(start.y, end.y) > node.position.y && Math.min(start.y, end.y) < node.position.y + node.height
        : start.y > node.position.y && start.y < node.position.y + node.height && Math.max(start.x, end.x) > node.position.x && Math.min(start.x, end.x) < node.position.x + node.width;
    }));
    if (wrapped && (crossesCard || edge.alternative)) {
      // In a wrapped overview, return through the gutters and above the cards.
      // A direct return across a row would run through intermediate phases.
      const laneY = Math.min(...nodes.map((node) => node.position.y)) - 64 - overheadLane++ * 64;
      const sourceX = source.position.x - 32;
      const targetX = target.position.x - (source.id === target.id ? 64 : 48);
      const start = { x: source.position.x, y: sourceCenter.y - (source.kind === "decision" ? 0 : source.id === target.id ? 16 : 0) };
      const end = { x: target.position.x, y: targetCenter.y + (target.kind === "decision" ? 0 : source.id === target.id ? 16 : arrivalShift) };
      points = [start, { x: sourceX, y: start.y }, { x: sourceX, y: laneY }, { x: targetX, y: laneY }, { x: targetX, y: end.y }, end];
      labelPoint = { x: (sourceX + targetX) / 2, y: laneY };
    }
    return [{ edge, points: points.filter((point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y), labelPoint }];
  });
  const exitSide = (route: DiagramRoute) => {
    const [start, next] = route.points;
    return !start || !next ? "none" : next.x < start.x ? "left" : next.x > start.x ? "right" : next.y < start.y ? "top" : "bottom";
  };
  for (const route of routes) {
    if (byId.get(route.edge.source)?.kind !== "decision") continue;
    const side = exitSide(route);
    const siblings = routes.filter(other => other.edge.source === route.edge.source && exitSide(other) === side);
    // Keep a single choice close to its diamond. Shared-side choices retain
    // their separate lane labels so several returns never cover each other.
    if (siblings.length === 1 && (side === "left" || side === "right")) {
      const start = route.points[0]!;
      route.labelPoint = { x: start.x + (side === "right" ? 78 : -78), y: start.y - 22 };
    }
  }
  return routes;
}

export function diagramPath(points: Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x},${point.y}`).join(" ");
}
