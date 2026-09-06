import { readFileSync } from "node:fs";
import { parseJsonObjectOption } from "./shared.js";
function revision(value) {
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error("Expected a non-negative integer revision.");
    return Number(value);
}
function jsonSource(file, inline, label) {
    if (Number(file !== undefined) + Number(inline !== undefined) !== 1)
        throw new Error(`Provide exactly one --${label}-file or --${label}-json.`);
    return parseJsonObjectOption(file === undefined ? inline : readFileSync(file, "utf8"));
}
function acceptedContext(options) {
    if ([options.context, options.contextFile, options.contextJson].filter(value => value !== undefined).length !== 1) {
        throw new Error("Provide exactly one --context, --context-file or --context-json.");
    }
    const context = options.contextFile !== undefined ? readFileSync(options.contextFile, "utf8")
        : options.contextJson !== undefined ? (() => {
            const value = JSON.parse(options.contextJson);
            return typeof value === "string" ? value : JSON.stringify(value);
        })() : options.context;
    if (!context.trim())
        throw new Error("The complete accepted task contract must not be empty.");
    return context;
}
export function registerFlowEvidenceCommands(flow, deps) {
    const controller = deps.controller;
    flow.command("packages")
        .description("Manage approved package manifests, parallel workers, immutable deliveries and verified joins.")
        .requiredOption("--flow-instance-id <id>", "Flow instance id.")
        .option("--request-file <path>", "Read a structured package operation from JSON.")
        .option("--request-json <json>", "Structured package operation JSON.")
        .action(async (options) => {
        deps.output(await controller.executeFlowPackages({ flowInstanceId: options.flowInstanceId, request: jsonSource(options.requestFile, options.requestJson, "request"), ...deps.authOptions({ allowStoredAdminKey: true }) }));
    });
    flow.command("recover-owner")
        .description("Replace a stopped or detached pinned role owner and restart its configured step with a fresh full-review requirement.")
        .requiredOption("--flow <id>", "Flow instance id.")
        .requiredOption("--role <role>", "Exact configured role whose owner is unavailable.")
        .requiredOption("--restart-step <id>", "Configured step owned by this role to restart.")
        .requiredOption("--reason <text>", "Explicit reason for replacing the previous owner.")
        .requiredOption("--expected-revision <n>", "Current flow runtime revision.", revision)
        .action((options) => {
        deps.output(controller.recoverFlowOwner({ flowInstanceId: options.flow, role: options.role,
            restartStepId: options.restartStep, reason: options.reason, expectedRevision: options.expectedRevision,
            ...deps.authOptions({ allowStoredAdminKey: true }) }));
    });
    flow.command("context-update")
        .description("Replace the complete current accepted task contract with compare-and-swap protection; previous revisions remain in history.")
        .requiredOption("--flow <id>", "Flow instance id.")
        .requiredOption("--expected-revision <n>", "Current context revision.", revision)
        .option("--context <text>", "Complete accepted task contract, including requirements that remain unchanged.")
        .option("--context-file <path>", "Read the complete accepted task contract as UTF-8 text.")
        .option("--context-json <json>", "Complete contract encoded as JSON; converted to text for the runtime.")
        .action((options) => {
        deps.output(controller.updateFlowContext({ flowInstanceId: options.flow, expectedRevision: options.expectedRevision,
            context: acceptedContext(options), ...deps.authOptions({ allowStoredAdminKey: true }) }));
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
        .option("--package-manifest-digest <sha256>", "Exact package manifest digest shown with the approved plan.")
        .action((options) => {
        deps.output(controller.recordFlowDecision({ flowInstanceId: options.flow, key: options.key,
            value: JSON.parse(options.valueJson), reason: options.reason, expectedRevision: options.expectedRevision,
            artifactKey: options.artifactKey, artifactDigest: options.artifactDigest, packageManifestDigest: options.packageManifestDigest, ...deps.authOptions({ allowStoredAdminKey: true }) }));
    });
    flow.command("evidence")
        .description("Execute a versioned evidence operation and bind its verified receipt to the flow.")
        .requiredOption("--flow <id>", "Flow instance id.")
        .requiredOption("--key <key>", "Evidence binding key used by the flow.")
        .option("--request-file <path>", "Read the evidence operation JSON from a file (recommended).")
        .option("--request-json <json>", "Evidence operation JSON object.")
        .option("--step <id>", "Authoring step instance id.")
        .action(async (options) => {
        deps.output(await controller.executeFlowEvidence({ flowInstanceId: options.flow, key: options.key,
            request: jsonSource(options.requestFile, options.requestJson, "request"), stepInstanceId: options.step,
            ...deps.authOptions({ allowStoredAdminKey: true }) }));
    });
}
