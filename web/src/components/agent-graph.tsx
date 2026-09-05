"use client";

import {
  Background,
  Controls,
  MiniMap,
  Position,
  ReactFlow,
  ViewportPortal,
  applyNodeChanges,
  type Edge,
  type NodeChange,
  type ReactFlowInstance
} from "@xyflow/react";
import { Check, Crosshair, LayoutGrid, Layers3, LocateFixed, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildRelations,
  focusedAgentId,
  primaryAgentRelations,
  visibleAgentRelations,
  initialLayout,
  RELATION_META,
  RENDERABLE_RELATION_TYPES,
  type GraphRelation,
  type RenderableAgentLinkType
} from "@/lib/graph";
import { routeAgentConnection, agentRoutePath, agentRouteLabel, fitAgentPortShifts } from "@/lib/agent-routing";
import { agentPresentation } from "@/lib/agent-presentation";
import type { DashboardSnapshot } from "@/lib/types";
import { AgentNode, type AgentFlowNode, type AgentNodeData } from "./agent-node";

const nodeTypes = { agent: AgentNode };
const ALL_LAYERS: RenderableAgentLinkType[] = RENDERABLE_RELATION_TYPES;
const GRAPH_MIN_ZOOM = 0.22;
const GRAPH_MAX_ZOOM = 1.75;
const SAFE_AREA_MARGIN = 16;
const SAFE_AREA_PADDING = 28;
const PARALLEL_EDGE_GAP = 24;
const ANCHOR_FAN_GAP = 18;
const MAX_ANCHOR_FAN_SHIFT = 54;
const EDGE_ARROW_LENGTH = 14;
const EDGE_ARROW_HALF_WIDTH = 5;
const DEFAULT_NODE_WIDTH = 300;
const DEFAULT_NODE_HEIGHT = 132;
const FOLLOW_ACTIVE_MAX_ZOOM = 1.12;
const FOLLOW_ACTIVE_MIN_ZOOM = 0.72;
const FOLLOW_ACTIVE_PADDING_X = 300;
const FOLLOW_ACTIVE_PADDING_Y = 190;
const RELATION_ANCHOR_SIDES: FloatingSide[] = ["left", "right", "top", "bottom"];

type RelationFlowEdge = Edge;
type FloatingSide = "bottom" | "left" | "right" | "top";
type RoutedRelation = GraphRelation & {
  parallelOffset: number;
  route: RelationRoute;
};
type RoutedEndpoint = {
  agentId: string;
  endpoint: "source" | "target";
  otherAgentId: string;
  relation: RoutedRelation;
  side: FloatingSide;
};

type RelationRoute = {
  flexible: boolean;
  sourceHandle: string;
  sourceSide: FloatingSide;
  sourceTangentShift: number;
  targetHandle: string;
  targetSide: FloatingSide;
  targetTangentShift: number;
};

export function AgentGraph({
  snapshot,
  selectedAgentId,
  onSelectAgent,
  onClearSelection,
  toolbarLeading
}: {
  snapshot: DashboardSnapshot;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onClearSelection?: () => void;
  toolbarLeading?: React.ReactNode;
}) {
  const relations = useMemo(() => buildRelations(snapshot), [snapshot]);
  const primary = useMemo(() => primaryAgentRelations(snapshot, relations), [snapshot, relations]);
  const focusId = focusedAgentId(snapshot, selectedAgentId);
  const [allRelations, setAllRelations] = useState(false);
  const [layers, setLayers] = useState<Set<RenderableAgentLinkType>>(() => new Set(ALL_LAYERS));
  const [layersOpen, setLayersOpen] = useState(false);
  const [nodes, setNodes] = useState<AgentFlowNode[]>([]);
  const [follow, setFollow] = useState(true);
  const [flowReady, setFlowReady] = useState(false);
  const flowRef = useRef<ReactFlowInstance<AgentFlowNode, RelationFlowEdge> | null>(null);
  const graphRootRef = useRef<HTMLDivElement | null>(null);
  const positionedRunRef = useRef<string | null>(null);
  const layerPopoverRef = useRef<HTMLDivElement | null>(null);
  const programmaticViewportRef = useRef(false);
  const storageKey = `agent-control:graph:v2:${snapshot.selected_run_id ?? "none"}`;

  useEffect(() => {
    const stored = readStoredPositions(storageKey);
    const layout = initialLayout(snapshot.agents, primary, snapshot);
    const sameRun = positionedRunRef.current === storageKey;
    positionedRunRef.current = storageKey;
    setNodes((current) => snapshot.agents.map((agent) => {
      const previous = sameRun ? current.find((node) => node.id === agent.agent_id) : undefined;
      return {
        ...previous,
        id: agent.agent_id,
        type: "agent",
        focusable: false,
        position: previous?.position ?? stored.get(agent.agent_id) ?? layout.get(agent.agent_id) ?? { x: 0, y: 0 },
        data: { agent, presentation: agentPresentation(snapshot, agent), selected: agent.agent_id === focusId, onSelect: () => onSelectAgent(agent.agent_id) }
      };
    }));
  }, [primary, focusId, snapshot, storageKey, onSelectAgent]);

  const visibleRelations = useMemo(
    () => assignParallelOffsets(visibleAgentRelations(relations.filter((relation) => layers.has(relation.type)), primary, focusId, allRelations)),
    [layers, relations, primary, focusId, allRelations]
  );
  const routedRelations = useMemo(() => assignAnchorRoutes(visibleRelations, nodes), [nodes, visibleRelations]);

  const onNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      setNodes((current) => {
        const next = applyNodeChanges<AgentFlowNode>(changes, current);
        storePositions(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const disableFollow = useCallback(() => {
    if (programmaticViewportRef.current) {
      return;
    }
    setFollow(false);
  }, []);

  const toggleLayer = useCallback((layer: RenderableAgentLinkType) => {
    setLayers((current) => {
      const next = new Set(current);
      if (next.has(layer)) {
        next.delete(layer);
      } else {
        next.add(layer);
      }
      return next;
    });
  }, []);

  const fitGraphToSafeArea = useCallback((duration = 450, focusActive = false) => {
    const flow = flowRef.current;
    const graphRoot = graphRootRef.current;
    const fittedNodes = flow?.getNodes() ?? [];
    if (!flow || !graphRoot || fittedNodes.length === 0) {
      return;
    }

    const bounds = flow.getNodesBounds(fittedNodes);
    const safeArea = getLargestGraphSafeArea(graphRoot);
    const availableWidth = Math.max(1, safeArea.width - SAFE_AREA_PADDING * 2);
    const availableHeight = Math.max(1, safeArea.height - SAFE_AREA_PADDING * 2);
    const boundedWidth = Math.max(1, bounds.width);
    const boundedHeight = Math.max(1, bounds.height);
    const rawZoom = Math.min(availableWidth / boundedWidth, availableHeight / boundedHeight);
    const focusedNode = focusActive
      ? (fittedNodes.find((node) => node.data.selected) ??
        fittedNodes.find((node) => isFollowFocusAgentStatus(node.data.agent.status)) ??
        null)
      : null;
    const focusedWidth = focusedNode?.measured?.width ?? DEFAULT_NODE_WIDTH;
    const focusedHeight = focusedNode?.measured?.height ?? DEFAULT_NODE_HEIGHT;
    const zoom = focusedNode
      ? clamp(
          Math.min(
            availableWidth / Math.max(1, focusedWidth + FOLLOW_ACTIVE_PADDING_X),
            availableHeight / Math.max(1, focusedHeight + FOLLOW_ACTIVE_PADDING_Y)
          ),
          FOLLOW_ACTIVE_MIN_ZOOM,
          FOLLOW_ACTIVE_MAX_ZOOM
        )
      : clamp(rawZoom, GRAPH_MIN_ZOOM, GRAPH_MAX_ZOOM);
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

  const organizeGraph = useCallback(() => {
    const layout = initialLayout(snapshot.agents, primary, snapshot);
    setFollow(false);
    setNodes((current) => {
      const arranged = current.map((node) => ({ ...node, position: layout.get(node.id) ?? node.position }));
      storePositions(storageKey, arranged);
      return arranged;
    });
    window.setTimeout(() => fitGraphToSafeArea(), 80);
  }, [snapshot, primary, storageKey, fitGraphToSafeArea]);

  useEffect(() => {
    if (!layersOpen) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!layerPopoverRef.current?.contains(event.target as Node)) {
        setLayersOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLayersOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [layersOpen]);

  useEffect(() => {
    if (follow && flowReady) {
      const timer = setTimeout(() => fitGraphToSafeArea(450, true), 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [focusId, fitGraphToSafeArea, flowReady, follow, nodes.length, routedRelations.length, selectedAgentId]);

  useEffect(() => {
    const graphRoot = graphRootRef.current;
    if (!follow || !flowReady || !graphRoot) {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => fitGraphToSafeArea(260, true));
    });
    observer.observe(graphRoot);
    return () => observer.disconnect();
  }, [fitGraphToSafeArea, flowReady, follow]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden" ref={graphRootRef}>
      <div className="agent-graph-toolbar absolute z-20 flex max-w-[calc(100%-112px)] items-center justify-between gap-2">
        {toolbarLeading}
        <div className="relative" ref={layerPopoverRef}>
          <button
            aria-expanded={layersOpen}
            aria-haspopup="menu"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-black/10 bg-white/82 px-3 text-xs font-semibold text-ink-700 shadow-panel backdrop-blur-xl transition hover:border-black/20 hover:bg-white"
            onClick={() => setLayersOpen((open) => !open)}
            type="button"
          >
            <Layers3 className="size-4 text-ink-400" />
            Relations
            <span className="rounded bg-black/6 px-1.5 py-0.5 text-[10px] font-semibold text-ink-400">
              {allRelations ? "All" : "Focused"}
            </span>
          </button>

          {layersOpen ? (
            <div
              className="absolute left-0 top-[calc(100%+8px)] z-30 w-80 rounded-lg bg-white/98 p-3 shadow-[0_18px_48px_rgba(15,23,42,0.16)] backdrop-blur-xl"
              role="menu"
            >
              <div className="px-2 pb-2 pt-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-300">Relationship layers</div>
                <div className="mt-0.5 text-[11px] leading-4 text-ink-400">Full relations for the focused agent; main connections for the others.</div>
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-ink-700">
                  <input type="checkbox" checked={allRelations} onChange={(event) => setAllRelations(event.target.checked)} />
                  Show all relationships
                </label>
              </div>
              <div className="mt-1 space-y-1">
                {ALL_LAYERS.map((layer) => (
                  <LayerMenuItem
                    active={layers.has(layer)}
                    key={layer}
                    layer={layer}
                    onToggle={() => toggleLayer(layer)}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>

      </div>

      <div className="agent-graph-actions absolute z-20">
        <div className="agent-graph-action-group" role="group" aria-label="Graph viewport controls">
          <GraphActionButton
            active={follow}
            icon={LocateFixed}
            label={follow ? "Disable follow focused agent" : "Follow focused agent"}
            onClick={() => setFollow((value) => !value)}
            switchControl
          />
          <GraphActionButton icon={Crosshair} label="Fit graph" onClick={() => { setFollow(false); fitGraphToSafeArea(); }} />
          <GraphActionButton icon={LayoutGrid} label="Organize agents" onClick={organizeGraph} />
        </div>
      </div>

      <div className="absolute inset-0">
        <ReactFlow<AgentFlowNode, RelationFlowEdge>
          edges={[]}
          maxZoom={GRAPH_MAX_ZOOM}
          minZoom={GRAPH_MIN_ZOOM}
          nodes={nodes}
          nodeTypes={nodeTypes}
          onInit={(instance) => {
            flowRef.current = instance;
            setFlowReady(true);
          }}
          onMoveStart={disableFollow}
          onNodeClick={(_, node) => onSelectAgent(node.id)}
          onPaneClick={onClearSelection}
          onNodeDragStart={disableFollow}
          onNodesChange={onNodesChange}
          onlyRenderVisibleElements={false}
          panOnDrag
          proOptions={{ hideAttribution: true }}
        >
          <GraphRelationOverlay nodes={nodes} relations={routedRelations} />
          <Background gap={22} size={1} />
          <Controls onFitView={() => { setFollow(false); fitGraphToSafeArea(); }} position="bottom-left" showInteractive={false} />
          <MiniMap
            maskColor="rgba(238, 242, 246, 0.68)"
            nodeBorderRadius={8}
            nodeColor={(node) => {
              const status = (node.data as AgentNodeData).agent.status;
              if (status === "planned") return "#a78bfa";
              if (status === "running") return "#14b8a6";
              if (status === "waiting_for_input") return "#f59e0b";
              if (status === "completed") return "#84cc16";
              if (status === "failed" || status === "blocked") return "#fb6b5f";
              return "#94a3b8";
            }}
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

function GraphActionButton({
  active,
  icon: Icon,
  label,
  onClick,
  switchControl = false
}: {
  active?: boolean;
  icon: LucideIcon;
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
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      title={label}
      type="button"
    >
      <Icon className="size-4" strokeWidth={1.8} />
    </button>
  );
}

function GraphRelationOverlay({ nodes, relations }: { nodes: AgentFlowNode[]; relations: RoutedRelation[] }) {
  const [hoveredRelation, setHoveredRelation] = useState<string | null>(null);
  const rendered = relations
    .map((relation) => relationPathData(relation, nodes))
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge));

  return (
    <ViewportPortal>
      <div className="agent-relation-layer">
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 size-px overflow-visible"
        >
          {rendered.map((edge) => (
            <g data-relation-type={edge.relationType} data-focused={edge.emphasized} key={edge.id}>
              <title>{edge.details}</title>
              {/* Keep labels on demand so parallel routes remain readable. */}
              <path
                d={edge.path}
                fill="none"
                stroke="transparent"
                strokeWidth={16}
                pointerEvents="stroke"
                onMouseEnter={() => setHoveredRelation(edge.id)}
                onMouseLeave={() => setHoveredRelation(null)}
              />
              <path
                d={edge.path}
                fill="none"
                opacity={edge.emphasized ? 1 : 0.65}
                stroke={edge.color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={edge.strokeWidth}
              />
              {edge.directed ? (
                <path aria-hidden="true" data-edge-arrow={edge.relationType} d={edge.arrow} fill={edge.color} />
              ) : null}
            </g>
          ))}
        </svg>
        {rendered.map((edge) =>
          edge.label && hoveredRelation === edge.id ? (
            <div
              className="pointer-events-none absolute max-w-44 truncate rounded bg-white/95 px-2 py-1 text-[11px] font-medium text-ink-600 shadow-[0_0_0_1px_rgba(21,25,29,0.08)]"
              title={edge.details}
              data-parallel-offset={edge.parallelOffset}
              data-relation-type={edge.relationType}
              data-source-tangent-shift={edge.sourceTangentShift}
              data-target-tangent-shift={edge.targetTangentShift}
              key={`${edge.id}-label`}
              style={{
                transform: `translate(-50%, -50%) translate(${edge.labelPoint.x}px, ${edge.labelPoint.y}px)`
              }}
            >
              {edge.label}
            </div>
          ) : null
        )}
      </div>
    </ViewportPortal>
  );
}

function relationPathData(relation: RoutedRelation, nodes: AgentFlowNode[]) {
  const sourceNode = nodes.find((node) => node.id === relation.source);
  const targetNode = nodes.find((node) => node.id === relation.target);
  if (!sourceNode || !targetNode) {
    return null;
  }

  const meta = RELATION_META[relation.type];
  const sourceHandle = relation.route.sourceHandle;
  const targetHandle = relation.route.targetHandle;
  const resolvedSourcePosition = positionForHandle(sourceHandle, undefined);
  const resolvedTargetPosition = positionForHandle(targetHandle, undefined);
  const sourceAnchor = sideAnchor(sourceNode, relation.route.sourceSide);
  const targetAnchor = sideAnchor(targetNode, relation.route.targetSide);
  const sourceDirection = directionForPosition(resolvedSourcePosition);
  const targetDirection = directionForPosition(resolvedTargetPosition);
  const sourceTangent = tangentForPosition(resolvedSourcePosition);
  const targetTangent = tangentForPosition(resolvedTargetPosition);
  const start = { x: sourceAnchor.x + sourceTangent.x * relation.route.sourceTangentShift, y: sourceAnchor.y + sourceTangent.y * relation.route.sourceTangentShift };
  const end = { x: targetAnchor.x + targetTangent.x * relation.route.targetTangentShift, y: targetAnchor.y + targetTangent.y * relation.route.targetTangentShift };
  const points = routeAgentConnection(start, end, sourceDirection, targetDirection, nodes.map((node) => ({
    ...node.position, width: node.measured?.width ?? DEFAULT_NODE_WIDTH, height: node.measured?.height ?? DEFAULT_NODE_HEIGHT
  })), relation.parallelOffset);
  if (points.length < 2) return null;
  const arrow = makeArrowPath(points.at(-1)!, points.at(-2)!);
  const labelPoint = agentRouteLabel(points);
  const path = agentRoutePath(points);

  return {
    arrow,
    color: relation.emphasized ? meta.color : "#94a3b8",
    emphasized: relation.emphasized,
    details: relation.details,
    directed: Boolean(meta.directed),
    id: relation.id,
    label: relation.label,
    labelPoint,
    parallelOffset: relation.parallelOffset,
    path,
    relationType: relation.type,
    sourceTangentShift: relation.route.sourceTangentShift,
    strokeWidth: relation.emphasized ? 2.5 : 1.8,
    targetTangentShift: relation.route.targetTangentShift
  };
}

function assignAnchorRoutes(
  relations: Array<GraphRelation & { parallelOffset: number }>,
  nodes: AgentFlowNode[]
): RoutedRelation[] {
  const routed = relations.map((relation) => ({
    ...relation,
    route: getRelationRoute(relation, nodes)
  }));

  applyAnchorFanoutShifts(routed, nodes);
  return routed;
}

function getRelationRoute(relation: GraphRelation, nodes: AgentFlowNode[]): RelationRoute {
  const source = nodes.find((node) => node.id === relation.source);
  const target = nodes.find((node) => node.id === relation.target);
  if (!source || !target) {
    return defaultInputOutputRoute();
  }

  const { sourceSide, targetSide } = chooseInputOutputSides(source, target);
  return {
    flexible: true,
    sourceHandle: `source-${sourceSide}`,
    sourceSide,
    sourceTangentShift: 0,
    targetHandle: `target-${targetSide}`,
    targetSide,
    targetTangentShift: 0
  };
}

function defaultInputOutputRoute(): RelationRoute {
  return {
    flexible: true,
    sourceHandle: "source-right",
    sourceSide: "right",
    sourceTangentShift: 0,
    targetHandle: "target-left",
    targetSide: "left",
    targetTangentShift: 0
  };
}

function chooseInputOutputSides(
  source: AgentFlowNode,
  target: AgentFlowNode
): { sourceSide: FloatingSide; targetSide: FloatingSide } {
  const sourceCenter = nodeCenter(source);
  const targetCenter = nodeCenter(target);
  const flowVector = normalizeVector({
    x: targetCenter.x - sourceCenter.x,
    y: targetCenter.y - sourceCenter.y
  });
  const targetToSourceVector = { x: -flowVector.x, y: -flowVector.y };
  let best: { sourceSide: FloatingSide; targetSide: FloatingSide; score: number } | null = null;

  for (const sourceSide of RELATION_ANCHOR_SIDES) {
    for (const targetSide of RELATION_ANCHOR_SIDES) {
      const sourceAnchor = sideAnchor(source, sourceSide);
      const targetAnchor = sideAnchor(target, targetSide);
      const dx = targetAnchor.x - sourceAnchor.x;
      const dy = targetAnchor.y - sourceAnchor.y;
      const length = Math.hypot(dx, dy);
      const sourceDirection = directionForSide(sourceSide);
      const targetDirection = directionForSide(targetSide);
      const sourceAlignment = dot(flowVector, sourceDirection);
      const targetAlignment = dot(targetToSourceVector, targetDirection);
      const axisPenalty = tangentAxis(sourceSide) === tangentAxis(targetSide) ? 0 : 22;
      const score =
        length +
        directionalPenalty(sourceAlignment) +
        directionalPenalty(targetAlignment) +
        axisPenalty;

      if (!best || score < best.score) {
        best = { sourceSide, targetSide, score };
      }
    }
  }

  return best ?? { sourceSide: "right", targetSide: "left" };
}

function applyAnchorFanoutShifts(relations: RoutedRelation[], nodes: AgentFlowNode[]) {
  const groups = new Map<string, RoutedEndpoint[]>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const laneShifts = relationLaneShifts(relations);
  for (const relation of relations) {
    const endpoints: RoutedEndpoint[] = [
      {
        agentId: relation.source,
        endpoint: "source",
        otherAgentId: relation.target,
        relation,
        side: relation.route.sourceSide
      },
      {
        agentId: relation.target,
        endpoint: "target",
        otherAgentId: relation.source,
        relation,
        side: relation.route.targetSide
      }
    ];
    for (const endpoint of endpoints) {
      const key = `${endpoint.agentId}:${endpoint.side}`;
      groups.set(key, [...(groups.get(key) ?? []), endpoint]);
    }
  }

  for (const group of groups.values()) {
    const bundles = bundleEndpoints(group);
    const orderedBundles = [...bundles.values()].sort((a, b) => compareFanoutEndpoints(a[0]!, b[0]!, nodeById));
    const bundleCenters = centeredBundleShifts(orderedBundles.map((bundle) => bundle.length));
    orderedBundles.forEach((bundle, index) => {
      const centerShift = bundleCenters[index] ?? 0;
      for (const endpoint of bundle) {
        const laneShift = laneShifts.get(endpoint.relation.id) ?? 0;
        const shift = clamp(centerShift + laneShift, -MAX_ANCHOR_FAN_SHIFT, MAX_ANCHOR_FAN_SHIFT);
        if (endpoint.endpoint === "source") {
          endpoint.relation.route.sourceTangentShift = shift;
        } else {
          endpoint.relation.route.targetTangentShift = shift;
        }
      }
    });
  }

  alignParallelPairEndpoints(relations);
  for (const group of groups.values()) {
    const node = nodeById.get(group[0]!.agentId);
    if (!node) continue;
    const horizontalEdge = group[0]!.side === "top" || group[0]!.side === "bottom";
    const shifts = fitAgentPortShifts(group.map((endpoint) => endpoint.endpoint === "source"
      ? endpoint.relation.route.sourceTangentShift : endpoint.relation.route.targetTangentShift), horizontalEdge ? nodeWidth(node) : nodeHeight(node));
    group.forEach((endpoint, index) => {
      if (endpoint.endpoint === "source") endpoint.relation.route.sourceTangentShift = shifts[index]!;
      else endpoint.relation.route.targetTangentShift = shifts[index]!;
    });
  }
}

function bundleEndpoints(endpoints: RoutedEndpoint[]): Map<string, RoutedEndpoint[]> {
  const bundles = new Map<string, RoutedEndpoint[]>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.agentId}:${endpoint.side}:${endpoint.otherAgentId}`;
    bundles.set(key, [...(bundles.get(key) ?? []), endpoint]);
  }
  return bundles;
}

function centeredBundleShifts(bundleSizes: number[]): number[] {
  if (bundleSizes.length === 0) {
    return [];
  }
  const widths = bundleSizes.map((size) => Math.max(0, size - 1) * ANCHOR_FAN_GAP);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + (bundleSizes.length - 1) * ANCHOR_FAN_GAP;
  let cursor = -totalWidth / 2;
  return widths.map((width, index) => {
    const center = cursor + width / 2;
    cursor += width + (index === bundleSizes.length - 1 ? 0 : ANCHOR_FAN_GAP);
    return center;
  });
}

function relationLaneShifts(relations: RoutedRelation[]): Map<string, number> {
  const groups = new Map<string, RoutedRelation[]>();
  for (const relation of relations) {
    const key = `${relation.source}:${relation.target}:${relation.route.sourceSide}:${relation.route.targetSide}`;
    groups.set(key, [...(groups.get(key) ?? []), relation]);
  }

  const shifts = new Map<string, number>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => relationSortKey(a).localeCompare(relationSortKey(b)));
    const middle = (ordered.length - 1) / 2;
    ordered.forEach((relation, index) => {
      shifts.set(relation.id, (index - middle) * ANCHOR_FAN_GAP);
    });
  }
  return shifts;
}

function alignParallelPairEndpoints(relations: RoutedRelation[]) {
  const groups = new Map<string, RoutedRelation[]>();
  for (const relation of relations) {
    const key = `${relation.source}:${relation.target}:${relation.route.sourceSide}:${relation.route.targetSide}`;
    groups.set(key, [...(groups.get(key) ?? []), relation]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const sample = group[0]!;
    if (tangentAxis(sample.route.sourceSide) !== tangentAxis(sample.route.targetSide)) {
      continue;
    }
    for (const relation of group) {
      relation.route.targetTangentShift = relation.route.sourceTangentShift;
    }
  }
}

function tangentAxis(side: FloatingSide): "horizontal" | "vertical" {
  return side === "top" || side === "bottom" ? "horizontal" : "vertical";
}

function compareFanoutEndpoints(a: RoutedEndpoint, b: RoutedEndpoint, nodeById: Map<string, AgentFlowNode>): number {
  const aRank = fanoutSortRank(a, nodeById);
  const bRank = fanoutSortRank(b, nodeById);
  if (aRank !== bRank) {
    return aRank - bRank;
  }
  return `${relationSortKey(a.relation)}:${a.endpoint}`.localeCompare(`${relationSortKey(b.relation)}:${b.endpoint}`);
}

function fanoutSortRank(endpoint: RoutedEndpoint, nodeById: Map<string, AgentFlowNode>): number {
  const otherNode = nodeById.get(endpoint.otherAgentId);
  if (!otherNode) {
    return 0;
  }
  const center = nodeCenter(otherNode);
  return endpoint.side === "left" || endpoint.side === "right" ? center.y : center.x;
}

function nodeCenter(node: AgentFlowNode): { x: number; y: number } {
  return {
    x: node.position.x + nodeWidth(node) / 2,
    y: node.position.y + nodeHeight(node) / 2
  };
}

function sideAnchor(node: AgentFlowNode, side: FloatingSide): { x: number; y: number } {
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

function nodeWidth(node: AgentFlowNode): number {
  return node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH;
}

function nodeHeight(node: AgentFlowNode): number {
  return node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT;
}

function relationSortKey(relation: GraphRelation): string {
  return `${relation.source}:${relation.target}:${relation.type}:${relation.label}:${relation.id}`;
}

function directionForPosition(position: Position | undefined): { x: number; y: number } {
  if (position === Position.Left) return { x: -1, y: 0 };
  if (position === Position.Top) return { x: 0, y: -1 };
  if (position === Position.Bottom) return { x: 0, y: 1 };
  return { x: 1, y: 0 };
}

function directionForSide(side: FloatingSide): { x: number; y: number } {
  if (side === "left") return { x: -1, y: 0 };
  if (side === "right") return { x: 1, y: 0 };
  if (side === "top") return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function normalizeVector(vector: { x: number; y: number }): { x: number; y: number } {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

function dot(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return a.x * b.x + a.y * b.y;
}

function directionalPenalty(alignment: number): number {
  return (1 - alignment) * 160;
}

function positionForHandle(handleId: string, fallback: Position | undefined): Position | undefined {
  if (handleId === "in" || handleId.endsWith("-left")) return Position.Left;
  if (handleId === "out" || handleId.endsWith("-right")) return Position.Right;
  if (handleId.endsWith("-top")) return Position.Top;
  if (handleId.endsWith("-bottom")) return Position.Bottom;
  return fallback;
}

function tangentForPosition(position: Position | undefined): { x: number; y: number } {
  if (position === Position.Top || position === Position.Bottom) {
    return { x: 1, y: 0 };
  }
  return { x: 0, y: 1 };
}

function makeArrowPath(tip: { x: number; y: number }, previousControl: { x: number; y: number }): string {
  const dx = tip.x - previousControl.x;
  const dy = tip.y - previousControl.y;
  const length = Math.hypot(dx, dy) || 1;
  const tangentX = dx / length;
  const tangentY = dy / length;
  const normalX = -tangentY;
  const normalY = tangentX;
  const baseX = tip.x - tangentX * EDGE_ARROW_LENGTH;
  const baseY = tip.y - tangentY * EDGE_ARROW_LENGTH;
  const wing1X = baseX + normalX * EDGE_ARROW_HALF_WIDTH;
  const wing1Y = baseY + normalY * EDGE_ARROW_HALF_WIDTH;
  const wing2X = baseX - normalX * EDGE_ARROW_HALF_WIDTH;
  const wing2Y = baseY - normalY * EDGE_ARROW_HALF_WIDTH;
  return `M ${tip.x},${tip.y} L ${wing1X},${wing1Y} L ${wing2X},${wing2Y} Z`;
}

function LayerMenuItem({
  active,
  layer,
  onToggle
}: {
  active: boolean;
  layer: RenderableAgentLinkType;
  onToggle: () => void;
}) {
  return (
    <button
      aria-checked={active}
      className={[
        "grid w-full grid-cols-[18px_minmax(0,1fr)_96px] items-center gap-3 px-2.5 py-2 text-left text-xs font-medium transition",
        active ? "text-ink-900" : "text-ink-500 hover:text-ink-900"
      ].join(" ")}
      onClick={onToggle}
      role="menuitemcheckbox"
      type="button"
    >
      <span
        className={[
          "grid size-[18px] place-items-center transition",
          active ? "text-teal-600" : "text-transparent"
        ].join(" ")}
      >
        <Check className="size-3" strokeWidth={2.4} />
      </span>
      <span className="min-w-0 truncate">{RELATION_META[layer].label}</span>
      <RelationLineSample layer={layer} active={active} />
    </button>
  );
}

function RelationLineSample({ active, layer }: { active: boolean; layer: RenderableAgentLinkType }) {
  const meta = RELATION_META[layer];
  return (
    <svg
      aria-hidden="true"
      className={["h-3 w-24 shrink-0 overflow-visible", active ? "opacity-100" : "opacity-45"].join(" ")}
      focusable="false"
      viewBox="0 0 96 12"
    >
      <line
        stroke={meta.color}
        strokeLinecap="round"
        strokeWidth={layer === "blocks" ? 2.4 : 1.8}
        x1="7"
        x2="89"
        y1="6"
        y2="6"
      />
      <circle cx="7" cy="6" fill={meta.color} r="2" />
      {meta.directed ? (
        <path data-relation-arrow-sample={layer} d="M 90 6 L 80 2.8 L 80 9.2 Z" fill={meta.color} />
      ) : (
        <circle cx="89" cy="6" fill={meta.color} r="2" />
      )}
    </svg>
  );
}

function assignParallelOffsets(relations: GraphRelation[]): Array<GraphRelation & { parallelOffset: number }> {
  const groups = new Map<string, GraphRelation[]>();
  const directedCounts = new Map<string, number>();
  for (const relation of relations) {
    const key = [relation.source, relation.target].sort().join("::");
    groups.set(key, [...(groups.get(key) ?? []), relation]);
    const directedKey = directedRelationKey(relation);
    directedCounts.set(directedKey, (directedCounts.get(directedKey) ?? 0) + 1);
  }

  const offsets = new Map<string, number>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) =>
      `${a.source}:${a.target}:${a.type}:${a.label}:${a.id}`.localeCompare(
        `${b.source}:${b.target}:${b.type}:${b.label}:${b.id}`
      )
    );
    const middle = (ordered.length - 1) / 2;
    ordered.forEach((relation, index) => {
      const hasDirectedSiblings = (directedCounts.get(directedRelationKey(relation)) ?? 0) > 1;
      offsets.set(relation.id, hasDirectedSiblings ? 0 : (index - middle) * PARALLEL_EDGE_GAP);
    });
  }

  return relations.map((relation) => ({
    ...relation,
    parallelOffset: offsets.get(relation.id) ?? 0
  }));
}

function directedRelationKey(relation: Pick<GraphRelation, "source" | "target">): string {
  return `${relation.source}->${relation.target}`;
}

type GraphSafeArea = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type GraphObstacle = GraphSafeArea & {
  zone: "bottom" | "top";
};

function getLargestGraphSafeArea(graphRoot: HTMLDivElement): GraphSafeArea {
  const rootRect = graphRoot.getBoundingClientRect();
  const rootArea = { height: rootRect.height, width: rootRect.width, x: 0, y: 0 };
  if (rootArea.width <= 0 || rootArea.height <= 0) {
    return rootArea;
  }

  const obstacles = getGraphObstacles(graphRoot, rootRect);
  const topClearance = Math.max(
    SAFE_AREA_MARGIN,
    ...obstacles.filter((obstacle) => obstacle.zone === "top").map((obstacle) => obstacle.y + obstacle.height + SAFE_AREA_MARGIN)
  );
  const bottomClearance = Math.min(
    rootArea.height - SAFE_AREA_MARGIN,
    ...obstacles.filter((obstacle) => obstacle.zone === "bottom").map((obstacle) => obstacle.y - SAFE_AREA_MARGIN)
  );

  const bottomLeftClearance = Math.max(
    SAFE_AREA_MARGIN,
    ...obstacles
      .filter((obstacle) => obstacle.zone === "bottom" && obstacle.x < rootArea.width / 2)
      .map((obstacle) => obstacle.x + obstacle.width + SAFE_AREA_MARGIN)
  );
  const bottomRightClearance = Math.min(
    rootArea.width - SAFE_AREA_MARGIN,
    ...obstacles
      .filter((obstacle) => obstacle.zone === "bottom" && obstacle.x + obstacle.width > rootArea.width / 2)
      .map((obstacle) => obstacle.x - SAFE_AREA_MARGIN)
  );

  const candidates = [
    makeSafeArea(SAFE_AREA_MARGIN, topClearance, rootArea.width - SAFE_AREA_MARGIN * 2, bottomClearance - topClearance),
    makeSafeArea(
      bottomLeftClearance,
      topClearance,
      bottomRightClearance - bottomLeftClearance,
      rootArea.height - topClearance - SAFE_AREA_MARGIN
    )
  ].filter((area) => area.width >= 160 && area.height >= 140);

  return candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? makeSafeArea(
    SAFE_AREA_MARGIN,
    topClearance,
    rootArea.width - SAFE_AREA_MARGIN * 2,
    rootArea.height - topClearance - SAFE_AREA_MARGIN
  );
}

function getGraphObstacles(graphRoot: HTMLDivElement, rootRect: DOMRect): GraphObstacle[] {
  const scopedObstacles = [
    [".agent-graph-toolbar", "top"],
    [".agent-graph-actions", "top"],
    [".react-flow__controls", "bottom"],
    [".react-flow__minimap", "bottom"]
  ] as const;
  const globalObstacles = [[".console-top", "top"]] as const;
  return [
    ...scopedObstacles.flatMap(([selector, zone]) =>
      Array.from(graphRoot.querySelectorAll<HTMLElement>(selector)).flatMap((element) => toGraphObstacle(element, rootRect, zone))
    ),
    ...globalObstacles.flatMap(([selector, zone]) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap((element) => toGraphObstacle(element, rootRect, zone))
    )
  ];
}

function toGraphObstacle(element: HTMLElement, rootRect: DOMRect, zone: GraphObstacle["zone"]): GraphObstacle[] {
  const rect = element.getBoundingClientRect();
  const left = Math.max(rootRect.left, rect.left);
  const right = Math.min(rootRect.right, rect.right);
  const top = Math.max(rootRect.top, rect.top);
  const bottom = Math.min(rootRect.bottom, rect.bottom);
  if (right <= left || bottom <= top) {
    return [];
  }
  return [
    {
      height: bottom - top,
      width: right - left,
      x: left - rootRect.left,
      y: top - rootRect.top,
      zone
    }
  ];
}

function makeSafeArea(x: number, y: number, width: number, height: number): GraphSafeArea {
  return { height: Math.max(0, height), width: Math.max(0, width), x, y };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFollowFocusAgentStatus(status: string): boolean {
  return status === "starting" || status === "running" || status === "waiting_for_input" || status === "blocked" || status === "failed";
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

function storePositions(key: string, nodes: AgentFlowNode[]): void {
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
