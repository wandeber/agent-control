"use client";

import { Activity, Bell, Boxes, FileText, GitBranch, Goal, Link2, Server, TimerReset } from "lucide-react";
import { compactId, formatDateTime, formatDuration, formatNumber, safeJson } from "@/lib/format";
import { agentFlowSteps, flowStepOptionLabel, flowStepOrdinal } from "@/lib/flow-steps";
import { isRenderableRelationType } from "@/lib/graph";
import type { AgentRecord, DashboardSnapshot, FlowStepInstanceRecord } from "@/lib/types";
import { EmptyState, Metric, StatusPill } from "./ui";

export function AgentInspector({
  onSelectStepInstance,
  snapshot,
  selectedAgentId,
  selectedStepInstanceId
}: {
  onSelectStepInstance: (stepInstanceId: string | null) => void;
  snapshot: DashboardSnapshot;
  selectedAgentId: string | null;
  selectedStepInstanceId: string | null;
}) {
  const agent = snapshot.agents.find((candidate) => candidate.agent_id === selectedAgentId) ?? snapshot.agents[0] ?? null;
  if (!agent) {
    return (
      <div className="h-full bg-white">
        <EmptyState detail="Select a run with registered agents to inspect their state." title="No agent selected" />
      </div>
    );
  }

  const computed = snapshot.computed_agents.find((item) => item.agent_id === agent.agent_id);
  const goals = snapshot.goals.filter((goal) => goal.agent_id === agent.agent_id);
  const heartbeats = snapshot.heartbeats.filter((heartbeat) => heartbeat.agent_id === agent.agent_id);
  const subscriptions = snapshot.subscriptions.filter(
    (subscription) => subscription.source_agent_id === agent.agent_id || subscription.subscriber_agent_id === agent.agent_id
  );
  const artifacts = snapshot.artifacts.filter((artifact) => artifact.agent_id === agent.agent_id);
  const links = snapshot.agent_links.filter(
    (link) =>
      isRenderableRelationType(link.type) &&
      (link.source_agent_id === agent.agent_id || link.target_agent_id === agent.agent_id)
  );
  const flowSteps = agentFlowSteps(snapshot, agent.agent_id);
  const selectedStep =
    flowSteps.find((step) => step.step_instance_id === selectedStepInstanceId) ?? flowSteps[0] ?? null;
  const startedRuns = snapshot.runs.filter((run) => run.created_by_agent_id === agent.agent_id);
  const latestEvents = snapshot.latest_events.filter((event) => event.agent_id === agent.agent_id).slice(0, 5);
  const usage = computed?.latest_usage;

  return (
    <section className="agent-scroll h-full overflow-auto bg-white">
      <div className="flex flex-col gap-3 p-4">
        <div className="pb-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-ink-900">{agent.title}</h2>
              <p className="mt-1 truncate text-xs text-ink-400">
                {compactId(agent.agent_id)} · {agent.role ?? "worker"} · {agent.backend}
              </p>
            </div>
            <StatusPill status={agent.status} />
          </div>
          {agent.objective ? <p className="mt-3 line-clamp-5 text-xs leading-5 text-ink-600">{agent.objective}</p> : null}
        </div>

        <InstanceSelector
          onSelectStepInstance={onSelectStepInstance}
          selectedStep={selectedStep}
          snapshot={snapshot}
          steps={flowSteps}
        />

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-black/8 pt-3">
          <Metric label="elapsed" value={formatDuration(computed?.elapsed_ms)} />
          <Metric label="status age" value={formatDuration(computed?.status_age_ms)} />
          <Metric label="model" value={agent.model ?? "unknown"} />
          <Metric label="updated" value={formatDateTime(agent.updated_at)} />
        </div>

        <UsagePanel
          contextLimit={usage?.context_limit}
          contextUsed={usage?.context_used}
          input={usage?.input_tokens}
          output={usage?.output_tokens}
          total={usage?.total_tokens}
        />

        <InfoBlock icon={Goal} title="Goals">
          {goals.length === 0 ? (
            <MutedLine>No goal registered for this agent.</MutedLine>
          ) : (
            goals.map((goal) => (
              <div className="border-l-2 border-teal-300 pl-2" key={goal.goal_id}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ink-800">{goal.status}</span>
                  <span className="text-[10px] text-ink-300">{formatDuration(Date.now() - Date.parse(goal.created_at))}</span>
                </div>
                <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-ink-500">{goal.objective}</p>
              </div>
            ))
          )}
        </InfoBlock>

        <InfoBlock icon={Bell} title="Heartbeats">
          {heartbeats.length === 0 ? (
            <MutedLine>No heartbeat configured.</MutedLine>
          ) : (
            heartbeats.map((heartbeat) => (
              <div className="border-l-2 border-amber-300 pl-2" key={heartbeat.heartbeat_id}>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-semibold text-ink-700">{formatDuration(heartbeat.idle_timeout_ms)}</span>
                  <span className="text-ink-400">last {formatDateTime(heartbeat.last_event_at)}</span>
                </div>
              </div>
            ))
          )}
        </InfoBlock>

        <InfoBlock icon={Link2} title="Relationships">
          <ListLines
            empty="No explicit relationships."
            lines={[
              ...links.map((link) => `${link.type}: ${compactId(link.source_agent_id)} -> ${compactId(link.target_agent_id)}`),
              ...subscriptions.map((subscription) => `${subscription.event_type}: ${compactId(subscription.source_agent_id ?? "run")} -> ${compactId(subscription.subscriber_agent_id)}`)
            ]}
          />
        </InfoBlock>

        <InfoBlock icon={GitBranch} title="Started Runs">
          <ListLines
            empty="No child runs started by this agent."
            lines={startedRuns.map((run) => `${run.title} · ${run.status} · ${compactId(run.run_id)}`)}
          />
        </InfoBlock>

        <InfoBlock icon={FileText} title="Artifacts">
          <ListLines empty="No artifacts registered." lines={artifacts.map((artifact) => `${artifact.expected ? "expected" : "actual"} · ${artifact.label} · ${artifact.path}`)} />
        </InfoBlock>

        <InfoBlock icon={Activity} title="Latest Events">
          {latestEvents.length === 0 ? (
            <MutedLine>No recent events.</MutedLine>
          ) : (
            latestEvents.map((event) => (
              <details className="border-l-2 border-black/10 pl-2" key={event.event_id}>
                <summary className="cursor-pointer text-[11px] font-semibold text-ink-700">
                  {event.type} · {formatDateTime(event.created_at)}
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-ink-900 p-2 text-[10px] text-white">{safeJson(event.payload)}</pre>
              </details>
            ))
          )}
        </InfoBlock>

        <InfoBlock icon={Server} title="Backend Handle">
          <pre className="max-h-56 overflow-auto rounded-md bg-ink-900 p-2 text-[10px] leading-4 text-white">
            {safeJson(redactHandle(agent))}
          </pre>
        </InfoBlock>
      </div>
    </section>
  );
}

function InstanceSelector({
  onSelectStepInstance,
  selectedStep,
  snapshot,
  steps
}: {
  onSelectStepInstance: (stepInstanceId: string | null) => void;
  selectedStep: FlowStepInstanceRecord | null;
  snapshot: DashboardSnapshot;
  steps: FlowStepInstanceRecord[];
}) {
  if (steps.length === 0) {
    return (
      <div className="border-t border-black/8 pt-3">
        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-300">Instance</div>
        <div className="mt-1 text-xs text-ink-500">No flow step instance is associated with this agent yet.</div>
      </div>
    );
  }

  return (
    <div className="border-t border-black/8 pt-3">
      <label className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-300" htmlFor="agent-instance-select">
        Instance
      </label>
      <select
        className="mt-1 h-8 w-full rounded-md border border-black/10 bg-white px-2 text-xs font-medium text-ink-800 outline-none transition focus:border-teal-300"
        id="agent-instance-select"
        onChange={(event) => onSelectStepInstance(event.target.value || null)}
        value={selectedStep?.step_instance_id ?? ""}
      >
        {steps.map((step, index) => (
          <option key={step.step_instance_id} value={step.step_instance_id}>
            {flowStepOptionLabel(step, index)}
          </option>
        ))}
      </select>
      {selectedStep ? (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-black/8 bg-canvas-50 px-3 py-2">
          <Metric label="instance" value={`#${flowStepOrdinal(snapshot, selectedStep)}`} />
          <Metric label="step" value={selectedStep.step_id} />
          <Metric label="status" value={selectedStep.status} />
          <Metric label="created" value={formatDateTime(selectedStep.created_at)} />
          <Metric label="updated" value={formatDateTime(selectedStep.updated_at)} />
          <Metric label="completed" value={selectedStep.completed_at ? formatDateTime(selectedStep.completed_at) : "not yet"} />
          {selectedStep.summary ? (
            <div className="col-span-2 min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-300">Summary</div>
              <div className="line-clamp-3 text-xs leading-5 text-ink-600">{selectedStep.summary}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function UsagePanel({
  contextLimit,
  contextUsed,
  input,
  output,
  total
}: {
  contextLimit?: number | null;
  contextUsed?: number | null;
  input?: number | null;
  output?: number | null;
  total?: number | null;
}) {
  const contextPercent = contextLimit && contextUsed ? Math.min(100, Math.round((contextUsed / contextLimit) * 100)) : 0;
  return (
    <div className="border-t border-black/8 pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-ink-800">
          <TimerReset className="size-3.5 text-ink-400" />
          Usage
        </div>
        <span className="text-[11px] text-ink-400">{formatNumber(total)} tokens</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <span>in {formatNumber(input)}</span>
        <span>out {formatNumber(output)}</span>
        <span>ctx {contextPercent || "?"}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/6">
        <div className="h-full rounded-full bg-teal-500" style={{ width: `${contextPercent}%` }} />
      </div>
    </div>
  );
}

function InfoBlock({
  children,
  icon: Icon,
  title
}: {
  children: React.ReactNode;
  icon: typeof Boxes;
  title: string;
}) {
  return (
    <div className="border-t border-black/8 pt-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-ink-800">
        <Icon className="size-3.5 text-ink-400" />
        {title}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function ListLines({ empty, lines }: { empty: string; lines: string[] }) {
  if (lines.length === 0) {
    return <MutedLine>{empty}</MutedLine>;
  }
  return lines.map((line) => (
    <div className="truncate border-l-2 border-black/10 pl-2 text-[11px] leading-5 text-ink-600" key={line}>
      {line}
    </div>
  ));
}

function MutedLine({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] leading-5 text-ink-400">{children}</div>;
}

function redactHandle(agent: AgentRecord): Record<string, unknown> | null {
  if (!agent.backend_handle) {
    return null;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(agent.backend_handle)) {
    result[key] = /token|secret|key|auth/i.test(key) ? "redacted" : value;
  }
  return result;
}
