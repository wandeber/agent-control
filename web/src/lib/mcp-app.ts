"use client";

import type { DashboardSnapshot } from "./types";

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: string | number;
  result: T;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number;
  error: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type McpUiDisplayMode = "inline" | "fullscreen" | "pip";

interface McpHostContext {
  theme?: "light" | "dark";
  availableDisplayModes?: McpUiDisplayMode[];
  displayMode?: McpUiDisplayMode;
}

export interface ConsoleSelectionState {
  screen?: "console" | "subagents" | "flows";
  flow_id?: string;
  repo_dir?: string;
  panel_id?: string;
  requested_run_id: string | null;
  follow_latest: boolean;
  action?: "reuse" | "close";
  command_id?: string;
}

export interface McpConsoleState {
  snapshot: DashboardSnapshot | null;
  console: ConsoleSelectionState | null;
}

type ConsoleStateListener = (state: McpConsoleState) => void;

const MCP_APP_PROTOCOL_VERSION = "2026-01-26";

/**
 * Keeps host-provided tool input/output outside React so notifications that
 * arrive before a component subscribes are not lost. Codex can deliver the
 * opening tool result immediately after the app bridge initializes; replaying
 * the cache lets the first render use that snapshot instead of waiting for the
 * next polling tick.
 */
export class McpConsoleNotificationStore {
  private readonly listeners = new Set<ConsoleStateListener>();
  private readonly retiredPanels = new Set<string>();
  private state: McpConsoleState = { snapshot: null, console: null };

  consume(event: Pick<MessageEvent, "data" | "source">, expectedSource: MessageEventSource | null): boolean {
    // The iframe talks only to its direct host. Accepting same-shaped messages
    // from arbitrary child/sibling windows would let unrelated page content
    // replace the visible run or inject a fake dashboard snapshot.
    if (!expectedSource || event.source !== expectedSource) {
      return false;
    }

    const message = asRecord(event.data) as JsonRpcNotification | null;
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return false;
    }

    if (message.method === "ui/notifications/tool-input") {
      this.applyToolInput(message.params);
      return true;
    }
    if (message.method === "ui/notifications/tool-result") {
      this.applyToolResult(message.params);
      return true;
    }
    return false;
  }

  applyToolInput(value: unknown): void {
    const params = asRecord(value);
    const args = asRecord(params?.arguments) ?? params;
    if (!args) {
      return;
    }

    const requestedRunId = nonEmptyString(args.run_id);
    const action = args.action === "reuse" || args.action === "close" ? args.action : undefined;
    // App-only snapshot acknowledgements can carry a command_id. They are
    // transport bookkeeping, not a new run-selection request.
    const commandId = nonEmptyString(args.command_id);
    if (commandId && !action) {
      return;
    }
    this.publish({
      console: {
        ...flowSelectionFields(args),
        requested_run_id: requestedRunId,
        follow_latest: !requestedRunId,
        ...(action ? { action } : {}),
        ...(commandId ? { command_id: commandId } : {})
      }
    });
  }

  applyToolResult(value: unknown): void {
    const result = unwrapCallToolResult(value);
    const structured = asRecord(result?.structuredContent);
    if (!structured) {
      return;
    }

    const snapshot = isDashboardSnapshot(structured.snapshot) ? structured.snapshot : undefined;
    const consoleState = parseConsoleSelection(structured.console);
    const nextPanel = consoleState?.panel_id;
    if (nextPanel && this.retiredPanels.has(nextPanel)) return;
    const previousPanel = this.state.console?.panel_id;
    if (nextPanel && previousPanel && nextPanel !== previousPanel) this.retiredPanels.add(previousPanel);
    if (!snapshot && !consoleState) {
      return;
    }
    this.publish({ snapshot, console: consoleState ?? undefined });
  }

  current(): McpConsoleState {
    return this.state;
  }

  subscribe(listener: ConsoleStateListener): () => void {
    this.listeners.add(listener);
    if (this.state.snapshot || this.state.console) {
      listener(this.state);
    }
    return () => this.listeners.delete(listener);
  }

  private publish(patch: { snapshot?: DashboardSnapshot; console?: ConsoleSelectionState }): void {
    this.state = {
      snapshot: patch.snapshot ?? this.state.snapshot,
      console: patch.console ? { ...patch.console, panel_id: patch.console.panel_id ?? this.state.console?.panel_id } : this.state.console
    };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

const consoleNotifications = new McpConsoleNotificationStore();

class AgentControlMcpAppClient {
  private readonly pending = new Map<string | number, PendingRequest<unknown>>();
  private nextId = 1;
  private connected = false;
  private hostContext: McpHostContext | null = null;
  private readonly onMessage = (event: MessageEvent) => {
    // Notification handling deliberately runs before response handling because
    // MCP App notifications have no JSON-RPC id. The old id-only parser
    // silently discarded the opening tool input/result sent by newer hosts.
    if (consoleNotifications.consume(event, window.parent)) {
      return;
    }

    if (event.source !== window.parent) {
      return;
    }

    const notification = asRecord(event.data) as JsonRpcNotification | null;
    if (notification?.method === "ui/notifications/host-context-changed") {
      this.hostContext = parseHostContext(notification.params);
      applyHostTheme(this.hostContext);
      return;
    }

    // MCP Apps hosts may acknowledge an app-requested teardown by sending a
    // resource-teardown request before unmounting the iframe. This console has
    // no unsaved client state, so acknowledge it immediately instead of
    // leaving the host waiting for a graceful-termination response.
    if (notification?.method === "ui/resource-teardown") {
      const requestId = asRecord(event.data)?.id;
      if (typeof requestId === "string" || typeof requestId === "number") {
        window.parent.postMessage({ jsonrpc: "2.0", id: requestId, result: {} }, "*");
      }
      return;
    }

    const message = event.data as JsonRpcSuccess<unknown> | JsonRpcFailure | undefined;
    if (!message || message.jsonrpc !== "2.0" || typeof message.id === "undefined") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if ("error" in message) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  };

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    window.addEventListener("message", this.onMessage);
    try {
      const initializeResult = await this.request<{ hostContext?: unknown }>(
        "ui/initialize",
        {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          appInfo: {
            name: "agent-control-console",
            title: "Agent Control Console",
            version: "0.1.0"
          },
          appCapabilities: {
            availableDisplayModes: ["fullscreen", "inline"]
          }
        },
        900
      );
      this.hostContext = parseHostContext(initializeResult?.hostContext);
      applyHostTheme(this.hostContext);
      this.notify("ui/notifications/initialized", {});
      this.connected = true;
      // Codex exposes fullscreen MCP Apps in its shared app/sidebar surface.
      // Request it from the app bridge instead of relying on a visual click or
      // Computer Use. Hosts that do not support the mode simply reject it and
      // keep the widget inline.
      void this.requestPreferredDisplayMode();
    } catch (error) {
      window.removeEventListener("message", this.onMessage);
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
      }
      this.pending.clear();
      throw error;
    }
  }

  async callTool<T extends Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.connect();
    const panelId = name.startsWith("agent_control_console_") ? await waitForConsolePanel() : undefined;
    const result = await this.request<CallToolResult>(
      "tools/call",
      {
        name,
        arguments: panelId
          ? { ...args, panel_id: panelId }
          : args
      },
      name === "agent_control_console_open_browser" ? 15000 : 10000
    );
    if (panelId && consoleNotifications.current().console?.panel_id !== panelId) {
      throw new Error("The console panel has been reopened.");
    }
    if (result.isError) {
      throw new Error(firstTextContent(result) ?? `MCP tool ${name} failed.`);
    }

    if (result.structuredContent) {
      return result.structuredContent as T;
    }
    const text = firstTextContent(result);
    if (text) {
      const parsed = JSON.parse(text) as T;
      return parsed;
    }
    return {} as T;
  }

  /** Ask the host to tear down this MCP App surface. The host may decline. */
  requestTeardown(): void {
    this.notify("ui/request-teardown", {});
  }

  private async requestPreferredDisplayMode(): Promise<void> {
    if (this.hostContext?.displayMode === "fullscreen") {
      return;
    }
    if (this.hostContext?.availableDisplayModes && !this.hostContext.availableDisplayModes.includes("fullscreen")) {
      return;
    }

    try {
      const result = await this.request<{ mode?: unknown }>(
        "ui/request-display-mode",
        { mode: "fullscreen" },
        5000
      );
      const mode = displayMode(result?.mode);
      if (mode) {
        this.hostContext = { ...this.hostContext, displayMode: mode };
      }
    } catch {
      // Display-mode changes are host-controlled. An unsupported or rejected
      // request must not make the console unavailable in its inline fallback.
    }
  }

  private request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP App response to ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      window.parent.postMessage(message, "*");
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  }
}

let clientPromise: Promise<AgentControlMcpAppClient | null> | null = null;

function waitForConsolePanel(): Promise<string> {
  const current = consoleNotifications.current().console?.panel_id;
  if (current) return Promise.resolve(current);
  // The bridge can initialize before the host delivers the opening result.
  // Wait for its scope instead of issuing an unscoped first refresh.
  return new Promise((resolvePanel, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Waiting for the Codex console identity.")); }, 5000);
    unsubscribe = consoleNotifications.subscribe(state => {
      if (!state.console?.panel_id) return;
      clearTimeout(timer);
      unsubscribe();
      resolvePanel(state.console.panel_id);
    });
  });
}

export function shouldTryMcpApp(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}

export function getMcpAppClient(): Promise<AgentControlMcpAppClient | null> {
  if (!shouldTryMcpApp()) {
    return Promise.resolve(null);
  }
  clientPromise ??= (async () => {
    const client = new AgentControlMcpAppClient();
    try {
      await client.connect();
      return client;
    } catch {
      return null;
    }
  })();
  return clientPromise;
}

export function getCachedMcpConsoleState(): McpConsoleState {
  return consoleNotifications.current();
}

export function subscribeMcpConsoleState(listener: ConsoleStateListener): () => void {
  const unsubscribe = consoleNotifications.subscribe(listener);
  if (shouldTryMcpApp()) {
    // Initializing here ensures the host listener exists before React Query or
    // the serial refresher needs data. Cache replay makes subscription order
    // irrelevant once the host has sent the opening result.
    void getMcpAppClient();
  }
  return unsubscribe;
}

/** Apply a structured app-only snapshot result to the shared console bridge. */
export function applyMcpConsoleToolResult(value: Record<string, unknown>): void {
  consoleNotifications.applyToolResult({ structuredContent: value });
}

/** Request closure of the currently mounted native Agent Control surface. */
export async function requestMcpAppTeardown(): Promise<boolean> {
  const client = await getMcpAppClient();
  if (!client) {
    return false;
  }
  client.requestTeardown();
  return true;
}

function unwrapCallToolResult(value: unknown): CallToolResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const nestedResult = asRecord(record.result);
  return (nestedResult ?? record) as CallToolResult;
}

function parseConsoleSelection(value: unknown): ConsoleSelectionState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const requestedRunId = nonEmptyString(record.requested_run_id);
  const action = record.action === "reuse" || record.action === "close" ? record.action : undefined;
  const commandId = nonEmptyString(record.command_id);
  const panelId = nonEmptyString(record.panel_id);
  return {
    ...flowSelectionFields(record),
    requested_run_id: requestedRunId,
    follow_latest: typeof record.follow_latest === "boolean" ? record.follow_latest : !requestedRunId,
    ...(action ? { action } : {}),
    ...(commandId ? { command_id: commandId } : {}),
    ...(panelId ? { panel_id: panelId } : {})
  };
}

function flowSelectionFields(record: Record<string, unknown>): Partial<ConsoleSelectionState> {
  return { ...(record.screen === "flows" || record.screen === "console" || record.screen === "subagents" ? { screen: record.screen } : {}),
    ...(nonEmptyString(record.flow_id) ? { flow_id: String(record.flow_id) } : {}),
    ...(nonEmptyString(record.repo_dir) ? { repo_dir: String(record.repo_dir) } : {}) };
}

function parseHostContext(value: unknown): McpHostContext | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const availableDisplayModes = Array.isArray(record.availableDisplayModes)
    ? record.availableDisplayModes.map(displayMode).filter((mode): mode is McpUiDisplayMode => Boolean(mode))
    : undefined;
  const mode = displayMode(record.displayMode);
  return {
    ...(record.theme === "light" || record.theme === "dark" ? { theme: record.theme } : {}),
    ...(availableDisplayModes ? { availableDisplayModes } : {}),
    ...(mode ? { displayMode: mode } : {})
  };
}

function displayMode(value: unknown): McpUiDisplayMode | null {
  return value === "inline" || value === "fullscreen" || value === "pip" ? value : null;
}

function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.generated_at === "string" &&
      (typeof record.selected_run_id === "string" || record.selected_run_id === null) &&
      Array.isArray(record.runs) &&
      Array.isArray(record.agents)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstTextContent(result: CallToolResult): string | null {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? null;
}

// Attach the parent listener as soon as the iframe bundle evaluates. React
// components subscribe later, but the store above replays anything delivered
// between bridge initialization and component mount.
if (shouldTryMcpApp()) {
  void getMcpAppClient();
}

function applyHostTheme(context: McpHostContext | null) {
  if (context?.theme && typeof document !== "undefined") document.documentElement.dataset.theme = context.theme;
}
