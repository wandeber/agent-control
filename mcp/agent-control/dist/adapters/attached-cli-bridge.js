import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { defaultControlHome } from "../core/paths.js";
import { ControllerError } from "../core/errors.js";
import { readCodexSession } from "./codex-session.js";
import { hasRolloutWriter } from "./cli-writer.js";
const home = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");
const bridgeDir = (id) => join(defaultControlHome(), "attached-cli", id);
function takeLock(path) {
    const database = new Database(path);
    try {
        database.pragma("busy_timeout = 0");
        // SQLite owns the process lock, including automatic release after a crash.
        database.exec("BEGIN IMMEDIATE");
        return database;
    }
    catch {
        database.close();
        return null;
    }
}
function releaseLock(database) { try {
    database.exec("ROLLBACK");
}
finally {
    database.close();
} }
function mutateQueue(dir, action) {
    const lock = takeLock(join(dir, "dispatch-lock.sqlite"));
    if (!lock)
        throw new ControllerError("A CLI dispatch is crossing its acceptance boundary; retry interruption after its next event.", "backend_unavailable");
    try {
        return action();
    }
    finally {
        releaseLock(lock);
    }
}
function config(profile) {
    const basePath = join(home(), "config.toml"), profilePath = profile ? join(home(), `${profile}.config.toml`) : null;
    const baseText = existsSync(basePath) ? readFileSync(basePath, "utf8") : "";
    const profileText = profilePath && existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
    const base = parse(baseText), inline = profile ? base.profiles?.[profile] : undefined;
    if (profile && !profileText && !inline)
        throw new Error("The session's Codex profile is not configured on this host.");
    return { values: { ...base, ...inline, ...parse(profileText) }, fingerprint: createHash("sha256").update(baseText + "\0" + profileText).digest("hex") };
}
export function resolveCliContinuity(threadId, requestedProfile, writer) {
    if (process.platform === "win32")
        throw new Error("Use the owning app-server endpoint for Windows CLI control.");
    const session = readCodexSession(threadId);
    if (!session?.cwd || !session.model || !session.modelProvider)
        throw new Error("Persistent model, provider and directory are required to continue the existing CLI identity.");
    if (requestedProfile && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(requestedProfile))
        throw new Error("Invalid Codex profile name.");
    if (requestedProfile && writer?.profile && requestedProfile !== writer.profile)
        throw new Error("The requested profile differs from the running session's original profile.");
    const profile = requestedProfile ?? writer?.profile;
    const dir = bridgeDir(threadId);
    if (writer && existsSync(dir)) {
        for (const file of readdirSync(dir).filter(f => f.endsWith(".json"))) {
            const queued = JSON.parse(readFileSync(join(dir, file), "utf8"));
            if (queued.state === "dispatched" && queued.writer?.pid === writer.pid && queued.writer.started === writer.started
                && queued.continuity.model === session.model && queued.continuity.profile === profile && config(profile).fingerprint === queued.continuity.fingerprint)
                return queued.continuity;
        }
    }
    if (writer?.unsupportedOverrides)
        throw new Error("The CLI has additional configuration overrides not present in persisted session metadata; its original configuration must be recovered before continuation.");
    const resolved = config(profile);
    const provider = resolved.values.model_provider ?? "openai";
    if (session.modelProvider && provider !== session.modelProvider)
        throw new Error("Configure or supply the original provider profile before continuing this CLI session.");
    if (profile && resolved.values.model !== session.model)
        throw new Error("The profile's model differs from the existing session.");
    return { thread_id: threadId, cwd: session.cwd, model: session.model, profile, fingerprint: resolved.fingerprint, effort: session.effort, approval_policy: session.approvalPolicy, sandbox_policy: session.sandboxPolicy,
        executable: writer?.executable ?? process.env.AGENT_CONTROL_CODEX_CLI_BIN ?? "codex" };
}
function save(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
}
export function queueCliMessage(continuity, prompt) {
    if (config(continuity.profile).fingerprint !== continuity.fingerprint)
        throw new ControllerError("Codex configuration changed since attachment; reattach after reviewing the same model/provider.", "unsupported_operation");
    const dir = bridgeDir(continuity.thread_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = `${Date.now()}-${process.hrtime.bigint().toString().padStart(24, "0")}-${randomUUID()}`;
    save(join(dir, `${id}.json`), { id, continuity, prompt, state: "pending" });
    ensureCliBridge(continuity.thread_id);
    return id;
}
export function cliQueueState(threadId) {
    const dir = bridgeDir(threadId);
    if (!existsSync(dir))
        return { pending: 0, uncertain: 0, failed: 0 };
    const messages = readdirSync(dir).filter(f => f.endsWith(".json")).sort().map(f => { try {
        return JSON.parse(readFileSync(join(dir, f), "utf8"));
    }
    catch {
        return null;
    } });
    const latest = messages.filter(Boolean).at(-1);
    // Retain failure history on disk without making a later explicitly requested success permanently blocked.
    return { pending: messages.filter(m => m && ["pending", "dispatched"].includes(m.state)).length,
        uncertain: latest?.state === "uncertain" ? 1 : 0, failed: latest?.state === "failed" ? 1 : 0 };
}
export function cancelQueuedCliMessages(threadId) {
    const dir = bridgeDir(threadId);
    let cancelled = 0;
    if (!existsSync(dir))
        return cancelled;
    mutateQueue(dir, () => {
        for (const file of readdirSync(dir).filter(f => f.endsWith(".json"))) {
            const path = join(dir, file), value = JSON.parse(readFileSync(path, "utf8"));
            if (value.state === "pending") {
                value.state = "cancelled";
                value.prompt = "";
                save(path, value);
                cancelled++;
            }
        }
    });
    return cancelled;
}
const starts = new Map();
export function ensureCliBridge(threadId) {
    const key = bridgeDir(threadId);
    if (!cliQueueState(threadId).pending || Date.now() - (starts.get(key) ?? 0) < 5000)
        return;
    starts.set(key, Date.now());
    const bundled = fileURLToPath(new URL("./attached-cli-bridge.js", import.meta.url));
    const entry = existsSync(bundled) ? bundled : fileURLToPath(new URL("../../dist/adapters/attached-cli-bridge.js", import.meta.url));
    const env = { ...process.env };
    delete env.AGENT_CONTROL_ADMIN_KEY;
    delete env.AGENT_CONTROL_TOKEN;
    const child = spawn(process.execPath, [entry, "--attached-bridge", threadId], { detached: true, stdio: "ignore", env });
    child.on("error", () => { });
    child.unref();
}
const pause = () => new Promise(resolve => setTimeout(resolve, 1000));
const birth = (pid) => { try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
catch {
    return "";
} };
export async function superviseAttachedCli(threadId) {
    const dir = bridgeDir(threadId), lock = join(dir, "supervisor");
    if (!existsSync(dir))
        return;
    const supervisorLock = takeLock(join(dir, "supervisor-lock.sqlite"));
    if (!supervisorLock)
        return;
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, started: birth(process.pid) }), { mode: 0o600 });
    try {
        for (;;) {
            const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort();
            const entry = files.map(file => ({ path: join(dir, file), value: JSON.parse(readFileSync(join(dir, file), "utf8")) })).find(e => ["pending", "dispatched"].includes(e.value.state));
            if (!entry)
                break;
            const { path, value } = entry, session = readCodexSession(threadId);
            if (value.state === "dispatched") {
                // A crash after the dispatch fence has uncertain acceptance. Never resend it.
                value.state = "uncertain";
                value.error = "The previous supervisor stopped after dispatch; inspect the exact session before retrying.";
                save(path, value);
                break;
            }
            if (!session || !["completed", "stopped", "failed"].includes(session.status) || hasRolloutWriter(session.path)) {
                await pause();
                continue;
            }
            if (config(value.continuity.profile).fingerprint !== value.continuity.fingerprint) {
                value.state = "failed";
                value.error = "Codex configuration changed before continuation.";
                save(path, value);
                continue;
            }
            const args = ["exec", "--json", "--skip-git-repo-check"];
            if (value.continuity.profile)
                args.push("--profile", value.continuity.profile);
            if (value.continuity.effort)
                args.push("-c", `model_reasoning_effort=${JSON.stringify(value.continuity.effort)}`);
            if (value.continuity.approval_policy)
                args.push("-c", `approval_policy=${JSON.stringify(value.continuity.approval_policy)}`);
            const sandbox = value.continuity.sandbox_policy;
            if (sandbox && ["read-only", "workspace-write", "danger-full-access"].includes(String(sandbox.type)))
                args.push("--sandbox", String(sandbox.type));
            if (sandbox?.type === "workspace-write") {
                if (typeof sandbox.network_access === "boolean")
                    args.push("-c", `sandbox_workspace_write.network_access=${sandbox.network_access}`);
                if (Array.isArray(sandbox.writable_roots))
                    args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(sandbox.writable_roots)}`);
            }
            args.push("--model", value.continuity.model, "resume", threadId, "-");
            let dispatched;
            try {
                dispatched = mutateQueue(dir, () => {
                    if (JSON.parse(readFileSync(path, "utf8")).state !== "pending")
                        return undefined;
                    value.state = "dispatched";
                    value.baseline = session.lastIndex;
                    save(path, value);
                    return new Promise(resolve => {
                        const child = spawn(value.continuity.executable, args, { cwd: value.continuity.cwd, stdio: ["pipe", "pipe", "pipe"] });
                        if (child.pid) {
                            value.writer = { pid: child.pid, started: birth(child.pid) };
                            save(path, value);
                        }
                        child.stdin.on("error", () => { });
                        child.stdin.end(value.prompt);
                        let buffer = "", wrongIdentity = false;
                        child.stdout.on("data", chunk => {
                            buffer += String(chunk);
                            const lines = buffer.split("\n");
                            buffer = lines.pop() ?? "";
                            for (const line of lines) {
                                try {
                                    const event = JSON.parse(line);
                                    if (event.type === "thread.started" && event.thread_id !== threadId) {
                                        wrongIdentity = true;
                                        child.kill("SIGINT");
                                    }
                                }
                                catch { /* Ignore non-JSON diagnostics, never infer acceptance from them. */ }
                            }
                        });
                        child.stderr.on("data", chunk => appendFileSync(join(dir, `${value.id}.log`), chunk, { mode: 0o600 }));
                        let finished = false;
                        const finish = (ok) => {
                            if (finished)
                                return;
                            finished = true;
                            const observed = readCodexSession(threadId);
                            const completed = ok && !wrongIdentity && observed?.status === "completed" && observed.lastIndex > (value.baseline ?? -1);
                            value.state = completed ? "completed" : observed?.status === "stopped" ? "cancelled" : "failed";
                            if (value.state === "failed")
                                value.error = "The exact-session CLI continuation did not produce successful completion evidence.";
                            value.prompt = "";
                            save(path, value);
                            resolve();
                        };
                        child.once("error", () => finish(false));
                        child.once("close", code => finish(code === 0));
                    });
                });
            }
            catch (error) {
                if (error instanceof ControllerError && error.reason === "backend_unavailable") {
                    await pause();
                    continue;
                }
                throw error;
            }
            await dispatched;
        }
    }
    finally {
        rmSync(lock, { recursive: true, force: true });
        releaseLock(supervisorLock);
    }
}
if (process.argv[2] === "--attached-bridge" && process.argv[3])
    await superviseAttachedCli(process.argv[3]);
