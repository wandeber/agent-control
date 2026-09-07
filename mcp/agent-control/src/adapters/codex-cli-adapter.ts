import { parse as parseToml } from "smol-toml";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControllerError } from "../core/errors.js";
import { agentRuntimeDir } from "../core/paths.js";
import type { AgentUsageObservation, AgentAdapter, AgentHandle, AgentMessage, AgentMessageInput, AgentStatusSnapshot, StartAgentInput, ReadLatestOptions, StopOptions, StopResult } from "../core/types.js";
import { writeState, type CliJob, type CliState } from "./codex-cli-runner.js";

interface Data { dir: string; cwd: string; profile?: string; model?: string; sandbox: string; reasoning_effort?: string; profile_hash?: string; resolved_model?: string; logFile?: string; }
const unsupported = (message: string) => new ControllerError(message, "unsupported_operation");
export class CodexCliAdapter implements AgentAdapter {
  readonly kind = "codex-cli";
  capabilities() { return { canStart: true, canSendMessage: true, canReadLatest: true, canStopGracefully: true, canForceStop: true, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: false }; }
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
    data.resolved_model = data.model ?? this.profileModel(data.profile);
    data.logFile = join(data.dir, "stderr.log");
    await this.launch(data, input.prompt ?? "", undefined, input.agentToken);
    return { backend: this.kind, id: input.agent.agent_id, data: { ...data } };
  }
  private profileModel(profile?: string): string | undefined {
    const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const read = (path: string) => {
      try { return parseToml(readFileSync(path, "utf8")); } catch { return {}; }
    };
    const base = read(join(home, "config.toml"));
    const selected = profile ? read(join(home, `${profile}.config.toml`)) : {};
    // Only export the model string; provider/auth configuration stays private.
    const model = selected.model ?? base.model;
    return typeof model === "string" && model.trim() ? model : undefined;
  }
  private profileHash(profile: string): string {
    const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), `${profile}.config.toml`);
    if (!existsSync(path)) throw unsupported("A persisted Codex profile file is required for managed CLI continuity.");
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  private async launch(data: Data, prompt: string, session?: string, agentToken?: string): Promise<void> {
    if (data.profile && this.profileHash(data.profile) !== data.profile_hash) throw unsupported("Codex profile changed since launch; review its model/provider before continuing.");
    try { mkdirSync(join(data.dir, "active")); } catch { throw unsupported("CLI worker already has an active turn. Wait before continuing."); }
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", data.sandbox, "-c", 'approval_policy="never"'];
    if (data.profile) args.push("--profile", data.profile);
    if (data.model) args.push("--model", data.model);
    if (data.reasoning_effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(data.reasoning_effort)}`);
    if (session) args.push("resume", session);
    args.push("-");
    if (agentToken) writeFileSync(join(data.dir, "credential"), agentToken, { mode: 0o600 });
    rmSync(join(data.dir, "ready"), { force: true });
    rmSync(join(data.dir, "cancelled"), { force: true });
    rmSync(join(data.dir, "stop.json"), { force: true });
    const job: CliJob = { executable: process.env.AGENT_CONTROL_CODEX_CLI_BIN ?? "codex", args, cwd: data.cwd, prompt };
    writeState(data.dir, { status: "running", thread_id: session, updated_at: new Date().toISOString() });
    writeFileSync(join(data.dir, "job.json"), JSON.stringify(job), { mode: 0o600 });
    appendFileSync(join(data.dir, "events.jsonl"), JSON.stringify({ type: "agent_control.prompt", text: prompt, created_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    // A separate Node supervisor survives disposal/reload of the MCP process.
    const bundledRunner = fileURLToPath(new URL("./codex-cli-runner.js", import.meta.url));
    const runner = existsSync(bundledRunner) ? bundledRunner : fileURLToPath(new URL("../../dist/adapters/codex-cli-runner.js", import.meta.url));
    const env = { ...process.env };
    delete env.AGENT_CONTROL_TOKEN; delete env.AGENT_CONTROL_ADMIN_KEY;
    if (existsSync(join(data.dir, "credential"))) env.AGENT_CONTROL_TOKEN = readFileSync(join(data.dir, "credential"), "utf8");
    const child = spawn(process.execPath, [runner, "--supervise", data.dir], { detached: true, stdio: "ignore", env });
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      for (let i=0;i<100;i++) {
        if (existsSync(join(data.dir, "ready"))) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw unsupported("CLI supervisor did not acknowledge startup.");
    } catch (error) {
      // Cancellation is fenced on disk before signaling our owned supervisor.
      // Keep the active lock until it acknowledges exit, preventing late starts.
      writeFileSync(join(data.dir, "cancelled"), "cancelled", { mode: 0o600 });
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await exited;
      }
      writeState(data.dir, { status: "failed", thread_id: session, updated_at: new Date().toISOString() });
      rmSync(join(data.dir, "active"), { recursive: true, force: true });
      throw error;
    }
  }
  async sendMessage(handle: AgentHandle, message: AgentMessageInput): Promise<void> {
    const data = handle.data as unknown as Data, state = this.state(data);
    if (state.status === "running") throw unsupported("CLI worker is busy; wait for its current turn before continuing.");
    if (!state.thread_id || !/^[a-zA-Z0-9-]+$/.test(state.thread_id)) throw unsupported("CLI worker has no persisted session ID to resume.");
    await this.launch(data, message.message, state.thread_id);
  }
  private state(data: Data): CliState {
    const state: CliState = JSON.parse(readFileSync(join(data.dir, "state.json"), "utf8"));
    if (state.status === "running" && Date.now() - Date.parse(state.updated_at) > 30_000) throw new ControllerError("CLI supervisor heartbeat is temporarily unavailable.", "backend_unavailable");
    return state;
  }
  async getStatus(handle: AgentHandle): Promise<AgentStatusSnapshot> { const state = this.state(handle.data as unknown as Data); return { status: state.status, updatedAt: state.updated_at, data: { thread_id: state.thread_id, exit_code: state.exit_code } }; }
  readUsage(handle: AgentHandle): AgentUsageObservation | null {
    const data = handle.data as unknown as Data;
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
    // Persisted chat stays readable even if its supervisor is unavailable.
    const state = JSON.parse(readFileSync(join(data.dir, "state.json"), "utf8")) as CliState;
    const updatedAt = state.updated_at;
    let failureGeneration = -1;
    for (const [index, line] of readFileSync(join(data.dir, "events.jsonl"), "utf8").split("\n").entries()) { try {
      const event = JSON.parse(line), item = event.item;
      if (event.type === "agent_control.prompt") generation++;
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
      const id = `${generation}:${item.id ?? `event-${index}`}`;
      messages.set(id, { id, role: item.type === "agent_message" ? "assistant" : "tool", text, created_at: updatedAt, metadata: { type: item.type === "agent_message" ? "text" : "tool", itemType: item.type } });
    } catch { /* Ignore incomplete trailing event while the process is writing. */ } }
    if (state.status === "failed" && failureGeneration !== generation) {
      messages.set(`failure-${generation}`, this.failureMessage(generation, updatedAt));
    }
    return [...messages.values()].slice(-options.limit);
  }
  private failureMessage(generation: number, created_at: string): AgentMessage {
    return { id: `failure-${generation}`, role: "system", text: "The agent could not complete this turn. See Logs for technical details.", created_at, metadata: { type: "text", itemType: "turn.failed" } };
  }
  async stop(handle: AgentHandle, options: StopOptions): Promise<StopResult> {
    const data = handle.data as unknown as Data;
    if (this.state(data).status !== "running") return { status: this.state(data).status };
    writeFileSync(join(data.dir, "stop.json"), JSON.stringify(options), { mode: 0o600 });
    for (let i=0;i<50;i++) { await new Promise(resolve => setTimeout(resolve, 100)); if (this.state(data).status !== "running") return { status: this.state(data).status }; }
    throw unsupported("CLI stop is still pending; inspect status or explicitly request kill.");
  }
  watchStatus(handle: AgentHandle, onChange: (snapshot: AgentStatusSnapshot) => void | Promise<void>): () => void {
    let previous = "", busy = false;
    const timer = setInterval(async () => { if (busy) return; busy=true; try { const snapshot = await this.getStatus(handle), signature=JSON.stringify({status:snapshot.status,data:snapshot.data}); if (signature !== previous) { previous=signature; await onChange(snapshot); } } catch { /* Runtime may have been purged; controller owns diagnostics. */ } finally { busy=false; } }, 1000);
    timer.unref(); return () => clearInterval(timer);
  }
}
