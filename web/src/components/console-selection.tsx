"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { requestMcpAppTeardown, subscribeMcpConsoleState, type ConsoleSelectionState } from "@/lib/mcp-app";

function useSharedSelection() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [followLatestRun, setFollowLatestRun] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const pinned = useRef(false);
  const historyHydrated = useRef(false);
  const lastHostSelection = useRef<ConsoleSelectionState | null>(null);

  useEffect(() => {
    const syncHistory = () => {
      const runId = new URLSearchParams(window.location.search).get("run_id")?.trim() || null;
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
      if (selection.action === "close") {
        void requestMcpAppTeardown();
      } else if (selection.requested_run_id) {
        pinned.current = true;
        setSelectedRunId(selection.requested_run_id);
        setFollowLatestRun(false);
        setSelectedAgentId(null);
        writeRunId(selection.requested_run_id, "replace");
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

  const selectRun = (runId: string) => {
    pinned.current = true;
    setSelectedRunId(runId);
    setFollowLatestRun(false);
    setSelectedAgentId(null);
    writeRunId(runId, "push");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return { selectedRunId, setSelectedRunId, followLatestRun, selectedAgentId, setSelectedAgentId, selectRun };
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

function writeRunId(runId: string, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  url.searchParams.set("run_id", runId);
  // Some MCP hosts use an opaque iframe URL that cannot be rewritten. The
  // shared selection still persists when moving between the two screens.
  try {
    window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", url.href);
  } catch {
    // The host remains the source of the opening run in an opaque iframe.
  }
}
