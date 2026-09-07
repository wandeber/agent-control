"use client";

import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Viewport,
  type NodeChange,
  type ReactFlowInstance
} from "@xyflow/react";
import { Crosshair, LayoutGrid, LocateFixed, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildRelations,
  focusedAgentId,
  primaryAgentRelations
} from "@/lib/graph";
import { buildAgentTeam, projectTeamRelations, bundleAgentConnections, teamLayout, teamBounds, keepExternalCardsOutsideTeam } from "@/lib/team-graph";
import { AgentConnectionOverlay } from "./agent-connection-overlay";
import { agentPresentation } from "@/lib/agent-presentation";
import type { DashboardSnapshot } from "@/lib/types";
import { AgentNode, type AgentFlowNode, type AgentNodeData } from "./agent-node";

// Keep per-run camera state while the router unmounts the console screen.
const savedCameras = new Map<string, { viewport: Viewport; follow: boolean }>();

const nodeTypes = { agent: AgentNode };
const GRAPH_MIN_ZOOM = 0.22;
const GRAPH_MAX_ZOOM = 1.75;
const SAFE_AREA_MARGIN = 16;
const SAFE_AREA_PADDING = 28;
const DEFAULT_NODE_WIDTH = 300;
const DEFAULT_NODE_HEIGHT = 132;
const FOLLOW_ACTIVE_MAX_ZOOM = 1.12;
const FOLLOW_ACTIVE_MIN_ZOOM = 0.72;
const FOLLOW_ACTIVE_PADDING_X = 300;
const FOLLOW_ACTIVE_PADDING_Y = 190;
type RelationFlowEdge = Edge;

export function AgentGraph({
  snapshot,
  selectedAgentId,
  onSelectAgent,
  onClearSelection,
  onOpenConversation,
  toolbarLeading
}: {
  snapshot: DashboardSnapshot;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onClearSelection?: () => void;
  onOpenConversation?: (agentId: string) => void;
  toolbarLeading?: React.ReactNode;
}) {
  const relations = useMemo(() => buildRelations(snapshot), [snapshot]);
  const primary = useMemo(() => primaryAgentRelations(snapshot, relations), [snapshot, relations]);
  const focusId = focusedAgentId(snapshot, selectedAgentId);
  const team = useMemo(() => buildAgentTeam(snapshot.agents), [snapshot.agents]);
  const projectedRelations = useMemo(() => projectTeamRelations(team, relations, primary), [team, relations, primary]);
  const [nodes, setNodes] = useState<AgentFlowNode[]>([]);
  const cameraKey = snapshot.selected_run_id ?? "none";
  const initialCamera = useRef(savedCameras.get(cameraKey));
  const [follow, setFollow] = useState(initialCamera.current?.follow ?? true);
  const followRef = useRef(follow);
  followRef.current = follow;
  const [flowReady, setFlowReady] = useState(false);
  const flowRef = useRef<ReactFlowInstance<AgentFlowNode, RelationFlowEdge> | null>(null);
  const graphRootRef = useRef<HTMLDivElement | null>(null);
  const positionedRunRef = useRef<string | null>(null);
  const programmaticViewportRef = useRef(false);
  useEffect(() => {
    const saved = savedCameras.get(cameraKey);
    if (saved) savedCameras.set(cameraKey, { ...saved, follow });
    return () => {
      const viewport = flowRef.current?.getViewport();
      if (viewport) savedCameras.set(cameraKey, { viewport, follow: followRef.current });
    };
  }, [cameraKey, follow]);
  const storageKey = `agent-control:graph:v3:${snapshot.selected_run_id ?? "none"}`;

  useEffect(() => {
    const stored = readStoredPositions(storageKey);
    const layout = teamLayout(snapshot, primary, team);
    const sameRun = positionedRunRef.current === storageKey;
    positionedRunRef.current = storageKey;
    setNodes((current) => keepExternalCardsOutsideTeam(snapshot.agents.map((agent) => {
      const previous = sameRun ? current.find((node) => node.id === agent.agent_id) : undefined;
      return {
        ...previous,
        id: agent.agent_id,
        type: "agent",
        focusable: false,
        position: previous?.position ?? stored.get(agent.agent_id) ?? layout.get(agent.agent_id) ?? { x: 0, y: 0 },
        data: { agent, presentation: agentPresentation(snapshot, agent), selected: agent.agent_id === focusId, onSelect: () => onSelectAgent(agent.agent_id) }
      };
    }), team));
  }, [primary, focusId, snapshot, storageKey, onSelectAgent, team]);

  const connections = useMemo(() => bundleAgentConnections(
    projectedRelations, focusId, false
  ), [projectedRelations, focusId]);

  const onNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      setNodes((current) => {
        const next = keepExternalCardsOutsideTeam(applyNodeChanges<AgentFlowNode>(changes, current), team);
        storePositions(storageKey, next);
        return next;
      });
    },
    [storageKey, team]
  );

  const disableFollow = useCallback(() => {
    if (programmaticViewportRef.current) {
      return;
    }
    setFollow(false);
  }, []);

  const fitGraphToSafeArea = useCallback((duration = 450, focusActive = false) => {
    const flow = flowRef.current;
    const graphRoot = graphRootRef.current;
    const fittedNodes = flow?.getNodes() ?? [];
    if (!flow || !graphRoot || fittedNodes.length === 0) {
      return;
    }

    const cardArea = flow.getNodesBounds(fittedNodes);
    const frame = teamBounds(fittedNodes, team)?.frame;
    const bounds = frame ? {
      x: Math.min(cardArea.x, frame.x), y: Math.min(cardArea.y, frame.y - 20),
      width: Math.max(cardArea.x + cardArea.width, frame.x + frame.width) - Math.min(cardArea.x, frame.x),
      height: Math.max(cardArea.y + cardArea.height, frame.y + frame.height) - Math.min(cardArea.y, frame.y - 20)
    } : cardArea;
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
  }, [team]);

  const organizeGraph = useCallback(() => {
    const layout = teamLayout(snapshot, primary, team);
    setFollow(false);
    setNodes((current) => {
      const arranged = current.map((node) => ({ ...node, position: layout.get(node.id) ?? node.position }));
      storePositions(storageKey, arranged);
      return arranged;
    });
    window.setTimeout(() => fitGraphToSafeArea(), 80);
  }, [snapshot, primary, storageKey, fitGraphToSafeArea, team]);

  useEffect(() => {
    if (follow && flowReady) {
      const timer = setTimeout(() => fitGraphToSafeArea(450, true), 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [focusId, fitGraphToSafeArea, flowReady, follow, nodes.length, connections.length, selectedAgentId]);

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
          defaultViewport={initialCamera.current?.viewport}
          edges={[]}
          maxZoom={GRAPH_MAX_ZOOM}
          minZoom={GRAPH_MIN_ZOOM}
          nodes={nodes}
          nodeTypes={nodeTypes}
          onInit={(instance) => {
            flowRef.current = instance;
            setFlowReady(true);
          }}
          onMoveStart={(event) => { if (event) setFollow(false); else disableFollow(); }}
          onMove={(_, viewport) => savedCameras.set(cameraKey, { viewport, follow: followRef.current })}
          onNodeClick={(_, node) => onSelectAgent(node.id)}
          onNodeDoubleClick={(_, node) => onOpenConversation?.(node.id)}
          zoomOnDoubleClick={false}
          onPaneClick={onClearSelection}
          onNodeDragStart={disableFollow}
          onNodesChange={onNodesChange}
          onlyRenderVisibleElements={false}
          panOnDrag
          proOptions={{ hideAttribution: true }}
        >
          <AgentConnectionOverlay nodes={nodes} connections={connections} team={team} />
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
