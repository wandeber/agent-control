import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentController } from "../core/controller.js";
import { errorToPayload } from "../core/errors.js";
import type { EventType } from "../core/types.js";

export type AuthOptionsFn = (optionsOverride?: { allowStoredAdminKey?: boolean }) => {
  agentToken?: string;
  adminKey?: string;
};

export interface CliDeps {
  controller: AgentController;
  output: (value: unknown) => void;
  authOptions: AuthOptionsFn;
}

export const DEFAULT_OPENCODE_SERVER = "http://localhost:53910";
export const DEFAULT_WORKER_WATCH_TIMEOUT_MS = 5_400_000;
export const DEFAULT_WORKER_WATCH_INTERVAL_MS = 5000;
export const DEFAULT_WORKER_START_TIMEOUT_MS = 30_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 600_000;
export const DEFAULT_TERMINAL_SUBSCRIPTION_EVENTS: EventType[] = [
  "agent.completed",
  "agent.failed",
  "agent.blocked",
  "agent.stopped"
];

export function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected integer, got: ${value}`);
  }
  return parsed;
}

export function parseJsonObjectOption(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function outputError(error: unknown): void {
  const payload = errorToPayload(error);
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          message: typeof payload.error === "string" ? payload.error : String(payload.error ?? "Unknown error"),
          reason: typeof payload.reason === "string" ? payload.reason : "unknown",
          details: payload.details ?? {},
          name: error instanceof Error ? error.name : "Error"
        }
      },
      null,
      2
    )
  );
}

export function commanderExitInfo(error: unknown): { code: string; exitCode: number } | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const record = error as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.exitCode === "number"
    ? { code: record.code, exitCode: record.exitCode }
    : null;
}

export async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveCommand, rejectCommand) => {
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

export function resolveAgentctlPath(): string {
  const local = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/agentctl");
  return existsSync(local) ? local : "agentctl";
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function requireOption(value: string | undefined, optionName: string): string {
  if (!value) {
    throw new Error(`Missing required ${optionName}.`);
  }
  return value;
}

export function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function getRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

export function getString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string.`);
  }
  return value;
}
