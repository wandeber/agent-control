import { createDefaultAdapterRegistry } from "../adapters/registry.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { AgentController } from "./controller.js";
import { defaultStatePath } from "./paths.js";
export function createController(dbPath = defaultStatePath()) {
    const store = new SqliteStore(dbPath);
    const controller = new AgentController(store, createDefaultAdapterRegistry());
    return { controller, store };
}
