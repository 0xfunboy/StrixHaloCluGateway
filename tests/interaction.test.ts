import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Application } from '../src/server.ts';
import { defaultConfig, type Config } from '../src/config.ts';
import type { Completion } from '../src/orchestrator.ts';
import type { InferenceRequest, InferenceResult, ToolCall } from '../src/adapters/types.ts';
import type { Account, Bootstrap, Conversation, ModelRoute, Project, Run } from '../src/contracts.ts';
import { id, now } from '../src/util.ts';

function answer(text: string, toolCalls: ToolCall[] = []): InferenceResult {
    return { text, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop', usage: { inputTokens: 40, outputTokens: 12 }, metrics: { totalMs: 4, sources: { usage: 'provider', ttft: 'gateway', prefill: 'unknown', decode: 'unknown', context: 'unknown' } }, quota: { state: 'unknown', source: 'unknown', observedAt: now() } };
}
async function http(t: test.TestContext, listener: RequestListener) {
    const server = createServer(listener); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); return 'http://127.0.0.1:' + address.port;
}
async function fixture(t: test.TestContext, options: { complete?: Completion; models?: boolean; workspace?: boolean; embeddingUrl?: string; publicDashboard?: boolean } = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'yed1z-interaction-')), workspace = path.join(root, 'workspace'); await mkdir(workspace);
    const calls: InferenceRequest[] = [];
    const config: Config = {
        ...defaultConfig(), port: 0, telemetryIntervalMs: 300000, publicDashboard: options.publicDashboard ?? true,
        nodes: ['primary', 'alternate', 'embedding'].map(node => ({ id: node, label: node, kind: 'server', host: 'private-host-' + node, capabilities: ['inference', 'execution'] })),
        resourceGroups: ['primary', 'alternate', 'embedding'].map(node => ({ id: node, label: node + ' resource', nodeIds: [node], capacity: 1 })),
        providers: options.models === false ? [] : [
            { id: 'primary-provider', label: 'Primary local engine', kind: 'openai-compatible', enabled: true, baseUrl: 'http://127.0.0.1:1/v1', tag: 'cluster', nodeIds: ['primary'], resourceGroupIds: ['primary'], models: [{ model: 'primary-model', label: 'Primary', capabilities: ['chat', 'tools'], contextWindow: 32768 }] },
            { id: 'alternate-provider', label: 'Private cloud provider label', kind: 'openai-compatible', enabled: true, baseUrl: 'http://127.0.0.1:2/v1', tag: 'cloud', nodeIds: [], resourceGroupIds: ['alternate'], models: [{ model: 'alternate-model', label: 'Alternate', capabilities: ['chat', 'tools'], contextWindow: 32768 }] },
            ...(options.embeddingUrl ? [{ id: 'embedding-provider', label: 'Embedding engine', kind: 'openai-compatible' as const, enabled: true, baseUrl: options.embeddingUrl, nodeIds: ['embedding'], resourceGroupIds: ['embedding'], models: [{ model: 'embedding-model', label: 'Embedding', capabilities: ['embedding'], contextWindow: 8192 }] }] : [])
        ],
        targets: [{ id: 'target', kind: 'local', nodeId: 'primary', workspaceRoot: workspace, commands: [
            { id: 'verify', label: 'Verification marker', verification: true, argv: [process.execPath, '-e', 'require("node:fs").appendFileSync("verification-ran.txt", "verified\\n")'] },
            { id: 'append', label: 'Append once', argv: [process.execPath, '-e', 'require("node:fs").appendFileSync("side-effect.txt", "executed\\n")'] }
        ] }]
    };
    const complete: Completion = async request => { calls.push(request); if (options.complete) return options.complete(request); const text = 'Answer from ' + request.model.id; request.onText(text); return answer(text); };
    const app = new Application({ directory: path.join(root, 'state'), config, complete });
    t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
    const owner = app.store.createUser('Funboy test operator', 'admin'); app.catalog.seed(owner.user);
    for (const account of app.catalog.accounts(owner.user)) app.store.put('account', { ...account, status: 'ready' });
    const routes = Object.fromEntries(app.catalog.models(owner.user).map(route => [route.providerId, route])) as Record<string, ModelRoute>;
    const project: Project = { id: id('prj'), ownerId: owner.user.id, memberIds: [], name: 'Interaction test project', description: 'Private project brief must not be public.', routes: routes['primary-provider'] ? { primary: routes['primary-provider'].id, coder: routes['primary-provider'].id, reviewer: routes['primary-provider'].id, ...(routes['embedding-provider'] ? { embedding: routes['embedding-provider'].id } : {}) } : {}, verifyRecipeIds: options.workspace === false ? [] : ['verify'], ...(options.workspace === false ? {} : { targetId: 'target', workspace: '.' }), createdAt: now(), updatedAt: now() };
    app.store.put('project', project);
    const port = await app.listen(), url = 'http://127.0.0.1:' + port;
    const api = async (endpoint: string, body?: unknown, token: string | null = owner.token, method?: string) => {
        const response = await fetch(url + endpoint, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() };
    };
    const conversation = async () => { const response = await api('/api/conversations', { projectId: project.id }); assert.equal(response.status, 201); return response.data as Conversation; };
    const send = (conversation: Conversation, body: unknown) => api('/api/conversations/' + conversation.id + '/messages', body);
    const done = async (run: Run) => { await app.orchestrator.idle(run.id); return app.store.require<Run>('run', run.id); };
    return { root, workspace, config, app, owner, routes, project, calls, url, api, conversation, send, done };
}

test('auto greeting is an immediate terminal service reply with no connected model or execution target', async t => {
    const f = await fixture(t, { models: false, workspace: false }), conversation = await f.conversation(), started = Date.now();
    const response = await f.send(conversation, { text: 'come stai?', mode: 'auto' });
    assert.equal(response.status, 202); assert.equal(response.data.status, 'succeeded'); assert.equal(response.data.intent, 'service');
    assert.ok(Date.now() - started < 1500); assert.equal(f.calls.length, 0); assert.equal(response.data.budget.callsUsed, 0); assert.equal(response.data.tasks.length, 0);
    const persisted = await f.api('/api/conversations/' + conversation.id);
    assert.equal(persisted.data.messages.at(-1).source, 'service'); assert.equal(persisted.data.messages.at(-1).status, 'complete');
    assert.equal(persisted.data.messages.at(-1).metrics, undefined); assert.match(persisted.data.messages.at(-1).text, /ci sono/);
});

test('service greeting and status in a live mission do not pause, cancel or replace the working agent', async t => {
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const f = await fixture(t, { complete: async request => { started(); return new Promise<InferenceResult>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); } });
    const conversation = await f.conversation();
    const mission = await f.send(conversation, { text: 'Implementa il progetto richiesto', mode: 'mission', permissions: { write: true, commands: true } });
    assert.equal(mission.status, 202); await entered;
    const original = f.app.store.require<Run>('run', mission.data.id), phase = original.phase;
    for (const text of ['come stai?', 'a che punto siamo?']) {
        const response = await f.send(conversation, { text, mode: 'auto' });
        assert.equal(response.status, 202); assert.equal(response.data.status, 'succeeded'); assert.equal(response.data.intent, 'service');
    }
    const current = f.app.store.require<Run>('run', mission.data.id);
    assert.equal(current.status, 'planning'); assert.equal(current.phase, phase); assert.equal(current.tasks[0].status, 'running'); assert.equal(f.calls.length, 1);
    assert.ok(f.app.orchestrator.active.has(mission.data.id));
    const messages = f.app.store.require<Conversation>('conversation', conversation.id).messages;
    assert.equal(messages.filter(message => message.source === 'service').length, 2);
    assert.match(messages.at(-1)!.text, /attività aperte/);
    await f.api('/api/runs/' + mission.data.id + '/cancel', {}); await f.done(mission.data);
});

test('auto explanatory questions use one completion and no team, workspace commands or verification', async t => {
    const f = await fixture(t), conversation = await f.conversation();
    const response = await f.send(conversation, { text: 'Spiegami la differenza fra un modello e un harness', mode: 'auto', permissions: { write: true, commands: true } });
    assert.equal(response.status, 202); const run = await f.done(response.data);
    assert.equal(run.status, 'succeeded'); assert.equal(run.mode, 'chat'); assert.equal(run.intent, 'conversation');
    assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].tools, []); assert.equal(run.tasks.length, 1); assert.equal(run.tasks[0].role, 'primary');
    assert.equal(run.budget.callsUsed, 1); assert.deepEqual(await readdir(f.workspace), []);
    assert.equal(f.app.store.all('evidence').length, 0); assert.equal(run.verificationPassed, undefined);
});

test('auto work requests require execution setup while explicit chat overrides workflow classification', async t => {
    const f = await fixture(t, { workspace: false }), conversation = await f.conversation();
    const missingWorkspace = await f.send(conversation, { text: 'Crea una funzione TypeScript per ordinare un array', mode: 'auto' });
    assert.equal(missingWorkspace.status, 409); assert.equal(missingWorkspace.data.code, 'WORKSPACE'); assert.equal(f.calls.length, 0);
    const configured = await f.api('/api/projects/' + f.project.id, { targetId: 'target', workspace: '.', verifyRecipeIds: [] }, f.owner.token, 'PATCH'); assert.equal(configured.status, 200);
    const missingVerification = await f.send(conversation, { text: 'Crea una funzione TypeScript per ordinare un array', mode: 'auto' });
    assert.equal(missingVerification.status, 409); assert.equal(missingVerification.data.code, 'VERIFICATION');
    const explicitChat = await f.send(conversation, { text: 'Crea una funzione TypeScript per ordinare un array', mode: 'chat' });
    assert.equal(explicitChat.status, 202); const run = await f.done(explicitChat.data);
    assert.equal(run.mode, 'chat'); assert.equal(run.status, 'succeeded'); assert.equal(f.calls.length, 1); assert.deepEqual(await readdir(f.workspace), []);
});

test('busy preferred model uses an allowed alternative while preserving conversation and actual response route', async t => {
    const f = await fixture(t), conversation = await f.conversation(), preferred = f.routes['primary-provider'], alternate = f.routes['alternate-provider'];
    const first = await f.send(conversation, { text: 'Spiegami il progetto', mode: 'chat', routeId: preferred.id }); await f.done(first.data);
    const held = await f.app.scheduler.acquire(['primary'], AbortSignal.timeout(3000));
    try {
        const second = await f.send(conversation, { text: 'Approfondisci la risposta precedente', mode: 'auto', routeId: preferred.id, routing: { strategy: 'auto', fallbackRouteIds: [alternate.id], maxWaitMs: 0 } });
        assert.equal(second.status, 202); const run = await f.done(second.data);
        assert.equal(run.status, 'succeeded'); assert.equal(run.tasks[0].routeId, alternate.id); assert.equal(run.tasks[0].routing?.switched, true);
        assert.equal(f.calls[1].model.id, 'alternate-model'); assert.ok(f.calls[1].messages.some(message => message.content.includes('Answer from primary-model')));
        const stored = f.app.store.require<Conversation>('conversation', conversation.id);
        assert.equal(stored.messages.length, 4); assert.equal(stored.messages.at(-1)?.routeId, alternate.id); assert.equal(stored.messages.at(-1)?.source, 'model');
        assert.equal(f.app.scheduler.snapshot().primary, 1); assert.equal(f.app.scheduler.snapshot().alternate, 0);
    } finally { held(); }
});

test('pinned busy model ends within its queue budget with no inference call or leaked reservation', async t => {
    const f = await fixture(t), conversation = await f.conversation(), held = await f.app.scheduler.acquire(['primary'], AbortSignal.timeout(3000));
    try {
        const started = Date.now();
        const response = await f.send(conversation, { text: 'Spiegami il contesto', mode: 'auto', routing: { strategy: 'pinned', fallbackRouteIds: [f.routes['alternate-provider'].id], maxWaitMs: 25 } });
        const run = await f.done(response.data);
        assert.equal(run.status, 'failed'); assert.match(run.error ?? '', /attesa massima/); assert.ok(Date.now() - started < 1500);
        assert.equal(f.calls.length, 0); assert.equal(run.budget.callsUsed, 0); assert.equal(f.app.scheduler.queue.length, 0);
        assert.equal(f.app.scheduler.snapshot().primary, 1); assert.equal(f.app.scheduler.snapshot().alternate ?? 0, 0);
        for (const [key, used] of f.app.scheduler.used) if (key.startsWith('account:')) assert.equal(used, 0);
    } finally { held(); }
});

test('chat embedding queue expires promptly and keeps lexical project context in the answer', async t => {
    let embeddingCalls = 0;
    const embeddingUrl = await http(t, (_req, res) => { embeddingCalls++; res.end('{"data":[{"index":0,"embedding":[1,0]}]}'); });
    const f = await fixture(t, { embeddingUrl: embeddingUrl + '/v1' }), conversation = await f.conversation();
    const artifact = await f.api('/api/artifacts', { projectId: f.project.id, name: 'quartz.md', content: '# Quartz\nQuartz uses the QZR-731 retry discipline for this project.' }); assert.equal(artifact.status, 201);
    const held = await f.app.scheduler.acquire(['embedding'], AbortSignal.timeout(4000));
    try {
        const started = Date.now(), response = await f.send(conversation, { text: 'Spiegami quartz e la sua disciplina di retry', mode: 'chat' }), run = await f.done(response.data);
        assert.equal(run.status, 'succeeded'); assert.equal(f.calls.length, 1); assert.equal(embeddingCalls, 0);
        assert.ok(Date.now() - started < 2500); assert.ok(f.calls[0].messages.some(message => message.content.includes('QZR-731')));
        assert.ok(run.tasks[0].context?.sources.some(source => source.id === artifact.data.id && source.included));
        assert.ok(f.app.store.replay(f.owner.user.id).some(event => event.type === 'context.warning' && event.runId === run.id));
        assert.equal(f.app.scheduler.queue.length, 0);
    } finally { held(); }
});

test('provider failure after a partial chat response never replays the prompt on an alternative', async t => {
    const f = await fixture(t, { complete: async request => { request.onText('Risposta parziale conservata'); throw Object.assign(new Error('Upstream connection interrupted'), { status: 503 }); } }), conversation = await f.conversation();
    const response = await f.send(conversation, { text: 'Spiegami una strategia di cache', mode: 'chat', routing: { strategy: 'auto', fallbackRouteIds: [f.routes['alternate-provider'].id], maxWaitMs: 50 } }), run = await f.done(response.data);
    assert.ok(['failed', 'interrupted'].includes(run.status)); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].model.id, 'primary-model');
    const stored = f.app.store.require<Conversation>('conversation', conversation.id);
    assert.equal(stored.messages.at(-1)?.text, 'Risposta parziale conservata'); assert.equal(stored.messages.at(-1)?.status, 'error');
    assert.equal(f.app.scheduler.queue.length, 0); assert.ok([...f.app.scheduler.used.values()].every(value => value === 0));
});

test('provider failure after a real tool side effect cannot replay that operation through a repair or fallback', async t => {
    let coderCalls = 0;
    const f = await fixture(t, { complete: async request => {
        if (request.tools?.some(tool => tool.name === 'write_file')) {
            coderCalls++;
            if (request.messages.some(message => message.role === 'tool')) throw Object.assign(new Error('Provider failed after completed command'), { status: 503 });
            return answer('', [{ id: 'append-once', name: 'run_command', arguments: JSON.stringify({ recipeId: 'append' }) }]);
        }
        return answer(JSON.stringify({ tasks: [{ id: 'implement', title: 'Record one completed operation', role: 'coder', instruction: 'Execute the append recipe exactly once, then describe its result.', dependsOn: [] }] }));
    } }), conversation = await f.conversation();
    const response = await f.send(conversation, { text: 'Implementa il requisito nel workspace', mode: 'mission', permissions: { write: true, commands: true }, maxIterations: 3, routing: { strategy: 'auto', fallbackRouteIds: [f.routes['alternate-provider'].id], maxWaitMs: 100 } });
    const run = await f.done(response.data);
    assert.ok(['failed', 'interrupted'].includes(run.status));
    assert.equal(await readFile(path.join(f.workspace, 'side-effect.txt'), 'utf8'), 'executed\n');
    assert.equal(coderCalls, 2); assert.equal(f.calls.length, 3); assert.ok(f.calls.every(request => request.model.id === 'primary-model'));
    assert.equal(f.app.scheduler.queue.length, 0); assert.ok([...f.app.scheduler.used.values()].every(value => value === 0));
});

test('public HUD excludes private connections and project state while invalid credentials never become a guest', async t => {
    const f = await fixture(t), conversation = await f.conversation();
    await f.send(conversation, { text: 'come stai?', mode: 'auto' });
    const cloud = f.routes['alternate-provider']; f.app.store.setSecret(cloud.accountId, 'private-provider-key-for-test');
    f.app.catalog.telemetry.set('primary', { nodeId: 'primary', status: 'offline', quality: 'unknown', error: 'private SSH path /home/operator/key', details: { network: [{ name: 'eth0', addresses: ['192.168.99.77'] }] } });
    const response = await f.api('/api/bootstrap', undefined, null); assert.equal(response.status, 200);
    const data = response.data as Bootstrap; assert.equal(data.user.id, 'guest');
    for (const key of ['projects', 'conversations', 'accounts', 'runs', 'approvals', 'memories', 'artifacts', 'evidence', 'targets'] as const) assert.deepEqual(data[key], []);
    const serialized = JSON.stringify(data);
    for (const hidden of ['Private cloud provider label', 'private-provider-key-for-test', 'private-host-primary', 'private SSH path', '192.168.99.77', f.project.id, f.owner.user.id, cloud.accountId]) assert.ok(!serialized.includes(hidden), hidden);
    assert.ok(data.models.every(model => model.accountId === 'public'));
    assert.equal((await f.api('/api/bootstrap', undefined, 'invalid_key')).status, 401);
    f.config.publicDashboard = false;
    assert.equal((await f.api('/api/bootstrap', undefined, null)).status, 401);
    assert.equal((await f.api('/api/bootstrap')).status, 200);
});

test('public SSE has a separate capacity and routing snapshots contain no private account data', { timeout: 10000 }, async t => {
    const f = await fixture(t), controller = new AbortController();
    try {
        const guests: Response[] = [];
        for (let i = 0; i < 9; i++) guests.push(await fetch(f.url + '/api/events', { signal: controller.signal }));
        assert.ok(guests.every(response => response.status === 200), 'Anonymous windows must not share one authenticated account limit');
        const authenticated = await fetch(f.url + '/api/events', { headers: { Authorization: 'Bearer ' + f.owner.token }, signal: controller.signal });
        assert.equal(authenticated.status, 200);
        const guestReader = guests[8].body!.getReader(), privateReader = authenticated.body!.getReader();
        await guestReader.read(); await privateReader.read();
        f.app.broadcastRouting();
        const guestFrame = new TextDecoder().decode((await guestReader.read()).value);
        const privateFrame = new TextDecoder().decode((await privateReader.read()).value);
        assert.match(guestFrame, /routing.updated/); assert.match(guestFrame, /resourceUsage/);
        assert.ok(!guestFrame.includes('routeAvailability')); assert.ok(!guestFrame.includes('providerLoads')); assert.ok(!guestFrame.includes(f.owner.user.id));
        assert.match(privateFrame, /routeAvailability/); assert.ok(privateFrame.includes(f.routes['primary-provider'].id));
        assert.ok(!privateFrame.includes('account:'), 'Internal quota semaphore IDs cannot reach an SSE client');
    } finally { controller.abort(); }
});
