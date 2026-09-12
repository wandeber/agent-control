"use client";

import { QuestionBadge } from "./user-questions";
import { ChevronRight, Folder, Search } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { elapsedFrom, formatDuration } from "@/lib/format";
import { shouldTryMcpApp } from "@/lib/mcp-app";
import type { DashboardSnapshot, RunRecord } from "@/lib/types";
import { EmptyState } from "./ui";

interface RunTreeRow {
  run: RunRecord;
  depth: number;
}

export function RunSidebar({
  snapshot,
  selectedRunId,
  selectedRunIds = [],
  onSelectRun
}: {
  snapshot: DashboardSnapshot | null;
  selectedRunId: string | null;
  selectedRunIds?: string[];
  onSelectRun: (runId: string, additive: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [groupByDirectory, setGroupByDirectory] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string | null>>(() => new Set());
  useEffect(() => setGroupByDirectory(!shouldTryMcpApp()), []);
  const runs = useMemo(() => {
    const values = snapshot?.runs ?? [];
    const needle = query.trim().toLowerCase();
    return buildRunRows(values, needle);
  }, [query, snapshot?.runs]);
  const groups = useMemo(() => {
    if (!groupByDirectory) return [];
    const directories = new Map<string | null, RunRecord[]>();
    for (const run of snapshot?.runs ?? []) {
      const directory = run.repo_dir || null;
      const entries = directories.get(directory) ?? [];
      entries.push(run);
      directories.set(directory, entries);
    }
    return [...directories].map(([directory, entries]) => ({
      directory,
      rows: buildRunRows(entries, query.trim().toLowerCase())
    })).filter(group => group.rows.length > 0);
  }, [groupByDirectory, query, snapshot?.runs]);

  const renderRows = (rows: RunTreeRow[]) => (
    <div className="flex flex-col divide-y divide-[var(--line)]">
      {rows.map(({ run, depth }) => (
        <div key={run.run_id} style={{ paddingLeft: `${depth * 12}px` }}>
          <RunRow depth={depth} run={run} questionCount={(snapshot?.user_questions ?? []).filter(question => question.run_id === run.run_id && question.state === "pending").length} selected={selectedRunIds.includes(run.run_id) || run.run_id === selectedRunId}
            onClick={(event) => onSelectRun(run.run_id, groupByDirectory && (event.ctrlKey || event.metaKey))} />
        </div>
      ))}
    </div>
  );

  return (
    <aside className="flex h-full min-w-0 flex-col border-r border-black/10 bg-white/72 backdrop-blur-xl">
      <div className="border-b border-black/10 p-3">
        <label className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-2.5 py-2 text-xs text-ink-400 shadow-hairline">
          <Search className="size-3.5" />
          <input
            className="min-w-0 flex-1 bg-transparent text-xs text-ink-900 outline-none placeholder:text-ink-300"
            onChange={(event) => {
              setQuery(event.target.value);
              // Search results must not remain hidden inside a collapsed directory.
              if (event.target.value.trim()) setCollapsed(new Set());
            }}
            placeholder="Search runs, repos, ids"
            value={query}
          />
        </label>
      </div>

      <div className="agent-scroll min-h-0 flex-1 overflow-auto p-2">
        {runs.length === 0 ? (
          <EmptyState detail="Create an Agent Control run and it will appear here automatically." title="No runs yet" />
        ) : groupByDirectory ? (
          <div className="flex flex-col gap-3">
            {groups.map(({ directory, rows }) => {
              const expanded = !collapsed.has(directory);
              const label = directory?.split(/[\\/]/).filter(Boolean).at(-1) ?? directory ?? "No directory";
              return (
                <section key={directory ?? ""} aria-label={directory ?? "No directory"}>
                  <button type="button" aria-expanded={expanded} title={directory ?? "No directory"}
                    className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--raised)]"
                    onClick={() => setCollapsed(current => {
                      const next = new Set(current);
                      if (next.has(directory)) next.delete(directory); else next.add(directory);
                      return next;
                    })}>
                    <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 text-ink-400 transition-transform ${expanded ? "rotate-90" : ""}`} />
                    <Folder aria-hidden="true" className="size-4 shrink-0 text-ink-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-ink-900">{label}</span>
                      {directory && directory !== label ? <span className="truncate-start block text-[10px] text-ink-400">{directory}</span> : null}
                    </span>
                    <span className="shrink-0 text-[10px] text-ink-400">{rows.length} {rows.length === 1 ? "run" : "runs"}</span>
                  </button>
                  {expanded ? renderRows(rows) : null}
                </section>
              );
            })}
          </div>
        ) : renderRows(runs)}
      </div>
    </aside>
  );
}

function RunRow({
  depth,
  run,
  selected,
  onClick,
  questionCount
}: {
  depth: number;
  questionCount: number;
  run: RunRecord;
  selected: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const elapsed = formatDuration(elapsedFrom(run.created_at, run.status === "active" ? null : run.updated_at));
  const runPath = run.repo_dir ?? run.run_id;
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={[
        "w-full px-2.5 py-2.5 text-left transition-colors",
        selected
          ? "bg-[var(--raised)]"
          : "bg-transparent hover:bg-[var(--raised)]"
      ].join(" ")}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2"><QuestionBadge count={questionCount} /><span className="truncate text-xs font-semibold text-ink-900">{run.title}</span></div>
        <span className="shrink-0 whitespace-nowrap text-[10px] font-medium text-ink-500">{elapsed}</span>
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
