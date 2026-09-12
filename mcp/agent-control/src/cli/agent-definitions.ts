import type { Command } from "commander";
import { AgentDefinitionService } from "../agent-definitions.js";
import type { ConfigureAgentDefinitionInput } from "../core/agent-definitions.js";
import type { CliDeps } from "./shared.js";
import { collect, parseJsonObjectOption } from "./shared.js";
import { addRequesterOptions, type RequesterOptions } from "./observation.js";
import type { EventType } from "../core/types.js";

export function registerAgentDefinitionCommands(program: Command, deps: CliDeps): void {
  const command = program.command("agent-definition").description("Manage reusable personal agent definitions.");
  const service = new AgentDefinitionService(deps.controller);

  command.command("list")
    .description("List the ordered catalog and revision.")
    .action(() => deps.output(service.list()));

  command.command("get")
    .description("Get a definition by id or name.")
    .option("--definition-id <id>", "Definition id.")
    .option("--name <name>", "Exact definition name.")
    .action((options: { definitionId?: string; name?: string }) =>
      deps.output(service.get({ definition_id: options.definitionId, name: options.name }))
    );

  command.command("inventory")
    .description("Read the feature-qualified configuration inventory.")
    .option("--repo-dir <path>", "Project directory.", process.cwd())
    .option("--refresh", "Bypass the cached inventory and requalify the runtime.")
    .action(async (options: { repoDir: string; refresh?: boolean }) =>
      deps.output(await service.inventory({ repo_dir: options.repoDir, refresh: options.refresh }))
    );

  command.command("configure")
    .description("Create, update, duplicate, or reorder a definition from the exact JSON DTO.")
    .requiredOption("--input-json <json>", "Configure request including operation, expected_revision, patch, and optional position.")
    .action((options: { inputJson: string }) => {
      const auth = deps.authOptions({ allowStoredAdminKey: true });
      deps.output(service.configure(parseJsonObjectOption(options.inputJson) as ConfigureAgentDefinitionInput, {
        adminKey: auth.adminKey,
        agentToken: auth.agentToken
      }));
    });

  command.command("delete")
    .description("Delete a definition with compare-and-swap revision.")
    .requiredOption("--definition-id <id>", "Definition id.")
    .requiredOption("--expected-revision <sha256>", "Current catalog revision.")
    .action((options: { definitionId: string; expectedRevision: string }) => {
      const auth = deps.authOptions({ allowStoredAdminKey: true });
      deps.output(service.delete({
        definition_id: options.definitionId,
        expected_revision: options.expectedRevision
      }, { adminKey: auth.adminKey, agentToken: auth.agentToken }));
    });

  addRequesterOptions(command.command("launch"))
    .description("Launch a supervised worker from an immutable definition snapshot.")
    .option("--definition-id <id>", "Definition id.")
    .option("--name <name>", "Exact definition name.")
    .option("--prompt <text>", "Task prompt.")
    .option("--prompt-file <path>", "Canonical prompt file.")
    .option("--title <title>", "Execution title.")
    .option("--repo-dir <path>", "Project directory.", process.cwd())
    .option("--run <runId>", "Existing run id.")
    .option("--phase <phase>", "Execution phase.", "task")
    .option("--role <role>", "Worker role.")
    .option("--objective <objective>", "Bounded objective.")
    .option("--sandbox <mode>", "read_only or workspace.")
    .option("--approval-policy <policy>", "Interactive approval policy; only on-request is accepted.")
    .option("--output-artifact <path>", "Expected primary output artifact.")
    .option("--input-handoffs-json <json>", "Compact structured handoffs array.")
    .option("--input-artifact <path>", "Input artifact.", collect, [])
    .option("--constraint <text>", "Constraint.", collect, [])
    .option("--expect-artifact <path>", "Expected output artifact.", collect, [])
    .option("--file <path>", "Image attachment.", collect, [])
    .option("--no-watch", "Do not start the detached watcher.")
    .action(async (options: {
      definitionId?: string; name?: string; prompt?: string; promptFile?: string; title?: string;
      repoDir: string; run?: string; phase: string; role?: string; objective?: string;
      sandbox?: "read_only" | "workspace"; approvalPolicy?: "on-request";
      outputArtifact?: string; inputHandoffsJson?: string; inputArtifact: string[];
      constraint: string[]; expectArtifact: string[]; file: string[]; watch?: boolean;
      requesterThreadId?: string; requesterEvent?: EventType[]; requesterDelivery?: "wait" | "notify";
    } & RequesterOptions) => {
      const auth = deps.authOptions({ allowStoredAdminKey: true });
      const handoffs = options.inputHandoffsJson
        ? JSON.parse(options.inputHandoffsJson) as unknown
        : undefined;
      deps.output(await service.launch({
        definition_id: options.definitionId,
        name: options.name,
        prompt: options.prompt,
        prompt_file: options.promptFile,
        title: options.title,
        repo_dir: options.repoDir,
        run_id: options.run,
        phase: options.phase,
        role: options.role,
        objective: options.objective,
        sandbox: options.sandbox,
        approval_policy: options.approvalPolicy,
        output_artifact: options.outputArtifact,
        input_handoffs: handoffs,
        input_artifacts: options.inputArtifact,
        constraints: options.constraint,
        expected_artifacts: options.expectArtifact,
        attachments: options.file,
        watch: options.watch,
        requester_thread_id: options.requesterThreadId,
        requester_event_types: options.requesterEvent,
        requester_delivery: options.requesterDelivery,
        admin_key: auth.adminKey,
        agent_token: auth.agentToken
      }, deps));
    });
}
