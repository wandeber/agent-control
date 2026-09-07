import { afterEach, beforeEach, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCliAdapter } from "../src/adapters/codex-cli-adapter.js";
let dir: string; let previous: NodeJS.ProcessEnv;
beforeEach(() => {
 previous={...process.env}; dir=mkdtempSync(join(tmpdir(), "codex-cli-test-"));
 process.env.AGENT_CONTROL_HOME=dir; process.env.CODEX_HOME=dir;
 const executable=join(dir,"fake-codex"); process.env.AGENT_CONTROL_CODEX_CLI_BIN=executable;
 writeFileSync(join(dir,"softec-yoda.config.toml"),'model="yoda"\n');
 writeFileSync(executable, `#!/usr/bin/env node
const fs=require('fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
fs.appendFileSync(${JSON.stringify(join(dir,"calls.jsonl"))},JSON.stringify({args:process.argv.slice(2),input,token:process.env.AGENT_CONTROL_TOKEN})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-1111-1111-111111111111'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'todo_list',id:'plan',items:[{text:'Write poem',completed:true}]}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',id:'message',text:'Poem'}}));
console.log(JSON.stringify({type:'turn.completed'}));
setTimeout(()=>process.exit(0),input.includes('slow')?15000:150);
});`,{mode:0o700});
});
afterEach(()=>{process.env=previous;rmSync(dir,{recursive:true,force:true});});
const input=()=>({agent:{agent_id:'agent_test',run_id:'run_test',repo_dir:dir},prompt:'poem',metadata:{profile:'softec-yoda',sandbox:'read_only'}} as any);
async function terminal(adapter: CodexCliAdapter, handle: any) {for(let i=0;i<100;i++){const state=await adapter.getStatus(handle);if(state.status!=='running')return state;await new Promise(r=>setTimeout(r,50));}throw Error('timeout');}
it('persists profile-only launch, restores plan/messages and resumes exact session',async()=>{
 process.env.AGENT_CONTROL_TOKEN='parent-secret';
 const adapter=new CodexCliAdapter(),handle=await adapter.start(input());
 expect((await terminal(adapter,handle)).status).toBe('completed');
 const restored=new CodexCliAdapter();
 expect((await restored.readLatest(handle,{limit:10})).map(m=>m.role)).toEqual(['user','tool','assistant']);
 await restored.sendMessage(handle,{message:'continue'});await terminal(restored,handle);
 const calls=readFileSync(join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 expect(handle.data.resolved_model).toBe('yoda');
 expect(calls).toHaveLength(2);expect(calls[0].args).toContain('softec-yoda');expect(calls[0].args).not.toContain('--model');expect(calls[0].token).toBeUndefined();
 expect(calls[1].args.slice(-3)).toEqual(['resume','11111111-1111-1111-1111-111111111111','-']);
 writeFileSync(join(dir,'softec-yoda.config.toml'),'model="other"');
 await expect(restored.sendMessage(handle,{message:'no'})).rejects.toThrow('profile changed');
});
it('preserves explicit model, rejects concurrency and stops only owned child',async()=>{
 const adapter=new CodexCliAdapter(),handle=await adapter.start({...input(),model:'explicit-yoda',prompt:'slow'});
 await expect(adapter.start(input())).rejects.toThrow('already has');
 await expect(adapter.sendMessage(handle,{message:'duplicate'})).rejects.toThrow('busy');
 for(let i=0;i<100 && !existsSync(join(dir,"calls.jsonl"));i++) await new Promise(r=>setTimeout(r,50));
 expect((await adapter.stop(handle,{mode:'kill'})).status).toBe('stopped');
 expect(readFileSync(join(dir,'calls.jsonl'),'utf8')).toContain('explicit-yoda');
});
it('retains only explicitly supplied worker credentials on exact-session continuation',async()=>{
 const adapter=new CodexCliAdapter(),handle=await adapter.start({...input(),agentToken:'worker-only'});
 await terminal(adapter,handle);await adapter.sendMessage(handle,{message:'continue'});await terminal(adapter,handle);
 const calls=readFileSync(join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 expect(calls.map(c=>c.token)).toEqual(['worker-only','worker-only']);
 expect(JSON.stringify(handle)).not.toContain('worker-only');
 expect((await adapter.readLatest(handle,{limit:20})).filter(m=>m.role==='assistant')).toHaveLength(2);
});
it('fails non-executions even on successful exit and reports command startup failures',async()=>{
 writeFileSync(process.env.AGENT_CONTROL_CODEX_CLI_BIN!, '#!/usr/bin/env node\nprocess.exit(0);',{mode:0o700});
 const adapter=new CodexCliAdapter(),handle=await adapter.start(input());
 expect((await terminal(adapter,handle)).status).toBe('failed');
 await expect(adapter.sendMessage(handle,{message:'no session'})).rejects.toThrow('no persisted session');
 process.env.AGENT_CONTROL_CODEX_CLI_BIN='/missing/codex';
 const second=await adapter.start({...input(),agent:{...input().agent,agent_id:'agent_second'}});
 expect((await terminal(adapter,second)).status).toBe('failed');
});
it('notifies terminal status and refuses unsupported attachments',async()=>{
 const adapter=new CodexCliAdapter();
 await expect(adapter.start({...input(),attachments:['image.png']})).rejects.toThrow('does not support attachments');
 const handle=await adapter.start(input());
 await new Promise<void>((resolve,reject)=>{
  const timeout=setTimeout(()=>{dispose();reject(Error('missing completion notification'));},4000);
  const dispose=adapter.watchStatus(handle,state=>{if(state.status==='completed'){clearTimeout(timeout);dispose();resolve();}});
 });
});
it('treats a stale supervisor heartbeat as unavailable rather than a completed/failed task',async()=>{
 const adapter=new CodexCliAdapter(),handle=await adapter.start(input());await terminal(adapter,handle);
 const path=join(String(handle.data.dir),'state.json');
 writeFileSync(path,JSON.stringify({status:'running',updated_at:new Date(0).toISOString()}));
 await expect(adapter.getStatus(handle)).rejects.toMatchObject({reason:'backend_unavailable'});
 expect((await adapter.readLatest(handle,{limit:10})).some(message=>message.text==='Poem')).toBe(true);
});

it('keeps recoverable diagnostics out of chat and available in technical logs',async()=>{
 const executable=process.env.AGENT_CONTROL_CODEX_CLI_BIN!;
 const source=readFileSync(executable,'utf8').replace("console.log(JSON.stringify({type:'turn.completed'}));", `
console.log(JSON.stringify({type:'item.completed',item:{type:'error',id:'warning',message:'Model metadata for yoda not found. Defaulting to fallback metadata'}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'future_diagnostic',id:'future',message:'Unknown non-tool event'}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',id:'command',command:'echo ok',aggregated_output:'ok'}}));
console.log(JSON.stringify({type:'turn.completed'}));`);
 writeFileSync(executable,source,{mode:0o700});
 const adapter=new CodexCliAdapter(),handle=await adapter.start(input());
 expect((await terminal(adapter,handle)).status).toBe('completed');
 const messages=await adapter.readLatest(handle,{limit:20});
 expect(messages.filter(m=>m.role==='tool').map(m=>m.metadata?.itemType)).toEqual(['todo_list','command_execution']);
 expect(JSON.stringify(messages)).not.toContain('fallback metadata');
 expect(messages.some(m=>m.text==='Poem')).toBe(true);
 expect(readFileSync(String(handle.data.logFile),'utf8')).toContain('fallback metadata');
 expect(readFileSync(join(String(handle.data.dir),'events.jsonl'),'utf8')).toContain('future_diagnostic');
});
it('renders blocking failures as short system messages, even if the CLI exits zero',async()=>{
 const executable=process.env.AGENT_CONTROL_CODEX_CLI_BIN!;
 writeFileSync(executable,readFileSync(executable,'utf8').replace("console.log(JSON.stringify({type:'turn.completed'}));", `console.log(JSON.stringify({type:'turn.failed',error:{message:'Technical provider failure'}}));
console.log(JSON.stringify({type:'turn.completed'}));`),{mode:0o700});
 const adapter=new CodexCliAdapter(),handle=await adapter.start(input());
 expect((await terminal(adapter,handle)).status).toBe('failed');
 const messages=await adapter.readLatest(handle,{limit:20});
 expect(messages.filter(m=>m.role==='system')).toHaveLength(1);
 expect(messages.at(-1)?.text).toContain('could not complete');
 expect(JSON.stringify(messages)).not.toContain('Technical provider failure');
 expect(readFileSync(String(handle.data.logFile),'utf8')).toContain('Technical provider failure');
});
it('resolves arbitrary profile names with TOML semantics without exporting credentials or overriding the profile',async()=>{
 writeFileSync(join(dir,'custom.config.toml'),`# model = "wrong"
model = 'yoda' # selected model
[model_providers.example]
model = "nested-wrong"
secret = "private-value"
`);
 const adapter=new CodexCliAdapter(),handle=await adapter.start({...input(),metadata:{profile:'custom'}});
 await terminal(adapter,handle);
 expect(handle.data.resolved_model).toBe('yoda');
 expect(handle.data.model).toBeUndefined();
 expect(JSON.stringify(handle)).not.toContain('private-value');
 const calls=JSON.parse(readFileSync(join(dir,'calls.jsonl'),'utf8').trim());
 expect(calls.args).not.toContain('--model');
 const overridden=await adapter.start({...input(),agent:{...input().agent,agent_id:'override'},model:'other',metadata:{profile:'custom'}});
 await terminal(adapter,overridden);
 expect(overridden.data.resolved_model).toBe('other');
});

it('retains a failed process turn in history after a successful continuation',async()=>{
 const executable=process.env.AGENT_CONTROL_CODEX_CLI_BIN!;
 const success=readFileSync(executable,'utf8');
 writeFileSync(executable,success.replace('process.exit(0)','process.exit(1)'),{mode:0o700});
 const adapter=new CodexCliAdapter(),handle=await adapter.start(input());
 expect((await terminal(adapter,handle)).status).toBe('failed');
 writeFileSync(executable,success,{mode:0o700});
 await adapter.sendMessage(handle,{message:'continue'});
 expect((await terminal(adapter,handle)).status).toBe('completed');
 const messages=await adapter.readLatest(handle,{limit:20});
 expect(messages.filter(m=>m.role==='system')).toHaveLength(1);
 expect(messages.at(-1)?.text).toBe('Poem');
});

it('collects cumulative CLI usage across resumed turns without charging cached input or duplicate completions',async()=>{
 const executable=process.env.AGENT_CONTROL_CODEX_CLI_BIN!;
 writeFileSync(executable,readFileSync(executable,'utf8').replace("console.log(JSON.stringify({type:'turn.completed'}));", `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:25,cached_input_tokens:80,cache_write_input_tokens:0,reasoning_output_tokens:10}}));`),{mode:0o700});
 const adapter=new CodexCliAdapter(),handle=await adapter.start(input());
 await terminal(adapter,handle);
 const once=adapter.readUsage(handle);
 expect(once).toMatchObject({input_tokens:100,output_tokens:25,total_tokens:125,cached_input_tokens:80,cache_write_input_tokens:0,reasoning_output_tokens:10,context_used:null,context_limit:null,model:'yoda'});
 expect(adapter.readUsage(handle)).toEqual(once);
 appendFileSync(join(String(handle.data.dir),'events.jsonl'),JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:25,cached_input_tokens:80,cache_write_input_tokens:0,reasoning_output_tokens:10}})+'\n');
 expect(adapter.readUsage(handle)?.total_tokens).toBe(125);
 await adapter.sendMessage(handle,{message:'continue'});await terminal(adapter,handle);
 expect(new CodexCliAdapter().readUsage(handle)).toMatchObject({input_tokens:200,output_tokens:50,total_tokens:250,cached_input_tokens:160,cache_write_input_tokens:0,reasoning_output_tokens:20});
});
it('keeps absent or malformed usage unknown and tolerates partial journal writes',()=>{
 const handle={backend:'codex-cli',id:'old',data:{dir}};
 const adapter=new CodexCliAdapter();
 expect(adapter.readUsage(handle)).toBeNull();
 writeFileSync(join(dir,'events.jsonl'),[
  {type:'agent_control.prompt'}, {type:'turn.completed'},
  {type:'turn.completed',usage:{input_tokens:-1,output_tokens:2}},
  {type:'turn.completed',usage:{input_tokens:'100',output_tokens:2}},
  {type:'turn.completed',usage:{input_tokens:1.5,output_tokens:'unknown'}}
 ].map(e=>JSON.stringify(e)).join('\n')+'\n{');
 expect(adapter.readUsage(handle)).toBeNull();
 writeFileSync(join(dir,'events.jsonl'),JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}})+'\n{');
 expect(adapter.readUsage(handle)).toMatchObject({input_tokens:0,output_tokens:0,total_tokens:0,model:null});
});

it('preserves partial counters and keeps incomplete cumulative fields unknown',()=>{
 const handle={backend:'codex-cli',id:'partial',data:{dir}};
 const adapter=new CodexCliAdapter();
 const journal=join(dir,'events.jsonl');
 const write=(events:unknown[])=>writeFileSync(journal,events.map(e=>JSON.stringify(e)).join('\n'));
 const prompt={type:'agent_control.prompt'};
 const first={type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:90}};
 write([prompt,first]);
 expect(adapter.readUsage(handle)).toMatchObject({input_tokens:100,output_tokens:null,total_tokens:null});
 write([prompt,first,prompt,{type:'turn.completed',usage:{input_tokens:50,output_tokens:10}}]);
 expect(adapter.readUsage(handle)).toMatchObject({input_tokens:150,output_tokens:null,total_tokens:null});
 write([prompt,first,prompt,{type:'turn.completed'}]);
 expect(adapter.readUsage(handle)).toBeNull();
});
