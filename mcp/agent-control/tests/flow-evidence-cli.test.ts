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
      executeFlowPackages: vi.fn(async () => ({ branches: {} })), executeFlowEvidence: vi.fn(async () => ({ receipt_id: "receipt" })), acknowledgeRunEvents: vi.fn(() => ({ advanced: true })),
      waitForRun: vi.fn(async () => ({ events: [] })), recoverFlowOwner: vi.fn(() => ({ runtime: { recovery: { full_review_required: true } } })) };
    const program = new Command(); program.exitOverride();
    const deps = { controller, output: vi.fn(), authOptions: vi.fn(() => ({ adminKey: "test-admin" })) } as unknown as CliDeps;
    registerFlowEvidenceCommands(program.command("flow"), deps);
    registerObservationCommands(program.command("run"), deps);
    return { controller, deps, program, parse: (args: string[]) => program.parseAsync(args, { from: "user" }) };
  }
  it("exposes explicit owner recovery with exact routing, revision and caller authentication", async () => {
    const { controller, deps, parse, program } = fixture();
    vi.mocked(deps.authOptions).mockReturnValue({ agentToken: "test-owner-token" });
    await parse(["flow", "recover-owner", "--flow", "flow-1", "--role", "reviewer", "--restart-step", "review",
      "--reason", "The assigned reviewer was detached; perform a full review.", "--expected-revision", "4"]);
    expect(controller.recoverFlowOwner).toHaveBeenCalledWith({ flowInstanceId: "flow-1", role: "reviewer", restartStepId: "review",
      reason: "The assigned reviewer was detached; perform a full review.", expectedRevision: 4, agentToken: "test-owner-token" });
    expect(deps.output).toHaveBeenCalledWith({ runtime: { recovery: { full_review_required: true } } });
    const help = program.commands.find(command => command.name() === "flow")!.commands.find(command => command.name() === "recover-owner")!.helpInformation();
    expect(help).toContain("--expected-revision"); expect(help).toContain("--restart-step"); expect(help).toContain("stopped or detached");
  });
  it("passes context CAS and artifact-bound decisions to production controller methods", async () => {
    const { controller, parse } = fixture();
    await parse(["flow", "context-update", "--flow", "flow-1", "--expected-revision", "1", "--context-json", '{"objective":"Revised"}']);
    expect(controller.updateFlowContext).toHaveBeenCalledWith({ flowInstanceId: "flow-1", expectedRevision: 1,
      context: '{"objective":"Revised"}', adminKey: "test-admin" });
    await parse(["flow", "decision", "--flow", "flow-1", "--key", "plan_approved", "--value-json", "true", "--reason", "Approved exact plan",
      "--expected-revision", "2", "--artifact-key", "plan", "--artifact-digest", "digest"]);
    expect(controller.recordFlowDecision).toHaveBeenCalledWith({ flowInstanceId: "flow-1", key: "plan_approved", value: true,
      reason: "Approved exact plan", expectedRevision: 2, artifactKey: "plan", artifactDigest: "digest", adminKey: "test-admin" });
  });
  it("preserves a complete multiline accepted contract from text and UTF-8 files", async () => {
    const first = fixture();
    const contract = "Keep existing requirements.\nChange only the agreed behavior.\nAcceptance: preserve the user decision.";
    await first.parse(["flow", "context-update", "--flow", "f", "--expected-revision", "2", "--context", contract]);
    expect(first.controller.updateFlowContext).toHaveBeenCalledWith(expect.objectContaining({ context: contract, expectedRevision: 2 }));
    const directory = mkdtempSync(join(tmpdir(), "accepted-context-cli-")); directories.push(directory);
    const path = join(directory, "contract.md"); writeFileSync(path, contract);
    const second = fixture();
    await second.parse(["flow", "context-update", "--flow", "f", "--expected-revision", "3", "--context-file", path]);
    expect(second.controller.updateFlowContext).toHaveBeenCalledWith(expect.objectContaining({ context: contract, expectedRevision: 3 }));
    const empty = fixture();
    await expect(empty.parse(["flow", "context-update", "--flow", "f", "--expected-revision", "0", "--context", "  "])).rejects.toThrow(/must not be empty/);
    expect(empty.controller.updateFlowContext).not.toHaveBeenCalled();
  });
  it("forwards compact package requests and the manifest digest in the existing plan approval", async () => {
    const { controller, parse } = fixture();
    await parse(["flow", "packages", "--flow-instance-id", "flow-1", "--request-json", '{"operation":"launch"}']);
    expect(controller.executeFlowPackages).toHaveBeenCalledWith({ flowInstanceId: "flow-1", request: { operation: "launch" }, adminKey: "test-admin" });
    await parse(["flow", "decision", "--flow", "flow-1", "--key", "plan", "--value-json", '"approved"', "--reason", "Approved plan and packages", "--expected-revision", "2", "--artifact-digest", "plan-hash", "--package-manifest-digest", "package-hash"]);
    expect(controller.recordFlowDecision).toHaveBeenCalledWith(expect.objectContaining({ packageManifestDigest: "package-hash", artifactDigest: "plan-hash" }));
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
