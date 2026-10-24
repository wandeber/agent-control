import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCliAdapter } from "../src/adapters/codex-cli-adapter.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import type { AgentHandle, StartAgentInput } from "../src/core/types.js";

// Opt in with an installed CLI. All inference stays on the local fixture;
// neither the user's configuration nor provider credentials are loaded.
const executable = process.env.AGENT_CONTROL_CODEX_ROUTING_BIN;
let root: string | undefined;
let server: Server | undefined;
let adapter: CodexCliAdapter | undefined;
let handle: AgentHandle | undefined;
afterEach(async () => {
  if (adapter && handle) await adapter.stop(handle, { mode: "kill" });
  if (server) await new Promise<void>((resolve) => { server!.closeAllConnections(); server!.close(() => resolve()); });
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined; server = undefined; adapter = undefined; handle = undefined;
});

async function settled(owner: CodexCliAdapter, execution: AgentHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { dispose(); reject(new Error("Local provider turn did not settle")); }, 30_000);
    const dispose = owner.watchStatus(execution, (state) => {
      if (["running", "queued"].includes(state.status)) return;
      clearTimeout(timer); dispose();
      if (state.status === "completed") resolve();
      else reject(new Error(`Local provider turn ${state.status}: ${readFileSync(join(String(execution.data.dir), "stderr.log"), "utf8")}`));
    });
  });
}

it.runIf(Boolean(executable)).each([
  { transport: "exec", model: undefined, provider: undefined },
  { transport: "exec", model: "explicit-model", provider: "default-provider" },
  { transport: "app-server", model: undefined, provider: undefined },
  { transport: "app-server", model: "explicit-model", provider: "default-provider" }
])("sends the selected provider/model on $transport start and resume (override: $model)", async ({ transport, model, provider }) => {
  root = mkdtempSync(join(tmpdir(), "ac-provider-routing-"));
  const home = join(root, "codex"), cwd = join(root, "project");
  mkdirSync(home); mkdirSync(cwd);
  const requests: Array<{ path: string; authorization?: string; body: any }> = [];
  server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse((request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes).toString());
    requests.push({ path: request.url, authorization: request.headers.authorization, body });
    const id = `resp_${requests.length}`;
    const item = { id: `msg_${requests.length}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Fixture response", annotations: [] }] };
    const result = { id, object: "response", created_at: 0, model: body.model, status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result }
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "localhost", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const base = `http://localhost:${address.port}`;
  writeFileSync(join(home, "config.toml"), `model="default-model"
model_provider="default-provider"
[model_providers.default-provider]
name="Default fixture"
base_url="${base}/default"
wire_api="responses"
env_key="AC_ROUTING_FIXTURE_KEY"
[model_providers.selected-provider]
name="Selected fixture"
base_url="${base}/selected"
wire_api="responses"
env_key="AC_ROUTING_FIXTURE_KEY"
`);
  writeFileSync(join(home, "selected.config.toml"), `model="profile-model"
model_provider="selected-provider"
sandbox_mode="read-only"
[features]
plugins=false
apps=false
memories=false
`);
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("AGENT_CONTROL_HOME", join(root, "control"));
  vi.stubEnv("AGENT_CONTROL_CODEX_CLI_BIN", executable!);
  vi.stubEnv("AC_ROUTING_FIXTURE_KEY", "local-fixture-only");
  const dbPath = join(root, "control.sqlite"), store = new SqliteStore(dbPath);
  store.close();
  adapter = new CodexCliAdapter();
  handle = await adapter.start({ agent: { agent_id: "routing", run_id: "routing", repo_dir: cwd },
    prompt: "first query", ...(model ? { model } : {}), metadata: { profile: "selected", sandbox: "read_only",
      ...(provider ? { model_provider: provider } : {}),
      ...(transport === "app-server" ? { approval_policy: "on-request", permission_db_path: dbPath } : {}) }
  } as StartAgentInput);
  await settled(adapter, handle);
  const statePath = join(String(handle.data.dir), "state.json");
  const initial = JSON.parse(readFileSync(statePath, "utf8"));
  await adapter.sendMessage(handle, { message: "second query" });
  await settled(adapter, handle);
  const continued = JSON.parse(readFileSync(statePath, "utf8"));
  expect(continued.thread_id).toBe(initial.thread_id);
  expect(continued.transport).toBe(transport === "app-server" ? "app-server" : undefined);
  const path = provider ? "/default/responses" : "/selected/responses";
  expect(requests.map(request => ({ path: request.path, model: request.body.model, authorization: request.authorization }))).toEqual([
    { path, model: model ?? "profile-model", authorization: "Bearer local-fixture-only" },
    { path, model: model ?? "profile-model", authorization: "Bearer local-fixture-only" }
  ]);
  expect((await adapter.readLatest(handle, { limit: 10 })).filter(message => message.role === "assistant").map(message => message.text))
    .toEqual(["Fixture response", "Fixture response"]);
  const userText = (body: any) => body.input.filter((item: any) => item.role === "user")
    .flatMap((item: any) => item.content.map((content: any) => content.text)).at(-1);
  expect(requests.map(request => userText(request.body))).toEqual(["first query", "second query"]);
  expect(requests[1].body.input.some((item: any) => item.role === "assistant")).toBe(true);
}, 90_000);
