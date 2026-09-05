import { describe, expect, it } from "vitest";
import { connectionJunctions, routeConnections } from "./connection-routing";
import { bundleAgentConnections, type GraphCard } from "./team-graph";

const cards: GraphCard[] = [
  { id: "middle", position: { x: 500, y: 200 } },
  { id: "left-top", position: { x: 0, y: 100 } },
  { id: "left-bottom", position: { x: 0, y: 300 } },
  { id: "right", position: { x: 1000, y: 200 } }
];
const relation = (source: string, target: string) => ({ id: `${source}-${target}`, source, target, type: "handoff" as const, label: "Ready" });
const render = (relations: ReturnType<typeof relation>[], nodes = cards) => routeConnections(bundleAgentConnections(relations, null, true), nodes, null);

describe("shared arrow junctions", () => {
  it("merges incoming branches at the same side center and keeps every relationship", () => {
    const relations = [relation("left-top", "middle"), relation("left-bottom", "middle")];
    const routes = render(relations);
    expect(routes).toHaveLength(2);
    expect(routes.map((route) => route.points.at(-1))).toEqual([{ x: 500, y: 266 }, { x: 500, y: 266 }]);
    const junctions = connectionJunctions(routes);
    expect(junctions).toHaveLength(1);
    expect(junctions[0]).toMatchObject({ nodeId: "middle", side: "left", relations });
    expect(junctions[0]!.arrow).toMatch(/^M 500,266 /);
    expect(junctions[0]!.path).toBe("M 500,266 L 476,266");
  });

  it.each([true, false])("shows one shared tip if any branch enters, regardless of order (incoming first: %s)", (incomingFirst) => {
    const relations = [relation("left-top", "middle"), relation("middle", "left-bottom")];
    if (!incomingFirst) relations.reverse();
    const junction = connectionJunctions(render(relations))[0]!;
    expect(junction.arrow).not.toBeNull();
    expect(junction.relations).toEqual(relations);
  });

  it("merges outgoing branches without adding an incoming arrow", () => {
    const junction = connectionJunctions(render([relation("middle", "left-top"), relation("middle", "left-bottom")]))[0]!;
    expect(junction).toMatchObject({ nodeId: "middle", side: "left", arrow: null });
  });

  it("keeps other sides independent and recalculates the shared point after a move", () => {
    const relations = [relation("left-top", "middle"), relation("left-bottom", "middle"), relation("right", "middle")];
    const routes = render(relations);
    expect(connectionJunctions(routes)).toHaveLength(1);
    const right = routes.find((route) => route.source === "middle" && route.target === "right")!;
    expect(right.startPortKey).not.toBe(connectionJunctions(routes)[0]!.id);
    const moved = cards.map((card) => card.id === "middle" ? { ...card, position: { x: 600, y: 220 } } : card);
    expect(connectionJunctions(render(relations, moved))[0]!.arrow).toMatch(/^M 600,286 /);
  });
});
