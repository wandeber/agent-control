import { describe, expect, it } from "vitest";
import { agentPresentation } from "./agent-presentation";
import { buildRelations, focusedAgentId, initialLayout, primaryAgentRelations, type GraphRelation } from "./graph";
import { bundleAgentConnections, projectTeamRelations } from "./team-graph";
import type { AgentRecord, DashboardSnapshot } from "./types";

const agents = ["owner", "a", "b", "c"].map((id) => ({ agent_id: id, role: id, status: id === "b" ? "running" : "completed" })) as AgentRecord[];
const data = () => ({ agents, runs: [], flow_instances: [], flows: [], flow_steps: [], computed_agents: [], flow_transitions: [] }) as unknown as DashboardSnapshot;
const relation = (source: string, target: string, type: GraphRelation["type"] = "handoff", label = "Next phase") => ({ id: `${source}-${target}-${type}-${label}`, source, target, type, label });

describe("focused agent relationships", () => {
  it("shows incoming and outgoing focus relations while retaining only the other main connections", () => {
    const edges = [relation("a", "b"), relation("b", "c"), relation("owner", "a", "parent_child"), relation("a", "c", "subscribed_to"), relation("c", "b", "blocks")];
    const main = primaryAgentRelations(data(), edges);
    const focused = bundleAgentConnections(projectTeamRelations(null, edges, main), "b", false);
    expect(focused).toHaveLength(3);
    expect(new Set(focused.flatMap((edge) => edge.relations.map((relation) => relation.id)))).toEqual(new Set([edges[0]!.id, edges[1]!.id, edges[2]!.id, edges[4]!.id]));
    expect(bundleAgentConnections(projectTeamRelations(null, edges, main), "b", true)).toHaveLength(4);
  });
  it("keeps the explicit selection ahead of the running worker, with an active fallback", () => {
    expect(focusedAgentId(data(), "a")).toBe("a");
    expect(focusedAgentId(data(), null)).toBe("b");
    expect(focusedAgentId(data(), "removed")).toBe("b");
  });
  it("bundles parallel conditions without dropping their explanations or direction", () => {
    const edges = [relation("a", "b", "handoff", "Ready"), relation("a", "b", "handoff", "Retry"), relation("b", "a")];
    const visible = bundleAgentConnections(edges, "a", false);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ source: "a", target: "b", arrowAtSource: true, arrowAtTarget: true });
    expect(visible[0]!.relations.map((relation) => relation.label)).toEqual(["Ready", "Retry", "Next phase"]);
  });
  it("uses declared forward flow connections, without fabricating a creation-order chain", () => {
    const snapshot = data();
    snapshot.flows = [{ flow_record_id: "f", flow_id: "test", config: { initial_step: "analysis", steps: {
      analysis: { role: "a", on: { reported: { to: "build" } } },
      build: { role: "b", on: { reported: { transitions: [{ id: "ready", to: "review" }, { id: "retry", to: "analysis" }] } } },
      review: { role: "c" }
    } } }] as unknown as DashboardSnapshot["flows"];
    snapshot.flow_instances = [{ flow_record_id: "f", flow_instance_id: "i", status: "active", current_step_id: "build" }] as DashboardSnapshot["flow_instances"];
    const edges = [relation("a", "b"), relation("b", "c"), relation("b", "a"), relation("owner", "c", "parent_child")];
    expect(primaryAgentRelations(snapshot, edges).map((edge) => edge.id)).toEqual([edges[0]!.id, edges[1]!.id]);
    const visible = bundleAgentConnections(projectTeamRelations(null, edges, primaryAgentRelations(snapshot, edges)), "c", false);
    expect(visible).toHaveLength(3);
    expect(visible.find((edge) => edge.source === "a")?.arrowAtSource).toBe(true);
  });
  it("places reused flow roles without collapsing their cyclic relationships", () => {
    const snapshot = data();
    snapshot.flows = [{ flow_record_id: "f", flow_id: "test", config: { initial_step: "analysis", steps: {
      analysis: { role: "a", on: { reported: { to: "planning" } } },
      planning: { role: "b", on: { reported: { to: "review" } } },
      review: { role: "a", on: { reported: { to: "implement" } } },
      implement: { role: "c", on: { reported: { to: "planning" } } }
    } } }] as unknown as DashboardSnapshot["flows"];
    snapshot.flow_instances = [{ flow_record_id: "f", flow_instance_id: "i", status: "active" }] as DashboardSnapshot["flow_instances"];
    const positions = initialLayout(agents, [relation("a", "b"), relation("b", "a"), relation("a", "c"), relation("c", "b")], snapshot);
    expect(new Set([...positions.values()].map((point) => point.x)).size).toBeGreaterThan(1);
    expect(new Set([...positions.values()].map((point) => JSON.stringify(point))).size).toBe(agents.length);
  });


});

describe("agent card activity", () => {
  it("shows the last nonempty public line and uses actual active tool activity", () => {
    const snapshot = data();
    snapshot.computed_agents = [{ agent_id: "b", activity: { kind: "message", text: "First line\nLatest visible update\n" } }] as DashboardSnapshot["computed_agents"];
    expect(agentPresentation(snapshot, agents[2]!)).toMatchObject({ activity: "Latest visible update", kind: "message", phase: null });
    snapshot.computed_agents[0]!.activity = { kind: "tool", text: "Running tests" };
    expect(agentPresentation(snapshot, agents[2]!).kind).toBe("tool");
    expect(agentPresentation(snapshot, { ...agents[2]!, status: "completed" }).kind).toBe("tool");
  });
  it("labels the phase and rejects activity from the previous attempt", () => {
    const snapshot = data();
    snapshot.flow_instances = [{ flow_instance_id: "i", current_step_id: "plan_review", status: "active" }] as DashboardSnapshot["flow_instances"];
    snapshot.flow_steps = [{ step_instance_id: "step", flow_instance_id: "i", agent_id: "b", step_id: "plan_review", status: "active", created_at: "2026-09-05T10:01:00Z", updated_at: "2026-09-05T10:01:00Z" }] as DashboardSnapshot["flow_steps"];
    snapshot.computed_agents = [{ agent_id: "b", activity: { kind: "message", text: "Old answer", observed_at: "2026-09-05T10:00:00Z" } }] as DashboardSnapshot["computed_agents"];
    expect(agentPresentation(snapshot, agents[2]!)).toMatchObject({ phase: "Phase: Plan review", kind: "status" });
    snapshot.flow_instances[0]!.status = "completed";
    expect(agentPresentation(snapshot, agents[2]!).phase).toBe("Last phase: Plan review");
  });
  it("keeps the blocked phase current and focuses its worker ahead of a running owner", () => {
    const snapshot = data();
    snapshot.agents = [{ ...agents[0]!, role: "orchestrator", status: "running" }, { ...agents[2]!, status: "blocked" }];
    snapshot.flow_instances = [{ flow_instance_id: "i", current_step_id: "analysis", status: "blocked" }] as DashboardSnapshot["flow_instances"];
    snapshot.flow_steps = [{ step_instance_id: "s", flow_instance_id: "i", agent_id: "b", step_id: "analysis", status: "blocked", created_at: "2026-09-05T10:00:00Z", updated_at: "2026-09-05T10:00:00Z" }] as DashboardSnapshot["flow_steps"];
    expect(focusedAgentId(snapshot, null)).toBe("b");
    expect(agentPresentation(snapshot, snapshot.agents[1]!).phase).toBe("Phase: Analysis");
    expect(agentPresentation(snapshot, { ...agents[0]!, role: "observer", status: "stopped" }).activity).not.toContain("Following");
  });
  it("keeps the last completed tool visible without describing a stopped agent as executing it", () => {
    const snapshot = data();
    snapshot.computed_agents = [{ agent_id: "b", activity: { kind: "tool", text: "Run tests", state: "completed" } }] as DashboardSnapshot["computed_agents"];
    expect(agentPresentation(snapshot, { ...agents[2]!, status: "completed" }).activity).toBe("Tool completed · Run tests");
    snapshot.computed_agents[0]!.activity!.state = "running";
    expect(agentPresentation(snapshot, { ...agents[2]!, status: "stopped" }).activity).toBe("Last tool · Run tests");
  });

});
