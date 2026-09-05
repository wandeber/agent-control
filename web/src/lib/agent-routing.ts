export interface AgentPoint { x: number; y: number }
export interface AgentRect extends AgentPoint { width: number; height: number }

// Route on card boundaries rather than between card centers. The grid includes
// every obstacle's perimeter, so manual card moves remain routable as well.
export function routeAgentConnection(start: AgentPoint, end: AgentPoint, startDirection: AgentPoint,
  endDirection: AgentPoint, cards: AgentRect[], lane = 0, clearance?: number): AgentPoint[] {
  const margin = clearance ?? 18 + Math.abs(lane) * 0.4;
  const distance = margin + (margin ? 10 : 2);
  const from = { x: start.x + startDirection.x * distance, y: start.y + startDirection.y * distance };
  const to = { x: end.x + endDirection.x * distance, y: end.y + endDirection.y * distance };
  const obstacles = cards.map((card) => ({ x: card.x - margin, y: card.y - margin, width: card.width + margin * 2, height: card.height + margin * 2 }));
  const xs = [...new Set([from.x, to.x, ...obstacles.flatMap((card) => [card.x, card.x + card.width])])].sort((a, b) => a - b);
  const ys = [...new Set([from.y, to.y, ...obstacles.flatMap((card) => [card.y, card.y + card.height])])].sort((a, b) => a - b);
  const width = xs.length;
  const point = (id: number) => ({ x: xs[id % width]!, y: ys[Math.floor(id / width)]! });
  const index = (p: AgentPoint) => ys.indexOf(p.y) * width + xs.indexOf(p.x);
  const source = index(from), target = index(to);
  const heuristic = (id: number) => { const p = point(id); return Math.abs(p.x - to.x) + Math.abs(p.y - to.y); };
  const initial = source * 3;
  const queue = new MinQueue();
  queue.push(initial, heuristic(source));
  const cost = new Map([[initial, 0]]);
  const previous = new Map<number, number>();
  const visited = new Set<number>();
  let finish: number | null = null;
  while (queue.length) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const id = Math.floor(current / 3), direction = current % 3;
    if (id === target) { finish = current; break; }
    const x = id % width, y = Math.floor(id / width);
    for (const [nx, ny, axis] of [[x - 1, y, 1], [x + 1, y, 1], [x, y - 1, 2], [x, y + 1, 2]]) {
      if (nx! < 0 || nx! >= width || ny! < 0 || ny! >= ys.length) continue;
      const nextId = ny! * width + nx!, next = nextId * 3 + axis!;
      if (visited.has(next)) continue;
      const a = point(id), b = point(nextId);
      if (obstacles.some((card) => crossesCard(a, b, card))) continue;
      const nextCost = cost.get(current)! + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + (direction && direction !== axis ? 28 : 0);
      if (nextCost >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, nextCost); previous.set(next, current);
      queue.push(next, nextCost + heuristic(nextId));
    }
  }
  // Overlapping cards can enclose a port. Do not draw a misleading line through
  // their contents; the connection becomes visible once the cards are separated.
  if (finish === null) return margin ? routeAgentConnection(start, end, startDirection, endDirection, cards, lane, 0) : [];
  const middle: AgentPoint[] = [];
  for (let key: number | undefined = finish; key !== undefined; key = previous.get(key)) middle.push(point(Math.floor(key / 3)));
  const points = [start, ...middle.reverse(), end];
  if (points.slice(1).some((p, index) => cards.some((card) => crossesCard(points[index]!, p, card)))) {
    return margin ? routeAgentConnection(start, end, startDirection, endDirection, cards, lane, 0) : [];
  }
  return points.filter((p, i) => i === 0 || i === points.length - 1 ||
    !((points[i - 1]!.x === p.x && p.x === points[i + 1]!.x) || (points[i - 1]!.y === p.y && p.y === points[i + 1]!.y)));
}

export function crossesCard(a: AgentPoint, b: AgentPoint, card: AgentRect): boolean {
  const epsilon = 0.01;
  if (a.x === b.x) return a.x > card.x + epsilon && a.x < card.x + card.width - epsilon &&
    Math.max(a.y, b.y) > card.y + epsilon && Math.min(a.y, b.y) < card.y + card.height - epsilon;
  return a.y > card.y + epsilon && a.y < card.y + card.height - epsilon &&
    Math.max(a.x, b.x) > card.x + epsilon && Math.min(a.x, b.x) < card.x + card.width - epsilon;
}

export function agentRoutePath(points: AgentPoint[]): string {
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x},${point.y}`).join(" ");
}

export function agentRouteLabel(points: AgentPoint[]): AgentPoint {
  const segments = points.slice(1).map((end, index) => ({ start: points[index]!, end }));
  const horizontal = segments.filter(({ start, end }) => start.y === end.y && Math.abs(end.x - start.x) >= 100);
  const segment = (horizontal.length ? horizontal : segments).sort((a, b) =>
    Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y) - Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y))[0];
  return segment ? { x: (segment.start.x + segment.end.x) / 2, y: (segment.start.y + segment.end.y) / 2 } : points[0] ?? { x: 0, y: 0 };
}

class MinQueue {
  private items: Array<{ key: number; score: number }> = [];
  get length() { return this.items.length; }
  push(key: number, score: number) {
    const item = { key, score };
    let index = this.items.length;
    this.items.push(item);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent]!.score <= score) break;
      this.items[index] = this.items[parent]!; index = parent;
    }
    this.items[index] = item;
  }
  pop(): number | undefined {
    const first = this.items[0], last = this.items.pop();
    if (!this.items.length || !last) return first?.key;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1]!.score < this.items[child]!.score) child++;
      if (this.items[child]!.score >= last.score) break;
      this.items[index] = this.items[child]!; index = child;
    }
    this.items[index] = last;
    return first?.key;
  }
}

/** Keep a crowded bundle on the straight part of a compact card's edge. */
export function fitAgentPortShifts(shifts: number[], sideLength: number): number[] {
  const extent = Math.max(0, sideLength / 2 - 14);
  const maximum = Math.max(0, ...shifts.map(Math.abs));
  const scale = maximum ? Math.min(1, extent / maximum) : 1;
  return shifts.map((shift) => shift * scale);
}
