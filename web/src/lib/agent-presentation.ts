import { STATUS_STYLE } from "./format";
import { latestAgentFlowStep } from "./flow-steps";
import type { AgentRecord, DashboardSnapshot } from "./types";

export function agentPresentation(snapshot: DashboardSnapshot, agent: AgentRecord) {
  const step = latestAgentFlowStep(snapshot, agent.agent_id);
  const instance = snapshot.flow_instances.find((item) => item.flow_instance_id === step?.flow_instance_id);
  const currentPhase = step && ["active", "blocked", "failed"].includes(step.status) &&
    !["completed", "stopped"].includes(agent.status) && instance?.current_step_id === step.step_id &&
    (instance.status === "active" || instance.status === "blocked");
  const phase = step ? `${currentPhase ? "Phase" : "Last phase"}: ${humanize(step.step_id)}` : null;
  const run = snapshot.runs.find((item) => item.run_id === agent.run_id);
  const generatedCoordinatorTitle = agent.role === "orchestrator" && run && (agent.title === run.title || agent.title === `${run.title} orchestrator`);
  const activity = snapshot.computed_agents.find((item) => item.agent_id === agent.agent_id)?.activity;
  // An earlier attempt's output must not look like progress on a fresh phase.
  const fresh = !step || Boolean(activity?.observed_at && Date.parse(activity.observed_at) >= Date.parse(step.created_at));
  const running = ["starting", "running", "waiting_for_input"].includes(agent.status);
  const text = activity && fresh ? lastLine(activity.text) : "";
  const toolPrefix = activity?.state === "running" && running ? "Using tool" : activity?.state === "completed" ? "Tool completed" : activity?.state === "failed" ? "Tool failed" : "Last tool";
  const summary = lastLine(step?.summary ?? "");
  return {
    title: generatedCoordinatorTitle ? "Orchestrator" : snapshot.flows.some((flow) => agent.title === `${flow.flow_id}: ${agent.role}`) ? humanize(agent.role ?? "worker") : agent.title,
    phase,
    activity: (text && activity?.kind === "tool" ? `${toolPrefix} · ${text}` : text) || summary || lastLine((agent.failure_reason ?? "").replaceAll("_", " ")) ||
      (agent.role === "observer" && running ? "Following run events" : agent.status === "planned" ? "Ready for its turn" :
        agent.status === "waiting_for_input" ? "Waiting for input" : `${STATUS_STYLE[agent.status].label} · no activity recorded`),
    kind: text ? activity!.kind : "status" as const
  };
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function lastLine(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

/** Resolved profile metadata is display-only and never a launch override. */
export function agentModelLabel(agent: AgentRecord): string {
  const resolved = agent.backend_handle?.resolved_model;
  return agent.model || (typeof resolved === "string" && resolved.trim() ? resolved : agent.backend);
}
