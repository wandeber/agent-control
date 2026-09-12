import type { Command } from "commander";
import { readFileSync } from "node:fs";
import type { CliDeps } from "./shared.js";
import { questionAskSchema } from "../tools/questions.js";

export function registerQuestionCommands(program: Command, deps: CliDeps): void {
  const question = program.command("question").description("Ask users in the shared console and recover durable answers.");
  question.command("ask").requiredOption("--agent <id>", "Your registered agent id.")
    .requiredOption("--file <path>", "JSON with title, request_key, and questions; free text is always available.")
    .option("--no-wait", "Return a wait contract so independent work can continue.")
    .option("--timeout-ms <n>", "Wait duration, up to one hour.")
    .action(async options => deps.output(await deps.controller.askUserQuestion(questionAskSchema.parse({
      ...JSON.parse(readFileSync(options.file, "utf8")), agent_id: options.agent,
      agent_token: deps.authOptions().agentToken, wait: options.wait, timeout_ms: options.timeoutMs === undefined ? undefined : Number(options.timeoutMs)
    }))));
  question.command("get").requiredOption("--question <id>", "Question id.")
    .action(options => deps.output(deps.controller.getUserQuestion(options.question, deps.authOptions())));
  question.command("list").requiredOption("--run <id>", "Run id.")
    .action(options => deps.output(deps.controller.listUserQuestions(options.run, deps.authOptions())));
  question.command("wait").requiredOption("--question <id>", "Question id.")
    .option("--timeout-ms <n>", "Wait duration, up to one hour.")
    .action(async options => deps.output(await deps.controller.waitForUserQuestion(options.question, {
      agentToken: deps.authOptions().agentToken, timeoutMs: options.timeoutMs === undefined ? undefined : Number(options.timeoutMs)
    })));
  question.command("answer").requiredOption("--question <id>", "Question id.")
    .requiredOption("--file <path>", "JSON map of question ids to {option_ids,text}, containing the user's submitted answers.")
    .action(options => deps.output(deps.controller.answerOperatorQuestion(options.question, JSON.parse(readFileSync(options.file, "utf8")), deps.authOptions())));
}
