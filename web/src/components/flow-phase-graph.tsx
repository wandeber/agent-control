"use client";

import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, ViewportPortal,
  applyNodeChanges, type Edge, type Node, type NodeChange, type NodeProps, type ReactFlowInstance
} from "@xyflow/react";
import { ArrowRight, CheckCircle2, Crosshair, GitBranch, LayoutGrid, LocateFixed, Radio, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildFlowVisualModel, type FlowVisualNode } from "@/lib/flow-graph";
import { buildFlowEvidenceView } from "@/lib/flow-evidence";
import {
  diagramPath, flowDiagramEdges, flowDiagramPositions, routeFlowDiagram, visibleFlowDiagramEdges,
  PHASE_HEIGHT, PHASE_WIDTH, type DiagramRoute, type Point
} from "@/lib/flow-diagram";
import { cx } from "@/lib/format";
import type { DashboardSnapshot } from "@/lib/types";
import { FlowEvidenceDetails } from "./flow-evidence";

const nodeTypes = { phase: FlowPhaseNode };
type PhaseNodeData = FlowVisualNode & Record<string, unknown> & {
  onSelectStep?: () => void;
  selected: boolean;
  ordinal: number | null;
  alternativeCount: number;
  graphKey: string;
};
type PhaseFlowNode = Node<PhaseNodeData, "phase">;

export interface FlowStepSelection {
  agentId: string | null;
  role: string | null;
  stepId: string;
  stepInstanceId: string | null;
}

export function FlowPhaseGraph({ onSelectStep, selectedStepId, selectedStepInstanceId, snapshot, toolbarLeading }: {
  onSelectStep: (selection: FlowStepSelection) => void;
  selectedStepId: string | null;
  selectedStepInstanceId: string | null;
  snapshot: DashboardSnapshot;
  toolbarLeading?: React.ReactNode;
}) {
  const model = useMemo(() => buildFlowVisualModel(snapshot), [snapshot]);
  const diagramEdges = useMemo(() => flowDiagramEdges(model?.nodes ?? [], model?.edges ?? []), [model]);
  const [nodes, setNodes] = useState<PhaseFlowNode[]>([]);
  const [columns, setColumns] = useState(1);
  const [follow, setFollow] = useState(false);
  const [allRoutes, setAllRoutes] = useState(false);
  const [focusedStepId, setFocusedStepId] = useState<string | null>(null);
  const [phaseDetailsOpen, setPhaseDetailsOpen] = useState(false);
  const [flowReady, setFlowReady] = useState(false);
  const flowRef = useRef<ReactFlowInstance<PhaseFlowNode, Edge> | null>(null);
  const graphRootRef = useRef<HTMLDivElement | null>(null);
  const graphKeyRef = useRef<string | null>(null);
  const fittedKeyRef = useRef<string | null>(null);
  const programmaticViewportRef = useRef(false);
  const storageKey = `agent-control:phase-graph:v8:${columns}:${snapshot.selected_run_id ?? "none"}:${model?.instance.flow_instance_id ?? "none"}`;
  const focusedPhase = focusedStepId ?? selectedStepId ?? model?.instance.current_step_id;
  const evidence = useMemo(() => model ? buildFlowEvidenceView(snapshot, {
    flowInstanceId: model.instance.flow_instance_id,
    stepId: focusedPhase
  }) : null, [focusedPhase, model, snapshot]);

  useEffect(() => {
    const root = graphRootRef.current;
    if (!root) return;
    const resize = () => setColumns(root.clientWidth >= 960 ? 3 : 1);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!model) { setNodes([]); return; }
    const stored = readStoredPositions(storageKey);
    const defaults = flowDiagramPositions(model.nodes, columns);
    const sameGraph = graphKeyRef.current === storageKey;
    graphKeyRef.current = storageKey;
    const ordinals = new Map(model.nodes.filter((node) => node.kind === "step").map((node, index) => [node.id, index + 1]));
    setNodes((current) => model.nodes.map((node) => {
      const previous = sameGraph ? current.find((item) => item.id === node.id) : undefined;
      return {
        id: node.id,
        type: "phase",
        position: previous?.position ?? stored.get(node.id) ?? defaults.get(node.id) ?? node.position,
        measured: previous?.measured,
        data: {
          ...node,
          ordinal: ordinals.get(node.id) ?? null,
          graphKey: storageKey,
          alternativeCount: diagramEdges.filter((edge) => edge.source === node.id && edge.alternative).length,
          onSelectStep: node.stepId ? () => { fittedKeyRef.current = null; setFocusedStepId(node.stepId); onSelectStep({
            agentId: node.latestStep?.agent_id ?? null,
            role: node.role,
            stepId: node.stepId!,
            stepInstanceId: node.latestStep?.step_instance_id ?? null
          }); } : undefined,
          selected: focusedStepId ? node.stepId === focusedStepId : Boolean((node.latestStep && node.latestStep.step_instance_id === selectedStepInstanceId) ||
            (!selectedStepInstanceId && node.stepId && node.stepId === selectedStepId))
        }
      };
    }));
  }, [columns, diagramEdges, focusedStepId, model, onSelectStep, selectedStepId, selectedStepInstanceId, storageKey]);

  useEffect(() => { setFollow(false); setAllRoutes(false); setFocusedStepId(null); }, [storageKey]);
  const activeNodeId = nodes.find((node) => node.data.isCurrent)?.id ?? null;
  const focusedNodeId = nodes.find((node) => node.data.selected)?.id ?? activeNodeId;
  const visibleEdges = useMemo(() => visibleFlowDiagramEdges(diagramEdges, focusedNodeId, allRoutes), [diagramEdges, focusedNodeId, allRoutes]);
  const routes = useMemo(() => routeFlowDiagram(visibleEdges, nodes.map((node) => ({
    id: node.id, kind: node.data.kind, position: node.position, width: node.measured?.width ?? PHASE_WIDTH, height: node.measured?.height ?? PHASE_HEIGHT
  }))), [nodes, visibleEdges]);
  const hiddenCount = diagramEdges.length - visibleEdges.length;

  const fitGraph = useCallback((focusActive = false) => {
    const flow = flowRef.current;
    const root = graphRootRef.current;
    if (!flow || !root || flow.getNodes().length === 0) return;
    const currentNodes = flow.getNodes();
    const active = focusActive ? currentNodes.find((node) => node.data.isCurrent) : null;
    const safe = getFlowSafeArea(root);
    const bounds = flow.getNodesBounds(active ? [active] : currentNodes);
    // Include return lanes and labels when fitting the expanded graph.
    const points = active ? [] : routes.flatMap((route) => [...route.points, { x: route.labelPoint.x - 82, y: route.labelPoint.y - 24 }, { x: route.labelPoint.x + 82, y: route.labelPoint.y + 24 }]);
    const left = Math.min(bounds.x, ...points.map((point) => point.x));
    const right = Math.max(bounds.x + bounds.width, ...points.map((point) => point.x));
    const top = Math.min(bounds.y, ...points.map((point) => point.y));
    const bottom = Math.max(bounds.y + bounds.height, ...points.map((point) => point.y));
    const zoom = Math.max(0.25, Math.min(active ? 1.1 : 1, (safe.width - 32) / (right - left + 48), (safe.height - 32) / (bottom - top + 32)));
    programmaticViewportRef.current = true;
    void flow.setViewport({ x: safe.x + safe.width / 2 - (left + right) / 2 * zoom, y: safe.y + safe.height / 2 - (top + bottom) / 2 * zoom, zoom }, { duration: 300 }).finally(() => { programmaticViewportRef.current = false; });
  }, [routes]);

  useEffect(() => {
    if (!flowReady || nodes.length === 0 || nodes.some((node) => !node.measured?.width || node.data.graphKey !== storageKey) || fittedKeyRef.current === storageKey) return;
    fittedKeyRef.current = storageKey;
    fitGraph();
  }, [fitGraph, flowReady, nodes, storageKey]);

  useEffect(() => {
    if (follow && flowReady) fitGraph(true);
  }, [activeNodeId, fitGraph, flowReady, follow]);

  const onNodesChange = useCallback((changes: NodeChange<PhaseFlowNode>[]) => {
    setNodes((current) => {
      const next = applyNodeChanges(changes, current);
      if (changes.some((change) => change.type === "position")) storePositions(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const organizeGraph = () => {
    if (!model) return;
    const positions = flowDiagramPositions(model.nodes, columns);
    setFollow(false);
    setNodes((current) => {
      const next = current.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
      storePositions(storageKey, next);
      return next;
    });
    fittedKeyRef.current = null;
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden" ref={graphRootRef}>
      <div className="agent-graph-toolbar absolute z-20 flex max-w-[calc(100%-112px)] flex-wrap items-center gap-2">
        {toolbarLeading}
        {model ? <>
          <div className="hidden min-w-0 items-center gap-2 rounded-lg border border-black/10 bg-white/95 px-3 py-2 text-xs shadow-panel sm:flex">
            <Workflow className="size-4 shrink-0 text-teal-700" />
            <div className="min-w-0">
              <div className="truncate font-semibold text-ink-800">{model.flow.flow_id}</div>
              <div className="text-[11px] text-ink-500">{model.instance.status.replaceAll("_", " ")}</div>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm">
            <input checked={allRoutes} className="accent-teal-700" onChange={(event) => { fittedKeyRef.current = null; setAllRoutes(event.target.checked); setFollow(false); }} type="checkbox" />
            All routes
          </label>
          <button aria-expanded={phaseDetailsOpen} aria-controls="flow-phase-evidence" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm" onClick={() => setPhaseDetailsOpen((value) => !value)} type="button">Phase details</button>
          <div className="w-full text-[11px] text-slate-600">{hiddenCount > 0 ? `Select a phase to see its other routes · ${hiddenCount} hidden` : "All routes shown"}</div>
        </> : null}
      </div>
      {phaseDetailsOpen && evidence ? <div className="absolute left-4 top-36 z-30 w-80 max-w-[calc(100%-32px)] shadow-panel" id="flow-phase-evidence"><FlowEvidenceDetails expanded view={evidence} /></div> : null}

      {model ? <>
        <div className="agent-graph-actions absolute z-20">
          <div className="agent-graph-action-group" role="group" aria-label="Flow graph viewport controls">
            <GraphActionButton active={follow} icon={LocateFixed} label={follow ? "Disable follow active phase" : "Follow active phase"} onClick={() => setFollow((value) => !value)} switchControl />
            <GraphActionButton icon={Crosshair} label="Fit flow" onClick={() => { setFollow(false); fitGraph(); }} />
            <GraphActionButton icon={LayoutGrid} label="Organize flow" onClick={organizeGraph} />
          </div>
        </div>
        <div className="absolute inset-0">
          <ReactFlow<PhaseFlowNode, Edge>
            edges={[]} nodes={nodes} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
            onInit={(instance) => { flowRef.current = instance; setFlowReady(true); }}
            onMoveStart={() => { if (!programmaticViewportRef.current) setFollow(false); }}
            onNodeDragStart={() => setFollow(false)}
            minZoom={0.25} maxZoom={1.75} elevateNodesOnSelect={false} onlyRenderVisibleElements={false}
            panOnDrag proOptions={{ hideAttribution: true }}
          >
            <PhaseEdgeOverlay routes={routes} />
            <Background gap={22} size={1} />
            <Controls onFitView={() => { setFollow(false); fitGraph(); }} position="bottom-left" showInteractive={false} />
            <MiniMap maskColor="rgba(238,242,246,0.68)" nodeBorderRadius={8} nodeColor={(node) => (node.data as PhaseNodeData).isCurrent ? "#0f766e" : "#cbd5e1"} position="bottom-right" pannable style={{ height: 64, width: 100 }} zoomable />
          </ReactFlow>
        </div>
        <div className="flow-legend absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 flex-wrap justify-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-[11px] text-slate-600 shadow-sm" aria-label="Flow arrow legend">
          <span className="inline-flex items-center gap-2"><ArrowRight className="size-4 text-slate-500" /> Possible route</span>
          <span className="inline-flex items-center gap-2"><ArrowRight className="size-4 text-teal-700" strokeWidth={3} /> Taken · latest attempt</span>
        </div>
      </> : <div className="flex h-full items-center justify-center px-6 text-center"><div className="rounded-lg border border-dashed border-black/15 bg-white/65 px-5 py-4"><div className="text-sm font-semibold text-ink-900">No declarative flow in this run</div><div className="mt-1 text-xs text-ink-500">Agent relationships are still available in the Agents view.</div></div></div>}
    </div>
  );
}

function FlowPhaseNode({ data }: NodeProps<PhaseFlowNode>) {
  const completed = data.status === "completed";
  const failed = ["failed", "blocked", "cancelled"].includes(data.status);
  const Icon = data.kind === "finish" ? CheckCircle2 : data.kind === "notify" ? Radio : Workflow;
  const result = typeof data.latestStep?.result_json?.conclusion === "string" ? data.latestStep.result_json.conclusion.replaceAll("_", " ") : null;
  const status = data.kind === "notify" ? (data.isCurrent ? "Waiting here" : "Chooses next phase")
    : data.kind === "finish" ? (completed ? "Completed" : "Not reached")
    : data.waitingLabel ?? (data.isCurrent ? `Current${failed ? ` · ${data.status}` : ""}` : data.status === "planned" ? "Not started" : completed ? `Reported${result ? `: ${result}` : ""}` : data.status);
  return (
    <div className={cx("relative flex h-[80px] w-[264px] flex-col justify-center rounded-xl border bg-white px-3 shadow-sm", failed ? "border-red-500 ring-2 ring-red-100" : data.isCurrent ? "border-teal-600 ring-2 ring-teal-100" : data.selected ? "border-slate-500 ring-2 ring-slate-200" : "border-slate-300")}
      role={data.onSelectStep ? "button" : undefined} tabIndex={data.onSelectStep ? 0 : undefined}
      title={data.description ?? data.title}
      onClick={(event) => { event.stopPropagation(); data.onSelectStep?.(); }}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); data.onSelectStep?.(); } }}
    >
      {([Position.Left, Position.Right, Position.Top, Position.Bottom] as const).map((position) => <Handle key={position} id={position} className="!size-0 !border-0 !opacity-0" position={position} type="source" isConnectable={false} />)}
      <div className="flex items-center gap-2">
        <span className={cx("grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold", failed ? "bg-red-100 text-red-800" : data.isCurrent ? "bg-teal-100 text-teal-800" : "bg-slate-100 text-slate-600")}>{data.ordinal ?? <Icon className="size-4" />}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold leading-5 text-slate-900">{data.title}</div>
          {data.role ? <div className="text-[11px] text-slate-500">{data.role.replaceAll("_", " ")}</div> : null}
        </div>
        {data.alternativeCount > 0 ? <span className="flex items-center gap-0.5 text-[10px] text-slate-500" title={`${data.alternativeCount} alternative routes. Select this phase to show them.`}><GitBranch className="size-3.5" />{data.alternativeCount}</span> : null}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 pl-8 text-[11px] leading-4">
        <span className={cx("truncate", failed || result === "blocked" ? "font-semibold text-red-700" : data.isCurrent ? "font-semibold text-teal-700" : "text-slate-600")} title={status}>{status}</span>
        {data.instanceCount > 1 ? <span className="shrink-0 text-slate-500">Attempt {data.instanceCount}</span> : null}
      </div>
    </div>
  );
}

function PhaseEdgeOverlay({ routes }: { routes: DiagramRoute[] }) {
  const [focusedEdge, setFocusedEdge] = useState<string | null>(null);
  return <ViewportPortal><div className="agent-relation-layer">
    <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 size-px overflow-visible">
      {routes.map(({ edge, points }) => {
        const color = edge.tone === "taken" ? "#0f766e" : "#64748b";
        const tip = points.at(-1)!;
        const previous = points.at(-2) ?? tip;
        const length = Math.hypot(tip.x - previous.x, tip.y - previous.y) || 1;
        const dx = (tip.x - previous.x) / length;
        const dy = (tip.y - previous.y) / length;
        const arrow = `M ${tip.x},${tip.y} L ${tip.x - dx * 13 - dy * 5},${tip.y - dy * 13 + dx * 5} L ${tip.x - dx * 13 + dy * 5},${tip.y - dy * 13 - dx * 5} Z`;
        return <g opacity={focusedEdge && focusedEdge !== edge.id ? 0.25 : 1} data-flow-edge={edge.id} data-flow-edge-tone={edge.tone === "taken" ? "taken" : "possible"} key={edge.id}>
          <path d={diagramPath(points)} fill="none" stroke="white" strokeWidth={7} strokeLinejoin="round" />
          <path data-flow-edge-route="orthogonal" d={diagramPath(points)} fill="none" stroke={color} strokeWidth={focusedEdge === edge.id ? 4.5 : edge.tone === "taken" ? 3.5 : 2.5} strokeLinejoin="round" />
          <path data-edge-arrow="true" d={arrow} fill={color} />
        </g>;
      })}
    </svg>
    {routes.map(({ edge, labelPoint }) => <div key={edge.id} title={edge.conditions} tabIndex={0} onMouseEnter={() => setFocusedEdge(edge.id)} onMouseLeave={() => setFocusedEdge(null)} onFocus={() => setFocusedEdge(edge.id)} onBlur={() => setFocusedEdge(null)}
      className={cx("pointer-events-auto absolute w-max max-w-[156px] whitespace-normal rounded-md border bg-white px-2 py-1 text-center text-[11px] font-medium leading-4 shadow-sm", edge.tone === "taken" ? "border-teal-200 text-teal-800" : "border-slate-200 text-slate-600")}
      data-flow-edge-label={edge.id} style={{ transform: `translate(-50%, -50%) translate(${labelPoint.x}px, ${labelPoint.y}px)` }}>
      {edge.label}
    </div>)}
  </div></ViewportPortal>;
}

function getFlowSafeArea(root: HTMLDivElement): { x: number; y: number; width: number; height: number } {
  const rect = root.getBoundingClientRect();
  let top = 16;
  let bottom = rect.height - 16;
  for (const selector of [".agent-graph-toolbar", ".agent-graph-actions", ".console-top"]) {
    for (const element of document.querySelectorAll(selector)) {
      const obstacle = element.getBoundingClientRect();
      if (obstacle.right > rect.left && obstacle.left < rect.right && obstacle.bottom > rect.top && obstacle.top < rect.bottom) top = Math.max(top, obstacle.bottom - rect.top + 16);
    }
  }
  for (const selector of [".flow-legend", ".react-flow__controls", ".react-flow__minimap", '.console-bottom-panel[data-open="true"]']) {
    for (const element of document.querySelectorAll(selector)) {
      const obstacle = element.getBoundingClientRect();
      if (obstacle.right > rect.left && obstacle.left < rect.right && obstacle.bottom > rect.top && obstacle.top < rect.bottom) bottom = Math.min(bottom, obstacle.top - rect.top - 16);
    }
  }
  return { x: 16, y: top, width: Math.max(1, rect.width - 32), height: Math.max(120, bottom - top) };
}

function GraphActionButton({ active, icon: Icon, label, onClick, switchControl = false }: {
  active?: boolean; icon: typeof Crosshair; label: string; onClick: () => void; switchControl?: boolean;
}) {
  return <button aria-label={label} aria-pressed={switchControl ? Boolean(active) : undefined} className="agent-graph-action-button" data-active={active ? "true" : "false"}
    onClick={(event) => { event.stopPropagation(); onClick(); }} onPointerDown={(event) => event.stopPropagation()} title={label} type="button"><Icon className="size-4" strokeWidth={1.8} /></button>;
}

function readStoredPositions(key: string): Map<string, Point> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, Point>;
    return new Map(Object.entries(parsed).filter(([, value]) => value && Number.isFinite(value.x) && Number.isFinite(value.y)));
  } catch { return new Map(); }
}

function storePositions(key: string, nodes: PhaseFlowNode[]): void {
  try { window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(nodes.map((node) => [node.id, node.position])))); }
  catch { /* The current layout remains in memory when the host denies storage. */ }
}
