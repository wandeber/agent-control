import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
export function defaultControlHome() {
    return process.env.AGENT_CONTROL_HOME || join(homedir(), ".codex", "agent-control");
}
export function defaultStatePath() {
    return process.env.AGENT_CONTROL_DB || join(defaultControlHome(), "state.sqlite");
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
