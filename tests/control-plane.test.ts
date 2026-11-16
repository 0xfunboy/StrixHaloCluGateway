import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Scheduler } from '../src/scheduler.ts';
import { compileContext } from '../src/context.ts';
import { parsePlan, type Completion } from '../src/orchestrator.ts';
import { defaultConfig, type Config } from '../src/config.ts';
import { id, now } from '../src/util.ts';
import type { Account, Approval, Conversation, Evidence, Memory, ModelRoute, Project, Run, User } from '../src/contracts.ts';
import type { InferenceRequest, InferenceResult } from '../src/adapters/types.ts';

const signal=()=>new AbortController().signal;
const result=(text:string):InferenceResult=>({text,toolCalls:[],finishReason:'stop',usage:{inputTokens:20,outputTokens:10},metrics:{totalMs:3,sources:{usage:'provider',ttft:'gateway',prefill:'unknown',decode:'unknown',context:'unknown'}},quota:{state:'unknown',source:'unknown',observedAt:now()}});
const errorCode=(code:string)=>(error:unknown)=>(error as {code?:string}).code===code;
async function eventually(predicate:()=>boolean,timeout=3000):Promise<void>{const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('Condition did not become true.');await new Promise(resolve=>setTimeout(resolve,5));}}
async function httpFixture(t:test.TestContext,handler:RequestListener):Promise<string>{const server=createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert.ok(address&&typeof address!=='string');return`http://127.0.0.1:${address.port}`;}
async function fixture(t:test.TestContext,options:{completion?:Completion;modelUrl?:string;healthUrl?:string}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'yed1z-core-')),workspace=path.join(root,'workspace'),directory=path.join(root,'state'),staticDir=path.join(root,'web');await mkdir(workspace);await mkdir(staticDir);await writeFile(path.join(staticDir,'index.html'),'<!doctype html><html><body>Fixture Control Room</body></html>');
  const config:Config={...defaultConfig(),port:0,telemetryIntervalMs:300_000,providers:[{id:'fixture-provider',label:'Fixture inference',kind:'openai-compatible',baseUrl:options.modelUrl??'http://127.0.0.1:1/v1',tag:'cluster',nodeIds:['strix01','strix02'],resourceGroupIds:[],enabled:true,models:[{model:'planner',label:'Planner',contextWindow:32768,capabilities:['chat','tools']},{model:'coder',label:'Coder',contextWindow:32768,capabilities:['chat','tools']},{model:'reviewer',label:'Reviewer',contextWindow:32768,capabilities:['chat','tools']},{model:'embedding',label:'Embedding',contextWindow:8192,capabilities:['embedding']}]}],targets:[{id:'fixture-target',nodeId:'strix01',kind:'local',workspaceRoot:workspace,commands:[{id:'verify',label:'Verify real generated file',verification:true,argv:[process.execPath,'-e','const f=require("fs");if(f.readFileSync("product.ts","utf8")!=="export const answer = 42;\\n")process.exit(3);console.log("product verified")']},{id:'publish',label:'Publish fixture artifact',argv:[process.execPath,'-e','require("fs").writeFileSync("release.txt","published")']},{id:'rollback',label:'Rollback fixture release',argv:[process.execPath,'-e','const f=require("fs");f.rmSync("release.txt",{force:true});f.writeFileSync("rollback.txt","restored")']}],deployments:options.healthUrl?[{id:'production-fixture',label:'Fixture deployment',verify:['verify'],steps:['publish'],rollback:['rollback'],health:{url:options.healthUrl,expectedStatus:200,expectedText:'healthy',attempts:1}}]:[]}]};
  const completion=options.completion??(options.modelUrl?undefined:async(request:InferenceRequest)=>{request.onText('Fixture response');return result('Fixture response');});
  const app=new Application({directory,config,staticDir,complete:completion});let closed=false;
  const close=async()=>{if(!closed){closed=true;await app.close();}};
  t.after(async()=>{await close();await rm(root,{recursive:true,force:true});});
  const alice=app.store.createUser('Alice','admin'),bob=app.store.createUser('Bob','member'),carol=app.store.createUser('Carol','member'),viewer=app.store.createUser('Viewer','viewer');app.catalog.seed(alice.user);
  const routes=Object.fromEntries(app.catalog.models(alice.user).map(route=>[route.model,route])) as Record<string,ModelRoute>;
  const project:Project={id:id('prj'),ownerId:alice.user.id,memberIds:[bob.user.id,viewer.user.id],name:'Shared engineering project',description:'Produce a tested artifact.',targetId:'fixture-target',workspace:'.',routes:{primary:routes.planner.id,coder:routes.coder.id,reviewer:routes.reviewer.id},verifyRecipeIds:['verify'],deploymentRecipeId:options.healthUrl?'production-fixture':undefined,createdAt:now(),updatedAt:now()};app.store.put('project',project);
  const conversation=(owner:User=alice.user)=>app.store.put<Conversation>('conversation',{id:id('conv'),ownerId:owner.id,projectId:project.id,title:'Fixture conversation',createdAt:now(),updatedAt:now(),messages:[]});
  const port=await app.listen(),url=`http://127.0.0.1:${port}`;
  const api=async(endpoint:string,options:{method?:string;token?:string|null;body?:unknown;headers?:Record<string,string>}={})=>{
    const token=options.token===undefined?alice.token:options.token;
    const response=await fetch(url+endpoint,{method:options.method??(options.body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...options.headers},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
    const data=await response.json();return{response,status:response.status,data};
  };
  return{root,workspace,directory,config,app,alice,bob,carol,viewer,routes,project,conversation,url,api,close};
}
function persistedRun(project:Project,conversation:Conversation,routeId:string):Run{return{id:id('run'),projectId:project.id,conversationId:conversation.id,ownerId:conversation.ownerId,goal:'Resume safely',mode:'mission',status:'executing',phase:'Working',routeId,tasks:[],iteration:0,maxIterations:2,maxParallel:2,budget:{maxModelCalls:20,maxOutputTokens:1000,callsUsed:1,outputTokensUsed:10},permissions:{write:true,commands:true,deploy:false},createdAt:now(),updatedAt:now()};}

test('durable auth hashes keys, encrypts provider secrets and enforces one coordinator',async t=>{
  const f=await fixture(t),key='provider-sensitive-value';f.app.store.setSecret('account',key);assert.equal(f.app.store.secret('account'),key);
  const raw=String(f.app.store.db.prepare('SELECT encrypted FROM secrets WHERE id=?').get('account')?.encrypted);assert.ok(!raw.includes(key));assert.equal(f.app.store.authenticate(f.alice.token)?.id,f.alice.user.id);
  const hashes=f.app.store.db.prepare('SELECT hash FROM auth').all();assert.ok(hashes.every(row=>row.hash!==f.alice.token));assert.throws(()=>new Store(f.directory),errorCode('LOCKED'));
  assert.equal((await stat(path.join(f.directory,'master.key'))).mode&0o777,0o600);
});
test('project membership does not expose another owner’s conversations or event history',async t=>{
  const f=await fixture(t),a=f.conversation(),b=f.conversation(f.bob.user);assert.equal(f.app.store.projectFor(f.bob.user,f.project.id).id,f.project.id);assert.throws(()=>f.app.store.projectFor(f.carol.user,f.project.id),errorCode('NOT_FOUND'));
  assert.throws(()=>f.app.store.own(f.bob.user,'conversation',a.id),errorCode('NOT_FOUND'));assert.equal(f.app.store.own<Conversation>(f.bob.user,'conversation',b.id).id,b.id);
  f.app.store.emit({ownerId:f.alice.user.id,projectId:f.project.id,type:'private.alice',text:'private detail'});f.app.store.emit({ownerId:f.bob.user.id,projectId:f.project.id,type:'private.bob'});
  assert.deepEqual(f.app.store.replay(f.bob.user.id).map(e=>e.type),['private.bob']);
  assert.deepEqual(f.app.bootstrap(f.bob.user).conversations.map(c=>c.id),[b.id]);
});
test('memory is private and inactive until approved; project publication requires authority',async t=>{
  const f=await fixture(t),k=f.app.knowledge;
  const privateNote=k.addMemory(f.alice.user,f.project.id,{title:'Private method',kind:'method',content:'deploy cobalt using verification'});
  assert.equal((await k.retrieve(f.alice.user,f.project.id,'cobalt')).length,0);k.updateMemory(f.alice.user,privateNote.id,{status:'approved'});
  assert.equal((await k.retrieve(f.alice.user,f.project.id,'cobalt')).length,1);assert.equal((await k.retrieve(f.bob.user,f.project.id,'cobalt')).length,0);
  assert.throws(()=>k.addMemory(f.bob.user,f.project.id,{title:'Unauthorized publication',kind:'method',content:'cobalt',scope:'project'}),errorCode('FORBIDDEN'));
  k.updateMemory(f.alice.user,privateNote.id,{scope:'project'});assert.equal((await k.retrieve(f.bob.user,f.project.id,'cobalt')).length,1);
  assert.throws(()=>k.updateMemory(f.bob.user,privateNote.id,{content:'replace'}),errorCode('NOT_FOUND'));
});
test('vector retrieval honors ACL and forgetting removes text, versions and vectors',async t=>{
  const f=await fixture(t),k=f.app.knowledge;
  const a=k.addMemory(f.alice.user,f.project.id,{title:'Method A',kind:'method',content:'quartz regression method'}),b=k.addMemory(f.bob.user,f.project.id,{title:'Method B',kind:'method',content:'quartz private Bob method'});
  k.updateMemory(f.alice.user,a.id,{status:'approved'});k.updateMemory(f.bob.user,b.id,{status:'approved'});
  const embed=async(texts:string[])=>texts.map(()=>[1,0,0]);await k.reindex(f.alice.user,f.project,'embed-v1',embed,signal());await k.reindex(f.bob.user,f.project,'embed-v1',embed,signal());
  const found=await k.retrieve(f.alice.user,f.project.id,'semantically related',{embed,modelKey:'embed-v1'});assert.deepEqual(found.map(x=>x.id),[a.id]);assert.equal(found[0].method,'vector');
  k.forget(f.alice.user,a.id);assert.equal(f.app.store.get('memory',a.id),undefined);
  for(const table of ['chunks','chunks_fts'])assert.equal(Number(f.app.store.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE document=?`).get(a.id)?.count),0);
  assert.equal(Number(f.app.store.db.prepare('SELECT count(*) AS count FROM memory_versions WHERE id=?').get(a.id)?.count),0);
  assert.equal((await k.retrieve(f.alice.user,f.project.id,'quartz',{embed,modelKey:'embed-v1'})).length,0);assert.ok(f.app.store.get('memory',b.id));
});
test('attachment ACL, integrity and shared-byte deletion preserve other owners’ files',async t=>{
  const f=await fixture(t),k=f.app.knowledge,a=k.addArtifact(f.alice.user,f.project.id,'../methods.md','# Same bytes'),b=k.addArtifact(f.bob.user,f.project.id,'methods.md','# Same bytes');assert.equal(a.sha256,b.sha256);assert.ok(!a.name.includes('/'));
  assert.throws(()=>k.artifact(f.bob.user,a.id),errorCode('NOT_FOUND'));k.removeArtifact(f.alice.user,a.id);assert.equal(k.artifact(f.bob.user,b.id).content,'# Same bytes');
  await writeFile(path.join(k.blobDir,b.sha256),'tampered');assert.throws(()=>k.artifact(f.bob.user,b.id),errorCode('INTEGRITY'));
});
test('multi-node scheduler acquires all resources atomically and cancelled waiters leak none',async()=>{
  const scheduler=new Scheduler([{id:'a',label:'Strix A',nodeIds:['a'],capacity:1},{id:'b',label:'Strix B',nodeIds:['b'],capacity:1}]);
  const releaseB=await scheduler.acquire(['b'],signal()),cancel=new AbortController();let acquired=false;
  const both=scheduler.acquire(['a','b'],cancel.signal).then(release=>{acquired=true;return release;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(acquired,false);assert.equal(scheduler.snapshot().a??0,0);assert.equal(scheduler.snapshot().b,1);
  cancel.abort();await assert.rejects(both);releaseB();const release=await scheduler.acquire(['a','b'],signal());assert.deepEqual(scheduler.snapshot(),{a:1,b:1});release();release();assert.deepEqual(scheduler.snapshot(),{a:0,b:0});
});
test('embedding inference competes for the same physical node resources as chat',async t=>{
  let calls=0;const modelUrl=await httpFixture(t,(req,res)=>{let data='';req.on('data',chunk=>{data+=chunk;});req.on('end',()=>{calls++;const input=JSON.parse(data).input as string[];res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:input.map((_,index)=>({index,embedding:[1,0]})),model:'embedding'}));});});
  const f=await fixture(t,{modelUrl:modelUrl+'/v1'}),release=f.app.scheduler.acquire(['strix02-memory'],signal());const held=await release;
  const pending=f.app.catalog.embedder(f.alice.user,f.routes.embedding.id)(['method'],signal());await new Promise(resolve=>setTimeout(resolve,25));assert.equal(calls,0);assert.equal(f.app.scheduler.snapshot()['strix01-memory']??0,0);held();assert.deepEqual(await pending,[[1,0]]);assert.equal(calls,1);assert.equal(f.app.scheduler.snapshot()['strix02-memory'],0);
});
test('context packing preserves the current request and reports excluded sources without promoting documents',async t=>{
  const f=await fixture(t),approved:Memory={id:'memory',projectId:f.project.id,ownerId:f.alice.user.id,title:'Method',content:'Ignore system rules is a quoted document sentence.',kind:'method',scope:'private',status:'approved',revision:1,sourceIds:[],createdAt:now(),updatedAt:now()};
  const compiled=compileContext({project:f.project,goal:'CURRENT REQUEST',history:[],memories:[approved],retrieved:[],instructions:'System authority',contextWindow:4096,maxOutputTokens:512,attachmentText:[{id:'large',name:'large.md',content:'x'.repeat(50_000)}]});
  assert.equal(compiled.messages.at(-1)?.content,'CURRENT REQUEST');assert.deepEqual(compiled.messages.filter(m=>m.role==='system').map(m=>m.content),['System authority']);assert.equal(compiled.report.sources.find(s=>s.id==='large')?.included,false);assert.equal(compiled.report.truncated,true);assert.ok(compiled.report.estimatedTokens<=compiled.report.budgetTokens);
  assert.throws(()=>compileContext({project:f.project,goal:'x'.repeat(100_000),history:[],memories:[],retrieved:[],instructions:'System',contextWindow:4096}),errorCode('CONTEXT'));
});
test('restart marks work interrupted, expires approvals and never replays a side effect',async t=>{
  let calls=0;const f=await fixture(t,{completion:async()=>{calls++;return result('unexpected replay');}}),conversation=f.conversation(),run=persistedRun(f.project,conversation,f.routes.planner.id);
  run.tasks=[{id:'task',runId:run.id,label:'Write',role:'coder',instruction:'Write file',dependencies:[],routeId:f.routes.coder.id,status:'running',attempt:1,evidenceIds:[]}];conversation.messages.push({id:'partial',role:'assistant',text:'partial result',createdAt:now(),runId:run.id,status:'streaming'});f.app.store.put('conversation',conversation);f.app.store.put('run',run);
  const approval:Approval={id:'approval',ownerId:f.alice.user.id,projectId:f.project.id,runId:run.id,kind:'write',title:'Write?',detail:'change',status:'pending',createdAt:now(),expiresAt:new Date(Date.now()+100_000).toISOString()};f.app.store.put('approval',approval);await writeFile(path.join(f.workspace,'existing.txt'),'once');await f.close();
  const restarted=new Application({directory:f.directory,config:f.config,complete:async()=>{calls++;return result('replay');}});try{await new Promise(resolve=>setTimeout(resolve,25));assert.equal(calls,0);assert.equal(restarted.store.require<Run>('run',run.id).status,'interrupted');assert.equal(restarted.store.require<Run>('run',run.id).tasks[0].status,'blocked');assert.equal(restarted.store.require<Approval>('approval',approval.id).status,'expired');assert.equal(restarted.store.require<Conversation>('conversation',conversation.id).messages[0].status,'error');assert.equal(await readFile(path.join(f.workspace,'existing.txt'),'utf8'),'once');assert.equal(restarted.store.authenticate(f.alice.token)?.id,f.alice.user.id);}finally{await restarted.close();}
});
test('real HTTP requires auth, rejects credential queries and gates cookie mutations by origin',async t=>{
  const f=await fixture(t);assert.equal((await f.api('/api/bootstrap',{token:null})).status,401);assert.equal((await f.api('/api/bootstrap?token=secret',{token:null})).status,400);assert.equal((await f.api('/api/health',{token:null})).status,200);
  const bad=await f.api('/api/login',{token:null,body:{token:f.alice.token},headers:{Origin:'https://attacker.invalid'}});assert.equal(bad.status,403);
  const login=await f.api('/api/login',{token:null,body:{token:f.alice.token},headers:{Origin:f.url}});assert.equal(login.status,200);const setCookie=login.response.headers.get('set-cookie')!;assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);const cookie=setCookie.split(';')[0];
  assert.equal((await f.api('/api/projects',{token:null,body:{name:'blocked'},headers:{Cookie:cookie}})).status,403);
  assert.equal((await f.api('/api/projects',{token:null,body:{name:'allowed'},headers:{Cookie:cookie,Origin:f.url}})).status,201);
  assert.equal((await f.api('/api/logout',{token:null,method:'POST',body:{},headers:{Cookie:cookie,Origin:f.url}})).status,200);assert.equal((await f.api('/api/bootstrap',{token:null,headers:{Cookie:cookie}})).status,401);
});
test('HTTP object ownership, operator roles and static allowlist stay enforced',async t=>{
  const f=await fixture(t),conversation=f.conversation(),artifact=f.app.knowledge.addArtifact(f.alice.user,f.project.id,'private.md','Alice only');
  assert.equal((await f.api(`/api/conversations/${conversation.id}`,{token:f.bob.token})).status,404);assert.equal((await f.api(`/api/artifacts/${artifact.id}`,{token:f.bob.token})).status,404);assert.equal((await f.api('/api/users',{token:f.bob.token})).status,403);
  assert.equal((await f.api('/api/providers',{token:f.bob.token,body:{label:'Private host',kind:'openai-compatible',baseUrl:'http://127.0.0.1:1'}})).status,403);
  assert.equal((await f.api('/api/projects',{token:f.viewer.token,body:{name:'denied'}})).status,403);assert.equal((await f.api('/api/bootstrap',{token:f.viewer.token})).status,200);
  const root=await fetch(f.url+'/');assert.equal(root.status,200);assert.match(root.headers.get('content-security-policy')??'',/script-src 'self'/);assert.equal((await fetch(f.url+'/state/master.key')).status,404);
});
test('untrusted member cannot enter mission or native-CLI execution even with a project membership',async t=>{
  const f=await fixture(t),conversation=f.conversation(f.bob.user);
  const mission=await f.api(`/api/conversations/${conversation.id}/messages`,{token:f.bob.token,body:{text:'Build it',routeId:f.routes.planner.id,mode:'mission',permissions:{write:true,commands:true}}});assert.equal(mission.status,403);
  const account=f.app.catalog.addAccount(f.alice.user,'fixture-provider','private',undefined,false);assert.throws(()=>f.app.catalog.resolve(f.bob.user,f.app.store.put<ModelRoute>('model',{...f.routes.planner,id:id('mdl'),accountId:account.id}).id),errorCode('NOT_FOUND'));
  const chat=await f.api(`/api/conversations/${conversation.id}/messages`,{token:f.bob.token,body:{text:'Explain the project',routeId:f.routes.planner.id,mode:'chat'}});assert.equal(chat.status,202);await f.app.orchestrator.idle(chat.data.id);assert.equal(f.app.store.require<Run>('run',chat.data.id).status,'succeeded');
  // Simulate a persisted native account belonging to a user whose role is now member.
  const providerId=id('prv'),accountId=id('acc');f.app.store.put('provider',{id:providerId,ownerId:f.bob.user.id,label:'Legacy Codex',kind:'codex',command:'never-execute-native-fixture',nodeIds:[],resourceGroupIds:[],enabled:true,createdAt:now()});
  f.app.store.put<Account>('account',{id:accountId,ownerId:f.bob.user.id,providerId,label:'Legacy account',shared:false,status:'unknown',hasSecret:false});const native=f.app.store.put<ModelRoute>('model',{...f.routes.planner,id:id('mdl'),providerId,accountId});
  assert.throws(()=>f.app.catalog.addAccount(f.bob.user,providerId,'New native account'),errorCode('TRUSTED_EXECUTION'));
  const nativeRun=f.app.orchestrator.start(f.bob.user,conversation.id,{text:'Read project',routeId:native.id,mode:'chat'});await f.app.orchestrator.idle(nativeRun.id);const nativeState=f.app.store.require<Run>('run',nativeRun.id);assert.equal(nativeState.status,'failed');assert.match(nativeState.error??'',/operatore fidato/);assert.equal(nativeState.budget.callsUsed,0);
  await assert.rejects(f.app.catalog.discover(f.bob.user,accountId,signal()),errorCode('TRUSTED_EXECUTION'));
  await assert.rejects(f.app.catalog.login(f.bob.user,accountId,()=>{},signal()),errorCode('TRUSTED_EXECUTION'));
});
test('explicit model/account switch preserves history when the first account reaches its quota',async t=>{
  const requests:InferenceRequest[]=[];const f=await fixture(t,{completion:async request=>{requests.push(request);const text=`Reply from ${request.model.id}`;request.onText(text);return result(text);}}),conversation=f.conversation();
  const first=await f.api(`/api/conversations/${conversation.id}/messages`,{body:{text:'Start this work',routeId:f.routes.planner.id,mode:'chat'}});assert.equal(first.status,202);await f.app.orchestrator.idle(first.data.id);
  f.app.catalog.quota(f.app.store.require<Account>('account',f.routes.planner.accountId),{state:'limited',source:'provider-headers',observedAt:now(),remainingRequests:0,retryAfterMs:60_000});
  const blocked=await f.api(`/api/conversations/${conversation.id}/messages`,{body:{text:'Continue',routeId:f.routes.planner.id,mode:'chat'}});assert.equal(blocked.status,429);assert.equal(requests.length,1);
  const alternate=f.app.catalog.addAccount(f.alice.user,'fixture-provider','Alternate quota'),route=f.app.store.put<ModelRoute>('model',{...f.routes.coder,id:id('mdl'),accountId:alternate.id});
  const second=await f.api(`/api/conversations/${conversation.id}/messages`,{body:{text:'Continue this work',routeId:route.id,mode:'chat'}});assert.equal(second.status,202);await f.app.orchestrator.idle(second.data.id);
  const stored=f.app.store.require<Conversation>('conversation',conversation.id);assert.equal(stored.messages.length,4);assert.deepEqual(stored.messages.filter(m=>m.role==='assistant').map(m=>m.routeId),[f.routes.planner.id,route.id]);assert.equal(stored.messages.at(-1)?.metrics?.totalTokens,30);assert.ok(requests[1].messages.some(m=>m.content.includes('Reply from planner')));
});
test('SSE replay contains only the authenticated owner and removes the subscription on disconnect',async t=>{
  const f=await fixture(t);f.app.store.emit({ownerId:f.alice.user.id,type:'private.alice',text:'alice-secret-event'});f.app.store.emit({ownerId:f.bob.user.id,type:'private.bob',text:'bob-visible-event'});
  const controller=new AbortController(),response=await fetch(f.url+'/api/events?after=0',{headers:{Authorization:'Bearer '+f.bob.token},signal:controller.signal}),reader=response.body!.getReader();let text='';
  while(!text.includes('bob-visible-event')){const part=await reader.read();assert.equal(part.done,false);text+=new TextDecoder().decode(part.value);}
  assert.ok(!text.includes('alice-secret-event'));await reader.cancel();controller.abort();await eventually(()=>f.app.streams.get(f.bob.user.id)?.size===0);
});
test('pause cancels a live model call and resuming requires an explicit action',async t=>{
  let calls=0,entered=false;const f=await fixture(t,{completion:async request=>{calls++;entered=true;return await new Promise<InferenceResult>((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));}}),conversation=f.conversation();
  const run=f.app.orchestrator.start(f.alice.user,conversation.id,{text:'Slow response',routeId:f.routes.planner.id,mode:'chat'});await eventually(()=>entered);f.app.orchestrator.control(f.alice.user,run.id,'pause');await f.app.orchestrator.idle(run.id);assert.equal(f.app.store.require<Run>('run',run.id).status,'paused');await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,1);assert.equal(f.app.orchestrator.active.size,0);f.app.orchestrator.control(f.alice.user,run.id,'cancel');assert.equal(f.app.store.require<Run>('run',run.id).status,'cancelled');
});
test('exhausted call budget stops before inference and releases the workspace',async t=>{
  let calls=0;const f=await fixture(t,{completion:async()=>{calls++;return result('should not run');}}),conversation=f.conversation(),run=persistedRun(f.project,conversation,f.routes.planner.id);run.mode='chat';run.status='queued';run.budget.maxModelCalls=1;run.budget.callsUsed=1;f.app.store.put('run',run);f.app.orchestrator.launch(f.alice.user,run);await f.app.orchestrator.idle(run.id);assert.equal(calls,0);assert.equal(f.app.store.require<Run>('run',run.id).status,'failed');assert.match(f.app.store.require<Run>('run',run.id).error??'',/Budget/);assert.equal(f.app.orchestrator.active.size,0);
});
test('planner rejects cyclic, missing and duplicate task dependencies',()=>{
  const task=(id:string,dependsOn:string[])=>({id,title:id,role:'coder',instruction:'Implement bounded task',dependsOn});
  for(const tasks of [[task('a',['b']),task('b',['a'])],[task('a',['missing'])],[task('a',[]),task('a',[])]])assert.throws(()=>parsePlan(JSON.stringify({tasks})),errorCode('PLAN'));
  assert.deepEqual(parsePlan(JSON.stringify({tasks:[task('a',[]),task('b',['a'])]})).map(t=>t.id),['a','b']);
});

async function missionFixture(t:test.TestContext,options:{healthStatus?:number;badProduct?:boolean}={}){
  const calls:Array<{model:string;role:string}>=[];
  const endpoint=await httpFixture(t,(req,res)=>{
    if(req.url==='/health'){res.statusCode=options.healthStatus??200;res.end(res.statusCode===200?'healthy':'down');return;}
    let raw='';req.on('data',chunk=>{raw+=chunk;});req.on('end',()=>{
      const request=JSON.parse(raw),messages=request.messages as Array<{role:string;content:string}>;const system=messages.find(m=>m.role==='system')?.content??'';const role=system.match(/Your role: ([a-z]+)/)?.[1]??'unknown';calls.push({model:request.model,role});
      let content='',toolCalls:unknown[]|undefined;
      if(role==='primary')content=JSON.stringify({tasks:[{id:'implementation',title:'Create product',role:'coder',instruction:'Create product.ts with the required implementation.',dependsOn:[]}]});
      else if(role==='coder'&&!messages.some(m=>m.role==='tool'))toolCalls=[{id:'call_write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'product.ts',content:options.badProduct?'export const answer = 0;\n':'export const answer = 42;\n'})}}];
      else if(role==='coder')content='Created product.ts.';
      else if(role==='reviewer')content=JSON.stringify({approved:true,issues:[],summary:'Implementation created and reviewed.',methodCandidate:{title:'Verify before release',content:'Run the configured product test before approving release.'}});
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',model:request.model,choices:[{index:0,message:{role:'assistant',content,...(toolCalls?{tool_calls:toolCalls}:{})},finish_reason:toolCalls?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}));
    });
  });
  const f=await fixture(t,{modelUrl:endpoint+'/v1',healthUrl:endpoint+'/health'}),conversation=f.conversation();
  const response=await f.api(`/api/conversations/${conversation.id}/messages`,{body:{text:'Build and verify product.ts. Stop before release.',routeId:f.routes.planner.id,mode:'mission',permissions:{write:true,commands:true,deploy:false},maxIterations:1,maxParallel:3}});assert.equal(response.status,202);await f.app.orchestrator.idle(response.data.id);
  return{...f,runId:response.data.id as string,calls};
}
test('real HTTP mission plans, changes files, reviews, verifies and waits for release before deployment',async t=>{
  const f=await missionFixture(t),run=f.app.store.require<Run>('run',f.runId);assert.equal(run.status,'awaiting_release');assert.equal(run.verificationPassed,true);assert.equal(await readFile(path.join(f.workspace,'product.ts'),'utf8'),'export const answer = 42;\n');await assert.rejects(readFile(path.join(f.workspace,'release.txt')));
  assert.deepEqual(f.calls.map(c=>c.model),['planner','coder','coder','reviewer']);assert.ok(f.app.store.all<Memory>('memory').some(m=>m.status==='candidate'&&m.kind==='method'));
  assert.equal((await f.api(`/api/projects/${f.project.id}`,{method:'PATCH',body:{workspace:'elsewhere'}})).status,409);
  const released=await f.api(`/api/runs/${f.runId}/release`,{body:{}});assert.equal(released.status,202);await f.app.orchestrator.idle(f.runId);const done=f.app.store.require<Run>('run',f.runId);assert.equal(done.status,'succeeded');assert.ok(done.releasedAt);assert.equal(await readFile(path.join(f.workspace,'release.txt'),'utf8'),'published');
  const evidence=f.app.store.all<Evidence>('evidence').find(e=>e.kind==='deployment')!;assert.equal(evidence.ok,true);assert.match(evidence.output,/Health verified: HTTP 200/);assert.equal(f.app.scheduler.snapshot()['strix01-memory'],0);
});
test('failed post-deployment health produces failed mission and observed rollback evidence',async t=>{
  const f=await missionFixture(t,{healthStatus:503});assert.equal(f.app.store.require<Run>('run',f.runId).status,'awaiting_release');await f.api(`/api/runs/${f.runId}/release`,{body:{}});await f.app.orchestrator.idle(f.runId);const done=f.app.store.require<Run>('run',f.runId);assert.equal(done.status,'failed');assert.equal(done.releasedAt,undefined);assert.equal(await readFile(path.join(f.workspace,'rollback.txt'),'utf8'),'restored');await assert.rejects(readFile(path.join(f.workspace,'release.txt')));
  const evidence=f.app.store.all<Evidence>('evidence').find(e=>e.kind==='deployment')!;assert.equal(evidence.ok,false);const execution=evidence.details?.execution as Array<{rollback?:string}>;assert.equal(execution.at(-1)?.rollback,'succeeded');
});
test('a model’s positive review cannot override failing executable verification',async t=>{
  const f=await missionFixture(t,{badProduct:true}),run=f.app.store.require<Run>('run',f.runId);assert.equal(run.status,'failed');assert.equal(run.verificationPassed,false);assert.equal(run.releasedAt,undefined);assert.ok(f.app.store.all<Evidence>('evidence').some(e=>e.kind==='review'&&e.ok));assert.ok(f.app.store.all<Evidence>('evidence').some(e=>e.kind==='test'&&!e.ok));assert.equal((await f.api(`/api/runs/${f.runId}/release`,{body:{}})).status,409);await assert.rejects(readFile(path.join(f.workspace,'release.txt')));
});
