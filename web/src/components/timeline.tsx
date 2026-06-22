"use client";

import { Clock3 } from "lucide-react";
import { cx, formatDuration, STATUS_STYLE } from "@/lib/format";
import type { DashboardSnapshot } from "@/lib/types";

export function Timeline({
  selectedStepInstanceId,
  snapshot
}: {
  selectedStepInstanceId: string | null;
  snapshot: DashboardSnapshot;
}) {
  const computed = new Map(snapshot.computed_agents.map((item) => [item.agent_id, item]));
  const maxElapsed = Math.max(1, ...snapshot.computed_agents.map((item) => item.elapsed_ms));
  const flowByInstanceId = new Map(snapshot.flow_instances.map((instance) => [instance.flow_instance_id, instance]));
  return (
    <div className="phase-timeline h-full overflow-auto bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-ink-700">
          <Clock3 className="size-3.5" />
          Phase swimlane
        </div>
        <span className="text-[11px] text-ink-400">{snapshot.latest_events.length} recent events</span>
      </div>
      <div className="agent-scroll flex h-[64px] gap-2 overflow-x-auto pb-1">
        {snapshot.agents.map((agent) => {
          const item = computed.get(agent.agent_id);
          const width = Math.max(82, Math.round(((item?.elapsed_ms ?? 0) / maxElapsed) * 220));
          const style = STATUS_STYLE[agent.status];
          return (
            <div
              className={["flex shrink-0 flex-col justify-between rounded-md border px-2 py-1.5", style.bg, style.border].join(" ")}
              key={agent.agent_id}
              style={{ width }}
            >
              <div className="truncate text-[11px] font-semibold text-ink-800">{agent.role ?? agent.title}</div>
              <div className="flex items-center justify-between gap-2">
                <span className={["size-1.5 rounded-full", style.dot].join(" ")} />
                <span className="truncate text-[10px] font-medium text-ink-500">{formatDuration(item?.elapsed_ms)}</span>
              </div>
            </div>
          );
        })}
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
