import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startControlServer } from "../src/control-server.js";
import { TOOL_DEFINITIONS } from "../src/tools/tool-definitions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function editable(name: string) {
  return {
    name,
    description: "Transport fixture",
    instructions: "Fixture instructions",
    model: "fixture-model",
    model_provider: "fixture-provider",
    reasoning_effort: "high",
    plugins: [],
    skills: [],
    mcp_servers: []
  };
}

function rawStatus(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname,
      method: "GET", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("configured-agent transports", () => {
  it("registers exactly the six model-visible operations with strict source_id duplicate parsing", () => {
    const definitions = TOOL_DEFINITIONS.filter((tool) => tool.name.startsWith("agent_definition_"));
    expect(definitions.map((tool) => tool.name)).toEqual([
      "agent_definition_list",
      "agent_definition_get",
      "agent_definition_inventory",
      "agent_definition_configure",
      "agent_definition_delete",
      "agent_definition_launch"
    ]);
    const configure = definitions.find((tool) => tool.name === "agent_definition_configure")!;
    expect((configure.inputSchema as any).properties.patch.properties.capabilities_mode.enum).toEqual(["inherit", "custom"]);
    expect(configure.schema.parse({ operation: "duplicate", source_id: "11111111-1111-4111-8111-111111111111",
      expected_revision: "0".repeat(64), patch: { name: "Copy" } })).toMatchObject({ source_id: expect.any(String) });
    expect(() => configure.schema.parse({ operation: "duplicate", source_definition_id: "11111111-1111-4111-8111-111111111111",
      expected_revision: "0".repeat(64), patch: { name: "Copy" } })).toThrow();
    expect(() => configure.schema.parse({ operation: "duplicate", source_id: "11111111-1111-4111-8111-111111111111",
      expected_revision: "0".repeat(64), patch: {}, name: "Top-level copy" })).toThrow();
  });

  it("serves catalog CRUD only to the exact configured localhost UI origin and host", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-definition-http-")); roots.push(root);
    vi.stubEnv("AGENT_CONTROL_HOME", root);
    vi.stubEnv("AGENT_CONTROL_DB", join(root, "state.sqlite"));
    const origin = "http://localhost:4888";
    const runtime = await startControlServer({ host: "localhost", port: 0, uiOrigin: origin });
    const port = (runtime.server.address() as AddressInfo).port;
    const base = `http://localhost:${port}/api/control/agent-definitions`;
    const headers = { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
    try {
      expect((await fetch(base)).status).toBe(403);
      expect(await rawStatus(new URL(base), { ...headers, host: "localhost:1" })).toBe(403);
      expect((await fetch(base, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status).toBe(403);

      const listed = await (await fetch(base, { headers })).json() as any;
      expect(listed).toMatchObject({ schema_version: 1 });
      expect(listed.agents).toHaveLength(7);
      expect(listed.agents.every((agent: any) => agent.bundled_key)).toBe(true);
      const configuredResponse = await fetch(`${base}/configure`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operation: "create", expected_revision: listed.revision, patch: editable("HTTP agent") })
      });
      expect(configuredResponse.status).toBe(200);
      const configured = await configuredResponse.json() as any;
      expect(configured.definition.name).toBe("HTTP agent");

      const fetched = await (await fetch(`${base}/${configured.definition.definition_id}`, { headers })).json() as any;
      expect(fetched.definition.definition_id).toBe(configured.definition.definition_id);
      const conflict = await fetch(`${base}/configure`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operation: "update", expected_revision: listed.revision,
          definition_id: configured.definition.definition_id, patch: { description: "stale" } })
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ reason: "conflict", details: { current_revision: configured.revision } });
      const deleted = await fetch(`${base}/${configured.definition.definition_id}`, {
        method: "DELETE", headers, body: JSON.stringify({ expected_revision: configured.revision })
      });
      expect(deleted.status).toBe(200);
    } finally {
      await runtime.close();
    }
  });

  it("binds app-only catalog operations to the originating panel and local operator thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-definition-app-")); roots.push(root);
    const env = { ...process.env, AGENT_CONTROL_HOME: root, AGENT_CONTROL_DB: join(root, "state.sqlite"),
      AGENT_CONTROL_ADMIN_KEY: "catalog-app-test", AGENT_CONTROL_POLL_INTERVAL_MS: "0" };
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"], cwd: resolve("."), env, stderr: "pipe" });
    const client = new Client({ name: "agent-definition-app-test", version: "1" });
    const call = (name: string, args: Record<string, unknown>, threadId = "operator-thread") =>
      client.callTool({ name, arguments: args, _meta: { threadId } });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.filter((tool) => tool.name.startsWith("agent_control_console_agent_definition_")))
        .toHaveLength(6);
      const opened = await call("open_agent_control_console", { screen: "agents", repo_dir: root });
      const panelId = (opened.structuredContent as any).console.panel_id;
      expect((opened.structuredContent as any).console.screen).toBe("agents");
      const listed = await call("agent_control_console_agent_definition_list", { panel_id: panelId });
      expect((listed.structuredContent as any).agents).toHaveLength(7);
      const configured = await call("agent_control_console_agent_definition_configure", {
        panel_id: panelId,
        operation: "create",
        expected_revision: (listed.structuredContent as any).revision,
        patch: editable("App agent")
      });
      expect((configured.structuredContent as any).definition.name).toBe("App agent");
      expect((await call("agent_control_console_agent_definition_list", { panel_id: panelId }, "other-thread")).isError).toBe(true);
      expect((await call("agent_control_console_agent_definition_list", { panel_id: "unknown" })).isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 15_000);
});
