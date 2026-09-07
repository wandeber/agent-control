import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const record = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Resolve from the caller's project, never from the long-lived MCP process cwd. */
export function resolveProjectRoot(projectDir) {
    if (!projectDir)
        return null;
    if (!isAbsolute(projectDir))
        throw new Error("Project directory must be absolute.");
    const start = resolve(projectDir);
    if (!existsSync(start) || !statSync(start).isDirectory())
        throw new Error("Project directory does not exist.");
    let current = start;
    let nearest = null;
    while (true) {
        if (!nearest && existsSync(join(current, ".agents")))
            nearest = current;
        if (existsSync(join(current, ".git")))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return nearest ?? start;
        current = parent;
    }
}
export function applyProjectModels(config, projectDir) {
    if (record(config.roles))
        for (const [role, settings] of Object.entries(config.roles)) {
            if (!record(settings))
                continue;
            for (const field of ["model", "reasoning_effort"])
                if (typeof settings[field] === "string" && settings[field].includes("${"))
                    throw new Error(`roles.${role}.${field} cannot use environment interpolation; use .agents/models.toml.`);
        }
    const root = resolveProjectRoot(projectDir);
    const path = root && join(root, ".agents", "models.toml");
    if (!path || !existsSync(path))
        return structuredClone(config);
    const preferences = parse(readFileSync(path, "utf8"));
    return applyModelPreferences(config, preferences);
}
export function applyModelPreferences(config, preferences) {
    for (const key of Object.keys(preferences))
        if (key !== "hdt" && key !== "flows")
            throw new Error(`Unknown models.toml section: ${key}`);
    for (const [section, groups] of Object.entries(preferences)) {
        if (!record(groups))
            throw new Error(`models.toml ${section} must be a table.`);
        const roleGroups = section === "hdt" ? [groups] : Object.values(groups);
        for (const roles of roleGroups) {
            if (!record(roles))
                throw new Error("Model overrides must contain role tables.");
            for (const [role, override] of Object.entries(roles)) {
                if (!record(override))
                    throw new Error(`Model override ${role} must be a table.`);
                for (const [key, value] of Object.entries(override)) {
                    if (key !== "model" && key !== "reasoning_effort")
                        throw new Error(`Unsupported model override field: ${role}.${key}`);
                    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("${"))
                        throw new Error(`Invalid model override: ${role}.${key}`);
                    if (key === "reasoning_effort" && !efforts.has(value))
                        throw new Error(`Invalid reasoning effort for ${role}.`);
                }
            }
        }
    }
    const clone = structuredClone(config);
    const overrides = record(preferences.flows) ? preferences.flows[String(config.id)] : undefined;
    if (!record(overrides))
        return clone;
    const roles = record(clone.roles) ? clone.roles : {};
    for (const [role, override] of Object.entries(overrides)) {
        if (!record(roles[role]))
            throw new Error(`Unknown role ${role} for flow ${String(config.id)}.`);
        Object.assign(roles[role], override);
    }
    return clone;
}
