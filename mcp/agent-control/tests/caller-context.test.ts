import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { currentCodexThreadId, withMcpCaller } from "../src/core/caller-context.js";
import { AgentController } from "../src/core/controller.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import type { AgentAdapter, AgentHandle, StartAgentInput } from "../src/core/types.js";

class Fixture implements AgentAdapter {
  readonly kind = "codex-thread";
  capabilities() { return { canStart: true, canSendMessage: true, canReadLatest: true, canStopGracefully: true, canForceStop: false, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: true }; }
  async start(input: StartAgentInput): Promise<AgentHandle> { return { backend: this.kind, id: input.agent.agent_id, data: { thread_id: `thread-${input.agent.agent_id}` } }; }
  async getStatus() { return { status: "running" as const }; }
  async readLatest() { return []; } async sendMessage() {} async stop() { return { status: "stopped" as const }; } async unregister() {}
}

afterEach(() => vi.unstubAllEnvs());

describe("request-scoped Codex MCP identity", () => {
  it("isolates concurrent calls without changing the legacy CLI environment", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "daemon-thread");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withMcpCaller({ threadId: "worker-a" }, async () => {
      await gate;
      expect(currentCodexThreadId()).toBe("worker-a");
      expect(process.env.CODEX_THREAD_ID).toBe("daemon-thread");
    });
    await withMcpCaller({ threadId: "worker-b" }, async () => {
      await Promise.resolve();
      expect(currentCodexThreadId()).toBe("worker-b");
      release();
      await first;
      expect(currentCodexThreadId()).toBe("worker-b");
    });
    expect(currentCodexThreadId()).toBe("daemon-thread");
  });

  it("never borrows the MCP process identity when request metadata is absent or malformed", () => {
    vi.stubEnv("CODEX_THREAD_ID", "assigned-worker");
    expect(withMcpCaller(undefined, currentCodexThreadId)).toBeUndefined();
    expect(withMcpCaller({ itemId: "call-only" }, currentCodexThreadId)).toBeUndefined();
    for (const value of [null, 1, "", "wrong\nthread", "x".repeat(257)]) {
      expect(() => withMcpCaller({ threadId: value }, currentCodexThreadId)).toThrow(/invalid thread identity/);
    }
  });

  it("authenticates real stdio evidence, reports and observer ACKs using host metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-caller-"));
    const db = join(root, "state.sqlite");
    vi.stubEnv("AGENT_CONTROL_HOME", root); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "fixture-admin");
    vi.stubEnv("CODEX_THREAD_ID", ""); vi.stubEnv("AGENT_CONTROL_REQUESTER_THREAD_ID", "");
    const store = new SqliteStore(db), registry = new AdapterRegistry(); registry.register(new Fixture());
    const controller = new AgentController(store, registry);
    const owner = controller.orchestratorLogin({ adminKey: "fixture-admin", title: "Coordinator", runTitle: "Caller fixture", repoDir: root, backend: "codex-thread", backendHandle: { thread_id: "original-user" } });
    const started = controller.startFlow({ runId: owner.run.run_id, agentToken: owner.agent_token, requesterThreadId: "original-user", config: {
      id: "mcp-identity", policy: { strict: true }, initial_step: "verify", roles: { verifier: { backend: "codex-thread" } },
      steps: { verify: { role: "verifier", sandbox: "read_only", evidence_operations: ["snapshot_artifact"], on: { completed: { finish: true } } } }
    } });
    const dispatched = await controller.dispatchActiveFlowStep({ flowInstanceId: started.instance.flow_instance_id, agentToken: owner.agent_token });
    const threadId = controller.getAgent(dispatched.agent!.agent_id).backend_handle!.thread_id as string;
    const inputPath = join(root, "input.md"); writeFileSync(inputPath, "Evidence input\n");
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    Object.assign(env, { AGENT_CONTROL_DB: db, CODEX_THREAD_ID: threadId, AGENT_CONTROL_POLL_INTERVAL_MS: "0" });
    delete env.AGENT_CONTROL_REQUESTER_THREAD_ID; delete env.AGENT_CONTROL_TOKEN;
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: resolve("."), env, stderr: "pipe" });
    const client = new Client({ name: "caller-metadata-fixture", version: "1" });
    const parsed = (result: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    try {
      await client.connect(transport);
      const args = { flow_instance_id: started.instance.flow_instance_id, step_instance_id: started.active_step!.step_instance_id, key: "input", request: { operation: "snapshot_artifact", path: inputPath } };
      // Even an environment matching the assigned worker cannot authenticate
      // an unidentified MCP request or override a different caller's metadata.
      for (const meta of [undefined, { threadId: "other-worker" }]) {
        const rejected = await client.callTool({ name: "flow_evidence", arguments: { ...args, threadId }, ...(meta ? { _meta: meta } : {}) });
        expect(rejected.isError).toBe(true); expect(parsed(rejected).reason).toBe("auth_required");
      }
      const [valid, invalidToken] = await Promise.all([
        client.callTool({ name: "flow_evidence", arguments: args, _meta: { threadId } }),
        client.callTool({ name: "flow_evidence", arguments: { ...args, agent_token: "invalid-token" }, _meta: { threadId } })
      ]);
      expect(valid.isError).toBe(false); expect(parsed(valid).actor_id).toBe(dispatched.agent!.agent_id);
      expect(invalidToken.isError).toBe(true);
      const explicitToken = controller.issueAgentToken(dispatched.agent!.agent_id);
      const legacy = await client.callTool({ name: "flow_evidence", arguments: { ...args, key: "explicit_identity", agent_token: explicitToken } });
      expect(legacy.isError).toBe(false); expect(parsed(legacy).actor_id).toBe(dispatched.agent!.agent_id);
      const observer = started.observer!;
      const observed = parsed(await client.callTool({ name: "run_wait", arguments: { run_id: owner.run.run_id, observer_agent_id: observer.observer_agent_id, timeout_ms: 10 }, _meta: { threadId: "original-user" } }));
      const ackArgs = { run_id: owner.run.run_id, observer_agent_id: observer.observer_agent_id, cursor: observed.cursor };
      expect((await client.callTool({ name: "run_ack", arguments: ackArgs, _meta: { threadId } })).isError).toBe(true);
      expect((await client.callTool({ name: "run_ack", arguments: ackArgs, _meta: { threadId: "original-user" } })).isError).toBe(false);
      const reportArgs = { step_instance_id: started.active_step!.step_instance_id, status: "completed", auto_continue: false };
      expect((await client.callTool({ name: "flow_step_report", arguments: reportArgs, _meta: { threadId: "original-user" } })).isError).toBe(true);
      expect((await client.callTool({ name: "flow_step_report", arguments: reportArgs, _meta: { threadId } })).isError).toBe(false);
      expect(controller.getFlowSnapshot(started.instance.flow_instance_id).instance.status).toBe("completed");
      expect(controller.ensureRequester(owner.run.run_id)!.observer_agent_id).toBe(observer.observer_agent_id);
    } finally { await client.close(); await controller.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
});
