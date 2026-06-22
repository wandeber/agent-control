"use client";

import { GitBranch, Maximize2, MessageSquareText, PanelBottom, RefreshCw, Wifi, WifiOff, type LucideIcon } from "lucide-react";
import type { ConnectionState } from "@/lib/api";
import type { RunRecord } from "@/lib/types";
import { IconButton } from "./ui";

export function TopBar({
  run,
  connection,
  inspectorOpen,
  runsOpen,
  threadOpen,
  onFit,
  onOpenAgent,
  onOpenRuns,
  onOpenThread,
  onRefresh
}: {
  run: RunRecord | null;
  connection: ConnectionState;
  inspectorOpen?: boolean;
  runsOpen?: boolean;
  threadOpen?: boolean;
  onFit?: () => void;
  onOpenAgent?: () => void;
  onOpenRuns?: () => void;
  onOpenThread?: () => void;
  onRefresh?: () => void;
}) {
  const connectionTone = connection === "live" ? "text-teal-700" : connection === "connecting" ? "text-amber-700" : "text-red-700";
  const runPath = run?.repo_dir ?? run?.run_id ?? "Waiting for Agent Control data";
  return (
    <header className="flex h-16 items-center justify-between gap-4 border-b border-black/10 bg-white/74 px-4 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-3">
        <IconButton active={runsOpen} icon={GitBranch} label="Runs" onClick={onOpenRuns} />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink-900">{run?.title ?? "No run selected"}</h2>
          <p className="truncate-start text-[11px] text-ink-400" title={runPath}>
            {runPath}
          </p>
        </div>
        <span className={["inline-flex shrink-0 items-center gap-1 text-xs font-medium", connectionTone].join(" ")}>
          {connection === "live" ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
          {connection}
        </span>
      </div>

      <div className="top-bar-button-group shrink-0" role="group" aria-label="Console view controls">
        <TopBarGroupButton active={inspectorOpen} icon={PanelBottom} label="Open inspector" onClick={onOpenAgent} />
        <TopBarGroupButton active={threadOpen} icon={MessageSquareText} label="Open thread" onClick={onOpenThread} />
        <TopBarGroupButton icon={RefreshCw} label="Refresh snapshot" onClick={onRefresh} />
        {onFit ? <TopBarGroupButton icon={Maximize2} label="Fit graph" onClick={onFit} /> : null}
      </div>
    </header>
  );
}

function TopBarGroupButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active?: boolean;
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="top-bar-group-button"
      data-active={active ? "true" : "false"}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon className="size-4" strokeWidth={1.8} />
    </button>
  );
}
