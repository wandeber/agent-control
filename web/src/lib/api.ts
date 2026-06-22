"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentLogTail, AgentMessage, DashboardSnapshot, SocketPayload } from "./types";

export type ConnectionState = "connecting" | "live" | "offline";

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
  const url = new URL(`${controlApiBase()}/api/control/agents/${encodeURIComponent(agentId)}/messages`);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Message request failed: ${response.status}`);
  }
  return (await response.json()) as AgentMessage[];
}

export async function fetchAgentLog(agentId: string, maxChars = 16000): Promise<AgentLogTail> {
  const url = new URL(`${controlApiBase()}/api/control/agents/${encodeURIComponent(agentId)}/log`);
  url.searchParams.set("max_chars", String(maxChars));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Log request failed: ${response.status}`);
  }
  return (await response.json()) as AgentLogTail;
}

export function artifactImageUrl(artifactId: string): string {
  return `${controlApiBase()}/api/control/artifacts/${encodeURIComponent(artifactId)}/file`;
}

export function useSnapshotStream(selectedRunId: string | null, selectedAgentId: string | null, followLatestRun = false) {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [agentLog, setAgentLog] = useState<AgentLogTail | null>(null);
  const lastEventIds = useRef<Set<string>>(new Set());
  const requestedRunId = followLatestRun ? null : selectedRunId;

  const query = useQuery({
    queryKey: ["snapshot", requestedRunId],
    queryFn: () => fetchSnapshot(requestedRunId),
    refetchInterval: connection === "live" ? false : 2500
  });

  useEffect(() => {
    if (query.data) {
      setSnapshot(query.data);
    }
  }, [query.data]);

  useEffect(() => {
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
  }, [queryClient, requestedRunId, selectedAgentId]);

  const selectedRun = useMemo(
    () => snapshot?.runs.find((run) => run.run_id === snapshot.selected_run_id) ?? null,
    [snapshot]
  );

  return {
    snapshot,
    selectedRun,
    connection,
    agentLog,
    isLoading: query.isLoading && !snapshot,
    error: query.error
  };
}
