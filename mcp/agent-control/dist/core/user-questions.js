import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { ControllerError } from "./errors.js";
import { newId, nowIso } from "./ids.js";
const questionKey = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value), "Use a unique question or option key.");
const optionSchema = z.object({ id: questionKey, label: z.string().trim().min(1).max(300), description: z.string().max(600).optional() }).strict();
export const userQuestionItemSchema = z.object({
    id: questionKey, prompt: z.string().trim().min(1).max(4000),
    options: z.array(optionSchema).min(1).max(8).optional(), multiple: z.boolean().optional()
}).strict().refine(item => !item.options || new Set(item.options.map(option => option.id)).size === item.options.length, "Option ids must be unique.");
export const userQuestionContentSchema = z.object({
    title: z.string().trim().min(1).max(200), questions: z.array(userQuestionItemSchema).min(1).max(3),
    request_key: z.string().trim().min(1).max(160)
}).strict().refine(value => new Set(value.questions.map(item => item.id)).size === value.questions.length, "Question ids must be unique.");
export const userQuestionAnswersSchema = z.record(z.object({
    option_ids: z.array(z.string().min(1).max(80)).max(8).default([]), text: z.string().trim().max(8000).default("")
}).strict());
/** Answers belong to a durable request, never an unsolicited new worker turn. */
export class UserQuestions {
    store;
    emit;
    constructor(store, emit) {
        this.store = store;
        this.emit = emit;
    }
    decode(row) {
        return { ...JSON.parse(row.record_json), state: row.state, answers: row.answers_json ? JSON.parse(row.answers_json) : null, answered_at: row.answered_at };
    }
    reconcileCancelled() {
        this.store.db.prepare(`update user_questions set state='cancelled' where state='pending' and (
      agent_id in (select agent_id from agents where unregistered_at is not null or status in ('stopping','stopped'))
      or run_id in (select run_id from runs where status in ('stopping','stopped')))`).run();
    }
    get(id) {
        this.reconcileCancelled();
        const row = this.store.db.prepare("select * from user_questions where question_id=?").get(id);
        if (!row)
            throw new ControllerError("Question not found.", "tool_error");
        return this.decode(row);
    }
    list(runIds, pendingOnly = false) {
        this.reconcileCancelled();
        return this.store.db.prepare(`select * from user_questions where run_id in (select value from json_each(?))
      ${pendingOnly ? "and state='pending'" : ""} order by created_at, rowid`).all(JSON.stringify(runIds)).map(row => this.decode(row));
    }
    ask(agent, content) {
        const parsed = userQuestionContentSchema.parse(content);
        return this.store.immediateTransaction(() => {
            const current = this.store.getAgent(agent.agent_id);
            const run = this.store.getRun(agent.run_id);
            if (!current || current.unregistered_at || ["stopping", "stopped"].includes(current.status) || !run || ["stopping", "stopped"].includes(run.status))
                throw new ControllerError("A stopped execution cannot ask a new question.", "tool_error");
            const previous = this.store.db.prepare("select * from user_questions where agent_id=? and generation=? and request_key=?")
                .get(agent.agent_id, current.work_generation, parsed.request_key);
            if (previous) {
                const record = this.decode(previous);
                if (record.title !== parsed.title || JSON.stringify(record.questions) !== JSON.stringify(parsed.questions))
                    throw new ControllerError("This request_key already identifies a different question.", "tool_error");
                return this.get(record.question_id);
            }
            const record = { ...parsed, question_id: newId("question"), run_id: agent.run_id, agent_id: agent.agent_id,
                agent_title: agent.title, run_title: run.title, state: "pending", answers: null, created_at: nowIso(), answered_at: null };
            this.store.db.prepare("insert into user_questions (question_id,run_id,agent_id,generation,request_key,record_json,state,created_at) values (?,?,?,?,?,?,?,?)")
                .run(record.question_id, record.run_id, record.agent_id, current.work_generation, record.request_key, JSON.stringify(record), record.state, record.created_at);
            this.emit({ runId: agent.run_id, agentId: agent.agent_id, type: "question.requested", payload: { question_id: record.question_id, title: record.title } });
            return record;
        });
    }
    answer(id, input) {
        return this.store.immediateTransaction(() => {
            const request = this.get(id);
            const answers = userQuestionAnswersSchema.parse(input);
            if (Object.keys(answers).length !== request.questions.length || Object.keys(answers).some(key => !request.questions.some(item => item.id === key)))
                throw new ControllerError("Answer every question in this request, without extra fields.", "tool_error");
            const canonical = {};
            for (const item of request.questions) {
                const answer = answers[item.id];
                if (!answer || (!answer.text && !answer.option_ids.length) || (!item.multiple && answer.option_ids.length > 1) || new Set(answer.option_ids).size !== answer.option_ids.length || answer.option_ids.some(id => !item.options?.some(option => option.id === id)))
                    throw new ControllerError("Choose a valid option or provide a written answer for each question.", "tool_error");
                canonical[item.id] = { option_ids: [...answer.option_ids].sort(), text: answer.text };
            }
            if (request.state === "answered" && JSON.stringify(request.answers) === JSON.stringify(canonical))
                return request;
            if (request.state !== "pending")
                throw new ControllerError("This question is no longer pending. Refresh to see its recorded answer.", "tool_error");
            // Serialize competing panels: the first submitted answer owns this request.
            this.store.db.prepare("update user_questions set state='answered', answers_json=?, answered_at=? where question_id=? and state='pending'")
                .run(JSON.stringify(canonical), nowIso(), id);
            this.emit({ runId: request.run_id, agentId: request.agent_id, type: "question.answered", payload: { question_id: id, title: request.title } });
            return this.get(id);
        });
    }
    async wait(id, timeoutMs = 3_600_000, signal) {
        const deadline = Date.now() + z.number().int().positive().max(3_600_000).parse(timeoutMs);
        const first = this.get(id);
        if (first.state !== "pending")
            return { question: first, outcome: first.state };
        const waitId = newId("question_wait");
        this.emit({ runId: first.run_id, agentId: first.agent_id, type: "question.wait_started", payload: { question_id: id, wait_id: waitId, expires_at: new Date(deadline).toISOString() } });
        try {
            while (true) {
                signal?.throwIfAborted();
                const question = this.get(id);
                if (question.state !== "pending")
                    return { question, outcome: question.state };
                if (Date.now() >= deadline)
                    return { question, outcome: "timeout", wait_contract: { tool: "question_wait", arguments: { question_id: id, timeout_ms: 3_600_000 } } };
                // The console and MCP often use different processes over the same SQLite
                // authority. Waiting here survives that boundary without model-side polling.
                await delay(Math.min(250, deadline - Date.now()), undefined, { signal });
            }
        }
        finally {
            this.emit({ runId: first.run_id, agentId: first.agent_id, type: "question.wait_ended", payload: { question_id: id, wait_id: waitId } });
        }
    }
}
