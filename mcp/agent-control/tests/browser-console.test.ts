import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserOpenCommand } from "../src/browser-console.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

afterEach(() => vi.unstubAllEnvs());

describe("external global console", () => {
  it("uses the system browser on macOS, Windows, WSL and Linux", () => {
    const url = "http://localhost:4000/?apiPort=4001&run_id=selected#/console";
    expect(browserOpenCommand(url, "darwin", false)).toEqual(["open", [url]]);
    expect(browserOpenCommand(url, "win32", false)).toEqual(["rundll32.exe", ["url.dll,FileProtocolHandler", url]]);
    expect(browserOpenCommand(url, "linux", true)[0]).toBe("powershell.exe");
    expect(browserOpenCommand(url, "linux", false)).toEqual(["xdg-open", [url]]);
    expect(() => browserOpenCommand("https://example.com")).toThrow(/local/);
  });

  it.skipIf(process.platform === "win32")("serves all conversations and stays available after the MCP client disconnects", async () => {
    const root = mkdtempSync(join(tmpdir(), "browser-console-"));
    const db = join(root, "state.sqlite");
    const store = new SqliteStore(db);
    const a = store.createRun({ title: "Conversation A" });
    const b = store.createRun({ title: "Conversation B" });
    store.db.prepare("insert into run_requesters(run_id, thread_id) values (?, ?)").run(a.run_id, "thread-a");
    store.close();
    // Exercise the real MCP action without opening a user's browser during tests.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const bin = join(root, "bin"); mkdirSync(bin);
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    writeFileSync(join(bin, opener), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_CONTROL_HOME: root, AGENT_CONTROL_DB: db, AGENT_CONTROL_POLL_INTERVAL_MS: "0" };
    delete env.WSL_INTEROP; delete env.WSL_DISTRO_NAME;
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: resolve("."), env, stderr: "pipe" });
    const client = new Client({ name: "browser-console-test", version: "1" });
    let url: URL | undefined;
    try {
      await client.connect(transport);
      const opened = await client.callTool({ name: "open_agent_control_console", arguments: {}, _meta: { threadId: "thread-a" } });
      const panelId = (opened.structuredContent as any).console.panel_id;
      const result = await client.callTool({ name: "agent_control_console_open_browser", arguments: { panel_id: panelId, run_id: a.run_id, screen: "console" } });
      expect(result.isError).not.toBe(true);
      url = new URL((result.structuredContent as any).url);
      expect(url.searchParams.get("run_id")).toBe(a.run_id);
      expect(url.hash).toBe("#/console");
      const again = await client.callTool({ name: "agent_control_console_open_browser", arguments: { panel_id: panelId, screen: "subagents" } });
      expect(new URL((again.structuredContent as any).url).origin).toBe(url.origin);
      const recordPath = join(root, "browser-console", readdirSync(join(root, "browser-console")).find(file => file.endsWith(".json"))!);
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      // A temporarily stalled listener must not cause another daemon to spawn.
      process.kill(record.pid, "SIGSTOP");
      try {
        const busy = await client.callTool({ name: "agent_control_console_open_browser", arguments: { panel_id: panelId } });
        expect(busy.isError).toBe(true);
        expect(JSON.parse(readFileSync(recordPath, "utf8")).pid).toBe(record.pid);
      } finally { process.kill(record.pid, "SIGCONT"); }
      await client.close();
      expect((await fetch(url)).status).toBe(200);
      const api = `http://localhost:${url.searchParams.get("apiPort")}/api/control/snapshot`;
      const snapshot = await (await fetch(api)).json() as any;
      expect(snapshot.runs.map((run: any) => run.run_id).sort()).toEqual([a.run_id, b.run_id].sort());
    } finally {
      await client.close();
      const { existsSync } = await import("node:fs");
      const records = join(root, "browser-console");
      if (existsSync(records)) for (const file of readdirSync(records).filter(name => name.endsWith(".json"))) {
        const record = JSON.parse(readFileSync(join(records, file), "utf8"));
        try { process.kill(record.pid, "SIGTERM"); } catch { /* Already stopped. */ }
      }
      // Wait for this test's detached listener before deleting its SQLite state.
      if (url) for (let i = 0; i < 50; i++) {
        try { await fetch(url, { signal: AbortSignal.timeout(100) }); } catch { break; }
        await new Promise(done => setTimeout(done, 50));
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
});
