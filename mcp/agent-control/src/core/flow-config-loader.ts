import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type FlowConfigSourceFormat = "auto" | "json" | "yaml";

export interface ParseFlowConfigTextOptions {
  format?: FlowConfigSourceFormat;
  sourcePath?: string | null;
  env?: NodeJS.ProcessEnv;
}

const ENV_REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-)([^}]*))?\}/g;

export function loadFlowConfigFile(
  path: string,
  options: Omit<ParseFlowConfigTextOptions, "sourcePath"> = {}
): Record<string, unknown> {
  const config = parseFlowConfigText(readFileSync(path, "utf8"), {
    ...options,
    sourcePath: path
  });
  validatePromptFileReferences(config, path);
  return absolutizePromptFileReferences(config, path);
}

export function parseFlowConfigText(
  text: string,
  options: ParseFlowConfigTextOptions = {}
): Record<string, unknown> {
  const parsed = parseConfigText(text, resolveFormat(options.format ?? "auto", options.sourcePath));
  const expanded = expandEnvironmentReferences(parsed, options.env ?? process.env);
  if (!expanded || typeof expanded !== "object" || Array.isArray(expanded)) {
    throw new Error("Expected a flow config object.");
  }
  return expanded as Record<string, unknown>;
}

export function expandEnvironmentReferences(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === "string") {
    return expandEnvironmentString(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnvironmentReferences(item, env));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, expandEnvironmentReferences(child, env)])
    );
  }
  return value;
}

export function validatePromptFileReferences(config: Record<string, unknown>, sourcePath: string): void {
  const baseDir = dirname(resolve(sourcePath));
  const missing: string[] = [];
  const prompts = isRecord(config.prompts) ? config.prompts : {};
  for (const [promptId, prompt] of Object.entries(prompts)) {
    if (isRecord(prompt) && typeof prompt.path === "string") {
      validatePromptFilePath(baseDir, `prompts.${promptId}.path`, prompt.path, missing);
    }
  }
  for (const [roleId, role] of Object.entries(isRecord(config.roles) ? config.roles : {})) {
    if (isRecord(role) && typeof role.prompt_path === "string") {
      validatePromptFilePath(baseDir, `roles.${roleId}.prompt_path`, role.prompt_path, missing);
    }
  }
  for (const [stepId, step] of Object.entries(isRecord(config.steps) ? config.steps : {})) {
    if (isRecord(step) && typeof step.prompt_path === "string") {
      validatePromptFilePath(baseDir, `steps.${stepId}.prompt_path`, step.prompt_path, missing);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Flow config references missing prompt files:\n${missing.join("\n")}`);
  }
}

function resolveFormat(format: FlowConfigSourceFormat, sourcePath?: string | null): Exclude<FlowConfigSourceFormat, "auto"> {
  if (format !== "auto") {
    return format;
  }
  const extension = sourcePath ? extname(sourcePath).toLowerCase() : "";
  return extension === ".json" ? "json" : "yaml";
}

function parseConfigText(text: string, format: Exclude<FlowConfigSourceFormat, "auto">): unknown {
  if (format === "json") {
    return JSON.parse(text) as unknown;
  }
  return parseYaml(text) as unknown;
}

function validatePromptFilePath(baseDir: string, owner: string, promptPath: string, missing: string[]): void {
  const resolved = resolve(baseDir, promptPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    missing.push(`${owner}: ${promptPath}`);
  }
}

function absolutizePromptFileReferences(config: Record<string, unknown>, sourcePath: string): Record<string, unknown> {
  const baseDir = dirname(resolve(sourcePath));
  const clone = structuredClone(config) as Record<string, unknown>;
  for (const prompt of Object.values(isRecord(clone.prompts) ? clone.prompts : {})) {
    if (isRecord(prompt) && typeof prompt.path === "string") {
      prompt.path = resolve(baseDir, prompt.path);
    }
  }
  for (const role of Object.values(isRecord(clone.roles) ? clone.roles : {})) {
    if (isRecord(role) && typeof role.prompt_path === "string") {
      role.prompt_path = resolve(baseDir, role.prompt_path);
    }
  }
  for (const step of Object.values(isRecord(clone.steps) ? clone.steps : {})) {
    if (isRecord(step) && typeof step.prompt_path === "string") {
      step.prompt_path = resolve(baseDir, step.prompt_path);
    }
  }
  return clone;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expandEnvironmentString(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REFERENCE_PATTERN, (_match, name: string, operator: string | undefined, fallback = "") => {
    const raw = env[name];
    if (operator === ":-") {
      return raw === undefined || raw === "" ? fallback : raw;
    }
    if (operator === "-") {
      return raw === undefined ? fallback : raw;
    }
    if (raw === undefined) {
      throw new Error(`Missing environment variable ${name} and no default was provided.`);
    }
    return raw;
  });
}
