import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorToPayload } from "../core/errors.js";
export const DEFAULT_OPENCODE_SERVER = "http://localhost:53910";
export const DEFAULT_WORKER_WATCH_TIMEOUT_MS = 5_400_000;
export const DEFAULT_WORKER_WATCH_INTERVAL_MS = 5000;
export const DEFAULT_WORKER_START_TIMEOUT_MS = 30_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 600_000;
export const DEFAULT_TERMINAL_SUBSCRIPTION_EVENTS = [
    "agent.completed",
    "agent.failed",
    "agent.blocked",
    "agent.stopped"
];
export function collect(value, previous) {
    previous.push(value);
    return previous;
}
export function parseIntOption(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) {
        throw new Error(`Expected integer, got: ${value}`);
    }
    return parsed;
}
export function parseJsonObjectOption(value) {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected a JSON object.");
    }
    return parsed;
}
export function outputError(error) {
    const payload = errorToPayload(error);
    console.error(JSON.stringify({
        ok: false,
        error: {
            message: typeof payload.error === "string" ? payload.error : String(payload.error ?? "Unknown error"),
            reason: typeof payload.reason === "string" ? payload.reason : "unknown",
            details: payload.details ?? {},
            name: error instanceof Error ? error.name : "Error"
        }
    }, null, 2));
}
export function commanderExitInfo(error) {
    if (!error || typeof error !== "object") {
        return null;
    }
    const record = error;
    return typeof record.code === "string" && typeof record.exitCode === "number"
        ? { code: record.code, exitCode: record.exitCode }
        : null;
}
export async function runCommand(command, args) {
    await new Promise((resolveCommand, rejectCommand) => {
        const child = spawn(command, args, { stdio: "inherit" });
        child.once("error", rejectCommand);
        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolveCommand();
                return;
            }
            rejectCommand(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}.`));
        });
    });
}
export function resolveAgentctlPath() {
    const local = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/agentctl");
    return existsSync(local) ? local : "agentctl";
}
export async function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            })
        ]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
export function requireOption(value, optionName) {
    if (!value) {
        throw new Error(`Missing required ${optionName}.`);
    }
    return value;
}
export function uniqueStrings(values) {
    return [...new Set(values.filter((value) => value.trim().length > 0))];
}
export async function sleep(ms) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
export function getRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Expected ${label} to be an object.`);
    }
    return value;
}
export function getString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Expected ${label} to be a non-empty string.`);
    }
    return value;
}
