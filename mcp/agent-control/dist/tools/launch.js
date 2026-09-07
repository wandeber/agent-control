import { resolveAdminKey } from "../core/identity.js";
import { observeLaunchCoordinator, prepareLaunchOwner } from "../core/launch-context.js";
import { launchWorker, startDetachedWatch } from "../cli/worker.js";
export function requesterOptions(input) {
    return { requesterThreadId: input.requester_thread_id,
        requesterEventTypes: input.requester_event_types,
        requesterDelivery: input.requester_delivery };
}
export async function launchWorkerTool(controller, input) {
    return launchWorker({ backend: String(input.backend ?? (input.profile ? "codex-cli" : "codex-thread")), title: String(input.title),
        prompt: input.prompt, promptFile: input.prompt_file,
        phase: String(input.phase ?? "task"), role: input.role,
        repo: input.repo_dir ?? process.cwd(), runId: input.run_id,
        profile: input.profile, sandbox: input.sandbox,
        model: input.model, reasoningEffort: input.reasoning_effort,
        server: input.server, objective: input.objective,
        outputArtifact: input.output_artifact,
        inputHandoffsJson: input.input_handoffs === undefined ? undefined : JSON.stringify(input.input_handoffs),
        inputArtifact: input.input_artifacts ?? [], constraint: input.constraints ?? [],
        expectArtifact: input.expected_artifacts ?? [], file: input.attachments ?? [],
        subscriberAgentId: [], subscribeEvent: [], startTimeoutMs: 30_000, watchIntervalMs: 5000,
        watch: input.watch !== false, requesterThreadId: input.requester_thread_id,
        requesterEvent: input.requester_event_types,
        requesterDelivery: input.requester_delivery
    }, { controller, output: () => { }, authOptions: () => ({ agentToken: input.agent_token,
            adminKey: input.admin_key ?? resolveAdminKey() }) });
}
export async function launchFlowTool(controller, input) {
    const title = String(input.title);
    const owner = prepareLaunchOwner(controller, { title, repoDir: input.repo_dir,
        runId: input.run_id, agentToken: input.agent_token,
        adminKey: input.admin_key ?? resolveAdminKey(), ...requesterOptions(input) });
    const projectDir = controller.getRun(owner.runId, { agentToken: owner.agentToken }).repo_dir;
    const config = input.config ?? controller.getFlowFromCatalog({ flowId: String(input.flow_id), projectDir }).config;
    controller.validateFlowConfig(config);
    const requester = controller.ensureRequester(owner.runId, { ...requesterOptions(input), agentToken: owner.agentToken });
    const coordinatorObserver = observeLaunchCoordinator(controller, owner, owner.runId, requester);
    const start = controller.startFlow({ config, runId: owner.runId, runTitle: title, acceptanceContext: input.acceptance_context,
        repoDir: input.repo_dir, agentToken: owner.agentToken,
        adminKey: owner.agentToken ? undefined : input.admin_key ?? resolveAdminKey(),
        ownerTaskIdentity: input.owner_task_identity,
        ownerTaskPath: input.owner_task_path, ...requesterOptions(input) });
    const continuation = start.active_step ? await controller.continueFlow({ flowInstanceId: start.instance.flow_instance_id,
        agentToken: owner.agentToken, bridgeToken: start.bridge_credential?.bridge_token, server: input.server }) : null;
    const agent = continuation?.agent;
    const watch = agent && continuation?.action === "dispatched" && agent.backend !== "codex-subagent"
        ? { detached_watcher: true, ...startDetachedWatch({ target: { kind: "flow", flowInstanceId: start.instance.flow_instance_id }, timeoutMs: 3_600_000, intervalMs: 5000 }) }
        : null;
    return { run_id: start.instance.run_id, flow_instance_id: start.instance.flow_instance_id,
        orchestrator_agent_id: owner.agent?.agent_id ?? null, observer: start.observer,
        coordinator_observer: coordinatorObserver, start, continuation, watch };
}
