import { cancelQueuedCliMessages, cliQueueState, ensureCliBridge, queueCliMessage, type CliContinuity } from "./attached-cli-bridge.js";
import { discoverCliWriter, hasRolloutWriter, interruptCliWriter } from "./cli-writer.js";
import { CodexThreadAdapter } from "./codex-thread-adapter.js";
import { controlExistingSession } from "./session-control.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ControllerError } from "../core/errors.js";
import type { AgentAdapter, AgentHandle, AgentMessage, AgentStatus, AgentUsageObservation } from "../core/types.js";

interface Session {
  id: string; path: string; cwd?: string; model: string | null; modelProvider?: string; effort?: string; approvalPolicy?: string; sandboxPolicy?: Record<string, unknown>; status: AgentStatus; updatedAt: string;
  messages: AgentMessage[]; usage: AgentUsageObservation | null; usageSamples: AgentUsageObservation[];
  events: Array<{ index: number; type: "agent.started" | "agent.completed" | "agent.stopped" | "agent.message"; turn_id?: string; text?: string }>;
  lastIndex: number;
}
const paths = new Map<string, string>();
const cache = new Map<string, { signature: string; session: Session }>();
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** Resolve only persisted sessions in the configured Codex home, never a caller-supplied log path. */
export function readCodexSession(threadId: string): Session | null {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)) return null;
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const key = `${home}:${threadId}`;
  let path = paths.get(key);
  const find = (dir: string): string | undefined => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { const found = find(join(dir, entry.name)); if (found) return found; }
      else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) return join(dir, entry.name);
    }
  };
  try {
    if (!path || !existsSync(path)) path = find(join(home, "sessions")) ?? find(join(home, "archived_sessions"));
    if (!path) return null;
    paths.set(key, path);
    const stat = statSync(path), signature = `${stat.size}:${stat.mtimeMs}`;
    if (cache.get(key)?.signature === signature) return cache.get(key)!.session;
    const session: Session = { id: threadId, path, model: null, status: "unknown", updatedAt: stat.mtime.toISOString(), messages: [], usage: null, usageSamples: [], events: [], lastIndex: -1 };
    let matched = false;
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const p = row.payload;
      if (!p) continue;
      session.lastIndex = index;
      if (row.type === "session_meta") { if (p.id !== threadId) return null; matched = true; session.cwd = p.cwd; session.modelProvider = p.model_provider; }
      if (row.type === "turn_context" && typeof p.model === "string") { session.model = p.model; session.effort = p.effort; session.approvalPolicy = p.approval_policy; session.sandboxPolicy = p.sandbox_policy; }
      if (row.type === "event_msg") {
        if (p.type === "task_started") session.status = "running";
        if (p.type === "task_complete") session.status = "completed";
        if (p.type === "turn_aborted") session.status = "stopped";
        const eventType = p.type === "task_started" ? "agent.started" : p.type === "task_complete" ? "agent.completed" : p.type === "turn_aborted" ? "agent.stopped" : undefined;
        if (eventType) session.events.push({ index, type: eventType, turn_id: p.turn_id });
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
          const text = (p.content ?? []).filter((c: { type: string }) => ["input_text", "output_text"].includes(c.type)).map((c: { text: string }) => c.text).join("\n");
          if (text) session.messages.push({ id, role: p.role, text, created_at, metadata: { type: "text" } });
          if (text && p.role === "assistant") session.events.push({ index, type: "agent.message", text: text.slice(0, 240) });
        } else if (p.type === "reasoning") {
          // Only the public summary, never encrypted/private reasoning payloads.
          const text = (p.summary ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
          if (text) session.messages.push({ id, role: "assistant", text, created_at, metadata: { type: "reasoning" } });
        } else if (["function_call", "custom_tool_call"].includes(p.type)) {
          session.messages.push({ id, role: "tool", text: `${p.name}\nInput: ${p.arguments ?? p.input ?? ""}`, created_at, metadata: { type: "tool" } });
        } else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
          session.messages.push({ id, role: "tool", text: typeof p.output === "string" ? p.output : JSON.stringify(p.output), created_at, metadata: { type: "tool" } });
        }
      }
    }
    if (!matched) return null;
    session.messages = session.messages.slice(-300);
    if (cache.size >= 100 && !cache.has(key)) cache.delete(cache.keys().next().value!);
    cache.set(key, { signature, session });
    return session;
  } catch { return null; }
}

export function sessionUsage(handle: AgentHandle): AgentUsageObservation | null {
  const session = readCodexSession(String(handle.data.thread_id ?? ""));
  if (!session?.usage) return null;
  const baseline = handle.data.usage_baseline as AgentUsageObservation | undefined;
  // Old attached conversations without a baseline must not charge their entire history to a run.
  if (!baseline && (handle.data.agent_control_role || handle.data.observation_only)) return null;
  if (!baseline) return session.usage;
  const result = { ...session.usage, source: "codex.rollout.since_attachment" };
  for (const field of ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"] as const) {
    const value = session.usage[field], before = baseline[field];
    result[field] = typeof value === "number" && typeof before === "number" && value >= before ? value - before : null;
  }
  // A single aggregate cannot truthfully attribute a mixed-model interval to its last model.
  const models = new Set(session.usageSamples.filter(s => s.captured_at > baseline.captured_at).map(s => s.model));
  if (models.size > 1) result.model = "Mixed models";
  return result;
}

export function sessionBaseline(threadId: string): AgentUsageObservation | null {
  const session = readCodexSession(threadId);
  if (!session) return null;
  return session.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_input_tokens: 0,
    cache_write_input_tokens: 0, reasoning_output_tokens: 0, context_used: null, context_limit: null,
    model: session.model, source: "codex.rollout.attachment_baseline", captured_at: new Date().toISOString() };
}

export class CodexSessionAdapter implements AgentAdapter {
  readonly kind = "codex-session";
  capabilities() { return { canStart: false, canSendMessage: true, canReadLatest: true, canStopGracefully: true,
    canForceStop: false, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: true }; }
  async start(): Promise<AgentHandle> { throw this.unsupported(); }
  private controlHandle(handle: AgentHandle) {
    const session = handle.data.remote_session ? null : readCodexSession(String(handle.data.thread_id));
    return { ...handle, data: { ...handle.data, safe_to_resume: Boolean(session && handle.data.cli_configuration_valid !== false && !hasRolloutWriter(session.path) && ["completed", "stopped", "failed"].includes(session.status)),
      model: session?.model ?? handle.data.model, model_provider: session?.modelProvider ?? handle.data.model_provider, cwd: session?.cwd ?? handle.data.cwd } };
  }
  async sendMessage(handle: AgentHandle, message: { message: string }): Promise<void> {
    await this.sendMessageWithReceipt(handle, message.message);
  }
  async sendMessageWithReceipt(handle: AgentHandle, message: string) {
    if (handle.data.cli_continuity && !handle.data.prefer_app_server) {
      const id = queueCliMessage(handle.data.cli_continuity as unknown as CliContinuity, message);
      return { delivered: false as const, queued: true, message_id: id, orchestrator_action: null };
    }
    await controlExistingSession(this.controlHandle(handle), "send", message);
    return { delivered: true as const };
  }
  async stop(handle: AgentHandle) {
    const cancelled = cancelQueuedCliMessages(String(handle.data.thread_id));
    const session = handle.data.remote_session ? null : readCodexSession(String(handle.data.thread_id));
    const writer = session ? discoverCliWriter(session.path) : null;
    if (session && writer) {
      interruptCliWriter(session.path, writer);
      return { status: "stopping" as const, message: "Interrupt sent to the reverified exclusive CLI writer." };
    }
    if (cancelled && session && ["completed", "stopped", "failed"].includes(session.status)) return { status: "stopped" as const, message: "Pending CLI messages cancelled." };
    await controlExistingSession(this.controlHandle(handle), "interrupt");
    return { status: "stopped" as const, message: "Interrupt accepted by the session's owning app-server." };
  }
  private unsupported() { return new ControllerError("Attach an existing session using worker_attach; this adapter does not create replacement sessions.", "unsupported_operation"); }
  async getStatus(handle: AgentHandle) {
    if (handle.data.remote_session) return new CodexThreadAdapter().getStatus(handle);
    const session = readCodexSession(String(handle.data.thread_id));
    const queue = cliQueueState(String(handle.data.thread_id));
    if (queue.pending) ensureCliBridge(String(handle.data.thread_id));
    // Missing final evidence is unknown, never a fabricated completion or interruption.
    const after = typeof handle.data.observed_event_index === "number" ? handle.data.observed_event_index : -1;
    return { status: (queue.uncertain || queue.failed ? "blocked" : queue.pending ? "running" : session?.status ?? "unknown") as AgentStatus, updatedAt: session?.updatedAt,
      data: { queued_messages: queue, observed_events: session?.events.filter(event => event.index > after) ?? [], observed_event_index: session?.lastIndex ?? after } };
  }
  async readLatest(handle: AgentHandle, options: { limit: number }) { if (handle.data.remote_session) return new CodexThreadAdapter().readLatest(handle, options); return readCodexSession(String(handle.data.thread_id))?.messages.slice(-options.limit) ?? []; }
  readUsage(handle: AgentHandle) { return handle.data.remote_session ? null : sessionUsage(handle); }
  watchStatus(handle: AgentHandle, onChange: Parameters<NonNullable<AgentAdapter["watchStatus"]>>[1]) {
    let previous = "", busy = false;
    const timer = setInterval(async () => { if (busy) return; busy = true;
      try { const state = await this.getStatus(handle); const signature = JSON.stringify(state);
        if (signature !== previous) { await onChange(state); previous = signature; }
      } catch { /* Keep the last successful observation and retry without inventing failure. */ } finally { busy = false; }
    }, 1000);
    timer.unref(); return () => clearInterval(timer);
  }
}
