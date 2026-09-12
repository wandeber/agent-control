import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { PermissionRequests } from "../core/permission-requests.js";
/** Keep the requesting connection alive; a restart/disconnect invalidates unanswerable requests. */
export function attachApprovalBroker(client, data) {
    const db = new Database(data.db_path);
    db.pragma("busy_timeout = 5000");
    const requests = new PermissionRequests(db);
    const connectionId = randomUUID();
    let closed = false;
    let turnId = null;
    let bind;
    const turnBound = new Promise(resolve => { bind = resolve; });
    const completed = new Set();
    client.bindApprovalTurn = id => { turnId = id; bind(id); if (completed.has(id) && data.closeOnTurnCompleted !== false)
        client.close(); };
    const resolved = new Set();
    client.retainForApprovals = true;
    const removeRequest = client.onServerRequest(request => {
        void (async () => {
            const params = record(request.params);
            if (params.threadId !== data.thread_id || typeof params.turnId !== "string" || typeof params.itemId !== "string")
                return;
            const kinds = { "item/commandExecution/requestApproval": "command", "item/fileChange/requestApproval": "files", "item/permissions/requestApproval": "permissions" };
            const kind = kinds[request.method];
            if (!kind || params.turnId !== await turnBound || closed)
                return;
            // File approval payloads omit the actual changes. Read exactly the item
            // associated with this request, never another turn's proposed patch.
            let item = {};
            if (kind === "files" || (kind === "command" && !params.command && !params.networkApprovalContext)) {
                try {
                    const read = record(await client.request("thread/read", { threadId: data.thread_id, includeTurns: true }));
                    const thread = record(read.thread);
                    const turn = (Array.isArray(thread.turns) ? thread.turns : []).map(record).find(t => t.id === params.turnId);
                    item = (Array.isArray(turn?.items) ? turn.items : []).map(record).find(i => i.id === params.itemId) ?? {};
                }
                catch { /* Rejection remains available; missing scope never enables approval. */ }
            }
            if (closed || resolved.has(JSON.stringify(request.id)))
                return;
            const scope = kind === "permissions" ? { permissions: params.permissions, duration: "This turn only" }
                : kind === "files" ? { changes: item.changes, grantRoot: params.grantRoot, environment: params.environmentId, duration: params.grantRoot ? "Requested root access for this session" : "This request only" }
                    : { command: params.command ?? item.command, cwd: params.cwd ?? item.cwd, network: params.networkApprovalContext,
                        additionalPermissions: params.additionalPermissions, environment: params.environmentId, duration: "This request only" };
            const complete = kind === "permissions" ? validPermissions(params.permissions)
                : kind === "files" ? item.type === "fileChange" && Array.isArray(item.changes) && item.changes.length > 0 && item.changes.every((change) => typeof change.path === "string" && typeof change.diff === "string" && ["add", "delete", "update"].includes(change.kind?.type)) : typeof scope.command === "string" && scope.command.length > 0 || validNetwork(scope.network);
            const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ["accept", "decline"];
            const choices = [];
            if (kind === "permissions" || decisions.includes("accept"))
                choices.push("approve");
            if (kind === "permissions" || decisions.includes("decline") || decisions.includes("cancel"))
                choices.push("reject");
            requests.create(connectionId, request.id, { agent_id: data.agent_id, thread_id: data.thread_id, turn_id: params.turnId,
                item_id: params.itemId, kind, title: kind === "command" ? "Command approval" : kind === "files" ? "File change approval" : "Additional permissions",
                reason: typeof params.reason === "string" ? params.reason : null, scope, scope_complete: complete, choices,
                ...(kind !== "permissions" && !decisions.includes("decline") && decisions.includes("cancel") ? { reject_interrupts_turn: true } : {}) });
        })().catch(() => { client.close(); });
    });
    const removeNotification = client.onNotification(notification => {
        const params = record(notification.params);
        if (params.threadId !== data.thread_id)
            return;
        if (notification.method === "serverRequest/resolved" && (typeof params.requestId === "string" || typeof params.requestId === "number")) {
            resolved.add(JSON.stringify(params.requestId));
            requests.resolve(connectionId, params.requestId, data.thread_id);
        }
        if (notification.method === "turn/completed") {
            const id = record(params.turn).id ?? params.turnId;
            if (typeof id === "string")
                completed.add(id);
            if (id === turnId && data.closeOnTurnCompleted !== false)
                setTimeout(() => client.close(), 0);
        }
    });
    const timer = setInterval(() => {
        if (closed)
            return;
        try {
            requests.heartbeat(connectionId);
            requests.dispatchDecisions(connectionId, response => client.respond(JSON.parse(response.rpc_id), JSON.parse(response.response_json)));
        }
        catch {
            client.close();
        }
    }, 100);
    timer.unref();
    const removeClose = client.onClose(() => {
        if (closed)
            return;
        closed = true;
        bind("");
        clearInterval(timer);
        removeRequest();
        removeNotification();
        removeClose();
        requests.disconnect(connectionId);
        db.close();
        client.retainForApprovals = false;
    });
}
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
function validNetwork(value) {
    const network = record(value);
    return typeof network.host === "string" && network.host.length > 0 && typeof network.protocol === "string";
}
function validPermissions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const permissions = record(value);
    if (Object.keys(permissions).some(key => !["network", "fileSystem"].includes(key)))
        return false;
    if (permissions.network != null && (typeof permissions.network !== "object" || Array.isArray(permissions.network) || Object.keys(permissions.network).some(key => key !== "enabled") || typeof permissions.network.enabled !== "boolean"))
        return false;
    if (permissions.fileSystem != null) {
        const fs = record(permissions.fileSystem);
        if (!Object.keys(fs).length || Object.keys(fs).some(key => !["read", "write", "entries", "globScanMaxDepth"].includes(key)))
            return false;
        if (fs.globScanMaxDepth != null && (!Number.isInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 0))
            return false;
        for (const key of ["read", "write"])
            if (fs[key] != null && (!Array.isArray(fs[key]) || !fs[key].every((path) => typeof path === "string")))
                return false;
        if (fs.entries != null && (!Array.isArray(fs.entries) || !fs.entries.every((entry) => ["read", "write", "deny"].includes(entry.access) && ((entry.path?.type === "path" && typeof entry.path.path === "string") || (entry.path?.type === "glob_pattern" && typeof entry.path.pattern === "string")))))
            return false;
    }
    return Boolean(permissions.network || permissions.fileSystem);
}
