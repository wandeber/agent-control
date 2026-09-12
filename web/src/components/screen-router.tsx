"use client";

import { Users, Workflow, RefreshCw, Maximize2, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ConsoleSelectionProvider, useConsoleSelection } from "./console-selection";
import { ConsoleShell } from "./console-shell";
import { FlowsShell } from "./flows-shell";
import { SubagentsShell } from "./subagents-shell";
import { getMcpAppClient, shouldTryMcpApp, subscribeMcpConsoleState } from "@/lib/mcp-app";

export function ScreenRouter() {
  const [screen, setScreen] = useState("subagents");
  useEffect(() => {
    const syncScreen = () => setScreen(window.location.hash === "#/flows" ? "flows" : window.location.hash === "#/console" ? "console" : "subagents");
    syncScreen();
    let lastCommand: string | undefined;
    const unsubscribe = subscribeMcpConsoleState(state => {
      const selection = state.console;
      const key = selection?.command_id ?? selection?.panel_id;
      if (key && key !== lastCommand && selection?.screen) { lastCommand = key; setScreen(selection.screen); }
    });
    window.addEventListener("hashchange", syncScreen);
    window.addEventListener("popstate", syncScreen);
    return () => {
      unsubscribe();
      window.removeEventListener("hashchange", syncScreen);
      window.removeEventListener("popstate", syncScreen);
    };
  }, []);

  const fullConsole = screen === "console";
  const navigate = (next: string) => { setScreen(next); try { window.location.hash = `/${next}`; } catch { /* Opaque host. */ } };
  return (
    <ConsoleSelectionProvider>
      <div className="agent-control-app" data-screen={screen}>
        <nav aria-label="Agent Control screens" className="screen-navigation">
          <strong>{screen === "flows" ? "Flows" : fullConsole ? "Full Console" : "Subagents"}</strong>
          {/* Fragment routes keep the single embedded MCP resource loaded.
              Both shells are eagerly bundled, and only the active one mounts. */}
          <div className="screen-navigation-actions"><ConnectionIndicator /><RefreshButton />
            {screen !== "flows" ? <button className="screen-navigation-link" onClick={() => navigate("flows")} type="button"><Workflow className="size-4" />Flows</button> : null}
            {screen !== "subagents" ? <button className="screen-navigation-link" onClick={() => navigate("subagents")} type="button"><Users className="size-4" />Subagents</button> : null}
            {!fullConsole ? <button className="screen-navigation-link" onClick={() => navigate("console")} type="button">Full Console</button> : null}
            <BrowserConsoleButton screen={screen} />
          </div>
        </nav>
        <div className="agent-control-screen">
          {screen === "flows" ? <FlowsShell /> : fullConsole ? <ConsoleShell onOpenConversation={() => { setScreen("subagents"); try { window.location.hash = "/subagents"; } catch { /* Keep in-memory navigation in opaque hosts. */ } }} /> : <SubagentsShell />}
        </div>
      </div>
    </ConsoleSelectionProvider>
  );
}

function ConnectionIndicator() {
  const { connection } = useConsoleSelection();
  return <span role="status" className="screen-connection" data-state={connection}>
    <span aria-hidden="true" className="connection-dot" />
    {connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Offline"}
  </span>;
}

function RefreshButton() {
  const { refreshCurrentScreen } = useConsoleSelection();
  return <button type="button" className="screen-navigation-link" aria-label="Refresh" title="Refresh" onClick={refreshCurrentScreen}><RefreshCw className="size-4" /></button>;
}

function BrowserConsoleButton({ screen }: { screen: string }) {
  const { selectedRunId, selectedFlowId } = useConsoleSelection();
  const [embedded, setEmbedded] = useState(false);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setEmbedded(shouldTryMcpApp()), []);
  if (!embedded) return null;
  const open = async () => {
    setOpening(true);
    setFailed(false);
    try {
      const client = await getMcpAppClient();
      if (!client) throw new Error("Console unavailable");
      await client.callTool("agent_control_console_open_browser", { screen, ...(selectedRunId ? { run_id: selectedRunId } : {}), ...(selectedFlowId ? { flow_id: selectedFlowId } : {}) });
    } catch {
      setFailed(true);
    } finally { setOpening(false); }
  };
  return <>
    {failed ? <span role="status" className="text-xs text-ink-400">Could not open browser. Try again.</span> : null}
    <button type="button" className="screen-navigation-link" aria-label="Full screen" title="Open all runs in your browser" disabled={opening} onClick={() => void open()}>
      {opening ? <LoaderCircle className="size-4 animate-spin" /> : <Maximize2 className="size-4" />}
    </button>
  </>;
}
