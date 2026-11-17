import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentLoad, InferenceLoadMonitor, sampleProviderLoad, validateLoadProbe } from '../src/inference-load.ts';
import type { LoadProbe, LoadProbeTarget, ProviderLoadObservation } from '../src/load-types.ts';
import { Catalog } from '../src/catalog.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';
import { defaultConfig, type Config } from '../src/config.ts';
import { RouteRouter } from '../src/routing.ts';
import type { ModelRoute } from '../src/contracts.ts';

const signal = () => AbortSignal.timeout(3000);
const code = (expected: string) => (error: unknown) => (error as {code?:string}).code === expected;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function http(t: test.TestContext, listener: RequestListener) {
    const server = createServer(listener);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return 'http://127.0.0.1:' + address.port;
}
const target = (url: string, overrides: Partial<LoadProbe> = {}): LoadProbeTarget => ({ id: 'engine', loadProbe: { kind: 'json', url, ...overrides } });

test('JSON load probes preserve measured zeros, unknown optional counters and explicit saturation', async t => {
    let payload: unknown = { activeRequests: 0, queuedRequests: 0, capacity: 4 };
    const url = await http(t, (req, res) => { assert.equal(req.method, 'GET'); assert.equal(req.url, '/load'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); });
    const provider = target(url + '/load');
    const free = await sampleProviderLoad(provider, signal());
    assert.equal(free.status, 'available'); assert.equal(free.activeRequests, 0); assert.equal(free.queuedRequests, 0); assert.equal(free.capacity, 4);
    assert.ok(free.observedAt && free.expiresAt); assert.ok(!JSON.stringify(free).includes(url));
    payload = { activeRequests: 1, capacity: 4 };
    const partial = await sampleProviderLoad(provider, signal());
    assert.equal(partial.status, 'available'); assert.equal(partial.queuedRequests, undefined);
    payload = { activeRequests: 1, queuedRequests: 2, capacity: 4 };
    assert.equal((await sampleProviderLoad(provider, signal())).status, 'busy');
    payload = { activeRequests: 4, capacity: 4 };
    assert.equal((await sampleProviderLoad(provider, signal())).status, 'busy');
    payload = { activeRequests: 1 };
    const unknownCapacity = await sampleProviderLoad(provider, signal());
    assert.equal(unknownCapacity.status, 'unknown'); assert.equal(unknownCapacity.activeRequests, 1); assert.equal(unknownCapacity.capacity, undefined);
    payload = { activeRequests: 0, capacity: 0 };
    assert.equal((await sampleProviderLoad(provider, signal())).status, 'busy');
});

test('llama slots count boolean processing flags and discard private per-slot parameters', async t => {
    let payload: unknown = [{ id: 0, is_processing: false, params: { prompt: 'do-not-retain-user-prompt' } }, { id: 1, is_processing: true }];
    const url = await http(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); });
    const provider = target(url + '/slots', { kind: 'llama-slots' });
    const sample = await sampleProviderLoad(provider, signal());
    assert.equal(sample.status, 'available'); assert.equal(sample.activeRequests, 1); assert.equal(sample.capacity, 2); assert.equal(sample.queuedRequests, undefined);
    assert.ok(!JSON.stringify(sample).includes('do-not-retain'));
    assert.equal((await sampleProviderLoad(target(url + '/slots', { kind: 'llama-slots', capacity: 1 }), signal())).status, 'busy');
    payload = [{ id: 0, is_processing: 'false' }];
    const malformed = await sampleProviderLoad(provider, signal());
    assert.equal(malformed.status, 'unknown'); assert.equal(malformed.activeRequests, undefined);
    payload = [{ id: 0, is_processing: false }, { id: 0, is_processing: false }];
    assert.equal((await sampleProviderLoad(provider, signal())).status, 'unknown');
});

test('HTTP failure, malformed counters and bounded body failures never become idle samples', async t => {
    let mode = 'http';
    const url = await http(t, (_req, res) => {
        if (mode === 'http') { res.writeHead(401); res.end('private provider detail'); return; }
        if (mode === 'huge') { res.end(JSON.stringify({ activeRequests: 0, padding: 'x'.repeat(600000) })); return; }
        res.setHeader('Content-Type', 'application/json'); res.end(mode === 'negative' ? '{"activeRequests":-1}' : '{"activeRequests":"0"}');
    });
    for (const next of ['http', 'negative', 'string', 'huge']) {
        mode = next;
        const sample = await sampleProviderLoad(target(url), signal());
        assert.equal(sample.status, 'unknown'); assert.equal(sample.activeRequests, undefined);
        assert.equal(sample.observedAt, undefined); assert.ok(!JSON.stringify(sample).includes('private provider detail'));
    }
});

test('probe timeout is bounded, stale samples stay distinct and configured credentials in URLs are rejected', async t => {
    const url = await http(t, (_req, res) => { setTimeout(() => res.end('{"activeRequests":0,"capacity":1}'), 150); });
    const timedOut = await sampleProviderLoad(target(url, { timeoutMs: 50 }), signal());
    assert.equal(timedOut.status, 'unknown'); assert.match(timedOut.reason, /timeout/);
    const observation: ProviderLoadObservation = { providerId: 'engine', kind: 'json', status: 'available', source: 'engine', lastAttemptAt: '2026-11-17T00:00:00.000Z', observedAt: '2026-11-17T00:00:00.000Z', expiresAt: '2026-11-17T00:00:01.000Z', activeRequests: 0, capacity: 1, reason: 'measured' };
    assert.equal(currentLoad(observation, { kind: 'json', url, maxAgeMs: 1000 }, Date.parse('2026-11-17T00:00:00.500Z'))?.status, 'available');
    assert.equal(currentLoad(observation, { kind: 'json', url, maxAgeMs: 1000 }, Date.parse('2026-11-17T00:00:02.000Z'))?.status, 'stale');
    assert.equal(observation.status, 'available', 'Freshness view must not mutate the observed sample.');
    assert.throws(() => validateLoadProbe({ kind: 'json', url: 'http://user:password@localhost/load' }));
    assert.throws(() => validateLoadProbe({ kind: 'json', url: url + '/load?token=secret' }));
});

test('monitor polls only configured endpoints with at most four concurrent GETs and coalesces refreshes', async t => {
    let inFlight = 0, maximum = 0, requests = 0;
    const url = await http(t, (req, res) => {
        assert.equal(req.method, 'GET'); requests++; inFlight++; maximum = Math.max(maximum, inFlight);
        setTimeout(() => { inFlight--; res.end('{"activeRequests":0,"capacity":1}'); }, 20);
    });
    const providers: LoadProbeTarget[] = Array.from({ length: 9 }, (_, index) => ({ ...target(url + '/load/' + index), id: 'engine-' + index }));
    providers.push({ id: 'unconfigured' }, { id: 'disabled', enabled: false, loadProbe: { kind: 'json', url } });
    const monitor = new InferenceLoadMonitor(), first = monitor.refresh(providers, signal()), second = monitor.refresh(providers, signal());
    assert.equal(first, second); const observed = await first;
    assert.equal(requests, 9); assert.equal(observed.length, 9); assert.ok(maximum <= 4);
    await monitor.refresh([], signal()); assert.equal(monitor.observations.size, 0);
});

async function routingFixture(t: test.TestContext, url: string) {
    const directory = await mkdtemp(path.join(tmpdir(), 'yed1z-external-load-'));
    const store = new Store(directory); t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
    const owner = store.createUser('Operator', 'admin').user;
    const config: Config = {
        ...defaultConfig(),
        nodes: [{ id: 'node', label: 'GPU', kind: 'server', capabilities: ['inference'] }],
        resourceGroups: [{ id: 'gpu', label: 'Exclusive GPU', nodeIds: ['node'], capacity: 1 }],
        providers: [
            { id: 'local', label: 'Local', kind: 'openai-compatible', enabled: true, baseUrl: url, nodeIds: ['node'], resourceGroupIds: ['gpu'], loadProbe: { kind: 'json', url: url + '/load', maxAgeMs: 1000 }, models: [{ model: 'local', label: 'Local', capabilities: ['chat'] }] },
            { id: 'another-engine', label: 'Alternative engine on same GPU', kind: 'openai-compatible', enabled: true, baseUrl: url, nodeIds: ['node'], resourceGroupIds: ['gpu'], models: [{ model: 'other', label: 'Other', capabilities: ['chat'] }] },
            { id: 'approved-cloud', label: 'Cloud', kind: 'openai-compatible', enabled: true, baseUrl: url, nodeIds: [], resourceGroupIds: [], models: [{ model: 'cloud', label: 'Cloud', capabilities: ['chat'] }] }
        ]
    };
    const scheduling = new Scheduler(config.resourceGroups), catalog = new Catalog(store, config, scheduling);
    catalog.seed(owner);
    for (const account of catalog.accounts(owner)) store.put('account', { ...account, status: 'ready' });
    const monitor = catalog.loadMonitor, router = new RouteRouter(catalog);
    const routes = Object.fromEntries(catalog.models(owner).map(route => [route.providerId, route])) as Record<'local'|'another-engine'|'approved-cloud', ModelRoute>;
    return { store, config, scheduler: scheduling, catalog, monitor, router, routes, owner };
}

test('fresh external activity blocks exclusive hardware and selects an explicitly approved other provider', async t => {
    let activeRequests = 1;
    const url = await http(t, (_req, res) => res.end(JSON.stringify({ activeRequests, queuedRequests: 0, capacity: 4 })));
    const f = await routingFixture(t, url);
    await f.monitor.refresh(f.config.providers, signal());
    assert.equal(f.monitor.observations.get('local')?.status, 'available', 'Engine has free slots but hardware is exclusive.');
    const availability = f.router.availability(f.owner);
    assert.equal(availability.find(row => row.routeId === f.routes.local.id)?.status, 'busy');
    assert.equal(availability.find(row => row.routeId === f.routes['another-engine'].id)?.status, 'busy', 'A different engine cannot switch shared busy hardware.');
    assert.equal(availability.find(row => row.routeId === f.routes.local.id)?.externalActiveRequests, 1);
    const alternate = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, alternativeRouteIds: [f.routes['approved-cloud'].id], strategy: 'auto', purpose: 'chat', signal: signal() });
    assert.equal(alternate.route.id, f.routes['approved-cloud'].id); alternate.release();
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal(), maxWaitMs: 30000 }), code('EXTERNAL_BUSY'));
    assert.equal(f.scheduler.queue.length, 0); assert.equal(f.scheduler.snapshot().gpu ?? 0, 0);
    activeRequests = 0; await f.monitor.refresh(f.config.providers, signal());
    const local = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal(), maxWaitMs: 0 }); local.release();
});

test('missing, failed and stale configured load probes block admission rather than assuming zero activity', async t => {
    let fail = false;
    const url = await http(t, (_req, res) => { if (fail) { res.writeHead(503); res.end(); } else res.end('{"activeRequests":0,"capacity":1}'); });
    const f = await routingFixture(t, url);
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() }), code('LOAD_UNAVAILABLE'));
    await f.monitor.refresh(f.config.providers, signal());
    const sample = f.monitor.observations.get('local')!;
    f.monitor.observations.set('local', { ...sample, observedAt: new Date(Date.now() - 5000).toISOString(), expiresAt: new Date(Date.now() - 4000).toISOString() });
    assert.equal(f.monitor.snapshot(f.config.providers)[0].status, 'stale');
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes['another-engine'].id, purpose: 'chat', signal: signal() }), code('LOAD_UNAVAILABLE'));
    fail = true; await f.monitor.refresh(f.config.providers, signal());
    assert.equal(f.monitor.observations.get('local')?.activeRequests, undefined);
    assert.equal(f.router.availability(f.owner).find(row => row.routeId === f.routes.local.id)?.status, 'unavailable');
});

test('a new external busy sample is rechecked after a queued local lease is granted', async t => {
    let activeRequests = 0;
    const url = await http(t, (_req, res) => res.end(JSON.stringify({ activeRequests, capacity: 1 })));
    const f = await routingFixture(t, url); await f.monitor.refresh(f.config.providers, signal());
    const first = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() });
    const waiting = f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal(), maxWaitMs: 1000 });
    activeRequests = 1; await f.monitor.refresh(f.config.providers, signal());
    first.release(); await assert.rejects(waiting, code('EXTERNAL_BUSY'));
    assert.equal(f.scheduler.queue.length, 0); assert.equal(f.scheduler.snapshot().gpu, 0);
});

test('a completed HTTP inference reconciles its own busy sample before the next pinned round', async t => {
    let activeRequests = 0, probes = 0, inferenceCalls = 0;
    const started = gate(); let finish!: () => void;
    const url = await http(t, (req, res) => {
        if (req.method === 'POST' && req.url === '/infer') {
            inferenceCalls++; activeRequests++; started.resolve();
            finish = () => { activeRequests--; res.end('finished'); };
            return;
        }
        assert.equal(req.url, '/load'); probes++;
        res.end(JSON.stringify({ activeRequests, capacity: 1 }));
    });
    const f = await routingFixture(t, url); await f.monitor.refresh(f.config.providers, signal());
    const first = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() });
    const inference = fetch(url + '/infer', { method: 'POST', signal: signal() });
    await started.promise; await f.monitor.refresh(f.config.providers, signal());
    assert.equal(f.monitor.observations.get('local')?.activeRequests, 1);
    finish(); assert.equal(await (await inference).text(), 'finished'); first.release();
    // A fresh router instance models the next task/tool round, with no timer poll.
    const second = await new RouteRouter(f.catalog).reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', strategy: 'pinned', maxWaitMs: 1000, signal: signal() });
    assert.equal(second.route.id, f.routes.local.id); assert.equal(second.switched, false);
    assert.equal(probes, 3, 'Admission must perform one authoritative read after the local release.');
    assert.equal(f.monitor.observations.get('local')?.activeRequests, 0);
    assert.equal(inferenceCalls, 1, 'Reconciliation cannot replay inference.');
    second.release(); assert.equal(f.scheduler.snapshot().gpu, 0);
});

test('reconciliation preserves real external work rather than subtracting the completed local request', async t => {
    let activeRequests = 0, probes = 0;
    const url = await http(t, (_req, res) => { probes++; res.end(JSON.stringify({ activeRequests, capacity: 1 })); });
    const f = await routingFixture(t, url); await f.monitor.refresh(f.config.providers, signal());
    const first = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() });
    activeRequests = 2; await f.monitor.refresh(f.config.providers, signal());
    activeRequests = 1; first.release();
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes['another-engine'].id, purpose: 'chat', maxWaitMs: 1000, signal: signal() }), code('EXTERNAL_BUSY'));
    assert.equal(probes, 3); assert.equal(f.monitor.observations.get('local')?.activeRequests, 1);
    assert.equal(f.scheduler.snapshot().gpu, 0); assert.equal(f.scheduler.queue.length, 0);
    const fallback = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, alternativeRouteIds: [f.routes['approved-cloud'].id], strategy: 'auto', purpose: 'chat', signal: signal() });
    assert.equal(fallback.route.id, f.routes['approved-cloud'].id); fallback.release();
    assert.equal(probes, 3, 'A fresh busy observation does not trigger repeated probes.');
});

test('an in-flight probe started before release cannot qualify just because its response arrived later', async t => {
    let activeRequests = 0, probes = 0, holdNext = false;
    const captured = gate(); let deliverOld!: () => void;
    const url = await http(t, (_req, res) => {
        probes++;
        const body = JSON.stringify({ activeRequests, capacity: 1 });
        if (holdNext) { holdNext = false; deliverOld = () => res.end(body); captured.resolve(); }
        else res.end(body);
    });
    const f = await routingFixture(t, url); await f.monitor.refresh(f.config.providers, signal());
    const first = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() });
    activeRequests = 1; holdNext = true;
    const oldPoll = f.monitor.refresh(f.config.providers, signal()); await captured.promise;
    activeRequests = 0; first.release();
    const pending = f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', maxWaitMs: 1000, signal: signal() });
    deliverOld(); await oldPoll;
    const second = await pending;
    assert.equal(probes, 3); assert.equal(f.monitor.observations.get('local')?.activeRequests, 0);
    assert.equal(second.route.id, f.routes.local.id); second.release();
});

test('a queued pinned reservation rechecks after the preceding local lease releases', async t => {
    let activeRequests = 0, probes = 0;
    const url = await http(t, (_req, res) => { probes++; res.end(JSON.stringify({ activeRequests, capacity: 1 })); });
    const f = await routingFixture(t, url); await f.monitor.refresh(f.config.providers, signal());
    const first = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() });
    const waiting = f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal(), maxWaitMs: 1000 });
    assert.equal(f.scheduler.queue.length, 1);
    activeRequests = 1; await f.monitor.refresh(f.config.providers, signal());
    activeRequests = 0; first.release();
    const second = await waiting;
    assert.equal(probes, 3); assert.equal(f.scheduler.snapshot().gpu, 1);
    second.release(); assert.equal(f.scheduler.snapshot().gpu, 0); assert.equal(f.scheduler.queue.length, 0);
});

test('failed, bounded and cancelled reconciliation remains closed and releases queued model resources', async t => {
    let mode = 'free', probes = 0;
    let observed = gate();
    const url = await http(t, (_req, res) => {
        probes++; observed.resolve();
        if (mode === 'hang') return;
        if (mode === 'fail') { res.writeHead(503); res.end(); return; }
        res.end('{"activeRequests":0,"capacity":1}');
    });
    const f = await routingFixture(t, url); await f.monitor.refresh(f.config.providers, signal());
    const first = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() });
    const waiting = f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal(), maxWaitMs: 40 });
    mode = 'hang'; first.release(); const start = Date.now();
    await assert.rejects(waiting, code('LOAD_UNAVAILABLE'));
    assert.ok(Date.now() - start < 500, 'Request budget bounds reconciliation even if the configured probe timeout is longer.');
    assert.equal(f.scheduler.snapshot().gpu, 0); assert.equal(f.scheduler.queue.length, 0);

    mode = 'free'; await f.monitor.refresh(f.config.providers, signal());
    const next = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() }); next.release();
    mode = 'hang'; observed = gate();
    const abort = new AbortController();
    const cancelled = f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: abort.signal, maxWaitMs: 1000 });
    await observed.promise; abort.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(f.scheduler.snapshot().gpu, 0); assert.equal(f.scheduler.queue.length, 0);

    mode = 'fail'; await f.monitor.refresh(f.config.providers, signal());
    await assert.rejects(f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() }), code('LOAD_UNAVAILABLE'));
    assert.equal(f.monitor.observations.get('local')?.activeRequests, undefined);
    assert.ok(probes >= 4);
});

test('polling and admission reconciliation share a four-request limit and one in-flight read per provider', async t => {
    let inFlight = 0, maximum = 0, requests = 0;
    const perProvider = new Map<string, number>(), oldStarted = gate(), releaseOld = gate();
    const url = await http(t, (req, res) => {
        const key = req.url!; requests++; inFlight++; maximum = Math.max(maximum, inFlight);
        perProvider.set(key, (perProvider.get(key) ?? 0) + 1);
        assert.equal(perProvider.get(key), 1, 'A newer read must not race an older response from the same provider.');
        const initial = requests <= 4;
        if (requests === 4) oldStarted.resolve();
        void (initial ? releaseOld.promise : Promise.resolve()).then(() => {
            perProvider.set(key, perProvider.get(key)! - 1); inFlight--;
            res.end(JSON.stringify({ activeRequests: initial ? 1 : 0, capacity: 1 }));
        });
    });
    const providers = Array.from({ length: 9 }, (_, index) => ({ ...target(url + '/load/' + index), id: 'engine-' + index }));
    const monitor = new InferenceLoadMonitor();
    const polling = monitor.refresh(providers, signal()); await oldStarted.promise;
    monitor.afterRelease(providers.map(provider => provider.id));
    const first = monitor.reconcile(providers, signal()), second = monitor.reconcile(providers, signal());
    releaseOld.resolve(); await Promise.all([polling, first, second]);
    assert.ok(maximum <= 4); assert.equal(requests, 13);
    assert.ok(providers.every(provider => !monitor.needsReconciliation(provider.id)));
    assert.ok(monitor.snapshot(providers).every(sample => sample.activeRequests === 0));
});

test('a free approved alternative and routes without configured probes perform no reconciliation GETs', async t => {
    let probes = 0;
    const url = await http(t, (_req, res) => { probes++; res.end('{"activeRequests":0,"capacity":1}'); });
    const f = await routingFixture(t, url); await f.monitor.refresh(f.config.providers, signal());
    const local = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal() }); local.release();
    const cloud = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, alternativeRouteIds: [f.routes['approved-cloud'].id], strategy: 'auto', purpose: 'chat', signal: signal(), maxWaitMs: 0 });
    assert.equal(cloud.route.id, f.routes['approved-cloud'].id); cloud.release(); assert.equal(probes, 1);
    delete f.config.providers[0].loadProbe;
    for (let i = 0; i < 2; i++) {
        const route = await f.router.reserve({ user: f.owner, preferredRouteId: f.routes.local.id, purpose: 'chat', signal: signal(), maxWaitMs: 0 }); route.release();
    }
    assert.equal(probes, 1, 'Ordinary inference without configured probes does not make load requests.');
});
