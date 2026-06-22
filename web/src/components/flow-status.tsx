"use client";

import { cx } from "@/lib/format";
import type { FlowVisualNode } from "@/lib/flow-graph";

type FlowNodeKind = FlowVisualNode["kind"];
type FlowNodeStatus = FlowVisualNode["status"];

export function flowStatusClass(status: FlowNodeStatus, kind: FlowNodeKind) {
  if (kind === "decision") {
    return { bg: "bg-sky-50", border: "border-sky-200", text: "text-sky-700" };
  }
  if (kind === "notify") {
    return { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700" };
  }
  if (kind === "finish") {
    return { bg: "bg-lime-50", border: "border-lime-200", text: "text-lime-700" };
  }
  if (status === "active") {
    return { bg: "bg-teal-50", border: "border-teal-200", text: "text-teal-700" };
  }
  if (status === "completed") {
    return { bg: "bg-lime-50", border: "border-lime-200", text: "text-lime-700" };
  }
  if (status === "blocked" || status === "failed" || status === "cancelled") {
    return { bg: "bg-red-50", border: "border-red-200", text: "text-red-700" };
  }
  return { bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-700" };
}

export function FlowStatusDot({
  current,
  kind,
  status
}: {
  current?: boolean;
  kind: FlowNodeKind;
  status: FlowNodeStatus;
}) {
  const statusClass = flowStatusClass(status, kind);
  const label = current ? `Current step · status: ${formatFlowStatusLabel(status)}` : `Status: ${formatFlowStatusLabel(status)}`;
  return (
    <span
      aria-label={label}
      className={cx(
        "grid size-4 shrink-0 place-items-center rounded-full",
        statusClass.bg,
        current && "ring-2 ring-teal-200"
      )}
      title={label}
    >
      <span className={cx("size-2 rounded-full", flowStatusDotClass(status, kind))} />
    </span>
  );
}

export function flowStatusDotClass(status: FlowNodeStatus, kind: FlowNodeKind): string {
  if (kind === "decision") return "bg-sky-400";
  if (kind === "notify") return "bg-amber-500";
  if (kind === "finish") return "bg-lime-500";
  if (status === "active") return "bg-signal-teal";
  if (status === "completed") return "bg-signal-lime";
  if (status === "blocked" || status === "failed" || status === "cancelled") return "bg-signal-coral";
  return "bg-violet-400";
}

export function formatFlowStatusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export function flowNodeColor(status: FlowNodeStatus, kind: FlowNodeKind): string {
  if (kind === "decision") return "#38bdf8";
  if (kind === "notify") return "#f59e0b";
  if (kind === "finish") return "#84cc16";
  if (status === "active") return "#14b8a6";
  if (status === "completed") return "#84cc16";
  if (status === "blocked" || status === "failed" || status === "cancelled") return "#fb6b5f";
  return "#a78bfa";
}
