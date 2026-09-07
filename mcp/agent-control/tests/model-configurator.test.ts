import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
let root:string;
const helper=resolve(import.meta.dirname,"../../../skills/flow-configurator/scripts/flow-model-configurator.mjs");
const run=(...args:string[])=>execFileSync(process.execPath,[helper,...args,"--project",root],{encoding:"utf8"});
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"ac-configurator-"));mkdirSync(join(root,".agents"));});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
it("sets preferences while preserving unrelated TOML and environment files",()=>{
 const env='# Unrelated environment\nOTHER=private\n';writeFileSync(join(root,'.agents.env'),env);
 const original='# My HDT choices\n[hdt.analyst]\nmodel = "gpt-6-astra" # preserved\n';
 writeFileSync(join(root,'.agents/models.toml'),original);
 const result=run('set','--set','planner.model=gpt-5.6-sol','--set','planner.reasoning_effort=xhigh');
 expect(result).not.toContain('private');
 expect(readFileSync(join(root,'.agents.env'),'utf8')).toBe(env);
 expect(readFileSync(join(root,'.agents/models.toml'),'utf8')).toContain(original);
 expect(JSON.parse(result).roles.planner).toEqual({model:'gpt-5.6-sol',reasoning_effort:'xhigh'});
});
it("uses canonical flow IDs when called with a local directory alias",()=>{
 const dir=join(root,'.agents/flows/folder-alias');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'flow.json'),JSON.stringify({id:'canonical',initial_step:'one',roles:{worker:{backend:'codex-thread',model:'base'}},steps:{one:{role:'worker'}}}));
 const result=JSON.parse(run('set','--flow','folder-alias','--set','worker.model=yoda'));
 expect(result.flow).toBe('canonical');expect(result.roles.worker.model).toBe('yoda');
});
it("rejects invalid settings without changing configuration",()=>{
 const original='[hdt.analyst]\nmodel="gpt-6-astra"\n';writeFileSync(join(root,'.agents/models.toml'),original);
 expect(()=>run('set','--set','planner.reasoning_effort=invalid')).toThrow();
 expect(readFileSync(join(root,'.agents/models.toml'),'utf8')).toBe(original);
});
it("rejects duplicate singleton options before editing",()=>{
 const original='[hdt.analyst]\nmodel="gpt-6-astra"\n';writeFileSync(join(root,'.agents/models.toml'),original);
 expect(()=>run('set','--flow','development-flow-v1','--flow','development-flow-v1','--set','planner.model=yoda')).toThrow();
 expect(readFileSync(join(root,'.agents/models.toml'),'utf8')).toBe(original);
});
