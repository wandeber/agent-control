import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDefinitionService, assertCatalogMutationAuthority } from "../src/agent-definitions.js";
import {
  AgentDefinitionCatalog,
  REQUIRED_AGENT_CONTROL_MCP,
  REQUIRED_AGENT_CONTROL_PLUGIN,
  type AgentDefinitionEditable
} from "../src/core/agent-definitions.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function catalog(): AgentDefinitionCatalog {
  const root = mkdtempSync(join(tmpdir(), "agent-definitions-"));
  roots.push(root);
  return new AgentDefinitionCatalog(join(root, "agents", "catalog.json"));
}

function editable(name: string): AgentDefinitionEditable {
  return {
    name,
    description: "A reusable agent",
    instructions: "Follow the definition sentinel.",
    model: "configured-model",
    model_provider: "configured-provider",
    reasoning_effort: "high",
    skills_catalog_token_budget: 8000,
    plugins: [
      { id: "optional@example", enabled: true },
      { id: REQUIRED_AGENT_CONTROL_PLUGIN, enabled: false }
    ],
    skills: [
      { path: "/skills/second/SKILL.md", enabled: false },
      { path: "/skills/first/SKILL.md", enabled: true }
    ],
    mcp_servers: [
      { name: "optional", enabled: false },
      { name: REQUIRED_AGENT_CONTROL_MCP, enabled: false }
    ]
  };
}

describe("personal configured-agent catalog", () => {
  it("uses deterministic empty bytes and preserves ordered definitions and capabilities", () => {
    const store = catalog();
    const empty = store.list();
    const bytes = Buffer.from(`${JSON.stringify({ schema_version: 1, agents: [] }, null, 2)}\n`);
    expect(empty).toEqual({ schema_version: 1, agents: [], revision: createHash("sha256").update(bytes).digest("hex") });

    const first = store.configure({ operation: "create", expected_revision: empty.revision, patch: editable("  First   Agent  ") });
    expect(first.definition.name).toBe("First Agent");
    expect(first.definition.plugins.map((entry) => entry.id)).toEqual(["optional@example", REQUIRED_AGENT_CONTROL_PLUGIN]);
    expect(first.definition.plugins.at(-1)).toEqual({ id: REQUIRED_AGENT_CONTROL_PLUGIN, enabled: true });
    expect(first.definition.mcp_servers.at(-1)).toEqual({ name: REQUIRED_AGENT_CONTROL_MCP, enabled: true });
    expect(first.definition.skills.map((entry) => entry.path)).toEqual(["/skills/second/SKILL.md", "/skills/first/SKILL.md"]);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);

    const second = store.configure({ operation: "create", expected_revision: first.revision, patch: editable("Second") });
    const moved = store.configure({ operation: "update", expected_revision: second.revision,
      definition_id: second.definition.definition_id, position: 0,
      patch: { skills_catalog_token_budget: null, skills: [{ path: "/replacement/SKILL.md", enabled: false }] } });
    expect(moved.agents.map((entry) => entry.name)).toEqual(["Second", "First Agent"]);
    expect(moved.definition.skills_catalog_token_budget).toBeUndefined();
    expect(moved.definition.skills).toEqual([{ path: "/replacement/SKILL.md", enabled: false }]);

    const duplicated = store.configure({ operation: "duplicate", expected_revision: moved.revision,
      source_id: moved.definition.definition_id, patch: { name: "Second copy" } });
    expect(duplicated.agents.map((entry) => entry.name)).toEqual(["Second", "Second copy", "First Agent"]);
    expect(duplicated.definition.definition_id).not.toBe(moved.definition.definition_id);
    expect(duplicated.definition.created_at).toBe(duplicated.definition.updated_at);
  });

  it("rejects normalized duplicate names, stale writers, invalid budgets, and invalid existing bytes without overwriting", () => {
    const store = catalog();
    const empty = store.list();
    const first = store.configure({ operation: "create", expected_revision: empty.revision, patch: editable("Café Agent") });
    expect(() => store.configure({ operation: "create", expected_revision: first.revision,
      patch: editable("  Cafe\u0301   Agent ") })).toThrow(/already exists/);
    try {
      store.configure({ operation: "update", expected_revision: empty.revision,
        definition_id: first.definition.definition_id, patch: { description: "stale" } });
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toMatchObject({ reason: "conflict", details: { current_revision: first.revision } });
    }
    expect(() => store.configure({ operation: "update", expected_revision: first.revision,
      definition_id: first.definition.definition_id, patch: { skills_catalog_token_budget: 10001 } })).toThrow(/invalid/i);
    const invalid = Buffer.from('{"schema_version":2,"agents":[]}\n');
    writeFileSync(store.path, invalid);
    expect(() => store.configure({ operation: "create", expected_revision: first.revision, patch: editable("Other") })).toThrow(/left unchanged/);
    expect(readFileSync(store.path)).toEqual(invalid);
  });

  it("rejects worker credentials and managed threads before local-admin or trusted capability fallback", () => {
    const unmanaged = { listAgents: () => [] } as any;
    try {
      assertCatalogMutationAuthority(unmanaged, {
        agentToken: "worker-token", adminKey: "also-present", trustedCatalogCapability: true
      });
      throw new Error("Expected worker-token rejection");
    } catch (error) {
      expect(error).toMatchObject({ reason: "auth_required" });
    }
    const managed = { listAgents: () => [{ backend: "codex-thread", backend_handle: { thread_id: "managed" },
      role: "worker", work_generation: 1, unregistered_at: null }] } as any;
    try {
      assertCatalogMutationAuthority(managed, {
        currentThreadId: "managed", trustedCatalogCapability: true
      });
      throw new Error("Expected managed-thread rejection");
    } catch (error) {
      expect(error).toMatchObject({ reason: "auth_required" });
    }
    expect(() => assertCatalogMutationAuthority(unmanaged, { trustedCatalogCapability: true })).not.toThrow();

    const store = catalog();
    const service = new AgentDefinitionService(unmanaged, store);
    try {
      service.configure({ operation: "create", expected_revision: store.list().revision, patch: editable("Blocked") }, {
        agentToken: "worker-token", trustedCatalogCapability: true
      });
      throw new Error("Expected service worker-token rejection");
    } catch (error) {
      expect(error).toMatchObject({ reason: "auth_required" });
    }
  });

  it("preserves the current catalog when its atomic replacement cannot be written", () => {
    const store = catalog();
    const first = store.configure({
      operation: "create",
      expected_revision: store.list().revision,
      patch: editable("Durable")
    });
    const before = readFileSync(store.path);
    const directory = dirname(store.path);
    chmodSync(directory, 0o500);
    try {
      expect(() => store.configure({
        operation: "update",
        expected_revision: first.revision,
        definition_id: first.definition.definition_id,
        patch: { description: "must not persist" }
      })).toThrow();
    } finally {
      chmodSync(directory, 0o700);
    }
    expect(readFileSync(store.path)).toEqual(before);
  });

  it("serializes independent process writers and lets exactly one stale revision win", async () => {
    const store = catalog();
    const revision = store.list().revision;
    const modulePath = resolve("src/core/agent-definitions.ts");
    const run = (name: string) => new Promise<any>((resolveResult, reject) => {
      const code = `import { AgentDefinitionCatalog } from ${JSON.stringify(modulePath)};
const store = new AgentDefinitionCatalog(${JSON.stringify(store.path)});
try { const result = store.configure({operation:"create",expected_revision:${JSON.stringify(revision)},patch:${JSON.stringify(editable(name))}}); console.log(JSON.stringify({ok:true,revision:result.revision})); }
catch (error) { console.log(JSON.stringify({ok:false,reason:error.reason,details:error.details})); }`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (status) => status === 0
        ? resolveResult(JSON.parse(stdout.trim()))
        : reject(new Error(stderr || `writer exited ${status}`)));
    });
    const results = await Promise.all([run("Writer A"), run("Writer B")]);
    expect(results.filter((entry) => entry.ok)).toHaveLength(1);
    expect(results.filter((entry) => !entry.ok)).toEqual([
      expect.objectContaining({ reason: "conflict", details: { current_revision: expect.any(String) } })
    ]);
    expect(store.list().agents).toHaveLength(1);
  }, 15_000);
});
