import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createController } from "./core/factory.js";
import { createMcpSession } from "./mcp-server.js";
import { startSharedMcpService } from "./mcp-service.js";
import { readServiceConfig } from "./service-config.js";

const shared = process.argv.includes("--http");
// A service must never inherit the conversation that installed it.
if (shared) for (const name of ["CODEX_THREAD_ID", "AGENT_CONTROL_TOKEN", "AGENT_CONTROL_REQUESTER_THREAD_ID"]) delete process.env[name];
let closeTransport: () => Promise<void>;
let shutdownTask: Promise<void> | undefined;
if (shared) {
  const config = readServiceConfig();
  const service = await startSharedMcpService({ createRuntime: createController, port: config.port, token: config.token });
  closeTransport = service.close;
} else {
  // Explicit CLI/debug compatibility; the installed plugin uses shared HTTP.
  const { controller, store } = createController();
  const session = createMcpSession(controller, store);
  closeTransport = async () => { await session.close(); await controller.dispose(); store.close(); };
  session.server.onclose = () => { void shutdown(); };
  process.stdin.once("end", () => { void shutdown(); });
  process.stdin.once("close", () => { void shutdown(); });
  await session.server.connect(new StdioServerTransport());
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
function shutdown(): Promise<void> {
  return shutdownTask ??= (async () => {
    const deadline = setTimeout(() => process.exit(1), 5_000); deadline.unref();
    await closeTransport(); process.exit(0);
  })();
}
