"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { controlApiBase } from "./api";
import { applyMcpConsoleToolResult, getCachedMcpConsoleState, getMcpAppClient, shouldTryMcpApp } from "./mcp-app";
import type { FlowConfigRecord } from "./types";

export interface FlowCatalogEntry {
  catalog_id: string; flow_id: string | null; directory_name: string; config_path: string;
  description: string | null; version: string | null; valid: boolean; error: string | null;
}
export interface FlowPromptPreview { scope: "role" | "step"; owner_id: string; path?: string; text: string | null; error: string | null }
export interface FlowDefinition extends FlowCatalogEntry { config: FlowConfigRecord; prompts: Record<string, FlowPromptPreview[]> }
export interface FlowPreview {
  project_dir: string | null; selected_flow_id: string | null; flows: FlowCatalogEntry[];
  catalogs: Array<{ catalog_id: string; name: string; root_path: string }>;
  definition: FlowDefinition | null; error: string | null; revision: string;
}

async function fetchFlowPreview(projectDir: string | null, flowId: string | null, isCurrent: () => boolean): Promise<FlowPreview> {
  const client = await getMcpAppClient();
  if (client) {
    const selection = getCachedMcpConsoleState().console;
    const command = selection?.command_id;
    const result = await client.callTool<{ preview: FlowPreview; console?: Record<string, unknown> }>("agent_control_console_flows", {
      ...(flowId ? { flow_id: flowId } : {}), ...(command ? { command_id: command } : {})
    });
    if (isCurrent() && getCachedMcpConsoleState().console === selection && result.console?.command_id && result.console.command_id !== command) applyMcpConsoleToolResult(result);
    return result.preview;
  }
  if (shouldTryMcpApp()) throw new Error("The Codex panel is offline.");
  const url = new URL(`${controlApiBase()}/api/control/flows`);
  if (flowId) url.searchParams.set("flow_id", flowId);
  if (projectDir) url.searchParams.set("repo_dir", projectDir);
  const result = await fetch(url);
  if (!result.ok) throw new Error("Flow preview unavailable.");
  return result.json();
}

/** Serial source refresh runs in the UI, without model turns or worker polling. */
export function useFlowPreview(projectDir: string | null, flowId: string | null) {
  const key = JSON.stringify([projectDir, flowId]);
  const [state, setState] = useState<{ key: string; data: FlowPreview; lastValid: FlowDefinition | null } | null>(null);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let disposed = false, pending = false;
    let timer: ReturnType<typeof setTimeout>;
    setConnection("connecting");
    const read = async () => {
      if (pending || disposed) return;
      clearTimeout(timer); pending = true;
      try {
        const data = await fetchFlowPreview(projectDir, flowId, () => !disposed);
        if (disposed) return;
        setState(previous => previous?.key === key && previous.data.revision === data.revision ? previous : {
          key, data, lastValid: data.definition ?? (previous?.key === key ? previous.lastValid : null)
        });
        setConnection("live");
      } catch { if (!disposed) setConnection("offline"); }
      finally { pending = false; if (!disposed) timer = setTimeout(() => void read(), document.hidden ? 5000 : 1000); }
    };
    refreshRef.current = () => void read();
    const foreground = () => { if (!document.hidden) void read(); };
    document.addEventListener("visibilitychange", foreground);
    void read();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", foreground); };
  }, [key, projectDir, flowId]);
  const current = state?.key === key ? state : null;
  return { data: current?.data ?? null, definition: current?.lastValid ?? null, connection, refresh };
}
