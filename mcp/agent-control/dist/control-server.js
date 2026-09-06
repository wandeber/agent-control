import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createController } from "./core/factory.js";
export async function startControlServer(options) {
    const { controller, store } = createController();
    let closing = false;
    const activeRequests = new Set();
    const socketTimers = new Set();
    const server = createServer((request, response) => {
        const work = handleRequest(request, response).finally(() => activeRequests.delete(work));
        activeRequests.add(work);
    });
    const handleRequest = async (request, response) => {
        if (closing) {
            response.writeHead(503);
            response.end();
            return;
        }
        setCorsHeaders(response);
        if (request.method === "OPTIONS") {
            response.statusCode = 204;
            response.end();
            return;
        }
        try {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${options.host}:${options.port}`}`);
            if (url.pathname === "/") {
                sendJson(response, 200, {
                    name: "Agent Control API",
                    status: "ok",
                    endpoints: [
                        "/api/control/health",
                        "/api/control/snapshot",
                        "/api/control/auth/orchestrator-login",
                        "/api/control/runs",
                        "/api/control/agents/:id/messages",
                        "/api/control/agents/:id/log",
                        "/ws/control"
                    ]
                });
                return;
            }
            if (url.pathname === "/api/control/health") {
                sendJson(response, 200, {
                    ok: true,
                    name: "Agent Control API"
                });
                return;
            }
            if (url.pathname.startsWith("/api/control")) {
                await handleApi(controller, request, response, url);
                return;
            }
            sendJson(response, 404, { error: "Not found." });
        }
        catch (error) {
            sendJson(response, 500, {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    };
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${options.host}:${options.port}`}`);
        if (url.pathname !== "/ws/control") {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (client) => {
            wss.emit("connection", client, request);
        });
    });
    wss.on("connection", (client) => {
        const state = {
            runId: null,
            agentId: null,
            seenEventIds: new Set(controller.listEvents({ limit: 100 }).map((event) => event.event_id)),
            lastLogBytes: 0,
            lastMessageSignature: ""
        };
        sendSocket(client, {
            type: "snapshot",
            snapshot: controller.getDashboardSnapshot()
        });
        client.on("message", (raw) => {
            try {
                const message = JSON.parse(String(raw));
                if (message.type === "select") {
                    state.runId = message.run_id ?? state.runId;
                    state.agentId = message.agent_id ?? null;
                    state.lastLogBytes = 0;
                    state.lastMessageSignature = "";
                    sendSocket(client, {
                        type: "snapshot",
                        snapshot: controller.getDashboardSnapshot(state.runId)
                    });
                }
            }
            catch {
                sendSocket(client, { type: "error", error: "Invalid websocket message." });
            }
        });
        const timer = setInterval(() => {
            controller.runBackground(() => tickSocket(controller, client, state));
        }, 1000);
        timer.unref();
        socketTimers.add(timer);
        client.once("close", () => { clearInterval(timer); socketTimers.delete(timer); });
    });
    let cleanupTask;
    const cleanup = () => cleanupTask ??= (async () => {
        closing = true;
        for (const timer of socketTimers)
            clearInterval(timer);
        for (const client of wss.clients)
            client.terminate();
        wss.close();
        await Promise.allSettled([...activeRequests]);
        await controller.dispose();
        store.close();
    })();
    server.once("close", () => { void cleanup(); });
    await new Promise((resolveListen) => {
        server.listen(options.port, options.host, resolveListen);
    });
    let closeTask;
    return {
        server,
        close: () => closeTask ??= (async () => {
            // Stop accepting work first; upgraded sockets otherwise keep close pending.
            closing = true;
            for (const client of wss.clients)
                client.terminate();
            await new Promise((resolveClose, rejectClose) => {
                server.close((error) => error ? rejectClose(error) : resolveClose());
            });
            await cleanup();
        })()
    };
}
async function tickSocket(controller, client, state) {
    if (client.readyState !== client.OPEN) {
        return;
    }
    await controller.pollActiveAgents(state.runId ?? undefined);
    const snapshot = controller.getDashboardSnapshot(state.runId);
    sendSocket(client, { type: "snapshot", snapshot });
    if (state.agentId && !snapshot.agents.some((agent) => agent.agent_id === state.agentId)) {
        state.agentId = null;
        state.lastLogBytes = 0;
        state.lastMessageSignature = "";
    }
    const events = controller
        .listEvents({ runId: state.runId ?? undefined, limit: 100 })
        .reverse()
        .filter((event) => !state.seenEventIds.has(event.event_id));
    for (const event of events) {
        state.seenEventIds.add(event.event_id);
        sendSocket(client, { type: "event", event });
    }
    if (state.agentId) {
        try {
            const messages = await controller.listAgentMessages(state.agentId, { limit: 96 });
            const messageSignature = JSON.stringify(messages.map((message) => {
                const item = message && typeof message === "object" ? message : {};
                return [item.id, item.role, item.created_at, typeof item.text === "string" ? item.text.length : 0, item.metadata];
            }));
            if (messageSignature !== state.lastMessageSignature) {
                state.lastMessageSignature = messageSignature;
                sendSocket(client, { type: "agent_messages", agent_id: state.agentId, messages });
            }
            const log = controller.readAgentLogTail(state.agentId, 8000);
            if (log.exists && log.bytes !== state.lastLogBytes) {
                state.lastLogBytes = log.bytes;
                sendSocket(client, { type: "agent_log", log });
            }
        }
        catch (error) {
            state.agentId = null;
            state.lastLogBytes = 0;
            state.lastMessageSignature = "";
            sendSocket(client, { type: "error", error: error instanceof Error ? error.message : String(error) });
        }
    }
}
async function handleApi(controller, request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/control/snapshot") {
        sendJson(response, 200, controller.getDashboardSnapshot(url.searchParams.get("run_id")));
        return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/auth/orchestrator-login") {
        const body = await readJson(request);
        sendJson(response, 201, controller.orchestratorLogin({
            adminKey: stringField(body, "admin_key"),
            title: stringField(body, "title"),
            runTitle: optionalStringField(body, "run_title"),
            repoDir: optionalStringField(body, "repo_dir"),
            runId: optionalStringField(body, "run_id"),
            backend: optionalStringField(body, "backend"),
            objective: optionalStringField(body, "objective"),
            model: optionalStringField(body, "model"),
            backendHandle: optionalObjectField(body, "backend_handle")
        }));
        return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/runs") {
        const body = await readJson(request);
        if (!optionalStringField(body, "admin_key") && !optionalStringField(body, "agent_token")) {
            throw new Error("run create requires admin_key or agent_token.");
        }
        sendJson(response, 201, controller.createRun({
            title: stringField(body, "title"),
            repoDir: optionalStringField(body, "repo_dir"),
            adminKey: optionalStringField(body, "admin_key"),
            agentToken: optionalStringField(body, "agent_token")
        }));
        return;
    }
    const agentMessages = url.pathname.match(/^\/api\/control\/agents\/([^/]+)\/messages$/);
    if (request.method === "GET" && agentMessages) {
        const limit = numberParam(url.searchParams.get("limit"), 5);
        sendJson(response, 200, await controller.listAgentMessages(agentMessages[1], { limit }));
        return;
    }
    const agentLog = url.pathname.match(/^\/api\/control\/agents\/([^/]+)\/log$/);
    if (request.method === "GET" && agentLog) {
        const maxChars = numberParam(url.searchParams.get("max_chars"), 8000);
        sendJson(response, 200, controller.readAgentLogTail(agentLog[1], maxChars));
        return;
    }
    const artifactFile = url.pathname.match(/^\/api\/control\/artifacts\/([^/]+)\/file$/);
    if (request.method === "GET" && artifactFile) {
        const artifactId = decodeURIComponent(artifactFile[1]);
        const artifact = controller.listArtifacts().find((entry) => entry.artifact_id === artifactId);
        if (!artifact || !existsSync(artifact.path)) {
            sendJson(response, 404, { error: "Artifact file not found." });
            return;
        }
        const contentType = imageContentType(artifact.path);
        if (!contentType) {
            sendJson(response, 415, { error: "Artifact is not a supported image." });
            return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", contentType);
        createReadStream(artifact.path).pipe(response);
        return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/links") {
        const body = await readJson(request);
        const caller = optionalStringField(body, "agent_token")
            ? controller.requireAgentToken(optionalStringField(body, "agent_token"))
            : null;
        sendJson(response, 201, controller.createAgentLink({
            runId: optionalStringField(body, "run_id") ?? caller?.run_id ?? missingStringField("run_id"),
            sourceAgentId: stringField(body, "source_agent_id"),
            targetAgentId: stringField(body, "target_agent_id"),
            type: stringField(body, "type"),
            label: optionalStringField(body, "label")
        }));
        return;
    }
    const linkDelete = url.pathname.match(/^\/api\/control\/links\/([^/]+)$/);
    if (request.method === "DELETE" && linkDelete) {
        sendJson(response, 200, controller.deleteAgentLink(linkDelete[1]));
        return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/usage") {
        const body = await readJson(request);
        sendJson(response, 201, controller.createUsageSnapshot({
            runId: stringField(body, "run_id"),
            agentId: stringField(body, "agent_id"),
            inputTokens: optionalNumberField(body, "input_tokens"),
            outputTokens: optionalNumberField(body, "output_tokens"),
            totalTokens: optionalNumberField(body, "total_tokens"),
            contextUsed: optionalNumberField(body, "context_used"),
            contextLimit: optionalNumberField(body, "context_limit"),
            source: optionalStringField(body, "source"),
            model: optionalStringField(body, "model")
        }));
        return;
    }
    sendJson(response, 404, { error: "Not found." });
}
function sendJson(response, status, value) {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(value));
}
function setCorsHeaders(response) {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
}
function sendSocket(client, payload) {
    if (client.readyState === client.OPEN) {
        client.send(JSON.stringify(payload));
    }
}
async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) {
        return {};
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
}
function stringField(body, key) {
    const value = body[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Missing string field: ${key}`);
    }
    return value;
}
function optionalStringField(body, key) {
    const value = body[key];
    return typeof value === "string" && value.length > 0 ? value : null;
}
function optionalObjectField(body, key) {
    const value = body[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function missingStringField(key) {
    throw new Error(`Missing string field: ${key}`);
}
function optionalNumberField(body, key) {
    const value = body[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function numberParam(value, fallback) {
    const parsed = value ? Number.parseInt(value, 10) : fallback;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function imageContentType(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".png")) {
        return "image/png";
    }
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
        return "image/jpeg";
    }
    if (lower.endsWith(".gif")) {
        return "image/gif";
    }
    if (lower.endsWith(".webp")) {
        return "image/webp";
    }
    if (lower.endsWith(".svg")) {
        return "image/svg+xml";
    }
    return null;
}
