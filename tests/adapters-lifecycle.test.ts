import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { ensureHttpEngine, isEngineReady, waitEngineReady } from '../src/adapters/lifecycle.ts';

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler); instance.listen(0, '127.0.0.1'); await once(instance, 'listening'); const address = instance.address(); assert(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); } };
}
const signal = () => AbortSignal.timeout(5000);
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

test('engine activation switches once then waits for the exact configured model on the direct engine', async () => {
  let current = 'qwen', switches = 0, polls = 0; const states: string[] = [];
  const app = await server((req, res) => {
    if (req.url === '/switch') {
      assert.equal(req.method, 'POST'); switches++; let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { assert.deepEqual(JSON.parse(body), { model: 'deepseek' }); current = 'loading'; json(res, { ok: true }); }); return;
    }
    if (current === 'loading' && ++polls > 1) current = 'ds41-engine';
    json(res, { data: [{ id: current }] });
  });
  try {
    const spec = { modelsUrl: app.url + '/v1/models', switchUrl: app.url + '/switch', expectedModel: 'ds41-engine', body: { model: 'deepseek' }, timeoutMs: 1500, pollMs: 20 };
    await ensureHttpEngine(spec, signal(), state => states.push(state)); assert.equal(switches, 1); assert(states.includes('loading')); assert.equal(states.at(-1), 'ready');
    await ensureHttpEngine(spec, signal()); assert.equal(switches, 1, 'already-ready model must not be restarted');
  } finally { await app.close(); }
});

test('a node-agent static available catalog does not establish engine readiness', async () => {
  const app = await server((_req, res) => json(res, { data: [{ id: 'qwen', status: 'available' }] }));
  try { assert.equal(await isEngineReady({ modelsUrl: app.url, expectedModel: 'qwen' }, signal()), false); } finally { await app.close(); }
});

test('readiness authentication failure does not trigger engine mutation', async () => {
  let switches = 0; const app = await server((req, res) => { if (req.url === '/switch') { switches++; return json(res, { ok: true }); } json(res, {}, 401); });
  try { await assert.rejects(ensureHttpEngine({ modelsUrl: app.url + '/v1/models', switchUrl: app.url + '/switch', expectedModel: 'qwen', timeoutMs: 500 }, signal()), /authorization/); assert.equal(switches, 0); } finally { await app.close(); }
});

test('readiness timeout and cancellation never report ready', async () => {
  const app = await server((_req, res) => json(res, { data: [{ id: 'different-model' }] }));
  try {
    await assert.rejects(waitEngineReady({ modelsUrl: app.url, expectedModel: 'qwen', timeoutMs: 100, pollMs: 20 }, signal()), /deadline/);
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await assert.rejects(waitEngineReady({ modelsUrl: app.url, expectedModel: 'qwen' }, controller.signal), /cancelled/);
  } finally { await app.close(); }
});
