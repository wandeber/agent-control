import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFlowEvidenceCommands } from "../src/cli/flow-evidence.js";
import { registerObservationCommands } from "../src/cli/observation.js";
import type { CliDeps } from "../src/cli/shared.js";

describe("flow evidence and observer CLI commands", () => {
  const directories: string[] = [];
  afterEach(() => { vi.unstubAllEnvs(); directories.forEach(path => rmSync(path, { recursive: true, force: true })); directories.length = 0; });
  function fixture() {
    const controller = { updateFlowContext: vi.fn(() => ({ revision: 2 })), recordFlowDecision: vi.fn(() => ({ recorded: true })),
      executeFlowEvidence: vi.fn(async () => ({ receipt_id: "receipt" })), acknowledgeRunEvents: vi.fn(() => ({ advanced: true })),
      waitForRun: vi.fn(async () => ({ events: [] })) };
    const program = new Command(); program.exitOverride();
    const deps = { controller, output: vi.fn(), authOptions: vi.fn(() => ({ adminKey: "test-admin" })) } as unknown as CliDeps;
    registerFlowEvidenceCommands(program.command("flow"), deps);
    registerObservationCommands(program.command("run"), deps);
    return { controller, deps, parse: (args: string[]) => program.parseAsync(args, { from: "user" }) };
  }
  it("passes context CAS and artifact-bound decisions to production controller methods", async () => {
    const { controller, parse } = fixture();
    await parse(["flow", "context-update", "--flow", "flow-1", "--expected-revision", "1", "--context-json", '{"objective":"Revised"}']);
    expect(controller.updateFlowContext).toHaveBeenCalledWith({ flowInstanceId: "flow-1", expectedRevision: 1,
      context: { objective: "Revised" }, adminKey: "test-admin" });
    await parse(["flow", "decision", "--flow", "flow-1", "--key", "plan_approved", "--value-json", "true", "--reason", "Approved exact plan",
      "--expected-revision", "2", "--artifact-key", "plan", "--artifact-digest", "digest"]);
    expect(controller.recordFlowDecision).toHaveBeenCalledWith({ flowInstanceId: "flow-1", key: "plan_approved", value: true,
      reason: "Approved exact plan", expectedRevision: 2, artifactKey: "plan", artifactDigest: "digest", adminKey: "test-admin" });
  });
  it("loads evidence request files and forwards configured caller authentication", async () => {
    const { controller, parse } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "flow-evidence-cli-")); directories.push(directory);
    const path = join(directory, "request.json"); writeFileSync(path, JSON.stringify({ operation: "prepare_plan", plan_path: "plan.md" }));
    await parse(["flow", "evidence", "--flow", "flow-1", "--key", "plan-review", "--step", "step-1", "--request-file", path]);
    expect(controller.executeFlowEvidence).toHaveBeenCalledWith({ flowInstanceId: "flow-1", key: "plan-review", stepInstanceId: "step-1",
      request: { operation: "prepare_plan", plan_path: "plan.md" }, adminKey: "test-admin" });
  });
  it("does not invoke a mutation for ambiguous input or a malformed revision", async () => {
    const { controller, parse } = fixture();
    await expect(parse(["flow", "context-update", "--flow", "f", "--expected-revision", "1", "--context-file", "missing", "--context-json", "{}"])).rejects.toThrow(/exactly one/);
    await expect(parse(["flow", "context-update", "--flow", "f", "--expected-revision", "1garbage", "--context-json", "{}"])).rejects.toThrow(/integer revision/);
    expect(controller.updateFlowContext).not.toHaveBeenCalled();
  });
  it("exposes explicit ACK and allows waiting from durable progress without a cursor", async () => {
    const { controller, parse } = fixture();
    await parse(["run", "wait", "--run", "r", "--observer-agent-id", "o", "--timeout", "1h"]);
    expect(controller.waitForRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "r", observerAgentId: "o", cursor: undefined, timeoutMs: 3_600_000 }));
    expect(controller.acknowledgeRunEvents).not.toHaveBeenCalled();
    await parse(["run", "ack", "--run", "r", "--observer-agent-id", "o", "--cursor", "delivered-cursor"]);
    expect(controller.acknowledgeRunEvents).toHaveBeenCalledWith({ runId: "r", observerAgentId: "o", cursor: "delivered-cursor", adminKey: "test-admin" });
  });
});
