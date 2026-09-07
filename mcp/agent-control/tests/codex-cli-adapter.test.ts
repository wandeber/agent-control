import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
