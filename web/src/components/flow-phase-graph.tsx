"use client";

import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ViewportPortal,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance
} from "@xyflow/react";
import type { ELK as ElkLayoutEngine, ElkNode } from "elkjs";
import { CheckCircle2, Crosshair, GitBranch, LayoutGrid, LocateFixed, Radio, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildFlowVisualModel, type FlowVisualEdge, type FlowVisualNode } from "@/lib/flow-graph";
import { compactId, cx, formatDuration } from "@/lib/format";
import type { DashboardSnapshot } from "@/lib/types";
import { FlowStatusDot, flowNodeColor, flowStatusClass } from "./flow-status";

const nodeTypes = { phase: FlowPhaseNode };
let elkPromise: Promise<ElkLayoutEngine> | null = null;
const GRAPH_MIN_ZOOM = 0.16;
const GRAPH_MAX_ZOOM = 1.75;
const SAFE_AREA_MARGIN = 16;
const SAFE_AREA_PADDING = 28;
const ORGANIZED_GRAPH_PADDING = 24;
const PHASE_PARALLEL_EDGE_GAP = 22;
const PHASE_ANCHOR_FAN_GAP = 16;
const PHASE_MAX_ANCHOR_FAN_SHIFT = 52;
const PHASE_ARROW_LENGTH = 10;
const PHASE_ARROW_HALF_WIDTH = 3;
const PHASE_FEEDBACK_LANE_PADDING = 72;
const PHASE_NOTIFY_BUS_CLEARANCE = 64;
const PHASE_NOTIFY_BUS_GAP = 18;
const PHASE_LAYOUT_STEP_MARGIN = 34;
const PHASE_LAYOUT_COMPACT_MARGIN = 24;
const DEFAULT_STEP_NODE_WIDTH = 264;
const DEFAULT_STEP_NODE_HEIGHT = 156;
const DEFAULT_COMPACT_NODE_WIDTH = 48;
const DEFAULT_COMPACT_NODE_HEIGHT = 48;
const FOLLOW_ACTIVE_MAX_ZOOM = 1.15;
const FOLLOW_ACTIVE_MIN_ZOOM = 0.72;
const FOLLOW_ACTIVE_PADDING_X = 260;
const FOLLOW_ACTIVE_PADDING_Y = 180;
const EDGE_COLORS: Record<FlowVisualEdge["tone"], string> = {
  default: "#64748b",
  finish: "#65a30d",
  notify: "#f59e0b",
  taken: "#14b8a6"
};

type PhaseNodeData = FlowVisualNode & Record<string, unknown> & { onSelectStep?: () => void; selected: boolean };
type PhaseFlowNode = Node<PhaseNodeData, "phase">;
type FloatingSide = "bottom" | "left" | "right" | "top";
type PhaseFlowEdge = Edge;
type PhaseEdgeLayer = "decision" | "feedback" | "finish" | "notify" | "primary";
type RoutedPhaseEdge = FlowVisualEdge & {
  elkPoints: Array<{ x: number; y: number }> | null;
  parallelOffset: number;
  route: PhaseEdgeRoute;
  semanticLayer: PhaseEdgeLayer;
};
type OrganizedPhaseLayout = {
  positions: Map<string, { x: number; y: number }>;
  routes: Map<string, Array<{ x: number; y: number }>>;
};
type PhaseEdgeRoute = {
  sourceSide: FloatingSide;
  sourceTangentShift: number;
  targetSide: FloatingSide;
  targetTangentShift: number;
};
type RoutedEndpoint = {
  edge: RoutedPhaseEdge;
  endpoint: "source" | "target";
  nodeId: string;
  otherNodeId: string;
  side: FloatingSide;
};
type RenderedPhaseEdge = {
  arrow: string;
  color: string;
  dash: string | undefined;
  id: string;
  label: string;
  labelPoint: { x: number; y: number };
  labels?: RenderedPhaseEdgeLabel[];
  path: string;
  points: Array<{ x: number; y: number }>;
  routeSource: "bus" | "custom" | "elk";
  semanticLayer: PhaseEdgeLayer;
  strokeWidth: number;
  tone: FlowVisualEdge["tone"];
};
type RenderedPhaseEdgeLabel = {
  id: string;
  point: { x: number; y: number };
  text: string;
  tone: FlowVisualEdge["tone"];
};
type PhaseBusCandidate = {
  labelPoint: { x: number; y: number };
  path: string;
  previousPoint: { x: number; y: number };
  score: number;
  targetAnchor: { x: number; y: number };
};
type PhaseBusSegment = {
  end: { x: number; y: number };
  ignoredNodeIds: Set<string>;
  start: { x: number; y: number };
};
type PhaseNodeRanks = Map<string, number>;

export interface FlowStepSelection {
  agentId: string | null;
  role: string | null;
  stepId: string;
  stepInstanceId: string | null;
}

export function FlowPhaseGraph({
  onSelectStep,
  selectedStepId,
  selectedStepInstanceId,
  snapshot,
  toolbarLeading
}: {
  onSelectStep: (selection: FlowStepSelection) => void;
  selectedStepId: string | null;
  selectedStepInstanceId: string | null;
  snapshot: DashboardSnapshot;
  toolbarLeading?: React.ReactNode;
}) {
  const model = useMemo(() => buildFlowVisualModel(snapshot), [snapshot]);
  const [nodes, setNodes] = useState<PhaseFlowNode[]>([]);
  const [organizedEdgeRoutes, setOrganizedEdgeRoutes] = useState<Map<string, Array<{ x: number; y: number }>>>(new Map());
  const [follow, setFollow] = useState(true);
  const [flowReady, setFlowReady] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const flowRef = useRef<ReactFlowInstance<PhaseFlowNode, PhaseFlowEdge> | null>(null);
  const graphRootRef = useRef<HTMLDivElement | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticViewportRef = useRef(false);
  const storageKey = `agent-control:phase-graph:v5:${snapshot.selected_run_id ?? "none"}:${model?.instance.flow_instance_id ?? "none"}`;

  useEffect(() => {
    if (!model) {
      setNodes([]);
      return;
    }
    const stored = readStoredPositions(storageKey);
    setNodes(
      model.nodes.map((node) => ({
        id: node.id,
        type: "phase",
        position: stored.get(node.id) ?? node.position,
        zIndex: phaseNodeZIndex(node),
        data: {
          ...node,
          onSelectStep: node.stepId
            ? () =>
                onSelectStep({
                  agentId: node.latestStep?.agent_id ?? null,
                  role: node.role,
                  stepId: node.stepId!,
                  stepInstanceId: node.latestStep?.step_instance_id ?? null
                })
            : undefined,
          selected: Boolean(
            (node.latestStep && node.latestStep.step_instance_id === selectedStepInstanceId) ||
              (!selectedStepInstanceId && node.stepId && node.stepId === selectedStepId)
          )
        }
      }))
    );
  }, [model, onSelectStep, selectedStepId, selectedStepInstanceId, storageKey]);

  useEffect(() => {
    setOrganizedEdgeRoutes(new Map());
  }, [storageKey]);

  const edges = useMemo(() => routePhaseEdges(model?.edges ?? [], nodes, organizedEdgeRoutes), [model?.edges, nodes, organizedEdgeRoutes]);
  const activePhaseNodeId = useMemo(
    () =>
      nodes.find((node) => node.data.kind === "step" && (node.data.isCurrent || node.data.latestStep?.status === "active"))?.id ?? null,
    [nodes]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<PhaseFlowNode>[]) => {
      if (changes.some((change) => change.type === "position" && "dragging" in change && change.dragging)) {
        setOrganizedEdgeRoutes(new Map());
      }
      setNodes((current) => {
        const next = applyNodeChanges<PhaseFlowNode>(changes, current);
        storePositions(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const fitGraph = useCallback((duration = 450, focusActive = false) => {
    const flow = flowRef.current;
    const graphRoot = graphRootRef.current;
    const fittedNodes = flow?.getNodes() ?? [];
    if (!flow || !graphRoot || fittedNodes.length === 0) {
      return;
    }
    const bounds = flow.getNodesBounds(fittedNodes);
    const safeArea = getFlowSafeArea(graphRoot);
    const availableWidth = Math.max(1, safeArea.width - SAFE_AREA_PADDING * 2);
    const availableHeight = Math.max(1, safeArea.height - SAFE_AREA_PADDING * 2);
    const boundedWidth = Math.max(1, bounds.width);
    const boundedHeight = Math.max(1, bounds.height);
    const rawZoom = Math.min(availableWidth / boundedWidth, availableHeight / boundedHeight);
    const activeNode = focusActive
      ? (fittedNodes.find((node) => node.data.kind === "step" && (node.data.isCurrent || node.data.latestStep?.status === "active")) ??
        null)
      : null;
    const focusedNode =
      activeNode ??
      (rawZoom < GRAPH_MIN_ZOOM
        ? fittedNodes.find((node) => node.data.selected) ?? fittedNodes.find((node) => node.data.isCurrent) ?? null
        : null);
    const focusedWidth = focusedNode?.measured?.width ?? (focusedNode?.data.kind === "step" ? DEFAULT_STEP_NODE_WIDTH : DEFAULT_COMPACT_NODE_WIDTH);
    const focusedHeight =
      focusedNode?.measured?.height ?? (focusedNode?.data.kind === "step" ? DEFAULT_STEP_NODE_HEIGHT : DEFAULT_COMPACT_NODE_HEIGHT);
    const zoom = focusedNode
      ? clamp(
          Math.min(
            availableWidth / Math.max(1, focusedWidth + FOLLOW_ACTIVE_PADDING_X),
            availableHeight / Math.max(1, focusedHeight + FOLLOW_ACTIVE_PADDING_Y)
          ),
          FOLLOW_ACTIVE_MIN_ZOOM,
          FOLLOW_ACTIVE_MAX_ZOOM
        )
      : clamp(rawZoom, GRAPH_MIN_ZOOM, 1.05);
    const boundsCenterX = focusedNode ? focusedNode.position.x + focusedWidth / 2 : bounds.x + boundedWidth / 2;
    const boundsCenterY = focusedNode ? focusedNode.position.y + focusedHeight / 2 : bounds.y + boundedHeight / 2;
    const viewport = {
      x: safeArea.x + safeArea.width / 2 - boundsCenterX * zoom,
      y: safeArea.y + safeArea.height / 2 - boundsCenterY * zoom,
      zoom
    };
    programmaticViewportRef.current = true;
    void flow.setViewport(viewport, { duration }).finally(() => {
      window.setTimeout(() => {
        programmaticViewportRef.current = false;
      }, 0);
    });
  }, []);

  const disableFollowTemporarily = useCallback(() => {
    if (programmaticViewportRef.current) {
      return;
    }
    setFollow(false);
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(() => setFollow(true), 20000);
  }, []);

  const organizeGraph = useCallback(async () => {
    if (!model || nodes.length === 0 || organizing) {
      return;
    }
    setOrganizing(true);
    try {
      const layout = await calculateOrganizedPhaseLayout(nodes, model.edges);
      setOrganizedEdgeRoutes(layout.routes);
      setNodes((current) => {
        const next = current.map((node) => ({
          ...node,
          position: layout.positions.get(node.id) ?? node.position
        }));
        storePositions(storageKey, next);
        return next;
      });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => fitGraph(420));
      });
    } finally {
      setOrganizing(false);
    }
  }, [fitGraph, model, nodes, organizing, storageKey]);

  useEffect(() => {
    if (follow && flowReady) {
      const timer = setTimeout(() => fitGraph(300, true), 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [activePhaseNodeId, edges.length, fitGraph, flowReady, follow, nodes.length, selectedStepInstanceId]);

  if (!model) {
    return (
      <div className="relative h-full min-h-0 overflow-hidden" ref={graphRootRef}>
        <div className="agent-graph-toolbar absolute z-20 flex items-center gap-2">
          {toolbarLeading}
        </div>
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div className="rounded-lg border border-dashed border-black/15 bg-white/65 px-5 py-4">
            <div className="text-sm font-semibold text-ink-900">No declarative flow in this run</div>
            <div className="mt-1 max-w-sm text-xs leading-5 text-ink-500">
              Agent relationships are still available in the Agents view.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden" ref={graphRootRef}>
      <div className="agent-graph-toolbar absolute z-20 flex max-w-[calc(100%-112px)] items-center gap-2">
        {toolbarLeading}
        <div className="hidden min-w-0 items-center gap-2 rounded-lg border border-black/10 bg-white/82 px-3 py-2 text-xs shadow-panel backdrop-blur-xl sm:flex">
          <Workflow className="size-4 shrink-0 text-teal-700" />
          <div className="min-w-0">
            <div className="truncate font-semibold text-ink-800">{model.flow.flow_id}</div>
            <div className="truncate text-[10px] text-ink-400">
              {compactId(model.instance.flow_instance_id)} · current {model.instance.current_step_id ?? "none"}
            </div>
          </div>
        </div>
      </div>

      <div className="agent-graph-actions absolute z-20">
        <div className="agent-graph-action-group" role="group" aria-label="Flow graph viewport controls">
          <GraphActionButton
            active={follow}
            icon={LocateFixed}
            label={follow ? "Disable follow active phase" : "Follow active phase"}
            onClick={() => setFollow((value) => !value)}
            switchControl
          />
          <GraphActionButton icon={Crosshair} label="Fit flow" onClick={() => fitGraph()} />
          <GraphActionButton disabled={organizing} icon={LayoutGrid} label={organizing ? "Organizing flow" : "Organize flow"} onClick={organizeGraph} />
        </div>
      </div>

      <div className="absolute inset-0">
        <ReactFlow<PhaseFlowNode, PhaseFlowEdge>
          edges={[]}
          elevateNodesOnSelect={false}
          maxZoom={GRAPH_MAX_ZOOM}
          minZoom={GRAPH_MIN_ZOOM}
          nodes={nodes}
          nodeTypes={nodeTypes}
          onInit={(instance) => {
            flowRef.current = instance;
            setFlowReady(true);
          }}
          onMoveStart={disableFollowTemporarily}
          onNodeClick={(_, node) => {
            if (node.data.kind === "step" && node.data.stepId) {
              onSelectStep({
                agentId: node.data.latestStep?.agent_id ?? null,
                role: node.data.role,
                stepId: node.data.stepId,
                stepInstanceId: node.data.latestStep?.step_instance_id ?? null
              });
            }
          }}
          onNodeDragStart={disableFollowTemporarily}
          onNodesChange={onNodesChange}
          onlyRenderVisibleElements={false}
          panOnDrag
          proOptions={{ hideAttribution: true }}
        >
          <PhaseEdgeOverlay edges={edges} nodes={nodes} />
          <Background gap={22} size={1} />
          <Controls onFitView={() => fitGraph()} position="bottom-left" showInteractive={false} />
          <MiniMap
            maskColor="rgba(238, 242, 246, 0.68)"
            nodeBorderRadius={8}
            nodeColor={(node) => flowNodeColor((node.data as PhaseNodeData).status, (node.data as PhaseNodeData).kind)}
            position="bottom-right"
            pannable
            style={{ height: 76, opacity: 0.82, width: 124 }}
            zoomable
          />
        </ReactFlow>
      </div>
    </div>
  );
}

function getFlowSafeArea(graphRoot: HTMLDivElement): { height: number; width: number; x: number; y: number } {
  const rootRect = graphRoot.getBoundingClientRect();
  const rootArea = { height: rootRect.height, width: rootRect.width, x: 0, y: 0 };
  if (rootArea.width <= 0 || rootArea.height <= 0) {
    return rootArea;
  }

  const topObstacles = [
    ...obstaclesFor(graphRoot, rootRect, [".agent-graph-toolbar", ".agent-graph-actions"]),
    ...obstaclesFor(document, rootRect, [".console-top"])
  ];
  const bottomObstacles = [
    ...obstaclesFor(graphRoot, rootRect, [".react-flow__controls", ".react-flow__minimap"]),
    ...obstaclesFor(document, rootRect, ['.console-bottom-panel[data-open="true"]'])
  ];

  const topClearance = Math.max(SAFE_AREA_MARGIN, ...topObstacles.map((obstacle) => obstacle.y + obstacle.height + SAFE_AREA_MARGIN));
  const bottomClearance = Math.min(rootArea.height - SAFE_AREA_MARGIN, ...bottomObstacles.map((obstacle) => obstacle.y - SAFE_AREA_MARGIN));
  const usableTop = Math.min(topClearance, rootArea.height - SAFE_AREA_MARGIN);
  const usableBottom = Math.max(usableTop + 120, bottomClearance);
  return {
    x: SAFE_AREA_MARGIN,
    y: usableTop,
    width: Math.max(1, rootArea.width - SAFE_AREA_MARGIN * 2),
    height: Math.max(1, Math.min(rootArea.height - SAFE_AREA_MARGIN, usableBottom) - usableTop)
  };
}

function obstaclesFor(
  root: Document | HTMLDivElement,
  rootRect: DOMRect,
  selectors: string[]
): Array<{ height: number; width: number; x: number; y: number }> {
  return selectors.flatMap((selector) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector)).flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(rootRect.left, rect.left);
      const right = Math.min(rootRect.right, rect.right);
      const top = Math.max(rootRect.top, rect.top);
      const bottom = Math.min(rootRect.bottom, rect.bottom);
      if (right <= left || bottom <= top) {
        return [];
      }
      return [{ height: bottom - top, width: right - left, x: left - rootRect.left, y: top - rootRect.top }];
    })
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function FlowPhaseNode({ data }: NodeProps<PhaseFlowNode>) {
  const Icon = data.kind === "decision" ? GitBranch : data.kind === "finish" ? CheckCircle2 : data.kind === "notify" ? Radio : Workflow;
  const statusClass = flowStatusClass(data.status, data.kind);
  if (data.kind === "decision") {
    return (
      <div className="group relative grid size-12 place-items-center" title={`${data.title}: ${data.subtitle}`}>
        <FlowHandles />
        <div className="absolute inset-1 rotate-45 rounded-[9px] border border-sky-200 bg-white shadow-node transition group-hover:border-sky-300 group-hover:bg-sky-50" />
        <Icon className="relative size-4 text-sky-700" strokeWidth={1.9} />
        <span className="pointer-events-none absolute left-1/2 top-[calc(100%+5px)] -translate-x-1/2 rounded bg-white/88 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-sky-700 shadow-[0_0_0_1px_rgba(14,165,233,0.16)]">
          {data.subtitle}
        </span>
      </div>
    );
  }

  if (data.kind === "finish" || data.kind === "notify") {
    return (
      <div
        className={cx(
          "group relative inline-flex min-h-11 w-max max-w-[170px] items-center gap-2 rounded-lg border bg-white px-3 py-2 text-left shadow-node transition",
          statusClass.border
        )}
        title={data.description ?? data.title}
      >
        <FlowHandles />
        <div className={cx("grid size-6 shrink-0 place-items-center rounded-md", statusClass.bg, statusClass.text)}>
          <Icon className="size-3.5" strokeWidth={1.9} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-ink-900">{data.title}</div>
          <div className={cx("truncate text-[9px] font-semibold uppercase tracking-[0.08em]", statusClass.text)}>
            {data.kind === "finish" ? "finish" : "notify"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cx(
        "group min-h-[116px] w-[264px] rounded-lg border bg-white p-3 text-left shadow-node transition",
        statusClass.border,
        data.isCurrent && "shadow-[0_0_0_2px_rgba(20,184,166,0.32),0_18px_42px_rgba(15,23,42,0.10)]",
        data.selected && "ring-2 ring-teal-300"
      )}
      onClick={(event) => {
        event.stopPropagation();
        data.onSelectStep?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onSelectStep?.();
        }
      }}
      role={data.onSelectStep ? "button" : undefined}
      tabIndex={data.onSelectStep ? 0 : undefined}
    >
      <FlowHandles />
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className={cx("grid size-8 shrink-0 place-items-center rounded-md", statusClass.bg, statusClass.text)}>
            <Icon className="size-4" strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink-900">{data.title}</div>
            <div className="truncate text-[11px] text-ink-500">{data.subtitle}</div>
          </div>
        </div>
        <FlowStatusDot current={data.isCurrent} kind={data.kind} status={data.status} />
      </div>

      {data.description ? (
        <div className="mt-2 line-clamp-2 text-[11px] leading-4 text-ink-500">{data.description}</div>
      ) : null}

      <div className="mt-3 grid grid-cols-3 gap-1.5 text-[10px]">
        <PhaseMetric label="inputs" value={String(data.inputCount)} />
        <PhaseMetric label="outputs" value={String(data.outputCount)} />
        <PhaseMetric label="runs" value={String(data.instanceCount)} />
      </div>

      {data.reportValues.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {data.reportValues.slice(0, 4).map((value) => (
            <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-ink-500" key={value}>
              {value}
            </span>
          ))}
          {data.reportValues.length > 4 ? (
            <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-ink-400">
              +{data.reportValues.length - 4}
            </span>
          ) : null}
        </div>
      ) : null}

      {data.latestStep ? (
        <div className="mt-2 truncate text-[10px] text-ink-400">
          {compactId(data.latestStep.step_instance_id)} · {formatDuration(Date.now() - Date.parse(data.latestStep.updated_at))} ago
        </div>
      ) : null}
    </div>
  );
}

function phaseNodeZIndex(node: FlowVisualNode): number {
  if (node.kind === "decision") {
    return 80;
  }
  if (node.kind === "finish" || node.kind === "notify") {
    return 70;
  }
  if (node.isCurrent) {
    return 30;
  }
  return 20;
}

function FlowHandles() {
  return (
    <>
      <Handle className="!size-1 !border-0 !bg-transparent !opacity-0" id="source-left" isConnectable={false} position={Position.Left} type="source" />
      <Handle className="!size-1 !border-0 !bg-transparent !opacity-0" id="source-right" isConnectable={false} position={Position.Right} type="source" />
      <Handle className="!size-1 !border-0 !bg-transparent !opacity-0" id="source-top" isConnectable={false} position={Position.Top} type="source" />
      <Handle className="!size-1 !border-0 !bg-transparent !opacity-0" id="source-bottom" isConnectable={false} position={Position.Bottom} type="source" />
      <Handle className="!size-1 !border-0 !bg-transparent !opacity-0" id="target-left" isConnectable={false} position={Position.Left} type="target" />
      <Handle className="!size-1 !border-0 !bg-transparent !opacity-0" id="target-right" isConnectable={false} position={Position.Right} type="target" />
      <Handle className="!size-1 !border-0 !bg-transparent !opacity-0" id="target-top" isConnectable={false} position={Position.Top} type="target" />
      <Handle className="!size-1 !border-0 !bg-transparent !opacity-0" id="target-bottom" isConnectable={false} position={Position.Bottom} type="target" />
    </>
  );
}

function PhaseMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-black/8 bg-white/60 px-1.5 py-1">
      <div className="truncate text-ink-300">{label}</div>
      <div className="truncate font-semibold text-ink-700">{value}</div>
    </div>
  );
}

function PhaseEdgeOverlay({ edges, nodes }: { edges: RoutedPhaseEdge[]; nodes: PhaseFlowNode[] }) {
  const renderedNormal = phaseNormalEdgePathData(edges.filter((edge) => !isPhaseBusEdge(edge)), nodes);
  const renderedBuses = phaseBusPathData(edges.filter(isPhaseBusEdge), nodes);
  const rendered = [...renderedNormal, ...renderedBuses];
  const labels = rendered.flatMap(renderedPhaseEdgeLabels);

  return (
    <ViewportPortal>
      <div className="agent-relation-layer">
        <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 size-px overflow-visible">
          {rendered.map((edge) => (
            <g data-flow-edge-layer={edge.semanticLayer} data-flow-edge-tone={edge.tone} key={edge.id}>
              <path
                data-flow-edge-route={edge.routeSource}
                d={edge.path}
                fill="none"
                opacity={edge.tone === "taken" ? 0.96 : 0.86}
                stroke={edge.color}
                strokeDasharray={edge.dash}
                strokeLinecap="butt"
                strokeLinejoin="miter"
                strokeWidth={edge.strokeWidth}
              />
              <path aria-hidden="true" data-edge-arrow={edge.tone} d={edge.arrow} fill={edge.color} />
            </g>
          ))}
        </svg>
        {labels.map((label) =>
          label.text ? (
            <div
              className="pointer-events-none absolute max-w-28 truncate rounded bg-white/88 px-1.5 py-0.5 text-[10px] font-semibold text-ink-500 shadow-[0_0_0_1px_rgba(21,25,29,0.08)]"
              data-flow-edge-tone={label.tone}
              key={label.id}
              style={{ transform: `translate(-50%, -50%) translate(${label.point.x}px, ${label.point.y}px)` }}
            >
              {label.text}
            </div>
          ) : null
        )}
      </div>
    </ViewportPortal>
  );
}

function renderedPhaseEdgeLabels(edge: RenderedPhaseEdge): RenderedPhaseEdgeLabel[] {
  if (edge.labels) {
    return edge.labels;
  }
  if (!edge.label) {
    return [];
  }
  return [{ id: `${edge.id}-label`, point: edgeLabelPoint(edge, 0, 1), text: edge.label, tone: edge.tone }];
}

function phaseNormalEdgePathData(edges: RoutedPhaseEdge[], nodes: PhaseFlowNode[]): RenderedPhaseEdge[] {
  const groups = new Map<string, RoutedPhaseEdge[]>();
  for (const edge of edges) {
    const key = phaseNormalEdgeGroupKey(edge);
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }

  return [...groups.values()]
    .map((group) => phaseNormalEdgeGroupPathData(group, nodes))
    .filter((edge): edge is RenderedPhaseEdge => Boolean(edge));
}

function phaseNormalEdgeGroupKey(edge: RoutedPhaseEdge): string {
  return `${edge.semanticLayer}:${edge.source}:${edge.target}`;
}

function phaseNormalEdgeGroupPathData(group: RoutedPhaseEdge[], nodes: PhaseFlowNode[]): RenderedPhaseEdge | null {
  const ordered = [...group].sort((a, b) => phaseEdgeSortKey(a).localeCompare(phaseEdgeSortKey(b)));
  const tone: FlowVisualEdge["tone"] = ordered.some((edge) => edge.tone === "taken") ? "taken" : ordered[0]?.tone ?? "default";
  const representative = ordered[0] ? { ...ordered[0], tone } : null;
  if (!representative) {
    return null;
  }
  const rendered = phaseEdgePathData(representative, nodes);
  if (!rendered || ordered.length === 1) {
    return rendered;
  }
  return {
    ...rendered,
    id: `bundle:${phaseNormalEdgeGroupKey(representative)}`,
    label: "",
    labels: bundledNormalEdgeLabels(ordered, rendered)
  };
}

function bundledNormalEdgeLabels(edges: RoutedPhaseEdge[], rendered: RenderedPhaseEdge): RenderedPhaseEdgeLabel[] {
  const counts = new Map<string, { count: number; tone: FlowVisualEdge["tone"] }>();
  for (const edge of edges) {
    const label = edge.label.trim();
    if (!label) {
      continue;
    }
    const current = counts.get(label) ?? { count: 0, tone: edge.tone };
    counts.set(label, {
      count: current.count + 1,
      tone: current.tone === "taken" || edge.tone === "taken" ? "taken" : current.tone
    });
  }

  const labels = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return labels.map(([label, value], index) => ({
    id: `${rendered.id}-label:${label}`,
    point: edgeLabelPoint(rendered, index, labels.length),
    text: value.count > 1 ? `${label} x${value.count}` : label,
    tone: value.tone
  }));
}

function edgeLabelPoint(edge: RenderedPhaseEdge, index: number, count: number): { x: number; y: number } {
  return edge.semanticLayer === "decision" ? targetEdgeLabelPoint(edge.points, index, count) : originEdgeLabelPoint(edge.points, index, count);
}

function originEdgeLabelPoint(points: Array<{ x: number; y: number }>, index: number, count: number): { x: number; y: number } {
  const start = points[0] ?? { x: 0, y: 0 };
  const next = points.find((point) => point.x !== start.x || point.y !== start.y) ?? points[1] ?? start;
  const vector = normalizeVector({ x: next.x - start.x, y: next.y - start.y });
  const normal = { x: -vector.y, y: vector.x };
  const middle = (count - 1) / 2;
  const offset = (index - middle) * 16;
  return {
    x: start.x + vector.x * 34 + normal.x * offset,
    y: start.y + vector.y * 34 + normal.y * offset
  };
}

function targetEdgeLabelPoint(points: Array<{ x: number; y: number }>, index: number, count: number): { x: number; y: number } {
  const end = points.at(-1) ?? { x: 0, y: 0 };
  const previous =
    [...points].reverse().find((point) => point.x !== end.x || point.y !== end.y) ?? points.at(-2) ?? end;
  const vector = normalizeVector({ x: end.x - previous.x, y: end.y - previous.y });
  const normal = { x: -vector.y, y: vector.x };
  const middle = (count - 1) / 2;
  const offset = (index - middle) * 16;
  return {
    x: end.x - vector.x * 34 + normal.x * offset,
    y: end.y - vector.y * 34 + normal.y * offset
  };
}

function isPhaseBusEdge(edge: RoutedPhaseEdge): boolean {
  return edge.semanticLayer === "notify";
}

function phaseBusPathData(edges: RoutedPhaseEdge[], nodes: PhaseFlowNode[]): RenderedPhaseEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map<string, { edges: RoutedPhaseEdge[]; layer: PhaseEdgeLayer; targetId: string }>();
  for (const edge of edges) {
    if (nodeById.has(edge.source) && nodeById.has(edge.target)) {
      const key = phaseBusGroupKey(edge);
      const current = groups.get(key) ?? { edges: [], layer: edge.semanticLayer, targetId: edge.target };
      groups.set(key, { ...current, edges: [...current.edges, edge] });
    }
  }

  return [...groups.entries()]
    .map(([, group], index) => phaseBusGroupPathData(group, nodeById, index))
    .filter((edge): edge is RenderedPhaseEdge => Boolean(edge));
}

function phaseBusGroupKey(edge: RoutedPhaseEdge): string {
  // Buses are intentionally scoped by semantic type and destination. A future
  // flow can show notify/subscription/handoff paths to the same agent without
  // collapsing distinct meanings into a single ambiguous trunk.
  return `${edge.semanticLayer}:${edge.target}`;
}

function phaseBusGroupPathData(
  group: { edges: RoutedPhaseEdge[]; layer: PhaseEdgeLayer; targetId: string },
  nodeById: Map<string, PhaseFlowNode>,
  groupIndex: number
): RenderedPhaseEdge | null {
  const target = nodeById.get(group.targetId);
  const sources = group.edges
    .map((edge) => ({ edge, node: nodeById.get(edge.source) }))
    .filter((item): item is { edge: RoutedPhaseEdge; node: PhaseFlowNode } => Boolean(item.node));
  if (!target || sources.length === 0) {
    return null;
  }

  const averageSource = averagePoint(sources.map(({ node }) => nodeCenter(node)));
  const tone = sources.some(({ edge }) => edge.tone === "taken") ? "taken" : "notify";
  const preferredTargetSide = sideFacingPoint(target, averageSource);
  const candidates = (["left", "right", "top", "bottom"] as FloatingSide[])
    .map((side) => phaseBusCandidate({ groupIndex, nodeById, preferredTargetSide, side, sources, target }))
    .sort((a, b) => a.score - b.score);
  const candidate = candidates[0];
  if (!candidate) {
    return null;
  }

  return phaseBusRenderedEdge({
    count: sources.length,
    labelPoint: candidate.labelPoint,
    layer: group.layer,
    path: candidate.path,
    previousPoint: candidate.previousPoint,
    target,
    targetAnchor: candidate.targetAnchor,
    targetId: group.targetId,
    tone
  });
}

function phaseBusCandidate(input: {
  groupIndex: number;
  nodeById: Map<string, PhaseFlowNode>;
  preferredTargetSide: FloatingSide;
  side: FloatingSide;
  sources: Array<{ edge: RoutedPhaseEdge; node: PhaseFlowNode }>;
  target: PhaseFlowNode;
}): PhaseBusCandidate {
  const targetAnchor = anchorToNodeEdge(sideAnchor(input.target, input.side), input.side);
  const targetDirection = directionForSide(input.side);
  const busDistance = PHASE_NOTIFY_BUS_CLEARANCE + input.groupIndex * PHASE_NOTIFY_BUS_GAP;
  const allNodes = [...input.nodeById.values()];

  if (input.side === "left" || input.side === "right") {
    const busX = targetAnchor.x + targetDirection.x * busDistance;
    const stubs = input.sources.map(({ node }) => {
      const sourceSide: FloatingSide = busX >= nodeCenter(node).x ? "right" : "left";
      const anchor = anchorToNodeEdge(sideAnchor(node, sourceSide), sourceSide);
      return {
        anchor,
        busPoint: { x: busX, y: anchor.y },
        nodeId: node.id
      };
    });
    const yValues = [targetAnchor.y, ...stubs.map((stub) => stub.busPoint.y)];
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    const targetBusPoint = { x: busX, y: targetAnchor.y };
    const segments: PhaseBusSegment[] = [
      { start: { x: busX, y: minY }, end: { x: busX, y: maxY }, ignoredNodeIds: new Set() },
      ...stubs.map((stub) => ({
        start: stub.anchor,
        end: stub.busPoint,
        ignoredNodeIds: new Set([stub.nodeId])
      })),
      { start: targetBusPoint, end: targetAnchor, ignoredNodeIds: new Set([input.target.id]) }
    ];
    const path = [
      `M ${busX},${minY} L ${busX},${maxY}`,
      ...stubs.map((stub) => `M ${stub.anchor.x},${stub.anchor.y} L ${stub.busPoint.x},${stub.busPoint.y}`),
      `M ${targetBusPoint.x},${targetBusPoint.y} L ${targetAnchor.x},${targetAnchor.y}`
    ].join(" ");
    return {
      labelPoint: { x: (targetBusPoint.x + targetAnchor.x) / 2, y: targetAnchor.y - 12 },
      path,
      previousPoint: targetBusPoint,
      score: phaseBusOverlapScore(segments, allNodes, input.side, input.preferredTargetSide),
      targetAnchor
    };
  }

  const busY = targetAnchor.y + targetDirection.y * busDistance;
  const stubs = input.sources.map(({ node }) => {
    const sourceSide: FloatingSide = busY >= nodeCenter(node).y ? "bottom" : "top";
    const anchor = anchorToNodeEdge(sideAnchor(node, sourceSide), sourceSide);
    return {
      anchor,
      busPoint: { x: anchor.x, y: busY },
      nodeId: node.id
    };
  });
  const xValues = [targetAnchor.x, ...stubs.map((stub) => stub.busPoint.x)];
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const targetBusPoint = { x: targetAnchor.x, y: busY };
  const segments: PhaseBusSegment[] = [
    { start: { x: minX, y: busY }, end: { x: maxX, y: busY }, ignoredNodeIds: new Set() },
    ...stubs.map((stub) => ({
      start: stub.anchor,
      end: stub.busPoint,
      ignoredNodeIds: new Set([stub.nodeId])
    })),
    { start: targetBusPoint, end: targetAnchor, ignoredNodeIds: new Set([input.target.id]) }
  ];
  const path = [
    `M ${minX},${busY} L ${maxX},${busY}`,
    ...stubs.map((stub) => `M ${stub.anchor.x},${stub.anchor.y} L ${stub.busPoint.x},${stub.busPoint.y}`),
    `M ${targetBusPoint.x},${targetBusPoint.y} L ${targetAnchor.x},${targetAnchor.y}`
  ].join(" ");
  return {
    labelPoint: { x: targetAnchor.x + 14, y: (targetBusPoint.y + targetAnchor.y) / 2 },
    path,
    previousPoint: targetBusPoint,
    targetAnchor,
    score: phaseBusOverlapScore(segments, allNodes, input.side, input.preferredTargetSide),
  };
}

function phaseBusOverlapScore(
  segments: PhaseBusSegment[],
  nodes: PhaseFlowNode[],
  side: FloatingSide,
  preferredSide: FloatingSide
): number {
  let score = side === preferredSide ? 0 : 14;
  for (const segment of segments) {
    const length = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
    score += length * 0.01;
    const steps = Math.max(1, Math.ceil(length / 18));
    for (let index = 1; index < steps; index += 1) {
      const t = index / steps;
      const point = {
        x: segment.start.x + (segment.end.x - segment.start.x) * t,
        y: segment.start.y + (segment.end.y - segment.start.y) * t
      };
      if (nodes.some((node) => !segment.ignoredNodeIds.has(node.id) && pointInsideNode(point, node, 4))) {
        score += 100;
      }
    }
  }
  return score;
}

function pointInsideNode(point: { x: number; y: number }, node: PhaseFlowNode, inset = 0): boolean {
  return (
    point.x > node.position.x + inset &&
    point.x < node.position.x + nodeWidth(node) - inset &&
    point.y > node.position.y + inset &&
    point.y < node.position.y + nodeHeight(node) - inset
  );
}

function phaseBusRenderedEdge(input: {
  count: number;
  labelPoint: { x: number; y: number };
  layer: PhaseEdgeLayer;
  path: string;
  previousPoint: { x: number; y: number };
  target: PhaseFlowNode;
  targetAnchor: { x: number; y: number };
  targetId: string;
  tone: FlowVisualEdge["tone"];
}): RenderedPhaseEdge {
  const pseudoEdge = { semanticLayer: input.layer, tone: input.tone };
  return {
    arrow: makeArrowPath(input.targetAnchor, input.previousPoint),
    color: phaseEdgeColor(pseudoEdge),
    dash: phaseEdgeDash(pseudoEdge),
    id: `${input.layer}-bus:${input.targetId}`,
    label: `${input.layer} ${input.target.data.title}${input.count > 1 ? ` x${input.count}` : ""}`,
    labelPoint: input.labelPoint,
    path: input.path,
    points: [input.previousPoint, input.targetAnchor],
    routeSource: "bus",
    semanticLayer: input.layer,
    strokeWidth: phaseEdgeStrokeWidth(pseudoEdge),
    tone: input.tone
  };
}

function routePhaseEdges(
  edges: FlowVisualEdge[],
  nodes: PhaseFlowNode[],
  organizedRoutes: Map<string, Array<{ x: number; y: number }>>
): RoutedPhaseEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const ranks = buildPhaseNodeRanks(nodes);
  const routed = assignPhaseParallelOffsets(edges)
    .filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target))
    .map((edge) => {
      const source = nodeById.get(edge.source)!;
      const target = nodeById.get(edge.target)!;
      const semanticLayer = classifyPhaseEdge(edge, source, target, ranks);
      const sides = semanticLayer === "feedback" ? { sourceSide: "bottom" as const, targetSide: "bottom" as const } : choosePhaseEdgeSides(source, target);
      return {
        ...edge,
        elkPoints: semanticLayer === "notify" || semanticLayer === "feedback" ? null : organizedRoutes.get(edge.id) ?? null,
        route: {
          sourceSide: sides.sourceSide,
          sourceTangentShift: 0,
          targetSide: sides.targetSide,
          targetTangentShift: 0
        },
        semanticLayer
      };
    });

  applyPhaseAnchorFanoutShifts(routed, nodes);
  return routed;
}

function buildPhaseNodeRanks(nodes: PhaseFlowNode[]): PhaseNodeRanks {
  return new Map(
    nodes
      .filter((node) => node.data.kind === "step" && node.data.stepId)
      .sort((a, b) => a.data.position.y - b.data.position.y || a.data.position.x - b.data.position.x || a.id.localeCompare(b.id))
      .map((node, index) => [node.id, index])
  );
}

function classifyPhaseEdge(
  edge: FlowVisualEdge,
  source: PhaseFlowNode,
  target: PhaseFlowNode,
  ranks: PhaseNodeRanks
): PhaseEdgeLayer {
  if (edge.tone === "notify" || target.data.kind === "notify") {
    return "notify";
  }
  if (edge.tone === "finish" || target.data.kind === "finish") {
    return "finish";
  }

  const sourceRank = sourceStepRank(edge, source, ranks);
  const targetRank = targetStepRank(target, ranks);
  if (source.data.kind === "step" && target.data.kind === "decision") {
    return "decision";
  }
  if (sourceRank !== null && targetRank !== null && targetRank <= sourceRank) {
    return "feedback";
  }
  if (source.data.kind === "decision" || target.data.kind === "decision") {
    return "decision";
  }
  return "primary";
}

function sourceStepRank(edge: FlowVisualEdge, source: PhaseFlowNode, ranks: PhaseNodeRanks): number | null {
  if (edge.sourceStepId) {
    return ranks.get(`step:${edge.sourceStepId}`) ?? null;
  }
  if (source.data.kind === "step") {
    return ranks.get(source.id) ?? null;
  }
  if (source.data.stepId) {
    return ranks.get(`step:${source.data.stepId}`) ?? null;
  }
  return null;
}

function targetStepRank(target: PhaseFlowNode, ranks: PhaseNodeRanks): number | null {
  if (target.data.kind === "step") {
    return ranks.get(target.id) ?? null;
  }
  if (target.data.stepId) {
    return ranks.get(`step:${target.data.stepId}`) ?? null;
  }
  return null;
}

function phaseEdgePathData(edge: RoutedPhaseEdge, nodes: PhaseFlowNode[]): RenderedPhaseEdge | null {
  const sourceNode = nodes.find((node) => node.id === edge.source);
  const targetNode = nodes.find((node) => node.id === edge.target);
  if (!sourceNode || !targetNode) {
    return null;
  }

  const elkPoints = edge.elkPoints ? dedupePoints(edge.elkPoints) : null;
  if (elkPoints && elkPoints.length >= 2) {
    const labelPoint = orthogonalLabelPoint(elkPoints);
    const tip = elkPoints.at(-1)!;
    const previousPoint = elkPoints.at(-2)!;
    return {
      arrow: makeArrowPath(tip, previousPoint),
      color: phaseEdgeColor(edge),
      dash: phaseEdgeDash(edge),
      id: edge.id,
      label: edge.label,
      labelPoint,
      path: pathFromPoints(elkPoints),
      points: elkPoints,
      routeSource: "elk",
      semanticLayer: edge.semanticLayer,
      strokeWidth: phaseEdgeStrokeWidth(edge),
      tone: edge.tone
    };
  }

  const sourceAnchor = anchorToNodeEdge(sideAnchor(sourceNode, edge.route.sourceSide), edge.route.sourceSide);
  const targetAnchor = anchorToNodeEdge(sideAnchor(targetNode, edge.route.targetSide), edge.route.targetSide);
  const sourceTangent = tangentForSide(edge.route.sourceSide);
  const targetTangent = tangentForSide(edge.route.targetSide);
  const startX = sourceAnchor.x + sourceTangent.x * edge.route.sourceTangentShift;
  const startY = sourceAnchor.y + sourceTangent.y * edge.route.sourceTangentShift;
  const endX = targetAnchor.x + targetTangent.x * edge.route.targetTangentShift;
  const endY = targetAnchor.y + targetTangent.y * edge.route.targetTangentShift;
  const points =
    edge.semanticLayer === "feedback"
      ? feedbackRoutePoints({
          end: { x: endX, y: endY },
          laneY: feedbackLaneY(nodes, edge.parallelOffset),
          start: { x: startX, y: startY }
        })
      : orthogonalRoutePoints({
          end: { x: endX, y: endY },
          parallelOffset: edge.parallelOffset,
          sourceSide: edge.route.sourceSide,
          start: { x: startX, y: startY },
          targetSide: edge.route.targetSide
        });
  const labelPoint = orthogonalLabelPoint(points);
  const previousPoint = points.at(-2) ?? { x: startX, y: startY };

  return {
    arrow: makeArrowPath({ x: endX, y: endY }, previousPoint),
    color: phaseEdgeColor(edge),
    dash: phaseEdgeDash(edge),
    id: edge.id,
    label: edge.label,
    labelPoint,
    path: pathFromPoints(points),
    points,
    routeSource: "custom",
    semanticLayer: edge.semanticLayer,
    strokeWidth: phaseEdgeStrokeWidth(edge),
    tone: edge.tone
  };
}

function orthogonalRoutePoints(input: {
  end: { x: number; y: number };
  parallelOffset: number;
  sourceSide: FloatingSide;
  start: { x: number; y: number };
  targetSide: FloatingSide;
}): Array<{ x: number; y: number }> {
  const sourceHorizontal = input.sourceSide === "left" || input.sourceSide === "right";
  const targetHorizontal = input.targetSide === "left" || input.targetSide === "right";

  if (sourceHorizontal && targetHorizontal) {
    const midX = (input.start.x + input.end.x) / 2 + input.parallelOffset;
    return dedupePoints([
      input.start,
      { x: midX, y: input.start.y },
      { x: midX, y: input.end.y },
      input.end
    ]);
  }

  if (!sourceHorizontal && !targetHorizontal) {
    const midY = (input.start.y + input.end.y) / 2 + input.parallelOffset;
    return dedupePoints([
      input.start,
      { x: input.start.x, y: midY },
      { x: input.end.x, y: midY },
      input.end
    ]);
  }

  if (sourceHorizontal) {
    return dedupePoints([
      input.start,
      { x: input.end.x + input.parallelOffset, y: input.start.y },
      { x: input.end.x + input.parallelOffset, y: input.end.y },
      input.end
    ]);
  }

  return dedupePoints([
    input.start,
    { x: input.start.x, y: input.end.y + input.parallelOffset },
    { x: input.end.x, y: input.end.y + input.parallelOffset },
    input.end
  ]);
}

function feedbackRoutePoints(input: {
  end: { x: number; y: number };
  laneY: number;
  start: { x: number; y: number };
}): Array<{ x: number; y: number }> {
  return dedupePoints([
    input.start,
    { x: input.start.x, y: input.laneY },
    { x: input.end.x, y: input.laneY },
    input.end
  ]);
}

function feedbackLaneY(nodes: PhaseFlowNode[], parallelOffset: number): number {
  const structuralNodes = nodes.filter((node) => node.data.kind === "step" || node.data.kind === "decision");
  const laneNodes = structuralNodes.length > 0 ? structuralNodes : nodes;
  const maxBottom = Math.max(0, ...laneNodes.map((node) => node.position.y + nodeHeight(node)));
  return maxBottom + PHASE_FEEDBACK_LANE_PADDING + parallelOffset;
}

function pathFromPoints(points: Array<{ x: number; y: number }>): string {
  const [first, ...rest] = points;
  if (!first) {
    return "";
  }
  return [`M ${first.x},${first.y}`, ...rest.map((point) => `L ${point.x},${point.y}`)].join(" ");
}

function orthogonalLabelPoint(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return {
      end: point,
      length: Math.hypot(point.x - previous.x, point.y - previous.y),
      start: previous
    };
  });
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let remaining = total / 2;
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const ratio = segment.length === 0 ? 0 : remaining / segment.length;
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        y: segment.start.y + (segment.end.y - segment.start.y) * ratio
      };
    }
    remaining -= segment.length;
  }
  return points.at(-1)!;
}

function dedupePoints(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
}

function phaseEdgeColor(edge: Pick<RoutedPhaseEdge, "semanticLayer" | "tone">): string {
  if (edge.semanticLayer === "feedback") {
    return "#7c3aed";
  }
  return EDGE_COLORS[edge.tone];
}

function phaseEdgeDash(edge: Pick<RoutedPhaseEdge, "semanticLayer" | "tone">): string | undefined {
  if (edge.tone === "finish") {
    return undefined;
  }
  if (edge.semanticLayer === "notify") {
    return "3 5";
  }
  if (edge.semanticLayer === "feedback") {
    return "5 5";
  }
  return edge.tone === "taken" ? undefined : "7 4";
}

function phaseEdgeStrokeWidth(edge: Pick<RoutedPhaseEdge, "semanticLayer" | "tone">): number {
  if (edge.tone === "taken") {
    return 2.35;
  }
  if (edge.semanticLayer === "notify") {
    return 1.65;
  }
  return 1.75;
}

function assignPhaseParallelOffsets(edges: FlowVisualEdge[]): Array<FlowVisualEdge & { parallelOffset: number }> {
  const groups = new Map<string, FlowVisualEdge[]>();
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join("::");
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }

  const offsets = new Map<string, number>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => phaseEdgeSortKey(a).localeCompare(phaseEdgeSortKey(b)));
    const middle = (ordered.length - 1) / 2;
    ordered.forEach((edge, index) => {
      offsets.set(edge.id, (index - middle) * PHASE_PARALLEL_EDGE_GAP);
    });
  }

  return edges.map((edge) => ({ ...edge, parallelOffset: offsets.get(edge.id) ?? 0 }));
}

function choosePhaseEdgeSides(
  source: PhaseFlowNode,
  target: PhaseFlowNode
): { sourceSide: FloatingSide; targetSide: FloatingSide } {
  const sourceCenter = nodeCenter(source);
  const targetCenter = nodeCenter(target);
  const flowVector = normalizeVector({
    x: targetCenter.x - sourceCenter.x,
    y: targetCenter.y - sourceCenter.y
  });
  const targetToSourceVector = { x: -flowVector.x, y: -flowVector.y };
  const sides: FloatingSide[] = ["left", "right", "top", "bottom"];
  let best: { sourceSide: FloatingSide; targetSide: FloatingSide; score: number } | null = null;

  for (const sourceSide of sides) {
    for (const targetSide of sides) {
      const sourceAnchor = sideAnchor(source, sourceSide);
      const targetAnchor = sideAnchor(target, targetSide);
      const dx = targetAnchor.x - sourceAnchor.x;
      const dy = targetAnchor.y - sourceAnchor.y;
      const length = Math.hypot(dx, dy);
      const sourceAlignment = dot(flowVector, directionForSide(sourceSide));
      const targetAlignment = dot(targetToSourceVector, directionForSide(targetSide));
      const axisPenalty = tangentAxis(sourceSide) === tangentAxis(targetSide) ? 0 : 20;
      const score = length + directionalPenalty(sourceAlignment) + directionalPenalty(targetAlignment) + axisPenalty;
      if (!best || score < best.score) {
        best = { sourceSide, targetSide, score };
      }
    }
  }

  return best ?? { sourceSide: "right", targetSide: "left" };
}

function sideFacingPoint(node: PhaseFlowNode, point: { x: number; y: number }): FloatingSide {
  const center = nodeCenter(node);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "bottom" : "top";
}

function averagePoint(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function applyPhaseAnchorFanoutShifts(edges: RoutedPhaseEdge[], nodes: PhaseFlowNode[]) {
  const groups = new Map<string, RoutedEndpoint[]>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const edge of edges) {
    const endpoints: RoutedEndpoint[] = [
      { edge, endpoint: "source", nodeId: edge.source, otherNodeId: edge.target, side: edge.route.sourceSide },
      { edge, endpoint: "target", nodeId: edge.target, otherNodeId: edge.source, side: edge.route.targetSide }
    ];
    for (const endpoint of endpoints) {
      const key = `${endpoint.nodeId}:${endpoint.side}`;
      groups.set(key, [...(groups.get(key) ?? []), endpoint]);
    }
  }

  for (const group of groups.values()) {
    const directionGroups = groupEndpointsByDirection(group, nodeById);
    const ordered = [...directionGroups.values()].sort((a, b) => compareFanoutEndpoints(a[0]!, b[0]!, nodeById));
    const middle = (ordered.length - 1) / 2;
    ordered.forEach((endpoints, index) => {
      const shift = clamp((index - middle) * PHASE_ANCHOR_FAN_GAP, -PHASE_MAX_ANCHOR_FAN_SHIFT, PHASE_MAX_ANCHOR_FAN_SHIFT);
      for (const endpoint of endpoints) {
        if (endpoint.endpoint === "source") {
          endpoint.edge.route.sourceTangentShift = shift;
        } else {
          endpoint.edge.route.targetTangentShift = shift;
        }
      }
    });
  }
}

function groupEndpointsByDirection(endpoints: RoutedEndpoint[], nodeById: Map<string, PhaseFlowNode>): Map<string, RoutedEndpoint[]> {
  const groups = new Map<string, RoutedEndpoint[]>();
  for (const endpoint of endpoints) {
    const key = endpointDirectionKey(endpoint, nodeById);
    groups.set(key, [...(groups.get(key) ?? []), endpoint]);
  }
  return groups;
}

function endpointDirectionKey(endpoint: RoutedEndpoint, nodeById: Map<string, PhaseFlowNode>): string {
  const currentNode = nodeById.get(endpoint.nodeId);
  const otherNode = nodeById.get(endpoint.otherNodeId);
  if (!currentNode || !otherNode) {
    return `${endpoint.endpoint}:unknown`;
  }

  const currentCenter = nodeCenter(currentNode);
  const otherCenter = nodeCenter(otherNode);
  const delta = endpoint.side === "left" || endpoint.side === "right"
    ? otherCenter.y - currentCenter.y
    : otherCenter.x - currentCenter.x;
  const direction = Math.abs(delta) < 8 ? "center" : delta < 0 ? "before" : "after";
  return `${endpoint.endpoint}:${direction}`;
}

function compareFanoutEndpoints(a: RoutedEndpoint, b: RoutedEndpoint, nodeById: Map<string, PhaseFlowNode>): number {
  const aRank = fanoutSortRank(a, nodeById);
  const bRank = fanoutSortRank(b, nodeById);
  if (aRank !== bRank) {
    return aRank - bRank;
  }
  return `${phaseEdgeSortKey(a.edge)}:${a.endpoint}`.localeCompare(`${phaseEdgeSortKey(b.edge)}:${b.endpoint}`);
}

function fanoutSortRank(endpoint: RoutedEndpoint, nodeById: Map<string, PhaseFlowNode>): number {
  const otherNode = nodeById.get(endpoint.otherNodeId);
  if (!otherNode) {
    return 0;
  }
  const center = nodeCenter(otherNode);
  return endpoint.side === "left" || endpoint.side === "right" ? center.y : center.x;
}

function sideAnchor(node: PhaseFlowNode, side: FloatingSide): { x: number; y: number } {
  const width = nodeWidth(node);
  const height = nodeHeight(node);
  if (side === "left") {
    return { x: node.position.x, y: node.position.y + height / 2 };
  }
  if (side === "right") {
    return { x: node.position.x + width, y: node.position.y + height / 2 };
  }
  if (side === "top") {
    return { x: node.position.x + width / 2, y: node.position.y };
  }
  return { x: node.position.x + width / 2, y: node.position.y + height };
}

function nodeCenter(node: PhaseFlowNode): { x: number; y: number } {
  return {
    x: node.position.x + nodeWidth(node) / 2,
    y: node.position.y + nodeHeight(node) / 2
  };
}

function nodeWidth(node: PhaseFlowNode): number {
  return node.measured?.width ?? node.width ?? (node.data.kind === "step" ? DEFAULT_STEP_NODE_WIDTH : DEFAULT_COMPACT_NODE_WIDTH);
}

function nodeHeight(node: PhaseFlowNode): number {
  return node.measured?.height ?? node.height ?? (node.data.kind === "step" ? DEFAULT_STEP_NODE_HEIGHT : DEFAULT_COMPACT_NODE_HEIGHT);
}

function anchorToNodeEdge(point: { x: number; y: number }, side: FloatingSide): { x: number; y: number } {
  const direction = directionForSide(side);
  return {
    x: point.x - direction.x * 1.5,
    y: point.y - direction.y * 1.5
  };
}

function directionForSide(side: FloatingSide): { x: number; y: number } {
  if (side === "left") return { x: -1, y: 0 };
  if (side === "right") return { x: 1, y: 0 };
  if (side === "top") return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function tangentForSide(side: FloatingSide): { x: number; y: number } {
  if (side === "top" || side === "bottom") {
    return { x: 1, y: 0 };
  }
  return { x: 0, y: 1 };
}

function tangentAxis(side: FloatingSide): "horizontal" | "vertical" {
  return side === "top" || side === "bottom" ? "horizontal" : "vertical";
}

function normalizeVector(vector: { x: number; y: number }): { x: number; y: number } {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

function dot(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return a.x * b.x + a.y * b.y;
}

function directionalPenalty(alignment: number): number {
  return (1 - alignment) * 145;
}

function makeArrowPath(tip: { x: number; y: number }, previousControl: { x: number; y: number }): string {
  const dx = tip.x - previousControl.x;
  const dy = tip.y - previousControl.y;
  const length = Math.hypot(dx, dy) || 1;
  const tangentX = dx / length;
  const tangentY = dy / length;
  const normalX = -tangentY;
  const normalY = tangentX;
  const baseX = tip.x - tangentX * PHASE_ARROW_LENGTH;
  const baseY = tip.y - tangentY * PHASE_ARROW_LENGTH;
  const wing1X = baseX + normalX * PHASE_ARROW_HALF_WIDTH;
  const wing1Y = baseY + normalY * PHASE_ARROW_HALF_WIDTH;
  const wing2X = baseX - normalX * PHASE_ARROW_HALF_WIDTH;
  const wing2Y = baseY - normalY * PHASE_ARROW_HALF_WIDTH;
  return `M ${tip.x},${tip.y} L ${wing1X},${wing1Y} L ${wing2X},${wing2Y} Z`;
}

function phaseEdgeSortKey(edge: Pick<FlowVisualEdge, "id" | "label" | "source" | "target" | "tone">): string {
  return `${edge.source}:${edge.target}:${edge.tone}:${edge.label}:${edge.id}`;
}

async function calculateOrganizedPhaseLayout(
  nodes: PhaseFlowNode[],
  edges: FlowVisualEdge[]
): Promise<OrganizedPhaseLayout> {
  const elk = await getElkLayoutEngine();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const ranks = buildPhaseNodeRanks(nodes);
  const layoutEdges = edges.filter((edge) => shouldUseEdgeForAutoLayout(edge, nodeById, ranks));
  const graph: ElkNode = {
    id: "phase-flow",
    children: nodes.map((node) => {
      const margin = phaseLayoutNodeMargin(node);
      return {
        id: node.id,
        width: nodeWidth(node),
        height: nodeHeight(node),
        layoutOptions: {
          "elk.margins": `[top=${margin},left=${margin},bottom=${margin},right=${margin}]`
        }
      };
    }),
    edges: layoutEdges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target]
    })),
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.aspectRatio": "2.2",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.edgeStraightening": "IMPROVE_STRAIGHTNESS",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "26",
      "elk.layered.spacing.edgeNodeBetweenLayers": "72",
      "elk.layered.spacing.nodeNodeBetweenLayers": "148",
      "elk.layered.thoroughness": "24",
      "elk.spacing.edgeEdge": "20",
      "elk.spacing.edgeNode": "38",
      "elk.layered.wrapping.cutting.strategy": "MSD",
      "elk.layered.wrapping.additionalEdgeSpacing": "36",
      "elk.layered.wrapping.strategy": "MULTI_EDGE",
      "elk.padding": `[top=${ORGANIZED_GRAPH_PADDING},left=${ORGANIZED_GRAPH_PADDING},bottom=${ORGANIZED_GRAPH_PADDING},right=${ORGANIZED_GRAPH_PADDING}]`,
      "elk.spacing.nodeNode": "92"
    }
  };
  const laidOut = await elk.layout(graph);
  const positioned = new Map<string, { x: number; y: number }>();
  for (const child of laidOut.children ?? []) {
    if (typeof child.x === "number" && typeof child.y === "number") {
      positioned.set(child.id, { x: child.x, y: child.y });
    }
  }
  const normalization = layoutNormalization(positioned);
  return {
    positions: normalizePositions(positioned, normalization),
    routes: extractElkEdgeRoutes(laidOut.edges ?? [], normalization)
  };
}

function phaseLayoutNodeMargin(node: PhaseFlowNode): number {
  return node.data.kind === "step" ? PHASE_LAYOUT_STEP_MARGIN : PHASE_LAYOUT_COMPACT_MARGIN;
}

function shouldUseEdgeForAutoLayout(edge: FlowVisualEdge, nodeById: Map<string, PhaseFlowNode>, ranks: PhaseNodeRanks): boolean {
  const source = nodeById.get(edge.source);
  const target = nodeById.get(edge.target);
  if (!source || !target) {
    return false;
  }
  const layer = classifyPhaseEdge(edge, source, target, ranks);
  return layer === "decision" || layer === "finish" || layer === "primary";
}

function getElkLayoutEngine(): Promise<ElkLayoutEngine> {
  elkPromise ??= import("elkjs/lib/elk.bundled.js").then(({ default: ElkConstructor }) => new ElkConstructor());
  return elkPromise;
}

function layoutNormalization(positions: Map<string, { x: number; y: number }>): { minX: number; minY: number } {
  if (positions.size === 0) {
    return { minX: 0, minY: 0 };
  }
  const values = [...positions.values()];
  return {
    minX: Math.min(...values.map((position) => position.x)),
    minY: Math.min(...values.map((position) => position.y))
  };
}

function normalizePositions(
  positions: Map<string, { x: number; y: number }>,
  normalization: { minX: number; minY: number }
): Map<string, { x: number; y: number }> {
  return new Map(
    [...positions.entries()].map(([id, position]) => [
      id,
      {
        x: Math.round(position.x - normalization.minX),
        y: Math.round(position.y - normalization.minY)
      }
    ])
  );
}

function extractElkEdgeRoutes(
  edges: NonNullable<ElkNode["edges"]>,
  normalization: { minX: number; minY: number }
): Map<string, Array<{ x: number; y: number }>> {
  const routes = new Map<string, Array<{ x: number; y: number }>>();
  for (const edge of edges) {
    const section = edge.sections?.[0];
    if (!edge.id || !section) {
      continue;
    }
    const points = dedupePoints(
      [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({
        x: Math.round(point.x - normalization.minX),
        y: Math.round(point.y - normalization.minY)
      }))
    );
    if (points.length >= 2) {
      routes.set(edge.id, points);
    }
  }
  return routes;
}

function GraphActionButton({
  active,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  switchControl = false
}: {
  active?: boolean;
  disabled?: boolean;
  icon: typeof Crosshair;
  label: string;
  onClick: () => void;
  switchControl?: boolean;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={switchControl ? Boolean(active) : undefined}
      className="agent-graph-action-button"
      data-active={active ? "true" : "false"}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) {
          onClick();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      title={label}
      type="button"
    >
      <Icon className="size-4" strokeWidth={1.8} />
    </button>
  );
}

function readStoredPositions(key: string): Map<string, { x: number; y: number }> {
  if (typeof window === "undefined") {
    return new Map();
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, { x: number; y: number }>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function storePositions(key: string, nodes: PhaseFlowNode[]): void {
  if (typeof window === "undefined") {
    return;
  }
  const values: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    values[node.id] = node.position;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Sandboxed MCP hosts can deny storage; layout still works in memory.
  }
}
