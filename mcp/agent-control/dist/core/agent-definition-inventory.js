import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CodexAppServerClient } from "../adapters/codex-thread-adapter.js";
import { capabilityIcon } from "./capability-icons.js";
import { REQUIRED_AGENT_CONTROL_MCP, REQUIRED_AGENT_CONTROL_PLUGIN } from "./agent-definitions.js";
import { ControllerError } from "./errors.js";
const inventoryCache = new Map();
export async function loadAgentDefinitionInventory(repoDir, refresh = false, selectedExecutable) {
    const executable = selectedExecutable
        ? resolveExecutable(selectedExecutable)
        : resolveCodexExecutable();
    const cwd = resolve(repoDir);
    const key = executable + "\0" + cwd;
    if (!refresh) {
        const cached = inventoryCache.get(key);
        if (cached)
            return cached;
    }
    const raw = await readRuntime(executable, cwd, refresh);
    const inventory = buildInventory(executable, cwd, raw);
    await qualifyRuntime(inventory, cwd);
    inventory.inventory_revision = hashJson({
        runtime: inventory.runtime,
        providers: inventory.providers,
        models: inventory.models,
        plugins: inventory.plugins,
        skills: inventory.skills,
        mcp_servers: inventory.mcp_servers,
        apps: inventory.apps
    });
    inventoryCache.set(key, inventory);
    return inventory;
}
export function compileAgentConfiguration(definition, catalogRevision, inventory, repoDir) {
    const inherit = definition.capabilities_mode === "inherit";
    const model = inventory.models.find((entry) => entry.id === definition.model && entry.model_provider === definition.model_provider);
    if (!model?.available) {
        throw capabilityUnavailable("model", definition.model);
    }
    if (model.catalog_available && !model.supported_reasoning_efforts.includes(definition.reasoning_effort)) {
        throw capabilityUnavailable("model", definition.model, "The selected reasoning effort is not supported by this catalog model.");
    }
    const selectedPlugins = new Map((inherit ? inventory.plugins.map(entry => ({ id: entry.id, enabled: entry.enabled_by_default })) : definition.plugins).map((entry) => [entry.id, entry.enabled]));
    selectedPlugins.set(REQUIRED_AGENT_CONTROL_PLUGIN, true);
    for (const [id, enabled] of selectedPlugins) {
        if (enabled && !inventory.plugins.some((entry) => entry.id === id && entry.available)) {
            throw capabilityUnavailable("plugin", id);
        }
    }
    const selectedSkills = new Map((inherit ? inventory.skills.map(entry => ({ path: entry.path, enabled: entry.enabled_by_default })) : definition.skills).map((entry) => [entry.path, entry.enabled]));
    for (const [path, enabled] of selectedSkills) {
        if (enabled && !inventory.skills.some((entry) => entry.path === path && entry.available)) {
            throw capabilityUnavailable("skill", path);
        }
    }
    const selectedMcp = new Map((inherit ? inventory.mcp_servers.map(entry => ({ name: entry.name, enabled: entry.enabled_by_default })) : definition.mcp_servers).map((entry) => [entry.name, entry.enabled]));
    selectedMcp.set(REQUIRED_AGENT_CONTROL_MCP, true);
    for (const [name, enabled] of selectedMcp) {
        if (enabled && !inventory.mcp_servers.some((entry) => entry.name === name && entry.available)) {
            throw capabilityUnavailable("mcp_server", name);
        }
    }
    const inventoryPluginById = new Map(inventory.plugins.map((entry) => [entry.id, entry]));
    const customPlugins = new Map((inherit ? [] : definition.plugins).map(plugin => [plugin.id, plugin]));
    for (const selection of customPlugins.values()) {
        if (!selection.enabled)
            continue;
        const plugin = inventoryPluginById.get(selection.id);
        for (const skill of selection.skills ?? [])
            if (skill.enabled && !plugin?.bundled_skills.some(item => item.path === skill.path))
                throw capabilityUnavailable("skill", skill.path);
        for (const server of selection.mcp_servers ?? [])
            if (server.enabled && !plugin?.bundled_mcp_servers.some(item => item.name === server.name))
                throw capabilityUnavailable("mcp_server", server.name);
        for (const app of selection.apps ?? [])
            if (app.enabled && !plugin?.bundled_apps.some(item => item.id === app.id))
                throw capabilityUnavailable("plugin", selection.id, "Bundled app " + app.id + " is unavailable.");
    }
    const pluginIds = orderedUnique([
        ...(inherit ? [] : definition.plugins.filter((entry) => inventoryPluginById.has(entry.id)).map((entry) => entry.id)),
        ...inventory.plugins.map((entry) => entry.id).sort()
    ]);
    const plugins = pluginIds.map((id) => {
        const enabled = id === REQUIRED_AGENT_CONTROL_PLUGIN || selectedPlugins.get(id) === true;
        return {
            id,
            enabled,
            required: id === REQUIRED_AGENT_CONTROL_PLUGIN || inventoryPluginById.get(id)?.required === true,
            bundled_skills: (inventoryPluginById.get(id)?.bundled_skills ?? []).map((skill) => ({
                ...skill,
                enabled: enabled && (inherit ? skill.enabled_by_default !== false : customPlugins.get(id)?.skills?.some(item => item.path === skill.path && item.enabled) ?? true)
            }))
        };
    });
    const pluginEnabled = new Map(plugins.map((entry) => [entry.id, entry.enabled]));
    const skillPaths = orderedUnique([
        ...(inherit ? [] : definition.skills.filter((entry) => inventory.skills.some((skill) => skill.path === entry.path))
            .map((entry) => entry.path)),
        ...inventory.skills.map((entry) => entry.path).sort()
    ]);
    const skills = skillPaths.map((path) => ({ path, enabled: selectedSkills.get(path) === true }));
    const bundledMcp = new Map();
    const bundledApps = new Map();
    for (const configuredPlugin of plugins) {
        const plugin = inventoryPluginById.get(configuredPlugin.id);
        if (!plugin)
            continue;
        for (const server of plugin.bundled_mcp_servers) {
            bundledMcp.set(server.name, { pluginId: plugin.id, rootTransport: server.root_transport === true, enabledByDefault: server.enabled_by_default !== false });
        }
        for (const app of plugin.bundled_apps) {
            const bundle = bundledApps.get(app.id) ?? { name: app.name, pluginIds: [] };
            if (!bundle.pluginIds.includes(plugin.id))
                bundle.pluginIds.push(plugin.id);
            bundledApps.set(app.id, bundle);
        }
    }
    const knownMcpNames = new Set([...bundledMcp.keys(), ...inventory.mcp_servers.map((entry) => entry.name)]);
    const mcpNames = orderedUnique([
        ...(inherit ? [] : definition.mcp_servers.filter((entry) => knownMcpNames.has(entry.name)).map((entry) => entry.name)),
        ...bundledMcp.keys(),
        ...inventory.mcp_servers.map((entry) => entry.name).sort()
    ]);
    const mcpServers = mcpNames.map((name) => {
        const bundle = bundledMcp.get(name);
        return {
            name,
            enabled: name === REQUIRED_AGENT_CONTROL_MCP ||
                (bundle ? pluginEnabled.get(bundle.pluginId) === true && (inherit ? bundle.enabledByDefault : customPlugins.get(bundle.pluginId)?.mcp_servers?.some(item => item.name === name && item.enabled) ?? true) : selectedMcp.get(name) === true),
            ...(bundle ? { plugin_id: bundle.pluginId, ...(bundle.rootTransport ? { root_transport: true } : {}) } : {})
        };
    });
    const inventoryAppById = new Map(inventory.apps.map((entry) => [entry.id, entry]));
    const appIds = orderedUnique([...bundledApps.keys(), ...inventory.apps.map((entry) => entry.id).sort()]);
    const apps = appIds.map((id) => {
        const bundle = bundledApps.get(id);
        const entry = inventoryAppById.get(id);
        return {
            id,
            name: bundle?.name ?? entry?.name ?? id,
            enabled: bundle ? bundle.pluginIds.some((pluginId) => pluginEnabled.get(pluginId) === true && (inherit ? entry?.enabled_by_default === true : customPlugins.get(pluginId)?.apps?.some(item => item.id === id && item.enabled) ?? true)) : inherit && entry?.enabled_by_default === true,
            ...(bundle ? { plugin_ids: bundle.pluginIds } : {})
        };
    });
    for (const [id, bundle] of bundledApps) {
        const enabledOwner = bundle.pluginIds.find((pluginId) => pluginEnabled.get(pluginId) === true);
        if (!inventoryAppById.get(id)?.available && enabledOwner && apps.some(app => app.id === id && app.enabled)) {
            throw capabilityUnavailable("plugin", enabledOwner, "Bundled app " + id + " is unavailable.");
        }
    }
    const inherited = inventory.inherited_developer_instructions;
    const developerInstructions = composeDeveloperInstructions(inherited, definition.instructions);
    const overrides = compileOverrides({
        model: definition.model,
        modelProvider: definition.model_provider,
        reasoningEffort: definition.reasoning_effort,
        budget: definition.skills_catalog_token_budget,
        developerInstructions,
        plugins,
        skills,
        mcpServers,
        apps
    });
    return {
        snapshot_version: 1,
        definition_id: definition.definition_id,
        definition_name: definition.name,
        catalog_revision: catalogRevision,
        inherited_instructions: inherited,
        definition_instructions: definition.instructions,
        developer_instructions: developerInstructions,
        instructions_hash: createHash("sha256").update(developerInstructions).digest("hex"),
        model: definition.model,
        model_provider: definition.model_provider,
        reasoning_effort: definition.reasoning_effort,
        ...(definition.skills_catalog_token_budget
            ? { skills_catalog_token_budget: definition.skills_catalog_token_budget }
            : {}),
        executable: inventory.runtime.executable,
        executable_version: inventory.runtime.version,
        repo_dir: resolve(repoDir),
        plugins,
        skills,
        mcp_servers: mcpServers,
        apps,
        app_server_overrides: overrides,
        inventory_revision: inventory.inventory_revision
    };
}
export function composeDeveloperInstructions(inherited, definition) {
    const parts = [];
    if (inherited.trim())
        parts.push(inherited.trim());
    if (definition.trim()) {
        parts.push("<agent-control-definition-instructions>\n" +
            definition.trim() +
            "\n</agent-control-definition-instructions>");
    }
    return parts.join("\n\n");
}
export function compiledSnapshotHash(snapshot) {
    return hashJson(snapshot);
}
export function refreshCompiledAgentConfiguration(snapshot, inventory) {
    if (inventory.runtime.executable !== snapshot.executable ||
        inventory.runtime.version !== snapshot.executable_version) {
        throw new ControllerError("Configured-agent continuation runtime changed from its immutable snapshot.", "unsupported_runtime", {
            expected_executable: snapshot.executable,
            actual_executable: inventory.runtime.executable,
            expected_version: snapshot.executable_version,
            actual_version: inventory.runtime.version
        });
    }
    const model = inventory.models.find((entry) => entry.id === snapshot.model && entry.model_provider === snapshot.model_provider && entry.available);
    if (!model)
        throw capabilityUnavailable("model", snapshot.model);
    if (model.catalog_available && !model.supported_reasoning_efforts.includes(snapshot.reasoning_effort)) {
        throw capabilityUnavailable("model", snapshot.model, "The selected reasoning effort is no longer supported by this catalog model.");
    }
    const previousPlugins = new Map(snapshot.plugins.map((entry) => [entry.id, entry.enabled]));
    const inventoryPluginById = new Map(inventory.plugins.map((entry) => [entry.id, entry]));
    const plugins = orderedUnique([
        ...snapshot.plugins.filter((entry) => inventoryPluginById.has(entry.id)).map((entry) => entry.id),
        ...inventory.plugins.map((entry) => entry.id).sort()
    ]).map((id) => {
        const previous = snapshot.plugins.find((entry) => entry.id === id);
        const enabled = id === REQUIRED_AGENT_CONTROL_PLUGIN || previousPlugins.get(id) === true;
        return {
            id,
            enabled,
            required: id === REQUIRED_AGENT_CONTROL_PLUGIN || inventoryPluginById.get(id)?.required === true,
            bundled_skills: previous?.bundled_skills ?? (inventoryPluginById.get(id)?.bundled_skills ?? []).map((skill) => ({
                ...skill,
                enabled: false
            }))
        };
    });
    for (const entry of snapshot.plugins) {
        if (entry.enabled && !inventory.plugins.some((candidate) => candidate.id === entry.id && candidate.available)) {
            throw capabilityUnavailable("plugin", entry.id);
        }
        const current = inventoryPluginById.get(entry.id);
        for (const skill of entry.bundled_skills) {
            if (skill.enabled && !current?.bundled_skills.some((candidate) => candidate.path === skill.path)) {
                throw capabilityUnavailable("skill", skill.path);
            }
        }
    }
    const previousSkills = new Map(snapshot.skills.map((entry) => [entry.path, entry.enabled]));
    const previousSkillByPath = new Map(snapshot.skills.map((entry) => [entry.path, entry]));
    const knownBundledSkillPaths = new Set(snapshot.plugins.flatMap((entry) => entry.bundled_skills.map((skill) => skill.path)));
    const newlyBundledSkills = inventory.plugins.flatMap((plugin) => plugin.bundled_skills
        .filter((skill) => !knownBundledSkillPaths.has(skill.path))
        .map((skill) => ({ ...skill, pluginId: plugin.id })));
    const availableStandaloneSkillPaths = new Set(inventory.skills.map((entry) => entry.path));
    const skills = orderedUnique([
        ...snapshot.skills.filter((entry) => availableStandaloneSkillPaths.has(entry.path) ||
            newlyBundledSkills.some((skill) => skill.path === entry.path)).map((entry) => entry.path),
        ...newlyBundledSkills.map((entry) => entry.path),
        ...inventory.skills.map((entry) => entry.path).sort()
    ]).map((path) => {
        const previous = previousSkillByPath.get(path);
        const bundled = newlyBundledSkills.find((entry) => entry.path === path);
        return {
            path,
            enabled: previousSkills.get(path) === true,
            ...(previous?.plugin_id ? { plugin_id: previous.plugin_id } : bundled ? { plugin_id: bundled.pluginId } : {})
        };
    });
    for (const entry of snapshot.skills) {
        if (entry.enabled && !inventory.skills.some((candidate) => candidate.path === entry.path && candidate.available)) {
            throw capabilityUnavailable("skill", entry.path);
        }
    }
    const previousMcp = new Map(snapshot.mcp_servers.map((entry) => [entry.name, entry.enabled]));
    const bundledMcp = inventory.plugins.flatMap((plugin) => plugin.bundled_mcp_servers.map((server) => ({
        name: server.name,
        pluginId: plugin.id,
        rootTransport: server.root_transport === true
    })));
    const availableMcpNames = new Set([
        ...inventory.mcp_servers.filter((entry) => entry.available).map((entry) => entry.name),
        ...bundledMcp.map((entry) => entry.name)
    ]);
    const mcpNames = orderedUnique([
        ...snapshot.mcp_servers.filter((entry) => availableMcpNames.has(entry.name)).map((entry) => entry.name),
        ...bundledMcp.map((entry) => entry.name),
        ...inventory.mcp_servers.map((entry) => entry.name).sort()
    ]);
    const mcpServers = mcpNames.map((name) => {
        const bundle = bundledMcp.find((entry) => entry.name === name);
        return {
            name,
            enabled: name === REQUIRED_AGENT_CONTROL_MCP || previousMcp.get(name) === true,
            ...(bundle ? {
                plugin_id: bundle.pluginId,
                ...(bundle.rootTransport ? { root_transport: true } : {})
            } : {})
        };
    });
    for (const entry of snapshot.mcp_servers) {
        if (entry.enabled && !availableMcpNames.has(entry.name))
            throw capabilityUnavailable("mcp_server", entry.name);
    }
    const previousApps = new Map(snapshot.apps.map((entry) => [entry.id, entry.enabled]));
    const currentBundledApps = new Map();
    for (const plugin of inventory.plugins) {
        for (const app of plugin.bundled_apps) {
            const bundle = currentBundledApps.get(app.id) ?? { name: app.name, pluginIds: [] };
            if (!bundle.pluginIds.includes(plugin.id))
                bundle.pluginIds.push(plugin.id);
            currentBundledApps.set(app.id, bundle);
        }
    }
    const currentApps = new Map(inventory.apps.map((entry) => [entry.id, entry]));
    const apps = orderedUnique([
        ...snapshot.apps.map((entry) => entry.id),
        ...currentBundledApps.keys(),
        ...inventory.apps.map((entry) => entry.id).sort()
    ]).map((id) => {
        const previous = snapshot.apps.find((candidate) => candidate.id === id);
        const bundled = currentBundledApps.get(id);
        return {
            id,
            name: previous?.name ?? bundled?.name ?? currentApps.get(id)?.name ?? id,
            enabled: previousApps.get(id) === true,
            ...(bundled ? { plugin_ids: bundled.pluginIds } : previous?.plugin_ids ? { plugin_ids: previous.plugin_ids } : {})
        };
    });
    for (const entry of snapshot.apps) {
        if (entry.enabled && !inventory.apps.some((candidate) => candidate.id === entry.id && candidate.available)) {
            throw capabilityUnavailable("app", entry.id);
        }
    }
    const appServerOverrides = compileOverrides({
        model: snapshot.model,
        modelProvider: snapshot.model_provider,
        reasoningEffort: snapshot.reasoning_effort,
        budget: snapshot.skills_catalog_token_budget,
        developerInstructions: snapshot.developer_instructions,
        plugins,
        skills,
        mcpServers,
        apps
    });
    return {
        ...snapshot,
        plugins,
        skills,
        mcp_servers: mcpServers,
        apps,
        app_server_overrides: appServerOverrides,
        inventory_revision: inventory.inventory_revision
    };
}
function compileOverrides(input) {
    const bundledMcpByPlugin = new Map();
    for (const server of input.mcpServers) {
        if (!server.plugin_id)
            continue;
        const entries = bundledMcpByPlugin.get(server.plugin_id) ?? [];
        entries.push({ name: server.name, enabled: server.enabled });
        bundledMcpByPlugin.set(server.plugin_id, entries);
    }
    const plugins = Object.fromEntries(input.plugins.map((entry) => [entry.id, {
            enabled: entry.enabled,
            ...(bundledMcpByPlugin.has(entry.id) ? {
                mcp_servers: Object.fromEntries(bundledMcpByPlugin.get(entry.id).map((server) => [
                    server.name,
                    { enabled: server.enabled }
                ]))
            } : {})
        }]));
    const mcpServers = Object.fromEntries(input.mcpServers.flatMap((entry) => {
        if (!entry.plugin_id || entry.root_transport) {
            return [[entry.name, { enabled: entry.enabled }]];
        }
        if (entry.enabled)
            return [];
        // Native plugin MCP disable flags may take effect after the server starts.
        // A complete inert root definition shadows that late activation without
        // copying the bundled transport or any of its credentials.
        return [[entry.name, {
                    enabled: false,
                    command: process.execPath,
                    args: ["-e", "process.exit(0)"]
                }]];
    }));
    const apps = Object.fromEntries([
        ["_default", { enabled: false }],
        ...input.apps.map((entry) => [entry.id, { enabled: entry.enabled }])
    ]);
    const result = [
        "plugins=" + toTomlInline(plugins),
        "skills.config=" + toTomlInline(input.skills),
        "mcp_servers=" + toTomlInline(mcpServers),
        "apps=" + toTomlInline(apps),
        "model=" + toTomlInline(input.model),
        "model_provider=" + toTomlInline(input.modelProvider),
        "model_reasoning_effort=" + toTomlInline(input.reasoningEffort),
        "developer_instructions=" + toTomlInline(input.developerInstructions)
    ];
    if (input.budget !== undefined) {
        result.push("skills.max_context_tokens=" + input.budget);
    }
    return result;
}
async function readRuntime(executable, cwd, refresh) {
    return withAppServer(executable, cwd, [], async (client) => {
        const [configResponse, skillsResponse, pluginResponse, modelResponse] = await Promise.all([
            client.request("config/read", { cwd, includeLayers: true }),
            client.request("skills/list", { cwds: [cwd], forceReload: refresh }),
            // Use Codex's effective catalog; forcing local resurrects legacy curated installs.
            collectPages(client, "plugin/list", {
                cwds: [cwd],
                forceRefetch: refresh
            }, "marketplaces"),
            collectPages(client, "model/list", {}, "data")
        ]);
        const config = object(object(configResponse).config);
        const provider = string(config.model_provider) || "openai";
        const modelCatalogs = [{ provider, models: modelResponse }];
        if (provider !== "openai") {
            // A personal default provider must not hide the public Codex agent defaults.
            // Probe that provider in a separate process; keep capability discovery on
            // the user's effective configuration and never rewrite their config.
            const models = await withAppServer(executable, cwd, ['model_provider="openai"'], client => collectPages(client, "model/list", {}, "data"));
            modelCatalogs.push({ provider: "openai", models });
        }
        const skills = array(object(skillsResponse).data).flatMap((entry) => array(object(entry).skills));
        const marketplaces = array(pluginResponse.marketplaces).map(object);
        const pluginRows = marketplaces.flatMap((entry) => array(entry.plugins).map(object));
        const pluginDetails = new Map();
        for (const marketplace of marketplaces) {
            for (const plugin of array(marketplace.plugins).map(object).filter((entry) => entry.installed === true)) {
                const response = object(await client.request("plugin/read", {
                    // Remote app aliases differ from the identifier accepted by plugin/read.
                    pluginName: !string(marketplace.path) && string(plugin.remotePluginId)
                        ? string(plugin.remotePluginId)
                        : string(plugin.name),
                    ...(string(marketplace.path) ? { marketplacePath: string(marketplace.path) } : {}),
                    ...(!string(marketplace.path) && string(marketplace.name)
                        ? { remoteMarketplaceName: string(marketplace.name) }
                        : {})
                }));
                pluginDetails.set(string(plugin.id), object(response.plugin));
            }
        }
        const appIds = new Set(Object.keys(object(config.apps)).filter((id) => id !== "_default"));
        for (const plugin of pluginRows) {
            for (const app of manifestInfo(object(plugin), skills, pluginDetails.get(string(plugin.id))).apps)
                appIds.add(app.id);
        }
        const appMetadata = [];
        const ids = [...appIds];
        for (let index = 0; index < ids.length; index += 100) {
            const response = object(await client.request("app/read", {
                appIds: ids.slice(index, index + 100),
                includeTools: false
            }));
            appMetadata.push(...array(response.apps).map(object));
        }
        return {
            config: object(configResponse),
            skills: object(skillsResponse),
            plugins: pluginResponse,
            modelCatalogs,
            pluginDetails,
            appMetadata
        };
    });
}
function buildInventory(executable, cwd, raw) {
    const config = object(raw.config.config);
    const skills = array(raw.skills.data).flatMap((entry) => array(object(entry).skills)).map(object);
    const pluginRows = array(raw.plugins.marketplaces).flatMap((entry) => array(object(entry).plugins)).map(object);
    const plugins = pluginRows.map((row) => pluginInventory(row, skills, raw.pluginDetails.get(string(row.id))))
        .filter((entry) => Boolean(entry));
    const bundledSkillPaths = new Set(plugins.flatMap((entry) => entry.bundled_skills.map((skill) => skill.path)));
    const bundledMcpNames = new Set(plugins.flatMap((entry) => entry.bundled_mcp_servers.map((server) => server.name)));
    const mcpConfig = object(config.mcp_servers);
    for (const plugin of plugins) {
        for (const skill of plugin.bundled_skills) {
            // Plugin metadata describes installed content. Only skills/list proves
            // that this executable exposes a skill in the effective session catalog.
            const runtimeSkill = skills.find(entry => string(entry.path) === skill.path);
            skill.runtime_available = Boolean(runtimeSkill);
            skill.enabled_by_default = Boolean(runtimeSkill) && runtimeSkill.enabled !== false;
        }
        for (const server of plugin.bundled_mcp_servers) {
            if (hasMcpTransport(object(mcpConfig[server.name])))
                server.root_transport = true;
            server.enabled_by_default = object(object(object(config.plugins)[plugin.id]).mcp_servers)[server.name]?.enabled !== false && object(mcpConfig[server.name]).enabled !== false;
        }
    }
    const mcpNames = Object.keys(mcpConfig).filter((name) => !bundledMcpNames.has(name));
    if (!mcpNames.includes(REQUIRED_AGENT_CONTROL_MCP))
        mcpNames.unshift(REQUIRED_AGENT_CONTROL_MCP);
    const configuredModels = [];
    const addConfiguredModel = (value) => {
        const model = string(value.model);
        const provider = string(value.model_provider);
        if (model && provider && !configuredModels.some((entry) => entry.model === model && entry.provider === provider)) {
            configuredModels.push({ model, provider });
        }
    };
    addConfiguredModel(config);
    for (const profile of Object.values(object(config.profiles)))
        addConfiguredModel(object(profile));
    for (const profile of configuredProfileModels())
        addConfiguredModel(profile);
    const defaultProvider = string(config.model_provider) || "openai";
    const providerConfig = object(config.model_providers);
    const providerIds = new Set([defaultProvider, ...raw.modelCatalogs.map(catalog => catalog.provider), ...Object.keys(providerConfig), ...configuredModels.map((entry) => entry.provider)]);
    const nativeModels = raw.modelCatalogs.flatMap(catalog => array(catalog.models.data).map(object).map((row) => ({
        id: string(row.model) || string(row.id),
        ...(string(row.displayName) ? { display_name: string(row.displayName) } : {}),
        model_provider: catalog.provider,
        supported_reasoning_efforts: array(row.supportedReasoningEfforts)
            .map((effort) => string(object(effort).reasoningEffort))
            .filter(Boolean),
        available: row.hidden !== true,
        catalog_available: true,
        run_validation_required: false
    }))).filter((entry) => entry.id);
    for (const configured of configuredModels) {
        if (!nativeModels.some((entry) => entry.id === configured.model && entry.model_provider === configured.provider)) {
            nativeModels.push({
                id: configured.model,
                model_provider: configured.provider,
                supported_reasoning_efforts: [],
                available: true,
                catalog_available: false,
                run_validation_required: true
            });
        }
    }
    const appConfig = object(config.apps);
    const metadataById = new Map(raw.appMetadata.map((entry) => [string(entry.id), entry]));
    const appIds = new Set(Object.keys(appConfig).filter((id) => id !== "_default"));
    for (const plugin of plugins)
        for (const app of plugin.bundled_apps)
            appIds.add(app.id);
    return {
        inventory_revision: "",
        refreshed_at: new Date().toISOString(),
        runtime: { executable, version: executableVersion(executable), compatible: true },
        inherited_developer_instructions: string(config.developer_instructions),
        providers: [...providerIds].map((id) => ({
            id,
            ...(string(object(providerConfig[id]).name) ? { name: string(object(providerConfig[id]).name) } : {}),
            available: true
        })).sort((left, right) => left.id.localeCompare(right.id)),
        models: nativeModels,
        plugins,
        skills: skills.filter((entry) => string(entry.path) && !bundledSkillPaths.has(string(entry.path))).map((entry) => ({
            path: string(entry.path),
            name: string(entry.name) || basename(dirname(string(entry.path))),
            ...(string(entry.description) ? { description: string(entry.description) } : {}),
            ...(string(entry.scope) ? { scope: string(entry.scope) } : {}),
            icon_url: capabilityIcon([object(entry.interface).iconSmall, object(entry.interface).iconLarge], [dirname(string(entry.path))]),
            required: false,
            available: true,
            enabled_by_default: entry.enabled !== false
        })).sort((left, right) => left.name.localeCompare(right.name)),
        mcp_servers: mcpNames.map((name) => ({
            name,
            required: name === REQUIRED_AGENT_CONTROL_MCP,
            available: name === REQUIRED_AGENT_CONTROL_MCP
                ? plugins.some((entry) => entry.id === REQUIRED_AGENT_CONTROL_PLUGIN && entry.available)
                : true,
            enabled_by_default: name === REQUIRED_AGENT_CONTROL_MCP || object(mcpConfig[name]).enabled !== false
        })).sort((left, right) => Number(right.required) - Number(left.required) || left.name.localeCompare(right.name)),
        apps: [...appIds].map((id) => {
            const metadata = metadataById.get(id);
            const manifestApp = plugins.flatMap((plugin) => plugin.bundled_apps).find((app) => app.id === id);
            return {
                id,
                name: string(metadata?.name) || manifestApp?.name || id,
                available: Boolean(metadata),
                enabled_by_default: (object(appConfig[id]).enabled ?? object(appConfig._default).enabled) !== false
            };
        }).sort((left, right) => left.name.localeCompare(right.name))
    };
}
function pluginInventory(row, skills, detail) {
    const id = string(row.id);
    const name = string(row.name);
    if (!id || !name || row.installed !== true)
        return null;
    const manifest = manifestInfo(row, skills, detail);
    const roots = [installedPluginRoot(row), pluginRoot(row)].filter((root) => Boolean(root));
    const artwork = [object(row.interface), object(object(detail?.summary).interface), object(roots[0] ? readJson(join(roots[0], ".codex-plugin", "plugin.json")).interface : {})];
    const required = id === REQUIRED_AGENT_CONTROL_PLUGIN;
    return {
        id,
        icon_url: capabilityIcon(artwork.flatMap(entry => [entry.composerIcon, entry.logo]), roots),
        icon_dark_url: capabilityIcon(artwork.map(entry => entry.logoDark), roots),
        name: string(object(row.interface).displayName) || name,
        ...(string(object(row.interface).shortDescription)
            ? { description: string(object(row.interface).shortDescription) }
            : {}),
        ...(string(row.localVersion) || string(row.version)
            ? { version: string(row.localVersion) || string(row.version) }
            : {}),
        bundled_skills: manifest.skills,
        bundled_mcp_servers: manifest.mcpServers.map((serverName) => ({ name: serverName })),
        bundled_apps: manifest.apps,
        required,
        available: row.availability !== "UNAVAILABLE",
        enabled_by_default: required || row.enabled === true
    };
}
function manifestInfo(row, skills, detail) {
    if (detail && Object.keys(detail).length > 0) {
        const sourceRoot = pluginRoot(row);
        const installedRoot = installedPluginRoot(row) ?? sourceRoot;
        const detailSkills = array(detail.skills).map(object).filter((entry) => string(entry.path)).map((entry) => {
            const detailPath = string(entry.path);
            const name = string(entry.name) || basename(dirname(detailPath));
            const runtimeSkill = skills.find((candidate) => string(candidate.name) === name && Boolean(installedRoot) && isInside(string(candidate.path), installedRoot));
            const installedPath = sourceRoot && installedRoot && isInside(detailPath, sourceRoot)
                ? resolve(installedRoot, relative(sourceRoot, detailPath))
                : undefined;
            return {
                path: string(runtimeSkill?.path) || (installedPath && existsSync(installedPath) ? installedPath : detailPath),
                name
            };
        });
        const detailApps = array(detail.apps).map(object).filter((entry) => string(entry.id)).map((entry) => ({
            id: string(entry.id),
            name: string(entry.name) || string(entry.id)
        }));
        for (const template of array(detail.appTemplates).map(object)) {
            for (const id of array(template.materializedAppIds).map(string).filter(Boolean)) {
                if (!detailApps.some((entry) => entry.id === id)) {
                    detailApps.push({ id, name: string(template.name) || id });
                }
            }
        }
        return {
            root: null,
            skills: detailSkills,
            mcpServers: array(detail.mcpServers).map(string).filter(Boolean),
            apps: detailApps
        };
    }
    const root = pluginRoot(row);
    if (!root)
        return { root: null, skills: [], mcpServers: [], apps: [] };
    const manifest = readJson(join(root, ".codex-plugin", "plugin.json"));
    const pluginSkills = skills.filter((entry) => isInside(string(entry.path), root)).map((entry) => ({
        path: string(entry.path),
        name: string(entry.name) || basename(dirname(string(entry.path)))
    }));
    const mcpPath = string(manifest.mcpServers)
        ? resolve(root, string(manifest.mcpServers))
        : join(root, ".mcp.json");
    const appPath = string(manifest.apps)
        ? resolve(root, string(manifest.apps))
        : join(root, ".app.json");
    const mcpServers = Object.keys(object(readJson(mcpPath).mcpServers));
    const apps = Object.entries(object(readJson(appPath).apps)).map(([name, value]) => ({
        id: string(object(value).id) || name,
        name
    }));
    return { root, skills: pluginSkills, mcpServers, apps };
}
async function qualifyRuntime(inventory, cwd) {
    const candidates = inventory.plugins.filter((entry) => entry.enabled_by_default && entry.bundled_skills.some(skill => skill.enabled_by_default));
    const candidate = candidates.find((entry) => !entry.required) ?? candidates[0];
    if (!candidate) {
        throw new ControllerError("Codex executable could not be qualified because no enabled plugin skill is available for the isolation probe.", "unsupported_runtime", { executable: inventory.runtime.executable, version: inventory.runtime.version });
    }
    const disabled = await withAppServer(inventory.runtime.executable, cwd, ["plugins=" + toTomlInline({ [candidate.id]: { enabled: false } })], async (client) => {
        const [config, skills] = await Promise.all([
            client.request("config/read", { cwd }),
            client.request("skills/list", { cwds: [cwd], forceReload: true })
        ]);
        return { config: object(object(config).config), skills: object(skills) };
    });
    const pluginDisabled = object(object(disabled.config.plugins)[candidate.id]).enabled === false;
    const returnedSkills = array(disabled.skills.data).flatMap((entry) => array(object(entry).skills)).map(object);
    const skillsDisabled = candidate.bundled_skills.every((skill) => {
        const returned = returnedSkills.find((entry) => string(entry.path) === skill.path);
        return !returned || returned.enabled === false;
    });
    if (!pluginDisabled || !skillsDisabled) {
        inventory.runtime.compatible = false;
        inventory.runtime.compatibility_reason = "Root plugin isolation failed for " + candidate.id + ".";
        throw new ControllerError("Codex executable is incompatible with configured-agent plugin isolation.", "unsupported_runtime", {
            executable: inventory.runtime.executable,
            version: inventory.runtime.version,
            plugin_id: candidate.id
        });
    }
}
async function withAppServer(executable, cwd, overrides, action) {
    const args = [
        "app-server",
        "--listen",
        "stdio://",
        ...overrides.flatMap((entry) => ["-c", entry])
    ];
    const client = new CodexAppServerClient("stdio://", undefined, {
        executable,
        args,
        cwd,
        detached: true
    });
    const timeout = setTimeout(() => client.close(true), 30_000);
    try {
        await client.initialize();
        return await action(client);
    }
    catch (error) {
        if (error instanceof ControllerError)
            throw error;
        throw new ControllerError("Could not read configured-agent inventory from Codex app-server.", "unsupported_runtime", { executable, error: error instanceof Error ? error.message : String(error) });
    }
    finally {
        clearTimeout(timeout);
        await client.closeAndWait();
    }
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
    return { [field]: values, nextCursor: null };
}
function resolveCodexExecutable() {
    const explicit = process.env.AGENT_CONTROL_CODEX_CLI_BIN;
    if (explicit)
        return resolveExecutable(explicit);
    const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
    if (existsSync(bundled))
        return realpathSync(bundled);
    return resolveExecutable("codex");
}
function resolveExecutable(value) {
    if (isAbsolute(value) || value.includes("/")) {
        if (!existsSync(value)) {
            throw new ControllerError("Configured Codex executable does not exist: " + value + ".", "unsupported_runtime");
        }
        return realpathSync(value);
    }
    const result = spawnSync("/usr/bin/which", [value], { encoding: "utf8" });
    const path = result.status === 0 ? result.stdout.trim() : "";
    if (!path || !existsSync(path)) {
        throw new ControllerError("Codex executable was not found: " + value + ".", "unsupported_runtime");
    }
    return realpathSync(path);
}
function executableVersion(executable) {
    const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) {
        throw new ControllerError("Could not determine Codex executable version.", "unsupported_runtime", { executable });
    }
    return result.stdout.trim() || result.stderr.trim();
}
function configuredProfileModels() {
    const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    try {
        return readdirSync(home)
            .filter((name) => name.endsWith(".config.toml"))
            .map((name) => {
            try {
                return object(parseToml(readFileSync(join(home, name), "utf8")));
            }
            catch {
                return {};
            }
        });
    }
    catch {
        return [];
    }
}
function pluginRoot(row) {
    const source = object(row.source);
    const name = string(row.name);
    const roots = [string(source.path), string(source.url)].filter(Boolean);
    const candidates = roots.flatMap((path) => [path, join(path, "plugins", name)]);
    return candidates.find((candidate) => existsSync(join(candidate, ".codex-plugin", "plugin.json"))) ?? null;
}
function installedPluginRoot(row) {
    const id = string(row.id);
    const separator = id.lastIndexOf("@");
    const pluginName = string(row.name);
    const marketplace = separator > 0 ? id.slice(separator + 1) : "";
    const version = string(row.localVersion) || string(row.version);
    if (!pluginName || !marketplace)
        return null;
    const parent = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "plugins", "cache", marketplace, pluginName);
    let candidates;
    try {
        candidates = readdirSync(parent).map((name) => join(parent, name))
            .filter((root) => existsSync(join(root, ".codex-plugin", "plugin.json")));
    }
    catch {
        return null;
    }
    const exactDirectory = version ? candidates.find((root) => basename(root) === version) : undefined;
    if (exactDirectory)
        return exactDirectory;
    const versionMatches = version ? candidates.filter((root) => string(readJson(join(root, ".codex-plugin", "plugin.json")).version) === version) : [];
    return (versionMatches.length > 0 ? versionMatches : candidates).sort()[0] ?? null;
}
function readJson(path) {
    try {
        return object(JSON.parse(readFileSync(path, "utf8")));
    }
    catch {
        return {};
    }
}
function isInside(path, root) {
    if (!path)
        return false;
    const candidate = resolve(path);
    const boundary = resolve(root);
    return candidate === boundary || candidate.startsWith(boundary + "/");
}
function capabilityUnavailable(kind, id, message = "An enabled configured-agent capability is unavailable.") {
    return new ControllerError(message, "capability_unavailable", {
        capability_kind: kind,
        capability_id: id
    });
}
function toTomlInline(value) {
    if (Array.isArray(value))
        return "[" + value.map(toTomlInline).join(",") + "]";
    if (value && typeof value === "object") {
        return "{" + Object.entries(value)
            .map(([key, item]) => JSON.stringify(key) + "=" + toTomlInline(item))
            .join(",") + "}";
    }
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    throw new ControllerError("Unsupported configured-agent runtime value.", "validation");
}
function hashJson(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function hasMcpTransport(value) {
    return typeof value.command === "string" || typeof value.url === "string";
}
function array(value) {
    return Array.isArray(value) ? value : [];
}
function string(value) {
    return typeof value === "string" ? value : "";
}
function orderedUnique(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (seen.has(value))
            continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}
