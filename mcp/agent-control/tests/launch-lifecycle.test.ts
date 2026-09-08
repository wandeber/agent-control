import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startControlServer } from "../src/control-server.js";
import { EVENT_TYPES } from "../src/core/types.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "agent-control-launch-lifecycle-"));
  directories.push(path);
  return path;
}

describe("launch and shutdown boundaries", () => {
  it("closes the HTTP controller idempotently with an active WebSocket", async () => {
    vi.stubEnv("AGENT_CONTROL_HOME", directory());
    const runtime = await startControlServer({ host: "localhost", port: 0 });
    const address = runtime.server.address() as { port: number };
    const client = new WebSocket(`ws://localhost:${address.port}/ws/control`);
    await once(client, "open");
    const closed = once(client, "close");
    await Promise.all([runtime.close(), runtime.close()]);
    await closed;
    expect(runtime.server.listening).toBe(false);
  });

  it("launches a flow through real MCP in one call and cancels an indefinite wait before closing storage", async () => {
    const path = directory();
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    Object.assign(env, { AGENT_CONTROL_HOME: path, AGENT_CONTROL_DB: join(path, "state.sqlite"),
      AGENT_CONTROL_TOKEN: "", AGENT_CONTROL_REQUESTER_THREAD_ID: "", AGENT_CONTROL_ADMIN_KEY: "lifecycle-test-admin",
      CODEX_THREAD_ID: "conversation-lifecycle" });
    delete env.AGENT_CONTROL_REQUESTER_THREAD_ID;
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"], cwd: resolve("."), env, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr += String(chunk); });
    const client = new Client({ name: "lifecycle-test", version: "1" });
    try {
      await client.connect(transport);
      const launch = await client.callTool({ name: "flow_launch", _meta: { threadId: "conversation-lifecycle" }, arguments: {
        title: "One-call observation", repo_dir: path, requester_thread_id: "original-user",
        config: { id: "observed-native-flow", initial_step: "work", roles: { worker: { backend: "codex-subagent" } },
          steps: { work: { role: "worker", prompt: "Inspect only", on: { reported: { finish: true } } } } }
      } });
      expect(launch.isError).toBe(false);
      const result = JSON.parse((launch.content as Array<{ text: string }>)[0]!.text);
      expect(result.observer).toMatchObject({ thread_id: "original-user", event_types: [...EVENT_TYPES], delivery: "wait" });
      expect(result.continuation.action).toBe("orchestrator_action_required");
      expect(result.coordinator_observer.thread_id).toBe("conversation-lifecycle");
      const waitArgs = { ...result.coordinator_observer.wait_contract.arguments, wake_on: "all", timeout_ms: 20 };
      const first = await client.callTool({ name: "run_wait", arguments: waitArgs });
      const batch = JSON.parse((first.content as Array<{ text: string }>)[0]!.text);
      expect(batch.events.map((event: { type: string }) => event.type)).toContain("flow.step_started");
      // Initial native work is returned by launch; later native actions arrive as owner events.
      expect(result.continuation.orchestrator_action).toMatchObject({
        operation: "spawn_agent", orchestrator_agent_id: result.coordinator_observer.observer_agent_id
      });
      const userWait = await client.callTool({ name: "run_wait", arguments: { ...result.observer.wait_contract.arguments, timeout_ms: 20 } });
      const userBatch = JSON.parse((userWait.content as Array<{ text: string }>)[0]!.text);
      expect(userBatch.events.every((event: any) => event.orchestrator_action === undefined)).toBe(true);
      const pending = client.callTool({ name: "run_wait", arguments: { wake_on: "all", ...waitArgs, cursor: batch.cursor, timeout_ms: 3_600_000 } });
      // A later request proves the indefinite wait has entered the server before SIGTERM.
      await client.callTool({ name: "run_list", arguments: {} });
      process.kill(transport.pid!, "SIGTERM");
      expect((await pending).isError).toBe(true);
      expect(stderr).not.toMatch(/database connection is not open|unhandled/i);
    } finally { await client.close(); }
  }, 15_000);
});
