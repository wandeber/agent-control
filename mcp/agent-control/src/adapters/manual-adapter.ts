import { ControllerError } from "../core/errors.js";
import {
  AGENT_STATUSES,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentHandle,
  type AgentMessage,
  type AgentMessageInput,
  type AgentStatus,
  type AgentStatusSnapshot,
  type ReadLatestOptions,
  type StartAgentInput,
  type StopOptions,
  type StopResult,
  type UnregisterOptions
} from "../core/types.js";

const CAPABILITIES: AgentCapabilities = {
  canStart: false,
  canSendMessage: false,
  canReadLatest: true,
  canStopGracefully: true,
  canForceStop: false,
  canStreamMessages: false,
  canInspectStatusCheaply: true,
  canAttachExisting: true
};

interface ManualHandleData {
  id?: string;
  status?: AgentStatus;
  message?: string;
  messages?: AgentMessage[];
}

export class ManualAdapter implements AgentAdapter {
  readonly kind = "manual";

  capabilities(): AgentCapabilities {
    return CAPABILITIES;
  }

  async start(input: StartAgentInput): Promise<AgentHandle> {
    if (!input.agent.backend_handle) {
      throw new ControllerError("Manual backend cannot start agents.", "unsupported_operation", {
        backend: this.kind
      });
    }

    const data = parseHandle(input.agent.backend_handle);
    return {
      backend: this.kind,
      id: data.id ?? input.agent.agent_id,
      data: input.agent.backend_handle
    };
  }

  async sendMessage(_handle: AgentHandle, _message: AgentMessageInput): Promise<void> {
    throw new ControllerError("Manual backend cannot deliver messages.", "unsupported_operation", {
      backend: this.kind
    });
  }

  async getStatus(handle: AgentHandle): Promise<AgentStatusSnapshot> {
    const data = parseHandle(handle.data);
    return {
      status: data.status ?? "waiting_for_input",
      message: data.message,
      data: { backend: this.kind, id: data.id ?? handle.id }
    };
  }

  async readLatest(handle: AgentHandle, options: ReadLatestOptions): Promise<AgentMessage[]> {
    const data = parseHandle(handle.data);
    return (data.messages ?? []).slice(-options.limit);
  }

  async stop(handle: AgentHandle, _options: StopOptions): Promise<StopResult> {
    const data = parseHandle(handle.data);
    return {
      status: "stopped",
      message: "Manual participant marked stopped by Agent Control.",
      data: { backend: this.kind, id: data.id ?? handle.id }
    };
  }

  async unregister(_handle: AgentHandle, _options: UnregisterOptions): Promise<void> {
    // Manual participants have no external process or session to archive.
  }
}

function parseHandle(value: Record<string, unknown>): ManualHandleData {
  const status = typeof value.status === "string" && isAgentStatus(value.status) ? value.status : undefined;
  const messages = Array.isArray(value.messages)
    ? value.messages
        .map((item, index) => normalizeMessage(item, index))
        .filter((message): message is AgentMessage => Boolean(message))
    : undefined;

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    status,
    message: typeof value.message === "string" ? value.message : undefined,
    messages
  };
}

function normalizeMessage(value: unknown, index: number): AgentMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : undefined;
  if (!text) {
    return null;
  }

  return {
    id: typeof record.id === "string" ? record.id : `manual-message-${index + 1}`,
    role: typeof record.role === "string" ? record.role : "assistant",
    text,
    created_at: typeof record.created_at === "string" ? record.created_at : new Date().toISOString(),
    metadata: record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : undefined
  };
}

function isAgentStatus(value: string): value is AgentStatus {
  return (AGENT_STATUSES as readonly string[]).includes(value);
}
