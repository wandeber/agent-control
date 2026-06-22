import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandEnvironmentReferences,
  loadFlowConfigFile,
  parseFlowConfigText
} from "../src/core/flow-config-loader.js";

describe("flow config loader", () => {
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
});
