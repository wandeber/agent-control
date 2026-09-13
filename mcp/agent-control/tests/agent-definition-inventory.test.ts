import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentDefinitionInventory } from "../src/core/agent-definition-inventory.js";
import { REQUIRED_AGENT_CONTROL_PLUGIN } from "../src/core/agent-definitions.js";
import { AgentDefinitionService } from "../src/agent-definitions.js";

const fixture = vi.hoisted(() => ({ provider: "custom", artworkRoot: "", remotePlugin: false, calls: [] as Array<{ method: string; args: string[]; params?: Record<string, unknown> }> }));
vi.mock("../src/adapters/codex-thread-adapter.js", () => ({
  CodexAppServerClient: class {
    constructor(_url: string, _token: unknown, readonly options: { args: string[] }) {}
    async initialize() {}
    close() {}
    async closeAndWait() {}
    async request(method: string, params?: { marketplaceKinds?: string[]; pluginName?: string; remoteMarketplaceName?: string }) {
      const args = this.options.args;
      fixture.calls.push({ method, args, params });
      const disabled = args.some(arg => arg.startsWith("plugins="));
      switch (method) {
        case "config/read": return { config: { model_provider: fixture.provider, model: "local-alias", plugins: { [REQUIRED_AGENT_CONTROL_PLUGIN]: { enabled: !disabled } }, model_providers: { custom: {} } } };
        case "skills/list": return { data: [{ skills: [{ name: "Control", path: "/fixture/control/SKILL.md", enabled: !disabled }, ...(fixture.artworkRoot ? [{ name: "Illustrated", path: join(fixture.artworkRoot, "skill/SKILL.md"), interface: { iconSmall: join(fixture.artworkRoot, "skill/icon.svg") } }] : [])] }] };
        case "plugin/list": return { marketplaces: [{ name: "agent-control", plugins: [{ id: REQUIRED_AGENT_CONTROL_PLUGIN, name: "agent-control", installed: true, enabled: true, ...(fixture.artworkRoot ? { source: { path: fixture.artworkRoot }, interface: { composerIcon: null, logo: join(fixture.artworkRoot, "missing.svg"), logoDark: null } } : {}) }, ...(params?.marketplaceKinds?.includes("local") ? [{ id: "legacy@old-local", name: "legacy", installed: true, enabled: true }] : [{ id: "legacy@effective-remote", name: "legacy", installed: false, enabled: false }])] }, ...(fixture.remotePlugin ? [{ name: "curated-remote", plugins: [{ id: "app-alias@curated-remote", name: "app-alias", remotePluginId: "plugin_asdk_app_real", installed: true, enabled: false }] }] : [])], nextCursor: null };
        case "plugin/read": if (params?.remoteMarketplaceName === "curated-remote") {
          if (params.pluginName !== "plugin_asdk_app_real") throw new Error("Remote plugin not found");
          return { plugin: { skills: [], mcpServers: [] } };
        }
        return { plugin: { skills: [{ name: "Control", path: "/fixture/control/SKILL.md" }, { name: "Metadata only", path: "/fixture/missing/SKILL.md" }], mcpServers: ["agent_control"] } };
        case "model/list": return { data: [{ model: args.includes('model_provider="openai"') || fixture.provider === "openai" ? "public-model" : "custom-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null };
        default: throw new Error("Unexpected discovery request: " + method);
      }
    }
  }
}));
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); fixture.calls = []; fixture.artworkRoot = ""; fixture.remotePlugin = false; });

describe("configured-agent provider inventory", () => {
  it("resolves remote plugin details using the catalog identifier, including disabled installs", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-inventory-remote-")); roots.push(root);
    vi.stubEnv("CODEX_HOME", root); fixture.remotePlugin = true;
    const inventory = await loadAgentDefinitionInventory(root, true, process.execPath);
    expect(fixture.calls).toContainEqual(expect.objectContaining({ method: "plugin/read", params: {
      pluginName: "plugin_asdk_app_real", remoteMarketplaceName: "curated-remote"
    } }));
    expect(inventory.plugins).toContainEqual(expect.objectContaining({ id: "app-alias@curated-remote", enabled_by_default: false }));
  });

  it("supplies declared plugin and skill artwork to the console without adding image bytes to agent context", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-inventory-icons-")); roots.push(root);
    vi.stubEnv("CODEX_HOME", root); vi.stubEnv("AGENT_CONTROL_HOME", root);
    fixture.artworkRoot = root;
    for (const directory of [".codex-plugin", "skill"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: "agent-control", interface: { composerIcon: "./icon.svg", logoDark: "./dark.svg" } }));
    writeFileSync(join(root, "skill/SKILL.md"), "# Illustrated");
    for (const path of ["icon.svg", "dark.svg", "skill/icon.svg"]) writeFileSync(join(root, path), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    // Use the same qualified fixture executable as the provider discovery tests.
    vi.stubEnv("AGENT_CONTROL_CODEX_CLI_BIN", process.execPath);
    const inventory = await loadAgentDefinitionInventory(root, true, process.execPath);
    expect(inventory.plugins[0]).toMatchObject({ icon_url: expect.stringMatching(/^data:image\/svg\+xml;base64,/), icon_dark_url: expect.stringMatching(/^data:image\/svg\+xml;base64,/) });
    expect(inventory.skills[0]?.icon_url).toMatch(/^data:image\/svg\+xml;base64,/);
    const service = new AgentDefinitionService({} as never);
    expect(JSON.stringify(await service.inventory({ repo_dir: root }))).not.toContain("data:image/");
    expect(JSON.stringify(await service.inventory({ repo_dir: root }, true))).toContain("data:image/");
  });

  it.each(["custom", "openai"])("discovers public defaults with general provider %s without changing capabilities", async provider => {
    const root = mkdtempSync(join(tmpdir(), "agent-inventory-")); roots.push(root);
    vi.stubEnv("CODEX_HOME", root); fixture.provider = provider;
    const inventory = await loadAgentDefinitionInventory(root, true, process.execPath);
    expect(inventory.models).toContainEqual(expect.objectContaining({ id: "public-model", model_provider: "openai", available: true, catalog_available: true }));
    expect(inventory.providers).toContainEqual(expect.objectContaining({ id: "openai", available: true }));
    if (provider === "custom") {
      expect(inventory.models).toContainEqual(expect.objectContaining({ id: "custom-model", model_provider: "custom" }));
      expect(inventory.models).not.toContainEqual(expect.objectContaining({ id: "public-model", model_provider: "custom" }));
    }
    const publicProbe = fixture.calls.filter(call => call.args.includes('model_provider="openai"'));
    expect(publicProbe.map(call => call.method)).toEqual(provider === "custom" ? ["model/list"] : []);
    expect(inventory.plugins[0]!.enabled_by_default).toBe(true);
    expect(inventory.plugins.map(plugin => plugin.id)).toEqual([REQUIRED_AGENT_CONTROL_PLUGIN]);
    expect(inventory.plugins[0]!.bundled_skills).toContainEqual(expect.objectContaining({
      path: "/fixture/missing/SKILL.md", runtime_available: false, enabled_by_default: false
    }));
    expect(inventory.plugins[0]!.bundled_skills).toContainEqual(expect.objectContaining({
      path: "/fixture/control/SKILL.md", runtime_available: true, enabled_by_default: true
    }));
    expect(fixture.calls.filter(call => call.method === "config/write")).toEqual([]);
  });
});
