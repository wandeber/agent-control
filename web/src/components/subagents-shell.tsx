"use client";

import { agentModelLabel, agentTokenLabel } from "@/lib/agent-presentation";
import { AgentCostLabel } from "./agent-cost-label";
import { AgentAccess } from "./agent-access";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSnapshotStream } from "@/lib/api";
import { useConsoleSelection } from "./console-selection";
import type { AgentRecord, AgentStatus, DashboardSnapshot } from "@/lib/types";
import {
  AGENT_MESSAGE_LOAD_STEP,
  INITIAL_AGENT_MESSAGE_LIMIT,
  MAX_AGENT_MESSAGE_LIMIT
} from "@/lib/workspace-refresh-policy";
import { EmptyState, StatusDot, StatusPill } from "./ui";
import { WorkspacePanel } from "./workspace-panel";

/** Worker list and conversation, shown as the default Agent Control screen. */
export function SubagentsShell() {
  const { registerRefresh, setConnection, selectedRunId, selectedRunIds, followLatestRun, selectedAgentId, setSelectedAgentId } = useConsoleSelection();
  const [messageLimit, setMessageLimit] = useState(INITIAL_AGENT_MESSAGE_LIMIT);
  const [narrowViewport, setNarrowViewport] = useState<boolean | null>(null);
  const { agentLog, agentError, connection, error, isLoading, refresh, snapshot, runSnapshots } = useSnapshotStream(
    selectedRunId,
    selectedAgentId,
    followLatestRun,
    messageLimit,
    selectedRunIds
  );
  useEffect(() => registerRefresh(refresh), [registerRefresh, refresh]);
  useEffect(() => { setConnection(agentError ? "offline" : connection); }, [agentError, connection, setConnection]);


  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const syncViewport = () => setNarrowViewport(media.matches);
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    setMessageLimit(INITIAL_AGENT_MESSAGE_LIMIT);
  }, [selectedAgentId]);

  const subagents = useMemo(
    () =>
      [...(snapshot?.agents ?? [])]
        .sort(compareAgents),
    [snapshot?.agents]
  );
  const activeSubagents = useMemo(() => subagents.filter((agent) => !isTerminalStatus(agent.status)), [subagents]);
  const finishedSubagents = useMemo(() => subagents.filter((agent) => isTerminalStatus(agent.status)), [subagents]);
  const selectedAgent = selectedAgentId
    ? snapshot?.agents.find((agent) => agent.agent_id === selectedAgentId) ?? null
    : null;

  const agentSnapshot = runSnapshots.find(value => value.agents.some(agent => agent.agent_id === selectedAgentId)) ?? snapshot;

  useEffect(() => {
    if (!snapshot || (!followLatestRun && selectedRunId && snapshot.selected_run_id !== selectedRunId)) return;
    if (narrowViewport === false && !selectedAgentId && subagents[0]) {
      setSelectedAgentId(subagents[0].agent_id);
      return;
    }
    if (selectedAgentId && !snapshot.agents.some((agent) => agent.agent_id === selectedAgentId)) {
      setSelectedAgentId(subagents[0]?.agent_id ?? null);
    }
  }, [narrowViewport, selectedAgentId, subagents, snapshot, followLatestRun, selectedRunId]);

  if (error && !snapshot) {
    return <main className="subagents-shell"><span role="status" className="p-3 text-xs text-ink-400">Offline</span></main>;
  }

  if (isLoading && !snapshot) {
    return (
      <main className="subagents-shell">
        <EmptyState detail="Connecting to Agent Control." title="Loading subagents" />
      </main>
    );
  }

  if (!snapshot || subagents.length === 0) {
    return (
      <main className="subagents-shell">
        <EmptyState detail="The selected run has no registered worker agents yet." title="No subagents" />
      </main>
    );
  }

  return (
    <main className="subagents-shell" data-agent-selected={selectedAgent ? "true" : "false"}>
      <div className="subagents-layout">
        <aside className="subagents-list" data-mobile-hidden={selectedAgent ? "true" : "false"}>
          <div className="subagents-list-scroll">
            {runSnapshots.length > 1 ? runSnapshots.map(value => <AgentGroup key={value.selected_run_id}
              snapshot={value} agents={[...value.agents].sort(compareAgents)} onSelect={setSelectedAgentId} selectedAgentId={selectedAgentId}
              title={value.runs.find(run => run.run_id === value.selected_run_id)?.title ?? "Run"} />) : <>
            {activeSubagents.length > 0 ? (
              <AgentGroup snapshot={snapshot} agents={activeSubagents} onSelect={setSelectedAgentId} selectedAgentId={selectedAgentId} title="Active" />
            ) : null}
            {finishedSubagents.length > 0 ? (
              <AgentGroup snapshot={snapshot} agents={finishedSubagents} onSelect={setSelectedAgentId} selectedAgentId={selectedAgentId} title="Finished" />
            ) : null}
            </>}
          </div>
        </aside>

        <section className="subagents-chat" data-mobile-visible={selectedAgent ? "true" : "false"}>
          {selectedAgent ? (
            <>
              <header className="subagents-chat-heading">
                <button aria-label="Back to subagents" className="subagents-back" onClick={() => setSelectedAgentId(null)} type="button">
                  <ArrowLeft className="size-4" />
                </button>
                <div className="min-w-0">
                  <h2>{selectedAgent.title}</h2>
                  <p className="flex flex-wrap items-baseline gap-x-3"><span>{agentModelLabel(selectedAgent)}</span><span>{agentTokenLabel(snapshot.computed_agents.find((item) => item.agent_id === selectedAgent.agent_id)?.latest_usage)}</span><AgentCostLabel snapshot={agentSnapshot ?? snapshot} agentId={selectedAgent.agent_id} /></p>
                </div>
                <AgentAccess key={selectedAgent.agent_id} snapshot={agentSnapshot?.agent_access?.find(item => item.agent_id === selectedAgent.agent_id)} />
                <StatusPill status={selectedAgent.status} />
              </header>
              <div className="subagents-chat-body">
                <WorkspacePanel
                  compact
                  liveLog={agentLog}
                  connectionError={agentError}
                  messageLimit={messageLimit}
                  onRequestOlderMessages={() => setMessageLimit((value) => Math.min(MAX_AGENT_MESSAGE_LIMIT, value + AGENT_MESSAGE_LOAD_STEP))}
                  selectedAgentId={selectedAgent.agent_id}
                  selectedStepInstanceId={null}
                  snapshot={agentSnapshot ?? snapshot}
                />
              </div>
            </>
          ) : (
            <EmptyState detail="Select a subagent to read its conversation." title="Choose a subagent" />
          )}
        </section>
      </div>
    </main>
  );
}

function AgentGroup({
  snapshot,
  agents,
  onSelect,
  selectedAgentId,
  title
}: {
  snapshot: DashboardSnapshot;
  agents: AgentRecord[];
  onSelect: (agentId: string) => void;
  selectedAgentId: string | null;
  title: string;
}) {
  return (
    <section className="subagents-group" aria-label={title}>
      <h2>{title}</h2>
      {agents.length === 0 ? <p className="px-3 py-2 text-xs text-ink-400">No subagents yet</p> : null}
      <div className="subagents-group-items">
        {agents.map((agent) => (
          <button
            aria-current={agent.agent_id === selectedAgentId ? "true" : undefined}
            className="subagent-list-item"
            data-selected={agent.agent_id === selectedAgentId ? "true" : "false"}
            key={agent.agent_id}
            onClick={() => onSelect(agent.agent_id)}
            type="button"
          >
            <StatusDot status={agent.status} />
            <span className="subagent-list-copy">
              <span className="subagent-list-title">{agent.title}</span>
              <span className="subagent-list-detail flex flex-wrap items-baseline gap-x-2"><span>{agentModelLabel(agent)}</span><AgentCostLabel snapshot={snapshot} agentId={agent.agent_id} /></span>
            </span>
            <StatusPill compact status={agent.status} />
          </button>
        ))}
      </div>
    </section>
  );
}

function compareAgents(left: AgentRecord, right: AgentRecord): number {
  return agentStatusPriority(left.status) - agentStatusPriority(right.status) || Date.parse(right.updated_at) - Date.parse(left.updated_at);
}

function agentStatusPriority(status: AgentStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "waiting_for_input":
      return 1;
    case "starting":
      return 2;
    case "queued":
      return 3;
    case "planned":
      return 4;
    case "stopping":
      return 5;
    case "completed":
      return 6;
    case "failed":
      return 7;
    case "blocked":
      return 8;
    case "stopped":
      return 9;
    default:
      return 10;
  }
}

function isTerminalStatus(status: AgentStatus): boolean {
  return status === "completed" || status === "failed" || status === "blocked" || status === "stopped";
}
