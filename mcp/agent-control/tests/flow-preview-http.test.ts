import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { startControlServer } from "../src/control-server.js";

it("serves live source files to the local browser and rejects cross-site prompt reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-preview-http-"));
  const dir = join(root, ".agents", "flows", "draft");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "flow.yaml"), "id: draft\ninitial_step: first\nsteps:\n  first:\n    prompt: Visible instructions\n");
  vi.stubEnv("AGENT_CONTROL_HOME", root); vi.stubEnv("AGENT_CONTROL_DB", join(root, "state.sqlite"));
  const api = await startControlServer({ host: "localhost", port: 0 });
  try {
    const url = new URL(`http://localhost:${(api.server.address() as AddressInfo).port}/api/control/flows`);
    url.searchParams.set("repo_dir", root); url.searchParams.set("flow_id", "draft");
    const allowed = await fetch(url, { headers: { origin: "http://localhost:3880" } });
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as any).definition.prompts.first[0].text).toBe("Visible instructions");
    const denied = await fetch(url, { headers: { origin: "https://unrelated.example" } });
    expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("Visible instructions");
    const opaque = await fetch(url, { headers: { origin: "null" } }); expect(opaque.status).toBe(403);
  } finally { await api.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
