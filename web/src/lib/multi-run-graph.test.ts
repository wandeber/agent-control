import { describe, expect, it } from "vitest";
import { buildRunGraph, keepRunsSeparate, multiRunBounds, multiRunLayout, runGraphBounds } from "./multi-run-graph";
import { combineRunSnapshots } from "./run-snapshots";
import type { DashboardSnapshot } from "./types";

function fixture(id: string): DashboardSnapshot {
  return {
    selected_run_id: id, runs: [{ run_id: id, title: id }],
    agents: ["owner", "worker", "reviewer"].map(role => ({ agent_id: `${id}:${role}`, run_id: id, title: role,
      role: role === "owner" ? "orchestrator" : role, status: "running", created_at: "2026-09-08", updated_at: "2026-09-08" })),
    subscriptions: [{ subscription_id: id, subscriber_agent_id: `${id}:owner`, source_agent_id: null, run_id: id, enabled: true, event_type: "agent.completed" }],
    agent_links: [], flows: [], flow_instances: [], flow_steps: [], flow_reports: [], flow_transitions: [], flow_artifact_bindings: [],
    heartbeats: [], goals: [], artifacts: [], latest_events: [], computed_agents: []
  } as unknown as DashboardSnapshot;
}

describe("multiple runs on one canvas", () => {
  it("keeps subscriptions and teams local and arranges non-overlapping frames", () => {
    const groups = [fixture("a"), fixture("b")].map(buildRunGraph);
    const positions = multiRunLayout(groups);
    const frames = groups.map(group => runGraphBounds(group.snapshot.agents.map(agent => ({ id: agent.agent_id, position: positions.get(agent.agent_id)! })), group.team));
    expect(frames[0].x + frames[0].width).toBeLessThan(frames[1].x);
    for (const group of groups) {
      expect(group.projected).toHaveLength(1);
      expect(group.projected[0].source).toBe(`${group.snapshot.selected_run_id}:owner`);
      expect(group.team?.members.every(id => id.startsWith(group.snapshot.selected_run_id!))).toBe(true);
    }
  });
  it("retains empty runs and exposes all agent identities without inventing combined pricing", () => {
    const a = fixture("a"), b = fixture("b");
    b.agents = [];
    const groups = [a, b].map(buildRunGraph);
    expect(multiRunLayout(groups).size).toBe(a.agents.length);
    const layout = multiRunLayout(groups);
    const cards = a.agents.map(agent => ({ id: agent.agent_id, position: layout.get(agent.agent_id)! }));
    const frames = multiRunBounds(groups, cards);
    expect(frames[1].x).toBeGreaterThan(frames[0].x + frames[0].width);
    const combined = combineRunSnapshots([a, fixture("c")])!;
    expect(combined.agents).toHaveLength(6);
    expect(combined.subscriptions).toHaveLength(2);
    expect(combined.costs).toBeUndefined();
    expect(combineRunSnapshots([a])).toBe(a);
  });
  it("keeps a growing run separate by shifting the next diagram as a unit", () => {
    const groups = [fixture("a"), fixture("b")].map(buildRunGraph);
    const layout = multiRunLayout(groups);
    const cards = groups.flatMap(group => group.snapshot.agents.map(agent => ({ id: agent.agent_id, position: layout.get(agent.agent_id)! })));
    cards.find(card => card.id === "a:reviewer")!.position.x += 1200;
    const moved = keepRunsSeparate(groups, cards);
    const frames = multiRunBounds(groups, moved);
    expect(frames[1].x).toBeGreaterThan(frames[0].x + frames[0].width);
    const shifts = moved.filter(card => card.id.startsWith("b:")).map(card => card.position.x - cards.find(old => old.id === card.id)!.position.x);
    expect(new Set(shifts).size).toBe(1);
    expect(shifts[0]).toBeGreaterThan(0);
  });
});
