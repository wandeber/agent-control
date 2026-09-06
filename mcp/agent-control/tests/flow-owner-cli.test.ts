import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "../src/core/controller.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import type { AgentAdapter, FlowSnapshot, StartAgentInput } from "../src/core/types.js";

describe("owner recovery CLI", () => {
  it("replaces a detached reviewer through the controller and returns only its public snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flow-owner-cli-"));
    const env = { ...process.env, AGENT_CONTROL_HOME: directory, AGENT_CONTROL_DB: join(directory, "state.sqlite"),
      AGENT_CONTROL_ADMIN_KEY: "owner-recovery-fixture-admin", AGENT_CONTROL_TOKEN: "", CODEX_THREAD_ID: "" };
    for (const name of ["AGENT_CONTROL_HOME", "AGENT_CONTROL_ADMIN_KEY", "CODEX_THREAD_ID"] as const) vi.stubEnv(name, env[name]);
    const store = new SqliteStore(env.AGENT_CONTROL_DB);
    const registry = new AdapterRegistry();
    const start = vi.fn(async ({ agent }: StartAgentInput) => ({ backend: "codex-thread", id: agent.agent_id, data: { thread_id: `fixture-${agent.agent_id}` } }));
    registry.register({ kind: "codex-thread", capabilities: () => ({ canStart: true, canSendMessage: true,
      canReadLatest: true, canStopGracefully: true, canForceStop: false, canStreamMessages: false,
      canInspectStatusCheaply: true, canAttachExisting: true }), start, getStatus: async () => ({ status: "running" }),
      readLatest: async () => [], sendMessage: async () => {}, stop: async () => ({ status: "stopped" }) } satisfies AgentAdapter);
    const controller = new AgentController(store, registry);
    try {
      const owner = controller.orchestratorLogin({ title: "Owner", backend: "codex-thread", adminKey: env.AGENT_CONTROL_ADMIN_KEY,
        repoDir: directory, backendHandle: { thread_id: "coordinator-fixture" } });
      const flow = controller.startFlow({ runId: owner.run.run_id, agentToken: owner.agent_token, config: {
        id: "recover-reviewer-cli", initial_step: "review", policy: { strict: true }, roles: { reviewer: { backend: "codex-thread" } },
        steps: { review: { role: "reviewer", prompt: "Review the complete accepted task", on: { completed: { finish: true } } } }
      } });
      await controller.dispatchActiveFlowStep({ flowInstanceId: flow.instance.flow_instance_id, agentToken: owner.agent_token });
      const before = controller.getFlowSnapshot(flow.instance.flow_instance_id);
      const previous = before.runtime!.owners.reviewer!;
      store.updateAgent(previous, { unregisteredAt: new Date().toISOString() });
      env.AGENT_CONTROL_TOKEN = owner.agent_token;
      const args = ["--import", "tsx", "src/cli.ts", "flow", "recover-owner", "--flow", flow.instance.flow_instance_id,
        "--role", "reviewer", "--restart-step", "review", "--reason", "Assigned reviewer was detached; perform a fresh full review.",
        "--expected-revision", String(before.runtime!.revision)];
      const raw = execFileSync(process.execPath, args, { cwd: resolve("."), encoding: "utf8", env });
      const recovered = JSON.parse(raw) as FlowSnapshot;
      expect(recovered.runtime!.owners.reviewer).not.toBe(previous);
      expect(recovered.runtime!.recovery?.full_review_required).toBe(true);
      expect(raw).not.toContain(owner.agent_token);
      expect(raw).not.toMatch(/"(?:agent_token|report_token|admin_key)"/);
      const retried = JSON.parse(execFileSync(process.execPath, args, { cwd: resolve("."), encoding: "utf8", env })) as FlowSnapshot;
      expect(retried.runtime!.owners.reviewer).toBe(recovered.runtime!.owners.reviewer);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      await controller.dispose(); store.close(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
    }
  });
});
