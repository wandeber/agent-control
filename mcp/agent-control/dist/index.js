import { consoleQuestionAnswerSchema, questionAnswersJsonSchema } from "./tools/questions.js";
import { canvasSetSchema } from "./tools/schemas.js";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createController } from "./core/factory.js";
import { errorToPayload } from "./core/errors.js";
import { currentCodexThreadId, withMcpCaller } from "./core/caller-context.js";
import { AGENT_CONTROL_VERSION } from "./core/version.js";
import { loadConsoleSnapshot } from "./console-tools.js";
import { previewFlowCatalog } from "./core/flow-preview.js";
import { readCodexSession } from "./adapters/codex-session.js";
import { ConsoleSessions } from "./console-sessions.js";
import { openBrowserConsole } from "./browser-console.js";
import { escapeInlineScript } from "./inline-script.js";
import { handleTool } from "./tools/handlers.js";
import { TOOL_DEFINITIONS } from "./tools/tool-definitions.js";
const { controller, store } = createController();
const MCP_APP_VERSION = AGENT_CONTROL_VERSION;
const CONSOLE_RESOURCE_URI = `ui://agent-control/${MCP_APP_VERSION}/console.html`;
const CONSOLE_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(MODULE_DIR, "../../..");
const WEB_RUNTIME_DIR = join(PLUGIN_ROOT, "web-runtime");
const CONSOLE_RESOURCE_UI_META = {
    csp: { connectDomains: [], resourceDomains: [] },
    prefersBorder: false
};
const APP_TOOL_META = { ui: { resourceUri: CONSOLE_RESOURCE_URI, visibility: ["app"] } };
const MODEL_CONSOLE_META = {
    ui: { resourceUri: CONSOLE_RESOURCE_URI, visibility: ["model"] },
    "ui/resourceUri": CONSOLE_RESOURCE_URI,
    "openai/outputTemplate": CONSOLE_RESOURCE_URI,
    "openai/widgetAccessible": true
};
const consoleSessions = new ConsoleSessions();
const PANEL_ID_PROPERTY = { panel_id: { type: "string", description: "Panel identity returned when this console was opened." } };
const FLOW_SELECTION_PROPERTIES = {
    screen: { type: "string", enum: ["console", "subagents", "flows"], description: "Select Flows to inspect or live-preview a definition without starting a run." },
    flow_id: { type: "string", description: "Catalog flow ID to preview, including a new flow being authored." },
    repo_dir: { type: "string", description: "Absolute task project directory for local flows and model overrides. Inferred from the calling thread when omitted." }
};
const APP_TOOL_DEFINITIONS = [
    { name: "agent_control_console_question_answer", description: "App-only. Record the user's submitted answers for an agent question associated with this conversation, independently of the selected room/chat.",
        inputSchema: { type: "object", properties: { ...PANEL_ID_PROPERTY, agent_id: { type: "string" }, question_id: { type: "string" }, answers: questionAnswersJsonSchema }, required: ["panel_id", "agent_id", "question_id", "answers"], additionalProperties: false }, _meta: APP_TOOL_META },
    { name: "agent_control_console_canvas_positions", description: "App-only. Persist a node drag or organize action for a run associated with this panel.",
        inputSchema: { type: "object", properties: { ...PANEL_ID_PROPERTY, run_id: { type: "string" }, expected_revision: { type: "integer" }, positions: { type: "array", items: { type: "object", properties: { agent_id: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["agent_id", "x", "y"], additionalProperties: false } } }, required: ["panel_id", "run_id", "expected_revision", "positions"], additionalProperties: false }, _meta: APP_TOOL_META },
    { name: "agent_control_console_access_request", description: "App-only. Set this agent's explicit access policy for its next turn; never interrupts work or grants the current pending permission.",
        inputSchema: { type: "object", properties: { ...PANEL_ID_PROPERTY, agent_id: { type: "string" }, revision: { type: "number" }, policy: { type: "object", properties: { sandbox: { type: "string", enum: ["read_only", "workspace", "full_access"] }, approval_policy: { type: "string", enum: ["on-request", "never", "untrusted"] } }, required: ["sandbox", "approval_policy"], additionalProperties: false } }, required: ["panel_id", "agent_id", "revision", "policy"], additionalProperties: false }, _meta: APP_TOOL_META },
    { name: "agent_control_console_permission_decide", description: "App-only. Submit the user's explicit decision for a live backend permission request in this panel's run.",
        inputSchema: { type: "object", properties: { ...PANEL_ID_PROPERTY, agent_id: { type: "string" }, request_id: { type: "string" }, decision: { type: "string", enum: ["approve", "reject"] } }, required: ["panel_id", "agent_id", "request_id", "decision"], additionalProperties: false }, _meta: APP_TOOL_META },
    {
        name: "agent_control_console_flows",
        description: "App-only. Read catalog definitions and prompt files in this panel project; never launches work.",
        inputSchema: { type: "object", properties: { ...PANEL_ID_PROPERTY, flow_id: { type: "string" }, command_id: { type: "string" } }, required: ["panel_id"], additionalProperties: false },
        _meta: APP_TOOL_META
    },
    {
        name: "agent_control_console_snapshot",
        description: "App-only. Return the Agent Control dashboard snapshot for the console.",
        inputSchema: {
            type: "object",
            properties: {
                ...PANEL_ID_PROPERTY,
                run_id: { type: "string", description: "Optional run id to select." },
                command_id: {
                    type: "string",
                    description: "Internal app acknowledgement for the last console command. Do not set from the model."
                }
            },
            required: ["panel_id"],
            additionalProperties: false
        },
        _meta: APP_TOOL_META
    },
    {
        name: "agent_control_console_agent_messages",
        description: "App-only. Return compact latest messages for one registered agent.",
        inputSchema: {
            type: "object",
            properties: {
                ...PANEL_ID_PROPERTY,
                agent_id: { type: "string", description: "Agent id." },
                limit: { type: "number", description: "Maximum messages to return." }
            },
            required: ["panel_id", "agent_id"],
            additionalProperties: false
        },
        _meta: APP_TOOL_META
    },
    {
        name: "agent_control_console_agent_log",
        description: "App-only. Return the controller-owned log tail for one registered agent.",
        inputSchema: {
            type: "object",
            properties: {
                ...PANEL_ID_PROPERTY,
                agent_id: { type: "string", description: "Agent id." },
                max_chars: { type: "number", description: "Maximum characters to return." }
            },
            required: ["panel_id", "agent_id"],
            additionalProperties: false
        },
        _meta: APP_TOOL_META
    },
    {
        name: "agent_control_console_open_browser",
        description: "App-only. Open the global console in the system browser when the user presses Full screen.",
        inputSchema: {
            type: "object",
            properties: {
                ...PANEL_ID_PROPERTY,
                run_id: { type: "string" },
                flow_id: { type: "string" },
                screen: { type: "string", enum: ["console", "subagents", "flows"] }
            },
            required: ["panel_id"],
            additionalProperties: false
        },
        _meta: APP_TOOL_META
    }
];
const OPEN_CONSOLE_TOOL = {
    name: "open_agent_control_console",
    description: "Show a flow before execution with screen: flows, flow_id and the task repo_dir; the view follows source edits without a run. Open the native Agent Control panel for the calling Codex conversation. Only its associated runs are visible, using the host thread identity automatically. Pin run_id when supplied or follow its latest run. Call this once, then reuse the existing panel. The Full screen button opens the global console in the system browser.",
    inputSchema: {
        type: "object",
        properties: {
            ...FLOW_SELECTION_PROPERTIES,
            run_id: { type: "string", description: "Optional run id to select when opening the console." }
        },
        additionalProperties: false
    },
    _meta: MODEL_CONSOLE_META
};
const REUSE_CONSOLE_TOOL = {
    name: "reuse_agent_control_console",
    description: "Reuse and update the already-open Agent Control panel without opening another tab. Set screen: flows, flow_id and repo_dir to live-preview source definitions while authoring, without starting work. Optionally pin run_id; use this after the first open_agent_control_console call.",
    inputSchema: {
        type: "object",
        properties: {
            ...FLOW_SELECTION_PROPERTIES,
            run_id: { type: "string", description: "Optional run id to select in the existing panel." }
        },
        additionalProperties: false
    }
};
const CLOSE_CONSOLE_TOOL = {
    name: "close_agent_control_console",
    description: "Request the currently-open Agent Control panel to close. The MCP host may decline the teardown; this command never opens a new panel.",
    inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
    }
};
const server = new Server({
    name: "agent_control",
    version: AGENT_CONTROL_VERSION
}, {
    capabilities: {
        tools: {},
        resources: {}
    }
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        ...TOOL_DEFINITIONS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
        })),
        OPEN_CONSOLE_TOOL,
        REUSE_CONSOLE_TOOL,
        CLOSE_CONSOLE_TOOL,
        ...APP_TOOL_DEFINITIONS
    ]
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
        {
            uri: CONSOLE_RESOURCE_URI,
            name: "Agent Control Console",
            description: "Native Codex panel for inspecting Agent Control runs, agents, flows, events, goals, and logs.",
            mimeType: CONSOLE_RESOURCE_MIME_TYPE,
            _meta: { ui: CONSOLE_RESOURCE_UI_META }
        }
    ]
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== CONSOLE_RESOURCE_URI) {
        throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    return {
        contents: [
            {
                uri: CONSOLE_RESOURCE_URI,
                mimeType: CONSOLE_RESOURCE_MIME_TYPE,
                text: await readConsoleHtml(),
                _meta: { ui: CONSOLE_RESOURCE_UI_META }
            }
        ]
    };
});
const activeCalls = new Set();
const shutdownCancellation = new AbortController();
let shutdownTask;
server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const call = (async () => {
        if (shutdownCancellation.signal.aborted)
            return jsonResult({ error: "Agent Control is shutting down." }, true);
        const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === request.params.name);
        try {
            const appResult = await withMcpCaller(request.params._meta, () => handleConsoleTool(request.params.name, request.params.arguments ?? {}));
            if (appResult) {
                return appResult;
            }
        }
        catch (error) {
            await controller.drainDeliveries();
            return jsonResult(errorToPayload(error), true);
        }
        if (!tool) {
            return jsonResult({ error: `Unknown tool: ${request.params.name}` }, true);
        }
        try {
            const input = tool.schema.parse(request.params.arguments ?? {});
            const result = await withMcpCaller(request.params._meta, () => handleTool(controller, tool.name, input, AbortSignal.any([extra.signal, shutdownCancellation.signal])));
            await controller.drainDeliveries();
            return jsonResult(result);
        }
        catch (error) {
            await controller.drainDeliveries();
            return jsonResult(errorToPayload(error), true);
        }
    })().finally(() => activeCalls.delete(call));
    activeCalls.add(call);
    return call;
});
const pollIntervalMs = Number(process.env.AGENT_CONTROL_POLL_INTERVAL_MS ?? "0");
let pollTimer;
if (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) {
    pollTimer = setInterval(() => controller.runBackground(() => controller.pollActiveAgents()), pollIntervalMs);
    pollTimer.unref();
}
process.once("SIGINT", () => {
    void shutdown(0);
});
process.once("SIGTERM", () => {
    void shutdown(0);
});
await server.connect(new StdioServerTransport());
function jsonResult(value, isError = false) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(value, null, 2)
            }
        ],
        isError
    };
}
async function handleConsoleTool(name, input) {
    if (name === "open_agent_control_console") {
        const runId = stringField(input, "run_id");
        const threadId = currentCodexThreadId();
        const selection = consoleFlowSelection(input, threadId);
        const snapshot = selection.screen === "flows" ? { console: { requested_run_id: runId ?? null, follow_latest: !runId } }
            : await loadConsoleSnapshot(controller, runId, { threadId: threadId ?? null });
        const session = consoleSessions.open(threadId, selection);
        const structuredContent = { ...snapshot, console: { ...snapshot.console, ...session.selection, panel_id: session.id } };
        return {
            content: [
                {
                    type: "text",
                    text: "Opened Agent Control console."
                }
            ],
            structuredContent,
            _meta: { "openai/outputTemplate": CONSOLE_RESOURCE_URI }
        };
    }
    if (name === "reuse_agent_control_console") {
        const runId = stringField(input, "run_id");
        const threadId = currentCodexThreadId();
        const session = consoleSessions.get(threadId);
        const selection = consoleFlowSelection(input, threadId, session.selection.repo_dir);
        const snapshot = selection.screen === "flows" ? { console: { requested_run_id: runId ?? null, follow_latest: !runId } }
            : await loadConsoleSnapshot(controller, runId, { threadId: session.threadId });
        const command = consoleSessions.queue(session, "reuse", runId, selection).command;
        return {
            content: [{ type: "text", text: "Reused Agent Control console." }],
            structuredContent: {
                ...snapshot,
                console: {
                    ...snapshot.console,
                    ...session.selection,
                    panel_id: session.id,
                    action: command.action,
                    command_id: command.command_id
                }
            }
        };
    }
    if (name === "close_agent_control_console") {
        const session = consoleSessions.queue(consoleSessions.get(currentCodexThreadId()), "close");
        const command = session.command;
        return {
            content: [{ type: "text", text: "Requested Agent Control console teardown." }],
            structuredContent: {
                console: {
                    panel_id: session.id,
                    requested_run_id: null,
                    follow_latest: false,
                    action: command.action,
                    command_id: command.command_id
                }
            }
        };
    }
    if (name === "agent_control_console_flows") {
        const session = consoleSessions.forApp(currentCodexThreadId(), stringField(input, "panel_id"));
        consoleSessions.acknowledge(session, stringField(input, "command_id"));
        const preview = previewFlowCatalog(session.selection.repo_dir, stringField(input, "flow_id") ?? session.selection.flow_id);
        return { content: [{ type: "text", text: "Loaded flow source preview." }], structuredContent: { preview, console: { ...session.selection, ...session.command, panel_id: session.id } } };
    }
    if (name === "agent_control_console_snapshot") {
        const runId = stringField(input, "run_id");
        const session = consoleSessions.forApp(currentCodexThreadId(), stringField(input, "panel_id"));
        const snapshot = await loadConsoleSnapshot(controller, runId, { threadId: session.threadId });
        consoleSessions.acknowledge(session, stringField(input, "command_id"));
        const structuredContent = { ...snapshot, console: { ...session.selection, ...(session.command ?? snapshot.console), panel_id: session.id } };
        return {
            content: [{ type: "text", text: "Loaded Agent Control dashboard snapshot." }],
            structuredContent
        };
    }
    if (name === "agent_control_console_canvas_positions") {
        const session = consoleSessions.forApp(currentCodexThreadId(), stringField(input, "panel_id"));
        const { panel_id, ...args } = input;
        const parsed = canvasSetSchema.parse(args);
        if (!store.listConsoleRuns(session.threadId).some(run => run.run_id === parsed.run_id))
            throw new Error("This run is not associated with this Codex conversation.");
        return { content: [{ type: "text", text: "Saved canvas positions." }], structuredContent: { canvas_positions: controller.setCanvasPositions(parsed.run_id, parsed.expected_revision, parsed.positions) } };
    }
    if (name === "agent_control_console_question_answer") {
        const { panel_id, ...args } = input;
        const parsed = consoleQuestionAnswerSchema.parse(args);
        assertConsoleAgent(input, parsed.agent_id);
        return { content: [{ type: "text", text: "Recorded the user's answer." }], structuredContent: { question: controller.answerConsoleQuestion(parsed.agent_id, parsed.question_id, parsed.answers) } };
    }
    if (name === "agent_control_console_access_request") {
        const agentId = requiredStringField(input, "agent_id");
        assertConsoleAgent(input, agentId);
        return { content: [{ type: "text", text: "Saved requested access for the next turn." }], structuredContent: { access: controller.requestAgentAccess(agentId, input.policy, numberField(input, "revision", -1)) } };
    }
    if (name === "agent_control_console_permission_decide") {
        const agentId = requiredStringField(input, "agent_id");
        assertConsoleAgent(input, agentId);
        const decision = requiredStringField(input, "decision");
        if (decision !== "approve" && decision !== "reject")
            throw new Error("Invalid permission decision.");
        return { content: [{ type: "text", text: "Submitted backend permission decision." }], structuredContent: { permission: controller.decidePermission(agentId, requiredStringField(input, "request_id"), decision) } };
    }
    if (name === "agent_control_console_agent_messages") {
        const agentId = requiredStringField(input, "agent_id");
        assertConsoleAgent(input, agentId);
        const limit = numberField(input, "limit", 12);
        return {
            content: [{ type: "text", text: "Loaded Agent Control agent messages." }],
            structuredContent: { messages: await controller.listAgentMessages(agentId, { limit }) }
        };
    }
    if (name === "agent_control_console_agent_log") {
        const agentId = requiredStringField(input, "agent_id");
        assertConsoleAgent(input, agentId);
        const maxChars = numberField(input, "max_chars", 16000);
        return {
            content: [{ type: "text", text: "Loaded Agent Control agent log." }],
            structuredContent: { log: controller.readAgentLogTail(agentId, maxChars) }
        };
    }
    if (name === "agent_control_console_open_browser") {
        const session = consoleSessions.forApp(currentCodexThreadId(), stringField(input, "panel_id"));
        const runId = stringField(input, "run_id");
        if (runId)
            controller.getDashboardSnapshot(runId, { threadId: session.threadId });
        const result = await openBrowserConsole(runId, stringField(input, "screen") === "flows" ? "flows" : stringField(input, "screen") === "subagents" ? "subagents" : "console", { ...session.selection, flow_id: stringField(input, "flow_id") ?? session.selection.flow_id });
        return { content: [{ type: "text", text: "Opened the global console in the system browser." }], structuredContent: result };
    }
    return null;
}
function consoleFlowSelection(input, threadId, previousRepo) {
    const screen = stringField(input, "screen");
    const repo = stringField(input, "repo_dir") ?? previousRepo ?? (threadId ? readCodexSession(threadId)?.cwd : undefined);
    return { ...(screen === "flows" || screen === "console" || screen === "subagents" ? { screen } : {}),
        ...(stringField(input, "flow_id") ? { flow_id: stringField(input, "flow_id") } : {}),
        ...(repo ? { repo_dir: resolve(repo) } : {}) };
}
function assertConsoleAgent(input, agentId) {
    const session = consoleSessions.forApp(currentCodexThreadId(), stringField(input, "panel_id"));
    const agent = controller.getAgent(agentId);
    if (!store.listConsoleRuns(session.threadId).some(run => run.run_id === agent.run_id)) {
        throw new Error("This agent is not associated with this Codex conversation.");
    }
}
async function readConsoleHtml() {
    const html = await readFile(join(WEB_RUNTIME_DIR, "index.html"), "utf8");
    return await inlineWebRuntimeAssets(html);
}
async function inlineWebRuntimeAssets(html) {
    const withoutPreloads = html.replace(/<link\b[^>]*\brel=["']preload["'][^>]*>/g, "");
    const withStyles = await replaceAsync(withoutPreloads, /<link\b([^>]*?)\brel=["']stylesheet["']([^>]*?)\bhref=["']([^"']+)["']([^>]*?)\/?>/g, async (_match, before, middle, href, after) => {
        const assetPath = runtimeAssetPath(String(href));
        if (!assetPath) {
            return `<link${before} rel="stylesheet"${middle} href="${href}"${after}/>`;
        }
        const css = await readFile(assetPath, "utf8");
        // React's resource hydration looks for the original stylesheet link.
        // Keep a disabled marker to prevent it from fetching the already-inlined
        // CSS from an asset server that does not exist in the MCP host.
        return `<style data-agent-control-inline-asset="${escapeHtml(String(href))}">\n${css}\n</style><link${before} rel="stylesheet"${middle} href="${href}"${after} disabled/>`;
    });
    return await replaceAsync(withStyles, /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)><\/script>/g, async (_match, before, src, after) => {
        const assetPath = runtimeAssetPath(String(src));
        if (!assetPath) {
            return `<script${before} src="${src}"${after}></script>`;
        }
        const js = escapeInlineScript(await readFile(assetPath, "utf8"));
        return `<script${stripAsyncAttribute(`${before}${after}`)} data-agent-control-inline-asset="${escapeHtml(String(src))}">\n${js}\n</script>`;
    });
}
function runtimeAssetPath(href) {
    if (!href.startsWith("/_next/")) {
        return null;
    }
    return join(WEB_RUNTIME_DIR, href.slice(1));
}
async function replaceAsync(input, pattern, replacement) {
    const matches = [...input.matchAll(pattern)];
    if (matches.length === 0) {
        return input;
    }
    const replacements = await Promise.all(matches.map((match) => replacement(...match)));
    let output = "";
    let lastIndex = 0;
    matches.forEach((match, index) => {
        output += input.slice(lastIndex, match.index);
        output += replacements[index];
        lastIndex = (match.index ?? 0) + match[0].length;
    });
    output += input.slice(lastIndex);
    return output;
}
function stripAsyncAttribute(attributes) {
    return attributes.replace(/\sasync(=["'][^"']*["'])?/g, "").replace(/\sdefer(=["'][^"']*["'])?/g, "");
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
function stringField(input, key) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return undefined;
    }
    const value = input[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function requiredStringField(input, key) {
    const value = stringField(input, key);
    if (!value) {
        throw new Error(`${key} is required.`);
    }
    return value;
}
function numberField(input, key, fallback) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return fallback;
    }
    const value = input[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function shutdown(code) {
    return shutdownTask ??= (async () => {
        shutdownCancellation.abort();
        if (pollTimer)
            clearInterval(pollTimer);
        await Promise.allSettled([...activeCalls]);
        await controller.dispose();
        await server.close();
        store.close();
        process.exit(code);
    })();
}
