import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createController } from "./core/factory.js";
import { errorToPayload } from "./core/errors.js";
import { loadConsoleSnapshot } from "./console-tools.js";
import { handleTool } from "./tools/handlers.js";
import { TOOL_DEFINITIONS } from "./tools/tool-definitions.js";
const { controller, store } = createController();
const MCP_APP_VERSION = "0.1.0";
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
const APP_TOOL_DEFINITIONS = [
    {
        name: "agent_control_console_snapshot",
        description: "App-only. Return the Agent Control dashboard snapshot for the console.",
        inputSchema: {
            type: "object",
            properties: {
                run_id: { type: "string", description: "Optional run id to select." }
            },
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
                agent_id: { type: "string", description: "Agent id." },
                limit: { type: "number", description: "Maximum messages to return." }
            },
            required: ["agent_id"],
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
                agent_id: { type: "string", description: "Agent id." },
                max_chars: { type: "number", description: "Maximum characters to return." }
            },
            required: ["agent_id"],
            additionalProperties: false
        },
        _meta: APP_TOOL_META
    }
];
const OPEN_CONSOLE_TOOL = {
    name: "open_agent_control_console",
    description: "Open the native Agent Control console as a Codex MCP App panel, pinning run_id when supplied or following the latest run otherwise.",
    inputSchema: {
        type: "object",
        properties: {
            run_id: { type: "string", description: "Optional run id to select when opening the console." }
        },
        additionalProperties: false
    },
    _meta: MODEL_CONSOLE_META
};
const server = new Server({
    name: "agent_control",
    version: "0.1.0"
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
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === request.params.name);
    try {
        const appResult = await handleConsoleTool(request.params.name, request.params.arguments ?? {});
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
        const result = await handleTool(controller, tool.name, input);
        await controller.drainDeliveries();
        return jsonResult(result);
    }
    catch (error) {
        await controller.drainDeliveries();
        return jsonResult(errorToPayload(error), true);
    }
});
const pollIntervalMs = Number(process.env.AGENT_CONTROL_POLL_INTERVAL_MS ?? "0");
if (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) {
    setInterval(() => {
        void controller.pollActiveAgents().catch(() => {
            // Background polling is best-effort. Explicit MCP calls surface errors.
        });
    }, pollIntervalMs).unref();
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
        const structuredContent = await loadConsoleSnapshot(controller, runId);
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
    if (name === "agent_control_console_snapshot") {
        const runId = stringField(input, "run_id");
        return {
            content: [{ type: "text", text: "Loaded Agent Control dashboard snapshot." }],
            structuredContent: await loadConsoleSnapshot(controller, runId)
        };
    }
    if (name === "agent_control_console_agent_messages") {
        const agentId = requiredStringField(input, "agent_id");
        const limit = numberField(input, "limit", 12);
        return {
            content: [{ type: "text", text: "Loaded Agent Control agent messages." }],
            structuredContent: { messages: await controller.listAgentMessages(agentId, { limit }) }
        };
    }
    if (name === "agent_control_console_agent_log") {
        const agentId = requiredStringField(input, "agent_id");
        const maxChars = numberField(input, "max_chars", 16000);
        return {
            content: [{ type: "text", text: "Loaded Agent Control agent log." }],
            structuredContent: { log: controller.readAgentLogTail(agentId, maxChars) }
        };
    }
    return null;
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
        return `<style data-agent-control-inline-asset="${escapeHtml(String(href))}">\n${css}\n</style>`;
    });
    return await replaceAsync(withStyles, /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)><\/script>/g, async (_match, before, src, after) => {
        const assetPath = runtimeAssetPath(String(src));
        if (!assetPath) {
            return `<script${before} src="${src}"${after}></script>`;
        }
        const js = (await readFile(assetPath, "utf8")).replaceAll("</script", "<\\/script");
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
async function shutdown(code) {
    await controller.drainDeliveries();
    store.close();
    process.exit(code);
}
