"use client";

import { Fragment, useState } from "react";
import { Clock3 } from "lucide-react";
import { cx, formatDuration } from "@/lib/format";
import type { DashboardSnapshot } from "@/lib/types";

export function Timeline({
  selectedStepInstanceId,
  snapshot
}: {
  selectedStepInstanceId: string | null;
  snapshot: DashboardSnapshot;
}) {
  const [zoom, setZoom] = useState(1);
  const timeline = snapshot.agent_timeline;
  const start = Date.parse(timeline?.started_at ?? snapshot.generated_at);
  const end = Date.parse(timeline?.ended_at ?? snapshot.generated_at);
  const duration = Math.max(1, end - start);
  const rows = new Map(timeline?.rows.map(row => [row.agent_id, row]));
  const flowByInstanceId = new Map(snapshot.flow_instances.map((instance) => [instance.flow_instance_id, instance]));
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <div className="phase-timeline h-full overflow-auto bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-ink-700"><Clock3 className="size-3.5" /> Agent activity</div>
        <div className="flex items-center gap-2 text-[11px] text-ink-500">
          <span>Filled: working · Gaps: inactive or waiting</span>
          <button type="button" aria-label="Zoom out timeline" disabled={zoom === 1} onClick={() => setZoom(value => Math.max(1, value / 2))} className="timeline-zoom">−</button>
          <button type="button" onClick={() => setZoom(1)} className="timeline-zoom">{zoom === 1 ? "Fit" : `${zoom}×`}</button>
          <button type="button" aria-label="Zoom in timeline" disabled={zoom >= 128} onClick={() => setZoom(value => Math.min(128, value * 2))} className="timeline-zoom">+</button>
        </div>
      </div>
      <div className="activity-timeline-scroll">
        <div className="activity-timeline-grid" style={{ width: `${zoom * 100}%`, minWidth: 560 }}>
          <div className="activity-timeline-label text-[10px] text-ink-400">Agent / working time</div>
          <div className="activity-timeline-ruler">
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <span key={fraction} style={{ left: `${fraction * 100}%`, transform: fraction === 1 ? "translateX(-100%)" : "none" }}>{time(start + duration * fraction)}</span>)}
          </div>
          {snapshot.agents.map(agent => {
            const row = rows.get(agent.agent_id);
            const total = row?.segments.reduce((sum, segment) => sum + Math.max(0, Date.parse(segment.ended_at ?? timeline!.ended_at) - Date.parse(segment.started_at)), 0) ?? 0;
            return <Fragment key={agent.agent_id}>
              <div className="activity-timeline-label" title={`${agent.title} · ${row?.source === "native" ? "Native turn timestamps" : "Observed controller timestamps"}${row?.coverage !== "complete" ? " · Incomplete timing history" : ""}`}>
                <strong>{agent.title}</strong><span>{row?.segments.length ? formatDuration(total) : "Timing unavailable"}{row?.source === "controller" && row.segments.length ? " · observed" : ""}{row?.coverage === "partial" ? " · partial" : ""}</span>
              </div>
              <div className="activity-timeline-track" aria-label={`${agent.title} activity`}>
                {row?.segments.map((segment, index) => {
                  const from = Date.parse(segment.started_at), to = Date.parse(segment.ended_at ?? timeline!.ended_at);
                  const label = `${agent.title} · Work period ${index + 1} · ${time(from)}–${segment.ended_at ? time(to) : "now"} · ${formatDuration(to - from)}`;
                  return <div key={segment.id} role="img" aria-label={label} title={label} className={cx("activity-timeline-bar", segment.ended_at === null && "is-live")} style={{ left: `${Math.max(0, (from - start) / duration) * 100}%`, width: `${Math.max(0, to - from) / duration * 100}%` }} />;
                })}
              </div>
            </Fragment>;
          })}
        </div>
      </div>
      {snapshot.flow_steps.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-300">Flow steps</div>
          <div className="agent-scroll flex gap-2 overflow-x-auto pb-1">
            {snapshot.flow_steps.map((step) => {
              const instance = flowByInstanceId.get(step.flow_instance_id);
              return (
                <div
                  className={cx(
                    "min-w-[150px] shrink-0 rounded-md border px-2 py-1.5",
                    flowStepStatusClasses(step.status),
                    step.step_instance_id === selectedStepInstanceId && "ring-2 ring-teal-300"
                  )}
                  key={step.step_instance_id}
                >
                  <div className="truncate text-[11px] font-semibold text-ink-800">{step.step_id}</div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] text-ink-500">{instance?.status ?? "unknown"}</span>
                    <span className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-500">
                      {step.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function flowStepStatusClasses(status: string): string {
  if (status === "active") {
    return "border-teal-200 bg-teal-50";
  }
  if (status === "completed") {
    return "border-lime-200 bg-lime-50";
  }
  if (status === "blocked" || status === "failed" || status === "cancelled") {
    return "border-red-200 bg-red-50";
  }
  return "border-zinc-200 bg-zinc-50";
}
