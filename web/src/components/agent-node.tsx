"use client";

import { AgentChatPreview } from "./agent-chat-preview";
import { AgentUsageIcon } from "./agent-usage-icon";
import { agentModelLabel } from "@/lib/agent-presentation";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { MessageSquare, Wrench } from "lucide-react";
import { STATUS_STYLE } from "@/lib/format";
import type { AgentRecord } from "@/lib/types";
import type { agentPresentation } from "@/lib/agent-presentation";
import { StatusDot } from "./ui";

const VISIBLE_HANDLE_CLASS = "!size-1 !border-0 !bg-transparent !opacity-0";
const FLOATING_HANDLE_CLASS = "!size-1 !border-0 !bg-transparent !opacity-0";

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentRecord;
  presentation: ReturnType<typeof agentPresentation>;
  selected: boolean;
  onSelect: () => void;
}

export type AgentFlowNode = Node<AgentNodeData, "agent">;

export function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  const style = STATUS_STYLE[data.agent.status];
  const ActivityIcon = data.presentation.kind === "tool" ? Wrench : MessageSquare;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={data.selected}
      aria-label={`${data.presentation.title}. ${style.label}${data.presentation.phase ? `. ${data.presentation.phase}` : ""}. ${data.presentation.activity}`}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); event.stopPropagation(); data.onSelect();
        }
      }}
      data-agent-card={data.agent.agent_id}
      className={[
        "group w-[300px] rounded-xl border bg-white p-3.5 text-left shadow-node backdrop-blur-xl transition",
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
          <AgentUsageIcon usage={data.presentation.usage} cost={data.presentation.cost} exchange={data.presentation.exchange} className={style.bg + " " + style.text} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink-900" title={data.agent.title}>{data.presentation.title}</div>
            {data.presentation.title.toLowerCase() !== data.agent.role?.replaceAll("_", " ").toLowerCase() ? (
              <div className="truncate text-[11px] text-ink-500">{[data.agent.role?.replaceAll("_", " ") ?? "worker", agentModelLabel(data.agent)].filter(Boolean).join(" · ")}</div>
            ) : <div className="truncate text-[11px] text-ink-500">{agentModelLabel(data.agent)}</div>}
          </div>
        </div>
        <span className={["flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-semibold", style.bg, style.text].join(" ")}>
          <StatusDot status={data.agent.status} />{style.label}
        </span>
      </div>

      {data.presentation.phase ? (
        <div className="mt-3 truncate text-[11px] font-medium text-teal-800" title={data.presentation.phase}>
          {data.presentation.phase}
        </div>
      ) : null}
      <AgentChatPreview agentId={data.agent.agent_id}><div className="mt-2.5 flex min-w-0 items-center gap-2 border-t border-black/5 pt-2.5 text-xs text-ink-600"
        data-agent-activity={data.presentation.kind}>
        <ActivityIcon className="size-3.5 shrink-0 text-ink-400" />
        <span className="truncate">{data.presentation.activity}</span>
      </div></AgentChatPreview>
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
