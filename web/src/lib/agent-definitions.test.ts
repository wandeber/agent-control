import { describe, expect, it } from "vitest";
import { applyAgentPatch, changedAgentPatch, createAgentDraft, filterCapabilityRows, pluginRows, selectAgentModel, uniqueAgentName, type AgentDefinition, type AgentDefinitionInventoryResult, type AgentModelInventory } from "./agent-definitions";

describe("agent definition presentation", () => {
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
