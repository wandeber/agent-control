import Database from "better-sqlite3";
import { CodexAppServerClient } from "./codex-thread-adapter.js";
import { attachApprovalBroker } from "./codex-approval-broker.js";
import { AgentAccessStore, accessTurnOverrides } from "../core/agent-access.js";
import { readInteractiveProfile, interactiveProfileOverrides } from "./codex-interactive-profile.js";
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
/** The detached CLI supervisor owns this RPC connection for the whole turn. */
export async function runInteractiveCliTurn(job, control) {
    const client = new CodexAppServerClient("stdio://", undefined, { executable: job.executable, args: ["app-server", "--listen", "stdio://"], cwd: job.cwd, detached: true });
    const db = new Database(job.db_path);
    db.pragma("busy_timeout = 5000");
    const access = new AgentAccessStore(db);
    let threadId = control.session, turnId;
    let expectedPolicy;
    let requestRevision = 0;
    let interrupted = false;
    let closing = false;
    let turnFinished = false;
    let timer;
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    const items = new Map();
    const early = [];
    const finish = (status) => {
        if (turnFinished)
            return;
        turnFinished = true;
        settle({ thread_id: threadId, status });
    };
    const confirmAccess = (response) => {
        if (!threadId)
            return;
        access.confirmAgentAccess(job.agent_id, requestRevision, { approval_policy: response.approvalPolicy,
            sandbox_policy: response.sandboxPolicy ?? response.sandbox, thread_id: threadId }, {
            ...expectedPolicy, ...(response.cwd === job.cwd ? { implicitCwd: job.cwd } : {})
        });
    };
    const notification = (message) => {
        const p = record(message.params);
        if (!threadId || p.threadId !== threadId)
            return;
        if (message.method === "thread/settings/updated") {
            confirmAccess(record(p.threadSettings));
            return;
        }
        if (!turnId) {
            early.push(message);
            return;
        }
        if (p.turnId && p.turnId !== turnId)
            return;
        if (message.method === "item/started" || message.method === "item/completed") {
            const item = record(p.item);
            if (typeof item.id !== "string")
                return;
            items.set(item.id, item);
            control.event({ type: message.method === "item/started" ? "item.started" : "item.completed", item: cliItem(item), turn_id: turnId });
        }
        else if (message.method === "item/agentMessage/delta" && typeof p.itemId === "string" && typeof p.delta === "string") {
            const item = { ...items.get(p.itemId), id: p.itemId, type: "agentMessage", text: `${items.get(p.itemId)?.text ?? ""}${p.delta}`, status: "inProgress" };
            items.set(p.itemId, item);
            control.event({ type: "item.updated", item: cliItem(item), turn_id: turnId });
        }
        else if (message.method === "turn/completed") {
            const turn = record(p.turn);
            if (turn.id !== turnId)
                return;
            if (turn.status === "completed") {
                control.event({ type: "turn.completed", turn_id: turnId });
                finish("completed");
            }
            else if (turn.status === "interrupted")
                finish("waiting_for_input");
            else {
                control.event({ type: "turn.failed", error: turn.error, turn_id: turnId });
                finish("failed");
            }
        }
    };
    const removeNotification = client.onNotification(notification);
    const removeClose = client.onClose(() => { if (!closing)
        finish("failed"); });
    try {
        await startup(client.initialize());
        const profile = readInteractiveProfile(job.profile_path, job.profile_hash);
        const loaded = Object.keys(profile).length ? await startup(client.request("config/read", { cwd: job.cwd, includeLayers: true })) : {};
        const config = interactiveProfileOverrides(profile, loaded);
        if (job.reasoning_effort)
            config.model_reasoning_effort = job.reasoning_effort;
        const requested = access.getAgentAccess(job.agent_id);
        requestRevision = requested.revision;
        const policy = requested.requested ?? { sandbox: job.sandbox, approval_policy: job.approval_policy ?? "never" };
        expectedPolicy = accessTurnOverrides(policy, job.cwd);
        const params = { ...(control.session ? { threadId: control.session } : {}), cwd: job.cwd, config,
            ...(job.model ? { model: job.model } : {}), approvalPolicy: expectedPolicy.approvalPolicy,
            approvalsReviewer: "user", sandbox: policy.sandbox === "read_only" ? "read-only" : policy.sandbox === "full_access" ? "danger-full-access" : "workspace-write" };
        const response = record(await startup(control.dispatch(() => client.requestConnected(control.session ? "thread/resume" : "thread/start", params))));
        const actualId = record(response.thread).id;
        if (typeof actualId !== "string" || (control.session && actualId !== control.session))
            throw new Error("Codex interactive continuation returned a different session.");
        threadId = actualId;
        const expectedModel = job.model ?? config.model;
        const expectedProvider = config.model_provider ?? job.model_provider;
        if (expectedModel && response.model !== expectedModel)
            throw new Error("Codex did not retain the selected model; no prompt was sent.");
        if (expectedProvider && response.modelProvider !== expectedProvider)
            throw new Error("Codex did not retain the selected model provider; no prompt was sent.");
        if (!requested.requested) {
            if (typeof record(response.sandbox).type !== "string")
                throw new Error("Codex did not confirm the existing sandbox; no prompt was sent.");
            // Transport selection must retain profile/base network and filesystem
            // restrictions. Only an explicit per-agent access choice selects a preset.
            expectedPolicy = { approvalPolicy: policy.approval_policy, sandboxPolicy: response.sandbox };
        }
        control.thread(actualId);
        control.event({ type: "thread.started", thread_id: actualId });
        confirmAccess(response);
        const beforeTurn = control.stop();
        if (beforeTurn)
            return { thread_id: actualId, status: beforeTurn === "interrupt" ? "waiting_for_input" : "failed" };
        attachApprovalBroker(client, { agent_id: job.agent_id, thread_id: actualId, db_path: job.db_path, closeOnTurnCompleted: false });
        const started = record(await startup(control.dispatch(() => client.requestConnected("turn/start", { threadId: actualId,
            input: [{ type: "text", text: job.prompt }], ...expectedPolicy,
            ...(job.reasoning_effort ? { effort: job.reasoning_effort } : {}) }))));
        turnId = record(started.turn).id;
        if (typeof turnId !== "string")
            throw new Error("Codex did not confirm the interactive turn identity.");
        control.turn(turnId);
        control.event({ type: "turn.started", turn_id: turnId });
        for (const message of early.splice(0))
            notification(message);
        client.bindApprovalTurn?.(turnId);
        if (record(started.turn).status === "completed")
            finish("completed");
        // Loaded-thread resume is a readback here, never our policy mutation. The
        // accepted turn/start and settings notification own application of changes.
        try {
            const effective = record(await startup(client.request("thread/resume", { threadId })));
            if (record(effective.thread).id === threadId)
                confirmAccess(effective);
        }
        catch { /* Keep an unconfirmed access revision pending without inventing an applied policy. */ }
        let checking = false;
        timer = setInterval(() => {
            if (checking || turnFinished)
                return;
            checking = true;
            try {
                control.heartbeat();
                const mode = control.stop();
                if (mode === "kill") {
                    closing = true;
                    client.close(true);
                    finish("failed");
                }
                else if (mode && !interrupted) {
                    interrupted = true;
                    void client.request("turn/interrupt", { threadId, turnId }).catch(() => finish("failed"));
                }
            }
            catch {
                finish("failed");
            }
            finally {
                checking = false;
            }
        }, 100);
        return await done;
    }
    catch (error) {
        control.event({ type: "error", message: error instanceof Error ? error.message : "Interactive Codex failed." });
        return { thread_id: threadId, status: "failed" };
    }
    finally {
        closing = true;
        if (timer)
            clearInterval(timer);
        removeNotification();
        removeClose();
        try {
            await client.closeAndWait();
        }
        finally {
            db.close();
        }
    }
}
function cliItem(item) {
    const types = { agentMessage: "agent_message", commandExecution: "command_execution", mcpToolCall: "mcp_tool_call", webSearch: "web_search", fileChange: "file_change", collabAgentToolCall: "collab_tool_call" };
    return { ...item, type: types[item.type] ?? item.type, ...(item.aggregatedOutput !== undefined ? { aggregated_output: item.aggregatedOutput } : {}), ...(item.exitCode !== undefined ? { exit_code: item.exitCode } : {}) };
}
async function startup(operation) {
    let timer;
    try {
        return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Codex interactive setup did not respond; the same execution is retained.")), 15000); })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
