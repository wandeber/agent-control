import { toolActivity } from "../core/tool-activity.js";
import { readCodexSession, sessionUsage } from "./codex-session.js";
import Database from "better-sqlite3";
import { AgentAccessStore } from "../core/agent-access.js";
import { PermissionRequests } from "../core/permission-requests.js";
import { readInteractiveProfile } from "./codex-interactive-profile.js";
import { parse as parseToml } from "smol-toml";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControllerError } from "../core/errors.js";
import { agentRuntimeDir } from "../core/paths.js";
import type { AgentUsageObservation, AgentAdapter, AgentHandle, AgentMessage, AgentMessageInput, AgentStatusSnapshot, StartAgentInput, ReadLatestOptions, StopOptions, StopResult } from "../core/types.js";
import { enqueueCliJob, requestCliStop, type CliJob, type CliState } from "./codex-cli-runner.js";

interface Data { dir: string; cwd: string; profile?: string; model?: string; model_provider?: string; sandbox: string; reasoning_effort?: string; profile_hash?: string; executable?: string; resolved_model?: string; logFile?: string; access_agent_id?: string; access_db_path?: string; approval_policy?: "on-request"; }
const unsupported = (message: string) => new ControllerError(message, "unsupported_operation");
export class CodexCliAdapter implements AgentAdapter {
  readonly kind = "codex-cli";
  capabilities() { return { canStart: true, canInterrupt: true, canRequestPermissions: true, canSendMessage: true, canReadLatest: true, canStopGracefully: true, canForceStop: true, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: false }; }
  validateInteractiveAccess(handle: AgentHandle): void {
    const data = handle.data as unknown as Data;
    if (data.profile && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(data.profile)) throw unsupported("Invalid persisted Codex profile name.");
    readInteractiveProfile(data.profile ? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), `${data.profile}.config.toml`) : undefined, data.profile_hash);
  }
  async start(input: StartAgentInput): Promise<AgentHandle> {
    if (input.attachments?.length || input.server) throw unsupported("codex-cli does not support attachments or server overrides; configure a Codex profile instead.");
    const profile = input.metadata?.profile;
    if (profile !== undefined && (typeof profile !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(profile))) throw unsupported("Invalid Codex profile name.");
    const sandbox = input.metadata?.sandbox ?? "workspace";
    if (!["workspace", "read_only"].includes(String(sandbox))) throw unsupported("codex-cli sandbox must be read_only or workspace.");
    const data: Data = { dir: join(agentRuntimeDir(input.agent.run_id, input.agent.agent_id), "codex-cli"), cwd: input.agent.repo_dir ?? process.cwd(), profile: profile as string | undefined,
      model: input.model ?? input.agent.model ?? undefined, sandbox: sandbox === "read_only" ? "read-only" : "workspace-write", reasoning_effort: input.metadata?.reasoning_effort as string | undefined };
    mkdirSync(data.dir, { recursive: true, mode: 0o700 });
    if (existsSync(join(data.dir, "state.json"))) throw unsupported("This CLI worker already has an execution; continue its existing session instead.");
    if (data.profile) data.profile_hash = this.profileHash(data.profile);
    // Presentation only: never turn the profile's model into a CLI override.
    const identity = this.profileIdentity(data.profile);
    data.resolved_model = data.model ?? identity.model;
    data.model_provider = identity.provider;
    data.logFile = join(data.dir, "stderr.log");
    data.executable = process.env.AGENT_CONTROL_CODEX_CLI_BIN ?? "codex";
    if (typeof input.metadata?.permission_db_path === "string" && input.metadata.permission_db_path !== ":memory:") {
      data.access_agent_id = input.agent.agent_id; data.access_db_path = input.metadata.permission_db_path;
    }
    if (input.metadata?.approval_policy === "on-request") data.approval_policy = "on-request";
    if (data.approval_policy && !data.access_db_path) throw unsupported("Interactive CLI requires a persistent Agent Control database.");
    await this.launch(data, input.prompt ?? "", true, input.agentToken);
    return { backend: this.kind, id: input.agent.agent_id, data: { ...data } };
  }
  private profileIdentity(profile?: string): { model?: string; provider?: string } {
    const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const read = (path: string) => {
      try { return parseToml(readFileSync(path, "utf8")); } catch { return {}; }
    };
    const base = read(join(home, "config.toml"));
    const selected = profile ? read(join(home, `${profile}.config.toml`)) : {};
    // Only export identity strings for display/pricing; endpoints and authentication stay private.
    const model = selected.model ?? base.model;
    const provider = selected.model_provider ?? base.model_provider ?? "openai";
    return { model: typeof model === "string" && model.trim() ? model : undefined,
      provider: typeof provider === "string" && provider.trim() ? provider : undefined };
  }
  private profileHash(profile: string): string {
    const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), `${profile}.config.toml`);
    if (!existsSync(path)) throw unsupported("A persisted Codex profile file is required for managed CLI continuity.");
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  private async launch(data: Data, prompt: string, initial: boolean, agentToken?: string): Promise<string> {
    if (data.profile && this.profileHash(data.profile) !== data.profile_hash) throw unsupported("Codex profile changed since launch; review its model/provider before continuing.");
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", data.sandbox, "-c", 'approval_policy="never"'];
    if (data.profile) args.push("--profile", data.profile);
    if (data.model) args.push("--model", data.model);
    if (data.reasoning_effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(data.reasoning_effort)}`);
    const profilePath = data.profile ? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), `${data.profile}.config.toml`) : undefined;
    let interactiveRequested = Boolean(data.approval_policy);
    if (data.access_db_path && data.access_agent_id) {
      const db = new Database(data.access_db_path);
      try { interactiveRequested ||= Boolean(new AgentAccessStore(db).getAgentAccess(data.access_agent_id).requested); }
      finally { db.close(); }
    }
    if (interactiveRequested || (existsSync(join(data.dir, "state.json")) && this.state(data).transport === "app-server")) readInteractiveProfile(profilePath, data.profile_hash);
    if (agentToken) writeFileSync(join(data.dir, "credential"), agentToken, { mode: 0o600 });
    const job: CliJob = { executable: data.executable ?? process.env.AGENT_CONTROL_CODEX_CLI_BIN ?? "codex", args, cwd: data.cwd, prompt,
      ...(profilePath ? { profile_path: profilePath, profile_hash: data.profile_hash } : {}),
      ...(data.access_agent_id && data.access_db_path ? { interactive: { agent_id: data.access_agent_id, db_path: data.access_db_path,
        model: data.model, model_provider: data.model_provider, reasoning_effort: data.reasoning_effort,
        sandbox: data.sandbox === "read-only" ? "read_only" as const : "workspace" as const, approval_policy: data.approval_policy } } : {}) };
    const messageId = enqueueCliJob(data.dir, job, initial);
    // Each contender uses a process-owned lock. Enqueue and dispatch share a
    // separate short lock, so a finishing supervisor cannot lose a new message.
    const bundledRunner = fileURLToPath(new URL("./codex-cli-runner.js", import.meta.url));
    const runner = existsSync(bundledRunner) ? bundledRunner : fileURLToPath(new URL("../../dist/adapters/codex-cli-runner.js", import.meta.url));
    const env = { ...process.env };
    delete env.AGENT_CONTROL_TOKEN; delete env.AGENT_CONTROL_ADMIN_KEY;
    if (existsSync(join(data.dir, "credential"))) env.AGENT_CONTROL_TOKEN = readFileSync(join(data.dir, "credential"), "utf8");
    const child = spawn(process.execPath, [runner, "--supervise", data.dir], { detached: true, stdio: "ignore", env });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    if (initial) {
      for (let i = 0; i < 100; i++) {
        if (existsSync(join(data.dir, "ready"))) return messageId;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw unsupported("CLI supervisor did not acknowledge startup; inspect the existing execution before retrying.");
    }
    return messageId;
  }
  async sendMessage(handle: AgentHandle, message: AgentMessageInput): Promise<void> {
    await this.sendMessageWithReceipt(handle, message);
  }
  async sendMessageWithReceipt(handle: AgentHandle, message: AgentMessageInput) {
    const data = handle.data as unknown as Data;
    this.state(data); // Reject a stale active supervisor before accepting more work.
    const messageId = await this.launch(data, message.message, false);
    return { delivered: false as const, queued: true, message_id: messageId, orchestrator_action: null };
  }
  private state(data: Data): CliState {
    const state: CliState = JSON.parse(readFileSync(join(data.dir, "state.json"), "utf8"));
    if (state.status === "running" && Date.now() - Date.parse(state.updated_at) > 30_000) throw new ControllerError("CLI supervisor heartbeat is temporarily unavailable.", "backend_unavailable");
    return state;
  }
  async getStatus(handle: AgentHandle): Promise<AgentStatusSnapshot> {
    const data = handle.data as unknown as Data, state = this.state(data);
    let permissionId: string | undefined;
    if (state.status === "running" && data.access_db_path && data.access_agent_id) {
      const db = new Database(data.access_db_path);
      try { permissionId = new PermissionRequests(db).list([data.access_agent_id]).find(request => request.state === "pending" && request.thread_id === state.thread_id)?.request_id; }
      finally { db.close(); }
    }
    return { status: permissionId ? "waiting_for_input" : state.status, updatedAt: state.updated_at,
      data: { thread_id: state.thread_id, exit_code: state.exit_code, ...(permissionId ? { permission_request_id: permissionId, reason: "backend_permission_request" } : {}) } };
  }
  readUsage(handle: AgentHandle): AgentUsageObservation | null {
    const data = handle.data as unknown as Data;
    try {
      const state = JSON.parse(readFileSync(join(data.dir, "state.json"), "utf8"));
      const session = typeof state.thread_id === "string" ? readCodexSession(state.thread_id) : null;
      if (session?.usage) {
        if ((data.resolved_model && session.model !== data.resolved_model) || (data.model_provider && session.modelProvider !== data.model_provider)) return null;
        // The native ledger includes in-progress and interrupted requests too.
        // Interactive app-server completion events contain no CLI usage object.
        return sessionUsage({ ...handle, data: { thread_id: state.thread_id } });
      }
    } catch { /* Older CLI journals remain a supported, independently measured source. */ }
    const journal = join(data.dir, "events.jsonl");
    try {
      const turns = new Map<number, { input: number | null; output: number | null; cached: number | null; writes: number | null; reasoning: number | null }>();
      let generation = 0;
      const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      for (const line of readFileSync(journal, "utf8").split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "agent_control.prompt") generation++;
          const usage = event.type === "turn.completed" ? event.usage : undefined;
          if (event.type === "turn.completed") {
            // One CLI invocation owns one turn. Repeated completion records must
            // replace that turn, not charge it again. Cached input and reasoning
            // output are breakdowns of the reported input/output totals, not extras.
            turns.set(generation, { input: validCount(usage?.input_tokens) ? usage.input_tokens : null, output: validCount(usage?.output_tokens) ? usage.output_tokens : null,
              writes: validCount(usage?.cache_write_input_tokens) && validCount(usage?.input_tokens) && usage.cache_write_input_tokens <= usage.input_tokens ? usage.cache_write_input_tokens : null,
              cached: validCount(usage?.cached_input_tokens) && validCount(usage?.input_tokens) && usage.cached_input_tokens <= usage.input_tokens ? usage.cached_input_tokens : null,
              reasoning: validCount(usage?.reasoning_output_tokens) && validCount(usage?.output_tokens) && usage.reasoning_output_tokens <= usage.output_tokens ? usage.reasoning_output_tokens : null });
          }
        } catch { /* A partial trailing line is retried on the next observation. */ }
      }
      if (!turns.size) return null;
      const sum = (field: "input" | "output" | "cached" | "reasoning" | "writes"): number | null => {
        let total = 0;
        for (const turn of turns.values()) {
          const value = turn[field];
          if (value === null) return null; // Never present a partial history as a complete total.
          total += value;
        }
        return validCount(total) ? total : null;
      };
      const input = sum("input"), output = sum("output");
      if (input === null && output === null) return null;
      const total = input !== null && output !== null && validCount(input + output) ? input + output : null;
      return { input_tokens: input, output_tokens: output, total_tokens: total,
        cached_input_tokens: sum("cached"), cache_write_input_tokens: sum("writes"), reasoning_output_tokens: sum("reasoning"),
        context_used: null, context_limit: null, source: "codex-cli.turn.completed",
        model: data.resolved_model ?? data.model ?? null, captured_at: statSync(journal).mtime.toISOString() };
    } catch { return null; } // Missing historical journals remain unknown.
  }
  async readLatest(handle: AgentHandle, options: ReadLatestOptions): Promise<AgentMessage[]> {
    const data = handle.data as unknown as Data;
    const messages = new Map<string, AgentMessage>();
    let generation = 0;
    let turn = 0;
    let nativeThread: string | undefined;
    let nativeTurn: string | undefined;
    // Persisted chat stays readable even if its supervisor is unavailable.
    const state = JSON.parse(readFileSync(join(data.dir, "state.json"), "utf8")) as CliState;
    const updatedAt = state.updated_at;
    let failureGeneration = -1;
    for (const [index, line] of readFileSync(join(data.dir, "events.jsonl"), "utf8").split("\n").entries()) { try {
      const event = JSON.parse(line), item = event.item;
      if (event.type === "agent_control.prompt") generation++;
      if (event.type === "thread.started") nativeThread = event.thread_id;
      if (event.type === "turn.started") { turn++; nativeTurn = event.turn_id; }
      if (event.type === "agent_control.prompt") messages.set(`prompt-${index}`, { id: `prompt-${index}`, role: "user", text: event.text, created_at: event.created_at });
      if (event.type === "turn.failed" || (event.type === "agent_control.turn_finished" && event.status === "failed")) {
        failureGeneration = generation;
        messages.set(`failure-${generation}`, this.failureMessage(generation, updatedAt));
      }
      if (!item) continue;
      // Diagnostics and future unknown events are not tool invocations. Their raw
      // payload remains in the event journal and diagnostics in the technical log.
      if (!["agent_message", "todo_list", "command_execution", "mcp_tool_call", "web_search", "file_change", "collab_tool_call"].includes(item.type)) continue;
      const text = item.type === "agent_message" ? item.text : item.type === "todo_list" ? `update_plan\nInput: ${JSON.stringify({plan: item.items?.map((task: {text:string;completed:boolean}) => ({step:task.text,status:task.completed ? "completed" : "pending"}))})}` : `${item.tool ?? item.command ?? item.type}\nInput: ${JSON.stringify(item)}${item.aggregated_output ? `\n${item.aggregated_output}` : ""}`;
      const id = `${generation}:${turn}:${item.id ?? `event-${index}`}`;
      messages.set(id, { id, role: item.type === "agent_message" ? "assistant" : "tool", text, created_at: updatedAt, metadata: { turnId: `${generation}:${turn}`, type: item.type === "agent_message" ? "text" : "tool", itemType: item.type,
        ...(typeof nativeThread === "string" && typeof nativeTurn === "string" && typeof item.id === "string" ? { approval_identity: { thread_id: nativeThread, turn_id: nativeTurn, item_id: item.id } } : {}),
        ...(item.type !== "agent_message" ? { tool_activity: toolActivity(item, id, event.type) } : {}) } });
    } catch { /* Ignore incomplete trailing event while the process is writing. */ } }
    if (state.status === "failed" && failureGeneration !== generation) {
      messages.set(`failure-${generation}`, this.failureMessage(generation, updatedAt));
    }
    return [...messages.values()].slice(-options.limit);
  }
  private failureMessage(generation: number, created_at: string): AgentMessage {
    return { id: `failure-${generation}`, role: "system", text: "The agent could not complete this turn. See Logs for technical details.", created_at, metadata: { type: "text", itemType: "turn.failed" } };
  }
  async interrupt(handle: AgentHandle): Promise<StopResult> {
    return this.stop(handle, { mode: "interrupt" });
  }
  async stop(handle: AgentHandle, options: StopOptions): Promise<StopResult> {
    const data = handle.data as unknown as Data;
    const target = requestCliStop(data.dir, options.mode);
    for (let i = 0; i < 50; i++) {
      const state = this.state(data);
      const settled = target === "legacy"
        ? state.status !== "running" && !existsSync(join(data.dir, "active"))
        : !target || state.turn_id !== target || state.status !== "running";
      if (settled) return { status: state.status };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw unsupported("CLI stop is still pending; inspect status or explicitly request kill.");
  }
  watchStatus(handle: AgentHandle, onChange: (snapshot: AgentStatusSnapshot) => void | Promise<void>): () => void {
    let previous = "", busy = false;
    const timer = setInterval(async () => { if (busy) return; busy=true; try { const snapshot = await this.getStatus(handle), signature=JSON.stringify({status:snapshot.status,data:snapshot.data}); if (signature !== previous) { previous=signature; await onChange(snapshot); } } catch { /* Runtime may have been purged; controller owns diagnostics. */ } finally { busy=false; } }, 1000);
    timer.unref(); return () => clearInterval(timer);
  }
}
