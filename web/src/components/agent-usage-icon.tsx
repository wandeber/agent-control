"use client";

import { usageBreakdown } from "@/lib/agent-presentation";
import type { UsageSnapshotRecord } from "@/lib/types";
import { Bot } from "lucide-react";
import { useId, useState } from "react";
import { createPortal } from "react-dom";

export function AgentUsageIcon({ usage, className }: { usage: UsageSnapshotRecord | null; className: string }) {
  const id = useId();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const open = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: Math.min(rect.bottom + 8, window.innerHeight - 300) });
  };
  const rows = usageBreakdown(usage);
  if (!rows.length) return <span className={`grid size-8 shrink-0 place-items-center rounded-md ${className}`}><Bot className="size-4" /></span>;
  return <>
    <button type="button" aria-label="Token consumption" aria-describedby={position ? id : undefined}
      className={`nodrag grid size-8 shrink-0 place-items-center rounded-md ${className}`}
      onMouseEnter={(event) => open(event.currentTarget)} onMouseLeave={() => setPosition(null)}
      onFocus={(event) => open(event.currentTarget)} onBlur={() => setPosition(null)}
      onKeyDown={(event) => { if (event.key === "Escape") setPosition(null); event.stopPropagation(); }}
      onClick={(event) => { event.stopPropagation(); open(event.currentTarget); }}>
      <Bot className="size-4" />
    </button>
    {position && createPortal(<div id={id} role="tooltip" className="pointer-events-none fixed z-[100] w-[280px] rounded-lg border border-black/10 bg-white p-3 text-xs text-ink-700 shadow-lg" style={{ ...position, background: "var(--panel-solid)", color: "var(--foreground)", borderColor: "var(--line)" }}>
      <div className="mb-2 font-semibold">Token consumption</div>
      <dl className="space-y-1">{rows.map((row) => <div key={row.label} className="flex justify-between gap-3"><dt>{row.label}</dt><dd className="tabular-nums">{new Intl.NumberFormat("en-US").format(row.value)}</dd></div>)}</dl>
    </div>, document.body)}
  </>;
}
