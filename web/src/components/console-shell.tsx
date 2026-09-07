"use client";

import { Bot, Clock3, Info, PanelBottom, Workflow, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useSnapshotStream } from "@/lib/api";
import { focusedAgentId } from "@/lib/graph";
import { latestAgentFlowStep } from "@/lib/flow-steps";
import { useConsoleSelection } from "./console-selection";
import type { DashboardSnapshot } from "@/lib/types";
import {
  AGENT_MESSAGE_LOAD_STEP,
  INITIAL_AGENT_MESSAGE_LIMIT,
  MAX_AGENT_MESSAGE_LIMIT
} from "@/lib/workspace-refresh-policy";
import { AgentGraph } from "./agent-graph";
import { AgentInspector } from "./agent-inspector";
import { FlowPhaseGraph, type FlowStepSelection } from "./flow-phase-graph";
import { RunInfoPanel } from "./run-info-panel";
import { RunSidebar } from "./run-sidebar";
import { Timeline } from "./timeline";
import { TopBar } from "./top-bar";
import { EmptyState, Panel } from "./ui";

type BottomPanel = "agent" | "run" | "timeline";
type GraphMode = "agents" | "flow";
type ResizeTarget = "bottom" | "runs" | "thread";

interface ConsoleLayoutState {
  bottomPanel: BottomPanel | null;
  bottomPanelHeight: number;
  runsOpen: boolean;
  runsPanelWidth: number;
  threadOpen: boolean;
  threadPanelWidth: number;
}

const CONSOLE_LAYOUT_STORAGE_KEY = "agent-control:console-layout:v1";
const NARROW_VIEWPORT_QUERY = "(max-width: 760px)";
const DEFAULT_LAYOUT: ConsoleLayoutState = {
  bottomPanel: null,
  bottomPanelHeight: 360,
  runsOpen: false,
  runsPanelWidth: 340,
  threadOpen: false,
  threadPanelWidth: 520
};

export function ConsoleShell({ onOpenConversation }: { onOpenConversation: () => void }) {
  const { setConnection, selectedRunId, setSelectedRunId, followLatestRun, selectedAgentId, setSelectedAgentId, selectRun } = useConsoleSelection();
  const [agentSelectionPinned, setAgentSelectionPinned] = useState(Boolean(selectedAgentId));
  const selectionRunRef = useRef<string | null | undefined>(undefined);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedStepInstanceId, setSelectedStepInstanceId] = useState<string | null>(null);
  const [selectedAgentMessageLimit, setSelectedAgentMessageLimit] = useState(INITIAL_AGENT_MESSAGE_LIMIT);
  const [graphMode, setGraphMode] = useState<GraphMode>("flow");
  const [layout, setLayout] = useState<ConsoleLayoutState>(DEFAULT_LAYOUT);
  const [layoutHydrated, setLayoutHydrated] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [renderedBottomPanel, setRenderedBottomPanel] = useState<BottomPanel>("agent");
  const [resizing, setResizing] = useState<ResizeTarget | null>(null);
  const latestStepByAgentRef = useRef<Map<string, string | null>>(new Map());
  const { bottomPanel, runsOpen } = layout;
  const threadOpen = false;
  const { agentLog, agentError, connection, error, isLoading, refresh, selectedRun, snapshot } = useSnapshotStream(
    selectedRunId,
    selectedAgentId,
    followLatestRun,
    selectedAgentMessageLimit
  );
  useEffect(() => { setConnection(agentError ? "offline" : connection); }, [agentError, connection, setConnection]);


  useEffect(() => {
    // A history expansion belongs to one agent/step selection. Resetting here
    // also advances the MCP refresh generation, so an older large-page result
    // cannot populate the newly selected thread.
    setSelectedAgentMessageLimit(INITIAL_AGENT_MESSAGE_LIMIT);
  }, [selectedAgentId, selectedStepInstanceId]);

  useEffect(() => {
    if (!followLatestRun || !snapshot?.selected_run_id || selectedRunId === snapshot.selected_run_id) {
      return;
    }
    setSelectedRunId(snapshot.selected_run_id);
    if (selectedRunId) setSelectedAgentId(null);
    setSelectedStepId(null);
    setSelectedStepInstanceId(null);
  }, [followLatestRun, selectedRunId, snapshot?.selected_run_id]);

  useEffect(() => {
    if (!snapshot || (!followLatestRun && selectedRunId && snapshot.selected_run_id !== selectedRunId)) return;
    if (selectionRunRef.current !== undefined && selectionRunRef.current !== snapshot.selected_run_id) {
      setAgentSelectionPinned(false);
    }
    selectionRunRef.current = snapshot.selected_run_id;
    const valid = snapshot.agents.some((agent) => agent.agent_id === selectedAgentId);
    if (!valid) setAgentSelectionPinned(false);
    if (!agentSelectionPinned || !valid) {
      const preferred = focusedAgentId(snapshot, null) ?? snapshot.agents[0]?.agent_id ?? null;
      if (preferred !== selectedAgentId) setSelectedAgentId(preferred);
    }
  }, [selectedAgentId, snapshot, followLatestRun, selectedRunId, agentSelectionPinned]);

  const selectedSnapshot = useMemo(() => snapshot, [snapshot]);
  const flowGraphAvailable = Boolean(selectedSnapshot?.flows.length && selectedSnapshot.flow_instances.length);
  const effectiveGraphMode = flowGraphAvailable ? graphMode : "agents";
  const latestSelectedAgentStepId = selectedSnapshot
    ? (latestAgentFlowStep(selectedSnapshot, selectedAgentId)?.step_instance_id ?? null)
    : null;

  useEffect(() => {
    if (!selectedSnapshot || !selectedAgentId) {
      setSelectedStepId(null);
      setSelectedStepInstanceId(null);
      return;
    }

    const latestStepId = latestAgentFlowStep(selectedSnapshot, selectedAgentId)?.step_instance_id ?? null;
    const previousLatestStepId = latestStepByAgentRef.current.get(selectedAgentId);
    const selectedStepBelongsToAgent = selectedSnapshot.flow_steps.some(
      (step) => step.step_instance_id === selectedStepInstanceId && step.agent_id === selectedAgentId
    );

    latestStepByAgentRef.current.set(selectedAgentId, latestStepId);

    if (!latestStepId) {
      setSelectedStepInstanceId(null);
      return;
    }
    if (!selectedStepBelongsToAgent || !selectedStepInstanceId || (previousLatestStepId && previousLatestStepId !== latestStepId)) {
      const latestStep = selectedSnapshot.flow_steps.find((step) => step.step_instance_id === latestStepId) ?? null;
      setSelectedStepId(latestStep?.step_id ?? null);
      setSelectedStepInstanceId(latestStepId);
    }
  }, [latestSelectedAgentStepId, selectedAgentId, selectedSnapshot, selectedStepInstanceId]);

  const selectAgent = useCallback(
    (agentId: string) => {
      setAgentSelectionPinned(true);
      const latestStep = selectedSnapshot ? latestAgentFlowStep(selectedSnapshot, agentId) : null;
      setSelectedAgentId(agentId);
      setSelectedStepId(latestStep?.step_id ?? null);
      setSelectedStepInstanceId(latestStep?.step_instance_id ?? null);
    },
    [selectedSnapshot]
  );

  const selectFlowStep = useCallback((selection: FlowStepSelection) => {
    setAgentSelectionPinned(true);
    const agentId = resolveFlowSelectionAgentId(selectedSnapshot, selection);
    if (agentId) {
      setSelectedAgentId(agentId);
    }
    setSelectedStepId(selection.stepId);
    setSelectedStepInstanceId(selection.stepInstanceId);
  }, [selectedSnapshot]);

  const selectStepInstance = useCallback((stepInstanceId: string | null) => {
    setAgentSelectionPinned(true);
    const step = selectedSnapshot?.flow_steps.find((candidate) => candidate.step_instance_id === stepInstanceId) ?? null;
    if (step?.agent_id) {
      setSelectedAgentId(step.agent_id);
    }
    setSelectedStepId(step?.step_id ?? null);
    setSelectedStepInstanceId(stepInstanceId);
  }, [selectedSnapshot]);

  const graphModeSwitch = selectedSnapshot ? (
    <GraphModeSwitch
      flowAvailable={flowGraphAvailable}
      mode={effectiveGraphMode}
      onChange={setGraphMode}
    />
  ) : null;
  const shellStyle = useMemo(
    () => {
      const sidePanelMaxWidth = narrowViewport ? "calc(100vw - 16px)" : "calc(100vw - 56px)";
      return {
        "--bottom-panel-height": `min(${layout.bottomPanelHeight}px, calc(100dvh - 96px))`,
        "--runs-panel-width": `min(${layout.runsPanelWidth}px, ${sidePanelMaxWidth})`,
        "--thread-panel-width": `min(${layout.threadPanelWidth}px, ${sidePanelMaxWidth})`
      } as CSSProperties;
    },
    [layout.bottomPanelHeight, layout.runsPanelWidth, layout.threadPanelWidth, narrowViewport]
  );

  useEffect(() => {
    setLayout(keepSingleOpenPanelOnNarrowViewport(readStoredConsoleLayout()));
    setLayoutHydrated(true);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const syncViewportMode = () => {
      const narrow = media.matches;
      setNarrowViewport(narrow);
      if (narrow) {
        setLayout((current) => keepSingleOpenPanel(current));
      }
    };

    syncViewportMode();
    media.addEventListener("change", syncViewportMode);
    return () => media.removeEventListener("change", syncViewportMode);
  }, []);

  useEffect(() => {
    if (!layoutHydrated) {
      return;
    }
    try {
      window.localStorage.setItem(CONSOLE_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Sandboxed MCP hosts can deny storage; layout still works in memory.
    }
  }, [layout, layoutHydrated]);

  useEffect(() => {
    if (bottomPanel) {
      setRenderedBottomPanel(bottomPanel);
    }
  }, [bottomPanel]);

  const patchLayout = (patch: Partial<ConsoleLayoutState>) => {
    setLayout((current) => ({ ...current, ...patch }));
  };

  const toggleRunsPanel = () => {
    setLayout((current) => {
      const runsOpen = !current.runsOpen;
      return narrowViewport ? { ...current, bottomPanel: null, runsOpen, threadOpen: false } : { ...current, runsOpen };
    });
  };

  const toggleBottomPanel = (panel: BottomPanel) => {
    setLayout((current) => {
      const bottomPanel = current.bottomPanel === panel ? null : panel;
      return narrowViewport ? { ...current, bottomPanel, runsOpen: false, threadOpen: false } : { ...current, bottomPanel };
    });
  };

  const showBottomPanel = (panel: BottomPanel) => {
    setLayout((current) =>
      narrowViewport ? { ...current, bottomPanel: panel, runsOpen: false, threadOpen: false } : { ...current, bottomPanel: panel }
    );
  };

  const startResize = (target: ResizeTarget) => (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLayout = layout;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    setResizing(target);
    document.body.style.cursor = target === "bottom" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";

    const handleMove = (moveEvent: PointerEvent) => {
      if (target === "runs") {
        const maxWidth = narrowViewport ? Math.max(260, viewportWidth - 16) : Math.max(280, viewportWidth - 220);
        const width = clampSize(startLayout.runsPanelWidth + (moveEvent.clientX - startX), 260, maxWidth);
        patchLayout({ runsPanelWidth: width });
      } else if (target === "thread") {
        const maxWidth = narrowViewport ? Math.max(320, viewportWidth - 16) : Math.max(340, viewportWidth - 220);
        const width = clampSize(startLayout.threadPanelWidth + (startX - moveEvent.clientX), 320, maxWidth);
        patchLayout({ threadPanelWidth: width });
      } else {
        const maxHeight = narrowViewport ? Math.max(260, viewportHeight - 96) : Math.max(260, viewportHeight - 120);
        const height = clampSize(startLayout.bottomPanelHeight + (startY - moveEvent.clientY), 240, maxHeight);
        patchLayout({ bottomPanelHeight: height });
      }
    };

    const handleUp = () => {
      setResizing(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  };

  return (
    <main
      className="console-shell relative h-screen overflow-hidden text-ink-900"
      data-bottom-panel={bottomPanel ?? "none"}
      data-resizing={resizing ?? "none"}
      data-runs-open={runsOpen ? "true" : "false"}
      data-thread-open={threadOpen ? "true" : "false"}
      style={shellStyle}
    >
      <div className="console-top">
        <TopBar
          connection={agentError ? "offline" : connection}
          inspectorOpen={bottomPanel === "agent"}
          onOpenAgent={() => toggleBottomPanel("agent")}
          onOpenRuns={toggleRunsPanel}
          onRefresh={refresh}
          run={selectedRun}
          runsOpen={runsOpen}
        />
      </div>

      <section className="console-graph">
        {error && !snapshot ? null : isLoading && !snapshot ? (
          <Panel className="h-full">
            <EmptyState detail="Connecting to Agent Control API and WebSocket." title="Loading controller state" />
          </Panel>
        ) : selectedSnapshot && (selectedSnapshot.agents.length > 0 || flowGraphAvailable) ? (
          <div className="graph-stack h-full min-h-0 min-w-0">
            {effectiveGraphMode === "flow" ? (
              <FlowPhaseGraph
                onSelectStep={selectFlowStep}
                selectedStepId={selectedStepId}
                selectedStepInstanceId={selectedStepInstanceId}
                snapshot={selectedSnapshot}
                toolbarLeading={graphModeSwitch}
              />
            ) : (
              <AgentGraph
                onSelectAgent={selectAgent}
                onOpenConversation={(agentId) => { selectAgent(agentId); onOpenConversation(); }}
                onClearSelection={() => setAgentSelectionPinned(false)}
                selectedAgentId={agentSelectionPinned ? selectedAgentId : null}
                snapshot={selectedSnapshot}
                toolbarLeading={graphModeSwitch}
              />
            )}
          </div>
        ) : (
          <div className="h-full">
            <EmptyState
              detail="Start a run with Agent Control, or use agentctl to register participants. The graph will appear as soon as agents exist."
              title="No agents in this run"
            />
          </div>
        )}
      </section>

      {selectedSnapshot ? (
        <aside
          aria-hidden={runsOpen ? undefined : true}
          aria-label="Runs"
          className="console-side-panel console-runs-panel"
          data-open={runsOpen ? "true" : "false"}
        >
          <ResizeHandle label="Resize runs panel" onPointerDown={startResize("runs")} orientation="vertical" />
          <PanelHeader detail={selectedRun?.title ?? "Agent Control"} onClose={() => patchLayout({ runsOpen: false })} title="Runs" />
          <div className="console-panel-body">
            <RunSidebar
              onSelectRun={(runId) => {
                selectRun(runId);
                setSelectedStepId(null);
                setSelectedStepInstanceId(null);
                patchLayout({ runsOpen: false });
              }}
              selectedRunId={selectedRunId ?? selectedSnapshot.selected_run_id ?? null}
              snapshot={selectedSnapshot}
            />
          </div>
        </aside>
      ) : null}

      {selectedSnapshot ? (
        <section
          aria-hidden={bottomPanel ? undefined : true}
          aria-label="Agent details, run info, and timeline"
          className="console-bottom-panel"
          data-open={bottomPanel ? "true" : "false"}
          data-panel={renderedBottomPanel}
        >
          <ResizeHandle label="Resize bottom panel" onPointerDown={startResize("bottom")} orientation="horizontal" />
          <div className="console-bottom-panel-header">
            <div className="console-bottom-tabs" role="tablist" aria-label="Bottom panel views">
              <button
                aria-selected={renderedBottomPanel === "agent"}
                className="console-bottom-tab"
                onClick={() => showBottomPanel("agent")}
                role="tab"
                type="button"
              >
                <PanelBottom className="size-4" />
                <span className="console-bottom-tab-label">Inspector</span>
              </button>
              <button
                aria-selected={renderedBottomPanel === "run"}
                className="console-bottom-tab"
                onClick={() => showBottomPanel("run")}
                role="tab"
                type="button"
              >
                <Info className="size-4" />
                <span className="console-bottom-tab-label">Run info</span>
              </button>
              <button
                aria-selected={renderedBottomPanel === "timeline"}
                className="console-bottom-tab"
                onClick={() => showBottomPanel("timeline")}
                role="tab"
                type="button"
              >
                <Clock3 className="size-4" />
                <span className="console-bottom-tab-label">Timeline</span>
              </button>
            </div>
            <button className="console-panel-close" onClick={() => patchLayout({ bottomPanel: null })} type="button" aria-label="Close bottom panel">
              <X className="size-4" />
            </button>
          </div>
          <div className="console-panel-body">
            {renderedBottomPanel === "agent" ? (
              <AgentInspector
                onSelectStepInstance={selectStepInstance}
                selectedAgentId={selectedAgentId}
                selectedStepInstanceId={selectedStepInstanceId}
                snapshot={selectedSnapshot}
              />
            ) : renderedBottomPanel === "run" ? (
              <RunInfoPanel run={selectedRun} selectedStepInstanceId={selectedStepInstanceId} snapshot={selectedSnapshot} />
            ) : (
              <Timeline selectedStepInstanceId={selectedStepInstanceId} snapshot={selectedSnapshot} />
            )}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function resolveFlowSelectionAgentId(
  snapshot: DashboardSnapshot | null | undefined,
  selection: FlowStepSelection
): string | null {
  if (selection.agentId) {
    return selection.agentId;
  }
  if (!snapshot) {
    return null;
  }

  const stepAgent =
    [...snapshot.flow_steps]
      .filter((step) => step.step_id === selection.stepId && step.agent_id)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0]?.agent_id ?? null;
  if (stepAgent) {
    return stepAgent;
  }

  if (!selection.role) {
    return null;
  }

  const roleAgents = snapshot.agents
    .filter((agent) => agent.role === selection.role)
    .sort((a, b) => agentSelectionWeight(b.status) - agentSelectionWeight(a.status) || Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return roleAgents[0]?.agent_id ?? null;
}

function agentSelectionWeight(status: string): number {
  if (status === "running") return 6;
  if (status === "waiting_for_input") return 5;
  if (status === "starting") return 4;
  if (status === "queued") return 3;
  if (status === "planned") return 2;
  if (status === "blocked" || status === "failed") return 1;
  return 0;
}

function GraphModeSwitch({
  flowAvailable,
  mode,
  onChange
}: {
  flowAvailable: boolean;
  mode: GraphMode;
  onChange: (mode: GraphMode) => void;
}) {
  return (
    <div className="agent-graph-action-group shrink-0" role="group" aria-label="Graph view">
      <GraphModeButton active={mode === "agents"} icon={Bot} label="Agents" onClick={() => onChange("agents")} />
      <GraphModeButton
        active={mode === "flow"}
        disabled={!flowAvailable}
        icon={Workflow}
        label="Flow"
        onClick={() => onChange("flow")}
      />
    </div>
  );
}

function GraphModeButton({
  active,
  disabled,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className="agent-graph-mode-button"
      data-active={active ? "true" : "false"}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon className="size-3.5" strokeWidth={1.9} />
      <span>{label}</span>
    </button>
  );
}

function ResizeHandle({
  label,
  onPointerDown,
  orientation
}: {
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  orientation: "horizontal" | "vertical";
}) {
  return (
    <div
      aria-label={label}
      aria-orientation={orientation}
      className="console-resize-handle"
      onPointerDown={onPointerDown}
      role="separator"
      tabIndex={0}
    />
  );
}

function PanelHeader({
  detail,
  onClose,
  title
}: {
  detail: string;
  onClose: () => void;
  title: string;
}) {
  return (
    <div className="console-panel-header">
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-500">{title}</div>
        <div className="truncate text-sm font-semibold text-ink-900">{detail}</div>
      </div>
      <button className="console-panel-close" onClick={onClose} type="button" aria-label={`Close ${title.toLowerCase()} panel`}>
        <X className="size-4" />
      </button>
    </div>
  );
}

function readStoredConsoleLayout(): ConsoleLayoutState {
  if (typeof window === "undefined") {
    return DEFAULT_LAYOUT;
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CONSOLE_LAYOUT_STORAGE_KEY) ?? "{}") as Partial<ConsoleLayoutState>;
    return {
      bottomPanel: parsed.bottomPanel === "agent" || parsed.bottomPanel === "run" || parsed.bottomPanel === "timeline" ? parsed.bottomPanel : null,
      bottomPanelHeight: boundedNumber(parsed.bottomPanelHeight, DEFAULT_LAYOUT.bottomPanelHeight, 240, 900),
      runsOpen: typeof parsed.runsOpen === "boolean" ? parsed.runsOpen : DEFAULT_LAYOUT.runsOpen,
      runsPanelWidth: boundedNumber(parsed.runsPanelWidth, DEFAULT_LAYOUT.runsPanelWidth, 260, 900),
      threadOpen: false,
      threadPanelWidth: boundedNumber(parsed.threadPanelWidth, DEFAULT_LAYOUT.threadPanelWidth, 320, 1000)
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function keepSingleOpenPanelOnNarrowViewport(layout: ConsoleLayoutState): ConsoleLayoutState {
  return typeof window !== "undefined" && window.matchMedia(NARROW_VIEWPORT_QUERY).matches ? keepSingleOpenPanel(layout) : layout;
}

function keepSingleOpenPanel(layout: ConsoleLayoutState): ConsoleLayoutState {
  if (layout.bottomPanel) {
    return { ...layout, runsOpen: false, threadOpen: false };
  }
  if (layout.threadOpen) {
    return { ...layout, runsOpen: false };
  }
  if (layout.runsOpen) {
    return { ...layout, threadOpen: false };
  }
  return layout;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clampSize(value, min, max) : fallback;
}

function clampSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
