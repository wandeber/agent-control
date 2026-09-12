import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createController } from "../../src/core/factory.js";
import { startControlServer } from "../../src/control-server.js";
import { startStaticWebServer } from "../../src/cli/web.js";
// Isolated protocol fixtures for interactive verification; no model or command execution.
const root = mkdtempSync(join(tmpdir(), "agent-control-questions-ui-"));
process.env.AGENT_CONTROL_HOME = root; process.env.AGENT_CONTROL_DB = join(root, "state.sqlite");
process.env.AGENT_CONTROL_ADMIN_KEY = randomUUID(); process.env.AGENT_CONTROL_POLL_INTERVAL_MS = "0";
const { controller, store } = createController(), auth = { adminKey: process.env.AGENT_CONTROL_ADMIN_KEY };
const run = controller.createRun({ title: "Verification · Portfolio studio", repoDir: "/workspace/portfolio", ...auth });
const other = controller.createRun({ title: "Verification · Design review", repoDir: "/workspace/portfolio", ...auth });
const iso = (offset: number) => new Date(Date.now() - 360_000 + offset).toISOString();
store.db.prepare("update runs set created_at=? where run_id in (?,?)").run(iso(0), run.run_id, other.run_id);
const agents = ["Interface designer", "Frontend developer", "Design reviewer"].map((title, index) => {
  const ownerRun = index === 2 ? other : run;
  const agent = controller.registerAgent({ runId: ownerRun.run_id, backend: "manual", title, status: "waiting_for_input", backendHandle: { id: title, status: "waiting_for_input", messages: [{ role: "assistant", text: index === 0 ? "I have prepared two visual directions for your portfolio." : "The responsive layout is ready for your content preferences.", created_at: iso(310_000) }] }, ...auth });
  for (const [start, end] of [[10_000 + index * 50_000, 110_000 + index * 50_000], [180_000 + index * 30_000, 270_000 + index * 30_000]]) {
    for (const [at, type, payload] of [[start, "agent.started", {}], [end, "agent.status_changed", { status: "waiting_for_input" }]] as const) {
      const event = store.createEvent({ runId: ownerRun.run_id, agentId: agent.agent_id, type, payload });
      store.db.prepare("update events set created_at=? where event_id=?").run(iso(at), event.event_id);
    }
  }
  return agent;
});
const client = new Client({ name: "question-ui-verification", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], cwd: resolve("."), env: process.env as Record<string, string>, stderr: "pipe" }));
console.log(JSON.stringify({ question_tools: (await client.listTools()).tools.filter(tool => tool.name.startsWith("question_")).map(tool => tool.name) }));
const prompts = [
  { title: "Visual direction", questions: [{ id: "direction", prompt: "Which direction should I develop for the tech portfolio?", options: [{ id: "editorial", label: "Light editorial", description: "Generous space and typography, with projects as the focus." }, { id: "terminal", label: "Dark technical", description: "A terminal-inspired identity with restrained accent colors." }] }] },
  { title: "Homepage content", questions: [{ id: "content", prompt: "Should the homepage start with selected projects or with your professional profile?", options: [{ id: "projects", label: "Selected projects" }, { id: "profile", label: "Professional profile" }] }] },
  { title: "Sections to review", questions: [{ id: "sections", prompt: "Which sections should I include in the final accessibility and content review?", multiple: true, options: [{ id: "projects", label: "Project case studies" }, { id: "about", label: "About and experience" }, { id: "contact", label: "Contact details" }] }] }
];
for (const [index, agent] of agents.entries()) void client.callTool({ name: "question_ask", arguments: { agent_id: agent.agent_id, agent_token: agent.agent_token, request_key: `verification-${index}`, ...prompts[index], timeout_ms: 3_600_000 }, _meta: { threadId: `fixture-worker-${index}` } }, undefined, { timeout: 3_650_000 }).then(result => console.log(JSON.stringify({ answered_agent: agent.title, result })), error => console.log(JSON.stringify({ waiter_closed: agent.title, error: String(error) })));
const api = await startControlServer({ host: "localhost", port: 0 });
const web = await startStaticWebServer({ host: "localhost", port: 0, rootDir: resolve("../../web-runtime") });
const origin = `http://localhost:${(web.address() as { port: number }).port}`;
api.setUiOrigin(origin);
console.log(JSON.stringify({ url: `${origin}/?apiPort=${(api.server.address() as { port: number }).port}&run_id=${run.run_id}#/console`, root }));
process.on("SIGTERM", async () => { await client.close(); await api.close(); await new Promise<void>(done => web.close(() => done())); await controller.dispose(); store.close(); process.exit(0); });
