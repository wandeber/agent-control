"use client";

import { ViewportPortal } from "@xyflow/react";
import { Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RELATION_META, TEAM_NODE_ID } from "@/lib/graph";
import { routeConnections } from "@/lib/connection-routing";
import { teamBounds, type AgentConnection, type AgentTeam, type TeamRelation } from "@/lib/team-graph";
import type { AgentFlowNode } from "./agent-node";

type OpenConnection = { id: string; x: number; y: number; pinned: boolean };

export function AgentConnectionOverlay({ nodes, connections, team }: {
  nodes: AgentFlowNode[]; connections: AgentConnection[]; team: AgentTeam | null;
}) {
  const bounds = teamBounds(nodes, team);
  const [open, setOpen] = useState<OpenConnection | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<SVGGElement | null>(null);
  const rendered = useMemo(() => routeConnections(connections, nodes, team), [connections, nodes, team]);
  const active = connections.find((connection) => connection.id === open?.id);
  const name = (id: string) => id === TEAM_NODE_ID ? "Team" : nodes.find((node) => node.id === id)?.data.presentation.title ?? "Agent";
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const closeLater = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen((current) => current?.pinned ? current : null), 180);
  };
  const show = (edge: AgentConnection, target: SVGGElement, pinned: boolean, point?: { x: number; y: number }) => {
    cancelClose();
    const rect = target.getBoundingClientRect();
    if (!open?.pinned || pinned) triggerRef.current = target;
    setOpen((current) => current?.pinned && !pinned ? current : {
      id: edge.id, x: point?.x ?? rect.x + rect.width / 2, y: point?.y ?? rect.y + rect.height / 2, pinned
    });
  };

  useEffect(() => {
    if (open && !active) setOpen(null);
  }, [active, open]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && popoverRef.current) { triggerRef.current?.focus(); setOpen(null); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { cancelClose(); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);

  return <>
    <ViewportPortal>
      {bounds && team ? <>
        <div aria-hidden="true" data-team-frame className="pointer-events-none absolute rounded-3xl border border-slate-300/80 bg-slate-100/40"
          style={{ left: bounds.frame.x, top: bounds.frame.y, width: bounds.frame.width, height: bounds.frame.height }} />
        <div className="pointer-events-none absolute flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white text-sm font-semibold text-ink-700 shadow-sm"
          data-team-header role="group" aria-label={`Team, ${team.members.length} agents`}
          style={{ left: bounds.header.position.x, top: bounds.header.position.y, width: 220, height: 40 }}>
          <Users className="size-4 text-ink-400" /> Team <span className="text-xs font-normal text-ink-400">{team.members.length} agents</span>
        </div>
      </> : null}
      <div className="agent-relation-layer">
        <svg className="pointer-events-none absolute left-0 top-0 size-px overflow-visible">
          {rendered.map((edge) => <g key={edge.id} role="button" tabIndex={0} aria-haspopup="dialog" style={{ outline: "none" }}
            aria-label={`${name(edge.source)} ${edge.arrowAtSource && edge.arrowAtTarget ? "↔" : edge.arrowAtSource ? "←" : "→"} ${name(edge.target)}: ${edge.relations.length} ${edge.relations.length === 1 ? "relationship" : "relationships"}`}
            aria-expanded={open?.id === edge.id} data-connection-id={edge.id}
            onMouseEnter={(event) => show(edge, event.currentTarget, false, { x: event.clientX, y: event.clientY })}
            onMouseLeave={closeLater} onFocus={(event) => show(edge, event.currentTarget, false)} onBlur={closeLater}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); show(edge, event.currentTarget, true, { x: event.clientX, y: event.clientY }); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); show(edge, event.currentTarget, true); }
            }}>
            <path d={edge.path} fill="none" stroke="transparent" strokeWidth={18} pointerEvents="stroke" className="cursor-pointer" />
            <path d={edge.path} fill="none" stroke={open?.id === edge.id ? "#0f766e" : "#778594"} strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" />
            {edge.arrowAtSource ? <path data-arrow="source" d={edge.startArrow} fill="#778594" /> : null}
            {edge.arrowAtTarget ? <path data-arrow="target" d={edge.endArrow} fill="#778594" /> : null}
          </g>)}
        </svg>
      </div>
    </ViewportPortal>
    {open && active ? createPortal(<div ref={popoverRef} role="dialog" aria-label="Relationships" data-connection-popover
      className="fixed z-[100] w-[340px] max-w-[calc(100vw-24px)] rounded-xl border border-slate-200 bg-white p-4 text-xs text-ink-700 shadow-xl"
      onMouseEnter={cancelClose} onMouseLeave={closeLater}
      style={{ left: Math.max(12, Math.min(open.x + 12, window.innerWidth - 352)), top: Math.max(12, Math.min(open.y + 12, window.innerHeight - 330)) }}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div><div className="text-sm font-semibold">{name(active.source)} · {name(active.target)}</div>
          <div className="mt-1 text-[11px] text-ink-400">{open.pinned ? "Connection details" : "Click the line to keep this open"}</div></div>
        <button className="rounded p-1 hover:bg-slate-100" aria-label="Close relationships" onClick={() => { triggerRef.current?.focus(); setOpen(null); }}><X className="size-4" /></button>
      </div>
      <div className="max-h-60 space-y-3 overflow-y-auto">
        {active.relations.map((relation) => <RelationshipDetail key={relation.id} relation={relation} name={name} />)}
      </div>
    </div>, document.body) : null}
  </>;
}

function RelationshipDetail({ relation, name }: { relation: TeamRelation; name: (id: string) => string }) {
  return <div className="border-t border-slate-100 pt-2">
    <div className="font-medium">{name(relation.source)} → {name(relation.target)}</div>
    <div className="mt-0.5">{RELATION_META[relation.type].label}</div>
    {relation.scope === "run" ? <div className="mt-1 text-ink-400">{relation.label} · Run-wide, including future members</div> :
      relation.originalRelations ? <>
        <div className="mt-1 text-ink-400">All {relation.members?.length} current team members</div>
        <ul className="mt-1 space-y-1 text-ink-400">{relation.originalRelations.map((original) => <li key={original.id}>
          {name(original.source)} → {name(original.target)}: {original.label}
        </li>)}</ul>
      </> : relation.label !== RELATION_META[relation.type].label ? <div className="mt-1 text-ink-400">{relation.label}</div> : null}
  </div>;
}
