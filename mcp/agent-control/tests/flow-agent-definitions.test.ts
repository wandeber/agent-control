import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentController } from "../src/core/controller.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { parseFlowConfig, resolveStepPromptSources } from "../src/core/flow.js";
import { compileFlowAgent, flowSourceConfig, resolveFlowAgentDefinitions } from "../src/core/flow-agent-definitions.js";
import { previewFlowCatalog } from "../src/core/flow-preview.js";
import { getFlowFromCatalog } from "../src/core/flow-catalog.js";
import { REQUIRED_AGENT_CONTROL_MCP, REQUIRED_AGENT_CONTROL_PLUGIN, type AgentDefinition } from "../src/core/agent-definitions.js";
import type { AgentDefinitionInventory, CompiledAgentConfiguration } from "../src/core/agent-definition-inventory.js";
import type { AgentAdapter, AgentHandle, FlowConfig, StartAgentInput } from "../src/core/types.js";

const fixture = vi.hoisted(() => ({ resolve: vi.fn(), inventory: vi.fn() }));
vi.mock("../src/core/agent-definitions.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/core/agent-definitions.js")>(),
  AgentDefinitionCatalog: class { resolve = fixture.resolve; }
}));
vi.mock("../src/core/agent-definition-inventory.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/core/agent-definition-inventory.js")>(),
  loadAgentDefinitionInventory: fixture.inventory
}));

function definition(): AgentDefinition {
  return { definition_id: "11111111-1111-4111-8111-111111111111", name: "Planner", description: "Shared planner", instructions: "Pinned planning instructions.",
    model: "base", model_provider: "provider", reasoning_effort: "high", plugins: [], skills: [], mcp_servers: [],
    created_at: "2026-09-12T00:00:00.000Z", updated_at: "2026-09-12T00:00:00.000Z" };
}
function inventory(): AgentDefinitionInventory {
  return { inventory_revision: "inventory-one", refreshed_at: "2026-09-12T00:00:00.000Z",
    runtime: { executable: "/fixture/codex", version: "fixture", compatible: true }, inherited_developer_instructions: "Inherited instructions.",
    providers: ["provider", "custom"].map(id => ({ id, available: true })),
    models: ["base", "override", "project"].flatMap(id => ["provider", "custom"].map(model_provider => ({ id, model_provider, supported_reasoning_efforts: ["high", "max"], available: true, catalog_available: true, run_validation_required: false }))),
    plugins: [{ id: REQUIRED_AGENT_CONTROL_PLUGIN, name: "Agent Control", required: true, available: true, enabled_by_default: true, bundled_skills: [], bundled_mcp_servers: [{ name: REQUIRED_AGENT_CONTROL_MCP }], bundled_apps: [] }],
    skills: [], mcp_servers: [{ name: REQUIRED_AGENT_CONTROL_MCP, required: true, available: true, enabled_by_default: true }], apps: [] };
}
class FixtureAdapter implements AgentAdapter {
  constructor(readonly kind = "codex-cli") {}
  starts: StartAgentInput[] = [];
  capabilities() { return { canStart: true, canSendMessage: true, canReadLatest: true, canStopGracefully: true, canForceStop: true, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: false }; }
  async start(input: StartAgentInput): Promise<AgentHandle> {
    this.starts.push(input);
    return { backend: this.kind, id: input.agent.agent_id, data: input.agent.backend_handle ?? { snapshot_hash: "fixture-snapshot", definition_id: (input.metadata?.configured_agent as CompiledAgentConfiguration | undefined)?.definition_id } };
  }
  async getStatus() { return { status: "running" as const }; }
  async readLatest() { return []; }
  async sendMessage() {}
  async stop() { return { status: "stopped" as const }; }
  async unregister() {}
}

describe("shared flow agent definitions", () => {
  let root: string, store: SqliteStore, controller: AgentController, adapter: FixtureAdapter;
  let owner: ReturnType<AgentController["orchestratorLogin"]>;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "flow-agents-")));
    vi.stubEnv("AGENT_CONTROL_HOME", join(root, "state")); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "fixture");
    vi.stubEnv("CODEX_THREAD_ID", ""); vi.stubEnv("AGENT_CONTROL_REQUESTER_THREAD_ID", "");
    fixture.resolve.mockReset().mockImplementation(() => ({ definition: definition(), revision: "catalog-one" }));
    fixture.inventory.mockReset().mockImplementation(async () => inventory());
    store = new SqliteStore(join(root, "state.sqlite")); adapter = new FixtureAdapter();
    const registry = new AdapterRegistry(); registry.register(adapter); registry.register(new FixtureAdapter("codex-thread")); controller = new AgentController(store, registry);
    owner = controller.orchestratorLogin({ adminKey: "fixture", title: "Owner", runTitle: "Flow objective", repoDir: root, backend: "codex-thread", backendHandle: { thread_id: "owner" } });
  });
  afterEach(async () => { await controller.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  function config(): FlowConfig { return { id: "shared", policy: { strict: true }, initial_step: "first", roles: { planner: { agent_ref: "development-planner" } }, steps: {
    first: { role: "planner", sandbox: "read_only", prompt: "First phase.", on: { completed: { to: "second" } } },
    second: { role: "planner", sandbox: "workspace", prompt: "Second phase.", on: { completed: { finish: true } } }
  } }; }
  function start(cfg = config()) { return controller.startFlow({ config: cfg, runId: owner.run.run_id, agentToken: owner.agent_token }); }
  function dispatch(id: string) { return controller.dispatchActiveFlowStep({ flowInstanceId: id, agentToken: owner.agent_token }); }
  function report(id: string) { const step = controller.getFlowSnapshot(id).steps.find(step => step.status === "active")!;
    return controller.reportFlowStep({ stepInstanceId: step.step_instance_id, status: "completed", agentToken: controller.issueAgentToken(step.agent_id!) }); }

  it.each(["prompt", "prompt_ref", "prompt_path"])("rejects agent_ref with role %s", key => {
    const cfg = config(); Object.assign(cfg.roles!.planner, { [key]: "instructions" });
    expect(() => parseFlowConfig(cfg)).toThrow(/cannot be combined/);
  });
  it("rejects incompatible backends, external snapshots and existing worker assignments", () => {
    const cfg = config(); cfg.roles!.planner.backend = "codex-thread";
    expect(() => parseFlowConfig(cfg)).toThrow(/codex-cli/);
    delete cfg.roles!.planner.backend;
    Object.assign(cfg.roles!.planner, { resolved_agent: {} });
    expect(() => parseFlowConfig(cfg)).toThrow(/internal/); expect(() => start(cfg)).toThrow(/internal/);
    delete cfg.roles!.planner.resolved_agent; cfg.steps.first.agent_id = "existing-agent";
    expect(() => parseFlowConfig(cfg)).toThrow(/pre-existing/);
  });
  it("reports an unknown reference before creating a flow", () => {
    fixture.resolve.mockImplementation(() => { throw new Error("Unknown reference"); });
    expect(() => start()).toThrow(/development-planner.*planner/);
    expect(store.listFlowInstances({ runId: owner.run.run_id })).toHaveLength(0);
    const runCount = store.listRuns().length;
    expect(() => controller.startFlow({ config: config(), repoDir: root, adminKey: "fixture" })).toThrow(/development-planner/);
    expect(store.listRuns()).toHaveLength(runCount);
  });
  it("resolves a repeated reference once and preserves the public source", () => {
    const cfg = config(); cfg.roles!.reviewer = { agent_ref: "development-planner", model: "override", model_provider: "custom", reasoning_effort: "max" };
    const pinned = resolveFlowAgentDefinitions(parseFlowConfig(cfg));
    expect(fixture.resolve).toHaveBeenCalledTimes(1);
    expect(pinned.roles!.reviewer.resolved_agent!.definition).toMatchObject({ model: "override", model_provider: "custom", reasoning_effort: "max" });
    expect(flowSourceConfig(pinned)).toEqual(cfg);
    expect(cfg.roles!.planner.resolved_agent).toBeUndefined();
    expect(resolveStepPromptSources(pinned, "first")[0]).toMatchObject({ text: "Pinned planning instructions.", agent_ref: "development-planner" });
  });
  it("freezes project overrides in both the role and compiled definition", async () => {
    mkdirSync(join(root, ".agents")); writeFileSync(join(root, ".agents/models.toml"), '[flows.shared.planner]\nmodel="project"\nmodel_provider="custom"\nreasoning_effort="max"\n');
    const cfg = config(); cfg.roles!.planner.model = "override";
    const result = start(cfg); const role = result.flow.config.roles!.planner;
    expect(role).toMatchObject({ model: "project", model_provider: "custom", reasoning_effort: "max" });
    writeFileSync(join(root, ".agents/models.toml"), '[flows.shared.planner]\nmodel="later"\n');
    await dispatch(result.instance.flow_instance_id);
    expect(adapter.starts[0]!.metadata?.configured_agent).toMatchObject({ model: "project", model_provider: "custom", reasoning_effort: "max", definition_instructions: "Pinned planning instructions.", catalog_revision: "catalog-one", repo_dir: root });
    expect(adapter.starts[0]!.prompt).not.toContain("Pinned planning instructions.");
    expect(fixture.inventory).toHaveBeenCalledWith(root, true);
  });
  it("retains one owner and snapshot across phases, replay and controller restart", async () => {
    const cfg = config(); const result = start(cfg); const id = result.instance.flow_instance_id;
    await dispatch(id); const initial = adapter.starts[0]!;
    expect(initial.metadata).toMatchObject({ sandbox: "read_only", flow_instance_id: id, step_instance_id: result.active_step!.step_instance_id, flow_step_instance_id: result.active_step!.step_instance_id });
    expect(initial.metadata).not.toHaveProperty("flow_writable_root");
    fixture.resolve.mockImplementation(() => { throw new Error("Catalog deleted after start"); });
    expect(start(cfg).reused).toBe(true);
    await controller.startAgent({ agentId: initial.agent.agent_id, prompt: initial.prompt, model: initial.model, metadata: initial.metadata });
    expect(adapter.starts).toHaveLength(1); expect(fixture.inventory).toHaveBeenCalledTimes(1);
    report(id);
    await controller.dispose(); controller = new AgentController(store, (() => { const registry = new AdapterRegistry(); registry.register(adapter); registry.register(new FixtureAdapter("codex-thread")); return registry; })());
    await dispatch(id);
    const second = adapter.starts[1]!;
    expect(second.agent.agent_id).toBe(initial.agent.agent_id);
    expect(second.metadata).not.toHaveProperty("configured_agent");
    expect(second.metadata).toMatchObject({ sandbox: "workspace", model_provider: "provider" });
    expect(second.metadata?.flow_writable_root).toBeTypeOf("string");
    expect(second.prompt).toContain("Second phase."); expect(second.prompt).not.toContain("First phase.");
    expect(fixture.inventory).toHaveBeenCalledTimes(1); expect(fixture.resolve).toHaveBeenCalledTimes(1);
  });
  it("compiles a fresh snapshot from the pinned definition for explicit owner recovery", async () => {
    const result = start(); const id = result.instance.flow_instance_id; await dispatch(id);
    const before = controller.getFlowSnapshot(id); store.updateAgent(before.runtime!.owners.planner!, { unregisteredAt: new Date().toISOString() });
    fixture.resolve.mockImplementation(() => { throw new Error("Catalog unavailable"); });
    controller.recoverFlowOwner({ flowInstanceId: id, role: "planner", restartStepId: "first", reason: "Replace lost owner", expectedRevision: before.runtime!.revision, agentToken: owner.agent_token });
    await dispatch(id);
    expect(adapter.starts[1]!.agent.agent_id).not.toBe(adapter.starts[0]!.agent.agent_id);
    expect(adapter.starts[1]!.metadata?.configured_agent).toMatchObject({ catalog_revision: "catalog-one", definition_instructions: "Pinned planning instructions." });
    expect(fixture.inventory).toHaveBeenCalledTimes(2); expect(fixture.resolve).toHaveBeenCalledTimes(1);
  });
  it("compiles each fresh_per_step worker without reading the catalog again", async () => {
    const cfg = config(); cfg.roles!.planner.agent_lifecycle = "fresh_per_step";
    const result = start(cfg); await dispatch(result.instance.flow_instance_id); report(result.instance.flow_instance_id); await dispatch(result.instance.flow_instance_id);
    expect(adapter.starts[0]!.agent.agent_id).not.toBe(adapter.starts[1]!.agent.agent_id);
    expect(fixture.inventory).toHaveBeenCalledTimes(2); expect(fixture.resolve).toHaveBeenCalledTimes(1);
  });
  it("does not borrow a previous instance's owner for a non-strict reference", async () => {
    const cfg = config(); delete cfg.policy;
    const first = start(cfg); await dispatch(first.instance.flow_instance_id); report(first.instance.flow_instance_id);
    await dispatch(first.instance.flow_instance_id); report(first.instance.flow_instance_id);
    fixture.resolve.mockReturnValue({ definition: { ...definition(), instructions: "New instance instructions." }, revision: "catalog-two" });
    const next = start(cfg); await dispatch(next.instance.flow_instance_id);
    expect(adapter.starts[2]!.agent.agent_id).not.toBe(adapter.starts[0]!.agent.agent_id);
    expect(adapter.starts[2]!.metadata?.configured_agent).toMatchObject({ catalog_revision: "catalog-two", definition_instructions: "New instance instructions." });
  });
  it("uses the actual repository when the run was opened through a symlink", async () => {
    const alias = join(root, "alias"); symlinkSync(root, alias);
    const aliasOwner = controller.orchestratorLogin({ adminKey: "fixture", title: "Alias owner", runTitle: "Alias flow", repoDir: alias, backend: "codex-thread", backendHandle: { thread_id: "alias-owner" } });
    const result = controller.startFlow({ config: config(), runId: aliasOwner.run.run_id, agentToken: aliasOwner.agent_token });
    await controller.dispatchActiveFlowStep({ flowInstanceId: result.instance.flow_instance_id, agentToken: aliasOwner.agent_token });
    expect(adapter.starts[0]!.agent.repo_dir).toBe(root);
    expect((adapter.starts[0]!.metadata?.configured_agent as CompiledAgentConfiguration).repo_dir).toBe(root);
  });
  it("rejects inconsistent pinned model or definition bytes before inventory access", async () => {
    const resolved = resolveFlowAgentDefinitions(parseFlowConfig(config())); resolved.roles!.planner.model = "other";
    await expect(compileFlowAgent(resolved.roles!.planner, root)).rejects.toThrow(/inconsistent/);
    resolved.roles!.planner.model = "base"; resolved.roles!.planner.resolved_agent!.definition.instructions = "tampered";
    await expect(compileFlowAgent(resolved.roles!.planner, root)).rejects.toThrow(/inconsistent/);
    expect(fixture.inventory).not.toHaveBeenCalled();
  });
  it("compiles package workers in their own worktree using the instance definition", async () => {
    const result = start(); const worktree = join(root, "package-worktree"); mkdirSync(worktree);
    const worker = controller.registerAgent({ runId: owner.run.run_id, backend: "codex-cli", title: "Package", role: "planner", repoDir: worktree, model: "base" });
    fixture.resolve.mockImplementation(() => { throw new Error("Catalog unavailable after start"); });
    await controller.startAgent({ agentId: worker.agent_id, prompt: "Package instructions", model: "base", metadata: {
      flow_instance_id: result.instance.flow_instance_id, flow_step_instance_id: result.active_step!.step_instance_id,
      package_flow_instance_id: result.instance.flow_instance_id, package_id: "one", package_attempt: 1, sandbox: "workspace"
    } });
    expect(adapter.starts[0]!.metadata?.configured_agent).toMatchObject({ repo_dir: worktree, catalog_revision: "catalog-one", definition_instructions: "Pinned planning instructions." });
    expect(fixture.inventory).toHaveBeenCalledWith(worktree, true); expect(fixture.resolve).toHaveBeenCalledTimes(1);
  });
  it("keeps inline CLI roles independent of the catalog and forwards explicit settings", async () => {
    const cfg = config(); cfg.roles!.planner = { backend: "codex-cli", model: "override", model_provider: "custom", reasoning_effort: "max", prompt: "Inline instructions." };
    const result = start(cfg); await dispatch(result.instance.flow_instance_id);
    expect(adapter.starts[0]!).toMatchObject({ model: "override", metadata: { model_provider: "custom", reasoning_effort: "max" } });
    expect(adapter.starts[0]!.prompt).toContain("Inline instructions.");
    expect(adapter.starts[0]!.metadata).not.toHaveProperty("configured_agent");
    expect(fixture.resolve).not.toHaveBeenCalled(); expect(fixture.inventory).not.toHaveBeenCalled();
  });
  it("previews current definitions separately from public config and active snapshots", () => {
    const cfg = config(); const started = start(cfg);
    const dir = join(root, ".agents/flows/shared"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "flow.json"), JSON.stringify(cfg));
    fixture.resolve.mockReturnValue({ definition: { ...definition(), instructions: "Current preview instructions." }, revision: "catalog-two" });
    const preview = previewFlowCatalog(root, "shared");
    expect(preview.error).toBeNull(); expect(preview.definition!.config.roles!.planner).toEqual(cfg.roles!.planner);
    expect(preview.definition!.resolved_roles.planner.resolved_agent!.catalog_revision).toBe("catalog-two");
    expect(preview.definition!.prompts.first[0]).toMatchObject({ text: "Current preview instructions." });
    expect(getFlowFromCatalog({ flowId: "shared", projectDir: root }).config).toEqual(cfg);
    expect(controller.getFlowSnapshot(started.instance.flow_instance_id).flow.config.roles!.planner.resolved_agent!.catalog_revision).toBe("catalog-one");
  });
});
