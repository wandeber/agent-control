import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { AgentController } from "../../src/core/controller.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { CodexThreadAdapter } from "../../src/adapters/codex-thread-adapter.js";

/** Isolated protocol peer: requests are real JSON-RPC; no command is executed. */
export async function approvalRuntime(options: { earlyApproval?: boolean; defaultApproval?: "never" | "on-request" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-control-approval-"));
  const dbPath = join(root, "state.sqlite");
  const store = new SqliteStore(dbPath);
  const adapters = new AdapterRegistry(); adapters.register(new CodexThreadAdapter());
  const controller = new AgentController(store, adapters);
  const server = new WebSocketServer({ host: "localhost", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  let owner: WebSocket | undefined;
  let flags: string[] = [];
  let active = false, interrupted = false;
  let approvalPolicy: unknown = "never", sandbox: Record<string, unknown> = { type: "readOnly" };
  const responses: Array<{ id: string | number; result: unknown }> = [];
  const calls: Array<{ method: string; params: any }> = [];
  const items: any[] = [
    { id: "thought", type: "agentMessage", text: "I will verify the local change and show its result here." },
    { id: "completed-command", type: "commandExecution", command: "printf 'Checks passed\\n'", cwd: root, status: "completed", aggregatedOutput: "Checks passed\n", exitCode: 0 },
    { id: "item-approval", type: "commandExecution", command: "printf 'Protocol fixture only\\n'", cwd: root, status: "inProgress" }
  ];
  const thread = () => ({ id: "fixture-thread", cwd: root, status: active ? { type: "active", activeFlags: flags } : { type: "idle" }, turns: [{ id: "fixture-turn", status: active ? "inProgress" : interrupted ? "interrupted" : "completed", items }] });
  server.on("connection", socket => socket.on("message", raw => {
    const message = JSON.parse(String(raw));
    if (!message.method) {
      responses.push(message); flags = [];
      if (message.result?.decision === "cancel") { active = false; interrupted = true; }
      socket.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "fixture-thread", requestId: message.id } }));
      if (interrupted) socket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "fixture-thread", turn: { id: "fixture-turn", status: "interrupted" } } }));
      return;
    }
    calls.push(message);
    if (message.id === undefined) return;
    let result: unknown = {};
    if (["thread/start", "thread/read", "thread/resume"].includes(message.method)) result = { thread: thread(), approvalPolicy, sandbox };
    if (message.method === "turn/start") {
      owner = socket; active = true; interrupted = false;
      approvalPolicy = message.params.approvalPolicy ?? approvalPolicy; sandbox = message.params.sandboxPolicy ?? sandbox;
      if (options.earlyApproval) socket.send(JSON.stringify({ id: message.id, method: "item/commandExecution/requestApproval", params: { threadId: "fixture-thread", turnId: "fixture-turn", itemId: "item-approval", command: "printf fixture", cwd: root } }));
      result = { turn: { id: "fixture-turn", status: "inProgress", items } };
    }
    socket.send(JSON.stringify({ id: message.id, result }));
    if (message.method === "turn/start") setTimeout(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ method: "turn/started", params: { threadId: "fixture-thread", turn: { id: "fixture-turn", status: "inProgress" } } })), options.earlyApproval ? 250 : 0);
  }));
  const run = controller.createRun({ title: "Permission protocol verification", repoDir: root });
  const agent = controller.registerAgent({ runId: run.run_id, backend: "codex-thread", title: "Implementation", model: "gpt-5.6-luna", repoDir: root });
  const launch = () => controller.startAgent({ agentId: agent.agent_id, server: `ws://localhost:${(server.address() as AddressInfo).port}`, prompt: "Verify the protocol fixture.", metadata: { ...(options.defaultApproval === "never" ? {} : { approval_policy: "on-request" }), sandbox: "workspace" } });
  const emit = (id: string | number = 0, method = "item/commandExecution/requestApproval", scope: Record<string, unknown> = { command: "printf 'Protocol fixture only\\n'", cwd: root }) => {
    if (!owner) throw Error("Fixture not launched");
    flags = ["waitingOnApproval"];
    owner.send(JSON.stringify({ id, method, params: { threadId: "fixture-thread", turnId: "fixture-turn", itemId: "item-approval", reason: "Verify the approval interface using an isolated protocol fixture.", ...scope } }));
  };
  return { root, dbPath, store, controller, server, agent, run, responses, calls, items, launch, emit,
    complete: () => { active = false; owner?.send(JSON.stringify({ method: "turn/completed", params: { threadId: "fixture-thread", turn: { id: "fixture-turn", status: "completed" } } })); },
    disconnect: () => owner?.terminate(),
    close: async () => { for (const socket of server.clients) socket.terminate(); await controller.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
