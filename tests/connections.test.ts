import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connections } from '../src/connections.ts';
import { Catalog } from '../src/catalog.ts';
import { Store } from '../src/store.ts';
import { Scheduler } from '../src/scheduler.ts';
import { RouteRouter } from '../src/routing.ts';
import { defaultConfig, type Config } from '../src/config.ts';
import { loginNative, runNativeAgent } from '../src/adapters/native.ts';
import { discoverModels } from '../src/adapters/inference.ts';
import type { Account, ModelRoute, Project, Provider, Run } from '../src/contracts.ts';
import type { ConnectionInput } from '../src/connection-types.ts';
import { AppError, now } from '../src/util.ts';

const cliFixture = fileURLToPath(new URL('./connections-cli-fixture.ts', import.meta.url));
const codexFixture = fileURLToPath(new URL('./adapters-cli-fixture.ts', import.meta.url));
const signal = () => AbortSignal.timeout(5000);
async function endpoint(t: test.TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
}
async function fixture(t: test.TestContext, providers: Config['providers'] = []) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yed1z-connect-'));
  const store = new Store(directory), config = { ...defaultConfig(), providers };
  const owner = store.createUser('Connection owner', 'admin').user;
  const member = store.createUser('Member', 'member').user;
  const other = store.createUser('Other operator', 'operator').user;
  const viewer = store.createUser('Viewer', 'viewer').user;
  const catalog = new Catalog(store, config, new Scheduler(config.resourceGroups));
  catalog.seed(owner);
  const connections = new Connections(catalog);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, config, owner, member, other, viewer, catalog, connections };
}
const isError = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const models = { data: [{ id: 'fixture-chat', capabilities: ['chat', 'tools'], context_window: 32768 }, { id: 'fixture-embedding', capabilities: ['embedding'] }] };

test('one connect discovers all HTTP models; concurrent and repeated enrollment reuses provider/account without exposing secrets', async t => {
  let calls = 0;
  const url = await endpoint(t, (req, res) => { calls++; assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer PRIVATE_HTTP_KEY'); setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(models)); }, 30); });
  const f = await fixture(t);
  const input: ConnectionInput = { preset: 'custom', label: '', accountLabel: '', baseUrl: url + '/chat/completions', secret: 'PRIVATE_HTTP_KEY', requestId: 'double-click', modelIds: [] };
  const [first, simultaneous] = await Promise.all([f.connections.connect(f.owner, input, signal()), f.connections.connect(f.owner, input, signal())]);
  assert.equal(first.status, 'ready'); assert.equal(first.models.length, 2); assert.equal(calls, 1);
  assert.equal(simultaneous.account.id, first.account.id); assert.equal(first.provider.baseUrl, url);
  const repeated = await f.connections.connect(f.owner, { ...input, providerId: first.provider.id, accountId: first.account.id }, signal());
  assert.equal(repeated.account.id, first.account.id); assert.deepEqual(repeated.reused, { provider: true, account: true });
  assert.equal(f.store.all('provider').length, 1); assert.equal(f.store.all('account').length, 1); assert.equal(f.store.all('model').length, 2);
  assert.equal(f.store.secret(first.account.id), 'PRIVATE_HTTP_KEY');
  assert(!JSON.stringify({ first, repeated, receipts: f.store.all('connection-enrollment') }).includes('PRIVATE_HTTP_KEY'));
  assert(!(await readFile(path.join(f.directory, 'control.sqlite'))).includes(Buffer.from('PRIVATE_HTTP_KEY')));
});

test('a rejected API key remains recoverable on the same account; another owner cannot reuse the enrollment', async t => {
  const url = await endpoint(t, (req, res) => { res.writeHead(req.headers.authorization === 'Bearer valid-new-key' ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(models)); });
  const f = await fixture(t);
  const first = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url, secret: 'wrong-key', requestId: 'correct-me' }, signal());
  assert.equal(first.status, 'unavailable'); assert.equal(first.account.status, 'error'); assert.match(first.message, /rifiutato/);
  await assert.rejects(f.connections.connect(f.other, { providerId: first.provider.id, accountId: first.account.id }, signal()), isError('NOT_FOUND'));
  const fixed = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url, secret: 'valid-new-key', accountId: first.account.id, requestId: 'correct-me' }, signal());
  assert.equal(fixed.status, 'ready'); assert.equal(fixed.account.id, first.account.id); assert.equal(f.store.all('account').length, 1);
});

test('manual model IDs work with an unsupported model catalog and remain explicitly unverified', async t => {
  const url = await endpoint(t, (_req, res) => { res.writeHead(404); res.end(); });
  const f = await fixture(t);
  const result = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url, modelIds: ['operator-declared-model'] }, signal());
  assert.equal(result.status, 'unverified'); assert.equal(result.account.status, 'unknown');
  assert.equal(result.models[0].model, 'operator-declared-model'); assert.deepEqual(result.models[0].capabilities, ['chat']);
  assert.equal(result.models[0].capabilitySource, 'operator');
  assert.match(result.warnings[0], /HTTP 404/);
});

test('manual IDs do not disguise rejected credentials or provider rate limits', async t => {
  let rateLimited = false;
  const url = await endpoint(t, (_req, res) => { res.writeHead(rateLimited ? 429 : 403, { 'Retry-After': '45' }); res.end(); });
  const f = await fixture(t);
  const first = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url, modelIds: ['guessed'] }, signal());
  assert.equal(first.status, 'unavailable'); assert.equal(first.models.length, 0);
  rateLimited = true;
  const second = await f.connections.connect(f.owner, { providerId: first.provider.id, accountId: first.account.id, modelIds: ['guessed'] }, signal());
  assert.equal(second.status, 'unavailable'); assert.equal(second.models.length, 0); assert.equal(second.account.status, 'cooldown');
  assert.ok(second.account.quota?.cooldownUntil); assert.ok(Date.parse(second.account.quota.cooldownUntil) > Date.now());
});

test('configured endpoints are reused with their resource groups and member credentials stay private', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify(models)));
  const f = await fixture(t, [{ id: 'configured', kind: 'openai-compatible', label: 'Existing cluster', baseUrl: url, enabled: true, nodeIds: ['strix01', 'strix02'], resourceGroupIds: ['strix01-memory', 'strix02-memory'] }]);
  const owned = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url }, signal());
  assert.equal(owned.provider.id, 'configured'); assert.equal(f.store.all('provider').length, 1);
  assert.deepEqual(owned.models[0].nodeIds, ['strix01', 'strix02']);
  const member = await f.connections.connect(f.member, { providerId: 'configured', accountLabel: 'My own key', secret: 'member-private-key' }, signal());
  assert.equal(member.status, 'ready'); assert.equal(member.account.shared, false); assert.equal(member.account.ownerId, f.member.id);
  assert.deepEqual(f.connections.options(f.member).presets, []);
  assert(!JSON.stringify(f.connections.options(f.owner)).includes('member-private-key'));
  await assert.rejects(f.connections.connect(f.viewer, { providerId: 'configured' }, signal()), isError('FORBIDDEN'));
});

test('an idle owned UI connection updates inherited hardware on every account, preserves omitted fields and supports explicit clearing', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify(models))), f = await fixture(t);
  const first = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url, shared: true, requestId: 'hardware-retry' }, signal());
  const member = await f.connections.connect(f.member, { providerId: first.provider.id, accountLabel: 'Member' }, signal());
  const customized = member.models.find(model => model.capabilities.includes('embedding'))!;
  f.store.put('model', { ...customized, resourceGroupIds: ['strix02-memory'], maxOutputTokens: 1234 });
  const updated = await f.connections.connect(f.owner, { providerId: first.provider.id, accountId: first.account.id, requestId: 'hardware-retry', nodeIds: ['aireward'], resourceGroupIds: ['cuda3090-memory'] }, signal());
  assert.deepEqual(updated.provider.nodeIds, ['aireward']); assert.deepEqual(updated.provider.resourceGroupIds, ['cuda3090-memory']);
  assert.equal(updated.account.id, first.account.id); assert.equal(f.store.all('provider').length, 1); assert.equal(f.store.all('account').length, 2);
  for (const route of f.store.all<ModelRoute>('model').filter(model => model.providerId === first.provider.id)) {
    assert.deepEqual(route.nodeIds, ['aireward']);
    assert.deepEqual(route.resourceGroupIds, route.id === customized.id ? ['strix02-memory'] : ['cuda3090-memory']);
  }
  assert.equal(f.store.require<ModelRoute>('model', customized.id).maxOutputTokens, 1234);
  const nodesOnly = await f.connections.connect(f.owner, { accountId: first.account.id, nodeIds: ['strix01'] }, signal());
  assert.deepEqual(nodesOnly.provider.nodeIds, ['strix01']); assert.deepEqual(nodesOnly.provider.resourceGroupIds, ['cuda3090-memory']);
  const omitted = await f.connections.connect(f.owner, { accountId: first.account.id }, signal());
  assert.deepEqual(omitted.provider.nodeIds, ['strix01']); assert.deepEqual(omitted.provider.resourceGroupIds, ['cuda3090-memory']);
  const cleared = await f.connections.connect(f.owner, { accountId: first.account.id, nodeIds: [], resourceGroupIds: [] }, signal());
  assert.deepEqual(cleared.provider.nodeIds, []); assert.deepEqual(cleared.provider.resourceGroupIds, []);
  assert.deepEqual(cleared.models.map(model => model.nodeIds), [[], []]);
});

test('file-configured hardware rejects explicit differences before changing accounts or credentials, while an unchanged topology is accepted', async t => {
  let calls = 0;
  const url = await endpoint(t, (_req, res) => { calls++; res.end(JSON.stringify(models)); });
  const f = await fixture(t, [{ id: 'configured', kind: 'openai-compatible', label: 'Configured engine', baseUrl: url, enabled: true, nodeIds: ['strix01', 'strix02'], resourceGroupIds: ['strix01-memory', 'strix02-memory'] }]);
  const existing = f.catalog.accounts(f.owner)[0];
  f.store.setSecret(existing.id, 'original-key');
  for (const changed of [{ nodeIds: [] }, { resourceGroupIds: ['cuda3090-memory'] }]) {
    await assert.rejects(f.connections.connect(f.owner, { providerId: 'configured', accountId: existing.id, secret: 'replacement-key', accountLabel: 'Should not change', ...changed }, signal()), error => isError('CONFIGURED_PROVIDER')(error) && /file di configurazione/.test((error as Error).message));
  }
  assert.equal(calls, 0); assert.equal(f.store.secret(existing.id), 'original-key');
  assert.equal(f.store.require<Account>('account', existing.id).label, 'Principale');
  const unchanged = await f.connections.connect(f.owner, { providerId: 'configured', nodeIds: ['strix02', 'strix01'], resourceGroupIds: ['strix02-memory', 'strix01-memory'] }, signal());
  assert.equal(unchanged.status, 'ready'); assert.deepEqual(unchanged.provider.nodeIds, ['strix01', 'strix02']);
});

test('hardware changes require the trusted provider owner and reject unknown resource references without creating partial accounts', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify(models))), f = await fixture(t);
  const first = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url, shared: true }, signal());
  for (const user of [f.member, f.other, { ...f.owner, role: 'member' as const }]) {
    await assert.rejects(f.connections.connect(user, { providerId: first.provider.id, nodeIds: ['aireward'] }, signal()), isError('FORBIDDEN'));
  }
  for (const invalid of [{ nodeIds: ['unknown-node'] }, { resourceGroupIds: ['unknown-group'] }]) {
    await assert.rejects(f.connections.connect(f.owner, { accountId: first.account.id, ...invalid }, signal()), isError('RESOURCE'));
  }
  assert.equal(f.store.all('account').length, 1); assert.deepEqual(f.store.require<Provider>('provider', first.provider.id).nodeIds, []);
});

test('a facade-style lease on any account blocks provider rebinding even below concurrency capacity and without a persisted run', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify(models))), f = await fixture(t);
  const first = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url, shared: true }, signal());
  const member = await f.connections.connect(f.member, { providerId: first.provider.id, accountLabel: 'Member' }, signal());
  const router = new RouteRouter(f.catalog), route = member.models.find(model => model.capabilities.includes('chat'))!;
  const lease = await router.reserve({ user: f.member, preferredRouteId: route.id, purpose: 'chat', nativeAllowed: false, maxWaitMs: 0, signal: signal() });
  try {
    assert.equal(f.store.all('run').length, 0);
    assert.equal(f.catalog.scheduler.inspect(['account:' + member.account.id]).activeCount, 1);
    await assert.rejects(f.connections.connect(f.owner, { accountId: first.account.id, nodeIds: ['aireward'] }, signal()), isError('TOPOLOGY_BUSY'));
    assert.deepEqual(f.store.require<Provider>('provider', first.provider.id).nodeIds, []);
  } finally { lease.release(); }
  const updated = await f.connections.connect(f.owner, { accountId: first.account.id, nodeIds: ['aireward'] }, signal());
  assert.deepEqual(updated.provider.nodeIds, ['aireward']);
});

test('a queued route reservation blocks rebinding before any account lease is granted', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify(models))), f = await fixture(t);
  const first = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url, nodeIds: ['aireward'], resourceGroupIds: ['cuda3090-memory'] }, signal());
  const releaseHardware = await f.catalog.scheduler.acquire(['cuda3090-memory'], signal());
  const controller = new AbortController(), router = new RouteRouter(f.catalog), route = first.models.find(model => model.capabilities.includes('chat'))!;
  const waiting = router.reserve({ user: f.owner, preferredRouteId: route.id, purpose: 'chat', maxWaitMs: 4000, signal: controller.signal }).then(lease => { lease.release(); return undefined; }, error => error);
  try {
    const inspection = f.catalog.scheduler.inspect(['account:' + first.account.id]);
    assert.equal(inspection.activeCount, 0); assert.equal(inspection.queueCount, 1);
    await assert.rejects(f.connections.connect(f.owner, { accountId: first.account.id, nodeIds: ['strix01'], resourceGroupIds: ['strix01-memory'] }, signal()), isError('TOPOLOGY_BUSY'));
    assert.deepEqual(f.store.require<Provider>('provider', first.provider.id).nodeIds, ['aireward']);
  } finally { controller.abort(); releaseHardware(); await waiting; }
  const updated = await f.connections.connect(f.owner, { accountId: first.account.id, nodeIds: ['strix01'], resourceGroupIds: ['strix01-memory'] }, signal());
  assert.deepEqual(updated.provider.nodeIds, ['strix01']);
});

test('open runs protect primary, task, fallback and future project routes between inference leases', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify(models))), f = await fixture(t);
  const first = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url }, signal());
  const alternative = await f.connections.connect(f.owner, { preset: 'custom', baseUrl: url + '/alternative' }, signal());
  const route = first.models.find(model => model.capabilities.includes('chat'))!, other = alternative.models.find(model => model.capabilities.includes('chat'))!;
  const project: Project = { id: 'hardware-project', ownerId: f.owner.id, memberIds: [], name: 'Hardware audit', description: '', routes: {}, verifyRecipeIds: [], createdAt: now(), updatedAt: now() };
  const run: Run = { id: 'hardware-run', projectId: project.id, conversationId: 'hardware-conversation', ownerId: f.owner.id, goal: 'Implement feature', mode: 'mission', status: 'executing', phase: 'Between model requests', routeId: other.id, tasks: [], iteration: 0, maxIterations: 1, maxParallel: 1, budget: { maxModelCalls: 4, maxOutputTokens: 4096, callsUsed: 0, outputTokensUsed: 0 }, permissions: { write: true, commands: false, deploy: false }, createdAt: now(), updatedAt: now() };
  for (const kind of ['primary', 'task', 'fallback', 'project-coder', 'project-embedding']) {
    f.store.put('project', { ...project, routes: kind === 'project-coder' ? { coder: route.id } : kind === 'project-embedding' ? { embedding: route.id } : {} });
    f.store.put('run', { ...run, routeId: kind === 'primary' ? route.id : other.id,
      routing: kind === 'fallback' ? { strategy: 'auto', fallbackRouteIds: [route.id] } : undefined,
      tasks: kind === 'task' ? [{ id: 'hardware-task', runId: run.id, label: 'Developer', role: 'coder', instruction: 'Implement feature', dependencies: [], routeId: route.id, status: 'queued', attempt: 1, evidenceIds: [] }] : [] });
    assert.equal(f.catalog.scheduler.inspect(['account:' + first.account.id]).activeCount, 0);
    await assert.rejects(f.connections.connect(f.owner, { accountId: first.account.id, nodeIds: ['aireward'] }, signal()), isError('TOPOLOGY_BUSY'), kind);
  }
  f.store.put('run', { ...run, routeId: route.id, status: 'succeeded' });
  const updated = await f.connections.connect(f.owner, { accountId: first.account.id, nodeIds: ['aireward'] }, signal());
  assert.deepEqual(updated.provider.nodeIds, ['aireward']);
});

test('configured lifecycle standby is distinct from authentication failure and never runs activation during enrollment', async t => {
  let rejected = false, switches = 0;
  const url = await endpoint(t, (req, res) => { if (req.method === 'POST') switches++; res.writeHead(rejected ? 401 : 503); res.end(); });
  const f = await fixture(t, [{ id: 'sleeping-engine', kind: 'openai-compatible', label: 'Switchable engine', baseUrl: url, enabled: true, nodeIds: ['strix01', 'strix02'], resourceGroupIds: ['strix01-memory', 'strix02-memory'], activation: { modelsUrl: url + '/models', expectedModel: 'configured-model', switchUrl: url + '/switch' }, models: [{ model: 'configured-model', label: 'Configured model', capabilities: ['chat', 'tools'] }] }]);
  const standby = await f.connections.connect(f.owner, { providerId: 'sleeping-engine' }, signal());
  assert.equal(standby.status, 'standby'); assert.equal(standby.account.status, 'unknown'); assert.equal(standby.models[0].model, 'configured-model');
  rejected = true;
  const forbidden = await f.connections.connect(f.owner, { providerId: 'sleeping-engine', accountId: standby.account.id }, signal());
  assert.equal(forbidden.status, 'unavailable'); assert.equal(forbidden.account.status, 'error'); assert.equal(switches, 0);
});

test('new local endpoints inherit the known coordinator resource binding while GemRouter remains an inference provider', async t => {
  const url = await endpoint(t, (req, res) => { assert.ok(['/api/tags', '/api/show', '/v1/models'].includes(req.url!)); res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'local-fixture', capabilities: ['chat'] }] } : req.url === '/api/show' ? { capabilities: ['completion', 'tools'], parameters: 'num_ctx 4096' } : models)); });
  const f = await fixture(t);
  const result = await f.connections.connect(f.owner, { preset: 'ollama', baseUrl: url.replace('/v1', ''), nodeIds: [], resourceGroupIds: [] }, signal());
  assert.equal(result.status, 'ready'); assert.deepEqual(result.provider.nodeIds, ['strix01']); assert.deepEqual(result.provider.resourceGroupIds, ['strix01-memory']);
  assert.deepEqual(result.models[0].nodeIds, ['strix01']);
  const router = await f.connections.connect(f.owner, { preset: 'gemrouter', baseUrl: url }, signal());
  assert.equal(router.status, 'ready'); assert.deepEqual(router.provider.nodeIds, []); assert.deepEqual(router.provider.resourceGroupIds, []);
});

test('enrollment rejects arbitrary runtime fields, URL credentials, unknown resources and native token input before writing state', async t => {
  const f = await fixture(t);
  for (const input of [
    { preset: 'codex', command: 'anything' },
    { preset: 'custom', baseUrl: 'http://user:password@127.0.0.1/v1' },
    { preset: 'custom', baseUrl: 'http://127.0.0.1:1/v1', nodeIds: ['unknown'] },
    { preset: 'codex', secret: 'oauth-token-should-not-be-imported' }
  ]) await assert.rejects(f.connections.connect(f.owner, input as ConnectionInput, signal()));
  assert.equal(f.store.all('provider').length, 0); assert.equal(f.store.all('account').length, 0);
  await assert.rejects(f.connections.connect(f.member, { preset: 'custom', baseUrl: 'http://127.0.0.1:1/v1' }, signal()), isError('FORBIDDEN'));
});

test('Antigravity discovery uses an actual ACP handshake and only advertised model choices', async t => {
  const f = await fixture(t, [{ id: 'agy-profile', label: 'Antigravity fixture', kind: 'antigravity', command: process.execPath, args: [cliFixture], env: { FIXTURE_FLAG: 'operator-only' }, nodeIds: [], resourceGroupIds: [], enabled: true }]);
  const result = await f.connections.connect(f.owner, { preset: 'antigravity', providerId: 'agy-profile' }, signal());
  assert.equal(result.status, 'ready'); assert.equal(result.account.status, 'ready');
  assert.deepEqual(result.models.map(m => m.model), ['observed-fixture-model']); assert.equal(result.models[0].contextWindow, undefined);
  assert(!('command' in result.provider)); assert(!('args' in result.provider)); assert(!('env' in result.provider));
  assert(!JSON.stringify(result).includes('PRIVATE_'));
  assert.equal(result.account.shared, false);
});

test('Antigravity auth-required disables stale routes and offers verified terminal instructions without claiming login success', async t => {
  const f = await fixture(t, [{ id: 'agy-profile', label: 'Antigravity fixture', kind: 'antigravity', command: process.execPath, args: [cliFixture, 'unauthenticated'], nodeIds: [], resourceGroupIds: [], enabled: true, models: [{ model: 'old-unverified-model', label: 'Old model' }] }]);
  const result = await f.connections.connect(f.owner, { preset: 'antigravity', providerId: 'agy-profile' }, signal());
  assert.equal(result.status, 'login-required'); assert.equal(result.account.status, 'unknown'); assert.match(result.nextAction?.command ?? '', /--gemini-dir.*--login/);
  assert(result.models.every(model => !model.enabled));
  await assert.rejects(loginNative({ connection: f.catalog.connection(f.store.require<Provider>('provider', result.provider.id), result.account), cwd: f.directory, signal: signal(), onAuth: () => assert.fail('No fabricated OAuth event') }), /CLI Google non ha confermato/);
  const other = await f.connections.connect(f.other, { providerId: 'agy-profile' }, signal());
  assert.equal(other.status, 'login-required');
  assert.notEqual(other.account.id, result.account.id);
  assert.notEqual(other.nextAction?.command, result.nextAction?.command);
  await assert.rejects(f.connections.connect(f.other, { accountId: result.account.id }, signal()), isError('NOT_FOUND'));
});

test('Antigravity model discovery reads the selected private profile without changing the other account', async t => {
  const f = await fixture(t, [{ id: 'agy-profile', label: 'Antigravity fixture', kind: 'antigravity', command: process.execPath, args: [cliFixture, 'profile-file'], nodeIds: [], resourceGroupIds: [], enabled: true }]);
  const first = await f.connections.connect(f.owner, { providerId: 'agy-profile', accountLabel: 'First' }, signal());
  const second = await f.connections.connect(f.owner, { providerId: 'agy-profile', accountLabel: 'Second' }, signal());
  assert.equal(first.account.nativeProfile, 'isolated');
  assert.equal(first.status, 'login-required');
  assert.equal(second.status, 'login-required');
  const provider = f.store.require<Provider>('provider', 'agy-profile');
  const dir = (account: Account) => f.catalog.connection(provider, account).isolatedProfilePath!;
  assert.notEqual(dir(first.account), dir(second.account));
  for (const account of [first.account, second.account]) {
    assert.equal((await stat(dir(account))).mode & 0o777, 0o700);
    assert(first.nextAction?.command?.includes(dir(account)) === (account.id === first.account.id));
  }
  await writeFile(path.join(dir(first.account), 'gemini', 'fixture-signed-in'), '', { mode: 0o600 });
  assert.equal((await f.connections.connect(f.owner, { accountId: first.account.id }, signal())).status, 'ready');
  assert.equal((await f.connections.connect(f.owner, { accountId: second.account.id }, signal())).status, 'login-required');
});

test('Antigravity supports advertised legacy selectors and labels an opaque current selection without inventing model IDs', async t => {
  for (const mode of ['legacy-models', 'no-models']) {
    const f = await fixture(t, [{ id: 'agy-profile', label: 'Antigravity fixture', kind: 'antigravity', command: process.execPath, args: [cliFixture, mode], nodeIds: [], resourceGroupIds: [], enabled: true }]);
    const result = await f.connections.connect(f.owner, { providerId: 'agy-profile' }, signal());
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.models.map(m => m.model), [mode === 'legacy-models' ? 'observed-legacy-model' : 'current']);
    if (mode === 'no-models') { assert.equal(result.models[0].capabilitySource, 'unknown'); assert.equal(result.models[0].contextWindow, undefined); assert.match(result.warnings[0], /non espone/); }
  }
});

test('native executable absence is a setup state, never a manufactured model catalog', async t => {
  const f = await fixture(t, [{ id: 'missing-codex', label: 'Codex unavailable', kind: 'codex', command: '/definitely-missing/yed1z-cli-fixture', nodeIds: [], resourceGroupIds: [], enabled: true }]);
  const result = await f.connections.connect(f.owner, { providerId: 'missing-codex' }, signal());
  assert.equal(result.status, 'setup-required'); assert.equal(result.models.length, 0); assert.equal(result.nextAction?.kind, 'configure-runtime');
  assert(!('command' in result.provider));
});

test('Codex enrollment discovers from isolated runtime profiles and distinct account labels create distinct homes', async t => {
  const f = await fixture(t, [{ id: 'codex-profile', label: 'Codex fixture', kind: 'codex', command: process.execPath, args: [codexFixture], nodeIds: [], resourceGroupIds: [], enabled: true }]);
  const a = await f.connections.connect(f.owner, { providerId: 'codex-profile', accountLabel: 'Account A' }, signal());
  const b = await f.connections.connect(f.owner, { providerId: 'codex-profile', accountLabel: 'Account B' }, signal());
  assert.equal(a.status, 'ready'); assert.equal(b.status, 'ready'); assert.notEqual(a.account.id, b.account.id);
  const p = f.store.require<Provider>('provider', a.provider.id);
  const homeA = f.catalog.connection(p, a.account).env!.CODEX_HOME, homeB = f.catalog.connection(p, b.account).env!.CODEX_HOME;
  assert.notEqual(homeA, homeB); assert.equal((await stat(homeA)).mode & 0o777, 0o700); assert.equal((await stat(homeB)).mode & 0o777, 0o700);
  assert(!JSON.stringify([a, b]).includes('CODEX_HOME')); assert.equal(a.account.shared, false);
});

test('an explicit quota domain shares observed cooldown with its owner’s other credentials only', async t => {
  const url = await endpoint(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: 'fixture' }] })));
  const f = await fixture(t, [{ id: 'quota-fixture', kind: 'openai-compatible', label: 'Quota fixture', baseUrl: url, enabled: true, nodeIds: [], resourceGroupIds: [] }]);
  const first = await f.connections.connect(f.owner, { providerId: 'quota-fixture', accountLabel: 'First key', shared: true, quotaDomain: 'Work Pool' }, signal());
  const second = await f.connections.connect(f.owner, { providerId: 'quota-fixture', accountLabel: 'Second key', quotaDomain: 'work pool' }, signal());
  const other = await f.connections.connect(f.other, { providerId: 'quota-fixture', accountLabel: 'Other owner', quotaDomain: 'Work Pool' }, signal());
  f.catalog.quota(first.account, { state: 'limited', source: 'provider-headers', observedAt: now(), retryAfterMs: 60000 });
  assert.throws(() => f.catalog.resolve(f.owner, second.models[0].id), isError('QUOTA'));
  assert.equal(f.catalog.accounts(f.owner).find(item => item.id === second.account.id)?.status, 'cooldown');
  assert.equal(f.catalog.resolve(f.other, other.models[0].id).account.id, other.account.id);
  assert.equal(f.catalog.accounts(f.other).find(item => item.id === first.account.id)?.quotaDomain, undefined);
  const cleared = await f.connections.connect(f.owner, { accountId: second.account.id, quotaDomain: '' }, signal());
  assert.equal(cleared.status, 'ready');
  assert.equal(cleared.account.quotaDomain, undefined);
  assert.throws(() => f.catalog.resolve(f.owner, first.models[0].id), isError('QUOTA'));
});

test('Codex login reports an owner-only pending device challenge and clears it on cancellation', async t => {
  const f = await fixture(t, [{ id: 'codex-profile', label: 'Codex fixture', kind: 'codex', command: process.execPath, args: [codexFixture, 'login-hang'], nodeIds: [], resourceGroupIds: [], enabled: true }]);
  const { account } = await f.connections.connect(f.owner, { providerId: 'codex-profile' }, signal());
  const events: string[] = [];
  let pending!: () => void, cancelled!: () => void;
  const pendingEvent = new Promise<void>(resolve => { pending = resolve; });
  const cancelledEvent = new Promise<void>(resolve => { cancelled = resolve; });
  const started = f.connections.startNativeLogin(f.owner, account.id, signal(), state => {
    events.push(state.status);
    if (state.status === 'pending') pending();
    if (state.status === 'cancelled') cancelled();
  });
  assert.equal(started.status, 'starting');
  await pendingEvent;
  const snapshot = f.connections.nativeLogin(f.owner, account.id);
  assert.equal(snapshot.status, 'pending');
  assert.equal(snapshot.userCode, 'ABCD-EFGH');
  assert.throws(() => f.connections.nativeLogin(f.other, account.id), isError('NOT_FOUND'));
  assert.deepEqual(f.connections.startNativeLogin(f.owner, account.id, signal(), () => assert.fail('duplicate login')), snapshot);
  const stopped = f.connections.cancelNativeLogin(f.owner, account.id);
  assert.equal(stopped.status, 'cancelled');
  assert(!('userCode' in stopped));
  await cancelledEvent;
  assert.deepEqual(events, ['pending', 'cancelled']);
});

test('a busy native account is reported promptly without corrupting its valid account state', async t => {
  const f = await fixture(t, [{ id: 'codex-profile', label: 'Codex fixture', kind: 'codex', command: process.execPath, args: [codexFixture, 'hang'], nodeIds: [], resourceGroupIds: [], enabled: true }]);
  const connected = await f.connections.connect(f.owner, { providerId: 'codex-profile' }, signal());
  const provider = f.store.require<Provider>('provider', connected.provider.id), controller = new AbortController();
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const running = runNativeAgent({ connection: f.catalog.connection(provider, connected.account), cwd: f.directory, model: { id: 'fixture-model' }, prompt: 'fixture', readOnly: true, signal: controller.signal, approve: async () => false, onEvent: event => { if (event.type === 'text') entered(); } });
  void running.catch(() => {});
  try {
    await ready;
    const result = await f.connections.connect(f.owner, { accountId: connected.account.id }, AbortSignal.timeout(500));
    assert.equal(result.status, 'unavailable'); assert.match(result.message, /sta lavorando/); assert.equal(result.account.status, 'ready');
  } finally { controller.abort(); await assert.rejects(running); }
});

test('detect is bounded to two local defaults and permitted configured endpoints without creating accounts', async t => {
  let configuredCalls = 0, hiddenCalls = 0;
  const url = await endpoint(t, (req, res) => { if (req.url?.startsWith('/hidden')) hiddenCalls++; else configuredCalls++; res.end(JSON.stringify(models)); });
  const f = await fixture(t, [{ id: 'known-endpoint', kind: 'openai-compatible', label: 'Known endpoint', baseUrl: url, enabled: true, nodeIds: [], resourceGroupIds: [] }]);
  f.store.put<Provider>('provider', { id: 'private-other', ownerId: f.other.id, kind: 'openai-compatible', label: 'Private other', baseUrl: url.replace('/v1', '/hidden'), enabled: true, nodeIds: [], resourceGroupIds: [], createdAt: now() });
  const before = f.store.all('account').length;
  const detected = await f.connections.detect(f.owner, signal());
  assert.equal(detected.candidates.length, 3); assert.equal(detected.candidates.find(c => c.providerId === 'known-endpoint')?.status, 'available');
  assert.equal(configuredCalls, 1); assert.equal(hiddenCalls, 0); assert.equal(f.store.all('account').length, before);
  assert(detected.candidates.every(c => ['http://127.0.0.1:11434', 'http://127.0.0.1:1234/v1', url].includes(c.baseUrl)));
  await assert.rejects(f.connections.detect(f.member, signal()), isError('FORBIDDEN'));
});

test('Ollama connection enriches advertised tool capabilities without generation and leaves missing metadata unknown', async t => {
  const shown: string[] = [];
  const url = await endpoint(t, (req, res) => {
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'qwen-fixture' }, { name: 'embed-fixture' }, { name: 'missing-fixture' }] })); return; }
    assert.equal(req.url, '/api/show'); assert.equal(req.method, 'POST');
    let raw = ''; req.on('data', value => { raw += value; }); req.on('end', () => {
      const body = JSON.parse(raw); shown.push(body.model); assert.equal(body.verbose, false);
      if (body.model === 'missing-fixture') { res.writeHead(404); res.end(); }
      else res.end(JSON.stringify(body.model === 'qwen-fixture' ? { capabilities: ['completion', 'tools'], parameters: 'num_ctx 8192\n', model_info: { 'general.architecture': 'qwen', 'qwen.context_length': 262144 }, template: 'PRIVATE_TEMPLATE' } : { capabilities: ['embedding'], model_info: { 'general.architecture': 'embedding', 'embedding.context_length': 32768 } }));
    });
  });
  const f = await fixture(t);
  const result = await f.connections.connect(f.owner, { preset: 'ollama', baseUrl: url.replace('/v1', '') }, signal());
  assert.equal(result.status, 'ready'); assert.equal(shown.length, 3);
  const qwen = result.models.find(m => m.model === 'qwen-fixture')!;
  assert.deepEqual(qwen.capabilities, ['chat', 'tools']); assert.equal(qwen.contextWindow, 8192); assert.equal(qwen.capabilitySource, 'provider');
  const embedding = result.models.find(m => m.model === 'embed-fixture')!;
  assert.deepEqual(embedding.capabilities, ['embedding']); assert.equal(embedding.contextWindow, undefined);
  assert.equal(result.models.find(m => m.model === 'missing-fixture')!.capabilitySource, 'unknown');
  assert.match(result.warnings[0], /Metadati Ollama/); assert(!JSON.stringify(result).includes('PRIVATE_TEMPLATE'));
  const before = shown.length;
  await discoverModels({ id: 'quick-probe', kind: 'ollama', label: 'Quick', baseUrl: url.replace('/v1', '') }, undefined, signal(), { metadata: false });
  assert.equal(shown.length, before);
});

test('Ollama metadata enrichment honors parent cancellation instead of converting it into a successful partial catalog', async t => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const url = await endpoint(t, (req, res) => { if (req.url === '/api/tags') res.end('{"models":[{"name":"pending-model"}]}'); else entered(); });
  const controller = new AbortController();
  const pending = discoverModels({ id: 'cancel-probe', kind: 'ollama', label: 'Cancel', baseUrl: url.replace('/v1', '') }, undefined, controller.signal);
  void pending.catch(() => {});
  await ready; controller.abort(); await assert.rejects(pending, /abort|cancel/i);
});

test('Ollama metadata probes are capped and timeout preserves the discovered catalog with unknown capabilities', async t => {
  let calls = 0, active = 0, maximum = 0;
  const url = await endpoint(t, (req, res) => {
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: Array.from({ length: 23 }, (_, i) => ({ name: `model-${i}` })) })); return; }
    calls++; active++; maximum = Math.max(maximum, active);
    let finished = false; const done = () => { if (!finished) { finished = true; active--; } }; res.once('close', done);
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      if (JSON.parse(raw).model === 'model-0') return;
      setTimeout(() => { done(); res.end('{"capabilities":["completion","tools"]}'); }, 5);
    });
  });
  const result = await discoverModels({ id: 'bounded-probe', kind: 'ollama', label: 'Bounded', baseUrl: url.replace('/v1', '') }, undefined, signal());
  assert.equal(result.models.length, 23); assert.equal(calls, 20); assert.ok(maximum <= 4);
  assert.equal(result.models[0].capabilitySource, 'unknown'); assert.equal(result.models[1].capabilitySource, 'provider'); assert.equal(result.models[22].capabilitySource, 'unknown');
  assert(result.warnings.some(warning => warning.includes('1 modelli'))); assert(result.warnings.some(warning => warning.includes('primi 20')));
});

test('Google guided login uses one private process and rediscovers only that account after operator consent', async t=>{
  const f=await fixture(t,[{id:'agy-guided',label:'Google',kind:'antigravity',command:process.execPath,args:[cliFixture,'profile-file'],nodeIds:[],resourceGroupIds:[],enabled:true}]);
  const a=await f.connections.connect(f.owner,{providerId:'agy-guided',accountLabel:'One'},signal());
  const b=await f.connections.connect(f.owner,{providerId:'agy-guided',accountLabel:'Two'},signal());
  assert.equal(a.nextAction?.kind,'login');
  const controller=new AbortController();t.after(()=>controller.abort());
  const events:unknown[]=[];
  const wait=async (status:string) => {
    for(let n=0;n<200;n++){
      const current=f.connections.nativeLogin(f.owner,a.account.id); if(current.status===status) return current;
      await new Promise(r=>setTimeout(r,10));
    }
    throw Error('No login event '+status);
  };
  f.connections.startNativeLogin(f.owner,a.account.id,controller.signal,s=>events.push(s));
  const pending=await wait('pending');assert.equal(pending.status,'pending');
  assert.equal(pending.responseRequired,true);assert.equal(new URL(pending.verificationUri).hostname,'accounts.google.com');
  assert.throws(()=>f.connections.respondNativeLogin(f.other,a.account.id,pending.operationId,'valid-fixture-code'),isError('NOT_FOUND'));
  assert.throws(()=>f.connections.respondNativeLogin(f.owner,a.account.id,pending.operationId,'https://other.test/?code=wrong'),isError('LOGIN_CODE'));
  f.connections.respondNativeLogin(f.owner,a.account.id,pending.operationId,'valid-fixture-code');
  assert.throws(()=>f.connections.respondNativeLogin(f.owner,a.account.id,pending.operationId,'valid-fixture-code'),isError('LOGIN_STATE'));
  const done=await wait('complete');assert.equal(done.status,'complete');assert.ok(done.models.some(m=>m.model==='observed-fixture-model'));
  assert.equal((await f.connections.connect(f.owner,{accountId:b.account.id},signal())).status,'login-required');
  assert.ok(!JSON.stringify(events).includes('valid-fixture-code'));
});
