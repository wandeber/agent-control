import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ControllerError } from "./errors.js";
import { verifyAdminKey } from "./identity.js";
import { currentCodexThreadId } from "./caller-context.js";
import { readCodexSession } from "../adapters/codex-session.js";
/** Bootstrap local launches without exposing a coordinator token in task text. */
export function prepareLaunchOwner(controller, input) {
    if (input.agentToken) {
        const agent = controller.requireAgentToken(input.agentToken);
        return { agent, runId: input.runId ?? agent.run_id, agentToken: input.agentToken };
    }
    if (!verifyAdminKey(input.adminKey))
        throw new ControllerError("Local launch requires Agent Control authorization.", "auth_required");
    const threadId = currentCodexThreadId();
    if (threadId) {
        // App-server workers do not inherit a per-worker MCP token. Recover their
        // existing participant locally, keeping its role and original run requester.
        const matchesThread = (agent) => {
            if (agent.backend === "codex-thread")
                return agent.backend_handle?.thread_id === threadId;
            if (agent.backend !== "codex-cli" || typeof agent.backend_handle?.dir !== "string")
                return false;
            try {
                return JSON.parse(readFileSync(join(agent.backend_handle.dir, "state.json"), "utf8")).thread_id === threadId;
            }
            catch {
                return false;
            }
        };
        // Identify managed workers globally before applying a requested run filter.
        // A nested CLI worker cannot become a new operator by omitting its token.
        const workers = controller.listAgents().filter(agent => !agent.unregistered_at && matchesThread(agent) && (agent.backend === "codex-cli" || agent.work_generation > 0 || !["observer", "orchestrator"].includes(agent.role ?? "")));
        const candidates = workers.length ? workers : controller.listAgents().filter(agent => !agent.unregistered_at && matchesThread(agent) && agent.role !== "observer" &&
            (input.runId ? agent.run_id === input.runId : agent.role !== "orchestrator"));
        if (candidates.length > 1)
            throw new ControllerError("Current Codex thread belongs to multiple runs; supply run_id.", "auth_required");
        const agent = candidates[0];
        if (agent)
            return { agent, runId: input.runId ?? agent.run_id, agentToken: controller.issueAgentToken(agent.agent_id) };
    }
    // A requester id identifies the conversation, not the executing host. A
    // headless coordinator must never acquire that conversation's native authority.
    const login = controller.orchestratorLogin({ adminKey: input.adminKey, title: `${input.title} coordinator`,
        runTitle: input.title, runId: input.runId, repoDir: input.repoDir, backend: threadId ? "codex-thread" : "manual", objective: input.title,
        model: threadId ? readCodexSession(threadId)?.model ?? undefined : undefined,
        backendHandle: threadId ? { thread_id: threadId, agent_control_role: "orchestrator", cwd: input.repoDir } : undefined });
    // Only the privileged bootstrap establishes operator authority. Routine
    // observation maintenance deliberately cannot synthesize this grant.
    const requester = input.requesterThreadId ?? controller.originalRequesterThread(login.run.run_id) ?? threadId;
    if (requester)
        controller.observeRun({ runId: login.run.run_id, threadId: requester, adminKey: input.adminKey });
    return { agent: login.agent, runId: login.run.run_id, agentToken: login.agent_token };
}
/** A separate executing conversation needs its own cursor and action visibility. */
export function observeLaunchCoordinator(controller, owner, runId, requester) {
    const threadId = owner.agent?.backend === "codex-thread" ? owner.agent.backend_handle?.thread_id : undefined;
    if (typeof threadId !== "string" || !threadId || threadId === requester?.thread_id)
        return null;
    return controller.observeRun({ runId, threadId, title: "Executing coordinator", agentToken: owner.agentToken });
}
