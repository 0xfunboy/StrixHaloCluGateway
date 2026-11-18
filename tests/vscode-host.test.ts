import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require=createRequire(import.meta.url);
interface HostView {resolveWebviewView(view:unknown):Promise<void>;configure():Promise<void>;addSelection():Promise<void>;dispose():void;}
async function host(t:test.TestContext){
  const directory=await mkdtemp(path.join(os.tmpdir(),'yed1z-vscode-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const {build}=require('esbuild') as {build:(options:unknown)=>Promise<unknown>};
  const bundle=path.join(directory,'extension.cjs');await build({entryPoints:[path.resolve(import.meta.dirname,'../vscode/src/extension.ts')],outfile:bundle,bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],logLevel:'silent'});
  const posts:Record<string,unknown>[]=[],secrets=new Map<string,string>(),state=new Map<string,unknown>(),inputs:Array<string|undefined>=[],errors:string[]=[],commands:string[]=[],writes:Array<{path:string;content:string}>=[];
  let receive:(value:unknown)=>void=()=>{},disposeView:()=>void=()=>{};
  const uri=(value:string)=>({path:value,fsPath:value,toString:()=>value});
  const vscode={Uri:{joinPath:(base:{path:string},...parts:string[])=>uri([base.path,...parts].join('/')),parse:uri,file:uri},
    workspace:{isTrusted:true,asRelativePath:()=> 'src/example.ts',fs:{readFile:async()=>Buffer.from('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><script type="module" src="/app.js"></script></body></html>'),writeFile:async(target:{path:string},bytes:Uint8Array)=>{writes.push({path:target.path,content:Buffer.from(bytes).toString('utf8')});}}},
    window:{showInputBox:async()=>inputs.shift(),showSaveDialog:async(_options:unknown)=>uri('/chosen/export.md'),showErrorMessage:(message:string)=>{errors.push(message);},showInformationMessage:()=>{},activeTextEditor:undefined as unknown},
    commands:{executeCommand:async(command:string)=>{commands.push(command);}},env:{openExternal:async()=>true}};
  const context={extensionUri:uri(directory),globalState:{get:<T>(key:string,fallback:T)=>state.has(key)?state.get(key):fallback,update:async(key:string,value:unknown)=>{state.set(key,value);}},secrets:{get:async(key:string)=>secrets.get(key),store:async(key:string,value:string)=>{secrets.set(key,value);}},subscriptions:[]};
  const loader=Module as unknown as {_load:(...args:unknown[])=>unknown};const original=loader._load;
  loader._load=function(name:unknown,...args:unknown[]){if(name==='vscode')return vscode;return original.call(this,name,...args);};
  let CommandView:new(context:unknown)=>HostView;try{CommandView=require(bundle).CommandView;}finally{loader._load=original;}
  const instance=new CommandView(context);t.after(()=>instance.dispose());
  const webview={html:'',options:{},cspSource:'vscode-webview://fixture',asWebviewUri:(asset:{path:string})=>uri('vscode-webview://fixture/'+path.basename(asset.path)),postMessage:async(value:Record<string,unknown>)=>{posts.push(value);return true;},onDidReceiveMessage:(callback:(value:unknown)=>void)=>{receive=callback;return{dispose(){}};}};
  await instance.resolveWebviewView({webview,onDidDispose:(callback:()=>void)=>{disposeView=callback;}});t.after(()=>disposeView());
  const wait=async(predicate:()=>boolean)=>{const until=Date.now()+3000;while(!predicate()){if(Date.now()>until)throw new Error('Host response timeout.');await new Promise(resolve=>setTimeout(resolve,5));}};
  const send=async(message:Record<string,unknown>)=>{receive(message);await wait(()=>posts.some(item=>item.id===message.id));return posts.find(item=>item.id===message.id)!;};
  const connect=(endpoint:string,token='host-private-key')=>{state.set('yed1z.endpoint',endpoint);secrets.set('yed1z.gateway.'+createHash('sha256').update(endpoint).digest('hex'),token);};
  return{instance,webview,posts,secrets,state,inputs,errors,commands,writes,vscode,send,receive,wait,connect};
}
async function server(t:test.TestContext,handler:RequestListener){
  const app=createServer(handler);await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>app.close(()=>resolve())));const address=app.address();assert.ok(address&&typeof address!=='string');return`http://127.0.0.1:${address.port}`;
}
test('webview loads local shared UI under restrictive CSP and never embeds the gateway token',async t=>{
  const h=await host(t);h.connect('https://yed1z.ai','secret-never-in-html');assert.match(h.webview.html,/connect-src 'none'/);assert.match(h.webview.html,/script-src 'nonce-/);assert.match(h.webview.html,/vscode-webview:\/\/fixture\/app.js/);assert.doesNotMatch(h.webview.html,/secret-never-in-html/);
});
test('host proxy authenticates in SecretStorage and returns API shape without the token',async t=>{
  const h=await host(t);let auth='';const endpoint=await server(t,(req,res)=>{auth=req.headers.authorization??'';res.setHeader('Content-Type','application/json');res.end('{"projects":[]}');});h.connect(endpoint);
  const result=await h.send({type:'api',id:'boot',method:'GET',path:'/api/bootstrap'});assert.equal(auth,'Bearer host-private-key');assert.equal(result.type,'api.result');assert.equal(result.ok,true);assert.deepEqual(result.data,{projects:[]});assert.doesNotMatch(JSON.stringify(h.posts),/host-private-key/);
});
test('untrusted workspace blocks project mutations and permits history reads and personal appearance',async t=>{
  const h=await host(t);let calls=0;const endpoint=await server(t,(_req,res)=>{calls++;res.end('{}');});h.connect(endpoint);h.vscode.workspace.isTrusted=false;
  const denied=await h.send({type:'api',id:'mutate',method:'POST',path:'/api/conversations',body:{projectId:'p'}});assert.equal(denied.ok,false);assert.equal(calls,0);
  const read=await h.send({type:'api',id:'read',method:'GET',path:'/api/bootstrap'});assert.equal(read.ok,true);assert.equal(calls,1);
  const preference=await h.send({type:'api',id:'preference',method:'PATCH',path:'/api/me/appearance',body:{theme:'light'}});assert.equal(preference.ok,true);assert.equal(calls,2);
  const unsafe=await h.send({type:'api',id:'post-profile',method:'POST',path:'/api/me/appearance',body:{theme:'light'}});assert.equal(unsafe.ok,false);assert.equal(calls,2);
});
test('native account secret prompt sends key only to the configured server',async t=>{
  const h=await host(t);let body:Record<string,unknown>={};const endpoint=await server(t,(req,res)=>{let data='';req.on('data',chunk=>{data+=chunk;});req.on('end',()=>{body=JSON.parse(data);res.end('{"id":"account","hasSecret":true}');});});h.connect(endpoint);h.inputs.push('provider-private-key');
  const result=await h.send({type:'api',id:'account',method:'POST',path:'/api/accounts',body:{providerId:'provider',label:'main',requestSecret:true}});assert.equal(result.ok,true);assert.equal(body.secret,'provider-private-key');assert.equal('requestSecret'in body,false);assert.doesNotMatch(JSON.stringify(h.posts),/provider-private-key/);
});
test('one-step connection secret prompt stays in the extension host and reaches only the configured gateway body',async t=>{
  const h=await host(t);let body:Record<string,unknown>={},auth='';const endpoint=await server(t,(req,res)=>{assert.equal(req.url,'/api/connections');auth=req.headers.authorization??'';let data='';req.on('data',chunk=>{data+=chunk;});req.on('end',()=>{body=JSON.parse(data);res.setHeader('Content-Type','application/json');res.end('{"status":"ready","account":{"id":"account","hasSecret":true},"models":[]}');});});h.connect(endpoint);h.inputs.push('connection-private-key');
  const result=await h.send({type:'api',id:'connection',method:'POST',path:'/api/connections',body:{preset:'gemrouter',baseUrl:'https://router.example/v1',requestId:'native-connect',requestSecret:true}});assert.equal(result.ok,true);assert.equal(auth,'Bearer host-private-key');assert.equal(body.secret,'connection-private-key');assert.equal(body.requestId,'native-connect');assert.equal('requestSecret'in body,false);assert.doesNotMatch(JSON.stringify(h.posts),/connection-private-key|host-private-key/);assert.doesNotMatch(h.webview.html,/connection-private-key|host-private-key/);
});
test('configure validates the server before changing saved endpoint and key',async t=>{
  const h=await host(t),endpoint=await server(t,(_req,res)=>{res.statusCode=401;res.end('{"error":"unauthorized"}');});h.connect('https://yed1z.ai','old-key');h.inputs.push(endpoint,'bad-key');await h.instance.configure();assert.equal(h.state.get('yed1z.endpoint'),'https://yed1z.ai');assert.equal(h.errors.length,1);assert.equal([...h.secrets.values()].includes('bad-key'),false);
});
test('selected editor context is explicit and trust-gated',async t=>{
  const h=await host(t);h.vscode.window.activeTextEditor={selection:{isEmpty:false},document:{getText:()=> 'const answer = 42;',uri:{path:'src/example.ts'}}};h.vscode.workspace.isTrusted=false;await h.instance.addSelection();assert.equal(h.posts.length,0);
  h.vscode.workspace.isTrusted=true;await h.instance.addSelection();assert.deepEqual(h.posts.at(-1),{type:'selection',name:'src/example.ts',content:'const answer = 42;'});assert.ok(h.commands.includes('haloforge.chat.focus'));
});
test('native export writes only the destination selected in the save dialog',async t=>{
  const h=await host(t);h.receive({type:'saveFile',name:'../../outside.md',content:'# User export'});await h.wait(()=>h.posts.some(p=>p.type==='savedFile'));
  assert.deepEqual(h.writes,[{path:'/chosen/export.md',content:'# User export'}]);assert.deepEqual(h.posts.at(-1),{type:'savedFile',ok:true});
});

test('guided Antigravity code remains in the host and reaches only the chosen login request',async t=>{
  const h=await host(t);let body:Record<string,unknown>={};
  const endpoint=await server(t,(req,res)=>{let raw=''; req.on('data',chunk=>{raw+=chunk;}); req.on('end',()=>{body=JSON.parse(raw);res.end('{"status":"pending"}');});});
  h.connect(endpoint);h.inputs.push('fixture-google-code');
  const response=await h.send({type:'api',id:'login-code',method:'POST',path:'/api/accounts/antigravity-personale/login/respond',body:{operationId:'login-id',requestCode:true}});
  assert.equal(response.ok,true);assert.deepEqual(body,{operationId:'login-id',code:'fixture-google-code'});assert.doesNotMatch(JSON.stringify(h.posts),/fixture-google-code/);
});

test('host permits PUT for scoped account delegates only',async t=>{
  const h=await host(t);let method='',target='',body:Record<string,unknown>={};
  const endpoint=await server(t,(req,res)=>{method=req.method??'';target=req.url??'';let raw='';req.on('data',chunk=>{raw+=chunk;});req.on('end',()=>{body=JSON.parse(raw);res.end('{}');});});
  h.connect(endpoint);
  const permitted=await h.send({type:'api',id:'account-delegates',method:'PUT',path:'/api/accounts/acc-fixture/delegates',body:{userIds:['u2'],shared:false}});
  assert.equal(permitted.ok,true);assert.equal(method,'PUT');assert.equal(target,'/api/accounts/acc-fixture/delegates');assert.deepEqual(body,{userIds:['u2'],shared:false});
  const denied=await h.send({type:'api',id:'wrong-put',method:'PUT',path:'/api/projects/p1',body:{name:'Denied'}});
  assert.equal(denied.ok,false);assert.equal(target,'/api/accounts/acc-fixture/delegates');
});
