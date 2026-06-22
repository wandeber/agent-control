import { ControllerError } from "../core/errors.js";
import { AGENT_STATUSES } from "../core/types.js";
const CAPABILITIES = {
    canStart: false,
    canSendMessage: false,
    canReadLatest: true,
    canStopGracefully: true,
    canForceStop: false,
    canStreamMessages: false,
    canInspectStatusCheaply: true,
    canAttachExisting: true
};
export class ManualAdapter {
    kind = "manual";
    capabilities() {
        return CAPABILITIES;
    }
    async start(input) {
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
    async sendMessage(_handle, _message) {
        throw new ControllerError("Manual backend cannot deliver messages.", "unsupported_operation", {
            backend: this.kind
        });
    }
    async getStatus(handle) {
        const data = parseHandle(handle.data);
        return {
            status: data.status ?? "waiting_for_input",
            message: data.message,
            data: { backend: this.kind, id: data.id ?? handle.id }
        };
    }
    async readLatest(handle, options) {
        const data = parseHandle(handle.data);
        return (data.messages ?? []).slice(-options.limit);
    }
    async stop(handle, _options) {
        const data = parseHandle(handle.data);
        return {
            status: "stopped",
            message: "Manual participant marked stopped by Agent Control.",
            data: { backend: this.kind, id: data.id ?? handle.id }
        };
    }
    async unregister(_handle, _options) {
        // Manual participants have no external process or session to archive.
    }
}
function parseHandle(value) {
    const status = typeof value.status === "string" && isAgentStatus(value.status) ? value.status : undefined;
    const messages = Array.isArray(value.messages)
        ? value.messages
            .map((item, index) => normalizeMessage(item, index))
            .filter((message) => Boolean(message))
        : undefined;
    return {
        id: typeof value.id === "string" ? value.id : undefined,
        status,
        message: typeof value.message === "string" ? value.message : undefined,
        messages
    };
}
function normalizeMessage(value, index) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const record = value;
    const text = typeof record.text === "string" ? record.text : undefined;
    if (!text) {
        return null;
    }
    return {
        id: typeof record.id === "string" ? record.id : `manual-message-${index + 1}`,
        role: typeof record.role === "string" ? record.role : "assistant",
        text,
        created_at: typeof record.created_at === "string" ? record.created_at : new Date().toISOString(),
        metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : undefined
    };
}
function isAgentStatus(value) {
    return AGENT_STATUSES.includes(value);
}
