import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import { Catalog } from '../src/catalog.ts';
import { Scheduler, type QueueWait } from '../src/scheduler.ts';
import { RouteRouter } from '../src/routing.ts';
import { defaultConfig, type Config } from '../src/config.ts';
import type { Account, ModelRoute, Provider } from '../src/contracts.ts';
import { id, now } from '../src/util.ts';

const signal = () => AbortSignal.timeout(3000);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const code = (expected: string) => (error: unknown) => (error as {code?:string}).code === expected;
function scheduler() { return new Scheduler(['a', 'b', 'c'].map(id => ({ id, label: id.toUpperCase(), nodeIds: [id], capacity: 1 }))); }

async function fixture(t: test.TestContext) {
    const directory = await mkdtemp(path.join(tmpdir(), 'yed1z-routing-'));
    const store = new Store(directory);
    t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
    const owner = store.createUser('Operator', 'admin').user;
    const member = store.createUser('Member', 'member').user;
    const other = store.createUser('Other operator', 'operator').user;
    const config: Config = {
        ...defaultConfig(),
        nodes: ['a', 'b', 'c'].map(id => ({ id, label: id, kind: 'server', capabilities: ['inference'] })),
        resourceGroups: ['a', 'b', 'c'].map(id => ({ id, label: id.toUpperCase(), nodeIds: [id], capacity: 1 })),
        providers: [
            { id: 'dual', label: 'Dual Strix', kind: 'openai-compatible', enabled: true, baseUrl: 'http://127.0.0.1:1/v1', nodeIds: ['a', 'b'], resourceGroupIds: ['a', 'b'], models: [{ model: 'dual-model', label: 'Dual', capabilities: ['chat', 'tools'], contextWindow: 32768 }] },
            { id: 'cuda', label: 'CUDA', kind: 'openai-compatible', enabled: true, baseUrl: 'http://127.0.0.1:2/v1', nodeIds: ['c'], resourceGroupIds: ['c'], models: [{ model: 'cuda-model', label: 'CUDA', capabilities: ['chat', 'tools'], contextWindow: 32768 }] },
            { id: 'cloud', label: 'Approved cloud', kind: 'openai-compatible', enabled: true, baseUrl: 'http://127.0.0.1:3/v1', nodeIds: [], resourceGroupIds: [], maxConcurrent: 1, models: [{ model: 'cloud-model', label: 'Cloud', capabilities: ['chat'], contextWindow: 8192 }] },
            { id: 'native', label: 'Codex profile', kind: 'codex', command: 'codex', enabled: true, nodeIds: [], resourceGroupIds: [], maxConcurrent: 16, models: [{ model: 'native-model', label: 'Codex', capabilities: ['chat', 'tools'], contextWindow: 32768 }] }
        ]
    };
    const scheduling = new Scheduler(config.resourceGroups), catalog = new Catalog(store, config, scheduling);
    catalog.seed(owner);
    for (const account of catalog.accounts(owner)) store.put('account', { ...account, status: 'ready' });
    const routes = Object.fromEntries(catalog.models(owner).map(route => [route.providerId, route])) as Record<'dual'|'cuda'|'cloud'|'native', ModelRoute>;
    const router = new RouteRouter(catalog);
    return { directory, store, config, catalog, scheduler: scheduling, router, owner, member, other, routes };
}

test('scheduler reserves exactly one available alternative atomically across multiple nodes', async () => {
    const s = scheduler(), heldB = await s.acquire(['b'], signal());
    const result = await s.acquireAny([{ id: 'dual', groups: ['a', 'b'] }, { id: 'cuda', groups: ['c'] }], signal(), { maxWaitMs: 0 });
    assert.equal(result.choiceId, 'cuda');
    assert.equal(s.snapshot().a ?? 0, 0);
    assert.equal(s.snapshot().b, 1);
    assert.equal(s.snapshot().c, 1);
    result.release(); result.release(); heldB();
    assert.equal(s.queue.length, 0);
    const dual = await s.acquireAny([{ id: 'dual', groups: ['b', 'a', 'a'] }], signal());
    assert.equal(s.snapshot().a, 1); assert.equal(s.snapshot().b, 1);
    dual.release();
});

test('queue timeout and cancellation release waiting state without claiming half a route', async () => {
    const s = scheduler(), held = await s.acquire(['b'], signal());
    const observed: QueueWait[] = [];
    await assert.rejects(s.acquire(['a', 'b'], signal(), { maxWaitMs: 15, onQueued: event => observed.push(event) }), code('QUEUE_TIMEOUT'));
    assert.equal(s.queue.length, 0); assert.equal(s.snapshot().a ?? 0, 0);
    assert.equal(observed[0].position, 1); assert.deepEqual(observed[0].busyResourceIds, ['b']);
    assert.ok(!('estimatedWaitMs' in observed[0]));
    const abort = new AbortController(), pending = s.acquire(['a', 'b'], abort.signal, { maxWaitMs: 1000 });
    abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
    held(); assert.equal(s.queue.length, 0); assert.equal(s.snapshot().b, 0);
});

test('interactive priority improves latency but the fourth bypass yields to older background work', async () => {
    const s = scheduler(), held = await s.acquire(['a'], signal()), order: string[] = [];
    const background = s.acquire(['a'], signal(), { priority: 'background', maxWaitMs: 1000 }).then(release => { order.push('background'); release(); });
    const foreground = Array.from({ length: 5 }, (_, index) => s.acquire(['a'], signal(), { priority: 'interactive', maxWaitMs: 1000 }).then(release => { order.push('interactive-' + index); release(); }));
    const independent = await s.acquire(['c'], signal(), { priority: 'background', maxWaitMs: 0 });
    independent(); held();
    await Promise.all([background, ...foreground]);
    assert.deepEqual(order, ['interactive-0', 'interactive-1', 'interactive-2', 'background', 'interactive-3', 'interactive-4']);
});

test('a starvation-protected dual-node request retains its priority when only one node is released', async () => {
    const s = scheduler(), heldB = await s.acquire(['b'], signal());
    let dualStarted = false;
    const dual = s.acquire(['a', 'b'], signal(), { priority: 'background', maxWaitMs: 1000 }).then(release => { dualStarted = true; return release; });
    for (let index = 0; index < 3; index++) {
        const release = await s.acquire(['a'], signal(), { priority: 'interactive', maxWaitMs: 0 });
        release();
    }
    await assert.rejects(s.acquire(['a'], signal(), { priority: 'interactive', maxWaitMs: 0 }), code('QUEUE_TIMEOUT'));
    assert.equal(dualStarted, false); assert.equal(s.snapshot().a, 0);
    heldB(); const releaseDual = await dual; assert.equal(dualStarted, true); releaseDual();
});

test('an older waiter on unrelated hardware cannot prevent fairness on another resource', async () => {
    const s = scheduler(), heldA = await s.acquire(['a'], signal()), heldB = await s.acquire(['b'], signal()), order: string[] = [];
    const waitingB = s.acquire(['b'], signal(), { priority: 'background', maxWaitMs: 1000 });
    const waitingA = s.acquire(['a'], signal(), { priority: 'background', maxWaitMs: 1000 }).then(release => { order.push('old-a'); release(); });
    const foreground = Array.from({ length: 6 }, (_, index) => s.acquire(['a'], signal(), { priority: 'interactive', maxWaitMs: 1000 }).then(release => { order.push('chat-' + index); release(); }));
    heldA(); await Promise.all([waitingA, ...foreground]);
    assert.equal(order.indexOf('old-a'), 3);
    heldB(); (await waitingB)();
});

test('automatic routing picks only an explicit compatible free alternative and preserves provider hardware constraints', async t => {
    const f = await fixture(t);
    // A route-level override cannot erase the provider's Dual Strix dependency.
    f.store.put('model', { ...f.routes.dual, nodeIds: [], resourceGroupIds: [] });
    const heldB = await f.scheduler.acquire(['b'], signal());
    const reservation = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.dual.id, alternativeRouteIds: [f.routes.cuda.id], strategy: 'auto', purpose: 'chat', signal: signal(), maxWaitMs: 0 });
    assert.equal(reservation.route.id, f.routes.cuda.id); assert.equal(reservation.switched, true);
    assert.equal(f.scheduler.snapshot().a ?? 0, 0); assert.equal(f.scheduler.snapshot().c, 1);
    assert.equal(f.router.availability(f.owner).find(item => item.routeId === f.routes.dual.id)?.status, 'busy');
    const heldC = reservation;
    // The free cloud account is not in the approved pool: it must not be used.
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.dual.id, alternativeRouteIds: [f.routes.cuda.id], strategy: 'auto', purpose: 'chat', signal: signal(), maxWaitMs: 10 }), code('QUEUE_TIMEOUT'));
    heldC.release(); heldB();
    assert.equal(f.scheduler.queue.length, 0);
});

test('pinned routing never switches and has a bounded wait even when an alternative is free', async t => {
    const f = await fixture(t), held = await f.scheduler.acquire(['a'], signal());
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.dual.id, alternativeRouteIds: [f.routes.cuda.id], strategy: 'pinned', purpose: 'chat', maxWaitMs: 10, signal: signal() }), code('QUEUE_TIMEOUT'));
    assert.equal(f.scheduler.snapshot().c ?? 0, 0); held();
});

test('routing filters context, capabilities, quota and private fallback accounts before reservation', async t => {
    const f = await fixture(t);
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'coder', requiredCapabilities: ['tools'], signal: signal() }), code('CAPABILITY'));
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'chat', minimumContextTokens: 12000, signal: signal() }), code('CONTEXT'));
    f.catalog.quota(f.store.require<Account>('account', f.routes.dual.accountId), { state: 'limited', source: 'provider-headers', observedAt: now(), retryAfterMs: 60000 });
    const alternate = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.dual.id, alternativeRouteIds: [f.routes.cuda.id], strategy: 'auto', purpose: 'chat', signal: signal(), maxWaitMs: 0 });
    assert.equal(alternate.route.id, f.routes.cuda.id); alternate.release();
    const privateAccount = f.catalog.addAccount(f.other, 'cloud', 'Private other account', undefined, false);
    const privateRoute = f.store.put<ModelRoute>('model', { ...f.routes.cloud, id: id('mdl'), accountId: privateAccount.id });
    assert.ok(!f.router.availability(f.owner).some(row => row.routeId === privateRoute.id));
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: privateRoute.id, purpose: 'chat', signal: signal() }), code('NOT_FOUND'));
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.dual.id, alternativeRouteIds: [privateRoute.id], strategy: 'auto', purpose: 'chat', signal: signal(), maxWaitMs: 0 }), code('QUOTA'));
});

test('OpenAI model IDs without declared capabilities can attempt chat without claiming tool support', async t => {
    const f = await fixture(t);
    const discovered = f.store.put<ModelRoute>('model', { ...f.routes.cloud, capabilities: [], capabilitySource: 'unknown' });
    assert.equal(f.router.availability(f.owner).find(row => row.routeId === discovered.id)?.status, 'unknown');
    const chat = await f.router.reserve({ user: f.owner, preferredRouteId: discovered.id, purpose: 'chat', signal: signal(), maxWaitMs: 0 });
    assert.deepEqual(chat.route.capabilities, []); chat.release();
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: discovered.id, purpose: 'coder', requiredCapabilities: ['tools'], signal: signal() }), code('CAPABILITY'));
    f.store.put('model', { ...discovered, capabilities: ['embedding'], capabilitySource: 'provider' });
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: discovered.id, purpose: 'chat', signal: signal() }), code('CAPABILITY'));
});

test('all native models of one account serialize and private semaphores stay out of the fleet snapshot', async t => {
    const f = await fixture(t);
    const secondRoute = f.store.put<ModelRoute>('model', { ...f.routes.native, id: id('mdl'), model: 'second-native-model' });
    const first = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.native.id, purpose: 'coder', nativeAllowed: true, signal: signal() });
    assert.ok(first.connection.env?.CODEX_HOME?.includes(first.account.id));
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: secondRoute.id, purpose: 'coder', nativeAllowed: true, signal: signal(), maxWaitMs: 10 }), code('QUEUE_TIMEOUT'));
    const availability = f.router.availability(f.owner).find(row => row.routeId === secondRoute.id)!;
    assert.equal(availability.status, 'busy');
    assert.deepEqual(availability.resourceGroupIds, []);
    assert.deepEqual(availability.busyResourceIds, []);
    assert.equal(availability.activeCount, 1);
    assert.match(availability.busyResourceLabels.join(' '), /Account/);
    assert.ok(!JSON.stringify(availability).includes('account:'), 'UI receives human account contention, not internal semaphore IDs.');
    assert.ok(!Object.keys(f.scheduler.snapshot()).some(key => key.startsWith('account:')));
    first.release();
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: secondRoute.id, purpose: 'chat', signal: signal() }), code('NATIVE_TARGET'));
});

test('HTTP account concurrency is bounded across model routes even without physical resource groups', async t => {
    const f = await fixture(t), provider = f.store.require<Provider>('provider', 'cloud');
    f.store.put('provider', { ...provider, maxConcurrent: 2 });
    const another = f.store.put<ModelRoute>('model', { ...f.routes.cloud, id: id('mdl'), model: 'another-cloud-model' });
    const first = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'chat', signal: signal() });
    const second = await f.router.reserve({ user: f.owner, preferredRouteId: another.id, purpose: 'chat', signal: signal() });
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'chat', signal: signal(), maxWaitMs: 10 }), code('QUEUE_TIMEOUT'));
    assert.equal(f.router.availability(f.owner).find(row => row.routeId === another.id)?.activeCount, 2);
    first.release(); second.release();
});

test('unknown access and expired cooldown remain distinguishable from verified readiness', async t => {
    const f = await fixture(t), account = f.store.require<Account>('account', f.routes.cloud.accountId);
    f.store.put('account', { ...account, status: 'unknown' });
    assert.equal(f.router.availability(f.owner).find(row => row.routeId === f.routes.cloud.id)?.status, 'unknown');
    const unknown = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'chat', signal: signal(), maxWaitMs: 0 }); unknown.release();
    f.store.put('account', { ...account, status: 'cooldown', quota: { observedAt: now(), source: 'rate-limit', cooldownUntil: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(f.router.availability(f.owner).find(row => row.routeId === f.routes.cloud.id)?.status, 'unknown');
    const expired = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'chat', signal: signal(), maxWaitMs: 0 }); expired.release();
    f.store.put('account', { ...account, status: 'error' });
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'chat', signal: signal() }), code('CONNECTION'));
});

test('quota is checked again after queue grant before any inference starts', async t => {
    const f = await fixture(t);
    const dual = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.dual.id, purpose: 'chat', signal: signal() });
    const cloud = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'chat', signal: signal() });
    const waiting = f.router.reserve({ user: f.owner, preferredRouteId: f.routes.dual.id, alternativeRouteIds: [f.routes.cloud.id], strategy: 'auto', purpose: 'chat', signal: signal(), maxWaitMs: 1000 });
    assert.equal(f.scheduler.queue.length, 1);
    f.catalog.quota(dual.account, { state: 'limited', source: 'provider-headers', observedAt: now(), retryAfterMs: 60000 });
    dual.release(); await tick();
    assert.equal(f.scheduler.snapshot().a, 0); assert.equal(f.scheduler.snapshot().b, 0);
    cloud.release(); const selected = await waiting;
    assert.equal(selected.route.id, f.routes.cloud.id); selected.release();
});

test('resource changes during a queue wait require a new atomic grant before execution', async t => {
    const f = await fixture(t), first = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'chat', signal: signal() });
    const waiting = f.router.reserve({ user: f.owner, preferredRouteId: f.routes.cloud.id, purpose: 'chat', signal: signal(), maxWaitMs: 1000 });
    const heldC = await f.scheduler.acquire(['c'], signal());
    f.store.put('provider', { ...f.store.require<Provider>('provider', 'cloud'), nodeIds: ['c'], resourceGroupIds: ['c'] });
    first.release(); await tick();
    assert.equal(f.scheduler.queue.length, 1);
    assert.equal(f.scheduler.used.get('account:' + f.routes.cloud.accountId), 0);
    assert.equal(f.scheduler.snapshot().c, 1);
    heldC(); const second = await waiting;
    assert.equal(f.scheduler.snapshot().c, 1); second.release();
});
