import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentDefinitionInventory } from "../src/core/agent-definition-inventory.js";
import { REQUIRED_AGENT_CONTROL_PLUGIN } from "../src/core/agent-definitions.js";
import { AgentDefinitionService } from "../src/agent-definitions.js";

const fixture = vi.hoisted(() => ({ provider: "custom", artworkRoot: "", calls: [] as Array<{ method: string; args: string[] }> }));
vi.mock("../src/adapters/codex-thread-adapter.js", () => ({
  CodexAppServerClient: class {
    constructor(_url: string, _token: unknown, readonly options: { args: string[] }) {}
    async initialize() {}
    close() {}
    async closeAndWait() {}
    async request(method: string) {
      const args = this.options.args;
      fixture.calls.push({ method, args });
      const disabled = args.some(arg => arg.startsWith("plugins="));
      switch (method) {
        case "config/read": return { config: { model_provider: fixture.provider, model: "local-alias", plugins: { [REQUIRED_AGENT_CONTROL_PLUGIN]: { enabled: !disabled } }, model_providers: { custom: {} } } };
        case "skills/list": return { data: [{ skills: [{ name: "Control", path: "/fixture/control/SKILL.md", enabled: !disabled }, ...(fixture.artworkRoot ? [{ name: "Illustrated", path: join(fixture.artworkRoot, "skill/SKILL.md"), interface: { iconSmall: join(fixture.artworkRoot, "skill/icon.svg") } }] : [])] }] };
        case "plugin/list": return { marketplaces: [{ name: "agent-control", plugins: [{ id: REQUIRED_AGENT_CONTROL_PLUGIN, name: "agent-control", installed: true, enabled: true, ...(fixture.artworkRoot ? { source: { path: fixture.artworkRoot }, interface: { composerIcon: null, logo: join(fixture.artworkRoot, "missing.svg"), logoDark: null } } : {}) }] }], nextCursor: null };
        case "plugin/read": return { plugin: { skills: [{ name: "Control", path: "/fixture/control/SKILL.md" }], mcpServers: ["agent_control"] } };
        case "model/list": return { data: [{ model: args.includes('model_provider="openai"') || fixture.provider === "openai" ? "public-model" : "custom-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null };
        default: throw new Error("Unexpected discovery request: " + method);
      }
    }
  }
}));
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); fixture.calls = []; fixture.artworkRoot = ""; });

describe("configured-agent provider inventory", () => {
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
    expect(fixture.calls.filter(call => call.method === "config/write")).toEqual([]);
  });
});
