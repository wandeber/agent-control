import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createController } from "./core/factory.js";
import { errorToPayload } from "./core/errors.js";
import { handleTool } from "./tools/handlers.js";
import { TOOL_DEFINITIONS } from "./tools/tool-definitions.js";

const { controller, store } = createController();

const server = new Server(
  {
    name: "agent_control",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === request.params.name);
  if (!tool) {
    return jsonResult({ error: `Unknown tool: ${request.params.name}` }, true);
  }

  try {
    const input = tool.schema.parse(request.params.arguments ?? {});
    const result = await handleTool(controller, tool.name, input as Record<string, unknown>);
    await controller.drainDeliveries();
    return jsonResult(result);
  } catch (error) {
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

async function shutdown(code: number): Promise<never> {
  await controller.drainDeliveries();
  store.close();
  process.exit(code);
}
