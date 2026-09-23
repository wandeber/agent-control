export interface PluginSelection {
  id: string;
  enabled: boolean;
  skills?: SkillSelection[];
  mcp_servers?: McpSelection[];
  apps?: Array<{ id: string; enabled: boolean }>;
}

export interface SkillSelection {
  path: string;
  enabled: boolean;
}

export interface McpSelection {
  name: string;
  enabled: boolean;
}

export interface AgentDefinition {
  definition_id: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  model_provider: string;
  reasoning_effort: string;
  skills_catalog_token_budget?: number;
  capabilities_mode?: "inherit" | "custom";
  readonly bundled_key?: string;
  readonly customized?: boolean;
  plugins: PluginSelection[];
  skills: SkillSelection[];
  mcp_servers: McpSelection[];
  created_at: string;
  updated_at: string;
}

export type AgentDefinitionEditable = Omit<AgentDefinition, "definition_id" | "created_at" | "updated_at" | "bundled_key" | "customized">;
export type AgentDefinitionPatch = Partial<Omit<AgentDefinitionEditable, "skills_catalog_token_budget">> & {
  skills_catalog_token_budget?: number | null;
};

export interface AgentCatalogResult {
  schema_version: 1;
  revision: string;
  agents: AgentDefinition[];
}

export interface AgentDefinitionGetResult {
  revision: string;
  definition: AgentDefinition;
}

export type AgentDefinitionConfigureInput =
  | { operation: "create"; expected_revision: string; patch: AgentDefinitionEditable; position?: number }
  | { operation: "update"; expected_revision: string; definition_id: string; patch: AgentDefinitionPatch; position?: number }
  | { operation: "duplicate"; expected_revision: string; source_id: string; patch: AgentDefinitionPatch; position?: number };

export interface AgentDefinitionConfigureResult {
  revision: string;
  definition: AgentDefinition;
  agents: AgentDefinition[];
}

export interface AgentDefinitionDeleteResult {
  revision: string;
  deleted_definition_id: string;
  agents: AgentDefinition[];
}

export interface AgentDefinitionLaunchInput {
  definition_id: string;
  prompt: string;
  repo_dir?: string;
}

export interface AgentDefinitionLaunchResult {
  definition_id: string;
  definition_name: string;
  catalog_revision: string;
  snapshot_hash: string;
  run_id: string;
  agent_id: string;
  state: string;
  backend: string;
  title: string;
  observer?: unknown;
  watch?: unknown;
}

interface InventoryCapabilityBase {
  icon_url?: string;
  icon_dark_url?: string;
  required: boolean;
  available: boolean;
  enabled_by_default: boolean;
}

export interface PluginInventory extends InventoryCapabilityBase {
  id: string;
  name: string;
  description?: string;
  version?: string;
  bundled_skills: Array<{ path: string; name: string; enabled_by_default?: boolean }>;
  bundled_mcp_servers: Array<{ name: string; enabled_by_default?: boolean }>;
  bundled_apps: Array<{ id: string; name: string }>;
}

export interface SkillInventory extends InventoryCapabilityBase {
  path: string;
  name: string;
  description?: string;
  scope?: string;
}

export interface McpInventory extends InventoryCapabilityBase {
  name: string;
  display_name?: string;
}

export interface AgentDefinitionInventoryResult {
  inventory_revision: string;
  refreshed_at: string;
  runtime: { executable: string; version: string; compatible: boolean; compatibility_reason?: string };
  providers: Array<{ id: string; name?: string; available: boolean }>;
  models: AgentModelInventory[];
  plugins: PluginInventory[];
  skills: SkillInventory[];
  mcp_servers: McpInventory[];
  apps?: Array<{ id: string; name: string; available: boolean; enabled_by_default: boolean }>;
}

export interface AgentModelInventory {
  id: string;
  display_name?: string;
  model_provider: string;
  supported_reasoning_efforts: string[];
  available: boolean;
  catalog_available: boolean;
  run_validation_required: boolean;
}

export interface CapabilityRow {
  id: string;
  name: string;
  description?: string;
  meta?: string;
  icon_url?: string;
  icon_dark_url?: string;
  enabled: boolean;
  required: boolean;
  available: boolean;
}

export class AgentDefinitionApiError extends Error {
  readonly reason: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, reason = "unknown", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AgentDefinitionApiError";
    this.reason = reason;
    this.details = details;
  }

  get isConflict(): boolean {
    return this.reason === "conflict" || /\bconflict\b|stale revision/i.test(this.message);
  }
}

export function editableAgent(definition: AgentDefinition): AgentDefinitionEditable {
  return {
    name: definition.name,
    description: definition.description,
    instructions: definition.instructions,
    model: definition.model,
    model_provider: definition.model_provider,
    reasoning_effort: definition.reasoning_effort,
    capabilities_mode: definition.capabilities_mode ?? "custom",
    ...(definition.skills_catalog_token_budget === undefined ? {} : { skills_catalog_token_budget: definition.skills_catalog_token_budget }),
    plugins: definition.plugins,
    skills: definition.skills,
    mcp_servers: definition.mcp_servers
  };
}

export function completeAgentPatch(definition: AgentDefinition): AgentDefinitionPatch {
  return {
    ...editableAgent(definition),
    skills_catalog_token_budget: definition.skills_catalog_token_budget ?? null
  };
}

export function changedAgentPatch(current: AgentDefinition, baseline: AgentDefinition, remote = baseline): AgentDefinitionPatch {
  const patch: AgentDefinitionPatch = {};
  if (current.name !== baseline.name) patch.name = current.name;
  if (current.description !== baseline.description) patch.description = current.description;
  if (current.instructions !== baseline.instructions) patch.instructions = current.instructions;
  if (current.model !== baseline.model) patch.model = current.model;
  if (current.model_provider !== baseline.model_provider) patch.model_provider = current.model_provider;
  if (current.reasoning_effort !== baseline.reasoning_effort) patch.reasoning_effort = current.reasoning_effort;
  if (current.skills_catalog_token_budget !== baseline.skills_catalog_token_budget) patch.skills_catalog_token_budget = current.skills_catalog_token_budget ?? null;
  const modeChanged = (current.capabilities_mode ?? "custom") !== (baseline.capabilities_mode ?? "custom");
  const capabilitiesChanged = !sameOrderedSelections(current.plugins, baseline.plugins)
    || !sameOrderedSelections(current.skills, baseline.skills)
    || !sameOrderedSelections(current.mcp_servers, baseline.mcp_servers);
  // Crossing modes requires one complete snapshot; within custom mode, preserve
  // unrelated capability categories that another session edited.
  const snapshotRequired = modeChanged || (capabilitiesChanged && (current.capabilities_mode ?? "custom") !== (remote.capabilities_mode ?? "custom"));
  if (modeChanged || capabilitiesChanged) patch.capabilities_mode = current.capabilities_mode ?? "custom";
  if (snapshotRequired || !sameOrderedSelections(current.plugins, baseline.plugins)) patch.plugins = current.plugins;
  if (snapshotRequired || !sameOrderedSelections(current.skills, baseline.skills)) patch.skills = current.skills;
  if (snapshotRequired || !sameOrderedSelections(current.mcp_servers, baseline.mcp_servers)) patch.mcp_servers = current.mcp_servers;
  return patch;
}

export function applyAgentPatch(definition: AgentDefinition, patch: AgentDefinitionPatch): AgentDefinition {
  const { skills_catalog_token_budget: budget, ...fields } = patch;
  const next = { ...definition, ...fields };
  if (budget === null) {
    delete next.skills_catalog_token_budget;
  } else if (budget !== undefined) {
    next.skills_catalog_token_budget = budget;
  }
  return next;
}

export function hasAgentPatch(patch: AgentDefinitionPatch): boolean {
  return Object.keys(patch).length > 0;
}

export function filterCapabilityRows(rows: CapabilityRow[], query: string): CapabilityRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return rows;
  return rows.filter(row => `${row.name} ${row.description ?? ""} ${row.id}`.toLocaleLowerCase().includes(needle));
}

function sameOrderedSelections(left: unknown[], right: unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function uniqueAgentName(base: string, agents: AgentDefinition[]): string {
  const used = new Set(agents.map(agent => normalizeAgentName(agent.name)));
  if (!used.has(normalizeAgentName(base))) return base;
  let suffix = 2;
  while (used.has(normalizeAgentName(`${base} ${suffix}`))) suffix += 1;
  return `${base} ${suffix}`;
}

function normalizeAgentName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("und");
}

export function createAgentDraft(inventory: AgentDefinitionInventoryResult, agents: AgentDefinition[]): AgentDefinitionEditable {
  const preferredModel = inventory.models.find(item => item.id === "gpt-6-luna" && item.model_provider === "openai" && item.available && item.supported_reasoning_efforts.includes("max"));
  const model = preferredModel ?? inventory.models.find(item => item.available);
  const provider = inventory.providers.find(item => item.id === model?.model_provider && item.available)
    ?? inventory.providers.find(item => item.available);
  return {
    name: uniqueAgentName("New agent", agents),
    description: "",
    instructions: "",
    model: model?.id ?? "",
    model_provider: model?.model_provider ?? provider?.id ?? "",
    reasoning_effort: selectReasoningEffort(model, "", "max"),
    plugins: inventory.plugins.map(item => ({ id: item.id, enabled: item.required })),
    skills: inventory.skills.map(item => ({ path: item.path, enabled: item.required })),
    mcp_servers: inventory.mcp_servers.map(item => ({ name: item.name, enabled: item.required }))
  };
}

export function selectAgentModel(definition: AgentDefinition, model: AgentModelInventory | undefined, providerId = model?.model_provider): AgentDefinition {
  if (!model || !providerId) return definition;
  return {
    ...definition,
    model: model.id,
    model_provider: providerId,
    reasoning_effort: selectReasoningEffort(model, definition.reasoning_effort, "medium")
  };
}

export function selectReasoningEffort(model: AgentModelInventory | undefined, current: string, preferred: "max" | "medium"): string {
  const currentEffort = current.trim();
  const supported = model?.supported_reasoning_efforts.filter(effort => effort.trim()) ?? [];
  if (currentEffort && (supported.includes(currentEffort) || (model?.run_validation_required && supported.length === 0))) {
    return currentEffort;
  }
  if (supported.includes(preferred)) return preferred;
  if (supported.length) return supported[0]!;
  // External/profile aliases without catalog metadata accept an explicit
  // requested effort which the selected executor validates at launch.
  if (model?.run_validation_required) return currentEffort || "medium";
  return currentEffort;
}

export function pluginRows(definition: AgentDefinition, inventory: AgentDefinitionInventoryResult): CapabilityRow[] {
  const items = new Map(inventory.plugins.map(item => [item.id, item]));
  const selections = definition.capabilities_mode === "inherit"
    ? inventory.plugins.map(item => ({ id: item.id, enabled: item.enabled_by_default }))
    : definition.plugins;
  const saved = selections.map(selection => {
    const item = items.get(selection.id);
    items.delete(selection.id);
    const bundled = item ? [
      item.bundled_skills.length ? `${item.bundled_skills.length} skill${item.bundled_skills.length === 1 ? "" : "s"}` : "",
      item.bundled_mcp_servers.length ? `${item.bundled_mcp_servers.length} MCP` : "",
      item.bundled_apps.length ? `${item.bundled_apps.length} app${item.bundled_apps.length === 1 ? "" : "s"}` : ""
    ].filter(Boolean).join(" · ") : undefined;
    return {
      id: selection.id,
      name: item?.name ?? selection.id,
      description: item?.description,
      icon_url: item?.icon_url,
      icon_dark_url: item?.icon_dark_url,
      meta: [item?.version, bundled].filter(Boolean).join(" · ") || undefined,
      enabled: item?.required ? true : selection.enabled,
      required: item?.required ?? false,
      available: item?.available ?? false
    };
  });
  return [...saved, ...[...items.values()].map(item => ({
    id: item.id,
    name: item.name,
    description: item.description,
    icon_url: item.icon_url,
    icon_dark_url: item.icon_dark_url,
    meta: item.version,
    enabled: item.required,
    required: item.required,
    available: item.available
  }))];
}

export function skillRows(definition: AgentDefinition, inventory: AgentDefinitionInventoryResult): CapabilityRow[] {
  return mergeRows(
    definition.capabilities_mode === "inherit"
      ? inventory.skills.map(item => ({ id: item.path, enabled: item.enabled_by_default }))
      : definition.skills.map(item => ({ id: item.path, enabled: item.enabled })),
    inventory.skills.map(item => ({ id: item.path, name: item.name, description: item.description, icon_url: item.icon_url, icon_dark_url: item.icon_dark_url, meta: item.scope, required: item.required, available: item.available }))
  );
}

export function mcpRows(definition: AgentDefinition, inventory: AgentDefinitionInventoryResult): CapabilityRow[] {
  return mergeRows(
    definition.capabilities_mode === "inherit"
      ? inventory.mcp_servers.map(item => ({ id: item.name, enabled: item.enabled_by_default }))
      : definition.mcp_servers.map(item => ({ id: item.name, enabled: item.enabled })),
    inventory.mcp_servers.map(item => ({ id: item.name, name: item.display_name ?? item.name, icon_url: item.icon_url, icon_dark_url: item.icon_dark_url, required: item.required, available: item.available }))
  );
}

function mergeRows(
  saved: Array<{ id: string; enabled: boolean }>,
  inventory: Array<Omit<CapabilityRow, "enabled">>
): CapabilityRow[] {
  const items = new Map(inventory.map(item => [item.id, item]));
  const rows = saved.map(selection => {
    const item = items.get(selection.id);
    items.delete(selection.id);
    return {
      id: selection.id,
      name: item?.name ?? selection.id,
      description: item?.description,
      meta: item?.meta,
      icon_url: item?.icon_url,
      icon_dark_url: item?.icon_dark_url,
      enabled: item?.required ? true : selection.enabled,
      required: item?.required ?? false,
      available: item?.available ?? false
    };
  });
  return [...rows, ...[...items.values()].map(item => ({ ...item, enabled: item.required }))];
}

export function capabilitySelections(kind: "plugins" | "skills" | "mcp_servers", rows: CapabilityRow[]): PluginSelection[] | SkillSelection[] | McpSelection[] {
  if (kind === "plugins") return rows.map(row => ({ id: row.id, enabled: row.required || row.enabled }));
  if (kind === "skills") return rows.map(row => ({ path: row.id, enabled: row.required || row.enabled }));
  return rows.map(row => ({ name: row.id, enabled: row.required || row.enabled }));
}

export function inheritAgentCapabilities(definition: AgentDefinition): AgentDefinition {
  return { ...definition, capabilities_mode: "inherit", plugins: [], skills: [], mcp_servers: [] };
}

function inheritedPluginSelections(inventory: AgentDefinitionInventoryResult): PluginSelection[] {
  const apps = new Map(inventory.apps?.map(app => [app.id, app]));
  return inventory.plugins.map(plugin => {
    const selection: PluginSelection = { id: plugin.id, enabled: plugin.required || plugin.enabled_by_default };
    // Disabled plugins retain normal defaults when enabled later. Only freeze
    // child overrides for plugins whose inherited capabilities are active now.
    if (!selection.enabled) return selection;
    if (plugin.bundled_skills.length) selection.skills = plugin.bundled_skills.map(skill => ({ path: skill.path, enabled: skill.enabled_by_default ?? true }));
    if (plugin.bundled_mcp_servers.length) selection.mcp_servers = plugin.bundled_mcp_servers.map(server => ({ name: server.name, enabled: server.enabled_by_default ?? true }));
    if (plugin.bundled_apps.length) selection.apps = plugin.bundled_apps.map(app => ({ id: app.id, enabled: apps.get(app.id)?.enabled_by_default ?? true }));
    return selection;
  });
}

export function replaceAgentCapabilities(
  definition: AgentDefinition,
  inventory: AgentDefinitionInventoryResult,
  kind: "plugins" | "skills" | "mcp_servers",
  rows: CapabilityRow[]
): AgentDefinition {
  // A first toggle or reorder freezes the entire inherited inventory so the
  // untouched categories retain their effective enablement and order.
  const next = definition.capabilities_mode === "inherit" ? {
    ...definition,
    capabilities_mode: "custom" as const,
    plugins: inheritedPluginSelections(inventory),
    skills: capabilitySelections("skills", skillRows(definition, inventory)) as SkillSelection[],
    mcp_servers: capabilitySelections("mcp_servers", mcpRows(definition, inventory)) as McpSelection[]
  } : definition;
  const selections = capabilitySelections(kind, rows);
  if (kind === "plugins") {
    const previous = new Map(next.plugins.map(plugin => [plugin.id, plugin]));
    return { ...next, plugins: (selections as PluginSelection[]).map(plugin => ({ ...previous.get(plugin.id), ...plugin })) };
  }
  if (kind === "skills") return { ...next, skills: selections as SkillSelection[] };
  return { ...next, mcp_servers: selections as McpSelection[] };
}
