import { readFileSync } from "node:fs";
import { compiledSnapshotHash } from "./agent-definition-inventory.js";
import { REQUIRED_AGENT_CONTROL_MCP } from "./agent-definitions.js";
import { ControllerError } from "./errors.js";
export function readConfiguredAgentExecutionSnapshot(path, expectedHash, executionAgentId) {
    let value;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        throw unsupported("Configured-agent snapshot could not be read.", {
            path,
            error: error instanceof Error ? error.message : String(error)
        });
    }
    const snapshot = object(value);
    const requiredStrings = [
        "definition_id", "definition_name", "catalog_revision", "inherited_instructions",
        "definition_instructions", "developer_instructions", "instructions_hash", "model",
        "model_provider", "reasoning_effort", "executable", "executable_version", "repo_dir",
        "inventory_revision", "execution_agent_id"
    ];
    if (snapshot.snapshot_version !== 1 ||
        requiredStrings.some((key) => typeof snapshot[key] !== "string") ||
        !Array.isArray(snapshot.plugins) ||
        !Array.isArray(snapshot.skills) ||
        !Array.isArray(snapshot.mcp_servers) ||
        !Array.isArray(snapshot.apps) ||
        !Array.isArray(snapshot.app_server_overrides) ||
        (snapshot.skills_catalog_token_budget !== undefined &&
            (!Number.isInteger(snapshot.skills_catalog_token_budget) ||
                snapshot.skills_catalog_token_budget < 1 || snapshot.skills_catalog_token_budget > 10_000))) {
        throw unsupported("Configured-agent snapshot has an invalid shape.", { path });
    }
    const typed = snapshot;
    if (typed.execution_agent_id !== executionAgentId) {
        throw unsupported("Configured-agent snapshot belongs to another execution.", {
            expected_agent_id: executionAgentId,
            actual_agent_id: typed.execution_agent_id
        });
    }
    if (compiledSnapshotHash(typed) !== expectedHash) {
        throw unsupported("Configured-agent snapshot changed after launch.", { path });
    }
    return typed;
}
export async function verifyConfiguredAgentThread(client, snapshot, inventory, startResponse, threadId, cwd) {
    const thread = object(startResponse.thread);
    assertEqual("model", string(startResponse.model) || string(thread.model), snapshot.model);
    assertEqual("model provider", string(startResponse.modelProvider) || string(thread.modelProvider), snapshot.model_provider);
    assertEqual("reasoning effort", string(startResponse.reasoningEffort) || string(thread.reasoningEffort), snapshot.reasoning_effort);
    const verificationStartedAt = Date.now();
    const [configResponse, skillsResponse, pluginResponse, , appResponse] = await Promise.all([
        client.request("config/read", { cwd, includeLayers: true }),
        client.request("skills/list", { cwds: [cwd], forceReload: true }),
        collectPages(client, "plugin/list", {
            cwds: [cwd], forceRefetch: true
        }, "marketplaces"),
        collectPages(client, "mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" }, "data"),
        collectPages(client, "app/list", { threadId, limit: 200, forceRefetch: true }, "data")
    ]);
    // A native plugin MCP process can appear after the first status response.
    // Read it again after a bounded startup window so an early empty row cannot
    // satisfy isolation verification.
    await waitForMcpIsolationSettle(verificationStartedAt);
    const mcpResponse = await collectPages(client, "mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" }, "data");
    const config = object(object(configResponse).config);
    assertEqual("configured model", string(config.model), snapshot.model);
    assertEqual("configured model provider", string(config.model_provider), snapshot.model_provider);
    assertEqual("configured reasoning effort", string(config.model_reasoning_effort), snapshot.reasoning_effort);
    assertEqual("developer instructions", string(config.developer_instructions), snapshot.developer_instructions);
    if (snapshot.skills_catalog_token_budget !== undefined) {
        assertEqual("skills catalog token budget", number(object(config.skills).max_context_tokens), snapshot.skills_catalog_token_budget);
    }
    const configuredPlugins = object(config.plugins);
    const pluginRows = array(pluginResponse.marketplaces)
        .flatMap((marketplace) => array(object(marketplace).plugins))
        .map(object);
    for (const expected of snapshot.plugins) {
        assertEnabled("plugin", expected.id, object(configuredPlugins[expected.id]).enabled, expected.enabled);
        const row = pluginRows.find((candidate) => string(candidate.id) === expected.id);
        if (expected.enabled && (!row || row.enabled !== true || row.availability === "UNAVAILABLE")) {
            throw unavailable("plugin", expected.id);
        }
        if (!expected.enabled && row?.enabled === true)
            isolationFailure("plugin", expected.id);
    }
    const configuredSkills = array(object(config.skills).config).map(object);
    const skillRows = array(object(skillsResponse).data)
        .flatMap((entry) => array(object(entry).skills))
        .map(object);
    for (const expected of snapshot.skills) {
        const configured = configuredSkills.find((candidate) => string(candidate.path) === expected.path);
        assertEnabled("skill", expected.path, configured?.enabled, expected.enabled);
        const row = skillRows.find((candidate) => string(candidate.path) === expected.path);
        if (expected.enabled && (!row || row.enabled === false))
            throw unavailable("skill", expected.path);
        if (!expected.enabled && row?.enabled === true)
            isolationFailure("skill", expected.path);
    }
    for (const plugin of snapshot.plugins) {
        for (const skill of plugin.bundled_skills) {
            const row = skillRows.find((candidate) => string(candidate.path) === skill.path);
            if (skill.enabled && (!row || row.enabled === false))
                throw unavailable("skill", skill.path);
            if (!skill.enabled && row?.enabled === true)
                isolationFailure("plugin skill", skill.path);
        }
    }
    const configuredMcp = object(config.mcp_servers);
    const mcpRows = array(mcpResponse.data).map(object);
    for (const expected of snapshot.mcp_servers) {
        const configured = expected.plugin_id
            ? object(object(object(config.plugins)[expected.plugin_id]).mcp_servers)[expected.name]
            : configuredMcp[expected.name];
        assertEnabled("MCP server", expected.name, object(configured).enabled, expected.enabled);
        if (expected.plugin_id && (!expected.enabled || expected.root_transport)) {
            assertEnabled("MCP server shadow", expected.name, object(configuredMcp[expected.name]).enabled, expected.enabled);
        }
        const row = mcpRows.find((candidate) => [candidate.name, candidate.serverName, candidate.id].some((value) => string(value) === expected.name));
        const tools = object(row?.tools);
        if (expected.enabled && (!row || row.authStatus === "notLoggedIn" || Object.keys(tools).length === 0))
            throw unavailable("mcp_server", expected.name);
        if (!expected.enabled && Object.keys(tools).length > 0)
            isolationFailure("MCP server", expected.name);
        if (expected.name === REQUIRED_AGENT_CONTROL_MCP && expected.enabled) {
            const toolNames = new Set(Object.values(tools).map((tool) => string(object(tool).name)));
            if (!toolNames.has("question_ask") || !toolNames.has("flow_step_report")) {
                throw unavailable("mcp_server", REQUIRED_AGENT_CONTROL_MCP);
            }
        }
    }
    if (!snapshot.mcp_servers.some((entry) => entry.name === REQUIRED_AGENT_CONTROL_MCP && entry.enabled)) {
        throw unavailable("mcp_server", REQUIRED_AGENT_CONTROL_MCP);
    }
    const configuredApps = object(config.apps);
    assertEnabled("app default", "_default", object(configuredApps._default).enabled, false);
    const appRows = array(appResponse.data).map(object);
    const selectedApps = new Set(snapshot.apps.filter((entry) => entry.enabled).map((entry) => entry.id));
    for (const expected of snapshot.apps) {
        assertEnabled("app", expected.id, object(configuredApps[expected.id]).enabled, expected.enabled);
        const row = appRows.find((candidate) => string(candidate.id) === expected.id);
        if (expected.enabled && (!row || row.isEnabled !== true || row.isAccessible !== true)) {
            throw unavailable("app", expected.id);
        }
    }
    for (const row of appRows) {
        const id = string(row.id);
        if (id && row.isEnabled === true && !selectedApps.has(id))
            isolationFailure("app", id);
    }
}
async function waitForMcpIsolationSettle(startedAt) {
    const remaining = 3_000 - (Date.now() - startedAt);
    if (remaining > 0)
        await new Promise((resolve) => setTimeout(resolve, remaining));
}
async function collectPages(client, method, params, field) {
    const values = [];
    let cursor;
    do {
        const response = object(await client.request(method, {
            ...params,
            ...(cursor ? { cursor, ...(params.forceRefetch === true ? { forceRefetch: false } : {}) } : {})
        }));
        values.push(...array(response[field]));
        cursor = string(response.nextCursor) || undefined;
    } while (cursor);
    return { [field]: values };
}
function assertEnabled(kind, id, actual, expected) {
    if (actual !== expected) {
        throw unsupported("Configured-agent capability isolation readback failed.", {
            capability_kind: kind,
            capability_id: id,
            expected_enabled: expected,
            actual_enabled: actual
        });
    }
}
function assertEqual(label, actual, expected) {
    if (actual !== expected) {
        throw unsupported("Codex did not retain the configured-agent " + label + "; no prompt was sent.", {
            expected,
            actual
        });
    }
}
function unavailable(kind, id) {
    return new ControllerError("An enabled configured-agent capability is unavailable.", "capability_unavailable", {
        capability_kind: kind,
        capability_id: id
    });
}
function isolationFailure(kind, id) {
    throw unsupported("An unselected configured-agent capability remained enabled; no prompt was sent.", {
        capability_kind: kind,
        capability_id: id
    });
}
function unsupported(message, details) {
    return new ControllerError(message, "unsupported_runtime", details);
}
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function array(value) {
    return Array.isArray(value) ? value : [];
}
function string(value) {
    return typeof value === "string" ? value : "";
}
function number(value) {
    return typeof value === "number" ? value : undefined;
}
