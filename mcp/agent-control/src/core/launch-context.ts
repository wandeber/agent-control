import type { AgentRecord, RunObserverResult } from "./types.js";
import type { AgentController } from "./controller.js";
import type { RequesterInput } from "./run-observation.js";
import { ControllerError } from "./errors.js";
import { verifyAdminKey } from "./identity.js";
import { currentCodexThreadId } from "./caller-context.js";

/** Bootstrap local launches without exposing a coordinator token in task text. */
export function prepareLaunchOwner(controller: AgentController, input: RequesterInput & {
  title: string; repoDir?: string; runId?: string; agentToken?: string; adminKey?: string;
}) {
  if (input.agentToken) {
    const agent = controller.requireAgentToken(input.agentToken);
    return { agent, runId: input.runId ?? agent.run_id, agentToken: input.agentToken };
  }
  if (!verifyAdminKey(input.adminKey)) throw new ControllerError("Local launch requires Agent Control authorization.", "auth_required");
  const threadId = currentCodexThreadId();
  if (threadId) {
    // App-server workers do not inherit a per-worker MCP token. Recover their
    // existing participant locally, keeping its role and original run requester.
    const candidates = controller.listAgents().filter(agent => agent.backend === "codex-thread" &&
      agent.backend_handle?.thread_id === threadId && agent.role !== "observer" &&
      (input.runId ? agent.run_id === input.runId : agent.role !== "orchestrator"));
    if (candidates.length > 1) throw new ControllerError("Current Codex thread belongs to multiple runs; supply run_id.", "auth_required");
    const agent = candidates[0];
    if (agent) return { agent, runId: input.runId ?? agent.run_id, agentToken: controller.issueAgentToken(agent.agent_id) };
  }
  // A requester id identifies the conversation, not the executing host. A
  // headless coordinator must never acquire that conversation's native authority.
  const login = controller.orchestratorLogin({ adminKey: input.adminKey!, title: `${input.title} coordinator`,
    runTitle: input.title, runId: input.runId, repoDir: input.repoDir, backend: threadId ? "codex-thread" : "manual", objective: input.title,
    backendHandle: threadId ? { thread_id: threadId, agent_control_role: "orchestrator", cwd: input.repoDir } : undefined });
  return { agent: login.agent, runId: login.run.run_id, agentToken: login.agent_token };
}

/** A separate executing conversation needs its own cursor and action visibility. */
export function observeLaunchCoordinator(controller: AgentController,
  owner: { agent: AgentRecord | null; agentToken?: string }, runId: string,
  requester: RunObserverResult | null) {
  const threadId = owner.agent?.backend === "codex-thread" ? owner.agent.backend_handle?.thread_id : undefined;
  if (typeof threadId !== "string" || !threadId || threadId === requester?.thread_id) return null;
  return controller.observeRun({ runId, threadId, title: "Executing coordinator", agentToken: owner.agentToken });
}
