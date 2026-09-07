"use client";

import { modelUsage } from "@/lib/agent-presentation";
import { compactId, cx, elapsedFrom, formatDateTime, formatDuration, formatNumber, STATUS_STYLE } from "@/lib/format";
import type { DashboardSnapshot, RunRecord } from "@/lib/types";

export function RunInfoPanel({
  run,
  selectedStepInstanceId,
  snapshot
}: {
  run: RunRecord | null;
  selectedStepInstanceId: string | null;
  snapshot: DashboardSnapshot;
}) {
  const elapsed = run ? formatDuration(elapsedFrom(run.created_at, run.status === "active" ? null : run.updated_at)) : "0s";
  const running = snapshot.status_counts.running ?? 0;
  const waiting = snapshot.status_counts.waiting_for_input ?? 0;
  const consumption = modelUsage(snapshot);


  return (
    <section className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex min-h-14 items-start justify-between gap-4 border-b border-black/8 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-ink-900">{run?.title ?? "No run selected"}</div>
          <div className="mt-0.5 truncate text-xs text-ink-400">{run?.repo_dir ?? run?.run_id ?? "Waiting for Agent Control data"}</div>
        </div>
      </div>

        <div className="agent-scroll min-h-0 flex-1 overflow-auto p-4">
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-500">
            <span>{snapshot.agents.length} agents</span><span>{running} running</span><span>{waiting} waiting</span><span>{elapsed} elapsed</span>
          </div>
          {consumption.rows.length ? <div className="mt-5">
            <h3 className="text-sm font-semibold text-ink-900">Token consumption</h3>
            <p className="mt-1 text-xs text-ink-400">Reported usage · input includes cached tokens; output includes reported reasoning. Missing usage is excluded; + marks a partial sum.</p>
            <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs tabular-nums">
              <thead className="text-ink-400"><tr><th className="py-2 font-medium">Model</th><th className="px-3 py-2 text-right font-medium">Input</th><th className="px-3 py-2 text-right font-medium">Cached input</th><th className="px-3 py-2 text-right font-medium">Uncached input</th><th className="px-3 py-2 text-right font-medium">Output</th><th className="py-2 text-right font-medium">Total</th></tr></thead>
              <tbody>{consumption.rows.map((row) => <tr key={row.model} className="border-t border-black/5"><th className="py-2 font-medium text-ink-700">{row.model}</th><UsageCells values={row} /></tr>)}</tbody>
              <tfoot className="border-t border-black/10 font-semibold text-ink-900"><tr><th className="py-3">All models</th><UsageCells values={consumption.totals} /></tr></tfoot>
            </table></div>
          </div> : null}

          {snapshot.flow_instances.length > 0 ? (
            <FlowOverview selectedStepInstanceId={selectedStepInstanceId} snapshot={snapshot} />
          ) : null}


        </div>
    </section>
  );
}

function FlowOverview({
  selectedStepInstanceId,
  snapshot
}: {
  selectedStepInstanceId: string | null;
  snapshot: DashboardSnapshot;
}) {
  const flowByRecordId = new Map(snapshot.flows.map((flow) => [flow.flow_record_id, flow]));
  const stepsByInstance = groupBy(snapshot.flow_steps, (step) => step.flow_instance_id);
  const transitionsByInstance = groupBy(snapshot.flow_transitions, (transition) => transition.flow_instance_id);
  const bindingsByInstance = groupBy(snapshot.flow_artifact_bindings, (binding) => binding.flow_instance_id);

  return (
    <div className="mt-5">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-300">Flows</div>
      <div className="flex flex-col gap-2">
        {snapshot.flow_instances.map((instance) => {
          const flow = flowByRecordId.get(instance.flow_record_id);
          const steps = stepsByInstance.get(instance.flow_instance_id) ?? [];
          const transitions = transitionsByInstance.get(instance.flow_instance_id) ?? [];
          const bindings = bindingsByInstance.get(instance.flow_instance_id) ?? [];
          return (
            <div className="rounded-md border border-black/8 bg-white/80" key={instance.flow_instance_id}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/8 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-ink-900">{flow?.flow_id ?? "Unknown flow"}</div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-400">
                    {compactId(instance.flow_instance_id)} · current {instance.current_step_id ?? "none"} · {formatDateTime(instance.updated_at)}
                  </div>
                </div>
                <span className={cx("rounded-full px-2 py-1 text-[10px] font-semibold uppercase", flowStatusClass(instance.status))}>
                  {instance.status.replaceAll("_", " ")}
                </span>
              </div>

              <div className="px-3 py-2">
                <div className="flex flex-col gap-1.5">
                  {steps.map((step) => (
                    <div
                      className={cx(
                        "grid grid-cols-[minmax(100px,1fr)_auto] gap-3 rounded px-1.5 py-1 text-[11px]",
                        step.step_instance_id === selectedStepInstanceId && "bg-teal-50 ring-1 ring-teal-200"
                      )}
                      key={step.step_instance_id}
                    >
                      <div className="min-w-0">
                        <span className="font-semibold text-ink-700">{step.step_id}</span>
                        {step.summary ? <span className="ml-2 text-ink-400">{step.summary}</span> : null}
                      </div>
                      <span className={cx("rounded px-1.5 py-0.5 font-semibold uppercase", flowStepStatusClass(step.status))}>
                        {step.status}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-ink-400">
                  <span>{transitions.length} transitions</span>
                  <span>{bindings.length} artifacts</span>
                  {flow?.description ? <span className="truncate">{flow.description}</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InfoMetric({
  label,
  tone = "neutral",
  value
}: {
  label: string;
  tone?: "neutral" | "teal" | "amber";
  value: string;
}) {
  const toneClass = tone === "teal" ? "text-teal-700" : tone === "amber" ? "text-amber-700" : "text-ink-900";
  return (
    <div className="min-w-0 rounded-md border border-black/8 bg-white/76 px-3 py-2">
      <div className="truncate text-[10px] uppercase tracking-[0.08em] text-ink-300">{label}</div>
      <div className={cx("mt-0.5 truncate text-base font-semibold", toneClass)}>{value}</div>
    </div>
  );
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const values = grouped.get(key) ?? [];
    values.push(item);
    grouped.set(key, values);
  }
  return grouped;
}

function flowStatusClass(status: string): string {
  if (status === "completed") {
    return "bg-lime-50 text-lime-700";
  }
  if (status === "active") {
    return "bg-teal-50 text-teal-700";
  }
  if (status === "waiting_for_orchestrator") {
    return "bg-amber-50 text-amber-700";
  }
  if (status === "blocked" || status === "cancelled") {
    return "bg-red-50 text-red-700";
  }
  return "bg-zinc-50 text-zinc-600";
}

function flowStepStatusClass(status: string): string {
  if (status === "completed") {
    return "bg-lime-50 text-lime-700";
  }
  if (status === "active") {
    return "bg-teal-50 text-teal-700";
  }
  if (status === "blocked" || status === "failed" || status === "cancelled") {
    return "bg-red-50 text-red-700";
  }
  return "bg-zinc-50 text-zinc-600";
}

function UsageCells({ values }: { values: ReturnType<typeof modelUsage>["totals"] }) {
  const label = (value: typeof values.input) => value.value === null ? "—" : `${new Intl.NumberFormat("en-US").format(value.value)}${value.partial ? "+" : ""}`;
  return <>{(["input", "cached", "uncached", "output", "total"] as const).map((key) => <td key={key} className={key === "total" ? "py-2 text-right align-top" : "px-3 py-2 text-right align-top"}>{label(values[key])}</td>)}</>;
}
