import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { ControllerError } from "../core/errors.js";

const scalarKeys = new Set(["model", "model_provider", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "service_tier", "sandbox_mode", "approval_policy"]);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** App-server has no profile-v2 flag. Support only config with equivalent path-free layering. */
export function readInteractiveProfile(path?: string, expectedHash?: string): Record<string, unknown> {
  if (!path) return {};
  const bytes = readFileSync(path);
  if (expectedHash && createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new ControllerError("Codex profile changed before interactive continuation.", "unsupported_operation");
  const config = parse(bytes.toString());
  const unsupported = (key: string): never => { throw new ControllerError(`Interactive Codex cannot preserve profile setting ${key}. Keep the current execution and review this setting before enabling interactive access.`, "unsupported_operation"); };
  for (const [key, value] of Object.entries(config)) {
    if (scalarKeys.has(key) && typeof value === "string") continue;
    if (key === "features" && object(value) && Object.values(value).every(item => typeof item === "boolean")) continue;
    if (key === "mcp_servers" && object(value)) {
      for (const [server, settings] of Object.entries(value)) {
        if (!object(settings) || Object.entries(settings).some(([field, enabled]) => field !== "enabled" || typeof enabled !== "boolean")) unsupported(`mcp_servers.${server}`);
      }
      continue;
    }
    if (key === "sandbox_workspace_write" && object(value) && Object.entries(value).every(([field, enabled]) => field === "network_access" && typeof enabled === "boolean")) continue;
    unsupported(key);
  }
  return config;
}

function merge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) result[key] = object(value) && object(result[key]) ? merge(result[key], value) : value;
  return result;
}

export function interactiveProfileOverrides(profile: Record<string, unknown>, configuration: unknown): Record<string, unknown> {
  if (!Object.keys(profile).length) return {};
  if (!object(configuration) || !Array.isArray(configuration.layers)) throw new ControllerError("Codex did not expose configuration layers; profile precedence cannot be verified.", "unsupported_operation");
  let result = profile;
  // config/read returns normalized, trusted layers; never read raw project TOML
  // or raise a disabled layer above the user's selected profile.
  for (const layer of [...configuration.layers].reverse()) {
    if (!object(layer) || !object(layer.name)) throw new ControllerError("Codex returned an invalid configuration layer.", "unsupported_operation");
    if (layer.name.type !== "project" || layer.disabledReason) continue;
    if (!object(layer.config)) throw new ControllerError("Codex project configuration could not be verified.", "unsupported_operation");
    result = merge(result, layer.config);
  }
  return result;
}
