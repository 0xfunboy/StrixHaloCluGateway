import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { Application } from '../src/server.ts';
import { defaultConfig } from '../src/config.ts';
import { createNodeBridge } from '../src/node-bridge.ts';
import { probeInference } from '../src/probe.ts';

const upstream = process.env.YED1Z_CANARY_UPSTREAM, model = process.env.YED1Z_CANARY_MODEL;
assert.ok(upstream && model, 'Imposta YED1Z_CANARY_UPSTREAM e YED1Z_CANARY_MODEL per un motore con function calling.');
const root = await mkdtemp(path.join(tmpdir(), 'yed1z-codex-canary-'));
const cwd = path.join(root, 'workspace'), profile = path.join(root, 'codex');
const bridgeToken = randomBytes(32).toString('hex'), marker = 'CONTROL-' + randomBytes(8).toString('hex');
const bridge = createNodeBridge({ upstream, kind:'openai', token:bridgeToken, upstreamToken:process.env.YED1Z_ENGINE_TOKEN });
let app: Application | undefined;
try {
    await Promise.all([mkdir(cwd), mkdir(profile)]);
    await writeFile(path.join(cwd,'canary.txt'), marker+'\n');
    await new Promise<void>((resolve,reject) => {bridge.once('error',reject);bridge.listen(0,'127.0.0.1',resolve);});
    const address=bridge.address(); assert.ok(address && typeof address!=='string');
    const baseUrl='http://127.0.0.1:'+address.port+'/v1';
    const discovery=await probeInference({id:'node',label:'Node',kind:'openai-compatible',baseUrl},{secret:bridgeToken,model,generate:true,signal:AbortSignal.timeout(120000)});
    assert.ok('inference' in discovery && discovery.inference.textReceived);
    const config=defaultConfig(); Object.assign(config,{port:0,nodes:[],links:[],resourceGroups:[],targets:[]});
    config.providers=[{id:'canary-node',label:'Canary node',kind:'openai-compatible',enabled:true,baseUrl,nodeIds:[],resourceGroupIds:[],models:[{model,label:model,capabilities:['chat','tools']}]}];
    app=new Application({directory:path.join(root,'state'),config});
    const {user,token}=app.store.createUser('Canary','operator');app.catalog.seed(user);
    const route=app.catalog.models(user)[0]; app.store.setSecret(route.accountId,bridgeToken);
    const port=await app.listen();
    const args=['exec','--ephemeral','--skip-git-repo-check','--json','--sandbox','read-only','-C',cwd,'-m',route.id,
        '-c','model_provider="yed1z"','-c','model_providers.yed1z.name="yed1z"',
        '-c','model_providers.yed1z.base_url="http://127.0.0.1:'+port+'/v1"','-c','model_providers.yed1z.wire_api="responses"',
        '-c','model_providers.yed1z.env_key="YED1Z_CANARY_KEY"','-c','model_providers.yed1z.supports_websockets=false',
        '-c','model_providers.yed1z.stream_max_retries=0','-c','model_providers.yed1z.request_max_retries=0','-c','web_search="disabled"',
        'Use a read-only command to read canary.txt in the current workspace. Reply with its exact contents.'];
    const invocation=promisify(execFile)('codex',args,{cwd,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:profile,YED1Z_CANARY_KEY:token},timeout:120000,maxBuffer:4*1024*1024});
    invocation.child.stdin?.end();
    const {stdout}=await invocation.catch(()=>{throw Error('La CLI non ha completato il turno di lettura.');});
    const events=stdout.trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(events.some(e=>e.item?.type==='command_execution'));
    assert.ok(events.some(e=>e.item?.type==='agent_message' && e.item.text?.includes(marker)));
    console.log(JSON.stringify({model,discovered:discovery.models.includes(model),streamed:discovery.inference.chunks>0,readOnlyTool:true,markerMatched:true}));
} finally {
    if (app) await app.close();
    bridge.closeAllConnections(); await new Promise<void>(resolve=>bridge.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
}
