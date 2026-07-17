import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultControlHome(): string {
  return process.env.AGENT_CONTROL_HOME || process.env.AGENT_CONTROL_USER_DIR || join(homedir(), ".agent-control");
}

export function defaultStatePath(): string {
  return process.env.AGENT_CONTROL_DB || defaultStateFilePath();
}

export function defaultStateFilePath(): string {
  return join(defaultControlHome(), "state.sqlite");
}

export function credentialsRoot(dbPath = defaultStatePath()): string {
  const controlHome = defaultControlHome();
  if (dbPath !== ":memory:" && resolve(dbPath) === resolve(defaultStateFilePath())) {
    return join(controlHome, "credentials");
  }

  // Credential cleanup is authoritative only for the SQLite database that
  // created the records. A stable database-specific sibling prevents one
  // overridden AGENT_CONTROL_DB from deleting another database's secrets while
  // preserving the historical path for the default state database.
  const authorityPath = dbPath === ":memory:" ? dbPath : resolve(dbPath);
  const namespace = createHash("sha256").update(authorityPath).digest("hex").slice(0, 20);
  return join(controlHome, `credentials-${namespace}`);
}

export function bridgeCredentialsDir(dbPath = defaultStatePath()): string {
  return join(credentialsRoot(dbPath), "bridges");
}

export function actionClaimCredentialsDir(dbPath = defaultStatePath()): string {
  return join(credentialsRoot(dbPath), "action-claims");
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
