import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
export function defaultControlHome() {
    return process.env.AGENT_CONTROL_HOME || process.env.AGENT_CONTROL_USER_DIR || join(homedir(), ".agent-control");
}
export function defaultStatePath() {
    return process.env.AGENT_CONTROL_DB || defaultStateFilePath();
}
export function defaultStateFilePath() {
    return join(defaultControlHome(), "state.sqlite");
}
export function credentialsRoot(dbPath = defaultStatePath()) {
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
export function bridgeCredentialsDir(dbPath = defaultStatePath()) {
    return join(credentialsRoot(dbPath), "bridges");
}
export function actionClaimCredentialsDir(dbPath = defaultStatePath()) {
    return join(credentialsRoot(dbPath), "action-claims");
}
export function runRuntimeDir(runId) {
    const dir = join(defaultControlHome(), "runs", runId);
    mkdirSync(dir, { recursive: true });
    return dir;
}
export function runsRuntimeRoot() {
    return join(defaultControlHome(), "runs");
}
export function runRuntimePath(runId) {
    return join(runsRuntimeRoot(), runId);
}
export function agentRuntimePath(runId, agentId) {
    return join(runRuntimePath(runId), "agents", agentId);
}
export function isInsideRunsRuntimeRoot(path) {
    const root = resolve(runsRuntimeRoot());
    const target = resolve(path);
    return target === root || target.startsWith(`${root}/`);
}
export function agentRuntimeDir(runId, agentId) {
    const dir = agentRuntimePath(runId, agentId);
    mkdirSync(dir, { recursive: true });
    return dir;
}
