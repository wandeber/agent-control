import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { createController } from "./core/factory.js";
import { errorToPayload } from "./core/errors.js";
import { loadConsoleSnapshot } from "./console-tools.js";
import { escapeInlineScript } from "./inline-script.js";
import { handleTool } from "./tools/handlers.js";
import { TOOL_DEFINITIONS } from "./tools/tool-definitions.js";

const { controller, store } = createController();
const MCP_APP_VERSION = "0.1.9";
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
] as const;

const OPEN_CONSOLE_TOOL = {
  name: "open_agent_control_console",
  description:
    "Open the native Agent Control console as a Codex MCP App panel, pinning run_id when supplied or following the latest run otherwise.",
  inputSchema: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "Optional run id to select when opening the console." }
    },
    additionalProperties: false
  },
  _meta: MODEL_CONSOLE_META
} as const;

const server = new Server(
  {
    name: "agent_control",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

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

const activeCalls = new Set<Promise<unknown>>();
const shutdownCancellation = new AbortController();
let shutdownTask: Promise<void> | undefined;
server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
  const call = (async () => {
    if (shutdownCancellation.signal.aborted) return jsonResult({ error: "Agent Control is shutting down." }, true);
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === request.params.name);

  try {
    const appResult = await handleConsoleTool(request.params.name, request.params.arguments ?? {});
    if (appResult) {
      return appResult;
    }
  } catch (error) {
    await controller.drainDeliveries();
    return jsonResult(errorToPayload(error), true);
  }

  if (!tool) {
    return jsonResult({ error: `Unknown tool: ${request.params.name}` }, true);
  }

  try {
    const input = tool.schema.parse(request.params.arguments ?? {});
    const result = await handleTool(controller, tool.name, input as Record<string, unknown>, AbortSignal.any([extra.signal, shutdownCancellation.signal]));
    await controller.drainDeliveries();
    return jsonResult(result);
  } catch (error) {
    await controller.drainDeliveries();
    return jsonResult(errorToPayload(error), true);
  }
  })().finally(() => activeCalls.delete(call));
  activeCalls.add(call);
  return call;
});

const pollIntervalMs = Number(process.env.AGENT_CONTROL_POLL_INTERVAL_MS ?? "0");
let pollTimer: ReturnType<typeof setInterval> | undefined;
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

function jsonResult(value: unknown, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
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

async function handleConsoleTool(
  name: string,
  input: unknown
): Promise<
  | {
      content: Array<{ type: "text"; text: string }>;
      structuredContent?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }
  | null
> {
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

async function readConsoleHtml(): Promise<string> {
  const html = await readFile(join(WEB_RUNTIME_DIR, "index.html"), "utf8");
  return await inlineWebRuntimeAssets(html);
}

async function inlineWebRuntimeAssets(html: string): Promise<string> {
  const withoutPreloads = html.replace(/<link\b[^>]*\brel=["']preload["'][^>]*>/g, "");
  const withStyles = await replaceAsync(
    withoutPreloads,
    /<link\b([^>]*?)\brel=["']stylesheet["']([^>]*?)\bhref=["']([^"']+)["']([^>]*?)\/?>/g,
    async (_match, before, middle, href, after) => {
      const assetPath = runtimeAssetPath(String(href));
      if (!assetPath) {
        return `<link${before} rel="stylesheet"${middle} href="${href}"${after}/>`;
      }
      const css = await readFile(assetPath, "utf8");
      // React's resource hydration looks for the original stylesheet link.
      // Keep a disabled marker to prevent it from fetching the already-inlined
      // CSS from an asset server that does not exist in the MCP host.
      return `<style data-agent-control-inline-asset="${escapeHtml(String(href))}">\n${css}\n</style><link${before} rel="stylesheet"${middle} href="${href}"${after} disabled/>`;
    }
  );

  return await replaceAsync(
    withStyles,
    /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)><\/script>/g,
    async (_match, before, src, after) => {
      const assetPath = runtimeAssetPath(String(src));
      if (!assetPath) {
        return `<script${before} src="${src}"${after}></script>`;
      }
      const js = escapeInlineScript(await readFile(assetPath, "utf8"));
      return `<script${stripAsyncAttribute(`${before}${after}`)} data-agent-control-inline-asset="${escapeHtml(
        String(src)
      )}">\n${js}\n</script>`;
    }
  );
}

function runtimeAssetPath(href: string): string | null {
  if (!href.startsWith("/_next/")) {
    return null;
  }
  return join(WEB_RUNTIME_DIR, href.slice(1));
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacement: (...match: string[]) => Promise<string>
): Promise<string> {
  const matches = [...input.matchAll(pattern)];
  if (matches.length === 0) {
    return input;
  }
  const replacements = await Promise.all(matches.map((match) => replacement(...(match as unknown as string[]))));
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

function stripAsyncAttribute(attributes: string): string {
  return attributes.replace(/\sasync(=["'][^"']*["'])?/g, "").replace(/\sdefer(=["'][^"']*["'])?/g, "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredStringField(input: unknown, key: string): string {
  const value = stringField(input, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function numberField(input: unknown, key: string, fallback: number): number {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function shutdown(code: number): Promise<void> {
  return shutdownTask ??= (async () => {
    shutdownCancellation.abort();
    if (pollTimer) clearInterval(pollTimer);
    await Promise.allSettled([...activeCalls]);
    await controller.dispose();
    await server.close();
    store.close();
    process.exit(code);
  })();
}
