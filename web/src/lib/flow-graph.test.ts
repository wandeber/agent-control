import { describe, expect, it } from "vitest";
import { buildFlowDefinitionGraph, buildFlowVisualModel } from "./flow-graph";
import { diagramPath, flowDiagramEdges, flowDiagramPositions, PHASE_HEIGHT, PHASE_WIDTH, routeFlowDiagram, visibleFlowDiagramEdges } from "./flow-diagram";
import type { DashboardSnapshot, FlowStepInstanceRecord, FlowTransitionRecord } from "./types";

function snapshot(): DashboardSnapshot {
  return {
    flows: [{ flow_record_id: "definition", flow_id: "review-flow", config: { initial_step: "analysis", steps: {
      analysis: { on: { reported: { notify: "reviewer" } } },
      planning: { on: { reported: { transitions: [
        { id: "ready", when: { equals: { var: "result.conclusion", value: "ready" } }, to: "review" },
        { id: "revise", to: "analysis" },
        { id: "blocked", notify: "orchestrator" }
      ] } } },
      review: { on: { reported: { transitions: [
        { id: "changes", to: "planning" },
        { id: "approved", finish: true, notify: "orchestrator" }
      ] } } }
    } } }],
    flow_instances: [{ flow_instance_id: "instance", flow_record_id: "definition", status: "active", current_step_id: "analysis", updated_at: "2026-09-05T10:00:00Z" }],
    flow_steps: [], flow_transitions: []
  } as unknown as DashboardSnapshot;
}

function step(step_id: string, step_instance_id: string, second = 0, status: FlowStepInstanceRecord["status"] = "completed"): FlowStepInstanceRecord {
  return { step_id, step_instance_id, flow_instance_id: "instance", status, agent_id: null, input_json: {}, output_json: {}, result_json: {}, transition_id: null, summary: null, created_at: `2026-09-05T10:00:0${second}Z`, updated_at: `2026-09-05T10:00:0${second}Z`, completed_at: null };
}
function transition(from: string, id: string, second: number, action: Record<string, unknown> = {}): FlowTransitionRecord {
  return { flow_transition_id: `transition-${second}`, flow_instance_id: "instance", from_step_instance_id: from, transition_id: id, target_step_id: typeof action.to === "string" ? action.to : null, action_json: action, created_at: `2026-09-05T10:00:0${second}Z` };
}

describe("flow diagram semantics", () => {
  it("renders finish plus notification as a finish and marks the terminal only after completion", () => {
    const data = snapshot();
    let model = buildFlowVisualModel(data)!;
    expect(model.edges.find((edge) => edge.transitionId === "approved")?.target).toBe("finish:done");
    expect(model.nodes.find((node) => node.kind === "finish")?.status).toBe("planned");
    data.flow_instances[0]!.status = "completed";
    model = buildFlowVisualModel(data)!;
    expect(model.nodes.find((node) => node.kind === "finish")?.status).toBe("completed");
  });

  it("shows the recorded manual handoff instead of inventing an automatic continuation", () => {
    const data = snapshot();
    expect(buildFlowVisualModel(data)!.edges.some((edge) => edge.source === "step:analysis" && edge.target === "step:planning")).toBe(false);
    data.flow_steps = [step("analysis", "a")];
    data.flow_transitions = [transition("a", "analysis-manual-to-planning", 1, { manual: true, to: "planning" })];
    const manual = buildFlowVisualModel(data)!.edges.find((edge) => edge.target === "step:planning" && edge.source === "step:analysis");
    expect(manual).toMatchObject({ label: "Orchestrator continuation", tone: "taken" });
  });

  it("does not highlight a previous attempt's rollback alongside the new approval", () => {
    const data = snapshot();
    data.flow_steps = [step("review", "old"), step("review", "new", 2)];
    data.flow_transitions = [transition("old", "changes", 1), transition("new", "approved", 3)];
    const model = buildFlowVisualModel(data)!;
    expect(model.edges.filter((edge) => edge.tone === "taken").map((edge) => edge.transitionId)).toEqual(["approved"]);
    expect(model.nodes.find((node) => node.stepId === "review")?.instanceCount).toBe(2);
  });

  it("uses the final notification to identify where the flow is waiting", () => {
    const data = snapshot();
    data.flow_instances[0]!.status = "waiting_for_orchestrator";
    data.flow_instances[0]!.current_step_id = null;
    data.flow_steps = [step("analysis", "a"), step("planning", "p", 2)];
    data.flow_transitions = [
      transition("a", "notify", 1, { notify: "reviewer" }),
      transition("a", "manual", 2, { manual: true, to: "planning" }),
      transition("p", "blocked", 3, { notify: "orchestrator" })
    ];
    expect(buildFlowVisualModel(data)!.nodes.filter((node) => node.isCurrent).map((node) => node.id)).toEqual(["notify:orchestrator"]);
  });

  it("prefers a new active attempt when creation timestamps tie", () => {
    const data = snapshot();
    data.flow_steps = [step("analysis", "old", 0, "cancelled"), step("analysis", "new", 0, "active")];
    expect(buildFlowVisualModel(data)!.nodes.find((node) => node.stepId === "analysis")?.latestStep?.step_instance_id).toBe("new");
  });

  it("identifies a pending user gate without inventing an assigned worker", () => {
    const data = snapshot();
    data.flows[0]!.config.steps.planning = { execution: "coordinator", decision: { key: "approve_plan", authority: "user" } };
    data.flow_instances[0]!.status = "waiting_for_orchestrator";
    data.flow_instances[0]!.current_step_id = "planning";
    data.flow_steps = [step("planning", "approval", 0, "active")];
    const node = buildFlowVisualModel(data)!.nodes.find((candidate) => candidate.stepId === "planning")!;
    expect(node.waitingLabel).toBe("Waiting for your decision");
    expect(node.latestStep?.agent_id).toBeNull();
    expect(node.status).toBe("active");
    data.flows[0]!.config.steps.planning!.decision = { key: "custom_intent_check", authority: "coordinator", owner: "requester" };
    expect(buildFlowVisualModel(data)!.nodes.find((candidate) => candidate.stepId === "planning")?.waitingLabel).toBe("Waiting for clarification owner review");
  });
});

describe("readable flow routes", () => {
  it("keeps the overview connected while exposing alternatives on selection or explicitly", () => {
    const model = buildFlowVisualModel(snapshot())!;
    const edges = flowDiagramEdges(model.nodes, model.edges);
    const overview = visibleFlowDiagramEdges(edges, "step:analysis", false);
    expect(overview.map((edge) => edge.id)).toContain("step:planning->step:review");
    expect(overview.map((edge) => edge.id)).not.toContain("step:planning->step:analysis");
    expect(visibleFlowDiagramEdges(edges, "step:planning", false).map((edge) => edge.id)).toContain("step:planning->step:analysis");
    expect(visibleFlowDiagramEdges(edges, null, true)).toHaveLength(edges.length);
    const taken = edges.map((edge) => edge.target === "step:analysis" ? { ...edge, tone: "taken" as const } : edge);
    expect(visibleFlowDiagramEdges(taken, null, false).map((edge) => edge.id)).toContain("step:planning->step:analysis");
  });

  it("keeps different notification origins distinct and preserves their conditions", () => {
    const data = snapshot();
    data.flows[0]!.config.steps.review!.on = { reported: { transitions: [{ id: "blocked", notify: "orchestrator" }, { id: "help", notify: "orchestrator" }] } };
    const model = buildFlowVisualModel(data)!;
    const edges = flowDiagramEdges(model.nodes, model.edges);
    expect(edges.filter((edge) => edge.target === "notify:orchestrator")).toHaveLength(2);
    expect(edges.find((edge) => edge.source === "step:review")?.conditions).toContain("notify orchestrator");
  });

  it.each([1, 3])("routes forwards, returns, and self loops in a %i-column layout", (columns) => {
    const model = buildFlowVisualModel(snapshot())!;
    const edges = flowDiagramEdges(model.nodes, [...model.edges, { id: "self", source: "step:review", target: "step:review", label: "retry", tone: "default", transitionId: "retry", sourceStepId: "review" }]);
    const positions = flowDiagramPositions(model.nodes, columns);
    const nodes = model.nodes.map((node) => ({ id: node.id, kind: node.kind, position: positions.get(node.id)!, width: PHASE_WIDTH, height: PHASE_HEIGHT }));
    const routes = routeFlowDiagram(edges, nodes);
    expect(routes).toHaveLength(edges.length);
    for (const { edge, points } of routes) {
      const target = nodes.find((node) => node.id === edge.target)!;
      const tip = points.at(-1)!;
      expect(tip.x >= target.position.x && tip.x <= target.position.x + target.width).toBe(true);
      expect(tip.y >= target.position.y && tip.y <= target.position.y + target.height).toBe(true);
      for (let index = 1; index < points.length; index++) expect(points[index]!.x === points[index - 1]!.x || points[index]!.y === points[index - 1]!.y).toBe(true);
      expect(diagramPath(points)).not.toContain("NaN");
      for (const obstacle of nodes.filter((node) => node.id !== edge.source && node.id !== edge.target)) {
        for (let index = 1; index < points.length; index++) {
          const a = points[index - 1]!, b = points[index]!;
          const crosses = a.x === b.x
            ? a.x > obstacle.position.x && a.x < obstacle.position.x + obstacle.width && Math.max(a.y, b.y) > obstacle.position.y && Math.min(a.y, b.y) < obstacle.position.y + obstacle.height
            : a.y > obstacle.position.y && a.y < obstacle.position.y + obstacle.height && Math.max(a.x, b.x) > obstacle.position.x && Math.min(a.x, b.x) < obstacle.position.x + obstacle.width;
          expect(crosses, `${edge.id} crosses ${obstacle.id}`).toBe(false);
        }
      }
    }
  });
});


describe("unstarted source graph", () => {
  it("includes declared transitions and prompts without synthesizing executed steps", () => {
    const graph = buildFlowDefinitionGraph({ id: "draft", initial_step: "first", steps: {
      first: { role: "writer", prompt: "Write", on: { reported: { to: "review" } } },
      review: { role: "reviewer", on: { reported: { transitions: [{ id: "retry", to: "first" }, { id: "done", finish: true }] } } }
    } });
    expect(graph.nodes.filter(node => node.stepId).map(node => node.stepId)).toEqual(["first", "review"]);
    expect(graph.nodes.every(node => !node.isCurrent && !node.latestStep && !node.instanceCount)).toBe(true);
    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([["step:first", "step:review"], ["step:review", "step:first"], ["step:review", "finish:done"]]);
  });
});
