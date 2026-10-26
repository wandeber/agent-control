import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { AgentController } from "./core/controller.js";
import type { SqliteStore } from "./storage/sqlite-store.js";
import { createMcpSession } from "./mcp-server.js";
import { AGENT_CONTROL_VERSION } from "./core/version.js";

type Session = ReturnType<typeof createMcpSession> & { transport: StreamableHTTPServerTransport; touched: number; streams: number };

/** One local controller, with small isolated protocol sessions for a few chats. */
export async function startSharedMcpService(options: { port: number; token: string; createRuntime: () => { controller: AgentController; store: SqliteStore } }) {
  let runtime: ReturnType<typeof options.createRuntime>;
  const sessions = new Map<string, Session>();
  const retiring = new Set<Promise<void>>();
  const retire = (session: Session) => {
    const task = session.close(); retiring.add(task);
    void task.catch(() => {}).finally(() => retiring.delete(task));
    return task;
  };
  let closing = false, closeTask: Promise<void> | undefined;
  const reply = (response: ServerResponse, status: number) => { response.writeHead(status); response.end(); };
  const server = createServer(async (request, response) => {
    try {
      const address = server.address() as AddressInfo;
      const expected = Buffer.from(`Bearer ${options.token}`), actual = Buffer.from(String(request.headers.authorization ?? ""));
      // Check identity and browser/DNS-rebinding boundaries before tool input.
      if (request.headers.origin || ![`localhost:${address.port}`, `127.0.0.1:${address.port}`, `[::1]:${address.port}`].includes(request.headers.host ?? "")) return reply(response, 403);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(response, 401);
      if (closing) return reply(response, 503);
      if (request.url === "/health" && request.method === "GET") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ version: AGENT_CONTROL_VERSION, pid: process.pid, sessions: sessions.size })); return;
      }
      if (request.url !== "/mcp") return reply(response, 404);
      let body: unknown;
      if (request.method === "POST") {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) return reply(response, 413);
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reply(response, 400); }
      }
      if (closing) return reply(response, 503);
      const sessionId = request.headers["mcp-session-id"];
      let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!session) {
        if (sessionId) return reply(response, 404);
        if (request.method !== "POST" || !isInitializeRequest(body)) return reply(response, 400);
        const client = createMcpSession(runtime.controller, runtime.store);
        const id = randomUUID();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
        session = Object.assign(client, { transport, touched: Date.now(), streams: 0 });
        const current = session;
        client.server.onclose = () => {
          sessions.delete(id);
          void retire(current);
        };
        sessions.set(id, current);
        await client.server.connect(transport);
      }
      const current = session;
      current.touched = Date.now();
      if (request.method === "GET") {
        current.streams++;
        response.once("close", () => { current.streams--; current.touched = Date.now(); });
      }
      const ids = (Array.isArray(body) ? body : [body]).flatMap(value =>
        value && typeof value === "object" && (typeof value.id === "string" || typeof value.id === "number") ? [value.id as RequestId] : []);
      if (ids.length) {
        const cancellation = new AbortController();
        for (const id of ids) current.requestSignals.set(id, cancellation.signal);
        response.once("close", () => {
          // SSE GET reconnects are harmless. Only this POST owns its tool wait.
          if (!response.writableFinished) cancellation.abort();
          for (const id of ids) if (current.requestSignals.get(id) === cancellation.signal) current.requestSignals.delete(id);
        });
        if (response.destroyed) cancellation.abort();
      }
      await current.transport.handleRequest(request, response, body);
      if (!current.transport.sessionId) await retire(current);
    } catch {
      if (!response.headersSent) reply(response, 500);
      else response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "localhost", () => { server.off("error", reject); resolve(); });
  });
  // Exclusively bind before migrations/recovery: duplicate launches do no DB work.
  try { runtime = options.createRuntime(); }
  catch (error) { server.close(); throw error; }
  const timer = setInterval(() => {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, session] of sessions) if (!session.activeCalls && !session.streams && session.touched < cutoff) {
      sessions.delete(id); void retire(session);
    }
  }, 60_000);
  timer.unref();
  return {
    server,
    get sessionCount() { return sessions.size; },
    get streamCount() { return [...sessions.values()].reduce((count, session) => count + session.streams, 0); },
    get activeCalls() { return [...sessions.values()].reduce((count, session) => count + session.activeCalls, 0); },
    close(): Promise<void> {
      return closeTask ??= (async () => {
        closing = true; clearInterval(timer);
        for (const session of sessions.values()) retire(session);
        await Promise.allSettled([...retiring]);
        sessions.clear();
        await runtime.controller.dispose(); runtime.store.close();
        server.closeIdleConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      })();
    }
  };
}
