import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ControllerError } from "./errors.js";
import { agentDefinitionCatalogPath } from "./paths.js";
export const REQUIRED_AGENT_CONTROL_PLUGIN = "agent-control@agent-control";
export const REQUIRED_AGENT_CONTROL_MCP = "agent_control";
export const pluginSelectionSchema = z.object({ id: z.string().min(1), enabled: z.boolean() }).strict();
export const skillSelectionSchema = z.object({ path: z.string().min(1), enabled: z.boolean() }).strict();
export const mcpSelectionSchema = z.object({ name: z.string().min(1), enabled: z.boolean() }).strict();
export const agentDefinitionSchema = z.object({
    definition_id: z.string().uuid(),
    name: z.string().min(1),
    description: z.string(),
    instructions: z.string(),
    model: z.string().min(1),
    model_provider: z.string().min(1),
    reasoning_effort: z.string().min(1),
    skills_catalog_token_budget: z.number().int().min(1).max(10_000).optional(),
    plugins: z.array(pluginSelectionSchema),
    skills: z.array(skillSelectionSchema),
    mcp_servers: z.array(mcpSelectionSchema),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime()
}).strict();
export const editableDefinitionSchema = agentDefinitionSchema.omit({
    definition_id: true,
    created_at: true,
    updated_at: true
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
    agents: z.array(agentDefinitionSchema)
}).strict();
const EMPTY_CATALOG_BYTES = Buffer.from(`${JSON.stringify({ schema_version: 1, agents: [] }, null, 2)}\n`);
export function normalizeAgentDefinitionName(value) {
    return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
export class AgentDefinitionCatalog {
    path;
    constructor(path = agentDefinitionCatalogPath()) {
        this.path = path;
    }
    list() {
        const { bytes, document } = this.readDocument();
        return { ...document, revision: digest(bytes) };
    }
    get(reference) {
        if (Boolean(reference.definitionId) === Boolean(reference.name)) {
            throw new ControllerError("Provide exactly one of definition_id or name.", "validation");
        }
        const catalog = this.list();
        const definition = reference.definitionId
            ? catalog.agents.find((entry) => entry.definition_id === reference.definitionId)
            : catalog.agents.find((entry) => normalizeAgentDefinitionName(entry.name) === normalizeAgentDefinitionName(reference.name));
        if (!definition) {
            throw new ControllerError("Configured agent definition was not found.", "not_found", {
                ...(reference.definitionId ? { definition_id: reference.definitionId } : { name: reference.name })
            });
        }
        return { revision: catalog.revision, definition };
    }
    configure(rawInput) {
        const input = parseOrValidation(configureAgentDefinitionSchema, rawInput);
        return this.withWriteLock(() => {
            const current = this.list();
            assertRevision(input.expected_revision, current.revision);
            const agents = [...current.agents];
            const now = new Date().toISOString();
            let definition;
            if (input.operation === "create") {
                definition = normalizeDefinition({
                    ...input.patch,
                    definition_id: randomUUID(),
                    created_at: now,
                    updated_at: now
                });
                assertPosition(input.position, agents.length, true);
                agents.splice(input.position ?? agents.length, 0, definition);
            }
            else {
                const referenceId = input.operation === "duplicate" ? input.source_id : input.definition_id;
                const sourceIndex = agents.findIndex((entry) => entry.definition_id === referenceId);
                if (sourceIndex < 0) {
                    throw new ControllerError("Configured agent definition was not found.", "not_found", {
                        definition_id: referenceId
                    });
                }
                const source = agents[sourceIndex];
                if (input.operation === "duplicate") {
                    const patched = applyPatch(source, input.patch);
                    definition = normalizeDefinition({
                        ...patched,
                        definition_id: randomUUID(),
                        created_at: now,
                        updated_at: now
                    });
                    assertPosition(input.position, agents.length, true);
                    agents.splice(input.position ?? sourceIndex + 1, 0, definition);
                }
                else {
                    definition = normalizeDefinition({
                        ...applyPatch(source, input.patch),
                        definition_id: source.definition_id,
                        created_at: source.created_at,
                        updated_at: now
                    });
                    agents[sourceIndex] = definition;
                    if (input.position !== undefined) {
                        assertPosition(input.position, agents.length - 1, true);
                        agents.splice(sourceIndex, 1);
                        agents.splice(input.position, 0, definition);
                    }
                }
            }
            validateCatalogSemantics(agents);
            const written = this.writeDocument({ schema_version: 1, agents });
            return { revision: written.revision, definition, agents: written.agents };
        });
    }
    delete(rawInput) {
        const input = parseOrValidation(deleteAgentDefinitionSchema, rawInput);
        return this.withWriteLock(() => {
            const current = this.list();
            assertRevision(input.expected_revision, current.revision);
            const index = current.agents.findIndex((entry) => entry.definition_id === input.definition_id);
            if (index < 0) {
                throw new ControllerError("Configured agent definition was not found.", "not_found", {
                    definition_id: input.definition_id
                });
            }
            const agents = [...current.agents];
            agents.splice(index, 1);
            const written = this.writeDocument({ schema_version: 1, agents });
            return { revision: written.revision, deleted_definition_id: input.definition_id, agents: written.agents };
        });
    }
    readDocument() {
        if (!existsSync(this.path)) {
            return { bytes: EMPTY_CATALOG_BYTES, document: { schema_version: 1, agents: [] } };
        }
        const bytes = readFileSync(this.path);
        try {
            const document = catalogSchema.parse(JSON.parse(bytes.toString("utf8")));
            validateCatalogSemantics(document.agents);
            return { bytes, document };
        }
        catch (error) {
            throw new ControllerError("The configured agent catalog is invalid and was left unchanged.", "validation", {
                path: this.path,
                issue: error instanceof Error ? error.message : String(error)
            });
        }
    }
    writeDocument(document) {
        const validated = catalogSchema.parse(document);
        validateCatalogSemantics(validated.agents);
        const bytes = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`);
        const directory = dirname(this.path);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        let descriptor;
        try {
            descriptor = openSync(temporary, "wx", 0o600);
            writeFileSync(descriptor, bytes);
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = undefined;
            renameSync(temporary, this.path);
            chmodSync(this.path, 0o600);
            const directoryDescriptor = openSync(directory, "r");
            try {
                fsyncSync(directoryDescriptor);
            }
            finally {
                closeSync(directoryDescriptor);
            }
        }
        catch (error) {
            if (descriptor !== undefined)
                closeSync(descriptor);
            if (existsSync(temporary))
                unlinkSync(temporary);
            throw error;
        }
        return { ...validated, revision: digest(bytes) };
    }
    withWriteLock(operation) {
        const directory = dirname(this.path);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const lock = new Database(`${this.path}.lock.sqlite`);
        try {
            lock.pragma("busy_timeout = 5000");
            lock.exec("BEGIN IMMEDIATE");
            const result = operation();
            lock.exec("COMMIT");
            return result;
        }
        catch (error) {
            if (lock.inTransaction)
                lock.exec("ROLLBACK");
            throw error;
        }
        finally {
            lock.close();
        }
    }
}
function applyPatch(source, patch) {
    const next = { ...source, ...patch };
    if (patch.skills_catalog_token_budget === null)
        delete next.skills_catalog_token_budget;
    return next;
}
function normalizeDefinition(definition) {
    return parseOrValidation(agentDefinitionSchema, {
        ...definition,
        name: definition.name.normalize("NFKC").trim().replace(/\s+/gu, " "),
        plugins: ensureRequired(definition.plugins, "id", REQUIRED_AGENT_CONTROL_PLUGIN),
        skills: uniqueSelections(definition.skills, "path"),
        mcp_servers: ensureRequired(definition.mcp_servers, "name", REQUIRED_AGENT_CONTROL_MCP)
    });
}
function ensureRequired(items, key, required) {
    const normalized = uniqueSelections(items, key);
    const index = normalized.findIndex((item) => item[key] === required);
    if (index < 0)
        return [{ [key]: required, enabled: true }, ...normalized];
    normalized[index] = { ...normalized[index], enabled: true };
    return normalized;
}
function uniqueSelections(items, key) {
    const seen = new Set();
    return items.filter((item) => {
        if (seen.has(item[key]))
            throw new ControllerError(`Duplicate capability entry: ${String(item[key])}.`, "validation");
        seen.add(item[key]);
        return true;
    });
}
function validateCatalogSemantics(agents) {
    const ids = new Set();
    const names = new Set();
    for (const agent of agents) {
        if (ids.has(agent.definition_id))
            throw new ControllerError(`Duplicate definition_id: ${agent.definition_id}.`, "validation");
        ids.add(agent.definition_id);
        const name = normalizeAgentDefinitionName(agent.name);
        if (!name)
            throw new ControllerError("Configured agent names cannot be blank.", "validation");
        if (names.has(name))
            throw new ControllerError(`Configured agent name already exists: ${agent.name}.`, "validation");
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
function assertPosition(position, maximum, allowMaximum) {
    if (position === undefined)
        return;
    if (position < 0 || position > maximum || (!allowMaximum && position === maximum)) {
        throw new ControllerError(`Catalog position ${position} is out of range.`, "validation", { position, maximum });
    }
}
function assertRevision(expected, current) {
    if (expected !== current) {
        throw new ControllerError("Configured agent catalog revision conflict.", "conflict", {
            current_revision: current
        });
    }
}
function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function parseOrValidation(schema, input) {
    try {
        return schema.parse(input);
    }
    catch (error) {
        throw new ControllerError("Configured agent input is invalid.", "validation", {
            issue: error instanceof Error ? error.message : String(error)
        });
    }
}
