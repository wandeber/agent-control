"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { requestMcpAppTeardown, shouldTryMcpApp, subscribeMcpConsoleState, type ConsoleSelectionState } from "@/lib/mcp-app";
import { nextRunSelection, readRunSelection } from "@/lib/run-selection";

function useSharedSelection() {
  const refreshHandler = useRef<(() => void) | null>(null);
  const registerRefresh = useCallback((handler: () => void) => {
    refreshHandler.current = handler;
    return () => { if (refreshHandler.current === handler) refreshHandler.current = null; };
  }, []);
  const refreshCurrentScreen = useCallback(() => refreshHandler.current?.(), []);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [followLatestRun, setFollowLatestRun] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const pinned = useRef(false);
  const historyHydrated = useRef(false);
  const lastHostSelection = useRef<ConsoleSelectionState | null>(null);

  useEffect(() => {
    const syncHistory = () => {
      const params = new URLSearchParams(window.location.search);
      if (!shouldTryMcpApp()) { setSelectedFlowId(params.get("flow_id")); setProjectDir(params.get("repo_dir")); }
      const ids = readRunSelection(window.location.search, shouldTryMcpApp());
      const runId = ids[0] ?? null;
      setSelectedRunIds(ids);
      pinned.current = Boolean(runId);
      setSelectedRunId(runId);
      setFollowLatestRun(!runId);
      setSelectedAgentId(null);
    };
    if (!historyHydrated.current) {
      syncHistory();
      historyHydrated.current = true;
    }
    // Fragment-only history moves change screens, not the selected worker.
    let search = window.location.search;
    const onPopState = () => {
      if (search !== window.location.search) {
        search = window.location.search;
        syncHistory();
      }
    };
    window.addEventListener("popstate", onPopState);
    const unsubscribe = subscribeMcpConsoleState((state) => {
      const selection = state.console;
      // Snapshot notifications replay the last selection. Consume a host
      // request once, above both screens, so navigating cannot re-pin an old run.
      if (!selection || selection === lastHostSelection.current ||
        (selection.command_id && selection.command_id === lastHostSelection.current?.command_id)) return;
      lastHostSelection.current = selection;
      if (selection.flow_id) setSelectedFlowId(selection.flow_id);
      if (selection.repo_dir) setProjectDir(selection.repo_dir);
      if (selection.action === "close") {
        void requestMcpAppTeardown();
      } else if (selection.requested_run_id) {
        pinned.current = true;
        setSelectedRunId(selection.requested_run_id);
        setSelectedRunIds([selection.requested_run_id]);
        setFollowLatestRun(false);
        setSelectedAgentId(null);
        writeRunIds([selection.requested_run_id], "replace");
        search = window.location.search;
      } else if (selection.follow_latest && !pinned.current) {
        setFollowLatestRun(true);
      }
    });
    return () => {
      window.removeEventListener("popstate", onPopState);
      unsubscribe();
    };
  }, []);

  const selectRun = (runId: string, additive = false) => {
    const ids = nextRunSelection(selectedRunIds.length ? selectedRunIds : selectedRunId ? [selectedRunId] : [], runId, additive && !shouldTryMcpApp());
    pinned.current = true;
    setSelectedRunId(ids[0]);
    setSelectedRunIds(ids);
    setFollowLatestRun(false);
    setSelectedAgentId(null);
    writeRunIds(ids, "push");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return { selectedFlowId, setSelectedFlowId, projectDir, registerRefresh, refreshCurrentScreen, connection, setConnection, selectedRunId, selectedRunIds, setSelectedRunId, followLatestRun, selectedAgentId, setSelectedAgentId, selectRun };
}

const SelectionContext = createContext<ReturnType<typeof useSharedSelection> | null>(null);

export function ConsoleSelectionProvider({ children }: { children: ReactNode }) {
  const selection = useSharedSelection();
  return <SelectionContext.Provider value={selection}>{children}</SelectionContext.Provider>;
}

export function useConsoleSelection() {
  const selection = useContext(SelectionContext);
  if (!selection) throw new Error("ConsoleSelectionProvider is required");
  return selection;
}

function writeRunIds(runIds: string[], mode: "push" | "replace") {
  const url = new URL(window.location.href);
  url.searchParams.delete("run_id");
  for (const runId of runIds) url.searchParams.append("run_id", runId);
  // Some MCP hosts use an opaque iframe URL that cannot be rewritten. The
  // shared selection still persists when moving between the two screens.
  try {
    window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", url.href);
  } catch {
    // The host remains the source of the opening run in an opaque iframe.
  }
}
