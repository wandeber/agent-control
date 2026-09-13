import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultControlHome } from "./paths.js";
const threadIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const cliStatuses = new Set(["running", "queued", "waiting_for_input", "completed", "failed", "stopped", "blocked"]);
/** CLI thread identity belongs to the supervisor's current execution state,
 * not model-supplied metadata, a status event, or the shared MCP process env. */
export function agentConversationThreadId(agent) {
    if (agent.unregistered_at)
        return null;
    if (agent.backend !== "codex-cli") {
        // Attached Codex sessions retain their trusted thread binding directly on
        // the handle, just like desktop-owned threads.
        const value = agent.backend === "codex-thread" || agent.backend === "codex-session" ? agent.backend_handle?.thread_id
            : agent.backend === "codex-subagent" ? agent.backend_handle?.native_agent_id : null;
        return typeof value === "string" && value.length > 0 ? value : null;
    }
    const dir = agent.backend_handle?.dir;
    if (typeof dir !== "string" || !dir)
        return null;
    let fd;
    try {
        // Resolve the configured home once, then require the exact owner directory.
        // A handle pointing at another execution or a symlinked owner directory
        // cannot borrow that execution's identity.
        const home = realpathSync(defaultControlHome());
        const expected = join(home, "runs", agent.run_id, "agents", agent.agent_id, "codex-cli");
        if (realpathSync(resolve(dir)) !== expected)
            return null;
        if (agent.backend_handle?.access_agent_id !== undefined && agent.backend_handle.access_agent_id !== agent.agent_id)
            return null;
        fd = openSync(join(expected, "state.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024)
            return null;
        const state = JSON.parse(readFileSync(fd, "utf8"));
        if (!state || typeof state !== "object" || Array.isArray(state) ||
            typeof state.thread_id !== "string" || !threadIdPattern.test(state.thread_id) ||
            typeof state.status !== "string" || !cliStatuses.has(state.status) ||
            typeof state.updated_at !== "string" || !Number.isFinite(Date.parse(state.updated_at)))
            return null;
        return state.thread_id;
    }
    catch {
        // Missing, rotating or malformed supervisor state never authenticates a
        // request. Explicit worker credentials remain a separate supported path.
        return null;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
