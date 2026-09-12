import { AgentAccessStore, accessTurnOverrides } from "../core/agent-access.js";
import Database from "better-sqlite3";
import { PermissionRequests } from "../core/permission-requests.js";
import { attachApprovalBroker } from "./codex-approval-broker.js";
import { toolActivity } from "../core/tool-activity.js";
import { ConnectionRecovery, connectWithStartup } from "./connection-recovery.js";
import { sessionUsage } from "./codex-session.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { ControllerError } from "../core/errors.js";
import { codexThreadActivity } from "../core/agent-activity.js";
const DEFAULT_APP_SERVER_URL = "unix://";
const DEFAULT_STDIO_COMMAND = "codex app-server";
const DEFAULT_DESKTOP_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";
const DEFAULT_DESKTOP_CODEX_COMMAND = `${DEFAULT_DESKTOP_CODEX_BINARY} app-server`;
const DEFAULT_UNIX_SOCKET_PATH = join(process.env.HOME ?? "", ".codex/app-server-control/app-server-control.sock");
const connectionRecovery = new ConnectionRecovery();
const TURN_START_TIMEOUT_MS = 3_000;
const ROLLOUT_COMPATIBILITY_ERROR = /does not start with session metadata/i;
const CAPABILITIES = {
    canInterrupt: true,
    canRequestPermissions: true,
    canStart: true,
    canSendMessage: true,
    canReadLatest: true,
    canStopGracefully: true,
    canForceStop: false,
    canStreamMessages: false,
    canInspectStatusCheaply: true,
    canAttachExisting: true
};
export class CodexThreadAdapter {
    kind = "codex-thread";
    readUsage(handle) { return sessionUsage(handle); }
    capabilities() {
        return CAPABILITIES;
    }
    async start(input) {
        const handleData = parseOptionalHandle(input.agent.backend_handle);
        const accessIdentity = input.metadata?.permission_db_path ? { access_agent_id: input.agent.agent_id, access_db_path: String(input.metadata.permission_db_path) } : {};
        const approval = input.metadata?.approval_policy === "on-request" ? { approval_policy: "on-request", approval_agent_id: input.agent.agent_id, approval_db_path: String(input.metadata.permission_db_path) } : {};
        const appServerUrl = resolveAppServerUrl(input.server, input.metadata, handleData);
        const authToken = resolveAuthToken(input.metadata, handleData);
        const reasoningEffort = stringValue(input.metadata?.reasoning_effort) ?? handleData?.reasoning_effort;
        const sandbox = input.metadata?.sandbox === "read_only" ? "read_only" : input.metadata?.sandbox === "workspace" ? "workspace" : handleData?.sandbox;
        if (handleData?.thread_id) {
            const data = {
                ...handleData,
                ...approval,
                ...accessIdentity,
                reasoning_effort: reasoningEffort,
                sandbox,
                flow_writable_root: stringValue(input.metadata?.flow_writable_root) ?? handleData?.flow_writable_root,
                app_server_url: appServerUrl,
                auth_token: stringValue(input.metadata?.auth_token) ?? stringValue(input.metadata?.authToken) ?? handleData.auth_token,
                auth_token_file: resolveAuthTokenFile(input.metadata, handleData) ?? handleData.auth_token_file
            };
            if (input.prompt) {
                const response = await startTurn(data, input.prompt, input.model);
                data.latest_turn_id = response.turn?.id;
            }
            return {
                backend: this.kind,
                id: data.thread_id,
                data: compactHandle(data)
            };
        }
        const client = new CodexAppServerClient(appServerUrl, authToken);
        try {
            await client.initialize();
            const startResponse = await client.request("thread/start", {
                cwd: input.agent.repo_dir ?? undefined,
                model: input.model ?? input.agent.model ?? undefined
            });
            const thread = readThreadFromResponse(startResponse, "thread/start");
            const data = {
                thread_id: thread.id,
                ...approval,
                ...accessIdentity,
                reasoning_effort: reasoningEffort,
                sandbox,
                flow_writable_root: stringValue(input.metadata?.flow_writable_root) ?? handleData?.flow_writable_root,
                app_server_url: appServerUrl,
                auth_token: stringValue(input.metadata?.auth_token) ?? stringValue(input.metadata?.authToken),
                auth_token_file: resolveAuthTokenFile(input.metadata, handleData),
                cwd: readCwdFromResponse(startResponse) ?? input.agent.repo_dir ?? undefined
            };
            if (input.prompt) {
                const turnResponse = await startTurnOnLoadedThread(client, data, input.prompt, input.model, data.cwd);
                data.latest_turn_id = turnResponse.turn?.id;
            }
            return {
                backend: this.kind,
                id: data.thread_id,
                data: compactHandle(data)
            };
        }
        finally {
            client.closeUnlessRetained();
        }
    }
    async stageNotification(handle, message) {
        const data = parseHandle(handle);
        const client = new CodexAppServerClient(resolveAppServerUrl(undefined, undefined, data), resolveAuthToken(undefined, data));
        try {
            await client.initialize();
            await client.request("thread/inject_items", {
                threadId: data.thread_id,
                items: [{ type: "message", role: "user", content: [{ type: "input_text", text: message.message }] }]
            });
        }
        finally {
            client.closeUnlessRetained();
        }
    }
    async sendMessage(handle, message) {
        const data = parseHandle(handle);
        // Codex Desktop's orchestrator thread is often the currently active user
        // turn. `thread/inject_items` appends a model-visible user item without
        // opening a competing writer, which gives Agent Control a real staging
        // path for terminal notifications. Worker threads still use a normal
        // turn so that a waiting worker is actually resumed.
        if (data.agent_control_role === "orchestrator") {
            try {
                await injectMessage(data, message.message);
                return;
            }
            catch (error) {
                if (!isInjectionFallbackError(error)) {
                    throw error;
                }
            }
        }
        await startTurn(data, message.message);
    }
    async getStatus(handle) {
        const data = parseHandle(handle);
        const thread = await readThread(data);
        const latestTurn = latestTurnOf(thread);
        let status = mapThreadStatus(thread, latestTurn, data);
        let permissionId;
        const permissionDb = data.approval_db_path ?? data.access_db_path;
        const permissionAgent = data.approval_agent_id ?? data.access_agent_id;
        if (permissionDb && permissionAgent) {
            const db = new Database(permissionDb);
            try {
                const permissions = new PermissionRequests(db).list([permissionAgent]).filter(request => request.turn_id === latestTurn?.id && request.thread_id === data.thread_id);
                if (["running", "waiting_for_input"].includes(status))
                    permissionId = permissions.find(request => request.state === "pending")?.request_id;
                if (latestTurn?.status === "interrupted" && permissions.some(request => request.decision === "reject" && request.reject_interrupts_turn))
                    status = "waiting_for_input";
            }
            finally {
                db.close();
            }
            if (permissionId)
                status = "waiting_for_input";
        }
        return {
            status,
            failureReason: status === "failed" ? "tool_error" : undefined,
            message: latestTurn
                ? `Codex thread ${thread.id} latest turn is ${latestTurn.status}.`
                : `Codex thread ${thread.id} has no turns.`,
            data: {
                ...(permissionId ? { permission_request_id: permissionId, reason: "backend_permission_request" } : {}),
                threadId: thread.id,
                threadStatus: thread.status,
                latestTurnId: latestTurn?.id,
                latestTurnStatus: latestTurn?.status,
                activity: codexThreadActivity(thread.turns ?? [])
            }
        };
    }
    async readLatest(handle, options) {
        const data = parseHandle(handle);
        const thread = await readThread(data, true);
        const messages = [];
        for (const turn of thread.turns ?? []) {
            for (const item of turn.items ?? []) {
                if (item.type === "agentMessage" && item.text) {
                    messages.push({
                        id: item.id ?? turn.id,
                        role: "assistant",
                        text: item.text,
                        created_at: timestampFromSeconds(turn.completedAt ?? turn.startedAt),
                        metadata: { threadId: thread.id, turnId: turn.id, itemType: item.type }
                    });
                }
                if (["commandExecution", "mcpToolCall", "dynamicToolCall", "plan", "fileChange"].includes(item.type)) {
                    messages.push({
                        id: item.id ?? `${turn.id}-${messages.length}`,
                        role: "tool",
                        text: `${item.tool ?? item.command ?? item.type}\nInput: ${JSON.stringify(item.arguments ?? item)}${item.aggregatedOutput ? `\n${item.aggregatedOutput}` : ""}`,
                        created_at: timestampFromSeconds(turn.completedAt ?? turn.startedAt),
                        metadata: { threadId: thread.id, turnId: turn.id, itemType: item.type, type: "tool", tool_activity: toolActivity(item, item.id ?? `${turn.id}-${messages.length}`) }
                    });
                }
                if (item.type === "userMessage") {
                    const text = item.content?.map((entry) => entry.text).filter(Boolean).join("\n") ?? "";
                    if (text) {
                        messages.push({
                            id: item.id ?? turn.id,
                            role: "user",
                            text,
                            created_at: timestampFromSeconds(turn.startedAt),
                            metadata: { threadId: thread.id, turnId: turn.id, itemType: item.type }
                        });
                    }
                }
            }
        }
        return messages.slice(-Math.max(1, options.limit));
    }
    async interrupt(handle) {
        const result = await this.stop(handle, { mode: "interrupt" });
        return { ...result, status: result.status === "stopped" ? "running" : result.status };
    }
    async stop(handle, _options) {
        const data = parseHandle(handle);
        const thread = await readThread(data);
        const latestTurn = latestTurnOf(thread);
        if (!latestTurn || latestTurn.status !== "inProgress") {
            return {
                status: _options.mode === "interrupt" ? mapThreadStatus(thread, latestTurn, data) : "stopped",
                message: "Codex thread has no active turn to interrupt."
            };
        }
        const client = createAppServerClient(data);
        try {
            await client.initialize();
            try {
                await client.request("turn/interrupt", {
                    threadId: data.thread_id,
                    turnId: latestTurn.id
                });
            }
            catch (error) {
                if (!isRolloutCompatibilityError(error)) {
                    throw error;
                }
                client.closeUnlessRetained();
                const fallback = createCompatibilityAppServerClient(data);
                if (!fallback) {
                    throw error;
                }
                try {
                    await fallback.initialize();
                    await fallback.request("turn/interrupt", {
                        threadId: data.thread_id,
                        turnId: latestTurn.id
                    });
                }
                finally {
                    fallback.closeUnlessRetained();
                }
            }
            return {
                status: "stopped",
                message: "Codex thread turn interrupted.",
                data: { threadId: data.thread_id, turnId: latestTurn.id }
            };
        }
        finally {
            client.closeUnlessRetained();
        }
    }
    async unregister(_handle, _options) {
        return;
    }
}
async function startTurn(data, message, model) {
    const client = createAppServerClient(data);
    try {
        await client.initialize();
        try {
            return await resumeAndStartTurn(client, data, message, model);
        }
        catch (error) {
            if (!isRolloutCompatibilityError(error)) {
                throw error;
            }
            client.closeUnlessRetained();
            const fallback = createCompatibilityAppServerClient(data);
            if (!fallback) {
                throw error;
            }
            try {
                await fallback.initialize();
                return await resumeAndStartTurn(fallback, data, message, model);
            }
            finally {
                fallback.closeUnlessRetained();
            }
        }
    }
    finally {
        client.closeUnlessRetained();
    }
}
async function injectMessage(data, message) {
    const client = createAppServerClient(data);
    try {
        await client.initialize();
        try {
            await injectMessageThroughClient(client, data, message);
            return;
        }
        catch (error) {
            if (!isRolloutCompatibilityError(error)) {
                throw error;
            }
            client.closeUnlessRetained();
            const fallback = createCompatibilityAppServerClient(data);
            if (!fallback) {
                throw error;
            }
            try {
                await fallback.initialize();
                await injectMessageThroughClient(fallback, data, message);
            }
            finally {
                fallback.closeUnlessRetained();
            }
        }
    }
    finally {
        client.closeUnlessRetained();
    }
}
async function injectMessageThroughClient(client, data, message) {
    await client.request("thread/inject_items", {
        threadId: data.thread_id,
        items: [
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: message }]
            }
        ]
    });
}
function enableApprovalBroker(client, data) {
    if ((data.approval_policy === "on-request" || data.approval_policy === "untrusted") && data.approval_agent_id && data.approval_db_path && !client.retainForApprovals) {
        attachApprovalBroker(client, { agent_id: data.approval_agent_id, thread_id: data.thread_id, db_path: data.approval_db_path });
    }
}
async function resumeAndStartTurn(client, data, message, model) {
    try {
        // A loaded Codex thread can accept a same-turn input through turn/start.
        // Trying it first lets notifications steer an active user turn instead of
        // failing on thread/resume's single-writer guard. Persisted/unloaded
        // threads reject this direct request; those still take the resume path.
        return await startTurnOnLoadedThread(client, data, message, model, data.cwd);
    }
    catch (error) {
        if (!isThreadNotLoadedError(error) && !isMissingRolloutError(error)) {
            throw error;
        }
        let resumed;
        try {
            resumed = await resumeThread(client, data);
        }
        catch (resumeError) {
            if (!isMissingRolloutError(resumeError)) {
                throw resumeError;
            }
            // A newly-created but still empty thread has no rollout to resume yet.
            // In that state the first turn must be started directly on the loaded
            // thread, using the cwd captured from `thread/start`.
            return await startTurnOnLoadedThread(client, data, message, model, data.cwd);
        }
        return await startTurnOnLoadedThread(client, data, message, model, resumed.cwd ?? data.cwd);
    }
}
async function startTurnOnLoadedThread(client, data, message, model, cwd) {
    const accessDb = data.access_db_path && data.access_agent_id ? new Database(data.access_db_path) : null;
    const accessStore = accessDb ? new AgentAccessStore(accessDb) : null;
    const access = accessStore?.getAgentAccess(data.access_agent_id);
    const expectedAccess = access?.requested ? accessTurnOverrides(access.requested, cwd ?? data.cwd, data.flow_writable_root) : null;
    let overrides = expectedAccess;
    let preserveActivePolicy = false;
    if (accessStore) {
        try {
            const current = await client.request("thread/read", { threadId: data.thread_id, includeTurns: true });
            // A continuation can steer an active turn. Keep its current permissions;
            // requested changes belong to the next actual turn boundary.
            preserveActivePolicy = !current.thread || current.thread.status.type === "active" || latestTurnOf(current.thread)?.status === "inProgress";
        }
        catch {
            preserveActivePolicy = true;
        }
        if (preserveActivePolicy)
            overrides = null;
    }
    if (overrides)
        data = { ...data, approval_policy: overrides.approvalPolicy === "never" ? undefined : overrides.approvalPolicy,
            approval_agent_id: data.access_agent_id, approval_db_path: data.access_db_path };
    if (preserveActivePolicy && access?.effective?.thread_id === data.thread_id) {
        const approval = access.effective.approval_policy;
        data = { ...data, approval_policy: approval === "on-request" || approval === "untrusted" ? approval : undefined,
            approval_agent_id: data.access_agent_id, approval_db_path: data.access_db_path };
    }
    enableApprovalBroker(client, data);
    const waiter = createTurnActivationWaiter(client, data.thread_id);
    const turnCwd = cwd ?? data.cwd;
    try {
        const result = await client.request("turn/start", {
            threadId: data.thread_id,
            clientUserMessageId: `agent-control-${randomUUID()}`,
            input: [{ type: "text", text: message, text_elements: [] }],
            cwd: turnCwd ?? undefined,
            model: model ?? undefined,
            // Retain the explicit effort when this worker receives another turn.
            effort: data.reasoning_effort ?? undefined,
            ...(preserveActivePolicy ? {} : data.sandbox === "read_only" ? { sandboxPolicy: { type: "readOnly" }, approvalPolicy: data.approval_policy ?? "never" } : data.sandbox === "workspace" ? { sandboxPolicy: { type: "workspaceWrite", writableRoots: [turnCwd, data.flow_writable_root].filter(Boolean), networkAccess: true }, approvalPolicy: data.approval_policy ?? "never" } : data.approval_policy ? { approvalPolicy: data.approval_policy } : {}),
            ...overrides
        });
        const turnResponse = result;
        if (turnResponse.turn?.id) {
            client.bindApprovalTurn?.(turnResponse.turn.id);
            await waiter.waitForTurn(turnResponse.turn.id).catch((error) => {
                if (!isTimeoutError(error)) {
                    throw error;
                }
                // `turn/start` returning a turn id is already the durable acceptance
                // signal. Some app-server transports do not replay the matching
                // `turn/started` notification to this short-lived connection, so status
                // polling remains the source of truth after dispatch.
            });
        }
        else {
            waiter.dispose();
            if (client.retainForApprovals) {
                client.close();
                throw new Error("Interactive approval launch returned no turn identity.");
            }
        }
        if (accessStore) {
            try {
                const observed = await client.request("thread/resume", { threadId: data.thread_id });
                if (observed.thread?.id === data.thread_id && observed.approvalPolicy !== undefined && observed.sandbox) {
                    accessStore.confirmAgentAccess(data.access_agent_id, access.revision, { thread_id: data.thread_id,
                        approval_policy: observed.approvalPolicy, sandbox_policy: observed.sandbox }, expectedAccess ? { ...expectedAccess, ...(observed.cwd === turnCwd && typeof observed.cwd === "string" ? { implicitCwd: observed.cwd } : {}) } : undefined);
                }
            }
            catch { /* Requested stays pending until the backend confirms its effective policy. */ }
        }
        return turnResponse;
    }
    catch (error) {
        client.close();
        waiter.dispose();
        throw error;
    }
    finally {
        accessDb?.close();
    }
}
async function readThread(data, allowHistoryFallback = false) {
    const client = createAppServerClient(data);
    try {
        await client.initialize();
        try {
            return await readThreadThroughClient(client, data);
        }
        catch (error) {
            if (!isRolloutCompatibilityError(error)) {
                throw error;
            }
            client.closeUnlessRetained();
            const fallback = createCompatibilityAppServerClient(data);
            if (!fallback) {
                throw error;
            }
            try {
                await fallback.initialize();
                return await readThreadThroughClient(fallback, data);
            }
            finally {
                fallback.closeUnlessRetained();
            }
        }
    }
    catch (error) {
        // History recovery never resumes work or reports the archive as a live worker.
        const url = resolveAppServerUrl(undefined, undefined, data);
        const local = /^wss?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(url);
        const command = resolveCompatibilityStdioCommand();
        if (!allowHistoryFallback || !local || !command || !(error instanceof ControllerError) || error.reason !== "backend_unavailable")
            throw error;
        client.closeUnlessRetained();
        const archive = new CodexAppServerClient("stdio://", undefined, command);
        try {
            await archive.initialize();
            return await readThreadThroughClient(archive, data);
        }
        finally {
            archive.close();
        }
    }
    finally {
        client.closeUnlessRetained();
    }
}
async function readThreadThroughClient(client, data) {
    const result = await client.request("thread/read", {
        threadId: data.thread_id,
        includeTurns: true
    });
    return readThreadFromResponse(result, "thread/read");
}
async function resumeThread(client, data) {
    // The Codex app server keeps historical threads readable while unloaded.
    // `turn/start` only works after the thread is resumed into the in-memory
    // session set, so wakeups must explicitly resume before sending a turn.
    const result = await client.request("thread/resume", {
        threadId: data.thread_id
    });
    return readThreadFromResponse(result, "thread/resume");
}
function createTurnActivationWaiter(client, threadId) {
    const seenTurnIds = new Set();
    let targetTurnId = null;
    let settled = false;
    let timeout = null;
    let resolveWait = null;
    let rejectWait = null;
    const unsubscribe = client.onNotification((notification) => {
        const turnId = turnIdFromActivationNotification(notification, threadId);
        if (!turnId) {
            return;
        }
        seenTurnIds.add(turnId);
        if (turnId === targetTurnId) {
            resolve();
        }
    });
    const cleanup = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        unsubscribe();
    };
    const resolve = () => {
        if (settled) {
            return;
        }
        settled = true;
        cleanup();
        resolveWait?.();
    };
    const reject = (error) => {
        if (settled) {
            return;
        }
        settled = true;
        cleanup();
        rejectWait?.(error);
    };
    return {
        waitForTurn(turnId) {
            targetTurnId = turnId;
            if (seenTurnIds.has(turnId)) {
                resolve();
            }
            return new Promise((resolvePromise, rejectPromise) => {
                resolveWait = resolvePromise;
                rejectWait = rejectPromise;
                timeout = setTimeout(() => {
                    reject(new ControllerError("Timed out waiting for Codex turn to start.", "timeout", { threadId, turnId }));
                }, TURN_START_TIMEOUT_MS);
                if (settled) {
                    cleanup();
                    resolvePromise();
                }
            });
        },
        dispose() {
            cleanup();
        }
    };
}
function turnIdFromActivationNotification(notification, threadId) {
    if (notification.method !== "turn/started" && notification.method !== "turn/completed") {
        return null;
    }
    const params = notification.params;
    if (params?.threadId !== threadId) {
        return null;
    }
    const turnId = params.turn?.id ?? params.turnId;
    return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class CodexAppServerClient {
    url;
    authToken;
    stdioCommand;
    retainForApprovals = false;
    bindApprovalTurn;
    serverRequestHandlers = new Set();
    closeHandlers = new Set();
    onServerRequest(handler) { this.serverRequestHandlers.add(handler); return () => { this.serverRequestHandlers.delete(handler); }; }
    onClose(handler) { this.closeHandlers.add(handler); return () => { this.closeHandlers.delete(handler); }; }
    respond(id, result) { if (!this.isConnected())
        throw new Error("Approval connection disconnected."); this.sendJson({ id, result }); }
    closeUnlessRetained() { if (!this.retainForApprovals)
        this.close(); }
    notifyClosed() { for (const handler of [...this.closeHandlers])
        handler(); }
    socket = null;
    process = null;
    ownedProcesses = new Map();
    ownedGroups = new Set();
    processBuffer = "";
    processStderr = "";
    nextId = 1;
    pending = new Map();
    notificationHandlers = new Set();
    constructor(url, authToken, stdioCommand) {
        this.url = url;
        this.authToken = authToken;
        this.stdioCommand = stdioCommand;
    }
    async initialize() {
        await this.connect();
        // Each short-lived controller operation opens a connection, initializes it,
        // sends one or a few requests, then closes it so the control plane never
        // needs to keep a long transcript stream in memory.
        await this.request("initialize", {
            clientInfo: { name: "agent-control", title: "Agent Control", version: "0.1.0" },
            capabilities: null
        });
        this.notify("initialized", {});
    }
    request(method, params) {
        // The connected path writes synchronously so a caller can fence dispatch
        // against cancellation while returning the asynchronous RPC response.
        if (!this.isConnected())
            return this.connect().then(() => this.requestConnected(method, params));
        return this.requestConnected(method, params);
    }
    requestConnected(method, params) {
        if (!this.isConnected()) {
            return Promise.reject(new ControllerError("Codex app-server connection is not open.", "backend_unavailable", {
                appServerUrl: this.url
            }));
        }
        const id = String(this.nextId++);
        const response = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        try {
            this.sendJson({ id, method, params });
        }
        catch (error) {
            this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
            this.pending.delete(id);
        }
        return response;
    }
    notify(method, params) {
        this.sendJson({ method, params });
    }
    onNotification(handler) {
        this.notificationHandlers.add(handler);
        return () => {
            this.notificationHandlers.delete(handler);
        };
    }
    close(force = false) {
        this.notifyClosed();
        for (const pending of this.pending.values())
            pending.reject(new Error("Codex app-server connection closed."));
        this.pending.clear();
        this.socket?.close();
        this.socket = null;
        for (const child of this.ownedProcesses.keys())
            this.signalOwnedProcess(child, force ? "SIGKILL" : "SIGTERM");
        this.process = null;
        this.processBuffer = "";
        this.processStderr = "";
    }
    async closeAndWait() {
        this.close();
        const closing = [...this.ownedProcesses.entries()];
        const settled = async (ms) => {
            const deadline = Date.now() + ms;
            do {
                for (const pid of this.ownedGroups) {
                    try {
                        process.kill(-pid, 0);
                    }
                    catch {
                        this.ownedGroups.delete(pid);
                    }
                }
                if (!this.ownedProcesses.size && !this.ownedGroups.size)
                    return true;
                await sleep(50);
            } while (Date.now() < deadline);
            return false;
        };
        if (await settled(1500))
            return;
        for (const [child] of closing)
            this.signalOwnedProcess(child, "SIGKILL");
        for (const pid of this.ownedGroups) {
            try {
                process.kill(-pid, "SIGKILL");
            }
            catch {
                this.ownedGroups.delete(pid);
            }
        }
        if (!await settled(5000))
            throw new Error("The owned Codex process has not exited; the same session must remain blocked.");
    }
    signalOwnedProcess(child, signal) {
        if (!this.ownedProcesses.has(child))
            return;
        try {
            if (typeof this.stdioCommand === "object" && this.stdioCommand.detached && child.pid)
                process.kill(-child.pid, signal);
            else
                child.kill(signal);
        }
        catch { /* Exit confirmation, rather than signal delivery, releases the owner. */ }
    }
    async connect() {
        if (this.isConnected()) {
            return;
        }
        await connectionRecovery.connect(this.usesStdio() ? `${this.url}:${JSON.stringify(this.resolveStdioCommand())}` : this.url, async () => {
            if (this.usesStdio()) {
                await this.connectStdio();
            }
            else if (this.usesUnixSocket()) {
                await this.connectUnixSocket();
            }
            else {
                // External endpoints are reconnected, never started from a guessed command.
                await this.connectWebSocket();
            }
        });
    }
    isConnected() {
        return Boolean(this.process && !this.process.killed) || this.socket?.readyState === WebSocket.OPEN;
    }
    usesStdio() {
        return this.url === "stdio://" || this.url === "stdio";
    }
    usesUnixSocket() {
        return this.url === "unix://" || this.url.startsWith("unix:///");
    }
    sendJson(payload) {
        if (this.process) {
            this.process.stdin.write(`${JSON.stringify(payload)}\n`);
            return;
        }
        this.socket?.send(JSON.stringify(payload));
    }
    resolveStdioCommand() {
        return this.stdioCommand ?? process.env.CODEX_APP_SERVER_STDIO_COMMAND ??
            process.env.CODEX_APP_SERVER_COMMAND ?? DEFAULT_STDIO_COMMAND;
    }
    async connectStdio() {
        const command = this.resolveStdioCommand();
        const [bin, ...args] = typeof command === "string" ? splitCommand(command) : [command.executable, ...command.args];
        if (!bin) {
            throw new ControllerError("Codex app-server stdio command is empty.", "backend_unavailable", {
                appServerUrl: this.url
            });
        }
        await new Promise((resolve, reject) => {
            const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], ...(typeof command === "object" ? { cwd: command.cwd, detached: command.detached } : {}) });
            const exit = new Promise(done => { child.once("close", () => { this.ownedProcesses.delete(child); done(); }); });
            this.ownedProcesses.set(child, exit);
            const timeout = setTimeout(() => {
                child.kill("SIGTERM");
                reject(new ControllerError("Timed out starting Codex app-server stdio transport.", "backend_unavailable", {
                    appServerUrl: this.url,
                    command
                }));
            }, 5000);
            child.stdout.on("data", (chunk) => { if (this.process === child)
                this.handleProcessStdout(String(chunk)); });
            child.stderr.on("data", (chunk) => {
                this.processStderr += String(chunk);
            });
            child.once("spawn", () => {
                clearTimeout(timeout);
                if (typeof command === "object" && command.detached && child.pid)
                    this.ownedGroups.add(child.pid);
                this.process = child;
                resolve();
            });
            child.once("error", (error) => {
                clearTimeout(timeout);
                reject(new ControllerError(`Codex app-server stdio failed to start: ${error.message}`, "backend_unavailable", {
                    appServerUrl: this.url,
                    command
                }));
            });
            child.once("exit", (code) => {
                if (this.process !== child)
                    return;
                this.process = null;
                this.notifyClosed();
                for (const pending of this.pending.values()) {
                    pending.reject(new ControllerError("Codex app-server stdio process exited.", "backend_unavailable", {
                        appServerUrl: this.url,
                        code,
                        stderr: this.processStderr.trim()
                    }));
                }
                this.pending.clear();
            });
        });
    }
    async connectWebSocket() {
        await new Promise((resolve, reject) => {
            const headers = this.authToken ? { Authorization: `Bearer ${this.authToken}` } : undefined;
            const socket = new WebSocket(this.url, { headers });
            const timeout = setTimeout(() => {
                socket.close();
                reject(new ControllerError("Timed out connecting to Codex app-server.", "backend_unavailable", {
                    appServerUrl: this.url
                }));
            }, 5000);
            socket.once("open", () => {
                clearTimeout(timeout);
                this.socket = socket;
                resolve();
            });
            socket.once("error", (error) => {
                clearTimeout(timeout);
                reject(new ControllerError(`Codex app-server connection failed: ${error.message}`, "backend_unavailable", {
                    appServerUrl: this.url
                }));
            });
            socket.on("message", (raw) => { if (this.socket === socket)
                this.handleMessage(String(raw)); });
            socket.on("close", () => {
                if (this.socket !== socket)
                    return;
                this.socket = null;
                this.notifyClosed();
                for (const pending of this.pending.values()) {
                    pending.reject(new ControllerError("Codex app-server websocket closed.", "backend_unavailable", {
                        appServerUrl: this.url
                    }));
                }
                this.pending.clear();
            });
        });
    }
    async connectUnixSocket() {
        try {
            await this.openUnixSocket();
        }
        catch (error) {
            // Only the managed default may be started automatically. Explicit custom
            // sockets and remote servers retain their configured lifecycle.
            if (this.url !== "unix://" || !(error instanceof Error) || !/ENOENT|ECONNREFUSED/.test(error.message))
                throw error;
            // Recovery connects only; it must never replay a thread or turn start.
            await connectWithStartup(() => this.openUnixSocket(), startDefaultDaemon);
        }
    }
    async openUnixSocket() {
        const socketPath = resolveUnixSocketPath(this.url);
        await new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
                // Codex control sockets reject a WebSocket compression extension offer.
                perMessageDeflate: false
            });
            const timeout = setTimeout(() => {
                socket.close();
                reject(new ControllerError("Timed out connecting to Codex app-server Unix socket.", "backend_unavailable", {
                    appServerUrl: this.url,
                    socketPath
                }));
            }, 5000);
            socket.once("open", () => {
                clearTimeout(timeout);
                this.socket = socket;
                resolve();
            });
            socket.once("error", (error) => {
                clearTimeout(timeout);
                reject(new ControllerError(`Codex app-server Unix socket connection failed: ${error.message}`, "backend_unavailable", {
                    appServerUrl: this.url,
                    socketPath
                }));
            });
            socket.on("message", (raw) => { if (this.socket === socket)
                this.handleMessage(String(raw)); });
            socket.on("close", () => {
                if (this.socket !== socket)
                    return;
                this.socket = null;
                this.notifyClosed();
                for (const pending of this.pending.values()) {
                    pending.reject(new ControllerError("Codex app-server Unix socket closed.", "backend_unavailable", {
                        appServerUrl: this.url,
                        socketPath
                    }));
                }
                this.pending.clear();
            });
        });
    }
    handleProcessStdout(chunk) {
        this.processBuffer += chunk;
        let newlineIndex = this.processBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this.processBuffer.slice(0, newlineIndex);
            this.processBuffer = this.processBuffer.slice(newlineIndex + 1);
            if (line.trim()) {
                this.handleMessage(line);
            }
            newlineIndex = this.processBuffer.indexOf("\n");
        }
    }
    handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (message.id !== undefined && typeof message.method === "string") {
            for (const handler of this.serverRequestHandlers)
                handler({ id: message.id, method: message.method, params: message.params });
            return;
        }
        // The app-server can emit notifications without an id while a request is
        // in flight. They are useful for a streaming UI, but this adapter is a
        // cheap request/response bridge, so it only resolves matching responses.
        if (message.id === undefined) {
            if (typeof message.method === "string") {
                const notification = { method: message.method, params: message.params };
                for (const handler of this.notificationHandlers) {
                    handler(notification);
                }
            }
            return;
        }
        const key = String(message.id);
        const pending = this.pending.get(key);
        if (!pending) {
            return;
        }
        this.pending.delete(key);
        if (message.error) {
            pending.reject(new ControllerError(message.error.message ?? "Codex app-server request failed.", "tool_error", {
                appServerUrl: this.url,
                error: message.error
            }));
            return;
        }
        pending.resolve(message.result);
    }
}
function splitCommand(command) {
    return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
}
function resolveUnixSocketPath(url) {
    if (url === "unix://") {
        return DEFAULT_UNIX_SOCKET_PATH;
    }
    return url.slice("unix://".length);
}
function parseOptionalHandle(value) {
    if (!value) {
        return null;
    }
    return {
        thread_id: String(value.thread_id ?? value.threadId ?? value.id ?? ""),
        reasoning_effort: stringValue(value.reasoning_effort),
        flow_writable_root: stringValue(value.flow_writable_root),
        sandbox: value.sandbox === "read_only" ? "read_only" : value.sandbox === "workspace" ? "workspace" : undefined,
        app_server_url: typeof value.app_server_url === "string"
            ? value.app_server_url
            : typeof value.appServerUrl === "string"
                ? value.appServerUrl
                : undefined,
        auth_token: typeof value.auth_token === "string"
            ? value.auth_token
            : typeof value.authToken === "string"
                ? value.authToken
                : undefined,
        auth_token_file: typeof value.auth_token_file === "string"
            ? value.auth_token_file
            : typeof value.authTokenFile === "string"
                ? value.authTokenFile
                : undefined,
        latest_turn_id: typeof value.latest_turn_id === "string"
            ? value.latest_turn_id
            : typeof value.latestTurnId === "string"
                ? value.latestTurnId
                : undefined,
        agent_control_role: typeof value.agent_control_role === "string"
            ? value.agent_control_role
            : typeof value.agentControlRole === "string"
                ? value.agentControlRole
                : undefined,
        cwd: typeof value.cwd === "string" ? value.cwd : undefined,
        recoverable_interrupt: value.recoverable_interrupt === true,
        access_agent_id: stringValue(value.access_agent_id),
        access_db_path: stringValue(value.access_db_path),
        approval_policy: value.approval_policy === "on-request" || value.approval_policy === "untrusted" ? value.approval_policy : undefined,
        approval_agent_id: stringValue(value.approval_agent_id),
        approval_db_path: stringValue(value.approval_db_path)
    };
}
function parseHandle(handle) {
    const data = parseOptionalHandle(handle.data);
    if (!data?.thread_id) {
        throw new ControllerError("Codex thread handle is missing thread_id.", "tool_error", {
            handle
        });
    }
    return data;
}
function compactHandle(data) {
    const handle = {
        thread_id: data.thread_id,
        app_server_url: resolveAppServerUrl(undefined, undefined, data)
    };
    if (data.auth_token) {
        handle.auth_token = data.auth_token;
    }
    if (data.auth_token_file) {
        handle.auth_token_file = data.auth_token_file;
    }
    if (data.latest_turn_id) {
        handle.latest_turn_id = data.latest_turn_id;
    }
    if (data.agent_control_role) {
        handle.agent_control_role = data.agent_control_role;
    }
    if (data.cwd) {
        handle.cwd = data.cwd;
    }
    if (data.flow_writable_root)
        handle.flow_writable_root = data.flow_writable_root;
    if (data.recoverable_interrupt)
        handle.recoverable_interrupt = true;
    if (data.approval_policy) {
        handle.approval_policy = data.approval_policy;
        handle.approval_agent_id = data.approval_agent_id;
        handle.approval_db_path = data.approval_db_path;
    }
    if (data.access_agent_id) {
        handle.access_agent_id = data.access_agent_id;
        handle.access_db_path = data.access_db_path;
    }
    if (data.sandbox)
        handle.sandbox = data.sandbox;
    if (data.reasoning_effort) {
        handle.reasoning_effort = data.reasoning_effort;
    }
    return handle;
}
function isMissingRolloutError(error) {
    return error instanceof Error && /no rollout found/i.test(error.message);
}
function isThreadNotLoadedError(error) {
    return (error instanceof Error &&
        /thread (?:not found|is not loaded|must be resumed)|not loaded/i.test(error.message));
}
function isInjectionFallbackError(error) {
    if (!(error instanceof Error)) {
        return false;
    }
    return /active writer|unknown method|method .*not found|thread (?:not found|is not loaded|must be resumed)|not loaded|does not start with session metadata|no rollout found/i.test(error.message);
}
function isRolloutCompatibilityError(error) {
    return error instanceof ControllerError && ROLLOUT_COMPATIBILITY_ERROR.test(error.message);
}
function isTimeoutError(error) {
    return error instanceof ControllerError && error.reason === "timeout";
}
function createAppServerClient(data) {
    return new CodexAppServerClient(resolveAppServerUrl(undefined, undefined, data), resolveAuthToken(undefined, data));
}
function createCompatibilityAppServerClient(data) {
    const primaryUrl = resolveAppServerUrl(undefined, undefined, data);
    const explicitCommand = process.env.CODEX_APP_SERVER_COMPAT_COMMAND;
    if (!explicitCommand &&
        primaryUrl !== "unix://" &&
        !primaryUrl.startsWith("unix:///") &&
        primaryUrl !== "stdio://" &&
        primaryUrl !== "stdio") {
        return null;
    }
    const command = resolveCompatibilityStdioCommand();
    if (!command) {
        return null;
    }
    return new CodexAppServerClient("stdio://", resolveAuthToken(undefined, data), command);
}
function resolveCompatibilityStdioCommand() {
    const explicitCommand = process.env.CODEX_APP_SERVER_COMPAT_COMMAND;
    if (explicitCommand) {
        return explicitCommand;
    }
    // Codex Desktop can advance its rollout format ahead of the standalone CLI
    // app-server. On macOS, use the bundled Desktop binary for that compatibility
    // retry when the persistent Unix app-server cannot parse the thread history.
    if (existsSync(DEFAULT_DESKTOP_CODEX_BINARY)) {
        return DEFAULT_DESKTOP_CODEX_COMMAND;
    }
    const configuredCommand = process.env.CODEX_APP_SERVER_STDIO_COMMAND ?? process.env.CODEX_APP_SERVER_COMMAND;
    return configuredCommand && configuredCommand !== DEFAULT_STDIO_COMMAND ? configuredCommand : undefined;
}
function resolveAppServerUrl(server, metadata, handle) {
    return (server ??
        stringValue(metadata?.app_server_url) ??
        stringValue(metadata?.appServerUrl) ??
        handle?.app_server_url ??
        process.env.CODEX_APP_SERVER_URL ??
        process.env.CODEX_APP_SERVER ??
        DEFAULT_APP_SERVER_URL);
}
function resolveAuthToken(metadata, handle) {
    const token = stringValue(metadata?.auth_token) ??
        stringValue(metadata?.authToken) ??
        handle?.auth_token ??
        process.env.CODEX_APP_SERVER_AUTH_TOKEN ??
        process.env.CODEX_REMOTE_TOKEN;
    if (token) {
        return token;
    }
    const tokenFile = resolveAuthTokenFile(metadata, handle);
    if (!tokenFile) {
        return undefined;
    }
    try {
        return readFileSync(tokenFile, "utf8").trim();
    }
    catch (error) {
        throw new ControllerError("Could not read Codex app-server auth token file.", "auth_required", {
            tokenFile,
            reason: error instanceof Error ? error.message : String(error)
        });
    }
}
function resolveAuthTokenFile(metadata, handle) {
    return (stringValue(metadata?.auth_token_file) ??
        stringValue(metadata?.authTokenFile) ??
        handle?.auth_token_file ??
        process.env.CODEX_APP_SERVER_AUTH_TOKEN_FILE ??
        process.env.CODEX_REMOTE_TOKEN_FILE);
}
function stringValue(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function readThreadFromResponse(response, method) {
    const thread = response.thread;
    if (!thread || typeof thread !== "object") {
        throw new ControllerError(`Codex app-server ${method} response did not include a thread.`, "tool_error", {
            response
        });
    }
    return thread;
}
function readCwdFromResponse(response) {
    const cwd = response.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}
function latestTurnOf(thread) {
    return thread.turns?.[thread.turns.length - 1];
}
function mapThreadStatus(thread, latestTurn, data) {
    if (thread.status.type === "active" && thread.status.activeFlags?.some(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(flag)))
        return "waiting_for_input";
    if (thread.status.type === "systemError") {
        return "failed";
    }
    // A registered orchestrator is not a worker. Its latest turn may be
    // completed or interrupted while the thread is still perfectly able to
    // receive subscription wakeups, so expose it as waiting for input instead of
    // making the run graph look like the supervisor stopped.
    if ((data.agent_control_role === "orchestrator" || data.agent_control_role === "observer") && latestTurn?.status !== "inProgress") {
        return "waiting_for_input";
    }
    if (thread.status.type === "active" || latestTurn?.status === "inProgress") {
        return "running";
    }
    if (!latestTurn) {
        return "unknown";
    }
    if (latestTurn.status === "completed") {
        return "completed";
    }
    if (latestTurn.status === "failed") {
        return "failed";
    }
    if (latestTurn.status === "interrupted") {
        return data.recoverable_interrupt ? "waiting_for_input" : "stopped";
    }
    return "unknown";
}
function timestampFromSeconds(value) {
    if (!value) {
        return new Date().toISOString();
    }
    return new Date(value * 1000).toISOString();
}
let daemonStart;
function startDefaultDaemon() {
    return daemonStart ??= new Promise((resolveStart, rejectStart) => {
        const child = spawn("codex", ["app-server", "daemon", "start"], { stdio: "ignore" });
        const timer = setTimeout(() => {
            child.kill();
            rejectStart(new ControllerError("Timed out starting the local Codex app-server daemon.", "backend_unavailable"));
        }, 15_000);
        child.once("error", (error) => {
            clearTimeout(timer);
            rejectStart(new ControllerError(`Could not start the local Codex daemon: ${error.message}`, "backend_unavailable"));
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolveStart();
            else
                rejectStart(new ControllerError("Could not start the local Codex app-server daemon. Check codex app-server daemon start.", "backend_unavailable"));
        });
    }).finally(() => { daemonStart = undefined; });
}
