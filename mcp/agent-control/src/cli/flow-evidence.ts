import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { parseJsonObjectOption, type CliDeps } from "./shared.js";

interface FlowRuntimeCommands {
  updateFlowContext(input: { flowInstanceId: string; context: Record<string, unknown>; expectedRevision: number; agentToken?: string; adminKey?: string }): unknown;
  recordFlowDecision(input: { flowInstanceId: string; key: string; value: unknown; reason: string; expectedRevision: number; artifactKey?: string; artifactDigest?: string; agentToken?: string; adminKey?: string }): unknown;
  executeFlowEvidence(input: { flowInstanceId: string; key: string; request: Record<string, unknown>; stepInstanceId?: string; agentToken?: string; adminKey?: string }): Promise<unknown>;
}

function revision(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Expected a non-negative integer revision.");
  return Number(value);
}

function jsonSource(file: string | undefined, inline: string | undefined, label: string): Record<string, unknown> {
  if (Number(file !== undefined) + Number(inline !== undefined) !== 1) throw new Error(`Provide exactly one --${label}-file or --${label}-json.`);
  return parseJsonObjectOption(file === undefined ? inline! : readFileSync(file, "utf8"));
}

export function registerFlowEvidenceCommands(flow: Command, deps: CliDeps): void {
  const controller = deps.controller as typeof deps.controller & FlowRuntimeCommands;
  flow.command("context-update")
    .description("Persist revised task context with compare-and-swap protection against stale updates.")
    .requiredOption("--flow <id>", "Flow instance id.")
    .requiredOption("--expected-revision <n>", "Current context revision.", revision)
    .option("--context-file <path>", "Read the context JSON object from a file.")
    .option("--context-json <json>", "Context JSON object; prefer a file for larger records.")
    .action((options: { flow: string; expectedRevision: number; contextFile?: string; contextJson?: string }) => {
      deps.output(controller.updateFlowContext({ flowInstanceId: options.flow, expectedRevision: options.expectedRevision,
        context: jsonSource(options.contextFile, options.contextJson, "context"), ...deps.authOptions({ allowStoredAdminKey: true }) }));
    });
  flow.command("decision")
    .description("Record a user decision against the current revision and, when required, the exact artifact digest.")
    .requiredOption("--flow <id>", "Flow instance id.")
    .requiredOption("--key <key>", "Configured decision key.")
    .requiredOption("--value-json <json>", "JSON decision value, such as true or a quoted string.")
    .requiredOption("--reason <text>", "Explicit user decision and its context.")
    .requiredOption("--expected-revision <n>", "Current context revision.", revision)
    .option("--artifact-key <key>", "Artifact to which this decision applies.")
    .option("--artifact-digest <sha256>", "Exact artifact digest displayed for the decision.")
    .action((options: { flow: string; key: string; valueJson: string; reason: string; expectedRevision: number; artifactKey?: string; artifactDigest?: string }) => {
      deps.output(controller.recordFlowDecision({ flowInstanceId: options.flow, key: options.key,
        value: JSON.parse(options.valueJson), reason: options.reason, expectedRevision: options.expectedRevision,
        artifactKey: options.artifactKey, artifactDigest: options.artifactDigest, ...deps.authOptions({ allowStoredAdminKey: true }) }));
    });
  flow.command("evidence")
    .description("Execute a versioned evidence operation and bind its verified receipt to the flow.")
    .requiredOption("--flow <id>", "Flow instance id.")
    .requiredOption("--key <key>", "Evidence binding key used by the flow.")
    .option("--request-file <path>", "Read the evidence operation JSON from a file (recommended).")
    .option("--request-json <json>", "Evidence operation JSON object.")
    .option("--step <id>", "Authoring step instance id.")
    .action(async (options: { flow: string; key: string; requestFile?: string; requestJson?: string; step?: string }) => {
      deps.output(await controller.executeFlowEvidence({ flowInstanceId: options.flow, key: options.key,
        request: jsonSource(options.requestFile, options.requestJson, "request"), stepInstanceId: options.step,
        ...deps.authOptions({ allowStoredAdminKey: true }) }));
    });
}
