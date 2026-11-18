import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { apiPath, gatewayUrl, GatewayClient, consumeEvents, boundedJson } from '../vscode/src/client.ts';

test('VS Code origin and API paths reject credential/redirect escape routes',()=>{
  assert.equal(gatewayUrl('http://127.0.0.1:8081/'),'http://127.0.0.1:8081');assert.equal(gatewayUrl('https://yed1z.ai'),'https://yed1z.ai');
  for(const value of ['https://token@yed1z.ai','https://yed1z.ai/path','http://public.example','https://yed1z.ai?key=secret'])assert.throws(()=>gatewayUrl(value));
  for(const value of ['https://other/api/bootstrap','/api/../secret','/api/%2e%2e/secret','/api/ok?token=secret','//other/api/bootstrap','/api/ok\\evil'])assert.throws(()=>apiPath(value));
  assert.equal(apiPath('/api/events?after=42'),'/api/events?after=42');
});
test('native transport sends token only to configured origin and rejects redirect',async t=>{
  let seen='',redirected=false;const other=createServer((_req,res)=>{redirected=true;res.end('{}');});await new Promise<void>(resolve=>other.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>other.close(()=>resolve())));const address2=other.address();assert.ok(address2&&typeof address2!=='string');
  const server=createServer((req,res)=>{seen=req.headers.authorization??'';if(req.url==='/api/redirect'){res.writeHead(302,{Location:`http://127.0.0.1:${address2.port}/api/steal`});res.end();}else{res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert.ok(address&&typeof address!=='string');const client=new GatewayClient(`http://127.0.0.1:${address.port}`,'private-token');
  const response=await client.request('GET','/api/bootstrap',undefined,new AbortController().signal);assert.deepEqual(await boundedJson(response),{ok:true});assert.equal(seen,'Bearer private-token');await assert.rejects(client.request('GET','/api/redirect',undefined,new AbortController().signal));assert.equal(redirected,false);
});
test('SSE handles partial UTF-8 and CRLF with bounded replay event IDs',async()=>{
  const bytes=new TextEncoder().encode(': heartbeat\r\ndata: {"id":7,"type":"message.delta","data":{"delta":"ciao è"}}\r\n\r\ndata: {"id":8,"type":"run.updated"}\n\n');
  const response=new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
  const events:unknown[]=[];await consumeEvents(response,event=>events.push(event),new AbortController().signal);assert.equal(events.length,2);assert.equal((events[0]as{data:{delta:string}}).data.delta,'ciao è');
});
test('SSE cancellation releases the reader',async()=>{
  let cancelled=false;const controller=new AbortController(),response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});
  const consuming=consumeEvents(response,()=>{},controller.signal);controller.abort();await assert.rejects(consuming);assert.equal(cancelled,true);
});
