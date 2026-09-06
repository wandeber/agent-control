import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CodexThreadAdapter } from "../src/adapters/codex-thread-adapter.js";
import type { AgentHandle, StartAgentInput } from "../src/core/types.js";

describe("CodexThreadAdapter", () => {
  let server: WebSocketServer;
  let appServerUrl: string;
  let requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let authHeaders: Array<string | undefined> = [];
  let tmp: string;
  let oldAuthTokenFile: string | undefined;
  let oldStdioCommand: string | undefined;
  let oldCompatibilityCommand: string | undefined;
  let oldRequestLog: string | undefined;

  function wireMockServer(
    target: WebSocketServer,
    targetRequests = requests,
    options: {
      resumeCwd?: string | null;
      deliveryTurnStatus?: "completed" | "interrupted" | "failed" | "inProgress";
      resumeError?: string;
      startError?: string;
      injectionError?: string;
    } = {}
  ): void {
    const resumeCwd = options.resumeCwd === undefined ? "/repo" : options.resumeCwd;
    const deliveryTurnStatus = options.deliveryTurnStatus ?? "completed";
    let startErrorUsed = false;
    target.on("connection", (socket, request) => {
      authHeaders.push(request.headers.authorization);
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        targetRequests.push({ method: message.method, params: message.params });
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
          return;
        }
        if (message.method === "initialized") {
          return;
        }
        if (message.method === "thread/start") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1", cwd: "/repo", status: { type: "idle" } } } }));
          return;
        }
        if (message.method === "thread/resume") {
          if (options.resumeError) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32603, message: options.resumeError }
              })
            );
            return;
          }
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                thread: {
                  id: "thread-1",
                  ...(resumeCwd === null ? {} : { cwd: resumeCwd }),
                  path: "/tmp/thread.jsonl",
                  status: { type: "idle" },
                  turns: []
                }
              }
            })
          );
          return;
        }
        if (message.method === "thread/inject_items") {
          if (options.injectionError) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32603, message: options.injectionError }
              })
            );
            return;
          }
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
          return;
        }
        if (message.method === "turn/start") {
          if (options.startError && !startErrorUsed) {
            startErrorUsed = true;
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32603, message: options.startError }
              })
            );
            return;
          }
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { turn: { id: "turn-1" } }
            })
          );
          setTimeout(() => {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "turn/started",
                params: {
                  threadId: "thread-1",
                  turn: { id: "turn-1" }
                }
              })
            );
          }, 0);
          return;
        }
        if (message.method === "thread/read") {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                thread: {
                  id: "thread-1",
                  cwd: resumeCwd ?? "/repo",
                  path: "/tmp/thread.jsonl",
                  status: { type: "idle" },
                  turns: [{ id: "turn-1", status: deliveryTurnStatus, items: [] }]
                }
              }
            })
          );
          return;
        }
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Unknown method ${message.method}` }
          })
        );
      });
    });
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "agent-control-codex-test-"));
    oldAuthTokenFile = process.env.CODEX_APP_SERVER_AUTH_TOKEN_FILE;
    oldStdioCommand = process.env.CODEX_APP_SERVER_STDIO_COMMAND;
    oldCompatibilityCommand = process.env.CODEX_APP_SERVER_COMPAT_COMMAND;
    oldRequestLog = process.env.REQUEST_LOG;
    requests = [];
    authHeaders = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    appServerUrl = `ws://localhost:${address.port}`;
    wireMockServer(server);
  });

  afterEach(async () => {
    if (oldAuthTokenFile === undefined) {
      delete process.env.CODEX_APP_SERVER_AUTH_TOKEN_FILE;
    } else {
      process.env.CODEX_APP_SERVER_AUTH_TOKEN_FILE = oldAuthTokenFile;
    }
    if (oldStdioCommand === undefined) {
      delete process.env.CODEX_APP_SERVER_STDIO_COMMAND;
    } else {
      process.env.CODEX_APP_SERVER_STDIO_COMMAND = oldStdioCommand;
    }
    if (oldCompatibilityCommand === undefined) {
      delete process.env.CODEX_APP_SERVER_COMPAT_COMMAND;
    } else {
      process.env.CODEX_APP_SERVER_COMPAT_COMMAND = oldCompatibilityCommand;
    }
    if (oldRequestLog === undefined) {
      delete process.env.REQUEST_LOG;
    } else {
      process.env.REQUEST_LOG = oldRequestLog;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reconnects an existing thread after endpoint recovery without dispatching another turn", async () => {
    const adapter = new CodexThreadAdapter();
    const handle: AgentHandle = { backend: "codex-thread", id: "thread-1",
      data: { thread_id: "thread-1", app_server_url: appServerUrl } };
    expect((await adapter.getStatus(handle)).status).toBe("completed");
    const port = (server.address() as AddressInfo).port;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(adapter.getStatus(handle)).rejects.toMatchObject({reason: "backend_unavailable"});
    server = new WebSocketServer({ port });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    wireMockServer(server);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    try {
      expect((await adapter.getStatus(handle)).status).toBe("completed");
      expect(requests.filter((request) => request.method === "thread/read")).toHaveLength(2);
      expect(requests.some((request) => ["thread/start", "turn/start", "thread/resume"].includes(request.method))).toBe(false);
    } finally { clock.mockRestore(); }
  });

  it("resumes an unloaded thread before starting a new turn", async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    requests = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    appServerUrl = `ws://localhost:${address.port}`;
    wireMockServer(server, requests, { startError: "thread not found: thread-1" });

    const adapter = new CodexThreadAdapter();
    const handle: AgentHandle = {
      backend: "codex-thread",
      id: "thread-1",
      data: {
        thread_id: "thread-1",
        app_server_url: appServerUrl
      }
    };

    await adapter.sendMessage(handle, { message: "Worker completed; continue orchestration." });

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "turn/start",
      "thread/resume",
      "turn/start"
    ]);
    expect(requests[3]?.params).toMatchObject({ threadId: "thread-1" });
    expect(requests[4]?.params).toMatchObject({
      threadId: "thread-1",
      cwd: "/repo",
      input: [{ type: "text", text: "Worker completed; continue orchestration.", text_elements: [] }]
    });
  });

  it("sends max effort to Codex and retains it when the worker is reused", async () => {
    const adapter = new CodexThreadAdapter();
    const handle = await adapter.start({
      agent: { repo_dir: "/repo", model: "gpt-5.6-luna", backend_handle: null } as StartAgentInput["agent"],
      server: appServerUrl, model: "gpt-5.6-luna", prompt: "Run analysis.", metadata: { reasoning_effort: "max" }
    });
    expect(handle.data.reasoning_effort).toBe("max");
    expect(requests.find((request) => request.method === "thread/start")?.params.model).toBe("gpt-5.6-luna");
    expect(requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ model: "gpt-5.6-luna", effort: "max" });
    requests.length = 0;
    await adapter.sendMessage(handle, { message: "Continue analysis." });
    expect(requests.find((request) => request.method === "turn/start")?.params.effort).toBe("max");
  });

  it("omits effort when an existing Codex selection does not override it", async () => {
    const adapter = new CodexThreadAdapter();
    await adapter.sendMessage({ backend: "codex-thread", id: "thread-1", data: { thread_id: "thread-1", app_server_url: appServerUrl } }, { message: "Continue." });
    expect(requests.find((request) => request.method === "turn/start")?.params).not.toHaveProperty("effort");
  });

  it("enforces a per-step sandbox on fresh and resumed turns", async () => {
    const adapter = new CodexThreadAdapter();
    const handle = await adapter.start({
      agent: { repo_dir: "/repo", model: "gpt-5.6-luna", backend_handle: null } as StartAgentInput["agent"],
      prompt: "Review without edits", server: appServerUrl, metadata: { sandbox: "read_only" }
    });
    expect(handle.data.cwd).toBe("/repo");
    expect(requests.find(request => request.method === "turn/start")?.params).toMatchObject({ sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" });
    requests.length = 0;
    await adapter.start({ agent: { repo_dir: "/repo", backend_handle: handle.data } as StartAgentInput["agent"],
      prompt: "Write the requested artifacts", server: appServerUrl, metadata: { sandbox: "workspace", flow_writable_root: "/runtime/run-1" } });
    expect(requests.find(request => request.method === "turn/start")?.params).toMatchObject({ sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/repo", "/runtime/run-1"], networkAccess: true }, approvalPolicy: "never" });
  });

  it("stages orchestrator notifications in the active Codex thread", async () => {
    const adapter = new CodexThreadAdapter();
    const handle: AgentHandle = {
      backend: "codex-thread",
      id: "thread-1",
      data: {
        thread_id: "thread-1",
        app_server_url: appServerUrl,
        agent_control_role: "orchestrator"
      }
    };

    await adapter.sendMessage(handle, { message: "Worker completed; continue orchestration." });

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/inject_items"
    ]);
    expect(requests[2]?.params).toMatchObject({
      threadId: "thread-1",
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Worker completed; continue orchestration." }]
        }
      ]
    });
  });

  it("falls back to a turn when staging is unavailable", async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    requests = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    appServerUrl = `ws://localhost:${address.port}`;
    wireMockServer(server, requests, { injectionError: "Unknown method thread/inject_items" });

    const adapter = new CodexThreadAdapter();
    const handle: AgentHandle = {
      backend: "codex-thread",
      id: "thread-1",
      data: {
        thread_id: "thread-1",
        app_server_url: appServerUrl,
        agent_control_role: "orchestrator"
      }
    };

    await adapter.sendMessage(handle, { message: "Worker completed; continue orchestration." });

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/inject_items",
      "initialize",
      "initialized",
      "turn/start"
    ]);
  });

  it("falls back to the registered handle cwd when resume omits cwd", async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    requests = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    appServerUrl = `ws://localhost:${address.port}`;
    wireMockServer(server, requests, { resumeCwd: null, startError: "thread not found: thread-1" });

    const adapter = new CodexThreadAdapter();
    const handle: AgentHandle = {
      backend: "codex-thread",
      id: "thread-1",
      data: {
        thread_id: "thread-1",
        app_server_url: appServerUrl,
        cwd: "/registered/repo"
      }
    };

    await adapter.sendMessage(handle, { message: "Worker completed; continue orchestration." });

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "turn/start",
      "thread/resume",
      "turn/start"
    ]);
    expect(requests[4]?.params).toMatchObject({
      threadId: "thread-1",
      cwd: "/registered/repo"
    });
  });

  it("treats turn/start acceptance as durable delivery", async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    requests = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    appServerUrl = `ws://localhost:${address.port}`;
    wireMockServer(server, requests, {
      deliveryTurnStatus: "interrupted",
      startError: "thread not found: thread-1"
    });

    const adapter = new CodexThreadAdapter();
    const handle: AgentHandle = {
      backend: "codex-thread",
      id: "thread-1",
      data: {
        thread_id: "thread-1",
        app_server_url: appServerUrl
      }
    };

    await adapter.sendMessage(handle, { message: "Worker completed; continue orchestration." });
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "turn/start",
      "thread/resume",
      "turn/start"
    ]);
  });

  it("falls back to a compatible Desktop app-server when rollout parsing fails", async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    requests = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    appServerUrl = `ws://localhost:${address.port}`;
    wireMockServer(server, requests, {
      startError: "failed to read thread: rollout does not start with session metadata"
    });

    const fallbackServer = join(tmp, "fallback-codex-app-server.mjs");
    const fallbackRequestLog = join(tmp, "fallback-requests.jsonl");
    writeFileSync(
      fallbackServer,
      `
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(process.env.REQUEST_LOG, JSON.stringify({ method: message.method }) + "\\n");
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  } else if (message.method === "initialized") {
    return;
  } else if (message.method === "thread/resume") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { thread: { id: "thread-1", cwd: "/repo", status: { type: "idle" }, turns: [] } }
    }) + "\\n");
  } else if (message.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }) + "\\n");
  }
});
`,
      "utf8"
    );
    process.env.CODEX_APP_SERVER_COMPAT_COMMAND = `${process.execPath} ${fallbackServer}`;
    process.env.REQUEST_LOG = fallbackRequestLog;

    const adapter = new CodexThreadAdapter();
    const handle: AgentHandle = {
      backend: "codex-thread",
      id: "thread-1",
      data: {
        thread_id: "thread-1",
        app_server_url: appServerUrl
      }
    };

    await adapter.sendMessage(handle, { message: "Worker completed; continue orchestration." });

    expect(requests.map((request) => request.method)).toEqual(["initialize", "initialized", "turn/start"]);
    const fallbackMethods = readFileSync(fallbackRequestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string })
      .map((request) => request.method);
    expect(fallbackMethods).toEqual(["initialize", "initialized", "turn/start"]);
  });

  it("reads websocket auth tokens from a token file", async () => {
    const tokenFile = join(tmp, "codex-token");
    writeFileSync(tokenFile, "test-token\n", "utf8");
    process.env.CODEX_APP_SERVER_AUTH_TOKEN_FILE = tokenFile;

    const adapter = new CodexThreadAdapter();
    const handle: AgentHandle = {
      backend: "codex-thread",
      id: "thread-1",
      data: {
        thread_id: "thread-1",
        app_server_url: appServerUrl
      }
    };

    await adapter.sendMessage(handle, { message: "Worker completed; continue orchestration." });

    expect(authHeaders[0]).toBe("Bearer test-token");
    expect(requests.map((request) => request.method)).toEqual(["initialize", "initialized", "turn/start"]);
  });

  it("uses documented Unix socket transport by default", async () => {
    const socketPath = join(tmp, "codex-app-server.sock");
    const unixRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const httpServer: Server = createServer();
    const compressionOffers: Array<string | undefined> = [];
    httpServer.on("upgrade", request => compressionOffers.push(request.headers["sec-websocket-extensions"]));
    const unixServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    wireMockServer(unixServer, unixRequests);
    await new Promise<void>((resolve) => httpServer.listen(socketPath, resolve));

    try {
      const adapter = new CodexThreadAdapter();
      const handle: AgentHandle = {
        backend: "codex-thread",
        id: "thread-1",
        data: {
          thread_id: "thread-1",
          app_server_url: `unix://${socketPath}`
        }
      };

      await adapter.sendMessage(handle, { message: "Worker completed; continue orchestration." });
      expect(compressionOffers).toEqual([undefined]);

      expect(unixRequests.map((request) => request.method)).toEqual(["initialize", "initialized", "turn/start"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        unixServer.close((socketError) => {
          httpServer.close((serverError) => {
            const error = socketError ?? serverError;
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      });
    }
  });

  it("reads an archived local thread with tools without resuming or replaying work", async () => {
    const fakeServer = join(tmp, "history.mjs");
    const requestLog = join(tmp, "history-requests.jsonl");
    writeFileSync(fakeServer, `
import { appendFileSync } from "node:fs";
import readline from "node:readline";
readline.createInterface({input: process.stdin}).on("line", line => {
  const msg = JSON.parse(line);
  appendFileSync(process.env.REQUEST_LOG, JSON.stringify(msg) + "\\n");
  if (!msg.id) return;
  const result = msg.method === "thread/read" ? {thread: {id: "thread-1", status: {type: "notLoaded"}, turns: [{id: "t1", status: "completed", items: [
    {id: "m1", type: "agentMessage", text: "Done"},
    {id: "p1", type: "mcpToolCall", tool: "update_plan", arguments: {plan: [{step: "Verify", status: "completed"}]}},
    {id: "c1", type: "commandExecution", command: "pwd", aggregatedOutput: "/repo"}
  ]}]}} : {};
  process.stdout.write(JSON.stringify({id: msg.id, result}) + "\\n");
});`);
    process.env.CODEX_APP_SERVER_COMPAT_COMMAND = `${process.execPath} ${fakeServer}`;
    process.env.REQUEST_LOG = requestLog;
    // Port zero cannot host the retired worker and avoids closing the shared fixture.
    const handle: AgentHandle = {backend: "codex-thread", id: "thread-1", data: {thread_id: "thread-1", app_server_url: "ws://localhost:0"}};
    const original = JSON.stringify(handle);
    const messages = await new CodexThreadAdapter().readLatest(handle, {limit: 10});
    expect(messages.map(message => message.id)).toEqual(["m1", "p1", "c1"]);
    expect(messages[1].metadata?.type).toBe("tool");
    expect(messages[1].text).toContain('"step":"Verify"');
    expect(messages[2].text).toContain("/repo");
    expect(JSON.stringify(handle)).toBe(original);
    const calls = readFileSync(requestLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls.map(call => call.method)).toEqual(["initialize", "initialized", "thread/read"]);
    expect(calls[2].params.threadId).toBe("thread-1");
  });

  it("uses documented stdio JSONL transport when configured", async () => {
    const fakeServer = join(tmp, "fake-codex-app-server.mjs");
    const requestLog = join(tmp, "stdio-requests.jsonl");
    writeFileSync(
      fakeServer,
      `
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(process.env.REQUEST_LOG, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  } else if (message.method === "initialized") {
    return;
  } else if (message.method === "thread/resume") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        thread: {
          id: "thread-1",
          cwd: "/repo",
          path: "/tmp/thread.jsonl",
          status: { type: "idle" },
          turns: []
        }
      }
    }) + "\\n");
  } else if (message.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }) + "\\n");
  } else if (message.method === "thread/read") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        thread: {
          id: "thread-1",
          cwd: "/repo",
          path: "/tmp/thread.jsonl",
          status: { type: "idle" },
          turns: [{ id: "turn-1", status: "completed", items: [] }]
        }
      }
    }) + "\\n");
  }
});
`,
      "utf8"
    );
    process.env.CODEX_APP_SERVER_STDIO_COMMAND = `${process.execPath} ${fakeServer}`;
    process.env.REQUEST_LOG = requestLog;

    const adapter = new CodexThreadAdapter();
    const handle: AgentHandle = {
      backend: "codex-thread",
      id: "thread-1",
      data: {
        thread_id: "thread-1",
        app_server_url: "stdio://"
      }
    };

    await adapter.sendMessage(handle, { message: "Worker completed; continue orchestration." });

    const methods = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string });
    expect(methods.map((request) => request.method)).toEqual(["initialize", "initialized", "turn/start"]);
  });
});
