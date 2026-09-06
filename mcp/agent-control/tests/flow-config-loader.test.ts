import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandEnvironmentReferences,
  loadFlowConfigFile,
  parseFlowConfigText
} from "../src/core/flow-config-loader.js";
import { parseFlowConfig, resolveFlowAgentLifecycle } from "../src/core/flow.js";
import { flowConfigJsonSchema } from "../src/core/flow-config-schema.js";

describe("flow config loader", () => {
  it("loads role-specific Codex defaults while keeping discovery separate from analysis", () => {
    for (const name of ["development-flow-v1", "demo-age-duration"]) {
      const config = parseFlowConfig(loadFlowConfigFile(resolve(import.meta.dirname, "../../../flows", name, "flow.yaml"), { env: {} }));
      for (const [role, settings] of Object.entries(config.roles ?? {})) {
        if (role === "orchestrator") continue;
        expect(settings.backend).toBe("codex-thread");
        if (role === "final_reviewer") {
          expect(settings.model).toBe("gpt-5.6-sol");
          expect(settings.reasoning_effort).toBe("xhigh");
        } else if (name === "development-flow-v1" && role === "analyst") {
          expect(settings.model).toBe("gpt-6-astra");
          expect(settings.reasoning_effort).toBe("xhigh");
        } else {
          expect(settings.model).toBe("gpt-5.6-luna");
          expect(settings.reasoning_effort).toBe("max");
        }
      }
    }
  });

  it("keeps native inheritance available by clearing both Codex overrides", () => {
    const path = resolve(import.meta.dirname, "../../../flows/development-flow-v1/flow.yaml");
    const env = { DEVFLOW_ANALYST_BACKEND: "codex-subagent", DEVFLOW_ANALYST_MODEL: "", DEVFLOW_ANALYST_REASONING_EFFORT: "" };
    expect(parseFlowConfig(loadFlowConfigFile(path, { env })).roles?.analyst).toMatchObject({ backend: "codex-subagent", model: undefined, reasoning_effort: "" });
    expect(() => parseFlowConfig(loadFlowConfigFile(path, { env: { ...env, DEVFLOW_ANALYST_REASONING_EFFORT: "max" } }))).toThrow(/reasoning_effort is only supported/);
  });

  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "flow-config-loader-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses YAML flow configs and expands env references with defaults", () => {
    const config = parseFlowConfigText(
      `
id: env-flow
initial_step: analysis
roles:
  analyst:
    backend: \${DEVFLOW_ANALYST_BACKEND:-opencode-server}
    model: \${DEVFLOW_ANALYST_MODEL:-opencode-go/deepseek-v4-pro}
steps:
  analysis:
    role: analyst
`,
      {
        format: "yaml",
        env: {
          DEVFLOW_ANALYST_BACKEND: "",
          DEVFLOW_ANALYST_MODEL: "custom/model"
        }
      }
    );

    expect(config).toMatchObject({
      id: "env-flow",
      initial_step: "analysis",
      roles: {
        analyst: {
          backend: "opencode-server",
          model: "custom/model"
        }
      }
    });
  });

  it("parses JSON flow configs from files", () => {
    const path = join(tmp, "flow.json");
    writeFileSync(path, JSON.stringify({ id: "json-flow", initial_step: "one", steps: { one: {} } }), "utf8");

    expect(loadFlowConfigFile(path)).toMatchObject({
      id: "json-flow",
      initial_step: "one"
    });
  });

  it("validates prompt file references relative to config files", () => {
    const promptsDir = join(tmp, "prompts");
    const flowPath = join(tmp, "flow.yaml");
    writeFileSync(join(tmp, "placeholder"), "", "utf8");
    writeFileSync(flowPath, "id: prompted\ninitial_step: one\nprompts:\n  one_prompt:\n    path: prompts/one.md\nsteps:\n  one:\n    prompt_ref: one_prompt\n", "utf8");

    expect(() => loadFlowConfigFile(flowPath)).toThrow(/missing prompt files/);

    mkdirSync(promptsDir);
    writeFileSync(join(promptsDir, "one.md"), "# One\n", "utf8");

    expect(loadFlowConfigFile(flowPath)).toMatchObject({
      id: "prompted",
      prompts: {
        one_prompt: {
          path: join(promptsDir, "one.md")
        }
      }
    });
  });

  it("supports shell-style dash defaults for undefined variables only", () => {
    const expanded = expandEnvironmentReferences(
      {
        unset: "${UNSET-default}",
        empty: "${EMPTY-default}"
      },
      { EMPTY: "" }
    );

    expect(expanded).toEqual({
      unset: "default",
      empty: ""
    });
  });

  it("throws when an env reference has no value or default", () => {
    expect(() => expandEnvironmentReferences("${MISSING}", {})).toThrow(/MISSING/);
  });

  it("parses fresh role lifecycle declarations while omitted roles keep reuse semantics", () => {
    const config = parseFlowConfigText(
      `
id: lifecycle-flow
initial_step: analysis
roles:
  analyst:
    backend: fake
  final_reviewer:
    backend: codex-thread
    agent_lifecycle: fresh_per_step
steps:
  analysis:
    role: analyst
`,
      { format: "yaml" }
    );

    expect(config.roles?.final_reviewer?.agent_lifecycle).toBe("fresh_per_step");
    expect(resolveFlowAgentLifecycle(config.roles?.analyst?.agent_lifecycle)).toBe("reuse");
    expect(flowConfigJsonSchema.$defs.promptOwner.properties.agent_lifecycle).toEqual({
      type: "string",
      enum: ["reuse", "fresh_per_step"],
      default: "reuse"
    });
  });

  it("keeps one bundled independent reviewer across correction iterations", () => {
    const flowPaths = [
      "../../flows/development-flow-v1/flow.yaml",
      "../../flows/demo-age-duration/flow.yaml"
    ];

    for (const flowPath of flowPaths) {
      const config = loadFlowConfigFile(resolve(process.cwd(), flowPath));
      expect(config.roles?.final_reviewer?.agent_lifecycle).toBe("reuse");
    }
  });

  it("rejects unsupported role lifecycle values", () => {
    expect(() =>
      parseFlowConfig(
        parseFlowConfigText(
          `
id: invalid-lifecycle
initial_step: review
roles:
  reviewer:
    backend: fake
    agent_lifecycle: sometimes_fresh
steps:
  review:
    role: reviewer
`,
          { format: "yaml" }
        )
      )
    ).toThrow(/Invalid flow config/);
  });

  it("rejects persistent agent ids on fresh-per-step roles", () => {
    expect(() =>
      parseFlowConfig(
        parseFlowConfigText(
          `
id: contradictory-lifecycle
initial_step: review
roles:
  reviewer:
    backend: fake
    agent_lifecycle: fresh_per_step
steps:
  review:
    role: reviewer
    agent_id: agent_persistent
`,
          { format: "yaml" }
        )
      )
    ).toThrow(/fresh_per_step role cannot use a persistent step agent_id/);
  });
});
