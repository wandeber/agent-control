import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AgentController } from "../src/core/controller.js";
import { CodexThreadAdapter } from "../src/adapters/codex-thread-adapter.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { withMcpCaller } from "../src/core/caller-context.js";
import { handleTool } from "../src/tools/handlers.js";
import { startControlServer } from "../src/control-server.js";
import { UserQuestions } from "../src/core/user-questions.js";

let root: string, store: SqliteStore, controller: AgentController;
const auth = { adminKey: "question-test-admin" };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ac-questions-"));
  vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", auth.adminKey); vi.stubEnv("AGENT_CONTROL_HOME", root);
  vi.stubEnv("AGENT_CONTROL_DB", join(root, "state.sqlite")); vi.stubEnv("AGENT_CONTROL_POLL_INTERVAL_MS", "0");
  store = new SqliteStore(join(root, "state.sqlite")); const adapters = new AdapterRegistry(); adapters.register(new CodexThreadAdapter()); controller = new AgentController(store, adapters);
});
afterEach(async () => { await controller.dispose(); store.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function worker(title = "Design", run = controller.createRun({ title, ...auth })) {
  const agent = controller.registerAgent({ runId: run.run_id, backend: "codex-thread", title, ...auth });
  return { run, agent, input: { agent_id: agent.agent_id, agent_token: agent.agent_token, title: "Choose the style", request_key: "style", wait: false,
    questions: [{ id: "style", prompt: "Which visual direction?", options: [{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }] }] } };
}
const answers = { style: { option_ids: ["light"], text: "Keep the typography calm." } };

describe("durable user questions", () => {
  it("returns the actual answer to a waiting worker without starting another turn", async () => {
    const w = worker(), send = vi.spyOn(controller, "sendMessage");
    const wait = controller.askUserQuestion({ ...w.input, wait: true, timeout_ms: 2000 });
    const q = controller.listUserQuestions(w.run.run_id, auth).questions[0];
    controller.answerOperatorQuestion(q.question_id, answers, auth);
    expect(await wait).toMatchObject({ outcome: "answered", question: { answers, state: "answered" } });
    expect(send).not.toHaveBeenCalled();
    expect(controller.getAgent(w.agent.agent_id).work_generation).toBe(w.agent.work_generation);
  });
  it("recovers timeouts and cancelled transports without duplicating or discarding a question", async () => {
    const w = worker();
    const first = await controller.askUserQuestion({ ...w.input, wait: true, timeout_ms: 5 });
    expect(first).toMatchObject({ outcome: "timeout", wait_contract: { tool: "question_wait" } });
    const replay = await controller.askUserQuestion(w.input);
    expect(replay.question.question_id).toBe(first.question.question_id);
    await expect(controller.askUserQuestion({ ...w.input, title: "Different" })).rejects.toThrow("different question");
    const abort = new AbortController();
    const cancelled = controller.waitForUserQuestion(first.question.question_id, { agentToken: w.agent.agent_token }, abort.signal);
    abort.abort(); await expect(cancelled).rejects.toThrow();
    expect(controller.getUserQuestion(first.question.question_id, auth).state).toBe("pending");
    controller.answerOperatorQuestion(first.question.question_id, answers, auth);
    const reopened = new SqliteStore(join(root, "state.sqlite"));
    try { expect(new UserQuestions(reopened, () => {}).get(first.question.question_id).answers).toEqual(answers); } finally { reopened.close(); }
  });
  it("serializes competing answers, validates selections, and cancels stopped executions", async () => {
    const w = worker(), q = (await controller.askUserQuestion(w.input)).question;
    for (const invalid of [{}, { style: { option_ids: ["invented"], text: "" } }, { style: { option_ids: ["light", "dark"], text: "" } }]) {
      expect(() => controller.answerOperatorQuestion(q.question_id, invalid, auth)).toThrow();
    }
    controller.answerOperatorQuestion(q.question_id, answers, auth);
    expect(controller.answerOperatorQuestion(q.question_id, answers, auth).answers).toEqual(answers);
    expect(() => controller.answerOperatorQuestion(q.question_id, { style: { option_ids: ["dark"], text: "" } }, auth)).toThrow("no longer pending");
    const next = (await controller.askUserQuestion({ ...w.input, request_key: "next" })).question;
    store.updateAgent(w.agent.agent_id, { status: "stopped" });
    expect(controller.getUserQuestion(next.question_id, auth).state).toBe("cancelled");
    expect(() => controller.answerOperatorQuestion(next.question_id, answers, auth)).toThrow();
    await expect(controller.askUserQuestion({ ...w.input, questions: [{ id: "constructor", prompt: "Invalid key" }] })).rejects.toThrow();
  });
  it("keeps worker reads private and lets the verified requester list and receive every question", async () => {
    const w = worker(), other = worker("Second", w.run);
    const observer = controller.observeRun({ runId: w.run.run_id, threadId: "requester", ...auth });
    const q = (await controller.askUserQuestion(w.input)).question;
    await controller.askUserQuestion(other.input);
    expect(controller.listUserQuestions(w.run.run_id, { agentToken: w.agent.agent_token }).questions).toHaveLength(1);
    expect(() => controller.getUserQuestion(q.question_id, { agentToken: other.agent.agent_token })).toThrow();
    expect(() => controller.answerOperatorQuestion(q.question_id, answers, { agentToken: w.agent.agent_token })).toThrow();
    const listed = await withMcpCaller({ threadId: "requester" }, () => handleTool(controller, "question_list", { run_id: w.run.run_id })) as any;
    expect(listed.questions).toHaveLength(2);
    expect(() => withMcpCaller({ threadId: "requester" }, () => controller.listUserQuestions(w.run.run_id, { adminKey: "bad" }))).toThrow("Invalid administrator");
    const event = await controller.waitForRun({ runId: w.run.run_id, observerAgentId: observer.observer_agent_id, cursor: observer.cursor, timeoutMs: 100, intervalMs: 10 });
    expect(JSON.stringify(event)).toContain(q.question_id);
    expect(JSON.stringify(event)).not.toContain("Which visual direction?");
  });
  it("projects questions from every visible room independently of the selected room", async () => {
    const a = worker("A"), b = worker("B");
    await controller.askUserQuestion(a.input); await controller.askUserQuestion(b.input);
    controller.observeRun({ runId: a.run.run_id, threadId: "requester", ...auth });
    expect(controller.getDashboardSnapshot(a.run.run_id).user_questions).toHaveLength(2);
    expect(controller.getDashboardSnapshot(a.run.run_id, { threadId: "requester" }).user_questions).toHaveLength(1);
  });
  it("shares durable requests with the CLI and enforces browser origin and question capability", async () => {
    const w = worker(), q = (await controller.askUserQuestion(w.input)).question;
    const get = await promisify(execFile)(process.execPath, [resolve("dist/cli.js"), "question", "get", "--question", q.question_id], { env: process.env });
    expect(JSON.parse(get.stdout)).toMatchObject({ question_id: q.question_id, state: "pending" });
    const api = await startControlServer({ host: "localhost", port: 0, uiOrigin: "http://localhost:3888" });
    const base = `http://localhost:${(api.server.address() as { port: number }).port}/api/control/questions`;
    const body = JSON.stringify({ agent_id: w.agent.agent_id, question_id: q.question_id, answers });
    const call = (route: string, headers = {}) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    try {
      expect((await call("access", { origin: "https://unrelated.example" })).status).toBe(403);
      expect((await call("answer", { origin: "http://localhost:3888" })).status).toBe(403);
      const access = await call("access", { origin: "http://localhost:3888" });
      expect(access.status).toBe(200);
      const { token } = await access.json() as { token: string };
      expect((await call("answer", { origin: "http://localhost:3888", "X-Agent-Control-Permission": token })).status).toBe(200);
      expect(controller.getUserQuestion(q.question_id, auth).answers).toEqual(answers);
      expect((await call("answer", { origin: "http://localhost:3888", "X-Agent-Control-Permission": token })).status).toBe(403);
    } finally { await api.close(); }
  });
});
