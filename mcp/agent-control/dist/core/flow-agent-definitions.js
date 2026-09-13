import { realpathSync } from "node:fs";
import { AgentDefinitionCatalog } from "./agent-definitions.js";
import { compileAgentConfiguration, loadAgentDefinitionInventory } from "./agent-definition-inventory.js";
import { ControllerError } from "./errors.js";
import { digest } from "./flow-runtime.js";
export function flowAgentRepoDir(role, repoDir) {
    return role?.agent_ref && repoDir ? realpathSync(repoDir) : repoDir;
}
/** Resolve source roles once, after project overrides, before persisting a run. */
export function resolveFlowAgentDefinitions(config, catalog) {
    const resolved = structuredClone(config);
    const selections = new Map();
    for (const [roleId, role] of Object.entries(resolved.roles ?? {})) {
        if (!role.agent_ref)
            continue;
        if (role.resolved_agent)
            throw new ControllerError("Flow agent definition was already resolved.", "tool_error", { role: roleId });
        catalog ??= new AgentDefinitionCatalog();
        let selected = selections.get(role.agent_ref);
        if (!selected) {
            try {
                selected = catalog.resolve(role.agent_ref);
            }
            catch (cause) {
                throw new ControllerError(`Cannot resolve agent_ref '${role.agent_ref}' for flow role '${roleId}'.`, "tool_error", { role: roleId, agent_ref: role.agent_ref, cause: cause instanceof Error ? cause.message : String(cause) });
            }
            selections.set(role.agent_ref, selected);
        }
        const sourceRole = structuredClone(role);
        const definition = { ...structuredClone(selected.definition),
            model: role.model ?? selected.definition.model,
            model_provider: role.model_provider ?? selected.definition.model_provider,
            reasoning_effort: role.reasoning_effort ?? selected.definition.reasoning_effort };
        role.backend = "codex-cli";
        role.model = definition.model;
        role.model_provider = definition.model_provider;
        role.reasoning_effort = definition.reasoning_effort;
        role.resolved_agent = { definition, catalog_revision: selected.revision,
            digest: digest({ definition, catalog_revision: selected.revision }), source_role: sourceRole };
    }
    return resolved;
}
/** Compare a repeated public start with the original selection, not today's catalog. */
export function flowSourceConfig(config) {
    const source = structuredClone(config);
    for (const [id, role] of Object.entries(source.roles ?? {})) {
        if (role.resolved_agent)
            source.roles[id] = structuredClone(role.resolved_agent.source_role);
    }
    return source;
}
/** Compile only new workers. Callers must retain an existing worker's runtime snapshot. */
export async function compileFlowAgent(role, repoDir) {
    const pinned = role.resolved_agent;
    if (!pinned || role.backend !== "codex-cli" ||
        pinned.digest !== digest({ definition: pinned.definition, catalog_revision: pinned.catalog_revision }) ||
        role.model !== pinned.definition.model || role.model_provider !== pinned.definition.model_provider ||
        role.reasoning_effort !== pinned.definition.reasoning_effort) {
        throw new ControllerError("The pinned flow agent definition is missing or inconsistent.", "tool_error");
    }
    const repo = realpathSync(repoDir);
    const inventory = await loadAgentDefinitionInventory(repo, true);
    return compileAgentConfiguration(pinned.definition, pinned.catalog_revision, inventory, repo);
}
