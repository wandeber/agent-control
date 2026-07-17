import { ControllerError } from "../core/errors.js";
import type { AgentAdapter } from "../core/types.js";
import { CodexThreadAdapter } from "./codex-thread-adapter.js";
import { CodexSubagentAdapter } from "./codex-subagent-adapter.js";
import { ManualAdapter } from "./manual-adapter.js";
import { OpenCodeServerAdapter } from "./opencode-server-adapter.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: string): AgentAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new ControllerError(`Unsupported backend: ${kind}`, "unsupported_operation", { backend: kind });
    }
    return adapter;
  }

  list(): Array<{ kind: string; capabilities: ReturnType<AgentAdapter["capabilities"]> }> {
    return [...this.adapters.values()].map((adapter) => ({
      kind: adapter.kind,
      capabilities: adapter.capabilities()
    }));
  }
}

export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new OpenCodeServerAdapter());
  registry.register(new CodexThreadAdapter());
  registry.register(new CodexSubagentAdapter());
  registry.register(new ManualAdapter());
  return registry;
}
