"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { elapsedFrom, formatDuration } from "@/lib/format";
import type { DashboardSnapshot, RunRecord } from "@/lib/types";
import { EmptyState } from "./ui";

interface RunTreeRow {
  run: RunRecord;
  depth: number;
}

export function RunSidebar({
  snapshot,
  selectedRunId,
  onSelectRun
}: {
  snapshot: DashboardSnapshot | null;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const runs = useMemo(() => {
    const values = snapshot?.runs ?? [];
    const needle = query.trim().toLowerCase();
    return buildRunRows(values, needle);
  }, [query, snapshot?.runs]);

  return (
    <aside className="flex h-full min-w-0 flex-col border-r border-black/10 bg-white/72 backdrop-blur-xl">
      <div className="border-b border-black/10 p-3">
        <div className="flex items-center gap-2">
          <div>
            <h1 className="text-sm font-semibold text-ink-900">Agent Control</h1>
            <p className="text-[11px] text-ink-400">Realtime worker console</p>
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 rounded-lg border border-black/10 bg-white px-2.5 py-2 text-xs text-ink-400 shadow-hairline">
          <Search className="size-3.5" />
          <input
            className="min-w-0 flex-1 bg-transparent text-xs text-ink-900 outline-none placeholder:text-ink-300"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search runs, repos, ids"
            value={query}
          />
        </label>
      </div>

      <div className="agent-scroll min-h-0 flex-1 overflow-auto p-2">
        {runs.length === 0 ? (
          <EmptyState detail="Create an Agent Control run and it will appear here automatically." title="No runs yet" />
        ) : (
          <div className="flex flex-col gap-1.5">
            {runs.map(({ run, depth }) => (
              <div key={run.run_id} style={{ paddingLeft: `${depth * 12}px` }}>
                <RunRow
                  depth={depth}
                  run={run}
                  selected={run.run_id === selectedRunId}
                  onClick={() => onSelectRun(run.run_id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function RunRow({
  depth,
  run,
  selected,
  onClick
}: {
  depth: number;
  run: RunRecord;
  selected: boolean;
  onClick: () => void;
}) {
  const elapsed = formatDuration(elapsedFrom(run.created_at, run.status === "active" ? null : run.updated_at));
  const runPath = run.repo_dir ?? run.run_id;
  return (
    <button
      className={[
        "w-full rounded-lg border px-2.5 py-2 text-left transition",
        selected
          ? "border-teal-300 bg-teal-50/80 shadow-hairline"
          : "border-transparent bg-white/46 hover:border-black/10 hover:bg-white/80"
      ].join(" ")}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-xs font-semibold text-ink-900">{run.title}</div>
        <span className="shrink-0 whitespace-nowrap rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-ink-500">{elapsed}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="truncate-start min-w-0 text-[11px] text-ink-400" title={runPath}>
          {runPath}
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-ink-300">
          {depth > 0 ? "child" : run.status}
        </span>
      </div>
    </button>
  );
}

function buildRunRows(runs: RunRecord[], needle: string): RunTreeRow[] {
  if (needle) {
    return runs
      .filter((run) => runMatches(run, needle))
      .map((run) => ({ run, depth: depthForRun(run, runs) }));
  }

  const runIds = new Set(runs.map((run) => run.run_id));
  const childrenByParent = new Map<string, RunRecord[]>();
  const roots: RunRecord[] = [];

  for (const run of runs) {
    if (run.parent_run_id && runIds.has(run.parent_run_id)) {
      childrenByParent.set(run.parent_run_id, [...(childrenByParent.get(run.parent_run_id) ?? []), run]);
    } else {
      roots.push(run);
    }
  }

  const rows: RunTreeRow[] = [];
  const append = (run: RunRecord, depth: number) => {
    rows.push({ run, depth });
    for (const child of childrenByParent.get(run.run_id) ?? []) {
      append(child, depth + 1);
    }
  };

  for (const root of roots) {
    append(root, 0);
  }

  return rows;
}

function depthForRun(run: RunRecord, runs: RunRecord[]): number {
  const byId = new Map(runs.map((item) => [item.run_id, item]));
  let depth = 0;
  let cursor = run.parent_run_id ? byId.get(run.parent_run_id) : null;
  const seen = new Set<string>([run.run_id]);
  while (cursor && !seen.has(cursor.run_id)) {
    seen.add(cursor.run_id);
    depth += 1;
    cursor = cursor.parent_run_id ? byId.get(cursor.parent_run_id) : null;
  }
  return depth;
}

function runMatches(run: RunRecord, needle: string): boolean {
  return `${run.title} ${run.repo_dir ?? ""} ${run.run_id}`.toLowerCase().includes(needle);
}
