import { ViewportPortal } from "@xyflow/react";

export function RunGraphFrame({ runId, title, bounds }: {
  runId: string; title: string; bounds: { x: number; y: number; width: number; height: number };
}) {
  return <ViewportPortal><div data-run-frame={runId} role="group" aria-label={title}
    className="pointer-events-none absolute rounded-3xl border border-[var(--line)]"
    style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}>
    <div className="truncate px-6 py-4 text-base font-semibold text-ink-900">{title}</div>
  </div></ViewportPortal>;
}
