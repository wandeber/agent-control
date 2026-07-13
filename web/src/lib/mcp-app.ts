"use client";

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

const MCP_APP_PROTOCOL_VERSION = "2026-01-26";

class AgentControlMcpAppClient {
  private readonly pending = new Map<string | number, PendingRequest<unknown>>();
  private nextId = 1;
  private connected = false;
  private readonly onMessage = (event: MessageEvent) => {
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
      await this.request(
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
      this.notify("ui/notifications/initialized", {});
      this.connected = true;
    } catch (error) {
      window.removeEventListener("message", this.onMessage);
      this.pending.clear();
      throw error;
    }
  }

  async callTool<T extends Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.connect();
    const result = await this.request<CallToolResult>(
      "tools/call",
      {
        name,
        arguments: args
      },
      10000
    );
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

function firstTextContent(result: CallToolResult): string | null {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? null;
}
