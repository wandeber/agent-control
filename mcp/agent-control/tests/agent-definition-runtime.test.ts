import { replaceAgentCapabilities, skillRows } from "../../../web/src/lib/agent-definitions.js";
import { agentDefinitionSchema } from "../src/core/agent-definitions.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileAgentConfiguration,
  compiledSnapshotHash,
  refreshCompiledAgentConfiguration,
  type AgentDefinitionInventory
} from "../src/core/agent-definition-inventory.js";
import {
  readConfiguredAgentExecutionSnapshot,
  verifyConfiguredAgentThread
} from "../src/core/configured-agent-runtime.js";
import {
  REQUIRED_AGENT_CONTROL_MCP,
  REQUIRED_AGENT_CONTROL_PLUGIN,
  type AgentDefinition
} from "../src/core/agent-definitions.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inventory(repo: string): AgentDefinitionInventory {
  return {
    inventory_revision: "inventory-one",
    refreshed_at: "2026-09-12T00:00:00.000Z",
    runtime: { executable: "/qualified/codex", version: "codex-cli 0.153.4", compatible: true },
    inherited_developer_instructions: "Inherited sentinel.",
    providers: [{ id: "provider", available: true }],
    models: [{ id: "model", model_provider: "provider", supported_reasoning_efforts: ["high"],
      available: true, catalog_available: true, run_validation_required: false }],
    plugins: [
      { id: REQUIRED_AGENT_CONTROL_PLUGIN, name: "Agent Control", required: true, available: true,
        enabled_by_default: true, bundled_skills: [{ path: "/agent-control/SKILL.md", name: "Agent Control" }],
        bundled_mcp_servers: [{ name: REQUIRED_AGENT_CONTROL_MCP }], bundled_apps: [] },
      { id: "selected@plugins", name: "Selected", required: false, available: true,
        enabled_by_default: false, bundled_skills: [{ path: "/selected/SKILL.md", name: "Selected" }],
        bundled_mcp_servers: [{ name: "selected_mcp", root_transport: true }], bundled_apps: [{ id: "selected-app", name: "Selected App" }] },
      { id: "off@plugins", name: "Off", required: false, available: true,
        enabled_by_default: true, bundled_skills: [{ path: "/off/SKILL.md", name: "Off" }],
        bundled_mcp_servers: [{ name: "off_mcp" }], bundled_apps: [{ id: "off-app", name: "Off App" }] },
      { id: "other-owner@plugins", name: "Other owner", required: false, available: true,
        enabled_by_default: false, bundled_skills: [], bundled_mcp_servers: [],
        bundled_apps: [{ id: "selected-app", name: "Selected App" }] }
    ],
    skills: [{ path: "/standalone/SKILL.md", name: "Standalone", required: false, available: true, enabled_by_default: true }],
    mcp_servers: [
      { name: REQUIRED_AGENT_CONTROL_MCP, required: true, available: true, enabled_by_default: true },
      { name: "standalone_mcp", required: false, available: true, enabled_by_default: true }
    ],
    apps: [
      { id: "selected-app", name: "Selected App", available: true, enabled_by_default: false },
      { id: "off-app", name: "Off App", available: true, enabled_by_default: true }
    ]
  };
}

function definition(): AgentDefinition {
  return {
    definition_id: "11111111-1111-4111-8111-111111111111",
    name: "Configured",
    description: "",
    instructions: "Definition sentinel.",
    model: "model",
    model_provider: "provider",
    reasoning_effort: "high",
    skills_catalog_token_budget: 9000,
    plugins: [{ id: REQUIRED_AGENT_CONTROL_PLUGIN, enabled: true }, { id: "selected@plugins", enabled: true }],
    skills: [{ path: "/standalone/SKILL.md", enabled: false }],
    mcp_servers: [{ name: REQUIRED_AGENT_CONTROL_MCP, enabled: true }, { name: "standalone_mcp", enabled: false }],
    created_at: "2026-09-12T00:00:00.000Z",
    updated_at: "2026-09-12T00:00:00.000Z"
  };
}

describe("configured-agent runtime", () => {
  it("inherits effective Codex capabilities at launch and freezes them across continuations", () => {
    const current = inventory("/project");
    current.plugins.find(plugin => plugin.id === "off@plugins")!.bundled_skills[0]!.enabled_by_default = false;
    current.plugins.find(plugin => plugin.id === "off@plugins")!.bundled_mcp_servers[0]!.enabled_by_default = false;
    current.apps.push({ id: "standalone-app", name: "Standalone", available: true, enabled_by_default: true });
    const inherited = { ...definition(), capabilities_mode: "inherit" as const };
    const compiled = compileAgentConfiguration(inherited, "revision", current, "/project");
    expect(compiled.plugins.find(plugin => plugin.id === "selected@plugins")!.enabled).toBe(false);
    expect(compiled.plugins.find(plugin => plugin.id === "off@plugins")!.enabled).toBe(true);
    expect(compiled.plugins.find(plugin => plugin.id === "off@plugins")!.bundled_skills[0]!.enabled).toBe(false);
    expect(compiled.mcp_servers.find(server => server.name === "off_mcp")!.enabled).toBe(false);
    expect(compiled.skills.find(skill => skill.path === "/standalone/SKILL.md")!.enabled).toBe(true);
    expect(compiled.mcp_servers.find(server => server.name === "standalone_mcp")!.enabled).toBe(true);
    expect(compiled.apps.find(app => app.id === "standalone-app")!.enabled).toBe(true);
    const changed = structuredClone(current);
    changed.plugins.forEach(plugin => { plugin.enabled_by_default = !plugin.enabled_by_default; });
    changed.skills[0]!.enabled_by_default = false;
    changed.mcp_servers.find(server => server.name === "standalone_mcp")!.enabled_by_default = false;
    changed.apps.find(app => app.id === "standalone-app")!.enabled_by_default = false;
    const resumed = refreshCompiledAgentConfiguration(compiled, changed);
    expect(resumed.plugins.map(({ id, enabled }) => ({ id, enabled }))).toEqual(compiled.plugins.map(({ id, enabled }) => ({ id, enabled })));
    expect(resumed.skills).toEqual(compiled.skills);
    expect(resumed.mcp_servers).toEqual(compiled.mcp_servers);
    expect(resumed.apps.map(({ id, enabled }) => ({ id, enabled }))).toEqual(compiled.apps.map(({ id, enabled }) => ({ id, enabled })));
    expect(compileAgentConfiguration(inherited, "revision", changed, "/project").skills[0]!.enabled).toBe(false);
    expect(compileAgentConfiguration({ ...inherited, capabilities_mode: "custom" }, "revision", current, "/project").plugins.find(plugin => plugin.id === "selected@plugins")!.enabled).toBe(true);
  });

  it("ignores unavailable inherited apps that the user has disabled", () => {
    const current = inventory("/project");
    current.plugins.find(plugin => plugin.id === "selected@plugins")!.enabled_by_default = true;
    current.apps.find(app => app.id === "selected-app")!.available = false;
    const inherited = compileAgentConfiguration({ ...definition(), capabilities_mode: "inherit" }, "revision", current, "/project");
    expect(inherited.apps.find(app => app.id === "selected-app")!.enabled).toBe(false);
    expect(() => compileAgentConfiguration(definition(), "revision", current, "/project")).toThrow(/unavailable/);
    expect(() => refreshCompiledAgentConfiguration(inherited, current)).not.toThrow();
  });

  it("preserves disabled plugin children through an editor customization, persistence, and continuation", () => {
    const current = inventory("/project");
    const plugin = current.plugins.find(plugin => plugin.id === "off@plugins")!;
    plugin.bundled_skills[0]!.enabled_by_default = false;
    plugin.bundled_mcp_servers[0]!.enabled_by_default = false;
    current.apps.find(app => app.id === "off-app")!.enabled_by_default = false;
    const inherited = { ...definition(), capabilities_mode: "inherit" as const };
    const edited = replaceAgentCapabilities(inherited, current, "skills", skillRows(inherited, current).map(row => ({ ...row, enabled: false })));
    const persisted = agentDefinitionSchema.parse(JSON.parse(JSON.stringify(edited)));
    const compiled = compileAgentConfiguration(persisted, "revision", current, "/project");
    expect(compiled.skills[0]!.enabled).toBe(false);
    expect(compiled.plugins.find(plugin => plugin.id === "off@plugins")!.bundled_skills[0]!.enabled).toBe(false);
    expect(compiled.mcp_servers.find(server => server.name === "off_mcp")!.enabled).toBe(false);
    expect(compiled.apps.find(app => app.id === "off-app")!.enabled).toBe(false);
    const refreshed = refreshCompiledAgentConfiguration(compiled, current);
    expect(refreshed.mcp_servers).toEqual(compiled.mcp_servers);
    expect(refreshed.apps.map(({ id, enabled }) => ({ id, enabled }))).toEqual(compiled.apps.map(({ id, enabled }) => ({ id, enabled })));
    const missing = structuredClone(persisted);
    missing.plugins.find(plugin => plugin.id === "off@plugins")!.skills = [{ path: "/not-in-plugin/SKILL.md", enabled: true }];
    expect(() => compileAgentConfiguration(missing, "revision", current, "/project")).toThrow(/unavailable/);
  });

  it("compiles a closed allowlist, frozen instructions, and plugin-scoped MCP settings", () => {
    const root = mkdtempSync(join(tmpdir(), "configured-runtime-")); roots.push(root);
    vi.stubEnv("AGENT_CONTROL_HOME", root);
    vi.stubEnv("AGENT_CONTROL_DB", join(root, "isolated.sqlite"));
    const configured = definition();
    configured.plugins = [configured.plugins[1]!, configured.plugins[0]!];
    configured.mcp_servers = [configured.mcp_servers[1]!, configured.mcp_servers[0]!];
    const compiled = compileAgentConfiguration(configured, "catalog-revision", inventory(root), root);
    expect(compiled.developer_instructions).toBe("Inherited sentinel.\n\n<agent-control-definition-instructions>\nDefinition sentinel.\n</agent-control-definition-instructions>");
    expect(compiled.plugins.map(({ id, enabled, required }) => ({ id, enabled, required }))).toEqual([
      { id: "selected@plugins", enabled: true, required: false },
      { id: REQUIRED_AGENT_CONTROL_PLUGIN, enabled: true, required: true },
      { id: "off@plugins", enabled: false, required: false },
      { id: "other-owner@plugins", enabled: false, required: false }
    ]);
    expect(compiled.plugins.find((entry) => entry.id === "selected@plugins")?.bundled_skills)
      .toEqual([{ path: "/selected/SKILL.md", name: "Selected", enabled: true }]);
    expect(compiled.mcp_servers.slice(0, 3).map((entry) => entry.name)).toEqual([
      "standalone_mcp",
      REQUIRED_AGENT_CONTROL_MCP,
      "selected_mcp"
    ]);
    expect(compiled.mcp_servers).toEqual(expect.arrayContaining([
      { name: REQUIRED_AGENT_CONTROL_MCP, enabled: true, plugin_id: REQUIRED_AGENT_CONTROL_PLUGIN },
      { name: "selected_mcp", enabled: true, plugin_id: "selected@plugins", root_transport: true },
      { name: "off_mcp", enabled: false, plugin_id: "off@plugins" },
      { name: "standalone_mcp", enabled: false }
    ]));
    expect(compiled.apps).toEqual(expect.arrayContaining([
      { id: "off-app", name: "Off App", enabled: false, plugin_ids: ["off@plugins"] }
    ]));
    expect(compiled.apps.find((entry) => entry.id === "selected-app")).toEqual({
      id: "selected-app",
      name: "Selected App",
      enabled: true,
      plugin_ids: ["selected@plugins", "other-owner@plugins"]
    });
    expect(compiled.app_server_overrides[0]).toContain('"off@plugins"={"enabled"=false');
    expect(compiled.app_server_overrides[0]).toContain('"agent_control"={"enabled"=true}');
    expect(compiled.app_server_overrides.join("\n")).toContain('"_default"={"enabled"=false}');
    expect(compiled.app_server_overrides.join("\n")).toContain("skills.max_context_tokens=9000");
    const rootMcpOverride = compiled.app_server_overrides.find((entry) => entry.startsWith("mcp_servers="))!;
    expect(rootMcpOverride).not.toContain("agent_control");
    expect(rootMcpOverride).toContain('"selected_mcp"={"enabled"=true}');
    expect(rootMcpOverride).toContain('"off_mcp"={"enabled"=false');
    expect(rootMcpOverride).toContain(JSON.stringify(process.execPath));
  });

  it("disables newly discovered capabilities on continuation and rejects missing enabled capabilities", () => {
    const root = mkdtempSync(join(tmpdir(), "configured-refresh-")); roots.push(root);
    const initial = inventory(root);
    const compiled = compileAgentConfiguration(definition(), "catalog", initial, root);
    const next = inventory(root);
    next.inventory_revision = "inventory-two";
    next.plugins.push({ id: "new@plugins", name: "New", required: false, available: true, enabled_by_default: true,
      bundled_skills: [], bundled_mcp_servers: [{ name: "new_mcp" }], bundled_apps: [] });
    next.plugins.find((entry) => entry.id === "selected@plugins")!.bundled_skills.push({
      path: "/selected/new/SKILL.md",
      name: "New selected bundle skill"
    });
    next.mcp_servers.push({ name: "new_standalone", required: false, available: true, enabled_by_default: true });
    const refreshed = refreshCompiledAgentConfiguration(compiled, next);
    expect(refreshed.plugins.find((entry) => entry.id === "new@plugins")?.enabled).toBe(false);
    expect(refreshed.mcp_servers.find((entry) => entry.name === "new_mcp")?.enabled).toBe(false);
    expect(refreshed.mcp_servers.find((entry) => entry.name === "new_standalone")?.enabled).toBe(false);
    expect(refreshed.skills.find((entry) => entry.path === "/selected/new/SKILL.md"))
      .toEqual({ path: "/selected/new/SKILL.md", enabled: false, plugin_id: "selected@plugins" });
    next.plugins = next.plugins.filter((entry) => entry.id !== "selected@plugins");
    try {
      refreshCompiledAgentConfiguration(compiled, next);
      throw new Error("Expected missing-capability failure");
    } catch (error) {
      expect(error).toMatchObject({ reason: "capability_unavailable" });
    }
  });

  it("validates immutable execution snapshots and verifies singular app/list plus MCP tools before a turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "configured-snapshot-")); roots.push(root);
    const currentInventory = inventory(root);
    const compiled = compileAgentConfiguration(definition(), "catalog", currentInventory, root);
    const snapshot = { ...compiled, execution_agent_id: "execution-agent" };
    const path = join(root, "snapshot.json");
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    const hash = compiledSnapshotHash(snapshot);
    expect(readConfiguredAgentExecutionSnapshot(path, hash, "execution-agent")).toMatchObject({ definition_id: definition().definition_id });
    expect(() => readConfiguredAgentExecutionSnapshot(path, "0".repeat(64), "execution-agent")).toThrow(/changed/);

    const calls: Array<{ method: string; params: any }> = [];
    const config = {
      model: compiled.model,
      model_provider: compiled.model_provider,
      model_reasoning_effort: compiled.reasoning_effort,
      developer_instructions: compiled.developer_instructions,
      skills: { max_context_tokens: 9000, config: compiled.skills },
      plugins: Object.fromEntries(compiled.plugins.map((entry) => [entry.id, {
        enabled: entry.enabled,
        mcp_servers: Object.fromEntries(compiled.mcp_servers.filter((server) => server.plugin_id === entry.id)
          .map((server) => [server.name, { enabled: server.enabled }]))
      }])),
      mcp_servers: Object.fromEntries(compiled.mcp_servers.map((entry) => [entry.name, { enabled: entry.enabled }])),
      apps: Object.fromEntries([["_default", { enabled: false }], ...compiled.apps.map((entry) => [entry.id, { enabled: entry.enabled }])])
    };
    const client = { request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "config/read") return { config };
      if (method === "skills/list") return { data: [{ skills: [
        { path: "/agent-control/SKILL.md", enabled: true },
        { path: "/selected/SKILL.md", enabled: true },
        { path: "/off/SKILL.md", enabled: false },
        { path: "/standalone/SKILL.md", enabled: false }
      ] }] };
      if (method === "plugin/list") return { marketplaces: [{ plugins: compiled.plugins.map((entry) => ({
        id: entry.id, enabled: entry.enabled, availability: "AVAILABLE"
      })) }], nextCursor: null };
      if (method === "mcpServerStatus/list") return { data: compiled.mcp_servers.map((entry) => ({
        name: entry.name,
        authStatus: "unsupported",
        tools: entry.enabled ? entry.name === REQUIRED_AGENT_CONTROL_MCP
          ? { question: { name: "question_ask" }, report: { name: "flow_step_report" } }
          : { one: { name: `${entry.name}_tool` } }
          : {}
      })), nextCursor: null };
      if (method === "app/list") {
        if (params.cursor === "apps-page-two") return { data: [], nextCursor: null };
        return { data: compiled.apps.map((entry) => ({
          id: entry.id, isEnabled: entry.enabled, isAccessible: true
        })), nextCursor: "apps-page-two" };
      }
      throw new Error(`Unexpected method ${method}`);
    } } as any;
    await expect(verifyConfiguredAgentThread(client, compiled, currentInventory, {
      model: "model", modelProvider: "provider", reasoningEffort: "high", thread: { id: "thread" }
    }, "thread", root)).resolves.toBeUndefined();
    expect(calls.some((entry) => entry.method === "app/list")).toBe(true);
    expect(calls.some((entry) => entry.method === "apps/list")).toBe(false);
    expect(calls.filter((entry) => entry.method === "app/list").map((entry) => entry.params.forceRefetch))
      .toEqual([true, false]);
    expect(calls.find((entry) => entry.method === "mcpServerStatus/list")?.params).toMatchObject({
      threadId: "thread", detail: "toolsAndAuthOnly"
    });
    expect(calls.filter((entry) => entry.method === "mcpServerStatus/list")).toHaveLength(2);
  });
});
