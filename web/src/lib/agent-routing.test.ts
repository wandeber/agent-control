import { describe, expect, it } from "vitest";
import { crossesCard, routeAgentConnection, type AgentRect } from "./agent-routing";

describe("agent routes around cards", () => {
  const cases: AgentRect[][] = [
    [{ x: 400, y: 400, width: 300, height: 130 }, { x: 800, y: 400, width: 300, height: 130 }, { x: 720, y: 430, width: 60, height: 70 }, { x: 350, y: 200, width: 100, height: 130 }],
    [{ x: 0, y: 0, width: 300, height: 130 }, { x: 0, y: 600, width: 300, height: 130 }, { x: 0, y: 200, width: 300, height: 130 }, { x: 0, y: 400, width: 300, height: 130 }],
    [{ x: -400, y: -300, width: 300, height: 130 }, { x: 200, y: 300, width: 300, height: 130 }, { x: -200, y: 0, width: 600, height: 130 }],
    [{ x: 0, y: 0, width: 300, height: 130 }, { x: 310, y: 0, width: 300, height: 130 }]
  ];
  it.each(cases.map((cards, index) => ({ index, cards })))("keeps every directed connection clear in layout $index", ({ cards }) => {
    for (const source of cards) for (const target of cards) {
      if (source === target) continue;
      const horizontal = Math.abs(source.x - target.x) >= Math.abs(source.y - target.y);
      const forward = horizontal ? target.x > source.x : target.y > source.y;
      const start = horizontal ? { x: source.x + (forward ? source.width : 0), y: source.y + source.height / 2 } : { x: source.x + source.width / 2, y: source.y + (forward ? source.height : 0) };
      const end = horizontal ? { x: target.x + (forward ? 0 : target.width), y: target.y + target.height / 2 } : { x: target.x + target.width / 2, y: target.y + (forward ? 0 : target.height) };
      const direction = horizontal ? { x: forward ? 1 : -1, y: 0 } : { x: 0, y: forward ? 1 : -1 };
      const reverse = { x: -direction.x, y: -direction.y };
      const route = routeAgentConnection(start, end, direction, reverse, cards);
      expect(route.length).toBeGreaterThan(1);
      expect(route[0]).toEqual(start);
      expect(route.at(-1)).toEqual(end);
      expect(routeAgentConnection(start, end, direction, reverse, cards)).toEqual(route);
      route.slice(1).forEach((point, index) => {
        const previous = route[index]!;
        expect(previous.x === point.x || previous.y === point.y).toBe(true);
        cards.forEach((card) => expect(crossesCard(previous, point, card)).toBe(false));
      });
    }
  });
  it("does not draw through a card enclosing the source port", () => {
    expect(routeAgentConnection({ x: 300, y: 60 }, { x: 600, y: 60 }, { x: 1, y: 0 }, { x: -1, y: 0 }, [
      { x: 0, y: 0, width: 300, height: 130 }, { x: 280, y: 0, width: 100, height: 130 }, { x: 600, y: 0, width: 300, height: 130 }
    ])).toEqual([]);
  });


});
