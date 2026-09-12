import { z } from "zod";
import { userQuestionItemSchema, userQuestionAnswersSchema } from "../core/user-questions.js";
import { objectSchema, stringProperty, numberProperty, booleanProperty, type ToolDefinition } from "./json-schema.js";

const identity = { agent_token: z.string().min(1).optional(), admin_key: z.string().min(1).optional() };
export const questionAskSchema = z.object({
  agent_id: z.string().min(1), agent_token: identity.agent_token,
  title: z.string().trim().min(1).max(200), request_key: z.string().trim().min(1).max(160),
  questions: z.array(userQuestionItemSchema).min(1).max(3), wait: z.boolean().optional(),
  timeout_ms: z.number().int().positive().max(3_600_000).optional()
}).strict();
export type QuestionAskInput = z.infer<typeof questionAskSchema>;
export const questionGetSchema = z.object({ ...identity, question_id: z.string().min(1) }).strict();
export const questionListSchema = z.object({ ...identity, run_id: z.string().min(1) }).strict();
export const questionWaitSchema = z.object({ question_id: z.string().min(1), agent_token: identity.agent_token, timeout_ms: z.number().int().positive().max(3_600_000).optional() }).strict();
export const questionAnswerSchema = z.object({ ...identity, question_id: z.string().min(1), answers: userQuestionAnswersSchema }).strict();
export const consoleQuestionAnswerSchema = z.object({ agent_id: z.string().min(1), question_id: z.string().min(1), answers: userQuestionAnswersSchema }).strict();

export const questionAnswersJsonSchema = { type: "object", additionalProperties: objectSchema({
  option_ids: { type: "array", items: { type: "string" }, maxItems: 8 }, text: { type: "string", maxLength: 8000 }
}) };
const identityProperties = {
  agent_token: stringProperty("Own worker credential when native thread identity is unavailable; never grants permission to answer for the user."),
  admin_key: stringProperty("Explicit local administrator credential for an operator; never put it in worker prompts.")
};
export const QUESTION_TOOLS: ToolDefinition[] = [
  { name: "question_ask", schema: questionAskSchema,
    description: "Ask the user 1–3 questions directly in Agent Control. All pending questions appear together in Full Console, with agent/room badges and in the owning chat. The authenticated agent owns this request. Use a stable request_key to retry without duplication. Default waits up to one hour and returns the user's actual answers through this same tool; wait=false returns a question_wait contract for independent work. Timeout/cancellation does not answer or discard the question: resume question_wait, never repeat it under a new key. This is clarification, not backend permission approval or a flow-decision receipt.",
    inputSchema: objectSchema({ agent_id: stringProperty("This agent's registered identity."), agent_token: identityProperties.agent_token,
      title: stringProperty("Short title for the question card."), request_key: stringProperty("Stable idempotency key for this decision within the current work generation."),
      questions: { type: "array", minItems: 1, maxItems: 3, items: objectSchema({ id: stringProperty("Stable question id."), prompt: stringProperty("Complete user-facing question."),
        multiple: booleanProperty("Allow selecting multiple options; default single choice. Free text is always available."),
        options: { type: "array", minItems: 1, maxItems: 8, items: objectSchema({ id: stringProperty("Stable option id."), label: stringProperty("User-facing answer."), description: stringProperty("Consequence or tradeoff.") }, ["id", "label"]) }
      }, ["id", "prompt"]) }, wait: booleanProperty("Default true; set false to continue independent work before question_wait."), timeout_ms: numberProperty("Wait up to 3600000 ms, default one hour.")
    }, ["agent_id", "title", "request_key", "questions"]) },
  { name: "question_get", schema: questionGetSchema, description: "Recover a durable question and actual submitted answers. Originating agent or authorized run operator only. Reading an answer never starts another worker turn.", inputSchema: objectSchema({ ...identityProperties, question_id: stringProperty("Question id.") }, ["question_id"]) },
  { name: "question_list", schema: questionListSchema, description: "Recover questions for a run. Workers see only their own; an authorized operator can inspect the run. Use question_wait for pending answers, not repeated polling.", inputSchema: objectSchema({ ...identityProperties, run_id: stringProperty("Run id.") }, ["run_id"]) },
  { name: "question_wait", schema: questionWaitSchema, description: "Wait for the user's answer to your existing question, including after a timeout or interrupted tool call. Defaults to one hour. Returns the exact persisted answers without steering or restarting the agent; resume this wait while the question remains pending. Does not let another worker consume this question.", inputSchema: objectSchema({ question_id: stringProperty("Existing question id."), agent_token: identityProperties.agent_token, timeout_ms: numberProperty("Positive timeout up to 3600000 ms.") }, ["question_id"]) },
  { name: "question_answer", schema: questionAnswerSchema, description: "Relay the user's actual answers to an existing Agent Control question. Original verified requester or explicit local operator only; workers cannot impersonate the user. Normally the user answers in the console. Idempotent identical answers; conflicting or cancelled submissions fail. This does not approve a native permission or a flow gate.", inputSchema: objectSchema({ ...identityProperties, question_id: stringProperty("Question id."), answers: questionAnswersJsonSchema }, ["question_id", "answers"]) }
];
