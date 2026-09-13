import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AgentDefinitionCatalog, configureAgentDefinitionSchema, deleteAgentDefinitionSchema } from "./core/agent-definitions.js";
import { compileAgentConfiguration, loadAgentDefinitionInventory } from "./core/agent-definition-inventory.js";
import { ControllerError } from "./core/errors.js";
import { currentCodexThreadId } from "./core/caller-context.js";
import { resolveAdminKey, verifyAdminKey } from "./core/identity.js";
import { EVENT_TYPES } from "./core/types.js";
import { launchWorker } from "./cli/worker.js";
export const agentDefinitionListSchema = z.object({}).strict();
export const agentDefinitionGetSchema = z.object({
    definition_id: z.string().uuid().optional(),
    name: z.string().min(1).optional()
}).strict().refine((input) => Boolean(input.definition_id) !== Boolean(input.name), {
    message: "Provide exactly one of definition_id or name."
});
export const agentDefinitionInventorySchema = z.object({
    repo_dir: z.string().min(1).optional(),
    refresh: z.boolean().optional()
}).strict();
const catalogAuthFields = {
    admin_key: z.string().min(1).optional(),
    agent_token: z.string().min(1).optional()
};
export const agentDefinitionConfigureToolSchema = z.union([
    configureAgentDefinitionSchema.options[0].extend(catalogAuthFields),
    configureAgentDefinitionSchema.options[1].extend(catalogAuthFields),
    configureAgentDefinitionSchema.options[2].extend(catalogAuthFields)
]);
export const agentDefinitionDeleteToolSchema = deleteAgentDefinitionSchema.extend(catalogAuthFields);
const requesterFields = {
    requester_thread_id: z.string().min(1).optional(),
    requester_event_types: z.array(z.enum(EVENT_TYPES)).min(1).optional(),
    requester_delivery: z.enum(["wait", "notify"]).optional()
};
export const agentDefinitionLaunchSchema = z.object({
    definition_id: z.string().uuid().optional(),
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    prompt_file: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    repo_dir: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    objective: z.string().min(1).optional(),
    sandbox: z.enum(["read_only", "workspace"]).optional(),
    approval_policy: z.literal("on-request").optional(),
    output_artifact: z.string().min(1).optional(),
    input_handoffs: z.array(z.unknown()).optional(),
    input_artifacts: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    expected_artifacts: z.array(z.string()).optional(),
    attachments: z.array(z.string()).optional(),
    watch: z.boolean().optional(),
    admin_key: z.string().min(1).optional(),
    agent_token: z.string().min(1).optional(),
    ...requesterFields
}).strict()
    .refine((input) => Boolean(input.definition_id) !== Boolean(input.name), {
    message: "Provide exactly one of definition_id or name."
})
    .refine((input) => Boolean(input.prompt) !== Boolean(input.prompt_file), {
    message: "Provide exactly one of prompt or prompt_file."
});
export class AgentDefinitionService {
    controller;
    catalog;
    constructor(controller, catalog = new AgentDefinitionCatalog()) {
        this.controller = controller;
        this.catalog = catalog;
    }
    list(input = {}) {
        parseInput(agentDefinitionListSchema, input);
        return this.catalog.list();
    }
    get(input) {
        const parsed = parseInput(agentDefinitionGetSchema, input);
        return this.catalog.get({ definitionId: parsed.definition_id, name: parsed.name });
    }
    async inventory(input, includeArtwork = false) {
        const parsed = parseInput(agentDefinitionInventorySchema, input);
        const inventory = await loadAgentDefinitionInventory(resolve(parsed.repo_dir ?? process.cwd()), parsed.refresh === true);
        if (includeArtwork)
            return inventory;
        // Artwork belongs in the console, not in model-facing MCP/CLI context.
        const withoutArtwork = ({ icon_url: _light, icon_dark_url: _dark, ...entry }) => entry;
        return { ...inventory, plugins: inventory.plugins.map(withoutArtwork), skills: inventory.skills.map(withoutArtwork), mcp_servers: inventory.mcp_servers.map(withoutArtwork) };
    }
    configure(input, authority = {}) {
        assertCatalogMutationAuthority(this.controller, authority);
        return this.catalog.configure(parseInput(configureAgentDefinitionSchema, input));
    }
    delete(input, authority = {}) {
        assertCatalogMutationAuthority(this.controller, authority);
        return this.catalog.delete(parseInput(deleteAgentDefinitionSchema, input));
    }
    async launch(input, deps) {
        const parsed = parseInput(agentDefinitionLaunchSchema, input);
        const selected = this.catalog.get({
            definitionId: parsed.definition_id,
            name: parsed.name
        });
        const repoDir = resolve(parsed.repo_dir ?? process.cwd());
        const inventory = await loadAgentDefinitionInventory(repoDir, true);
        const configuredAgent = compileAgentConfiguration(selected.definition, selected.revision, inventory, repoDir);
        const baseAuth = deps.authOptions({ allowStoredAdminKey: true });
        const launch = await launchWorker({
            backend: "codex-cli",
            title: parsed.title ?? selected.definition.name,
            prompt: parsed.prompt,
            promptFile: parsed.prompt_file,
            phase: parsed.phase ?? "task",
            role: parsed.role,
            objective: parsed.objective,
            repo: repoDir,
            runId: parsed.run_id,
            sandbox: parsed.sandbox,
            approvalPolicy: parsed.approval_policy,
            model: selected.definition.model,
            reasoningEffort: selected.definition.reasoning_effort,
            outputArtifact: parsed.output_artifact,
            inputHandoffsJson: parsed.input_handoffs === undefined
                ? undefined
                : JSON.stringify(parsed.input_handoffs),
            inputArtifact: parsed.input_artifacts ?? [],
            constraint: parsed.constraints ?? [],
            expectArtifact: parsed.expected_artifacts ?? [],
            file: parsed.attachments ?? [],
            subscriberAgentId: [],
            subscribeEvent: [],
            startTimeoutMs: 30_000,
            watchIntervalMs: 5000,
            watch: parsed.watch !== false,
            requesterThreadId: parsed.requester_thread_id,
            requesterEvent: parsed.requester_event_types,
            requesterDelivery: parsed.requester_delivery,
            agentToken: parsed.agent_token,
            configuredAgent
        }, {
            ...deps,
            authOptions: () => ({
                agentToken: parsed.agent_token ?? baseAuth.agentToken,
                adminKey: parsed.admin_key ?? baseAuth.adminKey
            })
        });
        const executionAgentId = String(launch.agent_id);
        const agent = this.controller.getAgent(executionAgentId);
        const snapshotHash = typeof agent.backend_handle?.snapshot_hash === "string"
            ? agent.backend_handle.snapshot_hash
            : null;
        if (!snapshotHash) {
            throw new ControllerError("Configured worker started without a verified immutable snapshot.", "tool_error", { definition_id: selected.definition.definition_id, agent_id: executionAgentId });
        }
        return {
            ...launch,
            definition_id: selected.definition.definition_id,
            definition_name: selected.definition.name,
            catalog_revision: selected.revision,
            snapshot_hash: snapshotHash
        };
    }
}
export function assertCatalogMutationAuthority(controller, authority) {
    if (authority.agentToken) {
        throw new ControllerError("Worker and run-scoped credentials cannot modify the personal configured-agent catalog.", "auth_required");
    }
    const threadId = authority.currentThreadId ?? currentCodexThreadId();
    if (threadId && managedAgentsForThread(controller, threadId).length > 0) {
        throw new ControllerError("A managed worker thread cannot modify the personal configured-agent catalog.", "auth_required");
    }
    if (authority.trustedCatalogCapability) {
        return;
    }
    const adminKey = authority.adminKey ?? resolveAdminKey();
    if (!verifyAdminKey(adminKey)) {
        throw new ControllerError("Configured-agent catalog changes require local operator authorization.", "auth_required");
    }
}
export function managedAgentsForThread(controller, threadId) {
    return controller.listAgents().filter((agent) => {
        if (agent.unregistered_at)
            return false;
        if (agent.backend === "codex-thread") {
            return agent.backend_handle?.thread_id === threadId &&
                (agent.work_generation > 0 || !["observer", "orchestrator"].includes(agent.role ?? ""));
        }
        if (agent.backend !== "codex-cli" || typeof agent.backend_handle?.dir !== "string")
            return false;
        try {
            const state = JSON.parse(readFileSync(join(agent.backend_handle.dir, "state.json"), "utf8"));
            return state.thread_id === threadId;
        }
        catch {
            return false;
        }
    });
}
function parseInput(schema, value) {
    try {
        return schema.parse(value);
    }
    catch (error) {
        throw new ControllerError("Configured agent input is invalid.", "validation", {
            issue: error instanceof Error ? error.message : String(error)
        });
    }
}
