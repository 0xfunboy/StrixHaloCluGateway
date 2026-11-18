import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createNodeBridge } from '../src/node-bridge.ts';
import { probeInference } from '../src/probe.ts';
async function listen(t: test.TestContext, server: Server) {
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
    const address=server.address();assert.ok(address && typeof address!=='string');return 'http://127.0.0.1:'+address.port;
}
test('a protected remote node exposes discovery, streaming inference and provider quota via the same connector used by GemRouter',async t=>{
    const visited:string[]=[];
    const upstream=await listen(t,createServer((req,res)=>{
        assert.equal(req.headers.authorization,'Bearer upstream-only');visited.push(req.url!);
        if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'on-node'}]}));return;}
        res.writeHead(200,{'content-type':'text/event-stream','x-ratelimit-remaining-requests':'17'});
        res.end('data: '+JSON.stringify({choices:[{delta:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:1}})+'\n\ndata: [DONE]\n\n');
    }));
    const token='test-remote-node-credential-123456';
    const bridge=await listen(t,createNodeBridge({upstream:upstream+'/v1',kind:'openai',token,upstreamToken:'upstream-only'}));
    assert.equal((await fetch(bridge+'/v1/models')).status,401);
    assert.equal((await fetch(bridge+'/api/switch',{headers:{Authorization:'Bearer '+token}})).status,404);
    const result=await probeInference({id:'g',label:'GemRouter contract',kind:'gemrouter',baseUrl:bridge+'/v1'},{secret:token,signal:AbortSignal.timeout(3000),generate:true});
    assert.deepEqual(result.models,['on-node']);assert.equal(result.inference?.exactOK,true);assert.deepEqual(visited,['/v1/models','/v1/chat/completions']);
});
