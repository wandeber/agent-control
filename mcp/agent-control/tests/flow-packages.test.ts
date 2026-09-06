import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentController } from "../src/core/controller.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { artifactDigest } from "../src/core/flow-runtime.js";
import { EVENT_TYPES } from "../src/core/types.js";
import type { AgentAdapter, AgentHandle, AgentStatus, FlowConfig, StartAgentInput } from "../src/core/types.js";
import type { FlowPackagesRequest, PackageGroup } from "../src/core/flow-packages.js";
import { flowPackagesSchema } from "../src/tools/schemas.js";
import { TOOL_DEFINITIONS } from "../src/tools/tool-definitions.js";

class Fixture implements AgentAdapter {
  readonly kind = "codex-thread"; starts: StartAgentInput[] = []; statuses = new Map<string, AgentStatus>(); gate?: Promise<void>;
  capabilities() { return { canStart: true, canSendMessage: true, canReadLatest: true, canStopGracefully: true, canForceStop: true, canStreamMessages: false, canInspectStatusCheaply: true, canAttachExisting: true }; }
  async start(input: StartAgentInput): Promise<AgentHandle> { this.starts.push(input); if (input.metadata?.package_id && this.gate) await this.gate; this.statuses.set(input.agent.agent_id,"running"); return { backend:this.kind,id:input.agent.agent_id,data:{thread_id:`thread-${input.agent.agent_id}`} }; }
  async getStatus(handle: AgentHandle) { return { status:this.statuses.get(handle.id) ?? "running" as AgentStatus }; }
  async readLatest() { return []; } async sendMessage() {} async stop(handle: AgentHandle) { this.statuses.set(handle.id,"stopped");return {status:"stopped" as const}; } async unregister() {}
}
describe("durable work package fork and join", () => {
  let root: string, repo: string, db: string, controller: AgentController, store: SqliteStore, adapter: Fixture;
  let owner: ReturnType<AgentController["orchestratorLogin"]>, id: string, parentId: string;
  const git = (cwd:string,...args:string[]) => execFileSync("git",["-C",cwd,...args],{encoding:"utf8"}).trim();
  const request = (value:FlowPackagesRequest, worker=false) => controller.executeFlowPackages({flowInstanceId:id,request:value,...(worker?{}:{agentToken:owner.agent_token})});
  const group = () => controller.getFlowSnapshot(id).runtime!.packages!;
  function actor(agentId:string) { vi.stubEnv("CODEX_THREAD_ID",`thread-${agentId}`); }
  async function dispatch() { const result = await controller.dispatchActiveFlowStep({flowInstanceId:id,agentToken:owner.agent_token}); actor(result.agent!.agent_id); return result; }
  function report() { const step=controller.getFlowSnapshot(id).steps.find(s=>s.status==="active")!; return controller.reportFlowStep({stepInstanceId:step.step_instance_id,status:"completed"}); }
  function config():FlowConfig { return {id:"packages",policy:{strict:true,plan_artifact:"plan",work_packages:{approval_decision:"plan",manifest_step:"review",execution_step:"implementation",integration_step:"integration"}},initial_step:"draft",roles:{planner:{backend:"codex-thread"},implementer:{backend:"codex-thread",model:"gpt-5.6-luna",reasoning_effort:"max"}},artifacts:{plan:{path:join(repo,"plan.md")}},steps:{
    draft:{role:"planner",outputs:{plan:{artifact:"plan",required:true}},on:{completed:{to:"review"}}},
    review:{role:"planner",on:{completed:{to:"approval"}}},
    approval:{execution:"coordinator",decision:{key:"plan",artifact_key:"plan"},on:{completed:{to:"implementation"}}},
    implementation:{role:"implementer",on:{completed:{transitions:[{id:"packages",when:{equals:{var:"packages.integration_required",value:true}},to:"integration"},{id:"inline",finish:true}]}}},
    integration:{role:"implementer",requires:{equals:{var:"packages.joined",value:true}},evidence_operations:["prepare_result"],on:{completed:{finish:true}}}
  }}; }
  beforeEach(async()=>{
    root=mkdtempSync(join(tmpdir(),"flow-packages-"));repo=join(root,"repo");mkdirSync(repo);db=join(root,"state.sqlite");
    vi.stubEnv("AGENT_CONTROL_HOME",join(root,"runtime"));vi.stubEnv("AGENT_CONTROL_ADMIN_KEY","fixture");vi.stubEnv("CODEX_THREAD_ID","");vi.stubEnv("AGENT_CONTROL_REQUESTER_THREAD_ID","");
    git(repo,"init","-q");git(repo,"config","user.email","fixture@example.invalid");git(repo,"config","user.name","Fixture");
    writeFileSync(join(repo,"plan.md"),"# Plan\n\n<!-- hdt-section: packages -->\n## Packages\n\nUpdate a and b independently.\n");writeFileSync(join(repo,"a.txt"),"a\n");writeFileSync(join(repo,"b.txt"),"b\n");git(repo,"add",".");git(repo,"commit","-qm","base");
    for(const branch of ["a","b"]) git(repo,"worktree","add","--quiet","--detach",join(root,branch),"HEAD");
    adapter=new Fixture();store=new SqliteStore(db);const adapters=new AdapterRegistry();adapters.register(adapter);controller=new AgentController(store,adapters);
    owner=controller.orchestratorLogin({adminKey:"fixture",title:"Owner",runTitle:"Implement approved packages",repoDir:repo,backend:"codex-thread",backendHandle:{thread_id:"owner-thread"}});
    const started=controller.startFlow({config:config(),runId:owner.run.run_id,agentToken:owner.agent_token,requesterThreadId:"original-user"});id=started.instance.flow_instance_id;
    await dispatch();report();await dispatch();
  });
  afterEach(async()=>{await controller.dispose();store.close();rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs();});
  async function approve(packages=entries()) {
    await request({operation:"define",packages});report();
    const snapshot=controller.getFlowSnapshot(id);controller.recordFlowDecision({flowInstanceId:id,key:"plan",value:"approved",reason:"Approved exact plan and work packages",expectedRevision:snapshot.runtime!.revision,artifactDigest:artifactDigest(join(repo,"plan.md")),packageManifestDigest:group().manifest_digest,agentToken:owner.agent_token});
    parentId=(await dispatch()).agent!.agent_id;
  }
  function entries(dependent=false) {return ["a","b"].map(name=>({id:name,title:`Package ${name}`,role:"implementer",worktree:join(root,name),paths:[`${name}.txt`],deliverables:[`${name}.txt`],depends_on:dependent&&name==="b"?["a"]:[]}));}
  async function deliver(name:string,value=`${name} changed\n`) {
    const branch=group().branches[name]!;writeFileSync(join(root,name,`${name}.txt`),value);actor(branch.agent_id!);
    const result=await request({operation:"deliver",package_id:name,attempt:branch.attempt,summary:`Delivered ${name}`},true);return result.branches[name]!.delivery!;
  }
  async function accept(names:string[]) { for(const name of names)adapter.statuses.set(group().branches[name]!.agent_id!,"completed"); return request({operation:"accept",deliveries:names.map(name=>({package_id:name,delivery_id:group().branches[name]!.delivery!.delivery_id})),reason:"Delivery meets its assigned package."}); }
  it("binds scope before exact approval and preserves the inline path",async()=>{
    await request({operation:"define",packages:[]});report();const snapshot=controller.getFlowSnapshot(id);
    expect(()=>controller.recordFlowDecision({flowInstanceId:id,key:"plan",value:"approved",reason:"Approved",expectedRevision:snapshot.runtime!.revision,artifactDigest:artifactDigest(join(repo,"plan.md")),agentToken:owner.agent_token})).toThrow(/manifest digest/);
    controller.recordFlowDecision({flowInstanceId:id,key:"plan",value:"approved",reason:"Approved",expectedRevision:snapshot.runtime!.revision,artifactDigest:artifactDigest(join(repo,"plan.md")),packageManifestDigest:group().manifest_digest,agentToken:owner.agent_token});
    await dispatch();expect(report().instance.status).toBe("completed");
  });
  it("launches two branches concurrently once, blocks premature join, and verifies consolidation",async()=>{
    await approve();let release!:()=>void;adapter.gate=new Promise<void>(r=>release=r);const pending=request({operation:"launch"});
    await vi.waitFor(()=>expect(adapter.starts.filter(s=>s.metadata?.package_id)).toHaveLength(2));
    await request({operation:"launch"});expect(adapter.starts.filter(s=>s.metadata?.package_id)).toHaveLength(2);release();await pending;adapter.gate=undefined;
    for (const branch of Object.values(group().branches)) { expect(branch.step_id).toBe("implementation"); expect(branch.parent_agent_id).toBe(parentId); expect(controller.listAgentLinks({runId:owner.run.run_id}).some(link=>link.source_agent_id===parentId && link.target_agent_id===branch.agent_id && link.type==="parent_child")).toBe(true); }
    expect(controller.ensureRequester(owner.run.run_id).observer_agent_id).toBe(controller.getFlowSnapshot(id).runtime!.decision_owners!.requester);
    actor(parentId);expect(()=>report()).toThrow(/join/);
    await expect(controller.startFlowStep({flowInstanceId:id,stepId:"integration",agentToken:owner.agent_token})).rejects.toThrow(/decision or milestone/);
    const a=await deliver("a");await expect(request({operation:"accept",deliveries:[{package_id:"a",delivery_id:a.delivery_id}],reason:"yes"})).rejects.toThrow(/inactive/);
    await deliver("b");await accept(["a","b"]);actor(parentId);expect(report().instance.current_step_id).toBe("integration");await dispatch();
    expect(()=>report()).toThrow(/integration receipt/);
    writeFileSync(join(repo,"a.txt"),readFileSync(join(root,"a","a.txt")));
    let receipt=await controller.executeFlowEvidence({flowInstanceId:id,key:"integration",request:{operation:"prepare_result",checkpoint_id:"premature",plan_path:join(repo,"plan.md"),paths:["a.txt"]}});
    await expect(request({operation:"integrate",result_receipt_id:receipt.receipt_id})).rejects.toThrow(/Consolidated result/);
    for(const name of ["a","b"])writeFileSync(join(repo,`${name}.txt`),readFileSync(join(root,name,`${name}.txt`)));
    receipt=await controller.executeFlowEvidence({flowInstanceId:id,key:"integration",request:{operation:"prepare_result",checkpoint_id:"consolidated",plan_path:join(repo,"plan.md"),paths:["a.txt","b.txt"]}});
    const alternateBase=git(repo,"commit-tree","HEAD^{tree}","-m","Alternate package base");
    const wrongBase=await controller.executeFlowEvidence({flowInstanceId:id,key:"wrong_base",request:{operation:"prepare_result",checkpoint_id:"wrong-base",plan_path:join(repo,"plan.md"),paths:["a.txt","b.txt"],base:alternateBase}});
    await expect(request({operation:"integrate",result_receipt_id:wrongBase.receipt_id})).rejects.toThrow(/base commit/);
    const integrated=await request({operation:"integrate",result_receipt_id:receipt.receipt_id});expect(integrated.integration!.delivery_ids).toHaveLength(2);
    const recordPath=integrated.integration!.path,recordBytes=readFileSync(recordPath);chmodSync(recordPath,0o644);writeFileSync(recordPath,"{}");
    await expect(request({operation:"integrate",result_receipt_id:receipt.receipt_id})).rejects.toThrow(/integrity/);
    rmSync(recordPath);await expect(request({operation:"integrate",result_receipt_id:receipt.receipt_id})).rejects.toThrow(/ENOENT/);
    writeFileSync(recordPath,recordBytes);expect(report().instance.status).toBe("completed");
  },30000);
  it("does not treat cancellation of an in-flight start as proof that it is inactive",async()=>{
    await approve([entries()[0]!]);let release!:()=>void;adapter.gate=new Promise<void>(r=>release=r);const pending=request({operation:"launch"});
    await vi.waitFor(()=>expect(adapter.starts.filter(s=>s.metadata?.package_id)).toHaveLength(1));
    await request({operation:"cancel",package_id:"a",attempt:1,reason:"Stop this branch"});
    await expect(request({operation:"retry",package_id:"a",attempt:1,reason:"Start again"})).rejects.toThrow(/settle/);
    release();await pending;adapter.gate=undefined;expect(group().branches.a!.state).toBe("cancelled");
    expect(adapter.starts.filter(s=>s.metadata?.package_id)).toHaveLength(1);
  });
  it("recovers a cancelled late start only from matching durable compensating-stop evidence",async()=>{
    await approve([entries()[0]!]);let release!:()=>void;adapter.gate=new Promise<void>(r=>release=r);const pending=request({operation:"launch"});
    await vi.waitFor(()=>expect(adapter.starts.filter(s=>s.metadata?.package_id)).toHaveLength(1));
    await request({operation:"cancel",package_id:"a",attempt:1,reason:"Cancel in-flight branch"});
    const crashState=controller.getFlowSnapshot(id).runtime!;expect(crashState.packages!.branches.a!.launch_settled).toBe(false);
    release();await pending;adapter.gate=undefined;const child=group().branches.a!.agent_id!;
    expect(controller.getAgent(child).status).toBe("stopped");
    // Keep the durable backend stop, but cut off the final package callback.
    store.db.prepare("update flow_runtime set state_json=? where flow_instance_id=?").run(JSON.stringify(crashState),id);
    await controller.dispose();store.close();store=new SqliteStore(db);const adapters=new AdapterRegistry();adapters.register(adapter);controller=new AgentController(store,adapters);
    const stop=store.listEvents({agentId:child,type:"agent.stopped"}).find(e=>e.payload.reason==="compensating_stop_after_late_start")!;
    expect(stop.payload.work_generation).toBe(controller.getAgent(child).work_generation);
    const stopBody=JSON.stringify(stop.payload);store.db.prepare("update events set payload_json=? where event_id=?").run(JSON.stringify({...stop.payload,work_generation:0}),stop.event_id);
    await expect(request({operation:"retry",package_id:"a",attempt:1,reason:"Retry confirmed stopped attempt"})).rejects.toThrow(/settle/);
    expect(adapter.starts.filter(s=>s.metadata?.package_id)).toHaveLength(1);
    store.db.prepare("update events set payload_json=? where event_id=?").run(stopBody,stop.event_id);
    await request({operation:"retry",package_id:"a",attempt:1,reason:"Retry confirmed stopped attempt"});
    expect(group().branches.a!.attempt).toBe(2);expect(group().branches.a!.prior_attempts![0]!.launch_settled).toBe(true);
    expect(adapter.starts.filter(s=>s.metadata?.package_id)).toHaveLength(2);
  });
  it("subscribes the launching worker before dispatch and resumes through explicit bound ACKs",async()=>{
    await approve();actor(parentId);const original=controller.ensureRequester(owner.run.run_id).observer_agent_id;
    let observedBeforeDispatch=false;const nativeStart=adapter.start.bind(adapter);adapter.start=async input=>{if(input.metadata?.package_id) observedBeforeDispatch=Boolean(store.db.prepare("select 1 from run_observers where run_id=? and thread_id=?").get(owner.run.run_id,`thread-${parentId}`));return nativeStart(input);};
    const launched=await request({operation:"launch"},true),observer=launched.coordinator_observer!;
    expect(observedBeforeDispatch).toBe(true);expect(observer.observer_agent_id).not.toBe(parentId);expect(observer.observer_agent_id).not.toBe(original);
    expect(observer.event_types).toEqual(EVENT_TYPES);expect(controller.getAgent(parentId).backend_handle?.agent_control_role).not.toBe("observer");
    expect(controller.ensureRequester(owner.run.run_id).observer_agent_id).toBe(original);
    expect(launched.wait_contract).toMatchObject({tool:"flow_packages",arguments:{flow_instance_id:id,request:{operation:"wait",timeout_ms:3600000}}});
    expect(observer.wait_contract.tool).toBe("flow_packages");
    type Batch={events:Array<{event_id:string;type:string}>,cursor:string,processed_cursor:string,timed_out:boolean,ack_contract?:{tool:string;arguments:{request:{operation:string;cursor:string}}},wait_contract:{tool:string}};
    const wait=()=>controller.executeFlowPackages({flowInstanceId:id,request:{operation:"wait",timeout_ms:1}}) as Promise<Batch>;
    const batch=await wait();expect(batch.events.some(e=>e.type==="agent.started")).toBe(true);expect(batch.ack_contract!.tool).toBe("flow_packages");expect(batch.ack_contract!.arguments.request).toEqual({operation:"ack",cursor:batch.cursor});
    expect(batch.processed_cursor).toBe(observer.processed_cursor);expect((await wait()).events).toEqual(batch.events);
    await expect(controller.executeFlowPackages({flowInstanceId:id,request:{operation:"ack",cursor:batch.cursor},agentToken:"invalid-token"})).rejects.toThrow();
    await expect(controller.executeFlowPackages({flowInstanceId:id,request:{operation:"ack",cursor:batch.cursor},agentToken:owner.agent_token})).rejects.toThrow(/cursor/i);
    await controller.executeFlowPackages({flowInstanceId:id,request:{operation:"ack",cursor:batch.cursor}});
    const resumed=await wait();expect(resumed.events).toEqual([]);expect(resumed.timed_out).toBe(true);expect(resumed.wait_contract.tool).toBe("flow_packages");
    const abort=new AbortController();abort.abort();await expect(controller.executeFlowPackages({flowInstanceId:id,request:{operation:"wait"},signal:abort.signal})).rejects.toThrow();
    expect(controller.ensureRequester(owner.run.run_id).observer_agent_id).toBe(original);
  });
  it("releases dependency successors in the batch acceptance call",async()=>{
    await approve(entries(true));await request({operation:"launch"});expect(group().branches.b!.agent_id).toBeUndefined();await deliver("a");await accept(["a"]);expect(group().branches.b!.state).toBe("running");
    expect(adapter.starts.filter(s=>s.metadata?.package_id)).toHaveLength(2);
  });
  it("rejects wrong owners, conflicting retries and writes outside scope",async()=>{
    await approve();await request({operation:"launch"});actor(parentId);await expect(request({operation:"deliver",package_id:"a",attempt:1,summary:"forged"},true)).rejects.toThrow(/assigned worker/);
    writeFileSync(join(root,"a","b.txt"),"outside");actor(group().branches.a!.agent_id!);await expect(request({operation:"deliver",package_id:"a",attempt:1,summary:"bad"},true)).rejects.toThrow(/outside/);writeFileSync(join(root,"a","b.txt"),"b\n");
    const receipt=await deliver("a");expect((await request({operation:"deliver",package_id:"a",attempt:1,summary:"Delivered a"},true)).branches.a!.delivery!.delivery_id).toBe(receipt.delivery_id);
    await expect(request({operation:"deliver",package_id:"a",attempt:1,summary:"different"},true)).rejects.toThrow(/conflicting/);
    expect(()=>controller.reportFlowStep({stepInstanceId:controller.getFlowSnapshot(id).steps.find(s=>s.status==="active")!.step_instance_id,status:"completed"})).toThrow();
  });
  it("reconciles terminal missing deliveries, retries generations, and rejects stale authors",async()=>{
    await approve();await request({operation:"launch"});const old=group().branches.a!;adapter.statuses.set(old.agent_id!,"failed");await controller.pollActiveAgents(owner.run.run_id);expect(group().branches.a!.state).toBe("failed");
    await request({operation:"retry",package_id:"a",attempt:1,reason:"Retry failed attempt"});expect(group().branches.a!.attempt).toBe(2);expect(group().branches.a!.agent_id).toBe(old.agent_id);
    actor(old.agent_id!);await expect(request({operation:"deliver",package_id:"a",attempt:1,summary:"old"},true)).rejects.toThrow(/obsolete/);
    const count=adapter.starts.length;await request({operation:"retry",package_id:"a",attempt:1,reason:"Retry failed attempt"});expect(adapter.starts).toHaveLength(count);
  });
  it("retains accepted deliveries across controller restart and rejects plan drift",async()=>{
    await approve();await request({operation:"launch"});await deliver("a");await deliver("b");await accept(["a","b"]);
    const previous=group();await controller.dispose();store.close();store=new SqliteStore(db);const adapters=new AdapterRegistry();adapters.register(adapter);controller=new AgentController(store,adapters);
    expect(group().manifest_digest).toBe(previous.manifest_digest);await request({operation:"launch"});expect(adapter.starts.filter(s=>s.metadata?.package_id)).toHaveLength(2);
    writeFileSync(join(repo,"plan.md"),"Changed unreported plan");actor(parentId);expect(()=>report()).toThrow(/outside its producing report/);
  });
  it("recovers an accepted backend launch after restart without issuing another start",async()=>{
    await approve();await request({operation:"launch"});const state=controller.getFlowSnapshot(id).runtime!;
    const branch=state.packages!.branches.a!;branch.state="invoking";branch.work_generation=0;branch.prior_start_event_id=null;branch.launch_lease_expires_at=new Date(0).toISOString();
    store.db.prepare("update flow_runtime set state_json=? where flow_instance_id=?").run(JSON.stringify(state),id);
    await controller.dispose();store.close();store=new SqliteStore(db);const adapters=new AdapterRegistry();adapters.register(adapter);controller=new AgentController(store,adapters);
    const count=adapter.starts.length;await request({operation:"launch"});expect(group().branches.a!.state).toBe("running");expect(adapter.starts).toHaveLength(count);
  });
  it("keeps an expired launch without backend acceptance uncertain instead of replaying it",async()=>{
    await approve();const state=controller.getFlowSnapshot(id).runtime!;const branch=state.packages!.branches.a!;
    const child=controller.registerAgent({runId:owner.run.run_id,backend:"codex-thread",title:"Interrupted package a",repoDir:join(root,"a"),agentToken:owner.agent_token});
    branch.state="invoking";branch.agent_id=child.agent_id;branch.work_generation=0;branch.launch_lease_expires_at=new Date(0).toISOString();
    store.db.prepare("update flow_runtime set state_json=? where flow_instance_id=?").run(JSON.stringify(state),id);
    await request({operation:"launch"});expect(group().branches.a!.state).toBe("uncertain");expect(adapter.starts.filter(s=>s.agent.agent_id===child.agent_id)).toHaveLength(0);
    actor(parentId);expect(()=>report()).toThrow(/join/);
  });
  it("represents deletion-only delivery and rejects dangling symlinks",async()=>{
    await approve([entries()[0]!]);await request({operation:"launch"});const branch=group().branches.a!;actor(branch.agent_id!);
    rmSync(join(root,"a","a.txt"));symlinkSync("missing-target",join(root,"a","a.txt"));
    await expect(request({operation:"deliver",package_id:"a",attempt:1,summary:"Delete a"},true)).rejects.toThrow(/symbolic links/);
    rmSync(join(root,"a","a.txt"));const deleted=await request({operation:"deliver",package_id:"a",attempt:1,summary:"Delete a"},true);
    expect(deleted.branches.a!.delivery!.files).toEqual([{path:"a.txt",sha256:null,mode:null}]);
    await accept(["a"]);actor(parentId);report();await dispatch();rmSync(join(repo,"a.txt"));
    const receipt=await controller.executeFlowEvidence({flowInstanceId:id,key:"deletion",request:{operation:"prepare_result",checkpoint_id:"deletion",plan_path:join(repo,"plan.md"),paths:["a.txt"],base:group().base_commit}});
    await request({operation:"integrate",result_receipt_id:receipt.receipt_id});expect(report().instance.status).toBe("completed");
  },30000);
  it("invalidates dependent acceptances and requeues their generations after cancellation",async()=>{
    const definitions=entries(true);await approve([{...definitions[0]!,required:false},definitions[1]!]);await request({operation:"launch"});await deliver("a");await accept(["a"]);await deliver("b");await accept(["b"]);
    await request({operation:"cancel",package_id:"a",attempt:1,reason:"Correct upstream assumption"});expect(group().branches.b!.state).toBe("cancelled");actor(parentId);expect(()=>report()).toThrow(/join/);
    await request({operation:"retry",package_id:"a",attempt:1,reason:"Fix the upstream behavior"});expect(group().branches.a!.attempt).toBe(2);expect(group().branches.b!.attempt).toBe(2);expect(group().branches.b!.state).toBe("pending");
    const start=adapter.starts.filter(s=>s.metadata?.package_id==="a").at(-1)!;expect(start.metadata?.reasoning_effort).toBe("max");expect(start.prompt).toContain("Fix the upstream behavior");
    await deliver("a","a corrected\n");await accept(["a"]);expect(group().branches.b!.state).toBe("running");expect(group().branches.b!.dependency_delivery_ids).toEqual([group().branches.a!.delivery!.delivery_id]);
  });
  it("preserves local consolidated changes rather than silently forking a stale HEAD",async()=>{
    writeFileSync(join(repo,"a.txt"),"Uncommitted local work\n");
    await expect(request({operation:"define",packages:entries()})).rejects.toThrow(/clean committed consolidated baseline/);
    expect(readFileSync(join(repo,"a.txt"),"utf8")).toBe("Uncommitted local work\n");
    expect((await request({operation:"define",packages:[]})).manifest).toEqual([]);
  });
  it("rejects altered manifest fields even when the stored approval hash was retained",async()=>{
    await approve();const state=controller.getFlowSnapshot(id).runtime!;state.packages!.manifest[0]!.required=false;
    store.db.prepare("update flow_runtime set state_json=? where flow_instance_id=?").run(JSON.stringify(state),id);
    await expect(request({operation:"launch"})).rejects.toThrow(/manifest integrity/);
  });
  it("rejects overlapping writes, shared worktrees and postapproval manifest rewrites",async()=>{
    await expect(request({operation:"define",packages:[entries()[0]!,{...entries()[1]!,paths:["a.txt"],deliverables:["a.txt"]}]})).rejects.toThrow(/disjoint/);
    await expect(request({operation:"define",packages:[entries()[0]!,{...entries()[1]!,worktree:join(root,"a")}]})).rejects.toThrow(/distinct/);
    await approve();await expect(request({operation:"define",packages:[]})).rejects.toThrow(/manifest review|immutable/);
  });
  it("validates the compact public operation schema",()=>{
    expect(flowPackagesSchema.safeParse({flow_instance_id:id,request:{operation:"deliver",package_id:"a",attempt:1,summary:"done",agent_id:"spoof"}}).success).toBe(false);
    const tool=TOOL_DEFINITIONS.find(t=>t.name==="flow_packages")!;expect(JSON.stringify(tool.inputSchema)).toContain("integrate");expect(JSON.stringify(tool.inputSchema)).not.toContain('"$ref"');
  });
});
