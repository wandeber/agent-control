import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentController } from "../src/core/controller.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { createDefaultAdapterRegistry } from "../src/adapters/registry.js";
import { startSharedMcpService } from "../src/mcp-service.js";

let directory: string, runtime: Awaited<ReturnType<typeof startSharedMcpService>>, controller: AgentController;
const clients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
const token = "a".repeat(64), headers = { Authorization: `Bearer ${token}` };
let url: URL;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ac-shared-http-"));
  vi.stubEnv("AGENT_CONTROL_HOME", directory); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "fixture-admin");
  vi.stubEnv("CODEX_THREAD_ID", "");
  runtime = await startSharedMcpService({ port: 0, token, createRuntime: () => {
    const store = new SqliteStore(join(directory, "state.sqlite"));
    controller = new AgentController(store, createDefaultAdapterRegistry()); return { controller, store };
  } });
  url = new URL(`http://localhost:${(runtime.server.address() as { port: number }).port}/mcp`);
});
afterEach(async () => {
  for (const { client, transport } of clients.splice(0)) { await transport.terminateSession().catch(() => {}); await client.close(); }
  await runtime.close(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
async function connect() {
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  const client = new Client({ name: "shared-http-fixture", version: "1" });
  clients.push({ client, transport }); await client.connect(transport); return { client, transport };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Condition not reached"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
it("serves three chats with overlapping request IDs and isolated console ownership", async () => {
  const group = await Promise.all([connect(), connect(), connect()]);
  expect(runtime.sessionCount).toBe(3);
  const results = await Promise.all(group.map(({ client }) => client.callTool({ name: "backend_list", arguments: {} })));
  expect(results.every(result => !result.isError)).toBe(true);
  const opened = await group[0].client.callTool({ name: "open_agent_control_console", arguments: { screen: "flows" }, _meta: { threadId: "chat-a" } });
  const panel = (opened.structuredContent as any).console.panel_id;
  for (const meta of [{ threadId: "chat-b" }, undefined]) {
    const stolen = await group[1].client.callTool({ name: "agent_control_console_flows", arguments: { panel_id: panel }, ...(meta ? { _meta: meta } : {}) });
    expect(stolen.isError).toBe(true);
  }
  for (const { transport } of group) await transport.terminateSession();
  expect(runtime.sessionCount).toBe(0);
  const next = await connect(); expect((await next.client.listTools()).tools.length).toBeGreaterThan(80);
  expect(runtime.sessionCount).toBe(1);
});
it.each(["POST disconnect", "session close"])("handles %s without disposing another chat or the shared controller", async ending => {
  const first = await connect(), second = await connect();
  const run = controller.createRun({ title: "Long wait", adminKey: "fixture-admin" });
  controller.registerAgent({ runId: run.run_id, title: "Worker", backend: "manual", status: "running", backendHandle: { status: "running" } });
  const observer = controller.observeRun({ runId: run.run_id, threadId: "chat-a", adminKey: "fixture-admin" });
  const post = (session: string, signal: AbortSignal) => fetch(url, { method: "POST", signal,
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "run_wait", arguments: observer.wait_contract.arguments } })
  }).then(response => response.text());
  const a = new AbortController(), b = new AbortController();
  const pendingA = post(first.transport.sessionId!, a.signal).catch(error => error.name);
  const pendingB = post(second.transport.sessionId!, b.signal).catch(error => error.name);
  await until(() => runtime.activeCalls === 2);
  if (ending === "POST disconnect") { a.abort(); expect(await pendingA).toBe("AbortError"); }
  else { await first.transport.terminateSession(); await pendingA; }
  await until(() => runtime.activeCalls === 1);
  expect((await second.client.callTool({ name: "backend_list", arguments: {} })).isError).not.toBe(true);
  expect(controller.getRun(run.run_id).title).toBe("Long wait");
  b.abort(); await pendingB; await until(() => runtime.activeCalls === 0);
});
it("rejects invalid credentials and browser/rebinding requests before creating a session", async () => {
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await fetch(url, { headers: { ...headers, Origin: "https://other.example" } })).status).toBe(403);
  const rebinding = await new Promise<number | undefined>((resolve, reject) => {
    // Undici normalizes Host; send the actual hostile header through Node HTTP.
    const outgoing = request(url, { headers: { ...headers, Host: "other.example" } }, response => { response.resume(); resolve(response.statusCode); });
    outgoing.on("error", reject); outgoing.end();
  });
  expect(rebinding).toBe(403);
  expect(runtime.sessionCount).toBe(0);
});
it("fails a duplicate start before initializing a second controller", async () => {
  const createRuntime = vi.fn();
  await expect(startSharedMcpService({ port: Number(url.port), token, createRuntime })).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(createRuntime).not.toHaveBeenCalled();
});
it("drains a retiring session before closing the shared store", async () => {
  const { client, transport } = await connect();
  let release!: (messages: []) => void;
  vi.spyOn(controller, "readLatest").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const dispose = vi.spyOn(controller, "dispose");
  const pending = client.callTool({ name: "agent_read_latest", arguments: { agent_id: "fixture" } }).catch(() => undefined);
  await until(() => runtime.activeCalls === 1);
  await transport.terminateSession(); expect(runtime.sessionCount).toBe(0);
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(closed).toBe(false); expect(dispose).not.toHaveBeenCalled();
  release([]); await closing; await client.close(); await pending;
  expect(dispose).toHaveBeenCalledTimes(1);
});
