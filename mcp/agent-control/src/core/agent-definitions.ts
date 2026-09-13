import Database from "../storage/database.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ControllerError } from "./errors.js";
import { agentDefinitionCatalogPath } from "./paths.js";

export const REQUIRED_AGENT_CONTROL_PLUGIN = "agent-control@agent-control";
export const REQUIRED_AGENT_CONTROL_MCP = "agent_control";

export const skillSelectionSchema = z.object({ path: z.string().min(1), enabled: z.boolean() }).strict();
export const mcpSelectionSchema = z.object({ name: z.string().min(1), enabled: z.boolean() }).strict();
export const appSelectionSchema = z.object({ id: z.string().min(1), enabled: z.boolean() }).strict();
export const pluginSelectionSchema = z.object({
  id: z.string().min(1), enabled: z.boolean(),
  skills: z.array(skillSelectionSchema).optional(),
  mcp_servers: z.array(mcpSelectionSchema).optional(),
  apps: z.array(appSelectionSchema).optional()
}).strict();

export const agentDefinitionSchema = z.object({
  definition_id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string(),
  instructions: z.string(),
  model: z.string().min(1),
  model_provider: z.string().min(1),
  reasoning_effort: z.string().min(1),
  capabilities_mode: z.enum(["inherit", "custom"]).optional(),
  skills_catalog_token_budget: z.number().int().min(1).max(10_000).optional(),
  plugins: z.array(pluginSelectionSchema),
  skills: z.array(skillSelectionSchema),
  mcp_servers: z.array(mcpSelectionSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  bundled_key: z.string().optional(),
  customized: z.boolean().optional()
}).strict();

export const editableDefinitionSchema = agentDefinitionSchema.omit({
  definition_id: true,
  created_at: true,
  updated_at: true,
  bundled_key: true,
  customized: true
});
export const definitionPatchSchema = editableDefinitionSchema.partial().extend({
  skills_catalog_token_budget: z.number().int().min(1).max(10_000).nullable().optional()
}).strict();

export const configureAgentDefinitionSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    expected_revision: z.string().length(64),
    patch: editableDefinitionSchema,
    position: z.number().int().nonnegative().optional()
  }).strict(),
  z.object({
    operation: z.literal("update"),
    expected_revision: z.string().length(64),
    definition_id: z.string().uuid(),
    patch: definitionPatchSchema,
    position: z.number().int().nonnegative().optional()
  }).strict(),
  z.object({
    operation: z.literal("duplicate"),
    expected_revision: z.string().length(64),
    source_id: z.string().uuid(),
    patch: definitionPatchSchema,
    position: z.number().int().nonnegative().optional()
  }).strict()
]);

export const deleteAgentDefinitionSchema = z.object({
  definition_id: z.string().uuid(),
  expected_revision: z.string().length(64)
}).strict();

const catalogSchema = z.object({
  schema_version: z.literal(1),
  agents: z.array(agentDefinitionSchema),
  bundled_overrides: z.record(z.object({ patch: definitionPatchSchema, updated_at: z.string().datetime() }).strict()).optional()
}).strict();

const bundledCatalogSchema = z.object({
  schema_version: z.literal(1),
  updated_at: z.string().datetime(),
  agents: z.array(z.object({
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    definition_id: z.string().uuid(),
    name: z.string().min(1),
    description: z.string(),
    model: z.string().min(1),
    model_provider: z.string().min(1),
    reasoning_effort: z.string().min(1),
    instructions_path: z.string().min(1)
  }).strict())
}).strict();

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentDefinitionEditable = z.infer<typeof editableDefinitionSchema>;
export type AgentDefinitionPatch = z.infer<typeof definitionPatchSchema>;
export type ConfigureAgentDefinitionInput = z.infer<typeof configureAgentDefinitionSchema>;
export type DeleteAgentDefinitionInput = z.infer<typeof deleteAgentDefinitionSchema>;
export type AgentDefinitionCatalogDocument = z.infer<typeof catalogSchema>;

export interface AgentDefinitionCatalogResult {
  schema_version: 1;
  agents: AgentDefinition[];
  revision: string;
}

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

const EMPTY_CATALOG_BYTES = Buffer.from(`${JSON.stringify({ schema_version: 1, agents: [] }, null, 2)}\n`);

export function normalizeAgentDefinitionName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export class AgentDefinitionCatalog {
  constructor(
    readonly path = agentDefinitionCatalogPath(),
    readonly bundledRoot: string | null = resolve(fileURLToPath(new URL("../../../../agents", import.meta.url)))
  ) {}

  list(): AgentDefinitionCatalogResult {
    const { bytes, document } = this.readDocument();
    const bundled = this.readBundled();
    const agents = [...bundled.map(definition => {
      const override = document.bundled_overrides?.[definition.definition_id];
      return { ...(override ? normalizeDefinition({ ...applyPatch(definition, override.patch), updated_at: override.updated_at }) : definition), customized: Boolean(override) };
    }), ...document.agents];
    validateCatalogSemantics(agents, false);
    return { schema_version: 1, agents, revision: bundled.length ? digest(Buffer.concat([bytes, Buffer.from(JSON.stringify(bundled))])) : digest(bytes) };
  }

  /** Flows use stable bundled keys or definition IDs; display names remain editable. */
  resolve(reference: string): { revision: string; definition: AgentDefinition } {
    const catalog = this.list();
    const definition = catalog.agents.find(agent => agent.definition_id === reference || agent.bundled_key === reference);
    if (!definition) throw new ControllerError(`Configured agent reference was not found: ${reference}.`, "not_found");
    return { revision: catalog.revision, definition };
  }

  get(reference: { definitionId?: string; name?: string }): { revision: string; definition: AgentDefinition } {
    if (Boolean(reference.definitionId) === Boolean(reference.name)) {
      throw new ControllerError("Provide exactly one of definition_id or name.", "validation");
    }
    const catalog = this.list();
    const matches = reference.definitionId
      ? catalog.agents.filter((entry) => entry.definition_id === reference.definitionId)
      : catalog.agents.filter((entry) => normalizeAgentDefinitionName(entry.name) === normalizeAgentDefinitionName(reference.name!));
    if (matches.length > 1) throw new ControllerError("Configured agent name is ambiguous; use definition_id.", "validation", { definition_ids: matches.map(entry => entry.definition_id) });
    const definition = matches[0];
    if (!definition) {
      throw new ControllerError("Configured agent definition was not found.", "not_found", {
        ...(reference.definitionId ? { definition_id: reference.definitionId } : { name: reference.name })
      });
    }
    return { revision: catalog.revision, definition };
  }

  configure(rawInput: ConfigureAgentDefinitionInput): AgentDefinitionConfigureResult {
    const input = parseOrValidation(configureAgentDefinitionSchema, rawInput);
    return this.withWriteLock(() => {
      const current = this.list();
      assertRevision(input.expected_revision, current.revision);
      const document = this.readDocument().document;
      const agents = [...document.agents];
      const overrides = { ...document.bundled_overrides };
      const now = new Date().toISOString();
      let definition: AgentDefinition;
      if (input.operation === "create") {
        definition = normalizeDefinition({
          ...input.patch,
          definition_id: randomUUID(),
          created_at: now,
          updated_at: now
        });
        assertPosition(input.position, agents.length, true);
        agents.splice(input.position ?? agents.length, 0, definition);
      } else {
        const referenceId = input.operation === "duplicate" ? input.source_id : input.definition_id;
        const sourceIndex = agents.findIndex((entry) => entry.definition_id === referenceId);
        const source = current.agents.find(entry => entry.definition_id === referenceId);
        if (!source) {
          throw new ControllerError("Configured agent definition was not found.", "not_found", {
            definition_id: referenceId
          });
        }
        assertCapabilityTransition(source, input.patch);
        if (input.operation === "duplicate") {
          const patched = applyPatch(source, input.patch);
          definition = normalizeDefinition({
            ...patched,
            definition_id: randomUUID(),
            bundled_key: undefined,
            customized: undefined,
            created_at: now,
            updated_at: now
          });
          assertPosition(input.position, agents.length, true);
          agents.splice(input.position ?? (sourceIndex < 0 ? agents.length : sourceIndex + 1), 0, definition);
        } else {
          definition = normalizeDefinition({
            ...applyPatch(source, input.patch),
            definition_id: source.definition_id,
            created_at: source.created_at,
            updated_at: now
          });
          if (source.bundled_key) {
            if (input.position !== undefined) throw new ControllerError("Bundled agents cannot be reordered; order their capabilities instead.", "validation");
            // Store only the user's choices so new bundled instructions and defaults
            // remain visible unless that specific field was customized.
            const base = this.readBundled().find(entry => entry.definition_id === source.definition_id)!;
            const patch = bundledDifference(base, definition);
            if (Object.keys(patch).length) overrides[source.definition_id] = { patch, updated_at: now };
            else delete overrides[source.definition_id];
          } else agents[sourceIndex] = definition;
          if (!source.bundled_key && input.position !== undefined) {
            assertPosition(input.position, agents.length - 1, true);
            agents.splice(sourceIndex, 1);
            agents.splice(input.position, 0, definition);
          }
        }
      }
      validateCatalogSemantics(agents);
      const bundled = this.readBundled().map(entry => {
        const override = overrides[entry.definition_id];
        return override ? normalizeDefinition({ ...applyPatch(entry, override.patch), updated_at: override.updated_at }) : entry;
      });
      const nameChanged = input.operation !== "update" || input.patch.name !== undefined && current.agents.find(entry => entry.definition_id === definition.definition_id)?.name !== definition.name;
      if (nameChanged && [...bundled, ...agents].some(entry => entry.definition_id !== definition.definition_id && normalizeAgentDefinitionName(entry.name) === normalizeAgentDefinitionName(definition.name))) {
        throw new ControllerError(`Configured agent name already exists: ${definition.name}.`, "validation");
      }
      validateCatalogSemantics([...bundled, ...agents], false);
      this.writeDocument({ schema_version: 1, agents, ...(Object.keys(overrides).length ? { bundled_overrides: overrides } : {}) });
      const written = this.list();
      return { revision: written.revision, definition: written.agents.find(entry => entry.definition_id === definition.definition_id)!, agents: written.agents };
    });
  }

  delete(rawInput: DeleteAgentDefinitionInput): AgentDefinitionDeleteResult {
    const input = parseOrValidation(deleteAgentDefinitionSchema, rawInput);
    return this.withWriteLock(() => {
      const current = this.list();
      assertRevision(input.expected_revision, current.revision);
      if (current.agents.some(entry => entry.definition_id === input.definition_id && entry.bundled_key)) {
        throw new ControllerError("Bundled agents cannot be deleted. Customize or duplicate the agent instead.", "validation");
      }
      const document = this.readDocument().document;
      const index = document.agents.findIndex((entry) => entry.definition_id === input.definition_id);
      if (index < 0) {
        throw new ControllerError("Configured agent definition was not found.", "not_found", {
          definition_id: input.definition_id
        });
      }
      const agents = [...document.agents];
      agents.splice(index, 1);
      this.writeDocument({ ...document, agents });
      const written = this.list();
      return { revision: written.revision, deleted_definition_id: input.definition_id, agents: written.agents };
    });
  }

  private readBundled(): AgentDefinition[] {
    if (!this.bundledRoot) return [];
    const path = resolve(this.bundledRoot, "catalog.json");
    const source = bundledCatalogSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (new Set(source.agents.map(entry => entry.key)).size !== source.agents.length) throw new ControllerError("Bundled agent keys must be unique.", "validation");
    return source.agents.map(entry => {
      const instructionPath = resolve(this.bundledRoot!, entry.instructions_path);
      const localPath = relative(this.bundledRoot!, instructionPath);
      if (isAbsolute(localPath) || localPath === ".." || localPath.startsWith("../") || !instructionPath.endsWith(".md")) {
        throw new ControllerError("Bundled agent instructions must be Markdown inside its catalog.", "validation");
      }
      const { key, instructions_path: _, ...fields } = entry;
      return normalizeDefinition({ ...fields, instructions: readFileSync(instructionPath, "utf8"),
        capabilities_mode: "inherit", plugins: [], skills: [], mcp_servers: [],
        created_at: source.updated_at, updated_at: source.updated_at, bundled_key: key });
    });
  }

  private readDocument(): { bytes: Buffer; document: AgentDefinitionCatalogDocument } {
    if (!existsSync(this.path)) {
      return { bytes: EMPTY_CATALOG_BYTES, document: { schema_version: 1, agents: [] } };
    }
    const bytes = readFileSync(this.path);
    try {
      const document = catalogSchema.parse(JSON.parse(bytes.toString("utf8")));
      validateCatalogSemantics(document.agents);
      return { bytes, document };
    } catch (error) {
      throw new ControllerError("The configured agent catalog is invalid and was left unchanged.", "validation", {
        path: this.path,
        issue: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private writeDocument(document: AgentDefinitionCatalogDocument): void {
    const validated = catalogSchema.parse(document);
    validateCatalogSemantics(validated.agents);
    const bytes = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`);
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }

  private withWriteLock<T>(operation: () => T): T {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = new Database(`${this.path}.lock.sqlite`);
    try {
      lock.pragma("busy_timeout = 5000");
      lock.exec("BEGIN IMMEDIATE");
      const result = operation();
      lock.exec("COMMIT");
      return result;
    } catch (error) {
      if (lock.inTransaction) lock.exec("ROLLBACK");
      throw error;
    } finally {
      lock.close();
    }
  }
}

function assertCapabilityTransition(source: AgentDefinition, patch: AgentDefinitionPatch): void {
  const changesSelection = (["plugins", "skills", "mcp_servers"] as const).some(key => patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(source[key]));
  if (source.capabilities_mode === "inherit" && changesSelection && patch.capabilities_mode === undefined) {
    throw new ControllerError("To customize inherited capabilities, set capabilities_mode to custom and supply all three capability lists from the current inventory.", "validation");
  }
  if (source.capabilities_mode === "inherit" && patch.capabilities_mode === "custom" && (!patch.plugins || !patch.skills || !patch.mcp_servers)) {
    throw new ControllerError("Switching from inherited capabilities requires plugins, skills, and mcp_servers together.", "validation");
  }
}

function applyPatch(source: AgentDefinition, patch: AgentDefinitionPatch): AgentDefinition {
  const next = { ...source, ...patch } as AgentDefinition;
  if (patch.skills_catalog_token_budget === null) delete next.skills_catalog_token_budget;
  return next;
}

function bundledDifference(base: AgentDefinition, customized: AgentDefinition): AgentDefinitionPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(editableDefinitionSchema.shape) as Array<keyof AgentDefinitionEditable>) {
    if (JSON.stringify(base[key]) !== JSON.stringify(customized[key])) patch[key] = customized[key] ?? null;
  }
  return definitionPatchSchema.parse(patch);
}

function normalizeDefinition(definition: AgentDefinition): AgentDefinition {
  return parseOrValidation(agentDefinitionSchema, {
    ...definition,
    name: definition.name.normalize("NFKC").trim().replace(/\s+/gu, " "),
    plugins: ensureRequired(definition.plugins.map(plugin => ({ ...plugin,
      ...(plugin.skills ? { skills: uniqueSelections(plugin.skills, "path") } : {}),
      ...(plugin.mcp_servers ? { mcp_servers: uniqueSelections(plugin.mcp_servers, "name") } : {}),
      ...(plugin.apps ? { apps: uniqueSelections(plugin.apps, "id") } : {})
    })), "id", REQUIRED_AGENT_CONTROL_PLUGIN),
    skills: uniqueSelections(definition.skills, "path"),
    mcp_servers: ensureRequired(definition.mcp_servers, "name", REQUIRED_AGENT_CONTROL_MCP)
  });
}

function ensureRequired<T extends { enabled: boolean }>(items: T[], key: keyof T, required: string): T[] {
  const normalized = uniqueSelections(items, key);
  const index = normalized.findIndex((item) => item[key] === required);
  if (index < 0) return [{ [key]: required, enabled: true } as T, ...normalized];
  normalized[index] = { ...normalized[index]!, enabled: true };
  return normalized;
}

function uniqueSelections<T>(items: T[], key: keyof T): T[] {
  const seen = new Set<unknown>();
  return items.filter((item) => {
    if (seen.has(item[key])) throw new ControllerError(`Duplicate capability entry: ${String(item[key])}.`, "validation");
    seen.add(item[key]);
    return true;
  });
}

function validateCatalogSemantics(agents: AgentDefinition[], uniqueNames = true): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.definition_id)) throw new ControllerError(`Duplicate definition_id: ${agent.definition_id}.`, "validation");
    ids.add(agent.definition_id);
    const name = normalizeAgentDefinitionName(agent.name);
    if (!name) throw new ControllerError("Configured agent names cannot be blank.", "validation");
    if (uniqueNames && names.has(name)) throw new ControllerError(`Configured agent name already exists: ${agent.name}.`, "validation");
    names.add(name);
    uniqueSelections(agent.plugins, "id");
    uniqueSelections(agent.skills, "path");
    uniqueSelections(agent.mcp_servers, "name");
    if (!agent.plugins.some((item) => item.id === REQUIRED_AGENT_CONTROL_PLUGIN && item.enabled)) {
      throw new ControllerError(`Required plugin ${REQUIRED_AGENT_CONTROL_PLUGIN} must be enabled.`, "validation");
    }
    if (!agent.mcp_servers.some((item) => item.name === REQUIRED_AGENT_CONTROL_MCP && item.enabled)) {
      throw new ControllerError(`Required MCP ${REQUIRED_AGENT_CONTROL_MCP} must be enabled.`, "validation");
    }
  }
}

function assertPosition(position: number | undefined, maximum: number, allowMaximum: boolean): void {
  if (position === undefined) return;
  if (position < 0 || position > maximum || (!allowMaximum && position === maximum)) {
    throw new ControllerError(`Catalog position ${position} is out of range.`, "validation", { position, maximum });
  }
}

function assertRevision(expected: string, current: string): void {
  if (expected !== current) {
    throw new ControllerError("Configured agent catalog revision conflict.", "conflict", {
      current_revision: current
    });
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseOrValidation<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    throw new ControllerError("Configured agent input is invalid.", "validation", {
      issue: error instanceof Error ? error.message : String(error)
    });
  }
}
