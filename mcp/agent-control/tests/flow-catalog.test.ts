import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createController } from "../src/core/factory.js";
import {
  getFlowFromCatalog,
  listFlowCatalog,
  resolveDefaultFlowCatalogRoot,
  type FlowCatalogDescriptor
} from "../src/core/flow-catalog.js";

describe("flow catalog", () => {
  let tmp: string;
  let catalog: FlowCatalogDescriptor;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "flow-catalog-test-"));
    const root = join(tmp, "flows");
    const flowDir = join(root, "sample-flow");
    mkdirSync(join(flowDir, "prompts"), { recursive: true });
    writeFileSync(join(flowDir, "prompts", "one.md"), "# One\n", "utf8");
    writeFileSync(
      join(flowDir, "flow.yaml"),
      [
        "id: sample-flow",
        "version: 1.2.3",
        "description: Sample catalog flow",
        "initial_step: one",
        "prompts:",
        "  one_prompt:",
        "    path: prompts/one.md",
        "steps:",
        "  one:",
        "    prompt_ref: one_prompt"
      ].join("\n"),
      "utf8"
    );
    catalog = {
      catalog_id: "test-flows",
      name: "Test flows",
      root_path: root,
      exists: true
    };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists flow summaries from a catalog directory", () => {
    const result = listFlowCatalog({ catalogs: [catalog] });

    expect(result.catalogs).toEqual([catalog]);
    expect(result.flows).toMatchObject([
      {
        catalog_id: "test-flows",
        flow_id: "sample-flow",
        version: "1.2.3",
        description: "Sample catalog flow",
        directory_name: "sample-flow",
        valid: true,
        error: null
      }
    ]);
  });

  it("resolves one flow by id and returns the loaded config", () => {
    const result = getFlowFromCatalog({ flowId: "sample-flow", catalogs: [catalog] });

    expect(result.config).toMatchObject({
      id: "sample-flow",
      prompts: {
        one_prompt: {
          path: join(catalog.root_path, "sample-flow", "prompts", "one.md")
        }
      }
    });
  });

  it("exposes the repository-level flows catalog through the controller", () => {
    const { controller, store } = createController(":memory:");
    try {
      const result = controller.listFlowCatalog({ query: "development-flow-v1" });
      expect(result.catalogs[0]).toMatchObject({
        catalog_id: "repo-flows",
        exists: true
      });
      expect(result.flows.some((flow) => flow.flow_id === "development-flow-v1")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("prefers an explicit flow catalog directory from the environment", () => {
    const explicit = join(tmp, "explicit-flows");
    mkdirSync(explicit);

    expect(
      resolveDefaultFlowCatalogRoot({
        basePath: join(tmp, "agent-control", "mcp", "agent-control", "dist", "core"),
        env: { AGENT_CONTROL_FLOW_CATALOG_DIR: explicit }
      })
    ).toBe(explicit);
  });

  it("finds marketplace-root flows when running from a plugin cache path", () => {
    const codexRoot = join(tmp, ".codex");
    const marketplaceFlows = join(codexRoot, ".tmp", "marketplaces", "agent-control", "flows");
    const cacheBase = join(
      codexRoot,
      "plugins",
      "cache",
      "agent-control",
      "agent-control",
      "0.1.0",
      "mcp",
      "agent-control",
      "dist",
      "core"
    );
    mkdirSync(marketplaceFlows, { recursive: true });
    mkdirSync(cacheBase, { recursive: true });

    expect(resolveDefaultFlowCatalogRoot({ basePath: cacheBase, env: {} })).toBe(marketplaceFlows);
  });

  it("prefers cache-root flows when the plugin cache includes them", () => {
    const codexRoot = join(tmp, ".codex");
    const cacheFlows = join(codexRoot, "plugins", "cache", "agent-control", "flows");
    const marketplaceFlows = join(codexRoot, ".tmp", "marketplaces", "agent-control", "flows");
    const cacheBase = join(
      codexRoot,
      "plugins",
      "cache",
      "agent-control",
      "agent-control",
      "0.1.0",
      "mcp",
      "agent-control",
      "dist",
      "core"
    );
    mkdirSync(cacheFlows, { recursive: true });
    mkdirSync(marketplaceFlows, { recursive: true });
    mkdirSync(cacheBase, { recursive: true });

    expect(resolveDefaultFlowCatalogRoot({ basePath: cacheBase, env: {} })).toBe(cacheFlows);
  });
});
