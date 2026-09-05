"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyMcpConsoleToolResult,
  getCachedMcpConsoleState,
  getMcpAppClient,
  shouldTryMcpApp,
  subscribeMcpConsoleState
} from "./mcp-app";
import { SerialRefreshCoordinator } from "./refresh-coordinator";
import { snapshotStreamIsLoading } from "./snapshot-stream-state";
import type { AgentLogTail, AgentMessage, DashboardSnapshot, SocketPayload } from "./types";
import { agentLogQueryKey, agentMessagesQueryKey } from "./workspace-refresh-policy";

export type ConnectionState = "connecting" | "live" | "offline";

// Console lifecycle commands are delivered through the same serialized
// snapshot path as live state. Keeping the last id here lets the next app-only
// read acknowledge a command without requiring a second UI-capable tool call.
let lastMcpConsoleCommandId: string | null = null;

export function controlApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_AGENT_CONTROL_API_BASE;
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  if (typeof window === "undefined") {
    return "http://localhost:3767";
  }
  const runtime = runtimeApiConfig();
  if (runtime.apiBase) {
    return runtime.apiBase;
  }
  return `${window.location.protocol}//${window.location.hostname}:${runtime.apiPort}`;
}

export function controlWsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_AGENT_CONTROL_WS_URL;
  if (configured) {
    return configured;
  }
  if (typeof window === "undefined") {
    return "ws://localhost:3767/ws/control";
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const runtime = runtimeApiConfig();
  if (runtime.wsUrl) {
    return runtime.wsUrl;
  }
  if (runtime.apiBase) {
    const base = new URL(runtime.apiBase);
    return `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}/ws/control`;
  }
  return `${protocol}//${window.location.hostname}:${runtime.apiPort}/ws/control`;
}

function runtimeApiConfig(): { apiBase: string | null; apiPort: number; wsUrl: string | null } {
  const params = new URLSearchParams(window.location.search);
  const explicitApiBase = normalizeBase(params.get("apiBase"));
  const explicitWsUrl = normalizeBase(params.get("wsUrl"));
  const apiPortParam = params.get("apiPort");
  const apiBase = explicitApiBase ?? (apiPortParam ? null : normalizeBase(window.localStorage.getItem("agent-control:api-base")));
  const wsUrl = explicitWsUrl ?? (apiPortParam ? null : normalizeBase(window.localStorage.getItem("agent-control:ws-url")));
  if (explicitApiBase) {
    window.localStorage.setItem("agent-control:api-base", explicitApiBase);
  }
  if (explicitWsUrl) {
    window.localStorage.setItem("agent-control:ws-url", explicitWsUrl);
  }
  if (apiPortParam && /^\d+$/.test(apiPortParam)) {
    window.localStorage.setItem("agent-control:api-port", apiPortParam);
  }
  const storedPort = window.localStorage.getItem("agent-control:api-port");
  const configuredPort = apiPortParam ?? storedPort;
  const parsedConfigured = configuredPort ? Number.parseInt(configuredPort, 10) : Number.NaN;
  const webPort = Number.parseInt(window.location.port, 10);
  const apiPort =
    Number.isFinite(parsedConfigured) && parsedConfigured > 0
      ? parsedConfigured
      : Number.isFinite(webPort) && webPort > 0
        ? webPort + 1
        : 3767;
  return { apiBase, apiPort, wsUrl };
}

function normalizeBase(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : null;
}

export async function fetchSnapshot(runId?: string | null): Promise<DashboardSnapshot> {
  const client = await getMcpAppClient();
  if (client) {
    const acknowledgedCommandId = lastMcpConsoleCommandId;
    const result = await client.callTool<{
      snapshot: DashboardSnapshot;
      console?: { action?: "reuse" | "close"; command_id?: string };
    }>("agent_control_console_snapshot", {
      ...(runId ? { run_id: runId } : {}),
      ...(acknowledgedCommandId ? { command_id: acknowledgedCommandId } : {})
    });
    if (acknowledgedCommandId && result.console?.command_id !== acknowledgedCommandId) {
      lastMcpConsoleCommandId = null;
    }
    if (result.console?.action && result.console.command_id) {
      lastMcpConsoleCommandId = result.console.command_id;
      applyMcpConsoleToolResult(result as unknown as Record<string, unknown>);
    }
    return result.snapshot;
  }

  const url = new URL(`${controlApiBase()}/api/control/snapshot`);
  if (runId) {
    url.searchParams.set("run_id", runId);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Snapshot request failed: ${response.status}`);
  }
  return (await response.json()) as DashboardSnapshot;
}

export async function fetchAgentMessages(agentId: string, limit = 12): Promise<AgentMessage[]> {
  const client = await getMcpAppClient();
  if (client) {
    const result = await client.callTool<{ messages: AgentMessage[] }>("agent_control_console_agent_messages", {
      agent_id: agentId,
      limit
    });
    return result.messages;
  }

  const url = new URL(`${controlApiBase()}/api/control/agents/${encodeURIComponent(agentId)}/messages`);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Message request failed: ${response.status}`);
  }
  return (await response.json()) as AgentMessage[];
}

export async function fetchAgentLog(agentId: string, maxChars = 16000): Promise<AgentLogTail> {
  const client = await getMcpAppClient();
  if (client) {
    const result = await client.callTool<{ log: AgentLogTail }>("agent_control_console_agent_log", {
      agent_id: agentId,
      max_chars: maxChars
    });
    return result.log;
  }

  const url = new URL(`${controlApiBase()}/api/control/agents/${encodeURIComponent(agentId)}/log`);
  url.searchParams.set("max_chars", String(maxChars));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Log request failed: ${response.status}`);
  }
  return (await response.json()) as AgentLogTail;
}

export function artifactImageUrl(artifactId: string): string {
  if (shouldTryMcpApp()) {
    return "";
  }
  return `${controlApiBase()}/api/control/artifacts/${encodeURIComponent(artifactId)}/file`;
}

export function useSnapshotStream(
  selectedRunId: string | null,
  selectedAgentId: string | null,
  followLatestRun = false,
  selectedAgentMessageLimit = 48
) {
  const queryClient = useQueryClient();
  const mcpMode = shouldTryMcpApp();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(() => getCachedMcpConsoleState().snapshot);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [agentLog, setAgentLog] = useState<AgentLogTail | null>(null);
  const [streamError, setStreamError] = useState<Error | null>(null);
  const lastEventIds = useRef<Set<string>>(new Set());
  const refreshCoordinator = useRef<SerialRefreshCoordinator<McpRefreshPayload> | null>(null);
  refreshCoordinator.current ??= new SerialRefreshCoordinator<McpRefreshPayload>(1400);
  const requestedRunId = followLatestRun ? null : selectedRunId;
  const requestedMessageLimit = Math.max(1, Math.trunc(selectedAgentMessageLimit));
  // Keep browser/WebSocket effect dependencies stable when only its separate
  // React Query history limit changes. The serial coordinator is the sole
  // consumer of this value, so zero is an unused browser-mode sentinel.
  const mcpMessageLimit = mcpMode ? requestedMessageLimit : 0;

  const query = useQuery({
    queryKey: ["snapshot", requestedRunId],
    queryFn: () => fetchSnapshot(requestedRunId),
    // MCP mode has its own serial coordinator. Enabling this query there would
    // create a second polling loop whose tool calls can overlap and return in
    // the wrong selection order.
    enabled: !mcpMode,
    refetchInterval: !mcpMode && connection !== "live" ? 2500 : false
  });

  useEffect(() => {
    if (!mcpMode && query.data) {
      setSnapshot(query.data);
    }
  }, [mcpMode, query.data]);

  useEffect(() => {
    if (!mcpMode) {
      return;
    }
    return subscribeMcpConsoleState((state) => {
      if (!state.snapshot) {
        return;
      }
      // The host-provided opening result is the fastest authoritative seed.
      // Regular app polling is applied by the generation-aware coordinator
      // below, not through this notification cache.
      setSnapshot(state.snapshot);
      setConnection("live");
      setStreamError(null);
    });
  }, [mcpMode]);

  useEffect(() => {
    if (mcpMode) {
      setConnection("connecting");
      refreshCoordinator.current?.start({
        task: async () => {
          const nextSnapshot = await fetchSnapshot(requestedRunId);
          if (!selectedAgentId || !nextSnapshot.agents.some((agent) => agent.agent_id === selectedAgentId)) {
            return {
              snapshot: nextSnapshot,
              selectedAgentId: null,
              messageLimit: mcpMessageLimit,
              messages: null,
              log: null
            };
          }

          // Keep all reads inside one serialized task. Snapshot, messages, and
          // log therefore describe one selection generation and cannot overlap
          // the next 1.4-second refresh cycle.
          const messages = await fetchAgentMessages(selectedAgentId, mcpMessageLimit);
          const log = await fetchAgentLog(selectedAgentId, 24000);
          return { snapshot: nextSnapshot, selectedAgentId, messageLimit: mcpMessageLimit, messages, log };
        },
        onResult: (result) => {
          setConnection("live");
          setStreamError(null);
          setSnapshot(result.snapshot);
          for (const item of result.snapshot.latest_events) {
            lastEventIds.current.add(item.event_id);
          }
          if (result.selectedAgentId && result.messages) {
            // WorkspacePanel creates this exact disabled query in MCP mode.
            // Updating only the current history generation prevents a smaller
            // cached page from replacing a user-requested older-message page.
            queryClient.setQueryData<AgentMessage[]>(
              agentMessagesQueryKey(result.selectedAgentId, result.messageLimit),
              result.messages
            );
            if (result.log) {
              queryClient.setQueryData<AgentLogTail>(agentLogQueryKey(result.selectedAgentId), result.log);
            }
          }
          setAgentLog(result.log);
        },
        onError: (error) => {
          setConnection("offline");
          setStreamError(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return () => {
        refreshCoordinator.current?.stop();
      };
    }

    let closed = false;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = () => {
      setConnection("connecting");
      socket = new WebSocket(controlWsUrl());
      socket.addEventListener("open", () => {
        setConnection("live");
        socket?.send(JSON.stringify({ type: "select", run_id: requestedRunId, agent_id: selectedAgentId }));
      });
      socket.addEventListener("message", (event) => {
        setConnection("live");
        const payload = JSON.parse(String(event.data)) as SocketPayload;
        if (payload.type === "snapshot") {
          if (requestedRunId && payload.snapshot.selected_run_id !== requestedRunId) {
            return;
          }
          setSnapshot(payload.snapshot);
          for (const item of payload.snapshot.latest_events) {
            lastEventIds.current.add(item.event_id);
          }
        } else if (payload.type === "event") {
          lastEventIds.current.add(payload.event.event_id);
        } else if (payload.type === "agent_messages") {
          queryClient.setQueriesData<AgentMessage[]>(
            { queryKey: ["messages", payload.agent_id] },
            payload.messages
          );
        } else if (payload.type === "agent_log") {
          setAgentLog(payload.log);
        }
      });
      socket.addEventListener("close", () => {
        if (closed) {
          return;
        }
        setConnection("offline");
        reconnect = setTimeout(connect, 1400);
      });
      socket.addEventListener("error", () => setConnection("offline"));
    };

    connect();

    return () => {
      closed = true;
      if (reconnect) {
        clearTimeout(reconnect);
      }
      socket?.close();
    };
  }, [mcpMessageLimit, mcpMode, queryClient, requestedRunId, selectedAgentId]);

  const refresh = useCallback(() => {
    if (mcpMode) {
      refreshCoordinator.current?.request();
      return;
    }
    void query.refetch();
  }, [mcpMode, query.refetch]);

  const selectedRun = useMemo(
    () => snapshot?.runs.find((run) => run.run_id === snapshot.selected_run_id) ?? null,
    [snapshot]
  );

  return {
    snapshot,
    selectedRun,
    connection,
    agentLog,
    refresh,
    isLoading: snapshotStreamIsLoading({
      hasSnapshot: Boolean(snapshot),
      hasError: Boolean(mcpMode ? streamError : query.error),
      mcpMode,
      queryLoading: query.isLoading
    }),
    error: mcpMode ? streamError : query.error
  };
}

interface McpRefreshPayload {
  snapshot: DashboardSnapshot;
  selectedAgentId: string | null;
  messageLimit: number;
  messages: AgentMessage[] | null;
  log: AgentLogTail | null;
}
