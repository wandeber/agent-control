import { STATUS_STYLE } from "./format";
import { latestAgentFlowStep } from "./flow-steps";
import type { AgentRecord, DashboardSnapshot, UsageSnapshotRecord } from "./types";

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
    usage: snapshot.computed_agents.find((item) => item.agent_id === agent.agent_id)?.latest_usage ?? null,
    tokens: agentTokenLabel(snapshot.computed_agents.find((item) => item.agent_id === agent.agent_id)?.latest_usage),
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

/** Missing usage is unknown, not zero. Never substitute context size for consumption. */
export function agentTokenLabel(usage?: UsageSnapshotRecord | null): string | null {
  if (!usage) return null;
  const parts = ([['input_tokens', 'in'], ['output_tokens', 'out'], ['total_tokens', 'total']] as const)
    .flatMap(([key, label]) => {
      const value = usage[key];
      return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? [`${new Intl.NumberFormat("en-US").format(value)} ${label}`] : [];
    });
  return parts.length ? `${parts.join(" · ")} tokens` : null;
}

export function agentTotalLabel(usage?: UsageSnapshotRecord | null): string | null {
  const total = usage?.total_tokens;
  return typeof total === "number" && Number.isFinite(total) && total >= 0
    ? `${new Intl.NumberFormat("en-US").format(total)} tokens` : null;
}

/** Sum reported consumption once per agent. Missing fields make that aggregate partial. */
export function modelUsage(snapshot: DashboardSnapshot) {
  const groups = new Map<string, UsageSnapshotRecord[]>();
  for (const agent of snapshot.agents) {
    const usage = snapshot.computed_agents.find((item) => item.agent_id === agent.agent_id)?.latest_usage;
    if (!usage || !agentTokenLabel(usage)) continue;
    const model = usage.model || agent.model || (typeof agent.backend_handle?.resolved_model === "string" ? agent.backend_handle.resolved_model : "Unknown model");
    groups.set(model, [...(groups.get(model) ?? []), usage]);
  }
  const sum = (items: UsageSnapshotRecord[], key: "input_tokens" | "output_tokens" | "total_tokens" | "cached" | "uncached") => {
    const values = items.map((item) => {
      if (key !== "cached" && key !== "uncached") return item[key];
      const input = item.input_tokens, cached = item.cached_input_tokens;
      // Derive each worker before summing: missing cache counts must not look like uncached input.
      if (typeof input !== "number" || !Number.isFinite(input) || typeof cached !== "number" || !Number.isFinite(cached) || cached < 0 || cached > input) return null;
      return key === "cached" ? cached : input - cached;
    });
    const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
    return { value: known.length ? known.reduce((a, b) => a + b, 0) : null, partial: known.length < values.length };
  };
  const summarize = (items: UsageSnapshotRecord[]) => ({ input: sum(items, "input_tokens"), cached: sum(items, "cached"), uncached: sum(items, "uncached"), output: sum(items, "output_tokens"), total: sum(items, "total_tokens") });
  const all = [...groups.values()].flat();
  return { rows: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([model, items]) => ({ model, ...summarize(items) })), totals: summarize(all), reported: all.length };
}

/** Subdivisions are included in totals; the non-reasoning remainder can include tool calls. */
export function usageBreakdown(usage: UsageSnapshotRecord | null) {
  const rows: { label: string; value: number }[] = [];
  const add = (label: string, value: number | null | undefined) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) rows.push({ label, value });
  };
  add("Input", usage?.input_tokens);
  const input = usage?.input_tokens, cached = usage?.cached_input_tokens;
  if (typeof input === "number" && typeof cached === "number" && cached >= 0 && cached <= input) {
    add("Cached input", cached); add("Uncached input", input - cached);
  }
  const writes = usage?.cache_write_input_tokens;
  if (typeof input === "number" && typeof writes === "number" && writes <= input) add("Cache writes (within input)", writes);
  add("Output", usage?.output_tokens);
  const output = usage?.output_tokens, reasoning = usage?.reasoning_output_tokens;
  if (typeof output === "number" && typeof reasoning === "number" && reasoning >= 0 && reasoning <= output) {
    add("Reasoning", reasoning); add("Text and other output", output - reasoning);
  }
  add("Total", usage?.total_tokens);
  return rows;
}
