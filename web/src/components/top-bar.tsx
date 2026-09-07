"use client";

import { GitBranch, Maximize2, PanelBottom, type LucideIcon } from "lucide-react";
import type { ConnectionState } from "@/lib/api";
import type { RunRecord } from "@/lib/types";
import { IconButton } from "./ui";

export function TopBar({
  run,
  inspectorOpen,
  runsOpen,
  onFit,
  onOpenAgent,
  onOpenRuns,
}: {
  run: RunRecord | null;
  connection: ConnectionState;
  inspectorOpen?: boolean;
  runsOpen?: boolean;
  onFit?: () => void;
  onOpenAgent?: () => void;
  onOpenRuns?: () => void;
}) {
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

      </div>

      <div className="top-bar-button-group shrink-0" role="group" aria-label="Console view controls">
        <TopBarGroupButton active={inspectorOpen} icon={PanelBottom} label="Open inspector" onClick={onOpenAgent} />
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
