import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { complete, discoverModels, embed, AdapterError } from '../src/adapters/inference.ts';
import { normalizeTelemetry, sampleTelemetry } from '../src/adapters/telemetry.ts';
import type { AdapterConnection } from '../src/adapters/types.ts';

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const instance = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  const address = instance.address(); assert(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { instance.closeAllConnections(); await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve())); } };
}
async function body(request: IncomingMessage): Promise<Record<string, any>> { let text = ''; for await (const part of request) text += part; return JSON.parse(text); }
const signal = () => AbortSignal.timeout(5000);
function conn(url: string, kind: AdapterConnection['kind'] = 'openai-compatible'): AdapterConnection { return { id: 'connection', label: 'Account A', kind, baseUrl: url }; }
function json(res: ServerResponse, value: unknown) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

test('provider model discovery preserves unknown capabilities and exact IDs without returning credentials', async () => {
  const app = await server((req, res) => { assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer TEST_KEY'); json(res, { data: [{ id: 'local/qwen', context_length: 65536, api_key: 'DO_NOT_RETURN' }, { id: 'local/qwen' }] }); });
  try {
    const result = await discoverModels(conn(app.url + '/v1'), 'TEST_KEY', signal());
    assert.equal(result.models.length, 1); assert.equal(result.models[0].id, 'local/qwen'); assert.equal(result.models[0].contextWindow, 65536); assert.deepEqual(result.models[0].capabilities, []); assert.equal(result.quota.state, 'unknown'); assert(!JSON.stringify(result).includes('DO_NOT_RETURN')); assert(!JSON.stringify(result).includes('TEST_KEY'));
  } finally { await app.close(); }
});

test('GemRouter remains an ordinary provider; streamed usage and engine timings belong to the current response', async () => {
  const app = await server(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions'); const payload = await body(req); assert.equal(payload.model, 'gemrouter/model'); assert.equal(payload.stream_options.include_usage, true);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-ratelimit-remaining-requests': '0' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Ciao' } }] }) + '\n\n');
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 34, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } }, timings: { prompt_ms: 0, prompt_per_second: 1000, predicted_per_second: 33 } }) + '\n\ndata: [DONE]\n\n');
  });
  try {
    const text: string[] = []; const result = await complete({ connection: conn(app.url + '/v1', 'gemrouter'), model: { id: 'gemrouter/model', contextWindow: 4096 }, messages: [{ role: 'user', content: 'ciao' }], signal: signal(), onText: chunk => text.push(chunk) });
    assert.deepEqual(text, ['Ciao']); assert.equal(result.usage?.inputTokens, 34); assert.equal(result.metrics.prefillMs, 0); assert.equal(result.metrics.decodeTokensPerSecond, 33); assert.equal(result.metrics.contextRemaining, 4059); assert.equal(result.quota.remainingRequests, 0); assert.equal(result.quota.state, 'limited'); assert(result.metrics.ttftMs !== undefined);
  } finally { await app.close(); }
});

test('429 is observable with Retry-After; adapter never retries or discloses an echoed key', async () => {
  let requests = 0;
  const app = await server((_req, res) => { requests++; res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' }); res.end(JSON.stringify({ error: { message: 'Bearer PRIVATE_KEY PRIVATE_KEY' } })); });
  try {
    await assert.rejects(complete({ connection: conn(app.url + '/v1'), model: { id: 'qwen' }, secret: 'PRIVATE_KEY', messages: [{ role: 'user', content: 'hi' }], signal: signal(), onText: () => {} }), (error: unknown) => { assert(error instanceof AdapterError); assert.equal(error.status, 429); assert.equal(error.quota?.retryAfterMs, 7000); assert.equal(error.quota?.state, 'limited'); assert(!error.message.includes('PRIVATE_KEY')); return true; });
    assert.equal(requests, 1);
  } finally { await app.close(); }
});

test('Ollama NDJSON handles multibyte text, tools, cached prefill and exact engine counts', async () => {
  const app = await server(async (req, res) => {
    assert.equal(req.url, '/api/chat'); const payload = await body(req); assert.equal(payload.options.num_predict, 50); assert.equal(payload.tools[0].function.name, 'read_file');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Ciao 🦊', thinking: 'PRIVATE_REASONING', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }] }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 100, prompt_eval_cached_count: 80, prompt_eval_duration: 100_000_000, eval_count: 4, eval_duration: 200_000_000 }));
  });
  try {
    const result = await complete({ connection: conn(app.url, 'ollama'), model: { id: 'qwen', maxOutputTokens: 50 }, messages: [{ role: 'user', content: 'read' }], tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], signal: signal(), onText: () => {} });
    assert.equal(result.text, 'Ciao 🦊'); assert.equal(result.toolCalls[0].name, 'read_file'); assert.equal(result.usage?.cachedInputTokens, 80); assert.equal(result.metrics.prefillTokensPerSecond, 200); assert.equal(result.metrics.decodeTokensPerSecond, 20); assert(!JSON.stringify(result).includes('PRIVATE_REASONING'));
  } finally { await app.close(); }
});

test('Ollama does not invent prefill throughput when uncached token count is unavailable', async () => {
  const app = await server((_req, res) => json(res, { done: true, message: { content: 'ok' }, prompt_eval_count: 10, eval_count: 0, prompt_eval_duration: 50_000_000, eval_duration: 100_000_000 }));
  try {
    const result = await complete({ connection: conn(app.url, 'ollama'), model: { id: 'q' }, messages: [{ role: 'user', content: 'hi' }], signal: signal(), onText: () => {} });
    assert.equal(result.metrics.prefillTokensPerSecond, undefined); assert.equal(result.metrics.prefillMs, 50); assert.equal(result.metrics.decodeTokensPerSecond, 0);
  } finally { await app.close(); }
});

test('Gemini paginated discovery and native completion preserve provider usage', async () => {
  let pages = 0;
  const app = await server(async (req, res) => {
    assert.equal(req.headers['x-goog-api-key'], 'GEMINI_KEY');
    if (req.method === 'GET') { pages++; return json(res, pages === 1 ? { models: [{ name: 'models/gemini-fixture', displayName: 'Gemini fixture', inputTokenLimit: 12000, supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'second' } : { models: [{ name: 'models/embed-fixture', supportedGenerationMethods: ['embedContent'] }] }); }
    assert.equal(req.url, '/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse'); const payload = await body(req); assert.equal(payload.contents[0].parts[0].text, 'Ciao');
    json(res, { candidates: [{ content: { role: 'model', parts: [{ text: 'Risposta' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 2, cachedContentTokenCount: 0 } });
  });
  try {
    const connection = conn(app.url + '/v1beta', 'gemini'); const catalog = await discoverModels(connection, 'GEMINI_KEY', signal()); assert.equal(catalog.models.length, 2); assert.deepEqual(catalog.models[1].capabilities, ['embedding']);
    const answer = await complete({ connection, secret: 'GEMINI_KEY', model: { id: 'gemini-fixture' }, messages: [{ role: 'user', content: 'Ciao' }], signal: signal(), onText: () => {} }); assert.equal(answer.text, 'Risposta'); assert.equal(answer.usage?.outputTokens, 5);
  } finally { await app.close(); }
});

test('Responses native adapter retains structured context metadata for subsequent tool exchanges', async () => {
  const app = await server(async (req, res) => {
    assert.equal(req.url, '/v1/responses'); const payload = await body(req); assert.equal(payload.model, 'responses-fixture');
    json(res, { id: 'resp-fixture', status: 'completed', output: [{ type: 'message', id: 'msg1', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }], usage: { input_tokens: 5, output_tokens: 2 } });
  });
  try {
    const result = await complete({ connection: conn(app.url + '/v1', 'openai-responses'), model: { id: 'responses-fixture' }, messages: [{ role: 'user', content: 'hi' }], signal: signal(), onText: () => {} }); assert.equal(result.text, 'Done'); assert.equal(result.providerMetadata?.kind, 'openai-responses'); assert.equal(result.usage?.inputTokens, 5);
  } finally { await app.close(); }
});

test('embedding adapter restores input order and rejects duplicated indices', async () => {
  let bad = false;
  const app = await server(async (req, res) => { assert.equal(req.url, '/v1/embeddings'); const payload = await body(req); assert.equal(payload.encoding_format, 'float'); json(res, { model: 'embed-fixture', data: [{ index: 1, embedding: [0, 1] }, { index: bad ? 1 : 0, embedding: [1, 0] }], usage: { prompt_tokens: 3 } }); });
  try {
    const request = { connection: conn(app.url + '/v1'), model: 'embed-fixture', texts: ['A', 'B'], signal: signal() }; const result = await embed(request); assert.deepEqual(result.vectors, [[1, 0], [0, 1]]); assert.equal(result.dimensions, 2); bad = true; await assert.rejects(embed(request), /indices/);
  } finally { await app.close(); }
});

test('Ollama embedding explicitly disables silent truncation', async () => {
  const app = await server(async (req, res) => { assert.equal(req.url, '/api/embed'); const payload = await body(req); assert.equal(payload.truncate, false); json(res, { model: 'embed', embeddings: [[0.2, -0.2]], prompt_eval_count: 7 }); });
  try { assert.equal((await embed({ connection: conn(app.url + '/api', 'ollama'), model: 'embed', texts: ['hello'], signal: signal() })).inputTokens, 7); } finally { await app.close(); }
});

test('provider redirects are rejected and cannot forward an API key', async () => {
  let leaked = false;
  const target = await server((_req, res) => { leaked = true; json(res, {}); });
  const app = await server((_req, res) => { res.writeHead(302, { location: target.url }); res.end(); });
  try { await assert.rejects(discoverModels(conn(app.url), 'secret', signal()), /redirect/); assert.equal(leaked, false); } finally { await app.close(); await target.close(); }
});

test('cancel aborts an active HTTP stream without another request', async () => {
  let requests = 0; const controller = new AbortController();
  const app = await server((_req, res) => { requests++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"index":0,"delta":{"content":"started"}}]}\n\n'); });
  try { await assert.rejects(complete({ connection: conn(app.url), model: { id: 'fixture' }, messages: [{ role: 'user', content: 'hi' }], signal: controller.signal, onText: () => controller.abort(new Error('stop')) }), /stop/); assert.equal(requests, 1); } finally { await app.close(); }
});

test('telemetry preserves real zero, marks stale measurements and rejects fabricated legacy defaults', async () => {
  const now = Date.now(); const raw = { schema: 'yed1z.telemetry.v1', hostname: 'node01', observedAt: new Date(now).toISOString(), cpu: { utilization: 0 }, memory: { usedBytes: 0, totalBytes: 1024 }, gpus: [{ name: 'AMD', utilization: 0, temperatureC: 40, powerWatts: 0 }] };
  const current = normalizeTelemetry(raw, { id: 'strix-1' }, now); assert.equal(current.cpu.utilization, 0); assert.equal(current.gpus[0].powerWatts, 0); assert.equal(current.status, 'online'); assert.equal(current.quality, 'measured');
  assert.equal(normalizeTelemetry(raw, { id: 'strix-1' }, now + 20_000).status, 'stale');
  const legacy = normalizeTelemetry({ telemetry: { aireward: { hostname: 'aireward', observed_at: now / 1000, temps: { cpu_c: 42 }, gpu: { power_w: 15 } } } }, { id: 'cuda', gatewayNodeKey: 'aireward' }, now);
  assert.equal(legacy.quality, 'legacy-unverified'); assert.equal(legacy.cpu.temperatureC, undefined); assert.deepEqual(legacy.gpus, []);
  const app = await server((_req, res) => json(res, raw));
  try { assert.equal((await sampleTelemetry({ id: 'strix-1', url: app.url }, signal())).status, 'online'); } finally { await app.close(); }
});

test('usage after the finish chunk is retained and missing engine throughput stays unknown', async () => {
  const app = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n');
    res.end('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":0}}\n\ndata: [DONE]\n\n');
  });
  try {
    const result = await complete({ connection: conn(app.url), model: { id: 'fixture' }, messages: [{ role: 'user', content: 'hi' }], signal: signal(), onText: () => {} });
    assert.equal(result.usage?.inputTokens, 12); assert.equal(result.usage?.outputTokens, 0); assert.equal(result.metrics.decodeTokensPerSecond, undefined); assert.equal(result.metrics.prefillMs, undefined);
  } finally { await app.close(); }
});

test('a truncated stream cannot produce a successful completed result', async () => {
  const app = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"index":0,"delta":{"content":"Partial"}}]}\n\n'); });
  try {
    const text: string[] = []; await assert.rejects(complete({ connection: conn(app.url), model: { id: 'fixture' }, messages: [{ role: 'user', content: 'hi' }], signal: signal(), onText: s => text.push(s) }), /before a completion marker/); assert.deepEqual(text, ['Partial']);
  } finally { await app.close(); }
});

test('interface telemetry retains observed addresses, speed and zero counters without inventing peers or traffic rates', () => {
  const result = normalizeTelemetry({ schema: 'yed1z.telemetry.v1', observedAt: new Date().toISOString(), hostname: 'strix', network: [
    { name: 'enp1s0', up: true, mac: '02:00:00:00:00:01', addresses: ['192.168.178.47/24', 'fe80::1234/64'], speedMbps: 2500, rxBytes: 0, txBytes: 1000, rxErrors: 0, txErrors: 0 },
    { name: 'thunderbolt0', up: false, speedMbps: -1, rxBytes: 100, txBytes: 0, peer: 'UNVERIFIED_PEER', rxBytesPerSecond: 99999 },
  ] }, { id: 'node' });
  assert.equal(result.network?.[0].rxBytes, 0); assert.equal(result.network?.[0].speedMbps, 2500); assert.deepEqual(result.network?.[0].addresses, ['192.168.178.47/24', 'fe80::1234/64']); assert.equal(result.network?.[1].speedMbps, undefined); assert.equal(result.network?.[1].up, false); assert(!JSON.stringify(result).includes('UNVERIFIED_PEER')); assert(!JSON.stringify(result).includes('99999'));
});

test('unknown interface state and invalid counters remain absent, including legacy network payloads', () => {
  const result = normalizeTelemetry({ schema: 'yed1z.telemetry.v1', observedAt: new Date().toISOString(), network: [
    { name: 'eth0', up: 'unknown', speedMbps: NaN, rxBytes: -1, txBytes: '0', rxErrors: Infinity, addresses: ['invalid', '10.55.0.1/33', '10.55.0.1/24'] },
  ] }, { id: 'node' });
  assert.equal(result.network?.[0].up, undefined); assert.equal(result.network?.[0].rxBytes, undefined); assert.equal(result.network?.[0].txBytes, undefined); assert.deepEqual(result.network?.[0].addresses, ['10.55.0.1/24']);
  assert.equal(normalizeTelemetry({ network: [{ name: 'eth0', rxBytes: 100 }] }, { id: 'legacy' }).network, undefined);
});
