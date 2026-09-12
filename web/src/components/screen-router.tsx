"use client";

import { Settings, Users, RefreshCw, Maximize2, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConsoleSelectionProvider, useConsoleSelection } from "./console-selection";
import { ConsoleShell } from "./console-shell";
import { FlowsShell } from "./flows-shell";
import { SubagentsShell } from "./subagents-shell";
import { AgentsShell } from "./agents-shell";
import type { SettingsSection } from "./settings-navigation";
import { getMcpAppClient, shouldTryMcpApp, subscribeMcpConsoleState } from "@/lib/mcp-app";

type Screen = "console" | "subagents" | SettingsSection;

export function ScreenRouter() {
  const [screen, setScreen] = useState<Screen>("subagents");
  const lastSettingsSection = useRef<SettingsSection>("agents");
  const selectScreen = useCallback((next: Screen) => {
    if (next === "agents" || next === "flows") lastSettingsSection.current = next;
    setScreen(next);
  }, []);
  useEffect(() => {
    const syncScreen = () => selectScreen(window.location.hash === "#/flows" ? "flows" : window.location.hash === "#/console" ? "console" : window.location.hash === "#/agents" ? "agents" : "subagents");
    syncScreen();
    let lastCommand: string | undefined;
    const unsubscribe = subscribeMcpConsoleState(state => {
      const selection = state.console;
      const key = selection?.command_id ?? selection?.panel_id;
      if (key && key !== lastCommand && selection?.screen) { lastCommand = key; selectScreen(selection.screen); }
    });
    window.addEventListener("hashchange", syncScreen);
    window.addEventListener("popstate", syncScreen);
    return () => {
      unsubscribe();
      window.removeEventListener("hashchange", syncScreen);
      window.removeEventListener("popstate", syncScreen);
    };
  }, [selectScreen]);

  const fullConsole = screen === "console";
  const settings = screen === "agents" || screen === "flows";
  const navigate = (next: Screen) => { selectScreen(next); try { window.location.hash = `/${next}`; } catch { /* Opaque host. */ } };
  return (
    <ConsoleSelectionProvider>
      <div className="agent-control-app" data-screen={screen}>
        <nav aria-label="Agent Control screens" className="screen-navigation">
          <strong>{settings ? "Settings" : fullConsole ? "Full Console" : "Subagents"}</strong>
          {/* Fragment routes keep the single embedded MCP resource loaded.
              Every screen is eagerly bundled, and only the active one mounts. */}
          <div className="screen-navigation-actions"><ConnectionIndicator /><RefreshButton />
            {screen !== "subagents" ? <button className="screen-navigation-link" onClick={() => navigate("subagents")} type="button"><Users className="size-4" />Subagents</button> : null}
            {!fullConsole ? <button className="screen-navigation-link" onClick={() => navigate("console")} type="button">Full Console</button> : null}
            <button className="screen-navigation-link" aria-current={settings ? "page" : undefined} onClick={() => navigate(lastSettingsSection.current)} type="button"><Settings className="size-4" />Settings</button>
            <BrowserConsoleButton screen={screen} />
          </div>
        </nav>
        <div className="agent-control-screen">
          {screen === "flows" ? <FlowsShell onNavigate={navigate} /> : screen === "agents" ? <AgentsShell onNavigate={navigate} /> : fullConsole ? <ConsoleShell onOpenConversation={() => navigate("subagents")} /> : <SubagentsShell />}
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
      await client.callTool("agent_control_console_open_browser", { screen, ...(screen !== "agents" && selectedRunId ? { run_id: selectedRunId } : {}), ...(screen === "flows" && selectedFlowId ? { flow_id: selectedFlowId } : {}) });
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
