import type { Command } from "commander";
import { readFileSync } from "node:fs";
import type { CliDeps } from "./shared.js";
import { canvasSetSchema } from "../tools/schemas.js";

export function registerOperatorCommands(program: Command, deps: CliDeps) {
  // CLI decisions require an explicit credential; never borrow a stored admin key.
  const permission = program.command("permission").description("Inspect and decide real native permission requests.");
  permission.command("list").requiredOption("--run <id>", "Run id.")
    .action(options => deps.output(deps.controller.listPermissions(options.run, deps.authOptions())));
  permission.command("decide").requiredOption("--agent <id>", "Request owner.").requiredOption("--request <id>", "Exact request id.")
    .requiredOption("--decision <choice>", "approve or reject after reviewing scope.")
    .action(options => deps.output(deps.controller.decideOperatorPermission(options.agent, options.request, options.decision, deps.authOptions())));
  const positions = program.command("canvas").description("Control the shared agent canvas.").command("positions");
  positions.command("get").requiredOption("--run <id>", "Run id.").action(options => {
    deps.controller.authorizeRunOperator(options.run, deps.authOptions()); deps.output(deps.controller.getCanvasPositions(options.run));
  });
  positions.command("set").requiredOption("--run <id>", "Run id.").requiredOption("--revision <n>", "Current CAS revision.")
    .requiredOption("--file <path>", "JSON array of {agent_id,x,y}, using run-local coordinates.").action(options => {
      const input = canvasSetSchema.parse({ run_id: options.run, expected_revision: Number(options.revision), positions: JSON.parse(readFileSync(options.file, "utf8")) });
      deps.controller.authorizeRunOperator(input.run_id, deps.authOptions());
      deps.output(deps.controller.setCanvasPositions(input.run_id, input.expected_revision, input.positions));
    });
}
