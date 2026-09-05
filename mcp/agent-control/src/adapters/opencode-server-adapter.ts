import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRuntimeDir, defaultControlHome } from "../core/paths.js";
import { ControllerError } from "../core/errors.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHandle,
  AgentMessage,
  AgentMessageInput,
  AgentStatus,
  AgentStatusSnapshot,
  FailureReason,
  ReadLatestOptions,
  StartAgentInput,
  StopOptions,
  StopResult
} from "../core/types.js";

const CAPABILITIES: AgentCapabilities = {
  canStart: true,
  canSendMessage: true,
  canReadLatest: true,
  canStopGracefully: true,
  canForceStop: true,
  canStreamMessages: false,
  canInspectStatusCheaply: true,
  canAttachExisting: true
};

const OPENCODE_STATUS_TIMEOUT_MS = 2500;
const OPENCODE_FETCH_TIMEOUT_MS = 5000;

interface OpenCodeModel {
  providerID: string;
  modelID: string;
  variant?: string;
}

interface OpenCodeHandleData {
  server: string;
  model: string;
  title: string;
  repoDir: string;
  pidFile: string;
  logFile: string;
  exitFile?: string;
  metadataFile: string;
  expectedArtifacts: string[];
  sessionId?: string;
  serverAutoStarted?: boolean;
  serverPid?: number;
  serverLogFile?: string;
  metadata?: Record<string, unknown>;
}

interface ServerEnsureResult {
  reachable: boolean;
  started: boolean;
  pid?: number;
  logFile?: string;
}

export class OpenCodeServerAdapter implements AgentAdapter {
  readonly kind = "opencode-server";
  private readonly children = new Map<string, ChildProcess>();

  capabilities(): AgentCapabilities {
    return CAPABILITIES;
  }

  async start(input: StartAgentInput): Promise<AgentHandle> {
    const server = requiredString(input.server ?? input.metadata?.server, "server");
    const repoDir = requiredString(input.agent.repo_dir, "repo_dir");
    const model = requiredString(input.model ?? input.agent.model, "model");
    const prompt = requiredString(input.prompt, "prompt");
    const runtimeDir = agentRuntimeDir(input.agent.run_id, input.agent.agent_id);
    const logFile = join(runtimeDir, "opencode.log");
    const pidFile = join(runtimeDir, "opencode.pid");
    const exitFile = join(runtimeDir, "opencode-exit.json");
    const metadataFile = join(runtimeDir, "opencode-launch.json");
    const expectedArtifacts = input.expectedArtifacts ?? [];
    const attachments = input.attachments ?? [];

    assertOpenCodeAvailable();
    const serverEnsure = await ensureServerReachable(server);

    for (const attachment of attachments) {
      if (!existsSync(attachment)) {
        throw new ControllerError("OpenCode attachment does not exist.", "tool_error", { attachment });
      }
    }

    mkdirSync(runtimeDir, { recursive: true });
    const openCodeModel = parseOpenCodeModel(model);
    const session = await createOpenCodeSession(server, {
      title: input.agent.title,
      repoDir,
      model: openCodeModel,
      metadata: {
        ...(input.metadata ?? {}),
        agentControlAgentId: input.agent.agent_id,
        agentControlRunId: input.agent.run_id
      }
    });
    await sendOpenCodePromptAsync(server, session.id, {
      model: openCodeModel,
      prompt,
      attachments
    });

    writeFileSync(pidFile, "\n", "utf8");
    writeFileSync(
      logFile,
      [
        `OpenCode session ${session.id} started through the server API.`,
        `Server: ${server}`,
        `Repository: ${repoDir}`,
        `Title: ${input.agent.title}`
      ].join("\n") + "\n",
      "utf8"
    );

    const data: OpenCodeHandleData = {
      server,
      model,
      title: input.agent.title,
      repoDir,
      pidFile,
      logFile,
      exitFile,
      metadataFile,
      expectedArtifacts,
      sessionId: session.id,
      serverAutoStarted: serverEnsure.started,
      serverPid: serverEnsure.pid,
      serverLogFile: serverEnsure.logFile,
      metadata: input.metadata ?? {}
    };
    writeFileSync(
      metadataFile,
      JSON.stringify(
        {
          backend: this.kind,
          server,
          model,
          title: input.agent.title,
          repoDir,
          pidFile,
          logFile,
          exitFile,
          expectedArtifacts,
          sessionId: session.id,
          serverAutoStarted: serverEnsure.started,
          serverPid: serverEnsure.pid,
          serverLogFile: serverEnsure.logFile,
          metadata: input.metadata ?? {},
          attachments: attachments.map((attachment) => basename(attachment)),
          commandShape: "POST /session?directory=<repo>, then POST /session/<sessionId>/prompt_async"
        },
        null,
        2
      ),
      "utf8"
    );

    return {
      backend: this.kind,
      id: input.agent.agent_id,
      data: data as unknown as Record<string, unknown>
    };
  }

  async sendMessage(handle: AgentHandle, message: AgentMessageInput): Promise<void> {
    const data = parseHandle(handle);
    const model = parseOpenCodeModel(data.model);
    assertOpenCodeAvailable();
    await ensureServerReachable(data.server);
    const sessionId = data.sessionId ?? (await findSessionId(data));
    if (!sessionId) {
      throw new ControllerError("OpenCode session could not be found for follow-up message.", "tool_error", {
        title: data.title,
        repoDir: data.repoDir
      });
    }

    await sendOpenCodePromptAsync(data.server, sessionId, {
      model,
      prompt: message.message,
      attachments: []
    });
  }

  async getStatus(handle: AgentHandle): Promise<AgentStatusSnapshot> {
    const data = parseHandle(handle);
    const serverAvailable = await isServerReachable(data.server);
    const pid = readPid(data.pidFile);
    const pidRunning = pid ? isProcessRunning(pid) : false;
    const artifactReady = data.expectedArtifacts.some((artifact) => fileHasBytes(artifact));
    const logBytes = fileBytes(data.logFile);
    const exitInfo = data.exitFile ? readExitInfo(data.exitFile) : null;

    let status: AgentStatus = "unknown";
    let failureReason: FailureReason | undefined;
    let message = "";

    const sessionId = data.sessionId ?? (serverAvailable ? await findSessionId(data) : undefined);
    if (serverAvailable && sessionId) {
      const sessionMessages = await fetchOpenCodeMessages(data.server, sessionId);
      const sessionState = summarizeOpenCodeSession(sessionMessages);
      if (sessionState.error) {
        status = "failed";
        failureReason = "worker_reported_blocker";
        message = "OpenCode session ended with an assistant error.";
      } else if (sessionState.completed) {
        if (data.expectedArtifacts.length === 0 || artifactReady) {
          status = "completed";
          message = data.expectedArtifacts.length === 0
            ? "OpenCode session completed."
            : "OpenCode session completed and at least one expected artifact exists.";
        } else {
          status = "failed";
          failureReason = "missing_artifact";
          message = "OpenCode session completed but did not create an expected artifact.";
        }
      } else {
        status = "running";
        message = "OpenCode session is running.";
      }
      return {
        status,
        failureReason,
        message,
        data: {
          pid,
          pidRunning,
          logFile: data.logFile,
          logBytes,
          exitInfo,
          serverAvailable,
          sessionId,
          latestAssistantMessageId: sessionState.latestAssistantMessageId,
          latestAssistantCompletedAt: sessionState.latestAssistantCompletedAt,
          metadata: data.metadata ?? {}
        }
      };
    }

    if (pidRunning) {
      status = "running";
      message = "OpenCode process is running.";
    } else if (artifactReady) {
      status = "completed";
      message = "OpenCode process stopped and at least one expected artifact exists.";
    } else if (exitInfo?.code === 0 && data.expectedArtifacts.length === 0) {
      status = "completed";
      message = "OpenCode process exited successfully.";
    } else if (exitInfo?.code === 0) {
      status = "failed";
      failureReason = "missing_artifact";
      message = "OpenCode process exited successfully but did not create an expected artifact.";
    } else if (exitInfo) {
      status = "failed";
      failureReason = "tool_error";
      message = "OpenCode process exited without satisfying expected artifacts.";
    } else if (pid && data.expectedArtifacts.length === 0 && logBytes > 0) {
      status = "unknown";
      message = "OpenCode process stopped and exit metadata is not ready yet.";
    } else if (pid && logBytes > 0) {
      status = "failed";
      failureReason = "missing_artifact";
      message = "OpenCode process stopped with log output but no expected artifact.";
    } else if (pid) {
      status = "failed";
      failureReason = "tool_error";
      message = "OpenCode process stopped without an expected artifact.";
    } else if (!serverAvailable) {
      status = "failed";
      failureReason = "backend_unavailable";
      message = "OpenCode server is unreachable.";
    }

    return {
      status,
      failureReason,
      message,
      data: {
        pid,
        pidRunning,
        logFile: data.logFile,
        logBytes,
        exitInfo,
        serverAvailable,
        sessionId,
        metadata: data.metadata ?? {}
      }
    };
  }

  async readLatest(handle: AgentHandle, options: ReadLatestOptions): Promise<AgentMessage[]> {
    const data = parseHandle(handle);
    if (!(await isServerReachable(data.server))) {
      return [openCodeLogTailMessage(data.logFile)];
    }

    const sessionId = data.sessionId ?? (await findSessionId(data));
    if (!sessionId) {
      return [openCodeLogTailMessage(data.logFile)];
    }

    const payload = await fetchOpenCodeMessages(data.server, sessionId);
    const messages = normalizeOpenCodeMessages(payload, options.limit);
    if (messages.length > 0) {
      return messages;
    }

    return [openCodeLogTailMessage(data.logFile)];
  }

  async stop(handle: AgentHandle, options: StopOptions): Promise<StopResult> {
    const data = parseHandle(handle);
    const abortResult = await abortOpenCodeSession(data);
    const pid = readPid(data.pidFile);
    if (!pid) {
      return {
        status: "stopped",
        message: abortResult.sessionId ? "OpenCode session abort requested; no local PID recorded." : "No PID file or empty PID.",
        data: { abortResult }
      };
    }

    if (!isProcessRunning(pid)) {
      return { status: "stopped", message: "Process is already stopped.", data: { pid, abortResult } };
    }

    signalProcessTree(pid, options.mode === "interrupt" ? "SIGINT" : "SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessRunning(pid)) {
      await sleep(250);
    }

    if (isProcessRunning(pid) && options.mode === "kill") {
      signalProcessTree(pid, "SIGKILL");
      const killDeadline = Date.now() + 2000;
      while (Date.now() < killDeadline && isProcessRunning(pid)) {
        await sleep(100);
      }
    }

    return {
      status: isProcessRunning(pid) ? "stopping" : "stopped",
      message: isProcessRunning(pid)
        ? "OpenCode session abort requested; local process signal sent but process is still running."
        : "OpenCode session abort requested and local process stopped.",
      data: { pid, abortResult }
    };
  }

  watchStatus(
    handle: AgentHandle,
    onChange: (snapshot: AgentStatusSnapshot) => void | Promise<void>
  ): () => void {
    const child = this.children.get(handle.id);
    if (!child) {
      return () => undefined;
    }

    const onExit = (): void => {
      setTimeout(() => {
        void this.getStatus(handle).then(onChange);
      }, 250).unref();
    };
    child.once("exit", onExit);
    return () => {
      child.off("exit", onExit);
    };
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ControllerError(`Missing required OpenCode field: ${field}`, "tool_error", { field });
  }
  return value;
}

function assertOpenCodeAvailable(): void {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new ControllerError("opencode CLI is not available on PATH.", "backend_unavailable", {
      error: result.error?.message,
      status: result.status,
      stderr: result.stderr
    });
  }
}

function parseHandle(handle: AgentHandle): OpenCodeHandleData {
  return handle.data as unknown as OpenCodeHandleData;
}

async function ensureServerReachable(server: string): Promise<ServerEnsureResult> {
  const localServer = parseLocalServer(server);
  if (localServer) {
    removeLegacyLaunchAgent(localServer.port);
  }

  if (await isServerReachable(server)) {
    return { reachable: true, started: false };
  }

  if (!localServer) {
    throw new ControllerError("OpenCode server is unreachable.", "backend_unavailable", { server });
  }

  const started = startLocalServer(server, localServer);
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await isServerReachable(server)) {
      return {
        reachable: true,
        started: true,
        pid: started.pid,
        logFile: started.logFile
      };
    }
    await sleep(250);
  }

  throw new ControllerError("OpenCode local server did not become reachable after start.", "backend_unavailable", {
    server,
    pid: started.pid,
    logFile: started.logFile
  });
}

function parseLocalServer(server: string): { hostname: string; port: string } | null {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return null;
  }

  if (url.protocol !== "http:") {
    return null;
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(hostname)) {
    return null;
  }

  const port = url.port || "80";
  return {
    hostname: hostname === "127.0.0.1" || hostname === "::1" ? "localhost" : hostname,
    port
  };
}

function startLocalServer(
  server: string,
  localServer: { hostname: string; port: string }
): { pid?: number; logFile: string } {
  const serverDir = join(defaultControlHome(), "servers");
  mkdirSync(serverDir, { recursive: true });
  const safePort = localServer.port.replace(/[^0-9]/g, "") || "unknown";
  const logFile = join(serverDir, `opencode-${safePort}.log`);
  const pidFile = join(serverDir, `opencode-${safePort}.pid`);

  const fd = openSync(logFile, "a");
  const child = spawn("opencode", ["serve", "--hostname", localServer.hostname, "--port", localServer.port], {
    detached: true,
    stdio: ["ignore", fd, fd]
  });
  child.unref();
  closeSync(fd);
  writeFileSync(pidFile, `${child.pid ?? ""}\n`, "utf8");
  writeFileSync(
    join(serverDir, `opencode-${safePort}.json`),
    JSON.stringify({ server, pid: child.pid, logFile, startedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
  return { pid: child.pid, logFile };
}

function removeLegacyLaunchAgent(port: string): void {
  if (process.platform !== "darwin" || !existsSync("/bin/launchctl")) {
    return;
  }

  const home = process.env.HOME ?? "";
  const safePort = port.replace(/[^0-9]/g, "") || "unknown";
  const label = `com.codex.agent-control.opencode.${safePort}`;
  const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

  if (uid !== undefined) {
    spawnSync("launchctl", ["bootout", `gui/${uid}`, plist], { stdio: "ignore" });
    spawnSync("launchctl", ["remove", `gui/${uid}/${label}`], { stdio: "ignore" });
  }
  spawnSync("launchctl", ["remove", label], { stdio: "ignore" });

  if (existsSync(plist)) {
    try {
      unlinkSync(plist);
    } catch {
      // A stale LaunchAgent plist is non-fatal; starting the worker should not
      // fail solely because cleanup of old controller state was denied.
    }
  }
}

async function isServerReachable(server: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${trimSlash(server)}/session/status`, {}, OPENCODE_STATUS_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}

async function findSessionId(data: OpenCodeHandleData): Promise<string | undefined> {
  try {
    const response = await fetchWithTimeout(`${trimSlash(data.server)}/session`);
    if (!response.ok) {
      return undefined;
    }
    const sessions = (await response.json()) as Array<Record<string, unknown>>;
    const matches = sessions.filter((session) => sessionMatchesHandle(session, data));
    matches.sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
    const match = matches[0];
    return typeof match?.id === "string" ? match.id : undefined;
  } catch {
    return undefined;
  }
}

async function createOpenCodeSession(
  server: string,
  input: {
    title: string;
    repoDir: string;
    model: OpenCodeModel;
    metadata: Record<string, unknown>;
  }
): Promise<{ id: string }> {
  const url = new URL(`${trimSlash(server)}/session`);
  url.searchParams.set("directory", input.repoDir);
  const response = await fetchWithTimeout(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      agent: "build",
      model: {
        id: input.model.modelID,
        providerID: input.model.providerID,
        ...(input.model.variant ? { variant: input.model.variant } : {})
      },
      metadata: input.metadata,
      permission: [{ permission: "*", pattern: "*", action: "allow" }]
    })
  });
  if (!response.ok) {
    throw new ControllerError("OpenCode session creation failed.", "tool_error", {
      status: response.status,
      body: await safeResponseText(response)
    });
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (typeof payload.id !== "string" || !payload.id.startsWith("ses")) {
    throw new ControllerError("OpenCode session creation returned no session id.", "tool_error", { payload });
  }
  return { id: payload.id };
}

async function sendOpenCodePromptAsync(
  server: string,
  sessionId: string,
  input: { model: OpenCodeModel; prompt: string; attachments: string[] }
): Promise<void> {
  const response = await fetchWithTimeout(`${trimSlash(server)}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: {
        providerID: input.model.providerID,
        modelID: input.model.modelID
      },
      agent: "build",
      ...(input.model.variant ? { variant: input.model.variant } : {}),
      parts: buildPromptParts(input.prompt, input.attachments)
    })
  });
  if (!response.ok) {
    throw new ControllerError("OpenCode prompt dispatch failed.", "tool_error", {
      sessionId,
      status: response.status,
      body: await safeResponseText(response)
    });
  }
}

async function fetchOpenCodeMessages(server: string, sessionId: string): Promise<unknown[]> {
  const response = await fetchWithTimeout(`${trimSlash(server)}/session/${encodeURIComponent(sessionId)}/message`);
  if (!response.ok) {
    throw new ControllerError("OpenCode messages request failed.", "tool_error", {
      sessionId,
      status: response.status,
      body: await safeResponseText(response)
    });
  }
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? payload : [];
}

async function abortOpenCodeSession(
  data: OpenCodeHandleData
): Promise<{ sessionId?: string; requested: boolean; ok: boolean; status?: number; error?: string }> {
  if (!(await isServerReachable(data.server))) {
    return { requested: false, ok: false, error: "server_unreachable" };
  }
  const sessionId = data.sessionId ?? (await findSessionId(data));
  if (!sessionId) {
    return { requested: false, ok: false, error: "session_not_found" };
  }

  try {
    const response = await fetchWithTimeout(`${trimSlash(data.server)}/session/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST"
    });
    return { sessionId, requested: true, ok: response.ok, status: response.status };
  } catch (error) {
    return {
      sessionId,
      requested: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = OPENCODE_FETCH_TIMEOUT_MS
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs)
  });
}

function sessionMatchesHandle(session: Record<string, unknown>, data: OpenCodeHandleData): boolean {
  const titleMatches = session.title === data.title;
  const directory = session.directory ?? session.cwd ?? session.path;
  const dirMatches = typeof directory === "string" ? directory === data.repoDir : true;
  return titleMatches && dirMatches;
}

function sessionTimestamp(session: Record<string, unknown>): number {
  const time = session.time && typeof session.time === "object" ? (session.time as Record<string, unknown>) : {};
  const candidates = [time.updated, time.created, session.updated, session.created];
  for (const candidate of candidates) {
    if (typeof candidate === "number") {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

function parseOpenCodeModel(model: string): OpenCodeModel {
  const [providerID, rest] = model.split("/", 2);
  if (!providerID || !rest) {
    throw new ControllerError("OpenCode model must use provider/model format.", "tool_error", { model });
  }
  const [modelID, variant] = rest.split(":", 2);
  return {
    providerID,
    modelID,
    ...(variant ? { variant } : {})
  };
}

function buildPromptParts(prompt: string, attachments: string[]): Array<Record<string, unknown>> {
  return [
    { type: "text", text: prompt },
    ...attachments.map((attachment) => ({
      type: "file",
      mime: guessMimeType(attachment),
      filename: basename(attachment),
      url: pathToFileURL(attachment).href
    }))
  ];
}

function guessMimeType(path: string): string {
  const lowered = path.toLowerCase();
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) return "image/jpeg";
  if (lowered.endsWith(".gif")) return "image/gif";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".json")) return "application/json";
  if (lowered.endsWith(".md") || lowered.endsWith(".markdown")) return "text/markdown";
  return "text/plain";
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall back to the direct process when the process group is unavailable.
  }
  try {
    process.kill(pid, signal);
  } catch {
    return;
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function openCodeLogTailMessage(logFile: string): AgentMessage {
  return {
    id: `log-${Date.now()}`,
    role: "system",
    text: tailFile(logFile, 4000),
    created_at: new Date().toISOString(),
    metadata: { source: "opencode-log-tail" }
  };
}

function writeExitInfo(exitFile: string, code: number | null, signal: NodeJS.Signals | null): void {
  writeFileSync(
    exitFile,
    JSON.stringify({ code, signal, exitedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function readPid(pidFile: string): number | null {
  try {
    const value = readFileSync(pidFile, "utf8").trim();
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readExitInfo(exitFile: string): { code: number | null; signal: string | null; exitedAt: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(exitFile, "utf8")) as {
      code?: unknown;
      signal?: unknown;
      exitedAt?: unknown;
    };
    return {
      code: typeof parsed.code === "number" ? parsed.code : null,
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
      exitedAt: typeof parsed.exitedAt === "string" ? parsed.exitedAt : ""
    };
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fileHasBytes(path: string): boolean {
  return fileBytes(path) > 0;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function tailFile(path: string, maxChars: number): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.slice(Math.max(0, text.length - maxChars));
  } catch {
    return "";
  }
}

function normalizeOpenCodeMessages(payload: unknown, limit: number): AgentMessage[] {
  const values = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { messages?: unknown[] }).messages)
      ? (payload as { messages: unknown[] }).messages
      : [];

  const messages = values.flatMap((raw, index) => normalizeOpenCodeMessage(raw, index));
  return messages.slice(-limit);
}

function normalizeOpenCodeMessage(raw: unknown, index: number): AgentMessage[] {
  const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const info = item.info && typeof item.info === "object" ? (item.info as Record<string, unknown>) : item;
  const parts = Array.isArray(item.parts) ? item.parts : [];
  const role = normalizeMessageRole(typeof info.role === "string" ? info.role : item.role);
  const messageId = typeof info.id === "string" ? info.id : typeof item.id === "string" ? item.id : `message-${index}`;
  const createdAt = isoFromOpenCodeTime(readNested(info, ["time", "created"]) ?? item.created_at ?? item.createdAt) ?? new Date().toISOString();
  const completedAt = isoFromOpenCodeTime(readNested(info, ["time", "completed"]));
  const metadataBase = {
    source: "opencode-session-api",
    sessionId: stringFieldOrUndefined(info.sessionID),
    messageId,
    completedAt,
    tokens: info.tokens
  };

  if (parts.length === 0) {
    const fallbackText =
      typeof item.text === "string"
        ? item.text
        : typeof item.content === "string"
          ? item.content
          : "";
    return fallbackText.trim().length > 0
      ? [
          {
            id: messageId,
            role,
            text: fallbackText,
            created_at: createdAt,
            metadata: metadataBase
          }
        ]
      : [];
  }

  return parts
    .flatMap((part, partIndex) => normalizeOpenCodePart(part, {
      createdAt,
      index,
      messageId,
      metadataBase,
      partIndex,
      role
    }))
    .filter((message) => message.text.trim().length > 0);
}

function normalizeMessageRole(role: unknown): string {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }
  return "assistant";
}

function normalizeOpenCodePart(
  rawPart: unknown,
  context: {
    createdAt: string;
    index: number;
    messageId: string;
    metadataBase: Record<string, unknown>;
    partIndex: number;
    role: string;
  }
): AgentMessage[] {
  const part = rawPart && typeof rawPart === "object" ? (rawPart as Record<string, unknown>) : {};
  const partType = typeof part.type === "string" ? part.type : "unknown";
  const partId = typeof part.id === "string" ? part.id : `${context.messageId}-part-${context.partIndex}`;
  const createdAt = isoFromOpenCodeTime(readNested(part, ["time", "start"])) ?? context.createdAt;
  const metadata = {
    ...context.metadataBase,
    partId,
    type: partType,
    kind: partType
  };

  if (partType === "text" || partType === "reasoning") {
    return [
      {
        id: partId,
        role: context.role,
        text: typeof part.text === "string" ? part.text : "",
        created_at: createdAt,
        metadata
      }
    ];
  }

  if (partType === "tool") {
    return [
      {
        id: partId,
        role: "tool",
        text: formatToolPart(part),
        created_at: createdAt,
        metadata: {
          ...metadata,
          tool: part.tool,
          callID: part.callID,
          stateStatus: readNested(part, ["state", "status"])
        }
      }
    ];
  }

  if (partType === "file") {
    return [
      {
        id: partId,
        role: context.role,
        text: formatFilePart(part),
        created_at: createdAt,
        metadata
      }
    ];
  }

  return [];
}

function summarizeOpenCodeSession(messages: unknown[]): {
  completed: boolean;
  error: boolean;
  latestAssistantMessageId?: string;
  latestAssistantCompletedAt?: string;
} {
  const assistantMessages = messages
    .map((raw) => (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}))
    .map((item) => (item.info && typeof item.info === "object" ? (item.info as Record<string, unknown>) : item))
    .filter((info) => info.role === "assistant");
  const latest = assistantMessages.at(-1);
  if (!latest) {
    return { completed: false, error: false };
  }
  const completedAt = isoFromOpenCodeTime(readNested(latest, ["time", "completed"]));
  return {
    completed: Boolean(completedAt),
    error: Boolean(latest.error),
    latestAssistantMessageId: stringFieldOrUndefined(latest.id),
    latestAssistantCompletedAt: completedAt
  };
}

function formatToolPart(part: Record<string, unknown>): string {
  const state = part.state && typeof part.state === "object" ? (part.state as Record<string, unknown>) : {};
  const status = typeof state.status === "string" ? state.status : "unknown";
  const title = typeof state.title === "string" ? state.title : undefined;
  const output = typeof state.output === "string" ? state.output : undefined;
  const error = typeof state.error === "string" ? state.error : undefined;
  const input = state.input && typeof state.input === "object" ? JSON.stringify(state.input, null, 2) : undefined;
  return truncateText(
    [
      `Tool: ${String(part.tool ?? "unknown")}`,
      `Status: ${status}`,
      title ? `Title: ${title}` : null,
      error ? `Error: ${error}` : null,
      output ? `Output:\n${output}` : null,
      input ? `Input:\n${input}` : null
    ]
      .filter(Boolean)
      .join("\n\n"),
    12000
  );
}

function formatFilePart(part: Record<string, unknown>): string {
  const label = [part.filename, part.mime].filter((value) => typeof value === "string").join(" ");
  const url = typeof part.url === "string" ? part.url : "";
  return [label || "File attachment", url].filter(Boolean).join("\n");
}

function safeResponseText(response: Response): Promise<string> {
  return response.text().then((text) => truncateText(text, 4000)).catch(() => "");
}

function readNested(source: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringFieldOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isoFromOpenCodeTime(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n\n[truncated]` : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
