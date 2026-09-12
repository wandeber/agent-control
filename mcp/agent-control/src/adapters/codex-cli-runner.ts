/** Detached supervisor: serializes turns and preserves exact-session continuation. */
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControllerError } from "../core/errors.js";
import { AgentAccessStore } from "../core/agent-access.js";
import { runInteractiveCliTurn, type InteractiveCliJob } from "./codex-cli-interactive.js";

export interface CliJob { executable: string; args: string[]; cwd: string; prompt: string; profile_path?: string; profile_hash?: string; interactive?: Omit<InteractiveCliJob, "executable" | "cwd" | "prompt" | "profile_path" | "profile_hash">; }
export interface CliState { status: "running" | "queued" | "waiting_for_input" | "completed" | "failed" | "stopped" | "blocked"; thread_id?: string; turn_id?: string; runtime_turn_id?: string; transport?: "app-server"; updated_at: string; exit_code?: number | null; }
interface QueuedJob { id: string; job: CliJob; initial: boolean; status: "pending" | "dispatched" | "completed" | "failed" | "interrupted" | "cancelled"; }
export function writeState(dir: string, state: CliState): void { save(join(dir, "state.json"), state); }
function save(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); renameSync(temp, path);
}
function stateAt(dir: string): CliState { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); }
function jobs(dir: string): QueuedJob[] {
  return readdirSync(join(dir, "queue")).filter(name => name.endsWith(".json")).sort()
    .map(name => JSON.parse(readFileSync(join(dir, "queue", name), "utf8")));
}
function saveJob(dir: string, entry: QueuedJob) { save(join(dir, "queue", `${entry.id}.json`), entry); }
function locked<T>(dir: string, action: () => T): T {
  const db = new Database(join(dir, "dispatch-lock.sqlite"));
  try { db.pragma("busy_timeout = 5000"); db.exec("BEGIN IMMEDIATE"); return action(); }
  finally { if (db.inTransaction) db.exec("ROLLBACK"); db.close(); }
}
const unavailable = (message: string) => new ControllerError(message, "unsupported_operation");
export function enqueueCliJob(dir: string, job: CliJob, initial: boolean): string {
  mkdirSync(join(dir, "queue"), { recursive: true, mode: 0o700 });
  return locked(dir, () => {
    if (existsSync(join(dir, "cancelled"))) throw unavailable("CLI worker was cancelled; no new work may be queued.");
    const exists = existsSync(join(dir, "state.json"));
    if (initial && exists) throw unavailable("This CLI worker already has an execution; continue its existing session instead.");
    const state: CliState = exists ? stateAt(dir) : { status: "queued", updated_at: new Date().toISOString() };
    if (!initial && !state.thread_id && !["running", "queued"].includes(state.status)) throw unavailable("CLI worker has no persisted session ID to resume.");
    if (state.status === "running" && !state.turn_id) throw unavailable("This turn belongs to an older CLI supervisor; wait for it to finish before continuing.");
    const id = `${Date.now()}-${process.hrtime.bigint().toString().padStart(24, "0")}-${randomUUID()}`;
    saveJob(dir, { id, job, initial, status: "pending" });
    writeState(dir, { ...state, status: state.status === "running" ? "running" : "queued", updated_at: new Date().toISOString() });
    return id;
  });
}
export function requestCliStop(dir: string, mode: "interrupt" | "graceful" | "kill"): string | undefined {
  return locked(dir, () => {
    const state = stateAt(dir);
    const legacy = state.status === "running" && !state.turn_id;
    if (legacy && mode === "interrupt") throw unavailable("Recoverable interruption requires the updated CLI supervisor. Wait for this older turn to finish before continuing.");
    if (mode !== "interrupt") {
      // Cancellation wins against enqueue and dispatch under the same lock.
      writeFileSync(join(dir, "cancelled"), mode, { mode: 0o600 });
      for (const entry of (existsSync(join(dir, "queue")) ? jobs(dir) : []).filter(entry => entry.status === "pending")) {
        entry.status = "cancelled"; entry.job.prompt = ""; saveJob(dir, entry);
      }
    } else if (existsSync(join(dir, "cancelled"))) throw unavailable("CLI worker is durably cancelled; interruption cannot resume it.");
    const target = legacy ? "legacy" : state.status === "running" ? state.turn_id : undefined;
    if (target) save(join(dir, "stop.json"), { mode, turn_id: target });
    else if (mode !== "interrupt") writeState(dir, { ...state, status: "stopped", updated_at: new Date().toISOString() });
    return target;
  });
}

export async function supervise(dir: string): Promise<void> {
  const owner = new Database(join(dir, "supervisor-lock.sqlite"));
  try { owner.pragma("busy_timeout = 0"); owner.exec("BEGIN IMMEDIATE"); }
  catch { owner.close(); return; }
  let released = false;
  const release = () => { if (!released) { released = true; owner.exec("ROLLBACK"); owner.close(); } };
  try {
    writeFileSync(join(dir, "ready"), "ready", { mode: 0o600 });
    for (;;) {
      let run: Promise<void> | undefined;
      locked(dir, () => {
        const all = jobs(dir);
        if (all.some(entry => entry.status === "dispatched")) {
          // An abandoned invocation may still own a child. Never replay or start
          // a competing turn based only on an expired MCP/supervisor lifetime.
          writeState(dir, { ...stateAt(dir), status: "blocked", updated_at: new Date().toISOString() });
          release(); return;
        }
        const next = all.find(entry => entry.status === "pending");
        if (!next || existsSync(join(dir, "cancelled"))) { release(); return; }
        const state = stateAt(dir);
        const session = next.initial ? undefined : state.thread_id;
        const profileValid = !next.job.profile_path || (existsSync(next.job.profile_path) && createHash("sha256").update(readFileSync(next.job.profile_path)).digest("hex") === next.job.profile_hash);
        if ((!next.initial && !session) || !profileValid) {
          next.status = "failed"; next.job.prompt = ""; saveJob(dir, next);
          appendFileSync(join(dir, "stderr.log"), !profileValid ? "Codex profile changed before queued continuation.\n" : "No persisted session ID for queued continuation.\n", { mode: 0o600 });
          writeState(dir, { ...state, status: "blocked", updated_at: new Date().toISOString() });
          release(); return;
        }
        next.status = "dispatched"; saveJob(dir, next);
        const args = [...next.job.args, ...(session ? ["resume", session] : []), "-"];
        writeState(dir, { ...state, status: "running", turn_id: next.id, runtime_turn_id: undefined, updated_at: new Date().toISOString() });
        appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ type: "agent_control.prompt", text: next.job.prompt, created_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
        let interactive = state.transport === "app-server" || Boolean(next.job.interactive?.approval_policy);
        if (next.job.interactive) {
          const accessDb = new Database(next.job.interactive.db_path);
          try { interactive ||= Boolean(new AgentAccessStore(accessDb).getAgentAccess(next.job.interactive.agent_id).requested); }
          finally { accessDb.close(); }
        }
        if (interactive && !next.job.interactive) throw unavailable("The interactive worker binding is unavailable; do not replace its transport.");
        if (interactive) writeState(dir, { ...stateAt(dir), transport: "app-server" });
        run = interactive ? runInteractiveTurn(dir, next, session) : runTurn(dir, next, args, session);
      });
      if (!run) break;
      await run;
    }
  } finally { release(); }
}

async function runInteractiveTurn(dir: string, entry: QueuedJob, session?: string): Promise<void> {
  const terminate = () => { requestCliStop(dir, "kill"); };
  process.on("SIGTERM", terminate); process.on("SIGINT", terminate);
  const event = (value: Record<string, unknown>) => {
    const line = JSON.stringify(value) + "\n";
    appendFileSync(join(dir, "events.jsonl"), line, { mode: 0o600 });
    if (value.type === "error" || value.type === "turn.failed") appendFileSync(join(dir, "stderr.log"), line, { mode: 0o600 });
  };
  let heartbeatAt = 0;
  const heartbeat = () => { if (Date.now() - heartbeatAt >= 1000) { heartbeatAt = Date.now(); locked(dir, () => writeState(dir, { ...stateAt(dir), updated_at: new Date().toISOString() })); } };
  const heartbeatTimer = setInterval(heartbeat, 1000);
  try {
    const result = await runInteractiveCliTurn({ ...entry.job, ...entry.job.interactive! }, {
      session, event,
      thread: id => locked(dir, () => writeState(dir, { ...stateAt(dir), thread_id: id, updated_at: new Date().toISOString() })),
      turn: id => locked(dir, () => writeState(dir, { ...stateAt(dir), runtime_turn_id: id, updated_at: new Date().toISOString() })),
      heartbeat,
      stop: () => locked(dir, () => {
        if (existsSync(join(dir, "cancelled"))) return readFileSync(join(dir, "cancelled"), "utf8") === "kill" ? "kill" : "graceful";
        if (!existsSync(join(dir, "stop.json"))) return undefined;
        const request = JSON.parse(readFileSync(join(dir, "stop.json"), "utf8"));
        rmSync(join(dir, "stop.json"), { force: true });
        return request.turn_id === entry.id ? request.mode : undefined;
      }),
      dispatch: send => locked(dir, () => {
        if (existsSync(join(dir, "cancelled"))) throw unavailable("The CLI worker was cancelled before dispatch.");
        return send();
      })
    });
    locked(dir, () => {
      const cancelled = existsSync(join(dir, "cancelled"));
      entry.status = cancelled ? "cancelled" : result.status === "waiting_for_input" ? "interrupted" : result.status;
      entry.job.prompt = ""; saveJob(dir, entry);
      const status = cancelled ? "stopped" : result.status;
      event({ type: "agent_control.turn_finished", status });
      writeState(dir, { status: !cancelled && jobs(dir).some(job => job.status === "pending") ? "queued" : status,
        thread_id: result.thread_id, transport: "app-server", exit_code: result.status === "completed" ? 0 : null, updated_at: new Date().toISOString() });
    });
  } catch (error) {
    // Unconfirmed process cleanup leaves the invocation claimed; another
    // supervisor must not start a competing writer for this session.
    locked(dir, () => writeState(dir, { ...stateAt(dir), status: "blocked", updated_at: new Date().toISOString() }));
    event({ type: "error", message: error instanceof Error ? error.message : "Interactive CLI ownership could not be released." });
    throw error;
  } finally { clearInterval(heartbeatTimer); process.off("SIGTERM", terminate); process.off("SIGINT", terminate); }
}

function runTurn(dir: string, entry: QueuedJob, args: string[], session?: string): Promise<void> {
  return new Promise(resolve => {
    const child = spawn(entry.job.executable, args, { cwd: entry.job.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let threadId = session, completed = false, failed = false, interrupted = false, cancelled = false, buffer = "";
    let signalled: string | undefined;
    const signal = (mode: string) => {
      if (mode === "interrupt") interrupted = true; else cancelled = true;
      if (child.pid && signalled !== mode) {
        try { process.kill(-child.pid, mode === "kill" ? "SIGKILL" : mode === "interrupt" ? "SIGINT" : "SIGTERM"); } catch { /* The owned child already exited. */ }
        signalled = mode;
      }
    };
    const terminate = () => signal("kill");
    process.on("SIGTERM", terminate); process.on("SIGINT", terminate);
    child.stdout.on("data", (chunk: Buffer) => {
      appendFileSync(join(dir, "events.jsonl"), chunk, { mode: 0o600 });
      buffer += chunk.toString(); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) { try {
        const event = JSON.parse(line);
        if (event.type === "turn.completed") completed = true;
        if (event.type === "turn.failed") failed = true;
        if (event.type === "error" || event.type === "turn.failed" || event.item?.type === "error") appendFileSync(join(dir, "stderr.log"), line + "\n", { mode: 0o600 });
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          if (session && event.thread_id !== session) {
            failed = true;
            // Killing a process that violated continuity is a failure, not a user cancellation.
            if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
          }
          else {
            threadId = event.thread_id;
            locked(dir, () => writeState(dir, { ...stateAt(dir), thread_id: threadId, updated_at: new Date().toISOString() }));
          }
        }
      } catch { /* Retain incomplete or non-JSON diagnostics without inferring success. */ } }
    });
    child.stderr.on("data", (chunk: Buffer) => appendFileSync(join(dir, "stderr.log"), chunk, { mode: 0o600 }));
    child.stdin.on("error", () => {}); child.stdin.end(entry.job.prompt);
    let heartbeatAt = Date.now();
    const timer = setInterval(() => locked(dir, () => {
      if (existsSync(join(dir, "cancelled"))) signal(readFileSync(join(dir, "cancelled"), "utf8") === "kill" ? "kill" : "graceful");
      else if (existsSync(join(dir, "stop.json"))) {
        const request = JSON.parse(readFileSync(join(dir, "stop.json"), "utf8"));
        if (request.turn_id === entry.id) signal(request.mode);
        rmSync(join(dir, "stop.json"), { force: true });
      }
      if (Date.now() - heartbeatAt >= 1000) {
        heartbeatAt = Date.now(); writeState(dir, { ...stateAt(dir), updated_at: new Date().toISOString() });
      }
    }), 100);
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return; finished = true; clearInterval(timer);
      process.off("SIGTERM", terminate); process.off("SIGINT", terminate);
      locked(dir, () => {
        const definitiveStop = cancelled || existsSync(join(dir, "cancelled"));
        const status = definitiveStop ? "stopped" : interrupted ? "waiting_for_input" : code === 0 && completed && !failed && threadId ? "completed" : "failed";
        entry.status = definitiveStop ? "cancelled" : interrupted ? "interrupted" : status === "completed" ? "completed" : "failed";
        entry.job.prompt = ""; saveJob(dir, entry);
        appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ type: "agent_control.turn_finished", status }) + "\n", { mode: 0o600 });
        const pending = jobs(dir).some(job => job.status === "pending");
        writeState(dir, { status: pending && !definitiveStop ? "queued" : status, thread_id: threadId, exit_code: code, updated_at: new Date().toISOString() });
      });
      resolve();
    };
    child.on("error", () => finish(null)); child.on("close", finish);
  });
}
if (process.argv[2] === "--supervise" && process.argv[3]) void supervise(process.argv[3]);
