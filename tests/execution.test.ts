import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, link, rm, chmod, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { execute, executeTool, acquireWorkspace, sshArguments, quoteRemote, runProcess, toolDefinitions } from '../src/execution/index.ts';
import { sha256 } from '../src/execution/workspace.ts';
import type { ExecutionTarget, Operation, ExecutionApproval } from '../src/execution/types.ts';

async function fixture(t:test.TestContext){
  const root=await mkdtemp(path.join(os.tmpdir(),'yed1z-exec-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const target:ExecutionTarget={id:'test-target',nodeId:'node01',kind:'local',workspaceRoot:root,commands:[{id:'test',label:'Run fixture test',argv:[process.execPath,'-e','console.log("verified")'],verification:true},{id:'fail',label:'Failed check',argv:[process.execPath,'-e','console.error("bad");process.exit(2)'],verification:true},{id:'marker',label:'Deploy fixture',argv:[process.execPath,'-e','require("fs").writeFileSync("deployed.txt","yes")']},{id:'rollback',label:'Rollback fixture',argv:[process.execPath,'-e','require("fs").writeFileSync("rollback.txt","yes")']}]};
  const approvals:ExecutionApproval[]=[];
  const run=(operation:Operation,approve?:(a:ExecutionApproval)=>Promise<boolean>)=>execute({target,operation,signal:new AbortController().signal,approve:approve??(async request=>{approvals.push(request);return true;})});
  return {root,target,run,approvals};
}
test('read, bounded search and listing use configured project workspace',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'README.md'),'Hello\nmethod: verify first\n');await mkdir(path.join(f.root,'node_modules'));await writeFile(path.join(f.root,'node_modules','hidden.txt'),'method: excluded');
  const read=await f.run({kind:'read',path:'README.md'});assert.equal(read.ok,true);assert.match(read.output,/SHA256 [a-f0-9]{64}/);
  const search=await f.run({kind:'search',query:'method:'});assert.match(search.output,/README.md:2/);assert.doesNotMatch(search.output,/hidden/);
  const list=await f.run({kind:'list'});assert.match(list.output,/README/);assert.doesNotMatch(list.output,/node_modules/);
});
test('project preparation creates only a validated child of an existing operator workspace root',async t=>{
  const f=await fixture(t),base={target:f.target,signal:new AbortController().signal,approve:async()=>true,operation:{kind:'prepare' as const}};
  const prepared=await execute({...base,workspace:'new-project/src'});assert.equal(prepared.ok,true);assert.deepEqual(prepared.data,{targetId:f.target.id,workspace:'new-project/src',created:true});assert.equal((await stat(path.join(f.root,'new-project','src'))).isDirectory(),true);
  await writeFile(path.join(f.root,'new-project','src','proof.txt'),'created');assert.equal(await readFile(path.join(f.root,'new-project','src','proof.txt'),'utf8'),'created');
  assert.equal((await execute({...base,workspace:'.'})).ok,true);assert.equal((await execute({...base,workspace:'denied',approve:async()=>false})).ok,false);await assert.rejects(stat(path.join(f.root,'denied')));
  await assert.rejects(execute({...base,workspace:'../escape'}));await assert.rejects(execute({...base,workspace:'/tmp/escape'}));await symlink(os.tmpdir(),path.join(f.root,'linked'));
  await assert.rejects(execute({...base,workspace:'linked/escape'}));await assert.rejects(execute({...base,target:{...f.target,workspaceRoot:path.join(f.root,'missing-root')},workspace:'project'}));
});
test('path traversal, symlinks and credentials cannot enter tools',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'.env'),'secret');await symlink(os.tmpdir(),path.join(f.root,'outside'));
  for(const file of ['../escape','/etc/passwd','outside/file','.env','.ssh/id_ed25519','auth.json','cert.pem'])await assert.rejects(f.run({kind:'read',path:file}));
  await assert.rejects(execute({target:f.target,workspace:'../',operation:{kind:'list'},signal:new AbortController().signal,approve:async()=>true}));
});
test('writes require existing file hash and explicit grant; declined write preserves bytes',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'code.ts'),'before');
  await assert.rejects(f.run({kind:'write',path:'code.ts',content:'after'}),/expectedSha256/);
  await assert.rejects(f.run({kind:'write',path:'code.ts',content:'after',expectedSha256:sha256('stale')}),/hash changed/);
  const denied=await f.run({kind:'write',path:'code.ts',content:'after',expectedSha256:sha256('before')},async()=>false);assert.equal(denied.ok,false);assert.equal(await readFile(path.join(f.root,'code.ts'),'utf8'),'before');
  const written=await f.run({kind:'write',path:'code.ts',content:'after',expectedSha256:sha256('before')});assert.equal(written.ok,true);assert.equal(await readFile(path.join(f.root,'code.ts'),'utf8'),'after');assert.match(f.approvals[0].detail,/--- Before\nbefore/);
});
test('concurrent edit during approval and hardlinks are rejected',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'code.ts'),'before');
  await assert.rejects(f.run({kind:'write',path:'code.ts',content:'after',expectedSha256:sha256('before')},async()=>{await writeFile(path.join(f.root,'code.ts'),'external edit');return true;}),/changed during approval/);
  await link(path.join(f.root,'code.ts'),path.join(f.root,'linked.ts'));
  await assert.rejects(f.run({kind:'write',path:'linked.ts',content:'after',expectedSha256:sha256('external edit')}),/hard-linked/);
  assert.equal(await readFile(path.join(f.root,'code.ts'),'utf8'),'external edit');
});
test('command execution only accepts operator recipe IDs and failure remains failure',async t=>{
  const f=await fixture(t);assert.equal((await f.run({kind:'verify',recipeId:'test'})).ok,true);const failed=await f.run({kind:'verify',recipeId:'fail'});assert.equal(failed.ok,false);assert.equal(failed.exitCode,2);
  await assert.rejects(f.run({kind:'command',recipeId:'rm -rf /'}),/not configured/);
  await assert.rejects(f.run({kind:'verify',recipeId:'marker'}),/not an operator-defined verification/);
  assert.equal((await f.run({kind:'command',recipeId:'marker'},async()=>false)).ok,false);await assert.rejects(readFile(path.join(f.root,'deployed.txt')));
});
test('command argv is never evaluated by a shell and provider environment secrets are absent',async t=>{
  const f=await fixture(t);process.env.YED1Z_TEST_SECRET='never-forward';t.after(()=>{delete process.env.YED1Z_TEST_SECRET;});
  f.target.commands.push({id:'literal',label:'Literal',argv:[process.execPath,'-e','console.log(process.argv[1]);console.log(process.env.YED1Z_TEST_SECRET??"absent")','$(echo dangerous); `echo danger`']});
  const result=await f.run({kind:'command',recipeId:'literal'});assert.equal(result.ok,true);assert.match(result.output,/\$\(echo dangerous\)/);assert.match(result.output,/absent/);assert.doesNotMatch(result.output,/never-forward/);
});
test('recipe directory cannot escape project into another workspace',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.root,'project'));f.target.commands.push({id:'escape',label:'Bad cwd',argv:[process.execPath,'-e','console.log("bad")'],cwd:'..',verification:true});
  await assert.rejects(execute({target:f.target,workspace:'project',operation:{kind:'verify',recipeId:'escape'},signal:new AbortController().signal,approve:async()=>true}));
});
test('read-only role cannot write or execute; model cannot select deployment tool',async t=>{
  const f=await fixture(t),request={target:f.target,signal:new AbortController().signal,approve:async()=>true};
  assert.deepEqual(toolDefinitions(f.target,true).map(x=>x.name),['list_files','read_file','search_files']);
  await assert.rejects(executeTool({name:'write_file',arguments:{path:'bad',content:'bad'}},request,true),/unavailable/);
  await assert.rejects(executeTool({name:'deploy',arguments:{recipeId:'prod'}},request),/unavailable/);
});
test('model command tools cannot invoke deployment, rollback or controller-only recipes',async t=>{
  const f=await fixture(t);f.target.deployments=[{id:'prod',label:'Production',verify:['test'],steps:['marker'],rollback:['rollback'],health:{url:'http://127.0.0.1:1/'}}];f.target.commands.push({id:'switch-model',label:'Infrastructure switch',argv:[process.execPath,'-e','console.log("switch")'],controllerOnly:true});
  const tools=toolDefinitions(f.target),command=tools.find(tool=>tool.name==='run_command')!;
  const ids=(command.parameters.properties as Record<string,{enum:string[]}>).recipeId.enum;assert.deepEqual(ids,['test','fail']);
  for(const recipeId of ['marker','rollback','switch-model'])await assert.rejects(executeTool({name:'run_command',arguments:{recipeId}},{target:f.target,signal:new AbortController().signal,approve:async()=>true}),/reserved/);
  await assert.rejects(readFile(path.join(f.root,'deployed.txt')));await assert.rejects(readFile(path.join(f.root,'rollback.txt')));
});
test('workspace lease serializes writers and a cancelled waiter never acquires',async t=>{
  const f=await fixture(t),signal=new AbortController().signal,release=await acquireWorkspace(f.target,'.',signal);let acquired=false;
  const waiting=acquireWorkspace(f.target,'.',signal).then(release2=>{acquired=true;release2();});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(acquired,false);
  const cancel=new AbortController(),cancelled=acquireWorkspace(f.target,'.',cancel.signal);cancel.abort();await assert.rejects(cancelled);
  release();release();await waiting;assert.equal(acquired,true);
  const release3=await acquireWorkspace(f.target,'.',signal);release3();
});
test('ancestor and descendant workspaces share a lease; disjoint projects proceed',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.root,'a'));await mkdir(path.join(f.root,'b'));const signal=new AbortController().signal;
  const releaseA=await acquireWorkspace(f.target,'a',signal),releaseB=await acquireWorkspace(f.target,'b',signal);let rootAcquired=false;
  const rootLease=acquireWorkspace(f.target,'.',signal).then(release=>{rootAcquired=true;return release;});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(rootAcquired,false);releaseA();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(rootAcquired,false);releaseB();(await rootLease)();
});
test('process timeout and cancellation cannot report success',async()=>{
  const timed=await runProcess([process.execPath,'-e','console.log("start");setInterval(()=>{},1000)'],{signal:new AbortController().signal,timeoutMs:70});assert.equal(timed.ok,false);assert.equal(timed.timedOut,true);
  const cancelled=new AbortController(),result=runProcess([process.execPath,'-e','setInterval(()=>{},1000)'],{signal:cancelled.signal,timeoutMs:5000});setTimeout(()=>cancelled.abort(),40);const stopped=await result;assert.equal(stopped.ok,false);assert.equal(stopped.cancelled,true);
});
test('SSH is strict noninteractive, fixed runner argv is shell-quoted and bad aliases rejected',async t=>{
  const f=await fixture(t),target={...f.target,kind:'ssh' as const,sshHost:'02-evo-x3-tb',remoteRunner:"/opt/yed1z's build/runner.mjs"};
  const args=sshArguments(target);assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('BatchMode=yes'));assert.ok(args.includes('02-evo-x3-tb'));assert.match(args.at(-1)!,/yed1z'\\''s build/);
  assert.equal(quoteRemote('$(touch /tmp/pwned)'),"'$(touch /tmp/pwned)'");assert.throws(()=>sshArguments({...target,sshHost:'-o ProxyCommand=evil'}));assert.throws(()=>sshArguments({...target,sshHost:'host;evil'}));
});
test('lost SSH runner result marks mutating operations uncertain instead of retryable failure',async t=>{
  const f=await fixture(t),fake=path.join(f.root,'ssh');await writeFile(fake,`#!${process.execPath}\nprocess.stdin.once('data',()=>process.exit(1));\n`);await chmod(fake,0o700);
  const previous=process.env.PATH;process.env.PATH=f.root+path.delimiter+(previous??'');t.after(()=>{process.env.PATH=previous;});
  const target={...f.target,kind:'ssh' as const,sshHost:'fixture-host'},base={target,signal:new AbortController().signal,approve:async()=>true};
  await assert.rejects(execute({...base,operation:{kind:'write',path:'file.md',content:'new'}}),(error:unknown)=>(error as {code?:string}).code==='REMOTE_UNCERTAIN');
  await assert.rejects(execute({...base,operation:{kind:'read',path:'file.md'}}),(error:unknown)=>(error as {code?:string}).code!=='REMOTE_UNCERTAIN');
});
test('deployment has fresh verification, a concrete approval and observed HTTP health',async t=>{
  const f=await fixture(t),server=createServer((_request,response)=>response.end('healthy'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  f.target.deployments=[{id:'prod',label:'Fixture production',verify:['test'],steps:['marker'],health:{url:`http://127.0.0.1:${address.port}/health`,expectedText:'healthy',attempts:1},rollback:['rollback']}];
  const result=await f.run({kind:'deploy',recipeId:'prod'});assert.equal(result.ok,true);assert.equal(f.approvals[0].kind,'deployment');assert.equal(result.evidence.at(-1)?.healthStatus,200);assert.equal(result.evidence.at(-1)?.rollback,'not-needed');assert.equal(await readFile(path.join(f.root,'deployed.txt'),'utf8'),'yes');
});
test('failed health runs the approved rollback and never marks production successful',async t=>{
  const f=await fixture(t),server=createServer((_request,response)=>{response.statusCode=503;response.end('down');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');f.target.deployments=[{id:'prod',label:'Fixture',verify:['test'],steps:['marker'],health:{url:`http://127.0.0.1:${address.port}/health`,attempts:1},rollback:['rollback']}];
  const result=await f.run({kind:'deploy',recipeId:'prod'});assert.equal(result.ok,false);assert.equal(result.evidence.at(-1)?.rollback,'succeeded');assert.equal(await readFile(path.join(f.root,'rollback.txt'),'utf8'),'yes');
});
test('failed release verification prevents deployment and approval',async t=>{
  const f=await fixture(t);f.target.deployments=[{id:'prod',label:'Fixture',verify:['fail'],steps:['marker'],health:{url:'http://127.0.0.1:1/'}}];
  const result=await f.run({kind:'deploy',recipeId:'prod'});assert.equal(result.ok,false);assert.equal(f.approvals.length,0);await assert.rejects(readFile(path.join(f.root,'deployed.txt')));
});
test('one-shot node runner uses node-owned target config and correlated write approval',async t=>{
  const f=await fixture(t),config=path.join(f.root,'node.json');await writeFile(config,JSON.stringify({targets:[f.target]}));
  const child=spawn(process.execPath,['src/execution/runner-entry.ts','--config',config,'--target',f.target.id],{cwd:path.resolve(import.meta.dirname,'..'),stdio:['pipe','pipe','pipe']});
  let buffer='',sawApproval=false,done:unknown;
  const exit=new Promise<void>((resolve,reject)=>{let stderr='';child.stderr.on('data',data=>{stderr+=data;});child.on('error',reject);child.stdout.on('data',chunk=>{buffer+=chunk.toString();let index:number;while((index=buffer.indexOf('\n'))>=0){const frame=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);if(frame.type==='approval'){sawApproval=true;child.stdin.write(JSON.stringify({type:'approval',id:frame.id,approved:true})+'\n');}else if(frame.type==='result'){done=frame.result;child.stdin.end();}else if(frame.type==='error')reject(new Error(frame.error));}});child.on('close',code=>code===0?resolve():reject(new Error(`Runner exit ${code}: ${stderr}`)));});
  child.stdin.write(JSON.stringify({type:'start',workspace:'.',operation:{kind:'write',path:'new.md',content:'approved'}})+'\n');await exit;assert.equal(sawApproval,true);assert.equal((done as {ok:boolean}).ok,true);assert.equal(await readFile(path.join(f.root,'new.md'),'utf8'),'approved');
});
