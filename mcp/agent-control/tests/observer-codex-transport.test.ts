import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CodexThreadAdapter } from "../src/adapters/codex-thread-adapter.js";

describe("Codex observer transport", () => {
  let server: WebSocketServer | undefined;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); });

  async function mock(injectionFails = false) {
    const methods: string[] = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    server.on("connection", (socket) => socket.on("message", (raw) => {
      const request = JSON.parse(String(raw));
      methods.push(request.method);
      if (request.id === undefined) return;
      if (request.method === "thread/inject_items" && injectionFails) {
        socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: "Unknown method" } }));
        return;
      }
      const result = request.method === "thread/read" ? {
        thread: { id: "user-thread", status: { type: "active", activeFlags: [] }, turns: [{ id: "turn1", status: "inProgress", items: [
          { type: "reasoning", text: "not public" }, { type: "commandExecution", status: "inProgress", command: "secret arguments" }
        ] }] }
      } : {};
      socket.send(JSON.stringify({ id: request.id, result }));
    }));
    return { methods, handle: { backend: "codex-thread", id: "user-thread", data: {
      thread_id: "user-thread", agent_control_role: "observer", app_server_url: `ws://localhost:${(server.address() as AddressInfo).port}`
    } } };
  }

  it("injects history without starting, resuming or interrupting a turn", async () => {
    const { methods, handle } = await mock();
    await new CodexThreadAdapter().stageNotification(handle, { message: "Phase finished" });
    expect(methods).toEqual(["initialize", "initialized", "thread/inject_items"]);
  });

  it("fails explicitly when injection is unsupported without turn/start fallback", async () => {
    const { methods, handle } = await mock(true);
    await expect(new CodexThreadAdapter().stageNotification(handle, { message: "Phase finished" })).rejects.toThrow();
    expect(methods).toEqual(["initialize", "initialized", "thread/inject_items"]);
  });

  it("projects structured tool activity from the existing status read", async () => {
    const { methods, handle } = await mock();
    const status = await new CodexThreadAdapter().getStatus(handle);
    expect(status.data?.activity).toEqual({ kind: "tool", text: "Run a command", state: "running" });
    expect(methods.filter((method) => method === "thread/read")).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain("secret arguments");
    expect(JSON.stringify(status)).not.toContain("not public");
  });
});
