import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDefaultAdapterRegistry } from "../src/adapters/registry.js";
import { AgentController } from "../src/core/controller.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { loadConsoleSnapshot } from "../src/console-tools.js";
import { ConsoleSessions } from "../src/console-sessions.js";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "console-scope-"));
  vi.stubEnv("AGENT_CONTROL_HOME", root);
  const db = join(root, "state.sqlite");
  const store = new SqliteStore(db), controller = new AgentController(store, createDefaultAdapterRegistry());
  const a = controller.createRun({ title: "Conversation A", repoDir: root });
  const b = controller.createRun({ title: "Conversation B", repoDir: root });
  store.db.prepare("insert into run_requesters(run_id, thread_id) values (?, ?)").run(a.run_id, "thread-a");
  const agentB = controller.registerAgent({ runId: b.run_id, backend: "codex-thread", title: "Worker B", status: "completed", backendHandle: { thread_id: "thread-b" } });
  return { root, db, store, controller, a, b, agentB, dispose: async () => { await controller.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("conversation-scoped console", () => {
  it("opens and edits flow previews with no runs, with panel-bound project scope and durable selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "console-preview-"));
    const project = join(root, "project");
    const dir = join(project, ".agents", "flows", "draft");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "flow.yaml");
    writeFileSync(path, "id: draft\ninitial_step: start\nsteps:\n  start:\n    prompt: Original\n");
    const db = join(root, "state.sqlite");
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: resolve("."), env: { ...process.env, AGENT_CONTROL_HOME: root, AGENT_CONTROL_DB: db, AGENT_CONTROL_POLL_INTERVAL_MS: "0" }, stderr: "pipe" });
    const client = new Client({ name: "flow-preview-test", version: "1" });
    const call = (name: string, args: Record<string, unknown>, thread = "owner") => client.callTool({ name, arguments: args, _meta: { threadId: thread } });
    const data = (result: Awaited<ReturnType<typeof call>>) => result.structuredContent as any;
    try {
      await client.connect(transport);
      const opened = data(await call("open_agent_control_console", { screen: "flows", flow_id: "draft", repo_dir: project }));
      expect(opened.snapshot).toBeUndefined();
      const panel = opened.console.panel_id;
      expect(opened.console).toMatchObject({ screen: "flows", flow_id: "draft", repo_dir: project });
      expect((await call("agent_control_console_flows", { panel_id: panel }, "another")).isError).toBe(true);
      expect((await call("agent_control_console_flows", {})).isError).toBe(true);
      const first = data(await call("agent_control_console_flows", { panel_id: panel }));
      expect(first.preview.definition.config.steps.start.prompt).toBe("Original");
      writeFileSync(path, "id: draft\ninitial_step: start\nsteps:\n  start:\n    prompt: Edited\n");
      const edited = data(await call("agent_control_console_flows", { panel_id: panel, repo_dir: root }));
      expect(edited.preview.project_dir).toBe(project);
      expect(edited.preview.definition.config.steps.start.prompt).toBe("Edited");
      const reused = data(await call("reuse_agent_control_console", { screen: "flows", flow_id: "future" }));
      const delivered = data(await call("agent_control_console_flows", { panel_id: panel, flow_id: "draft" }));
      expect(delivered.console.command_id).toBe(reused.console.command_id);
      const acknowledged = data(await call("agent_control_console_flows", { panel_id: panel, command_id: reused.console.command_id }));
      expect(acknowledged.console).toMatchObject({ screen: "flows", flow_id: "future", repo_dir: project });
      expect(acknowledged.console.command_id).toBeUndefined();
      const store = new SqliteStore(db);
      try { expect(store.listRuns()).toHaveLength(0); expect(store.listAgents()).toHaveLength(0); } finally { store.close(); }
    } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("never queues a delayed command into a replacement panel", () => {
    const sessions = new ConsoleSessions();
    const oldPanel = sessions.open("thread-a");
    const replacement = sessions.open("thread-a");
    expect(() => sessions.queue(oldPanel, "close")).toThrow(/Reopen/);
    expect(replacement.command).toBeNull();
    expect(() => sessions.forApp("thread-a")).toThrow(/Reopen/);
  });
  it("filters before selecting or polling; global mode includes all historical runs", async () => {
    const f = fixture();
    try {
      const child = f.store.createRun({ title: "Nested work", repoDir: f.root, parentRunId: f.a.run_id });
      for (let i = 0; i < 120; i++) f.controller.createRun({ title: `Unrelated ${i}`, repoDir: f.root });
      const scope = { threadId: "thread-a" };
      expect(f.controller.getDashboardSnapshot(f.a.run_id, scope).runs.map(run => run.run_id).sort()).toEqual([f.a.run_id, child.run_id].sort());
      expect(f.controller.getDashboardSnapshot(f.b.run_id, { threadId: "thread-b" }).runs.map(run => run.run_id)).toEqual([f.b.run_id]);
      expect(f.controller.getDashboardSnapshot().runs).toHaveLength(123);
      const poll = vi.spyOn(f.controller, "pollActiveAgents").mockResolvedValue([]);
      await expect(loadConsoleSnapshot(f.controller, f.b.run_id, scope)).rejects.toThrow(/not associated/);
      expect(poll).not.toHaveBeenCalled();
      const empty = await loadConsoleSnapshot(f.controller, undefined, { threadId: "unassociated" });
      expect(empty.snapshot.runs).toEqual([]);
      expect(empty.snapshot.agents).toEqual([]);
      expect(empty.snapshot.selected_run_id).toBeNull();
      expect(poll).not.toHaveBeenCalled();
      const own = await loadConsoleSnapshot(f.controller, undefined, scope);
      expect(poll).toHaveBeenCalledWith(own.snapshot.selected_run_id);
      expect([f.a.run_id, child.run_id]).toContain(own.snapshot.selected_run_id);
      expect(f.controller.getDashboardSnapshot(undefined, { threadId: null }).runs).toEqual([]);
    } finally { await f.dispose(); }
  });

  it("keeps explicit observers and retired participants visible without using repository proximity", async () => {
    const f = fixture();
    try {
      f.store.db.prepare(`insert into run_observers(observer_agent_id, run_id, thread_id, events_json, delivery, start_sequence, created_at)
        values (?, ?, ?, '[]', 'wait', 0, ?)`).run(f.agentB.agent_id, f.b.run_id, "second-observer", new Date().toISOString());
      expect(f.store.listConsoleRuns("second-observer").map(run => run.run_id)).toEqual([f.b.run_id]);
      f.store.db.prepare("update agents set unregistered_at = ? where agent_id = ?").run(new Date().toISOString(), f.agentB.agent_id);
      expect(f.store.listConsoleRuns("thread-b").map(run => run.run_id)).toEqual([f.b.run_id]);
      const native = f.controller.createRun({ title: "Native participant", repoDir: f.root });
      f.store.createAgent({ runId: native.run_id, title: "Native", backend: "codex-subagent", backendHandle: { native_agent_id: "native-thread" } });
      expect(f.store.listConsoleRuns("native-thread").map(run => run.run_id)).toEqual([native.run_id]);
    } finally { await f.dispose(); }
  });

  it("isolates two panels in one MCP process, including commands, ACKs and app-only detail reads", async () => {
    const f = fixture();
    const env = { ...process.env, AGENT_CONTROL_HOME: f.root, AGENT_CONTROL_DB: f.db, CODEX_THREAD_ID: "wrong-process-thread", AGENT_CONTROL_POLL_INTERVAL_MS: "0" };
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: resolve("."), env, stderr: "pipe" });
    const client = new Client({ name: "console-scope-test", version: "1" });
    const call = (name: string, args: Record<string, unknown> = {}, threadId?: string) => client.callTool({ name, arguments: args, ...(threadId ? { _meta: { threadId } } : {}) });
    const data = (result: Awaited<ReturnType<typeof call>>) => result.structuredContent as any;
    try {
      await client.connect(transport);
      expect((await call("open_agent_control_console")).isError).toBe(true);
      const [openedA, openedB] = await Promise.all([call("open_agent_control_console", {}, "thread-a"), call("open_agent_control_console", {}, "thread-b")]);
      const panelA = data(openedA).console.panel_id, panelB = data(openedB).console.panel_id;
      expect(panelA).not.toBe(panelB);
      expect(data(openedA).snapshot.runs.map((run: any) => run.run_id)).toEqual([f.a.run_id]);
      expect(data(openedB).snapshot.runs.map((run: any) => run.run_id)).toEqual([f.b.run_id]);
      expect(data(await call("agent_control_console_snapshot", { panel_id: panelA })).snapshot.selected_run_id).toBe(f.a.run_id);
      expect((await call("agent_control_console_snapshot")).isError).toBe(true);
      expect((await call("agent_control_console_snapshot", { panel_id: "unknown" })).isError).toBe(true);
      expect((await call("agent_control_console_snapshot", { panel_id: panelA }, "thread-b")).isError).toBe(true);
      expect((await call("agent_control_console_snapshot", { panel_id: panelA, run_id: f.b.run_id })).isError).toBe(true);
      for (const name of ["agent_control_console_agent_messages", "agent_control_console_agent_log"]) {
        expect((await call(name, { panel_id: panelA, agent_id: f.agentB.agent_id })).isError).toBe(true);
      }
      expect((await call("agent_control_console_agent_log", { panel_id: panelB, agent_id: f.agentB.agent_id })).isError).not.toBe(true);
      const closeA = data(await call("close_agent_control_console", {}, "thread-a")).console;
      const reuseB = data(await call("reuse_agent_control_console", { run_id: f.b.run_id }, "thread-b")).console;
      expect(data(await call("agent_control_console_snapshot", { panel_id: panelB, command_id: closeA.command_id })).console.command_id).toBe(reuseB.command_id);
      expect(data(await call("agent_control_console_snapshot", { panel_id: panelA })).console.action).toBe("close");
      await call("open_agent_control_console", {}, "thread-a");
      expect((await call("agent_control_console_snapshot", { panel_id: panelA })).isError).toBe(true);
      expect(data(await call("agent_control_console_snapshot", { panel_id: panelB, command_id: reuseB.command_id })).console.action).toBeUndefined();
    } finally { await client.close(); await f.dispose(); }
  }, 15000);
});
