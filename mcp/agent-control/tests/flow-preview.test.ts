import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewFlowCatalog } from "../src/core/flow-preview.js";
import { getFlowFromCatalog } from "../src/core/flow-catalog.js";

let root: string, flowDir: string;
const config = { id: "example", initial_step: "first", roles: { writer: { backend: "codex-thread", model: "gpt-5.6-luna", reasoning_effort: "max", prompt_path: "agent.md" } }, steps: { first: { role: "writer", prompt: "Phase instructions", on: { reported: { finish: true } } } } };
const save = (value: unknown = config) => writeFileSync(join(flowDir, "flow.json"), JSON.stringify(value));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flow-preview-"));
  flowDir = join(root, ".agents", "flows", "example");
  mkdirSync(flowDir, { recursive: true });
  mkdirSync(join(root, "bundled"));
  vi.stubEnv("AGENT_CONTROL_FLOW_CATALOG_DIR", join(root, "bundled"));
  vi.stubEnv("AGENT_CONTROL_USER_FLOW_CATALOG_DIR", join(root, "user"));
  writeFileSync(join(flowDir, "agent.md"), "Agent instructions"); save();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("source flow preview", () => {
  it("resolves the directory alias just like the catalog loader", () => {
    save({ ...config, id: "canonical" });
    const preview = previewFlowCatalog(root, "example");
    expect(preview.selected_flow_id).toBe("canonical");
    expect(preview.definition?.config.id).toBe("canonical");
  });
  it("resolves role and phase prompts without a run and revisions change on prompt-only edits", () => {
    const first = previewFlowCatalog(root, "example");
    expect(first.definition?.prompts.first).toMatchObject([{ scope: "role", text: "Agent instructions" }, { scope: "step", text: "Phase instructions" }]);
    expect(previewFlowCatalog(root, "example").revision).toBe(first.revision);
    writeFileSync(join(flowDir, "agent.md"), "Updated role instructions");
    const updated = previewFlowCatalog(root, "example");
    expect(updated.revision).not.toBe(first.revision);
    expect(updated.definition?.prompts.first?.[0]?.text).toBe("Updated role instructions");
  });
  it("uses project overrides exactly like launch and refreshes when only model settings change", () => {
    const before = previewFlowCatalog(root, "example");
    writeFileSync(join(root, ".agents", "models.toml"), '[flows.example.writer]\nmodel="gpt-6-astra"\nreasoning_effort="xhigh"\n');
    const after = previewFlowCatalog(root, "example");
    expect(after.error).toBeNull();
    expect(after.definition?.config.roles).toEqual(getFlowFromCatalog({ flowId: "example", projectDir: root }).config.roles);
    expect(after.definition?.config.roles?.writer?.model).toBe("gpt-6-astra");
    expect(after.revision).not.toBe(before.revision);
  });
  it("reports incomplete drafts and recovers after save, including newly created flows", () => {
    expect(previewFlowCatalog(root, "new").definition).toBeNull();
    writeFileSync(join(flowDir, "flow.json"), '{"id":');
    expect(previewFlowCatalog(root, "example")).toMatchObject({ definition: null, error: expect.any(String) });
    save(); expect(previewFlowCatalog(root, "example").definition).not.toBeNull();
    mkdirSync(join(root, ".agents", "flows", "new"));
    writeFileSync(join(root, ".agents", "flows", "new", "flow.yaml"), 'id: new\ninitial_step: start\nsteps:\n  start:\n    prompt: Hello\n');
    expect(previewFlowCatalog(root, "new").definition?.config.id).toBe("new");
  });
  it("replaces a bundled same-ID flow with the project definition", () => {
    mkdirSync(join(root, "bundled", "example"));
    writeFileSync(join(root, "bundled", "example", "flow.json"), JSON.stringify({ id: "example", initial_step: "other", steps: { other: { prompt: "Bundled" } } }));
    const result = previewFlowCatalog(root, "example");
    expect(result.flows).toHaveLength(1);
    expect(result.definition?.config.initial_step).toBe("first");
  });
  it("does not expose external prompt contents through symlinks", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-preview-"));
    try {
      writeFileSync(join(outside, "private.md"), "NEVER DISPLAY THIS");
      rmSync(join(flowDir, "agent.md")); symlinkSync(join(outside, "private.md"), join(flowDir, "agent.md"));
      const prompt = previewFlowCatalog(root, "example").definition?.prompts.first?.[0];
      expect(prompt?.text).toBeNull(); expect(prompt?.error).toMatch(/outside/);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  it("bounds prompt reads", () => {
    writeFileSync(join(flowDir, "agent.md"), "x".repeat(512 * 1024 + 1));
    expect(previewFlowCatalog(root, "example").definition?.prompts.first?.[0]).toMatchObject({ text: null, error: expect.stringContaining("too large") });
  });
});
