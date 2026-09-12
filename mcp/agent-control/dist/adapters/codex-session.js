import { toolActivity } from "../core/tool-activity.js";
import { cancelQueuedCliMessages, cliQueueState, ensureCliBridge, queueCliMessage } from "./attached-cli-bridge.js";
import { discoverCliWriter, hasRolloutWriter, interruptCliWriter } from "./cli-writer.js";
import { CodexThreadAdapter } from "./codex-thread-adapter.js";
import { controlExistingSession } from "./session-control.js";
import Database from "better-sqlite3";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ControllerError } from "../core/errors.js";
const cache = new Map();
const count = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const usageFields = ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"];
function belongsToThread(path, home, threadId) {
    let fd;
    try {
        const actual = realpathSync(path);
        if (!actual.endsWith(".jsonl") || !["sessions", "archived_sessions"].some(dir => {
            if (!existsSync(join(home, dir)))
                return false;
            const root = realpathSync(join(home, dir)), rel = relative(root, actual);
            return rel.split(sep)[0] !== ".." && !isAbsolute(rel);
        }))
            return false;
        fd = openSync(actual, "r");
        // Metadata is the first record; never parse another conversation merely
        // because a filename or a stale index mentions the requested UUID.
        const buffer = Buffer.alloc(1024 * 1024);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        const end = buffer.subarray(0, length).indexOf(10);
        if (end < 0)
            return false;
        const row = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        return row.type === "session_meta" && row.payload?.id === threadId;
    }
    catch {
        return false;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function sessionPath(home, threadId) {
    // Codex can resume a conversation into an ID_session-ID filename. Its
    // read-only index identifies the active rollout even when older copies remain.
    for (const file of readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))) {
        let db;
        try {
            db = new Database(join(home, file), { readonly: true, fileMustExist: true });
            const row = db.prepare("select rollout_path from threads where id = ?").get(threadId);
            if (row?.rollout_path && belongsToThread(row.rollout_path, home, threadId))
                return row.rollout_path;
        }
        catch { /* Older hosts may have no compatible thread index. */ }
        finally {
            db?.close();
        }
    }
    return sessionCandidates(home, threadId).find(path => belongsToThread(path, home, threadId));
}
function sessionCandidates(home, threadId) {
    const candidates = [];
    const suffix = new RegExp(`(?:^|-)${threadId}(?:_[a-f0-9-]{36})?\\.jsonl$`, "i");
    const visit = (dir) => {
        if (!existsSync(dir))
            return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory())
                visit(path);
            else if (entry.isFile() && suffix.test(entry.name))
                candidates.push(path);
        }
    };
    visit(join(home, "sessions"));
    visit(join(home, "archived_sessions"));
    return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}
const usagePaths = new Map();
/** Historical usage may span resumed rollouts; every path must still prove its native thread identity. */
export function codexUsagePaths(threadId, baselinePath) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId))
        return [];
    const home = process.env.CODEX_HOME ?? join(homedir(), ".codex"), key = `${home}:${threadId}`;
    try {
        const active = sessionPath(home, threadId), cached = usagePaths.get(key);
        // Resuming changes the indexed path. Avoid walking the session tree on every dashboard refresh.
        const paths = cached && cached.active === active && cached.paths.every(existsSync) ? cached.paths : sessionCandidates(home, threadId);
        if (usagePaths.size >= 100 && !usagePaths.has(key))
            usagePaths.delete(usagePaths.keys().next().value);
        usagePaths.set(key, { active, paths });
        return [...new Set([baselinePath, active, ...paths].filter((path) => !!path && belongsToThread(path, home, threadId)).map(path => realpathSync(path)))];
    }
    catch {
        return [];
    }
}
/** Resolve only persisted sessions in the configured Codex home, never a caller-supplied log path. */
export function readCodexSession(threadId) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId))
        return null;
    const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const key = `${home}:${threadId}`;
    try {
        const path = sessionPath(home, threadId);
        if (!path)
            return null;
        const stat = statSync(path), signature = `${resolve(path)}:${stat.size}:${stat.mtimeMs}`;
        if (cache.get(key)?.signature === signature)
            return cache.get(key).session;
        const session = { id: threadId, path, model: null, status: "unknown", updatedAt: stat.mtime.toISOString(), messages: [], usage: null, usageSamples: [], events: [], lastIndex: -1 };
        let matched = false;
        for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
            let row;
            try {
                row = JSON.parse(line);
            }
            catch {
                continue;
            }
            const p = row.payload;
            if (!p)
                continue;
            session.lastIndex = index;
            if (row.type === "session_meta") {
                if (p.id !== threadId)
                    return null;
                matched = true;
                session.cwd = p.cwd;
                session.modelProvider = p.model_provider;
            }
            if (row.type === "turn_context" && typeof p.model === "string") {
                session.model = p.model;
                session.effort = p.effort;
                session.approvalPolicy = p.approval_policy;
                session.sandboxPolicy = p.sandbox_policy;
            }
            if (row.type === "event_msg") {
                if (p.type === "task_started")
                    session.status = "running";
                if (p.type === "task_complete")
                    session.status = "completed";
                if (p.type === "turn_aborted")
                    session.status = "stopped";
                const eventType = p.type === "task_started" ? "agent.started" : p.type === "task_complete" ? "agent.completed" : p.type === "turn_aborted" ? "agent.stopped" : undefined;
                if (eventType)
                    session.events.push({ index, type: eventType, turn_id: p.turn_id });
                if (p.type === "token_count" && p.info?.total_token_usage) {
                    const u = p.info.total_token_usage;
                    session.usage = { input_tokens: count(u.input_tokens), output_tokens: count(u.output_tokens), total_tokens: count(u.total_tokens),
                        cached_input_tokens: count(u.cached_input_tokens), cache_write_input_tokens: count(u.cache_write_input_tokens),
                        reasoning_output_tokens: count(u.reasoning_output_tokens), context_used: null, context_limit: count(p.info.model_context_window),
                        source: "codex.rollout.token_count", model: session.model, captured_at: row.timestamp };
                    session.usageSamples.push(session.usage);
                }
            }
            if (row.type === "response_item") {
                const id = `rollout-${index}`, created_at = row.timestamp;
                if (p.type === "message" && ["assistant", "user"].includes(p.role)) {
                    const text = (p.content ?? []).filter((c) => ["input_text", "output_text"].includes(c.type)).map((c) => c.text).join("\n");
                    if (text)
                        session.messages.push({ id, role: p.role, text, created_at, metadata: { type: "text" } });
                    if (text && p.role === "assistant")
                        session.events.push({ index, type: "agent.message", text: text.slice(0, 240) });
                }
                else if (p.type === "reasoning") {
                    // Only the public summary, never encrypted/private reasoning payloads.
                    const text = (p.summary ?? []).map((c) => c.text ?? "").join("\n");
                    if (text)
                        session.messages.push({ id, role: "assistant", text, created_at, metadata: { type: "reasoning" } });
                }
                else if (["function_call", "custom_tool_call"].includes(p.type)) {
                    session.messages.push({ id, role: "tool", text: `${p.name}\nInput: ${p.arguments ?? p.input ?? ""}`, created_at, metadata: { type: "tool", tool_activity: toolActivity({ ...p, arguments: p.arguments ?? p.input, status: "running" }, p.call_id ?? id) } });
                }
                else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
                    session.messages.push({ id, role: "tool", text: typeof p.output === "string" ? p.output : JSON.stringify(p.output), created_at, metadata: { type: "tool", tool_activity: toolActivity({ name: "Tool result", output: p.output, status: "completed" }, p.call_id ?? id) } });
                }
            }
        }
        if (!matched)
            return null;
        session.messages = session.messages.slice(-300);
        if (cache.size >= 100 && !cache.has(key))
            cache.delete(cache.keys().next().value);
        cache.set(key, { signature, session });
        return session;
    }
    catch {
        return null;
    }
}
export function sessionUsage(handle) {
    const session = readCodexSession(String(handle.data.thread_id ?? ""));
    if (!session?.usage)
        return null;
    let baseline = handle.data.usage_baseline;
    const index = baseline?.rollout_usage_index;
    const indexedSample = typeof index === "number" ? session.usageSamples[index] : undefined;
    // Persist the exact boundary: two token records may share a millisecond, and
    // a newly registered conversation may legitimately have no token records yet.
    const exactBoundary = baseline?.rollout_path === session.path && typeof index === "number" && (index === -1 && baseline.source === "codex.rollout.attachment_baseline" && usageFields.every(field => baseline[field] === 0) ||
        !!indexedSample && indexedSample.captured_at === baseline.captured_at && usageFields.every(field => indexedSample[field] === baseline[field]));
    let samples = exactBoundary ? session.usageSamples.slice(index + 1) : session.usageSamples;
    const scopeStart = typeof handle.data.usage_started_at === "string" ? handle.data.usage_started_at : undefined;
    if (!exactBoundary && scopeStart && Number.isFinite(Date.parse(scopeStart))) {
        // Recover old baselines from the actual registration boundary, not from a
        // counter captured days earlier in a different rollout. Never charge that
        // intervening conversation history to the selected run.
        baseline = session.usageSamples.filter(sample => Date.parse(sample.captured_at) <= Date.parse(scopeStart)).at(-1);
        if (!baseline)
            return null;
        samples = session.usageSamples.slice(session.usageSamples.indexOf(baseline) + 1);
    }
    else if (!exactBoundary && baseline) {
        const matching = session.usageSamples.findIndex(sample => sample.captured_at === baseline.captured_at && usageFields.every(field => sample[field] === baseline[field]));
        samples = matching >= 0 ? session.usageSamples.slice(matching + 1) : session.usageSamples.filter(sample => sample.captured_at > baseline.captured_at);
    }
    // Old attached conversations without a baseline must not charge their entire history to a run.
    if (!baseline && (handle.data.agent_control_role || handle.data.observation_only))
        return null;
    const result = { ...session.usage, source: baseline ? "codex.rollout.since_attachment" : session.usage.source };
    for (const field of usageFields) {
        const value = session.usage[field], before = baseline ? baseline[field] : 0;
        let previous = before;
        const monotonic = samples.every(sample => {
            const next = sample[field];
            if (typeof next !== "number")
                return true;
            const valid = typeof previous !== "number" || next >= previous;
            previous = next;
            return valid;
        });
        result[field] = monotonic && typeof value === "number" && typeof before === "number" && value >= before ? value - before : null;
    }
    // A single aggregate cannot truthfully attribute a mixed-model interval to its last model.
    const models = new Set(samples.map(s => s.model));
    if (models.size > 1)
        result.model = "Mixed models";
    return result;
}
export function sessionBaseline(threadId) {
    const session = readCodexSession(threadId);
    if (!session)
        return null;
    const baseline = session.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_input_tokens: 0,
        cache_write_input_tokens: 0, reasoning_output_tokens: 0, context_used: null, context_limit: null,
        model: session.model, source: "codex.rollout.attachment_baseline", captured_at: new Date().toISOString() };
    return { ...baseline, rollout_path: session.path, rollout_usage_index: session.usageSamples.length - 1 };
}
export class CodexSessionAdapter {
    kind = "codex-session";
    capabilities() {
        return { canStart: false, canSendMessage: true, canReadLatest: true, canStopGracefully: true,
            canInterrupt: true, canForceStop: false, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: true };
    }
    async start() { throw this.unsupported(); }
    controlHandle(handle) {
        const session = handle.data.remote_session ? null : readCodexSession(String(handle.data.thread_id));
        return { ...handle, data: { ...handle.data, safe_to_resume: Boolean(session && handle.data.cli_configuration_valid !== false && !hasRolloutWriter(session.path) && ["completed", "stopped", "failed"].includes(session.status)),
                model: session?.model ?? handle.data.model, model_provider: session?.modelProvider ?? handle.data.model_provider, cwd: session?.cwd ?? handle.data.cwd } };
    }
    async sendMessage(handle, message) {
        await this.sendMessageWithReceipt(handle, message);
    }
    async sendMessageWithReceipt(handle, message) {
        if (handle.data.cli_continuity && !handle.data.prefer_app_server) {
            const id = queueCliMessage(handle.data.cli_continuity, message.message, message.metadata?.dispatch_fence);
            return { delivered: false, queued: true, message_id: id, orchestrator_action: null };
        }
        await controlExistingSession(this.controlHandle(handle), "send", message.message);
        return { delivered: true };
    }
    async interrupt(handle) {
        const session = handle.data.remote_session ? null : readCodexSession(String(handle.data.thread_id));
        const writer = session ? discoverCliWriter(session.path) : null;
        if (session && writer) {
            interruptCliWriter(session.path, writer);
            return { status: "running", message: "Interrupt sent to the reverified exclusive CLI writer; awaiting its turn result." };
        }
        if (!handle.data.prefer_app_server && session && ["completed", "stopped", "failed"].includes(session.status))
            return this.getStatus(handle);
        await controlExistingSession(this.controlHandle(handle), "interrupt");
        return { status: "running", message: "Interrupt accepted by the session's owning app-server; awaiting its turn result." };
    }
    async stop(handle, options) {
        if (options?.mode === "interrupt")
            return this.interrupt(handle);
        cancelQueuedCliMessages(String(handle.data.thread_id));
        const result = await this.interrupt(handle);
        return { ...result, status: ["completed", "stopped", "failed", "waiting_for_input"].includes(result.status) ? "stopped" : "stopping" };
    }
    unsupported() { return new ControllerError("Attach an existing session using worker_attach; this adapter does not create replacement sessions.", "unsupported_operation"); }
    async getStatus(handle) {
        if (handle.data.remote_session) {
            const result = await new CodexThreadAdapter().getStatus(handle);
            return { ...result, status: this.observedStatus(result.status, handle) };
        }
        const session = readCodexSession(String(handle.data.thread_id));
        const queue = cliQueueState(String(handle.data.thread_id));
        if (queue.pending)
            ensureCliBridge(String(handle.data.thread_id));
        // Missing final evidence is unknown, never a fabricated completion or interruption.
        const after = typeof handle.data.observed_event_index === "number" ? handle.data.observed_event_index : -1;
        return { status: this.observedStatus(queue.uncertain || queue.failed ? "blocked" : queue.pending ? "running" : session?.status ?? "unknown", handle), updatedAt: session?.updatedAt,
            data: { queued_messages: queue, observed_events: session?.events.filter(event => event.index > after).map(event => event.type === "agent.stopped" && !handle.data.cancel_requested
                    ? { ...event, type: "agent.status_changed", status: "waiting_for_input", reason: "turn_interrupted" } : event) ?? [], observed_event_index: session?.lastIndex ?? after } };
    }
    observedStatus(status, handle) {
        if (handle.data.cancel_requested && ["stopped", "completed", "failed"].includes(status))
            return "stopped";
        return status === "stopped" ? "waiting_for_input" : status;
    }
    async readLatest(handle, options) { if (handle.data.remote_session)
        return new CodexThreadAdapter().readLatest(handle, options); return readCodexSession(String(handle.data.thread_id))?.messages.slice(-options.limit) ?? []; }
    readUsage(handle) { return handle.data.remote_session ? null : sessionUsage(handle); }
    watchStatus(handle, onChange) {
        let previous = "", busy = false;
        const timer = setInterval(async () => {
            if (busy)
                return;
            busy = true;
            try {
                const state = await this.getStatus(handle);
                const signature = JSON.stringify(state);
                if (signature !== previous) {
                    await onChange(state);
                    previous = signature;
                }
            }
            catch { /* Keep the last successful observation and retry without inventing failure. */ }
            finally {
                busy = false;
            }
        }, 1000);
        timer.unref();
        return () => clearInterval(timer);
    }
}
