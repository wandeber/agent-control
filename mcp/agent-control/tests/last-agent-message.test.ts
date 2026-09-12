import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultAdapterRegistry } from "../src/adapters/registry.js";
import { AgentController } from "../src/core/controller.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import type { AgentStatusSnapshot } from "../src/core/types.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-last-message-"));
  vi.stubEnv("AGENT_CONTROL_HOME", home); vi.stubEnv("CODEX_HOME", home);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it("retains the final message through an empty completion observation and a controller restart", async () => {
  const store = new SqliteStore(join(home, "state.sqlite")), registry = createDefaultAdapterRegistry();
  let controller = new AgentController(store, registry);
  const observe = vi.spyOn(registry.get("manual"), "getStatus");
  try {
    const run = controller.createRun({ title: "Last message persistence" });
    const agent = controller.registerAgent({ runId: run.run_id, backend: "manual", title: "Worker", status: "running", backendHandle: { id: "worker" } });
    observe.mockResolvedValue({ status: "running", data: { activity: { kind: "message", text: "First line\nDelivered the result", observed_at: "2026-09-11T12:00:00Z" } } });
    await controller.refreshAgentStatus(agent.agent_id);
    observe.mockResolvedValue({ status: "completed", data: { activity: null } });
    await controller.refreshAgentStatus(agent.agent_id);
    expect(controller.getDashboardSnapshot(run.run_id).computed_agents[0]?.activity?.text).toBe("Delivered the result");
    await controller.dispose(); controller = new AgentController(store, registry);
    expect(controller.getDashboardSnapshot(run.run_id).computed_agents[0]?.activity?.text).toBe("Delivered the result");
  } finally { await controller.dispose(); store.close(); }
});

it("keeps the last display message across new work without restoring it as live flow activity", async () => {
  const store = new SqliteStore(":memory:"), registry = createDefaultAdapterRegistry(), controller = new AgentController(store, registry);
  try {
    const run = controller.createRun({ title: "Independent display history" });
    const agent = controller.registerAgent({ runId: run.run_id, backend: "manual", title: "Worker", status: "running", backendHandle: { id: "worker" } });
    const observe = vi.spyOn(registry.get("manual"), "getStatus");
    observe.mockResolvedValue({ status: "running", data: { activity: { kind: "message", text: "Previous result" } } });
    await controller.refreshAgentStatus(agent.agent_id);
    store.db.prepare("update agents set work_generation=work_generation+1 where agent_id=?").run(agent.agent_id);
    observe.mockResolvedValue({ status: "waiting_for_input", data: { activity: null } } as AgentStatusSnapshot);
    await controller.refreshAgentStatus(agent.agent_id);
    expect(controller.getDashboardSnapshot(run.run_id).computed_agents[0]?.activity?.text).toBe("Previous result");
    const persisted = JSON.parse((store.db.prepare("select activity_json from agent_activity where agent_id=?").get(agent.agent_id) as { activity_json: string }).activity_json);
    expect(persisted.cleared).toBe(true);
    observe.mockResolvedValue({ status: "running", data: { activity: { kind: "message", text: "New response" } } });
    await controller.refreshAgentStatus(agent.agent_id);
    expect(controller.getDashboardSnapshot(run.run_id).computed_agents[0]?.activity?.text).toBe("New response");
  } finally { await controller.dispose(); store.close(); }
});

it("recovers a completed CLI's actual final message without opening its chat", async () => {
  const store = new SqliteStore(":memory:"), controller = new AgentController(store, createDefaultAdapterRegistry());
  try {
    const thread = "11111111-1111-4111-8111-111111111111";
    mkdirSync(join(home, "sessions"));
    const path = join(home, "sessions", `rollout-${thread}.jsonl`);
    const row = (type: string, payload: unknown, timestamp = "2026-09-11T12:00:00Z") => JSON.stringify({ type, payload, timestamp }) + "\n";
    writeFileSync(path, row("session_meta", { id: thread }) + row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Saved the SVG" }] }) + row("event_msg", { type: "task_complete" }));
    writeFileSync(join(home, "state.json"), JSON.stringify({ thread_id: thread }));
    const run = controller.createRun({ title: "Historical CLI message" });
    controller.registerAgent({ runId: run.run_id, backend: "codex-cli", title: "Worker", status: "completed", backendHandle: { dir: home } });
    expect(controller.getDashboardSnapshot(run.run_id).computed_agents[0]?.activity).toMatchObject({ kind: "message", text: "Saved the SVG" });
    appendFileSync(path, row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Do not show user instructions as agent output" }] }, "2026-09-11T13:00:00Z"));
    expect(controller.getDashboardSnapshot(run.run_id).computed_agents[0]?.activity?.text).toBe("Saved the SVG");
  } finally { await controller.dispose(); store.close(); }
});
