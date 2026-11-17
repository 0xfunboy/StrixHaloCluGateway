import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/server.ts';
import { defaultConfig, type Config } from '../src/config.ts';
import type { Account, ModelRoute, Provider } from '../src/contracts.ts';
import type { Completion } from '../src/orchestrator.ts';
import type { InferenceRequest, InferenceResult, ToolCall } from '../src/adapters/types.ts';
import { AppError, id, now } from '../src/util.ts';

function result(text: string, toolCalls: ToolCall[] = []): InferenceResult {
  return {
    text, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    usage: { inputTokens: 83, outputTokens: 17 },
    metrics: { totalMs: 5, sources: { usage: 'provider', ttft: 'gateway', prefill: 'unknown', decode: 'unknown', context: 'unknown' } },
    quota: { state: 'unknown', source: 'unknown', observedAt: now() },
  };
}

interface PublicToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
  index?: number;
}
interface ChatResponse {
  id: string;
  object: string;
  model?: string;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message?: { role: string; content: string | null; tool_calls?: PublicToolCall[] };
    delta?: { content?: string; tool_calls?: PublicToolCall[] };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function httpFixture(t: test.TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(t: test.TestContext, options: { completion?: Completion; baseUrl?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yed1z-facade-')), workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const config: Config = {
    ...defaultConfig(), port: 0, telemetryIntervalMs: 300_000, links: [],
    nodes: [{ id: 'fixture-node', label: 'Fixture host', kind: 'server', capabilities: ['execution'] }],
    resourceGroups: [{ id: 'fixture-resource', label: 'Fixture inference', nodeIds: [], capacity: 1 }],
    providers: [{
      id: 'fixture-provider', label: 'Fixture inference', kind: 'openai-compatible', enabled: true,
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:1/v1', nodeIds: [], resourceGroupIds: ['fixture-resource'],
      models: [{ model: 'fixture-model', label: 'Fixture model', contextWindow: 8192, capabilities: ['chat', 'tools'] }],
    }],
    targets: [{ id: 'fixture-target', nodeId: 'fixture-node', kind: 'local', workspaceRoot: workspace, commands: [], deployments: [] }],
  };
  // Completion is injected only in the two facade contract tests. Quota and
  // discovery tests exercise the production HTTP adapters against local servers.
  const app = new Application({ directory: path.join(root, 'state'), config, complete: options.completion });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const owner = app.store.createUser('Facade operator', 'admin');
  app.catalog.seed(owner.user);
  const route = app.catalog.models(owner.user)[0];
  const account = app.store.require<Account>('account', route.accountId);
  const port = await app.listen(), url = `http://127.0.0.1:${port}`;
  const request = (endpoint: string, body?: unknown) => fetch(url + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, config, owner, route, account, workspace, request };
}

test('model listing identifies account-specific routes and rejects an ambiguous underlying model without choosing a quota silently', { timeout: 10000 }, async t => {
  const calls: InferenceRequest[] = [];
  const f = await fixture(t, { completion: async request => { calls.push(request); return result('Selected account reached.'); } });
  const alternate = f.app.catalog.addAccount(f.owner.user, f.route.providerId, 'Alternate quota', 'fixture-alternate-secret');
  const alternateRoute = f.app.store.put<ModelRoute>('model', { ...f.route, id: id('mdl'), accountId: alternate.id, label: 'Same model, alternate quota' });
  const listing = await f.request('/v1/models');
  assert.equal(listing.status, 200);
  const catalog = await listing.json() as { object: string; data: Array<{ id: string; object: string; owned_by: string; underlying_model: string }> };
  assert.equal(catalog.object, 'list');
  assert.deepEqual(catalog.data.map(model => model.id).sort(), [f.route.id, alternateRoute.id].sort());
  assert.ok(catalog.data.every(model => model.object === 'model' && model.underlying_model === 'fixture-model' && model.owned_by === f.route.providerId));
  assert.equal(JSON.stringify(catalog).includes('fixture-alternate-secret'), false);
  const ambiguous = await f.request('/v1/chat/completions', { model: 'fixture-model', messages: [{ role: 'user', content: 'Which account?' }] });
  assert.equal(ambiguous.status, 400);
  assert.equal((await ambiguous.json() as { code: string }).code, 'AMBIGUOUS_MODEL');
  assert.equal(calls.length, 0);
  for (const route of [f.route, alternateRoute]) {
    const response = await f.request('/v1/chat/completions', { model: route.id, messages: [{ role: 'user', content: 'Use this exact quota.' }] });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as ChatResponse).model, route.id);
    assert.equal(calls.at(-1)?.connection.accountId, route.accountId);
    assert.equal(calls.at(-1)?.model.id, 'fixture-model');
  }
  assert.equal(calls[1].secret, 'fixture-alternate-secret');
  assert.equal(f.app.scheduler.snapshot()['fixture-resource'], 0);
});

test('facade streams tool calls and final usage, then forwards the canonical assistant/tool roundtrip without executing a tool', { timeout: 10000 }, async t => {
  const calls: InferenceRequest[] = [];
  const argumentsText = '{ "path": "must-not-exist.txt", "content": "client side only" }';
  const toolCall: ToolCall = { id: 'call_client_write', name: 'write_file', arguments: argumentsText };
  const f = await fixture(t, { completion: async request => {
    calls.push(request);
    if (calls.length === 1) return result('', [toolCall]);
    request.onText('Client result received.');
    return result('Client result received.');
  } });
  const parameters = { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false };
  const tools = [{ type: 'function', function: { name: 'write_file', description: 'A client-owned tool; never execute on the inference gateway.', parameters } }];
  const initialMessages = [{ role: 'system', content: 'Use only the client-provided tools.' }, { role: 'user', content: 'Prepare the client write.' }];
  const streaming = await f.request('/v1/chat/completions', { model: f.route.id, messages: initialMessages, tools, stream: true, stream_options: { include_usage: true } });
  assert.equal(streaming.status, 200);
  assert.match(streaming.headers.get('content-type') ?? '', /text\/event-stream/);
  const wire = await streaming.text();
  const frames = wire.trim().split(/\r?\n\r?\n/).map(frame => frame.replace(/^data: /, ''));
  assert.equal(frames.pop(), '[DONE]');
  const chunks = frames.map(frame => JSON.parse(frame) as ChatResponse);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(chunk => chunk.object === 'chat.completion.chunk' && chunk.id === chunks[0].id));
  const toolChunk = chunks.find(chunk => chunk.choices[0]?.delta?.tool_calls?.length)!;
  assert.ok(toolChunk, 'Tool calls must be represented in SSE, not discarded');
  assert.deepEqual(toolChunk.choices[0].delta!.tool_calls, [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: argumentsText } }]);
  const final = chunks.at(-1)!;
  assert.equal(final.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(final.usage, { prompt_tokens: 83, completion_tokens: 17, total_tokens: 100 });
  assert.equal(chunks.filter(chunk => chunk.usage).length, 1);
  assert.deepEqual(calls[0].tools, [{ name: 'write_file', description: tools[0].function.description, parameters }]);
  assert.equal(calls.length, 1, 'The gateway must not start an autonomous tool loop');
  const publicCall = { id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: argumentsText } };
  const followup = await f.request('/v1/chat/completions', {
    model: f.route.id, tools,
    messages: [...initialMessages, { role: 'assistant', content: null, tool_calls: [publicCall] }, { role: 'tool', tool_call_id: toolCall.id, content: '{"ok":true,"source":"client"}' }],
  });
  assert.equal(followup.status, 200);
  const reply = await followup.json() as ChatResponse;
  assert.equal(reply.choices[0].message?.content, 'Client result received.');
  assert.equal(reply.choices[0].finish_reason, 'stop');
  assert.deepEqual(calls[1].messages, [
    ...initialMessages,
    { role: 'assistant', content: '', toolCalls: [toolCall] },
    { role: 'tool', content: '{"ok":true,"source":"client"}', toolCallId: toolCall.id },
  ]);
  assert.deepEqual(calls[1].tools, calls[0].tools);
  assert.equal(calls.length, 2);
  assert.equal(f.app.store.all('run').length, 0);
  assert.equal(f.app.store.all('evidence').length, 0);
  await assert.rejects(readFile(path.join(f.workspace, 'must-not-exist.txt')), { code: 'ENOENT' });
});

test('real upstream HTTP 429 preserves its status and Retry-After and persists the account cooldown before another request', { timeout: 10000 }, async t => {
  let upstreamCalls = 0;
  const upstream = await httpFixture(t, (req, res) => {
    upstreamCalls++;
    assert.equal(req.url, '/v1/chat/completions');
    req.resume();
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '23', 'X-RateLimit-Remaining-Requests': '0' });
    res.end(JSON.stringify({ error: { message: 'Fixture quota exhausted.' } }));
  });
  const f = await fixture(t, { baseUrl: upstream + '/v1' }), before = Date.now();
  const response = await f.request('/v1/chat/completions', { model: f.route.id, messages: [{ role: 'user', content: 'Hit fixture limit.' }], stream: true });
  assert.equal(response.status, 429, 'A limit before the first SSE frame must retain its HTTP status');
  assert.equal(response.headers.get('retry-after'), '23');
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.equal((await response.json() as { code: string }).code, 'UPSTREAM');
  const account = f.app.store.require<Account>('account', f.account.id);
  assert.equal(account.status, 'cooldown');
  assert.equal(account.quota?.remainingRequests, 0);
  assert.equal(account.quota?.source, 'rate-limit');
  const cooldown = Date.parse(account.quota!.cooldownUntil!);
  assert.ok(cooldown >= before + 23000 && cooldown <= Date.now() + 23000);
  const second = await f.request('/v1/chat/completions', { model: f.route.id, messages: [{ role: 'user', content: 'Do not retry a cooling account.' }] });
  assert.equal(second.status, 429);
  assert.equal((await second.json() as { code: string }).code, 'QUOTA');
  assert.equal(upstreamCalls, 1, 'The coordinator must not retry or rotate accounts silently');
  assert.equal(f.app.scheduler.snapshot()['fixture-resource'], 0);
});

test('repeated catalog seeding applies configuration changes while preserving account IDs, secrets and discovered routes', { timeout: 10000 }, async t => {
  let discoveries = 0;
  const fixtureSecret = 'local-fixture-principal-key';
  const upstream = await httpFixture(t, (req, res) => {
    discoveries++;
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, `Bearer ${fixtureSecret}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'fixture-model', name: 'Discovered model label', context_length: 65536, capabilities: ['chat', 'tools', 'vision'] },
      { id: 'discovered-only', name: 'Discovered embedding', context_length: 16384, capabilities: ['embedding'] },
    ] }));
  });
  const f = await fixture(t, { baseUrl: upstream + '/v1' });
  f.app.store.setSecret(f.account.id, fixtureSecret);
  f.app.store.put<Account>('account', { ...f.account, hasSecret: true });
  const alternate = f.app.catalog.addAccount(f.owner.user, f.route.providerId, 'Private alternate', 'local-fixture-alternate-key');
  const alternateRoute = f.app.store.put<ModelRoute>('model', { ...f.route, id: id('mdl'), accountId: alternate.id });
  const discovery = await f.app.catalog.discover(f.owner.user, f.account.id, new AbortController().signal);
  assert.equal(discoveries, 1);
  const discovered = discovery.models.find(route => route.model === 'discovered-only')!;
  assert.ok(discovered);
  const accountIds = f.app.store.all<Account>('account').map(account => account.id).sort();
  const routeIds = f.app.store.all<ModelRoute>('model').map(route => route.id).sort();
  const createdAt = f.app.store.require<Provider>('provider', f.route.providerId).createdAt;
  f.config.providers[0].label = 'Updated operator configuration';
  f.config.providers[0].enabled = false;
  f.config.providers[0].nodeIds = ['fixture-node'];
  f.config.providers[0].baseUrl = upstream + '/updated/v1';
  f.app.catalog.seed(f.owner.user);
  f.app.catalog.seed(f.owner.user);
  assert.deepEqual(f.app.store.all<Account>('account').map(account => account.id).sort(), accountIds);
  assert.deepEqual(f.app.store.all<ModelRoute>('model').map(route => route.id).sort(), routeIds);
  assert.equal(f.app.store.secret(f.account.id), fixtureSecret);
  assert.equal(f.app.store.secret(alternate.id), 'local-fixture-alternate-key');
  assert.equal(f.app.store.require<Account>('account', f.account.id).hasSecret, true);
  assert.equal(f.app.store.require<Account>('account', alternate.id).shared, false);
  const provider = f.app.store.require<Provider>('provider', f.route.providerId);
  assert.equal(provider.label, 'Updated operator configuration');
  assert.equal(provider.baseUrl, upstream + '/updated/v1');
  assert.equal(provider.createdAt, createdAt);
  for (const route of f.app.store.all<ModelRoute>('model')) {
    assert.equal(route.enabled, false);
    assert.deepEqual(route.nodeIds, ['fixture-node']);
  }
  const seeded = f.app.store.require<ModelRoute>('model', f.route.id);
  assert.equal(seeded.contextWindow, 65536);
  assert.deepEqual(seeded.capabilities, ['chat', 'tools', 'vision']);
  assert.equal(seeded.label, 'Discovered model label');
  assert.equal(f.app.store.require<ModelRoute>('model', discovered.id).contextWindow, 16384);
  assert.deepEqual(f.app.store.require<ModelRoute>('model', discovered.id).capabilities, ['embedding']);
  assert.equal(f.app.store.require<ModelRoute>('model', alternateRoute.id).accountId, alternate.id);
  const disabledListing = await f.request('/v1/models');
  assert.deepEqual((await disabledListing.json() as { data: unknown[] }).data, []);
  f.config.providers[0].enabled = true;
  f.app.catalog.seed(f.owner.user);
  assert.ok(f.app.store.all<ModelRoute>('model').every(route => route.enabled));
  assert.deepEqual(f.app.store.all<ModelRoute>('model').map(route => route.id).sort(), routeIds);
  assert.equal(discoveries, 1, 'Seeding configuration must not trigger hidden discovery or inference');
});

test('discovery exposes provider errors without logging out the portal user and preserves rate-limit cooldown and ownership errors', { timeout: 10000 }, async t => {
  let status = 401, calls = 0;
  const upstream = await httpFixture(t, (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/models');
    res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '19', 'X-RateLimit-Remaining-Requests': '0' } : {}) });
    res.end(JSON.stringify({ error: { message: 'Fixture failure, token=must-not-reach-browser' } }));
  });
  const f = await fixture(t, { baseUrl: upstream + '/v1' });
  const rejectedKey = await f.request(`/api/accounts/${f.account.id}/discover`, {});
  assert.equal(rejectedKey.status, 502, 'Provider 401 is not a gateway authentication failure');
  const keyError = await rejectedKey.json() as { code: string; error: string };
  assert.equal(keyError.code, 'UPSTREAM');
  assert.match(keyError.error, /401/i);
  assert.equal(JSON.stringify(keyError).includes('must-not-reach-browser'), false);
  assert.equal((await f.request('/api/bootstrap')).status, 200, 'The same authenticated portal session remains valid');
  const outsider = f.app.store.createUser('Other operator', 'admin');
  await assert.rejects(f.app.catalog.discover(outsider.user, f.account.id, new AbortController().signal), error => error instanceof AppError && error.status === 404 && error.code === 'NOT_FOUND');
  assert.equal(calls, 1, 'Ownership rejection must precede any provider request');
  status = 429;
  const before = Date.now();
  const limited = await f.request(`/api/accounts/${f.account.id}/discover`, {});
  assert.equal(limited.status, 429);
  const quotaError = await limited.json() as { code: string; error: string };
  assert.equal(quotaError.code, 'QUOTA');
  assert.match(quotaError.error, /quota/i);
  const account = f.app.store.require<Account>('account', f.account.id);
  assert.equal(account.status, 'cooldown');
  assert.equal(account.quota?.remainingRequests, 0);
  assert.equal(account.quota?.source, 'rate-limit');
  const cooldown = Date.parse(account.quota!.cooldownUntil!);
  assert.ok(cooldown >= before + 19000 && cooldown <= Date.now() + 19000);
  assert.equal(calls, 2);
});

test('successful discovery retires missing routes, preserves history IDs and operator capability declarations, and does not resurrect them at restart', { timeout: 10000 }, async t => {
  let currentModel = 'model-a', available = true;
  const upstream = await httpFixture(t, (_req, res) => {
    res.writeHead(available ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(available ? { data: [{ id: currentModel }] } : { error: { message: 'temporarily unavailable' } }));
  });
  const f = await fixture(t, { baseUrl: upstream + '/v1' });
  const first = await f.app.catalog.discover(f.owner.user, f.account.id, AbortSignal.timeout(5000));
  const old = first.models[0];
  f.app.store.put<ModelRoute>('model', { ...old, capabilities: ['chat', 'tools'], capabilitySource: 'operator' });
  const repeated = await f.app.catalog.discover(f.owner.user, f.account.id, AbortSignal.timeout(5000));
  assert.deepEqual(repeated.models[0].capabilities, ['chat', 'tools']);
  assert.equal(repeated.models[0].capabilitySource, 'operator');
  available = false;
  await assert.rejects(f.app.catalog.discover(f.owner.user, f.account.id, AbortSignal.timeout(5000)), { code: 'UPSTREAM' });
  assert.equal(f.app.store.require<ModelRoute>('model', old.id).enabled, true, 'A failed catalog read cannot retire known models');
  available = true; currentModel = 'model-b';
  const second = await f.app.catalog.discover(f.owner.user, f.account.id, AbortSignal.timeout(5000));
  assert.equal(second.models.length, 1); assert.equal(second.models[0].model, 'model-b');
  assert.equal(f.app.store.require<ModelRoute>('model', old.id).enabled, false);
  assert.equal(f.app.store.require<ModelRoute>('model', old.id).discoveryStatus, 'missing');
  assert.throws(() => f.app.catalog.resolve(f.owner.user, old.id), { code: 'DISABLED' });
  f.app.catalog.seed(f.owner.user);
  assert.equal(f.app.store.require<ModelRoute>('model', old.id).enabled, false);
  const listed = await f.request('/v1/models');
  assert.deepEqual((await listed.json() as { data: Array<{ id: string }> }).data.map(row => row.id), [second.models[0].id]);
  currentModel = 'model-a';
  const restored = await f.app.catalog.discover(f.owner.user, f.account.id, AbortSignal.timeout(5000));
  assert.equal(restored.models[0].id, old.id);
  assert.equal(restored.models[0].enabled, true);
  assert.equal(restored.models[0].discoveryStatus, 'present');
});
