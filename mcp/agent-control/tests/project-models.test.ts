import { createController } from "../src/core/factory.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyProjectModels, resolveProjectRoot } from "../src/core/project-models.js";
import { getFlowFromCatalog, listFlowCatalog } from "../src/core/flow-catalog.js";
import { parseFlowConfigText } from "../src/core/flow-config-loader.js";
let root: string;
const base = { id: "example", initial_step: "one", roles: { analyst: { backend: "codex-thread", model: "base", reasoning_effort: "high", prompt: "Preserve instructions" } }, steps: { one: { role: "analyst" } } };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ac-models-")); mkdirSync(join(root, ".git")); mkdirSync(join(root, ".agents")); mkdirSync(join(root, "src")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("resolves a subdirectory and merges partial model overrides without changing the base", () => {
 writeFileSync(join(root, ".agents/models.toml"), '[flows.example.analyst]\nmodel="yoda"\n');
 expect(resolveProjectRoot(join(root,"src"))).toBe(root);
 expect(applyProjectModels(base, join(root,"src"))).toMatchObject({ roles: { analyst: { model: "yoda", reasoning_effort: "high", prompt: "Preserve instructions" } } });
 expect(base.roles.analyst.model).toBe("base");
});
it.each(['[flows.example.typo]\nmodel="yoda"', '[flows.example.analyst]\nbackend="fake"', '[flows.example.analyst]\nreasoning_effort="huge"', '[flows.example.analyst]\nmodel=3', '[broken'])('rejects invalid project preferences: %s', text => {
 writeFileSync(join(root,".agents/models.toml"),text); expect(() => applyProjectModels(base, root)).toThrow();
});
it("project same ID replaces base while keeping relative prompts in the local package", () => {
 const bundled=join(root,"bundled"), local=join(root,".agents/flows");
 for(const [dir,model] of [[bundled,"bundled"],[local,"local"]]) {
  mkdirSync(join(dir,"example"),{recursive:true});writeFileSync(join(dir,"example/prompt.md"),"Instructions");
  writeFileSync(join(dir,"example/flow.json"),JSON.stringify({...base, roles:{analyst:{...base.roles.analyst,prompt:undefined,model,prompt_path:"prompt.md"}}}));
 }
 const catalogs=[{catalog_id:"repo-flows",name:"Base",root_path:bundled,exists:true},{catalog_id:"project-flows",name:"Project",root_path:local,exists:true}];
 writeFileSync(join(root,".agents/models.toml"),'[flows.example.analyst]\nreasoning_effort="xhigh"');
 expect(listFlowCatalog({catalogs}).flows).toHaveLength(1);
 expect(getFlowFromCatalog({flowId:"example",catalogs,projectDir:root}).config).toMatchObject({roles:{analyst:{model:"local",reasoning_effort:"xhigh",prompt_path:join(local,"example/prompt.md")}}});
});
it("rejects model environment interpolation for file and direct object inputs", () => {
 expect(()=>parseFlowConfigText('id: bad\nroles:\n  analyst:\n    model: ${MODEL-default}')).toThrow(/environment interpolation/);
 expect(()=>applyProjectModels({...base,roles:{analyst:{model:'${MODEL-default}'}}})).toThrow(/environment interpolation/);
});

it("pins project model settings at launch and never rereads them for a running instance", async () => {
 vi.stubEnv("AGENT_CONTROL_HOME", join(root, "state")); vi.stubEnv("AGENT_CONTROL_ADMIN_KEY", "test-admin"); vi.stubEnv("CODEX_THREAD_ID", "");
 const { controller, store } = createController(join(root, "state.db"));
 try {
  writeFileSync(join(root,".agents/models.toml"),'[flows.example.analyst]\nmodel="project-model"');
  const result = controller.startFlow({ config: base, repoDir: join(root,"src"), adminKey:"test-admin" });
  writeFileSync(join(root,".agents/models.toml"),'[flows.example.analyst]\nmodel="later-model"');
  expect(controller.getFlowSnapshot(result.instance.flow_instance_id).flow.config.roles?.analyst.model).toBe("project-model");
 } finally { await controller.dispose(); store.close(); vi.unstubAllEnvs(); }
});
