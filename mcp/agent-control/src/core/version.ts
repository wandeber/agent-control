import { readFileSync } from "node:fs";

// Source and compiled modules have the same depth relative to the manifest.
// Keep CLI output and MCP resource versions tied to the installed package.
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version)) {
  throw new Error("The Agent Control package manifest has no valid version.");
}
export const AGENT_CONTROL_VERSION = manifest.version;
