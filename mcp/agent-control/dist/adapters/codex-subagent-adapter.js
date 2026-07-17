import { ControllerError } from "../core/errors.js";
const CAPABILITIES = {
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
export class CodexSubagentAdapter {
    kind = "codex-subagent";
    capabilities() {
        return CAPABILITIES;
    }
    async start(_input) {
        return rejectDirectCall("spawn_agent");
    }
    async sendMessage(_handle, _message) {
        return rejectDirectCall("send_message");
    }
    async getStatus(_handle) {
        return rejectDirectCall("list_agents");
    }
    async readLatest(_handle, _options) {
        return rejectDirectCall("read_latest");
    }
    async stop(_handle, _options) {
        return rejectDirectCall("interrupt_agent");
    }
}
function rejectDirectCall(operation) {
    throw new ControllerError("Codex subagent operations must be executed through the scoped orchestrator bridge.", "unsupported_operation", { backend: "codex-subagent", operation });
}
