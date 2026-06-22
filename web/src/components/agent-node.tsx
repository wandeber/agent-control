"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Activity, Bot, Clock3, Cpu, Goal, Layers3, Radio } from "lucide-react";
import { compactId, formatDuration, formatNumber, STATUS_STYLE } from "@/lib/format";
import type { AgentComputedState, AgentRecord, GoalRecord, HeartbeatRecord } from "@/lib/types";
import { StatusDot } from "./ui";

const VISIBLE_HANDLE_CLASS = "!size-1 !border-0 !bg-transparent !opacity-0";
const FLOATING_HANDLE_CLASS = "!size-1 !border-0 !bg-transparent !opacity-0";

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentRecord;
  computed?: AgentComputedState;
  flowInstanceCount: number;
  goals: GoalRecord[];
  heartbeats: HeartbeatRecord[];
  selected: boolean;
}

export type AgentFlowNode = Node<AgentNodeData, "agent">;

export function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  const style = STATUS_STYLE[data.agent.status];
  const usage = data.computed?.latest_usage;
  const heartbeat = data.heartbeats[0];
  return (
    <div
      className={[
        "group w-[270px] rounded-lg border bg-white p-3 text-left shadow-node backdrop-blur-xl transition",
        style.border,
        data.selected ? "ring-2 ring-teal-300" : "ring-0"
      ].join(" ")}
    >
      <Handle className={VISIBLE_HANDLE_CLASS} id="in" isConnectable={false} position={Position.Left} type="target" />
      <Handle className={VISIBLE_HANDLE_CLASS} id="out" isConnectable={false} position={Position.Right} type="source" />
      <FloatingHandles type="source" />
      <FloatingHandles type="target" />
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className={["grid size-8 shrink-0 place-items-center rounded-md", style.bg, style.text].join(" ")}>
            <Bot className="size-4" strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink-900">{data.agent.title}</div>
            <div className="truncate text-[11px] text-ink-500">
              {data.agent.role ?? "worker"} · {compactId(data.agent.agent_id)}
            </div>
          </div>
        </div>
        <StatusDot status={data.agent.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <NodeMetric
          icon={Clock3}
          label="elapsed"
          value={data.agent.status === "planned" ? "not started" : formatDuration(data.computed?.elapsed_ms)}
        />
        <NodeMetric icon={Cpu} label="tokens" value={formatNumber(usage?.total_tokens)} />
        <NodeMetric icon={Activity} label="backend" value={data.agent.backend} />
        <NodeMetric icon={Radio} label="heartbeat" value={heartbeat ? formatDuration(heartbeat.idle_timeout_ms) : "none"} />
      </div>

      {data.flowInstanceCount > 1 ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-violet-100 bg-violet-50/70 px-2 py-1.5">
          <Layers3 className="size-3.5 shrink-0 text-violet-700" />
          <span className="truncate text-[11px] font-medium text-violet-800">
            {data.flowInstanceCount} clean instances
          </span>
        </div>
      ) : null}

      {data.goals.length > 0 ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-black/8 bg-canvas-50 px-2 py-1.5">
          <Goal className="size-3.5 shrink-0 text-teal-700" />
          <span className="truncate text-[11px] font-medium text-ink-700">{data.goals[0]?.status}</span>
          <span className="truncate text-[11px] text-ink-400">{data.goals[0]?.objective}</span>
        </div>
      ) : null}
    </div>
  );
}

function FloatingHandles({ type }: { type: "source" | "target" }) {
  return (
    <>
      <Handle className={FLOATING_HANDLE_CLASS} id={`${type}-top`} isConnectable={false} position={Position.Top} type={type} />
      <Handle
        className={FLOATING_HANDLE_CLASS}
        id={`${type}-right`}
        isConnectable={false}
        position={Position.Right}
        type={type}
      />
      <Handle
        className={FLOATING_HANDLE_CLASS}
        id={`${type}-bottom`}
        isConnectable={false}
        position={Position.Bottom}
        type={type}
      />
      <Handle className={FLOATING_HANDLE_CLASS} id={`${type}-left`} isConnectable={false} position={Position.Left} type={type} />
    </>
  );
}

function NodeMetric({
  icon: Icon,
  label,
  value
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-black/8 bg-white/60 px-2 py-1.5">
      <Icon className="size-3.5 shrink-0 text-ink-300" strokeWidth={1.8} />
      <span className="text-ink-300">{label}</span>
      <span className="min-w-0 truncate font-medium text-ink-700">{value}</span>
    </div>
  );
}
