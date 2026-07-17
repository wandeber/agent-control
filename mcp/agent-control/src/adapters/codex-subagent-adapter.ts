import { ControllerError } from "../core/errors.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHandle,
  AgentMessage,
  AgentMessageInput,
  AgentStatusSnapshot,
  ReadLatestOptions,
  StartAgentInput,
  StopOptions,
  StopResult
} from "../core/types.js";

const CAPABILITIES: AgentCapabilities = {
  canStart: true,
  canSendMessage: true,
  canReadLatest: false,
  canStopGracefully: false,
  canForceStop: false,
  canStreamMessages: false,
  canInspectStatusCheaply: false,
  canAttachExisting: true,
  requiresOrchestratorAction: true,
  canInterrupt: true
};

/**
 * Codex subagent v2 tools are available only to the root Codex task. This
 * adapter is therefore a capability marker: the controller persists a scoped
 * orchestrator action before any of these methods could be called, and the
 * root bridge later executes that action with the native collaboration tool.
 */
export class CodexSubagentAdapter implements AgentAdapter {
  readonly kind = "codex-subagent";

  capabilities(): AgentCapabilities {
    return CAPABILITIES;
  }

  async start(_input: StartAgentInput): Promise<AgentHandle> {
    return rejectDirectCall("spawn_agent");
  }

  async sendMessage(_handle: AgentHandle, _message: AgentMessageInput): Promise<void> {
    return rejectDirectCall("send_message");
  }

  async getStatus(_handle: AgentHandle): Promise<AgentStatusSnapshot> {
    return rejectDirectCall("list_agents");
  }

  async readLatest(_handle: AgentHandle, _options: ReadLatestOptions): Promise<AgentMessage[]> {
    return rejectDirectCall("read_latest");
  }

  async stop(_handle: AgentHandle, _options: StopOptions): Promise<StopResult> {
    return rejectDirectCall("interrupt_agent");
  }
}

function rejectDirectCall(operation: string): never {
  throw new ControllerError(
    "Codex subagent operations must be executed through the scoped orchestrator bridge.",
    "unsupported_operation",
    { backend: "codex-subagent", operation }
  );
}
