import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../src/cli/shared.js";
import { launchWorker, registerWorkerCommands, type WorkerLaunchOptions } from "../src/cli/worker.js";
import type { AgentRecord } from "../src/core/types.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CANONICAL_PROMPT_FILE = resolve(REPOSITORY_ROOT, "flows/development-flow-v1/prompts/analysis.md");
const OUTPUT_ARTIFACT = resolve(tmpdir(), "agent-control-worker-input-handoffs-report.md");

describe("worker launch input handoffs", () => {
  beforeEach(() => { vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "test-admin-key"); vi.stubEnv("CODEX_THREAD_ID", ""); });
  afterEach(() => vi.unstubAllEnvs());
  it("defaults CLI workers to Codex Luna Max without an OpenCode server", async () => {
    const harness = createCliHarness();
    const program = new Command().name("agentctl").exitOverride();
    registerWorkerCommands(program, harness.deps);
    await program.parseAsync([
      "worker", "launch", "--repo", REPOSITORY_ROOT, "--title", "Default worker",
      "--prompt-file", CANONICAL_PROMPT_FILE, "--phase", "analysis",
      "--output-artifact", OUTPUT_ARTIFACT, "--no-watch"
    ], { from: "user" });
    expect(harness.registerAgent).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex-thread", model: "gpt-5.6-luna" }));
    expect(harness.startAgent).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-luna", metadata: { reasoning_effort: "max" }, server: undefined
    }));
  });

  it("preserves explicit Codex model and effort choices", async () => {
    const harness = createCliHarness();
    await launchWorker(createLaunchOptions({ backend: "codex-thread", model: "gpt-5.5", reasoningEffort: "high" }), harness.deps);
    expect(harness.startAgent).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.5", metadata: { reasoning_effort: "high" } }));
  });

  it("rejects Codex reasoning on another backend before registering work", async () => {
    const harness = createCliHarness();
    await expect(launchWorker(createLaunchOptions({ backend: "opencode-server", reasoningEffort: "max" }), harness.deps)).rejects.toThrow(/only supported by codex-thread/);
    expect(harness.registerAgent).not.toHaveBeenCalled();
  });

  it("renders accepted handoffs exactly once as a dedicated JSON block", async () => {
    const harness = createCliHarness();
    const handoffs = [
      {
        label: "accepted_analysis",
        kind: "phase_report",
        payload: {
          verdict: "passed",
          summary: "The agent-facing backend work keeps analysis report-only.",
          plan_revision_id: "HDT-INPUT-HANDOFFS-v4",
          finding_ids: ["FINAL-R3-001"],
          approved_artifact_path: ".tmp/plans/hdt-input-handoffs-v4.md",
          recommended_next_phase: "planning"
        }
      }
    ];

    await launchWorker(
      createLaunchOptions({ inputHandoffsJson: JSON.stringify(handoffs) }),
      harness.deps
    );

    const prompt = harness.startAgent.mock.calls[0]?.[0]?.prompt as string;
    const expectedBlock = ["Input handoffs:", "```json", JSON.stringify(handoffs), "```"].join("\n");
    expect(prompt).toContain(expectedBlock);
    expect(prompt.match(/^Input handoffs:$/gm)).toHaveLength(1);
    expect(harness.registerAgent).toHaveBeenCalledTimes(1);
    expect(harness.startAgent).toHaveBeenCalledTimes(1);
  });

  it("accepts domain words and a loopback application URL without treating them as control metadata", async () => {
    const harness = createCliHarness();
    const handoffs = [
      {
        label: "application_evidence",
        kind: "evidence_summary",
        payload: {
          base_url: "http://localhost:3000/api/health",
          application_url: "ws://127.0.0.1:3000/events",
          monkey: "healthy",
          apikeynote: "The API key decision remains documented.",
          alias_note: "The words apikey and APIKEY appear in documentation without carrying a value.",
          benign_assignment: "Decision context: use the accepted plan.",
          quoted_benign_assignment: "Use \"review note\": complete.",
          findingids: ["FINAL-R3-001"]
        }
      }
    ];

    await launchWorker(createLaunchOptions({ inputHandoffsJson: JSON.stringify(handoffs) }), harness.deps);

    const prompt = harness.startAgent.mock.calls[0]?.[0]?.prompt as string;
    expect(extractInputHandoffsJson(prompt)).toBe(JSON.stringify(handoffs));
    expect(harness.startAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps deeply nested handoffs within the validated compact render size", async () => {
    const harness = createCliHarness();
    let nested: Record<string, unknown> = { result: "passed" };
    for (let index = 0; index < 256; index += 1) {
      nested = { [`layer_${index}`]: nested };
    }
    const handoffs = [{ label: "nested_evidence", kind: "evidence_summary", payload: { evidence: nested } }];
    const compactJson = JSON.stringify(handoffs);
    const prettyJson = JSON.stringify(handoffs, null, 2);

    await launchWorker(createLaunchOptions({ inputHandoffsJson: compactJson }), harness.deps);

    const prompt = harness.startAgent.mock.calls[0]?.[0]?.prompt as string;
    const renderedJson = extractInputHandoffsJson(prompt);
    expect(renderedJson).toBe(compactJson);
    expect(Buffer.byteLength(renderedJson, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(prettyJson, "utf8")).toBeGreaterThan(64 * 1024);
  });

  it("keeps the dispatch prompt byte-for-byte compatible when the option is omitted", async () => {
    const harness = createCliHarness();
    const options = createLaunchOptions();

    await launchWorker(options, harness.deps);

    const prompt = harness.startAgent.mock.calls[0]?.[0]?.prompt as string;
    const expectedPrompt = [
      "# Delegated Worker Dispatch",
      "",
      `Phase: ${options.phase}`,
      `Objective: ${options.objective}`,
      `Repository: ${REPOSITORY_ROOT}`,
      `Output artifact: ${OUTPUT_ARTIFACT}`,
      "",
      "Input artifacts:",
      "- none",
      "",
      "Constraints:",
      "- none",
      "",
      "Attached files:",
      "- none",
      "",
      "Rules:",
      "- Follow the canonical prompt exactly.",
      "- Write the required output artifact before reporting completion.",
      "- Keep in-process status terse.",
      "- Do not assume the coordinator is Codex unless the backend-specific prompt says so.",
      "",
      `Canonical prompt file: ${CANONICAL_PROMPT_FILE}`,
      "",
      "# Canonical Prompt Content",
      "",
      readFileSync(CANONICAL_PROMPT_FILE, "utf8").trimEnd(),
      ""
    ].join("\n");
    expect(prompt).toBe(expectedPrompt);
    expect(prompt).not.toContain("Input handoffs:");
  });

  it("treats --input-handoffs-json '[]' exactly like an omitted option", async () => {
    const emptyHarness = createCliHarness();
    const program = new Command().name("agentctl").exitOverride();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    registerWorkerCommands(program, emptyHarness.deps);

    await program.parseAsync(
      [
        "worker",
        "launch",
        "--backend",
        "test",
        "--repo",
        REPOSITORY_ROOT,
        "--title",
        "Handoff worker",
        "--prompt-file",
        CANONICAL_PROMPT_FILE,
        "--phase",
        "analysis",
        "--objective",
        "Validate compact workflow handoffs.",
        "--output-artifact",
        OUTPUT_ARTIFACT,
        "--no-default-terminal-subscriptions",
        "--input-handoffs-json",
        "[]"
      ],
      { from: "user" }
    );

    const omittedHarness = createCliHarness();
    await launchWorker(createLaunchOptions(), omittedHarness.deps);
    const emptyPrompt = emptyHarness.startAgent.mock.calls[0]?.[0]?.prompt as string;
    const omittedPrompt = omittedHarness.startAgent.mock.calls[0]?.[0]?.prompt as string;
    expect(emptyPrompt).toBe(omittedPrompt);
    expect(emptyPrompt).not.toContain("Input handoffs:");
  });

  it("rejects a repeated CLI option before launching a worker", async () => {
    const harness = createCliHarness();
    const program = new Command().name("agentctl").exitOverride();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    registerWorkerCommands(program, harness.deps);

    await expect(
      program.parseAsync(
        [
          "worker",
          "launch",
          "--backend",
          "test",
          "--repo",
          REPOSITORY_ROOT,
          "--title",
          "Handoff worker",
          "--prompt-file",
          CANONICAL_PROMPT_FILE,
          "--phase",
          "analysis",
          "--output-artifact",
          OUTPUT_ARTIFACT,
          "--input-handoffs-json",
          "[]",
          "--input-handoffs-json",
          "[]"
        ],
        { from: "user" }
      )
    ).rejects.toThrow("--input-handoffs-json may be provided at most once.");
    expect(harness.registerAgent).not.toHaveBeenCalled();
    expect(harness.startAgent).not.toHaveBeenCalled();
  });

  it("treats payload contents as opaque caller-owned JSON", async () => {
    const harness = createCliHarness();
    const handoffs = [
      {
        label: "caller_owned_context",
        kind: "phase_report",
        payload: {
          execution_ref: "execution-1",
          controller: { connection: { reference: "controller-1" } },
          credentials: { api_token: "caller-owned-value" },
          transcript: ["caller-owned-message"],
          reasoning_trace: ["caller-owned-note"],
          summary: "Use http://worker:caller-owned@example.com and stdio:// transport."
        }
      }
    ];

    await launchWorker(createLaunchOptions({ inputHandoffsJson: JSON.stringify(handoffs) }), harness.deps);

    const prompt = harness.startAgent.mock.calls[0]?.[0]?.prompt as string;
    expect(extractInputHandoffsJson(prompt)).toBe(JSON.stringify(handoffs));
    expect(harness.startAgent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-array envelope", "{}"],
    [
      "more than sixteen entries",
      JSON.stringify(
        Array.from({ length: 17 }, (_, index) => ({ label: `handoff_${index}`, kind: "phase_report", payload: {} }))
      )
    ],
    ["an invalid label", JSON.stringify([{ label: "Accepted Analysis", kind: "phase_report", payload: {} }])],
    ["an invalid kind", JSON.stringify([{ label: "accepted_analysis", kind: "Phase Report", payload: {} }])],
    [
      "duplicate labels",
      JSON.stringify([
        { label: "accepted_analysis", kind: "phase_report", payload: {} },
        { label: "accepted_analysis", kind: "evidence_summary", payload: {} }
      ])
    ],
    ["a non-object payload", JSON.stringify([{ label: "accepted_analysis", kind: "phase_report", payload: [] }])],
    [
      "an unexpected envelope field",
      JSON.stringify([{ label: "accepted_analysis", kind: "phase_report", payload: {}, execution_ref: "extra" }])
    ],
    [
      "an oversized payload",
      JSON.stringify([{ label: "accepted_analysis", kind: "phase_report", payload: { summary: "x".repeat(16 * 1024) } }])
    ],
    [
      "an oversized collection",
      JSON.stringify(
        Array.from({ length: 5 }, (_, index) => ({
          label: `handoff_${index}`,
          kind: "evidence_summary",
          payload: { summary: "x".repeat(13 * 1024) }
        }))
      )
    ],
    [
      "a non-finite JSON number",
      '[{"label":"accepted_analysis","kind":"phase_report","payload":{"confidence":1e400}}]'
    ]
  ])("rejects structurally invalid or unrenderable %s before registration or backend start", async (_description, inputHandoffsJson) => {
    const harness = createCliHarness();

    await expect(launchWorker(createLaunchOptions({ inputHandoffsJson }), harness.deps)).rejects.toThrow();
    expect(harness.authOptions).not.toHaveBeenCalled();
    expect(harness.registerAgent).not.toHaveBeenCalled();
    expect(harness.startAgent).not.toHaveBeenCalled();
  });
});

function extractInputHandoffsJson(prompt: string): string {
  const prefix = "Input handoffs:\n```json\n";
  const start = prompt.indexOf(prefix);
  if (start < 0) {
    throw new Error("Input handoffs block not found.");
  }
  const contentStart = start + prefix.length;
  const contentEnd = prompt.indexOf("\n```", contentStart);
  if (contentEnd < 0) {
    throw new Error("Input handoffs block is not terminated.");
  }
  return prompt.slice(contentStart, contentEnd);
}

function createLaunchOptions(overrides: Partial<WorkerLaunchOptions> = {}): WorkerLaunchOptions {
  return {
    backend: "test",
    repo: REPOSITORY_ROOT,
    title: "Handoff worker",
    promptFile: CANONICAL_PROMPT_FILE,
    phase: "analysis",
    objective: "Validate compact workflow handoffs.",
    outputArtifact: OUTPUT_ARTIFACT,
    startTimeoutMs: 1_000,
    inputArtifact: [],
    constraint: [],
    expectArtifact: [],
    file: [],
    subscribeEvent: [],
    defaultTerminalSubscriptions: false,
    subscriberAgentId: [],
    watch: false,
    watchIntervalMs: 5_000,
    ...overrides
  };
}

function createCliHarness(): {
  deps: CliDeps;
  authOptions: ReturnType<typeof vi.fn>;
  registerAgent: ReturnType<typeof vi.fn>;
  startAgent: ReturnType<typeof vi.fn>;
} {
  const now = "2026-07-17T00:00:00.000Z";
  const agent: AgentRecord = {
    agent_id: "agent_handoff_test",
    run_id: "run_handoff_test",
    backend: "test",
    title: "Handoff worker",
    role: "analysis",
    objective: "Validate compact workflow handoffs.",
    repo_dir: REPOSITORY_ROOT,
    model: null,
    backend_handle: null,
    work_generation: 0,
    work_revision: 0,
    status: "queued",
    failure_reason: null,
    unregistered_at: null,
    created_at: now,
    updated_at: now
  };
  const authOptions = vi.fn(() => ({ adminKey: "test-admin-key" }));
  const registerAgent = vi.fn(() => agent);
  const startAgent = vi.fn(async () => ({ ...agent, status: "running" as const }));
  const controller = {
    orchestratorLogin: vi.fn(() => ({ run: { run_id: agent.run_id }, agent: { ...agent, agent_id: "owner" }, agent_token: "owner-token" })),
    originalRequesterThread: vi.fn(() => undefined),
    ensureRequester: vi.fn(() => ({ observer_agent_id: "observer_handoff_test", run_id: agent.run_id })),
    createRun: vi.fn(() => ({ run_id: agent.run_id })),
    registerAgent,
    createArtifact: vi.fn(() => ({
      artifact_id: "artifact_handoff_test",
      run_id: agent.run_id,
      agent_id: agent.agent_id,
      label: "analysis-output",
      path: OUTPUT_ARTIFACT,
      expected: true,
      created_at: now,
      updated_at: now
    })),
    startAgent,
    agentPurge: vi.fn(async () => ({ purged: true }))
  } as unknown as CliDeps["controller"];

  return {
    deps: { controller, authOptions, output: vi.fn() },
    authOptions,
    registerAgent,
    startAgent
  };
}
