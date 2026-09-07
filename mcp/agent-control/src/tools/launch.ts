import type { AgentController } from "../core/controller.js";
import { resolveAdminKey } from "../core/identity.js";
import { observeLaunchCoordinator, prepareLaunchOwner } from "../core/launch-context.js";
import { launchWorker, startDetachedWatch } from "../cli/worker.js";
import type { EventType } from "../core/types.js";

export function requesterOptions(input: Record<string, unknown>) {
  return { requesterThreadId: input.requester_thread_id as string | undefined,
    requesterEventTypes: input.requester_event_types as EventType[] | undefined,
    requesterDelivery: input.requester_delivery as "wait" | "notify" | undefined };
}

export async function launchWorkerTool(controller: AgentController, input: Record<string, unknown>) {
  return launchWorker({ backend: String(input.backend ?? (input.profile ? "codex-cli" : "codex-thread")), title: String(input.title),
    prompt: input.prompt as string | undefined, promptFile: input.prompt_file as string | undefined,
    phase: String(input.phase ?? "task"), role: input.role as string | undefined,
    repo: (input.repo_dir as string | undefined) ?? process.cwd(), runId: input.run_id as string | undefined,
    profile: input.profile as string | undefined, sandbox: input.sandbox as "read_only" | "workspace" | undefined,
    model: input.model as string | undefined, reasoningEffort: input.reasoning_effort as string | undefined,
    server: input.server as string | undefined, objective: input.objective as string | undefined,
    outputArtifact: input.output_artifact as string | undefined,
    inputHandoffsJson: input.input_handoffs === undefined ? undefined : JSON.stringify(input.input_handoffs),
    inputArtifact: (input.input_artifacts as string[] | undefined) ?? [], constraint: (input.constraints as string[] | undefined) ?? [],
    expectArtifact: (input.expected_artifacts as string[] | undefined) ?? [], file: (input.attachments as string[] | undefined) ?? [],
    subscriberAgentId: [], subscribeEvent: [], startTimeoutMs: 30_000, watchIntervalMs: 5000,
    watch: input.watch !== false, requesterThreadId: input.requester_thread_id as string | undefined,
    requesterEvent: input.requester_event_types as EventType[] | undefined,
    requesterDelivery: input.requester_delivery as "wait" | "notify" | undefined
  }, { controller, output: () => {}, authOptions: () => ({ agentToken: input.agent_token as string | undefined,
    adminKey: (input.admin_key as string | undefined) ?? resolveAdminKey() }) });
}

export async function launchFlowTool(controller: AgentController, input: Record<string, unknown>) {
  const title = String(input.title);
  const owner = prepareLaunchOwner(controller, { title, repoDir: input.repo_dir as string | undefined,
    runId: input.run_id as string | undefined, agentToken: input.agent_token as string | undefined,
    adminKey: (input.admin_key as string | undefined) ?? resolveAdminKey(), ...requesterOptions(input) });
  const projectDir = controller.getRun(owner.runId, { agentToken: owner.agentToken }).repo_dir;
  const config = input.config ?? controller.getFlowFromCatalog({ flowId: String(input.flow_id), projectDir }).config;
  controller.validateFlowConfig(config);
  const requester = controller.ensureRequester(owner.runId, { ...requesterOptions(input), agentToken: owner.agentToken });
  const coordinatorObserver = observeLaunchCoordinator(controller, owner, owner.runId, requester);
  const start = controller.startFlow({ config, runId: owner.runId, runTitle: title, acceptanceContext: input.acceptance_context as string | undefined,
    repoDir: input.repo_dir as string | undefined, agentToken: owner.agentToken,
    adminKey: owner.agentToken ? undefined : (input.admin_key as string | undefined) ?? resolveAdminKey(),
    ownerTaskIdentity: input.owner_task_identity as string | undefined,
    ownerTaskPath: input.owner_task_path as string | undefined, ...requesterOptions(input) });
  const continuation = start.active_step ? await controller.continueFlow({ flowInstanceId: start.instance.flow_instance_id,
    agentToken: owner.agentToken, bridgeToken: start.bridge_credential?.bridge_token, server: input.server as string | undefined }) : null;
  const agent = continuation?.agent;
  const watch = agent && continuation?.action === "dispatched" && agent.backend !== "codex-subagent"
    ? { detached_watcher: true, ...startDetachedWatch({ target: { kind: "flow", flowInstanceId: start.instance.flow_instance_id }, timeoutMs: 3_600_000, intervalMs: 5000 }) }
    : null;
  return { run_id: start.instance.run_id, flow_instance_id: start.instance.flow_instance_id,
    orchestrator_agent_id: owner.agent?.agent_id ?? null, observer: start.observer,
    coordinator_observer: coordinatorObserver, start, continuation, watch };
}
