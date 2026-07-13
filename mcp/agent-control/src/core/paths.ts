import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultControlHome(): string {
  return process.env.AGENT_CONTROL_HOME || process.env.AGENT_CONTROL_USER_DIR || join(homedir(), ".agent-control");
}

export function defaultStatePath(): string {
  return process.env.AGENT_CONTROL_DB || join(defaultControlHome(), "state.sqlite");
}

export function runRuntimeDir(runId: string): string {
  const dir = join(defaultControlHome(), "runs", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runsRuntimeRoot(): string {
  return join(defaultControlHome(), "runs");
}

export function runRuntimePath(runId: string): string {
  return join(runsRuntimeRoot(), runId);
}

export function agentRuntimePath(runId: string, agentId: string): string {
  return join(runRuntimePath(runId), "agents", agentId);
}

export function isInsideRunsRuntimeRoot(path: string): boolean {
  const root = resolve(runsRuntimeRoot());
  const target = resolve(path);
  return target === root || target.startsWith(`${root}/`);
}

export function agentRuntimeDir(runId: string, agentId: string): string {
  const dir = agentRuntimePath(runId, agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
