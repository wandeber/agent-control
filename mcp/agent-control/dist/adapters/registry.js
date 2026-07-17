import { ControllerError } from "../core/errors.js";
import { CodexThreadAdapter } from "./codex-thread-adapter.js";
import { CodexSubagentAdapter } from "./codex-subagent-adapter.js";
import { ManualAdapter } from "./manual-adapter.js";
import { OpenCodeServerAdapter } from "./opencode-server-adapter.js";
export class AdapterRegistry {
    adapters = new Map();
    register(adapter) {
        this.adapters.set(adapter.kind, adapter);
    }
    get(kind) {
        const adapter = this.adapters.get(kind);
        if (!adapter) {
            throw new ControllerError(`Unsupported backend: ${kind}`, "unsupported_operation", { backend: kind });
        }
        return adapter;
    }
    list() {
        return [...this.adapters.values()].map((adapter) => ({
            kind: adapter.kind,
            capabilities: adapter.capabilities()
        }));
    }
}
export function createDefaultAdapterRegistry() {
    const registry = new AdapterRegistry();
    registry.register(new OpenCodeServerAdapter());
    registry.register(new CodexThreadAdapter());
    registry.register(new CodexSubagentAdapter());
    registry.register(new ManualAdapter());
    return registry;
}
