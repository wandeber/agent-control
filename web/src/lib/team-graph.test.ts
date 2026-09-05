import { describe, expect, it } from "vitest";
import { routeConnections } from "./connection-routing";
import { crossesCard } from "./agent-routing";
import { buildRelations, TEAM_NODE_ID, type GraphRelation } from "./graph";
import { buildAgentTeam, bundleAgentConnections, cardBounds, projectTeamRelations, keepExternalCardsOutsideTeam, teamBounds, teamLayout } from "./team-graph";
import type { AgentRecord, DashboardSnapshot, SubscriptionRecord } from "./types";

const agents = ["owner", "a", "b", "c"].map((id) => ({ agent_id: id, run_id: "run", title: id,
  role: id === "owner" ? "orchestrator" : id, status: "running", created_at: "2026-09-05" })) as AgentRecord[];
const data = () => ({ selected_run_id: "run", agents, runs: [], agent_links: [], subscriptions: [], flow_instances: [], flows: [],
  flow_steps: [], computed_agents: [], flow_transitions: [] }) as unknown as DashboardSnapshot;
const relation = (source: string, target: string, type: GraphRelation["type"] = "handoff", label: string = type) => ({ id: `${source}-${target}-${type}-${label}`, source, target, type, label });
const subscription = (id: string, source: string | null, event: string, subscriber = "owner") => ({
  subscription_id: id, source_agent_id: source, subscriber_agent_id: subscriber, event_type: event, enabled: true, run_id: "run"
}) as SubscriptionRecord;

describe("one connection per pair", () => {
  it("preserves mixed types and both directions in a single connection", () => {
    const edges = [relation("a", "b", "parent_child"), relation("b", "a", "subscribed_to"), relation("a", "b", "handoff")];
    const connections = bundleAgentConnections(edges, "a", false);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ arrowAtSource: true, arrowAtTarget: true, relations: edges });
    expect(bundleAgentConnections(edges.slice(0, 1), "a", false)[0]).toMatchObject({ arrowAtSource: false, arrowAtTarget: true });
    expect(bundleAgentConnections(edges.slice(1, 2), "a", false)[0]).toMatchObject({ arrowAtSource: true, arrowAtTarget: false });
  });
  it("keeps manual links and every enabled event filter without inferring scope from observer event types", () => {
    const snapshot = data();
    snapshot.agent_links = [{ link_id: "manual", source_agent_id: "owner", target_agent_id: "a", type: "subscribed_to", label: "Manual dependency" }] as DashboardSnapshot["agent_links"];
    snapshot.subscriptions = [subscription("completed", "a", "agent.completed"), subscription("blocked", "a", "agent.blocked"),
      { ...subscription("disabled", "b", "agent.failed"), enabled: false }, { ...subscription("foreign", null, "agent.failed"), run_id: "other" }];
    snapshot.run_observers = [{ observer_agent_id: "owner", run_id: "run", delivery: "wait", event_types: ["agent.completed", "agent.blocked"] }];
    const edges = buildRelations(snapshot);
    expect(edges).toHaveLength(3);
    expect(edges.every((edge) => edge.target === "a")).toBe(true);
    expect(bundleAgentConnections(edges, "owner", false)[0]!.relations.map((edge) => edge.label)).toEqual(["Manual dependency", "agent.completed", "agent.blocked"]);
  });
});

describe("team relationship scope", () => {
  it("replaces common hierarchy with one team relation while retaining member labels and particular handoffs", () => {
    const team = buildAgentTeam(agents)!;
    const hierarchy = team.members.map((id) => relation("owner", id, "parent_child", id));
    const partial = relation("owner", "a", "handoff", "Needs clarification");
    const projected = projectTeamRelations(team, [...hierarchy, partial], []);
    expect(projected).toHaveLength(2);
    expect(projected.find((edge) => edge.target === TEAM_NODE_ID)).toMatchObject({ source: "owner", originalRelations: hierarchy, members: ["a", "b", "c"] });
    expect(projected.find((edge) => edge.target === "a")).toEqual({ ...partial, primary: false });
    // Filtering the view cannot make an incomplete relation appear global.
    expect(bundleAgentConnections(projected, "owner", false)).toHaveLength(2);
    expect(projectTeamRelations(team, hierarchy.slice(0, 2), []).every((edge) => edge.target !== TEAM_NODE_ID)).toBe(true);
  });
  it("preserves member-specific conditions inside a common handoff type", () => {
    const team = buildAgentTeam(agents)!;
    const edges = team.members.map((id) => relation("owner", id, "handoff", `review-${id}`));
    const projected = projectTeamRelations(team, edges, []);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ target: TEAM_NODE_ID, originalRelations: edges });
    expect(projected[0]?.scope).toBeUndefined();
  });
  it("lets a team member subscribe to the team and keeps global and particular filters distinct", () => {
    const snapshot = data();
    snapshot.subscriptions = [subscription("global", null, "agent.completed", "b"), subscription("specific", "a", "agent.blocked", "b")];
    const edges = projectTeamRelations(buildAgentTeam(snapshot.agents), buildRelations(snapshot), []);
    const connections = bundleAgentConnections(edges, "b", false);
    expect(connections).toHaveLength(2);
    expect(edges.find((edge) => edge.target === TEAM_NODE_ID)).toMatchObject({ source: "b", scope: "run", label: "agent.completed" });
    expect(edges.find((edge) => edge.target === "a")).toMatchObject({ source: "b", label: "agent.blocked" });
    snapshot.agents = [...agents, { ...agents[1]!, agent_id: "future" }];
    expect(projectTeamRelations(buildAgentTeam(snapshot.agents), buildRelations(snapshot), []).find((edge) => edge.scope === "run")?.members).toContain("future");
  });
  it("does not extend common current-member relationships to a new member without evidence", () => {
    const edges = agents.slice(1).map((agent) => relation("owner", agent.agent_id, "parent_child"));
    const expanded = [...agents, { ...agents[1]!, agent_id: "future" }];
    expect(projectTeamRelations(buildAgentTeam(expanded), edges, []).some((edge) => edge.target === TEAM_NODE_ID)).toBe(false);
  });
  it("accepts an unscoped subscription without inventing a team from observers alone", () => {
    const snapshot = data();
    snapshot.subscriptions = [{ ...subscription("any-run", null, "agent.completed"), run_id: null }];
    expect(buildRelations(snapshot)[0]).toMatchObject({ target: TEAM_NODE_ID, scope: "run" });
    expect(buildAgentTeam(agents.slice(0, 1))).toBeNull();
  });
  it("positions the owner outside the team and updates the frame as a member moves", () => {
    const snapshot = data(), team = buildAgentTeam(agents)!;
    const layout = teamLayout(snapshot, [], team);
    const cards = agents.map((agent) => ({ id: agent.agent_id, position: layout.get(agent.agent_id)! }));
    const initial = teamBounds(cards, team)!;
    expect(layout.get("owner")!.y + 132).toBeLessThan(initial.frame.y);
    const moved = cards.map((card) => card.id === "b" ? { ...card, position: { x: 1500, y: 1100 } } : card);
    const resized = teamBounds(moved, team)!;
    expect(resized.frame.width).toBeGreaterThan(initial.frame.width);
    expect(resized.frame.y + resized.frame.height).toBeGreaterThan(1100 + 132);
    expect(resized.header.position.y + 20).toBe(resized.frame.y);
  });
});


describe("team connection geometry", () => {
  it("routes an internal subscription to the shared header inside the team, with two tips only for two directions", () => {
    const snapshot = data(), team = buildAgentTeam(agents)!;
    const layout = teamLayout(snapshot, [], team);
    const cards = agents.map((agent) => ({ id: agent.agent_id, position: layout.get(agent.agent_id)! }));
    const edges = bundleAgentConnections([relation("b", TEAM_NODE_ID, "subscribed_to"), relation(TEAM_NODE_ID, "b", "handoff")], "b", false);
    const rendered = routeConnections(edges, cards, team);
    const frame = teamBounds(cards, team)!.frame;
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ arrowAtSource: true, arrowAtTarget: true });
    for (const point of rendered[0]!.points) {
      expect(point.x).toBeGreaterThanOrEqual(frame.x);
      expect(point.x).toBeLessThanOrEqual(frame.x + frame.width);
      expect(point.y).toBeGreaterThanOrEqual(frame.y);
      expect(point.y).toBeLessThanOrEqual(frame.y + frame.height);
    }
    expect(rendered[0]!.points.slice(1).some((point, index) => cards.some((card) => crossesCard(rendered[0]!.points[index]!, point, cardBounds(card))))).toBe(false);
  });
});


describe("team membership while dragging", () => {
  it("keeps external cards outside when a member expands the frame over them", () => {
    const team = buildAgentTeam(agents)!;
    const cards = [{ id: "owner", position: { x: 100, y: 30 } },
      { id: "a", position: { x: 100, y: 380 } }, { id: "b", position: { x: 100, y: 0 } }];
    const result = keepExternalCardsOutsideTeam(cards, team);
    const frame = teamBounds(result, team)!.frame;
    expect(result[0]!.position.y + 132).toBeLessThan(frame.y - 20);
    expect(result.slice(1)).toEqual(cards.slice(1));
  });
  it("prevents dropping an outside card into the team without stacking it on another outside card", () => {
    const team = buildAgentTeam(agents)!;
    const cards = [{ id: "owner", position: { x: 100, y: 500 } }, { id: "observer", position: { x: 100, y: 212 } },
      { id: "a", position: { x: 100, y: 500 } }, { id: "b", position: { x: 540, y: 500 } }];
    const result = keepExternalCardsOutsideTeam(cards, team);
    expect(result[0]!.position).toEqual({ x: 440, y: 212 });
    expect(keepExternalCardsOutsideTeam(result, team)).toEqual(result);
  });
});


it("finds a free outside slot when displaced cards each obstruct multiple nominal slots", () => {
  const team = buildAgentTeam(agents)!;
  const cards = [{ id: "owner", position: { x: 0, y: 500 } }, { id: "observer-1", position: { x: 280, y: 212 } },
    { id: "observer-2", position: { x: 960, y: 212 } }, { id: "a", position: { x: 100, y: 500 } }, { id: "b", position: { x: 540, y: 500 } }];
  expect(keepExternalCardsOutsideTeam(cards, team)[0]!.position).toEqual({ x: 620, y: 212 });
});
