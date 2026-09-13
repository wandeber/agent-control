import { describe, expect, it } from "vitest";
import { applyAgentPatch, changedAgentPatch, completeAgentPatch, createAgentDraft, editableAgent, filterCapabilityRows, inheritAgentCapabilities, mcpRows, pluginRows, replaceAgentCapabilities, skillRows, selectAgentModel, uniqueAgentName, type AgentDefinition, type AgentDefinitionInventoryResult, type AgentModelInventory } from "./agent-definitions";

describe("agent definition presentation", () => {
  it("carries inventory artwork through saved, inherited, and newly available rows", () => {
    const artwork = { icon_url: "data:image/svg+xml;base64,light", icon_dark_url: "data:image/svg+xml;base64,dark" };
    const illustrated = { ...inventory,
      plugins: inventory.plugins.map(item => ({ ...item, ...artwork })),
      skills: inventory.skills.map(item => ({ ...item, ...artwork })),
      mcp_servers: inventory.mcp_servers.map(item => ({ ...item, ...artwork }))
    };
    for (const agent of [definition, inheritAgentCapabilities(definition)]) {
      for (const row of [...pluginRows(agent, illustrated), ...skillRows(agent, illustrated), ...mcpRows(agent, illustrated)]) {
        expect(row).toMatchObject(artwork);
      }
    }
  });

  it("keeps saved capability order, preserves missing rows, and appends new inventory entries off", () => {
    const rows = pluginRows({
      ...definition,
      plugins: [{ id: "missing", enabled: true }, { id: "required", enabled: false }]
    }, inventory);

    expect(rows.map(row => [row.id, row.enabled, row.available, row.required])).toEqual([
      ["missing", true, false, false],
      ["required", true, true, true],
      ["optional", false, true, false]
    ]);
  });

  it("inherits current defaults and required capabilities, ignoring stale personal selections", () => {
    const inherited = { ...definition, capabilities_mode: "inherit" as const, plugins: [{ id: "missing", enabled: true }, { id: "optional", enabled: false }] };
    const currentInventory = {
      ...inventory,
      plugins: inventory.plugins.map(item => ({ ...item, enabled_by_default: item.id === "optional" })),
      skills: [...inventory.skills, { path: "off.md", name: "Off", required: false, available: true, enabled_by_default: false }]
    };
    expect(pluginRows(inherited, currentInventory).map(row => [row.id, row.enabled])).toEqual([["required", true], ["optional", true]]);
    expect(skillRows(inherited, currentInventory).map(row => [row.id, row.enabled])).toEqual([["skill.md", true], ["off.md", false]]);
    expect(mcpRows(inherited, currentInventory).map(row => [row.id, row.enabled])).toEqual([["agent_control", true]]);
  });

  it.each(["plugins", "skills", "mcp_servers"] as const)("materializes all categories on the first %s toggle", kind => {
    const inherited = inheritAgentCapabilities(definition);
    const currentInventory = {
      ...inventory,
      mcp_servers: [...inventory.mcp_servers, { name: "optional_mcp", required: false, available: true, enabled_by_default: true }]
    };
    const rows = kind === "plugins" ? pluginRows(inherited, currentInventory) : kind === "skills" ? skillRows(inherited, currentInventory) : mcpRows(inherited, currentInventory);
    const next = replaceAgentCapabilities(inherited, currentInventory, kind, rows.map(row => row.required ? row : { ...row, enabled: false }));
    expect(next.capabilities_mode).toBe("custom");
    expect(next.plugins).toEqual([{ id: "required", enabled: true }, { id: "optional", enabled: kind !== "plugins" }]);
    expect(next.skills).toEqual([{ path: "skill.md", enabled: kind !== "skills" }]);
    expect(next.mcp_servers).toEqual([{ name: "agent_control", enabled: true }, { name: "optional_mcp", enabled: kind !== "mcp_servers" }]);
    expect(inherited.plugins).toEqual([]);
  });

  it.each(["plugins", "skills", "mcp_servers"] as const)("preserves plugin child defaults when first editing %s", kind => {
    const inherited = inheritAgentCapabilities(definition);
    const currentInventory = inventoryWithPluginChildren();
    const rows = kind === "plugins" ? pluginRows(inherited, currentInventory) : kind === "skills" ? skillRows(inherited, currentInventory) : mcpRows(inherited, currentInventory);
    const custom = replaceAgentCapabilities(inherited, currentInventory, kind, rows.map(row => row.id === "optional" || row.id === "skill.md" || row.id === "optional_mcp" ? { ...row, enabled: false } : row));
    const activePlugin = custom.plugins.find(plugin => plugin.id === "required");
    expect(activePlugin).toEqual({
      id: "required", enabled: true,
      skills: [{ path: "child-off.md", enabled: false }, { path: "child-on.md", enabled: true }],
      mcp_servers: [{ name: "child-off", enabled: false }, { name: "child-on", enabled: true }],
      apps: [{ id: "app-off", enabled: false }, { id: "app-on", enabled: true }]
    });
    expect(custom.plugins.find(plugin => plugin.id === "disabled-plugin")).toEqual({ id: "disabled-plugin", enabled: false });
    const patch = changedAgentPatch(custom, inherited);
    expect(patch).toMatchObject({ capabilities_mode: "custom", plugins: custom.plugins, skills: custom.skills, mcp_servers: custom.mcp_servers });
    expect(applyAgentPatch(inherited, completeAgentPatch(custom)).plugins).toEqual(custom.plugins);
  });

  it("preserves child overrides through later plugin toggles and ordering", () => {
    const currentInventory = inventoryWithPluginChildren();
    const inherited = inheritAgentCapabilities(definition);
    const custom = replaceAgentCapabilities(inherited, currentInventory, "skills", skillRows(inherited, currentInventory));
    const savedChildren = custom.plugins.find(plugin => plugin.id === "required");
    const toggled = replaceAgentCapabilities(custom, currentInventory, "plugins", pluginRows(custom, currentInventory).map(row => row.id === "disabled-plugin" ? { ...row, enabled: true } : row));
    expect(toggled.plugins.find(plugin => plugin.id === "disabled-plugin")).toEqual({ id: "disabled-plugin", enabled: true });
    const reordered = replaceAgentCapabilities(toggled, currentInventory, "plugins", pluginRows(toggled, currentInventory).reverse());
    expect(reordered.plugins.map(plugin => plugin.id)).toEqual(["disabled-plugin", "optional", "required"]);
    expect(reordered.plugins.find(plugin => plugin.id === "required")).toEqual(savedChildren);
    expect(changedAgentPatch(reordered, custom).plugins).toEqual(reordered.plugins);
  });

  it("keeps saved custom child overrides even when inventory defaults change or disappear", () => {
    const custom: AgentDefinition = { ...definition, capabilities_mode: "custom", plugins: [{
      id: "optional", enabled: true,
      skills: [{ path: "saved-off.md", enabled: false }],
      mcp_servers: [{ name: "saved-off", enabled: false }],
      apps: [{ id: "saved-off", enabled: false }]
    }] };
    const disabled = replaceAgentCapabilities(custom, inventory, "plugins", pluginRows(custom, inventory).map(row => ({ ...row, enabled: false })));
    expect(disabled.plugins[0]).toEqual({ ...custom.plugins[0], enabled: false });
    const enabled = replaceAgentCapabilities(disabled, inventory, "plugins", pluginRows(disabled, inventory).map(row => ({ ...row, enabled: true })));
    expect(enabled.plugins[0]).toEqual(custom.plugins[0]);
    expect(completeAgentPatch(enabled).plugins).toEqual(enabled.plugins);
  });

  it("materializes inherited order on reorder and leaves other custom categories intact", () => {
    const inherited = inheritAgentCapabilities(definition);
    const reordered = replaceAgentCapabilities(inherited, inventory, "plugins", pluginRows(inherited, inventory).reverse());
    expect(reordered.plugins).toEqual([{ id: "optional", enabled: true }, { id: "required", enabled: true }]);
    expect(reordered.skills).toEqual([{ path: "skill.md", enabled: true }]);
    expect(reordered.mcp_servers).toEqual([{ name: "agent_control", enabled: true }]);
    const nextInventory = { ...inventory, skills: [] };
    const edited = replaceAgentCapabilities(reordered, nextInventory, "plugins", pluginRows(reordered, nextInventory));
    expect(edited.skills).toEqual(reordered.skills);
    expect(edited.plugins).toEqual(reordered.plugins);
  });

  it("returns to live inheritance and carries the reset through diff and full save", () => {
    const custom = { ...definition, plugins: [{ id: "optional", enabled: false }], skills: [{ path: "old.md", enabled: true }] };
    const inherited = inheritAgentCapabilities(custom);
    const patch = changedAgentPatch(inherited, custom);
    expect(patch).toEqual({ capabilities_mode: "inherit", plugins: [], skills: [], mcp_servers: [] });
    const saved = applyAgentPatch(custom, completeAgentPatch(inherited));
    expect(saved).toEqual(inherited);
    expect(pluginRows(saved, inventory).find(row => row.id === "optional")?.enabled).toBe(true);
    expect(skillRows(saved, { ...inventory, skills: [] })).toEqual([]);
  });

  it("reapplies a materialized snapshot atomically over a remote change", () => {
    const inherited = inheritAgentCapabilities(definition);
    const custom = replaceAgentCapabilities(inherited, inventory, "plugins", pluginRows(inherited, inventory).reverse());
    const patch = changedAgentPatch(custom, inherited);
    expect(patch).toEqual({ capabilities_mode: "custom", plugins: custom.plugins, skills: custom.skills, mcp_servers: custom.mcp_servers });
    const remote = { ...inherited, description: "Remote edit", skills: [{ path: "remote.md", enabled: false }] };
    expect(applyAgentPatch(remote, patch)).toEqual({ ...custom, description: "Remote edit" });
  });

  it("keeps a local custom toggle when the remote definition switches to inheritance", () => {
    const baseline = { ...definition, plugins: [{ id: "optional", enabled: true }], skills: [{ path: "skill.md", enabled: true }] };
    const local = { ...baseline, plugins: [{ id: "optional", enabled: false }] };
    const remote = { ...inheritAgentCapabilities(baseline), description: "Remote edit" };
    const merged = applyAgentPatch(remote, changedAgentPatch(local, baseline, remote));
    expect(merged.capabilities_mode).toBe("custom");
    expect(merged.plugins).toEqual(local.plugins);
    expect(merged.skills).toEqual(local.skills);
    expect(merged.description).toBe("Remote edit");
    expect(pluginRows(merged, inventory).find(row => row.id === "optional")?.enabled).toBe(false);
  });

  it("preserves remote edits to another category when both sessions stay custom", () => {
    const local = { ...definition, plugins: [{ id: "optional", enabled: true }] };
    const remote = { ...definition, skills: [{ path: "remote.md", enabled: true }] };
    const merged = applyAgentPatch(remote, changedAgentPatch(local, definition, remote));
    expect(merged.plugins).toEqual(local.plugins);
    expect(merged.skills).toEqual(remote.skills);
  });

  it("preserves inheritance for identity and model edits and never patches origin metadata", () => {
    const inherited = { ...inheritAgentCapabilities(definition), bundled_key: "research", customized: false };
    const edited = { ...selectAgentModel(inherited, externalModel()), name: "My researcher", instructions: "Local instructions", customized: true };
    expect(edited.capabilities_mode).toBe("inherit");
    const diff = changedAgentPatch(edited, inherited);
    expect(diff).not.toHaveProperty("capabilities_mode");
    expect(diff).not.toHaveProperty("plugins");
    for (const patch of [diff, editableAgent(edited), completeAgentPatch(edited)]) {
      expect(patch).not.toHaveProperty("bundled_key");
      expect(patch).not.toHaveProperty("customized");
    }
    expect(completeAgentPatch(edited).capabilities_mode).toBe("inherit");
    expect(completeAgentPatch(definition).capabilities_mode).toBe("custom");
    expect(changedAgentPatch({ ...definition, capabilities_mode: "custom" }, definition)).toEqual({});
  });

  it("creates agents with required capabilities on and every optional capability off", () => {
    const draft = createAgentDraft(inventory, []);
    expect(draft.plugins).toEqual([{ id: "required", enabled: true }, { id: "optional", enabled: false }]);
    expect(draft.skills).toEqual([{ path: "skill.md", enabled: false }]);
    expect(draft.mcp_servers).toEqual([{ name: "agent_control", enabled: true }]);
  });

  it("prefers the available Luna max default without changing saved definitions", () => {
    const withLuna: AgentDefinitionInventoryResult = {
      ...inventory,
      models: [
        { id: "gpt-6-astra", model_provider: "openai", supported_reasoning_efforts: ["medium", "max"], available: true, catalog_available: true, run_validation_required: false },
        { id: "gpt-5.6-luna", model_provider: "openai", supported_reasoning_efforts: ["low", "max"], available: true, catalog_available: true, run_validation_required: false }
      ],
      providers: [{ id: "openai", available: true }]
    };
    const draft = createAgentDraft(withLuna, [definition]);
    expect([draft.model_provider, draft.model, draft.reasoning_effort]).toEqual(["openai", "gpt-5.6-luna", "max"]);
    expect(definition.model).toBe("model-1");
  });

  it("creates a valid requested effort when only a run-validated external model exists", () => {
    const external = externalModel();
    const externalOnly: AgentDefinitionInventoryResult = {
      ...inventory,
      providers: [{ id: "external-profile", available: true }],
      models: [external]
    };

    const draft = createAgentDraft(externalOnly, []);

    expect([draft.model_provider, draft.model, draft.reasoning_effort]).toEqual(["external-profile", "profile-model", "medium"]);
    expect(draft.reasoning_effort.trim()).not.toBe("");
  });

  it("preserves an explicit effort when switching providers to a run-validated model", () => {
    const switched = selectAgentModel({ ...definition, reasoning_effort: "high" }, externalModel(), "external-profile");

    expect([switched.model_provider, switched.model, switched.reasoning_effort]).toEqual(["external-profile", "profile-model", "high"]);
  });

  it("preserves a non-empty effort when switching models to a run-validated alias", () => {
    const switched = selectAgentModel(definition, externalModel());

    expect([switched.model_provider, switched.model, switched.reasoning_effort]).toEqual(["external-profile", "profile-model", "medium"]);
    expect(switched.reasoning_effort.trim()).not.toBe("");
  });

  it("generates unique names using the catalog normalization rules", () => {
    expect(uniqueAgentName("Research copy", [{ ...definition, name: "  RESEARCH   COPY " }])).toBe("Research copy 2");
  });

  it("reapplies only locally changed fields over a conflicting remote definition", () => {
    const local = {
      ...definition,
      instructions: "Keep the local instructions",
      plugins: [{ id: "optional", enabled: true }]
    };
    const remote = {
      ...definition,
      description: "Description edited remotely",
      model: "remote-model"
    };

    const merged = applyAgentPatch(remote, changedAgentPatch(local, definition));

    expect(merged.instructions).toBe("Keep the local instructions");
    expect(merged.plugins).toEqual([{ id: "optional", enabled: true }]);
    expect(merged.description).toBe("Description edited remotely");
    expect(merged.model).toBe("remote-model");
  });

  it("filters capabilities without changing their full saved order", () => {
    const rows = pluginRows(definition, inventory);
    const originalOrder = rows.map(row => row.id);

    expect(filterCapabilityRows(rows, "optional").map(row => row.id)).toEqual(["optional"]);
    expect(rows.map(row => row.id)).toEqual(originalOrder);
  });
});

const definition: AgentDefinition = {
  definition_id: "definition-1",
  name: "Research",
  description: "",
  instructions: "",
  model: "model-1",
  model_provider: "provider-1",
  reasoning_effort: "medium",
  plugins: [],
  skills: [],
  mcp_servers: [],
  created_at: "2026-09-12T10:00:00Z",
  updated_at: "2026-09-12T10:00:00Z"
};

const inventory: AgentDefinitionInventoryResult = {
  inventory_revision: "inventory-1",
  refreshed_at: "2026-09-12T10:00:00Z",
  runtime: { executable: "/usr/local/bin/codex", version: "1.0.0", compatible: true },
  providers: [{ id: "provider-1", available: true }],
  models: [{ id: "model-1", model_provider: "provider-1", supported_reasoning_efforts: ["medium"], available: true, catalog_available: true, run_validation_required: false }],
  plugins: [
    { id: "required", name: "Agent Control", required: true, available: true, enabled_by_default: true, bundled_skills: [], bundled_mcp_servers: [], bundled_apps: [] },
    { id: "optional", name: "Optional", required: false, available: true, enabled_by_default: true, bundled_skills: [], bundled_mcp_servers: [], bundled_apps: [] }
  ],
  skills: [{ path: "skill.md", name: "Skill", required: false, available: true, enabled_by_default: true }],
  mcp_servers: [{ name: "agent_control", required: true, available: true, enabled_by_default: true }]
};

function externalModel(): AgentModelInventory {
  return {
    id: "profile-model",
    display_name: "Profile model",
    model_provider: "external-profile",
    supported_reasoning_efforts: [],
    available: true,
    catalog_available: false,
    run_validation_required: true
  };
}

function inventoryWithPluginChildren(): AgentDefinitionInventoryResult {
  const children = {
    bundled_skills: [{ path: "child-off.md", name: "Off", enabled_by_default: false }, { path: "child-on.md", name: "On", enabled_by_default: true }],
    bundled_mcp_servers: [{ name: "child-off", enabled_by_default: false }, { name: "child-on", enabled_by_default: true }],
    bundled_apps: [{ id: "app-off", name: "Off" }, { id: "app-on", name: "On" }]
  };
  return {
    ...inventory,
    plugins: [
      { ...inventory.plugins[0]!, ...children, enabled_by_default: false },
      inventory.plugins[1]!,
      { ...inventory.plugins[1]!, ...children, id: "disabled-plugin", enabled_by_default: false }
    ],
    mcp_servers: [...inventory.mcp_servers, { name: "optional_mcp", required: false, available: true, enabled_by_default: true }],
    apps: [{ id: "app-off", name: "Off", available: true, enabled_by_default: false }, { id: "app-on", name: "On", available: true, enabled_by_default: true }]
  };
}
