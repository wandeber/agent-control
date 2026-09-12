import { resolveCliContinuity } from "../adapters/attached-cli-bridge.js";
import { discoverCliWriter, hasRolloutWriter } from "../adapters/cli-writer.js";
import { inspectSessionControl } from "../adapters/session-control.js";
import { readCodexSession, sessionBaseline } from "../adapters/codex-session.js";
import { ControllerError } from "../core/errors.js";
import { resolveAdminKey } from "../core/identity.js";
import { observeLaunchCoordinator, prepareLaunchOwner } from "../core/launch-context.js";
import { requesterOptions } from "./launch.js";
/** Registration and control discovery never start a turn or take a writer lock. */
export async function attachWorkerTool(controller, input) {
    const threadId = String(input.thread_id);
    const previous = typeof input.run_id === "string" ? controller.listAgents({ runId: input.run_id }).find(a => !a.unregistered_at && a.backend_handle?.thread_id === threadId) : undefined;
    const endpoint = input.server ?? previous?.backend_handle?.app_server_url ?? process.env.CODEX_APP_SERVER_URL ?? process.env.CODEX_APP_SERVER;
    const authTokenFile = input.auth_token_file ?? previous?.backend_handle?.auth_token_file;
    const remote = Boolean(endpoint && !/^(unix:|stdio:|wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$))/.test(endpoint));
    const session = remote ? null : readCodexSession(threadId);
    const controlHandle = { backend: "codex-session", id: threadId, data: { thread_id: threadId, app_server_url: endpoint, auth_token_file: authTokenFile } };
    let controlled;
    let controlError;
    try {
        controlled = await inspectSessionControl(controlHandle);
    }
    catch (error) {
        controlError = error instanceof Error ? error.message : "Control endpoint unavailable.";
    }
    if (!session && !controlled)
        throw new ControllerError("The existing Codex session is not readable locally or through its owning app-server. Supply server for the owning host; do not relaunch it.", "backend_unavailable");
    const baseline = session ? sessionBaseline(threadId) : null;
    const liveControl = Boolean(controlled && controlled.status.type !== "notLoaded" && !endpoint?.startsWith("stdio"));
    const resumable = Boolean(controlled && !endpoint?.startsWith("stdio") && session && !hasRolloutWriter(session.path) && ["completed", "stopped", "failed"].includes(session.status));
    const writer = session ? discoverCliWriter(session.path) : null;
    let continuity;
    let continuityError;
    if (session) {
        try {
            continuity = resolveCliContinuity(threadId, input.profile ?? previous?.backend_handle?.profile, writer);
        }
        catch (error) {
            continuityError = error instanceof Error ? error.message : "Original CLI configuration is unavailable.";
        }
    }
    const owner = prepareLaunchOwner(controller, { title: String(input.title ?? "Attached Codex session"), repoDir: session?.cwd ?? controlled?.cwd,
        runId: input.run_id, agentToken: input.agent_token,
        adminKey: input.admin_key ?? resolveAdminKey(), ...requesterOptions(input) });
    const observer = controller.ensureRequester(owner.runId, { ...requesterOptions(input), agentToken: owner.agentToken });
    const coordinatorObserver = observeLaunchCoordinator(controller, owner, owner.runId, observer);
    // Reattaching the same physical session must not duplicate cards or usage.
    let agent = controller.listAgents({ runId: owner.runId }).find(a => !a.unregistered_at && a.backend_handle?.thread_id === threadId);
    const reused = Boolean(agent);
    if (!agent) {
        const { agent_token: _token, ...registered } = controller.registerAgent({ runId: owner.runId, backend: "codex-session",
            title: String(input.title ?? "Existing Codex session"), role: "worker", repoDir: session?.cwd ?? controlled?.cwd, model: session?.model ?? null,
            status: "unknown", backendHandle: { thread_id: threadId, usage_baseline: baseline, observation_only: false, observed_event_index: session?.lastIndex, app_server_url: endpoint, auth_token_file: authTokenFile, remote_session: !session, cwd: session?.cwd ?? controlled?.cwd, model_provider: session?.modelProvider ?? controlled?.modelProvider, cli_continuity: continuity, profile: continuity?.profile, cli_configuration_valid: Boolean(continuity), prefer_app_server: liveControl },
            agentToken: owner.agentToken });
        agent = registered;
    }
    if (agent.backend === "codex-session") {
        if (reused)
            agent = controller.reconnectAttachedSession(agent.agent_id, {
                ...(endpoint ? { app_server_url: endpoint } : {}), ...(authTokenFile ? { auth_token_file: authTokenFile } : {}), remote_session: !session,
                cli_continuity: continuity, profile: continuity?.profile, cli_configuration_valid: Boolean(continuity), prefer_app_server: liveControl
            });
        agent = await controller.refreshAgentStatus(agent.agent_id);
    }
    const cancelled = agent.backend_handle?.cancel_requested === true || ["stopping", "stopped"].includes(controller.getRun(owner.runId).status);
    return { run_id: owner.runId, agent, reused, observer, coordinator_observer: coordinatorObserver,
        capabilities: { observe: true, read_messages: true, send_message: !cancelled && (liveControl || (resumable && Boolean(continuity)) || Boolean(continuity)), stop: liveControl || Boolean(writer), resume: !cancelled && (liveControl || Boolean(continuity)), canInterrupt: !cancelled && (liveControl || Boolean(writer)) },
        control: { endpoint: endpoint ?? "configured local app-server", state: liveControl ? "connected" : continuity ? "cli_bridge" : resumable ? "resumable" : "connection_required",
            message_delivery: !liveControl && continuity ? "queued_after_current_turn" : "app_server", cli_configuration_reason: continuityError ?? null,
            reason: liveControl || resumable || continuity ? null : controlError ?? "Connect to the app-server that owns this active session." },
        usage_scope: "Reported token increments since attachment; earlier conversation history is excluded.",
        wait_contract: coordinatorObserver?.wait_contract ?? observer?.wait_contract ?? null };
}
