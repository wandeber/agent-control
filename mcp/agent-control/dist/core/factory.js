import { createDefaultAdapterRegistry } from "../adapters/registry.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { AgentController } from "./controller.js";
import { LocalCredentialStore } from "./local-credential-store.js";
import { credentialsRoot, defaultStatePath } from "./paths.js";
export function createController(dbPath = defaultStatePath()) {
    const store = new SqliteStore(dbPath);
    const credentialStore = new LocalCredentialStore(store, credentialsRoot(dbPath));
    // Startup cleanup is intentionally bounded and best-effort. Unsafe or
    // malformed files remain unusable and will surface diagnostics during an
    // explicit credential operation without preventing unrelated MCP tools from
    // starting.
    // An in-memory SQLite authority is intentionally ephemeral (primarily tests
    // and schema probes) and must never invalidate credentials belonging to the
    // user's persistent controller database.
    if (dbPath !== ":memory:") {
        credentialStore.cleanupStaleCredentials();
    }
    const controller = new AgentController(store, createDefaultAdapterRegistry(), credentialStore);
    return { controller, store, credentialStore };
}
