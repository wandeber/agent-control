import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultControlHome } from "./core/paths.js";
export const SERVICE_PORT = 17662;
export function readServiceConfig() {
    const value = JSON.parse(readFileSync(join(defaultControlHome(), "mcp-service.json"), "utf8"));
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)) {
        throw new Error("Invalid local MCP service configuration; run the packaged service installer.");
    }
    return { port: value.port, token: value.token };
}
