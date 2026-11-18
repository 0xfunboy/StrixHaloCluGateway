import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Application } from '../src/server.ts';
import { defaultConfig, type Config } from '../src/config.ts';
import { complete as completeHttp } from '../src/adapters/index.ts';
import type { Completion } from '../src/orchestrator.ts';
import type { InferenceRequest, InferenceResult, ToolCall } from '../src/adapters/types.ts';
import type { Account, Bootstrap, Conversation, ModelRoute, Project, Provider, Run } from '../src/contracts.ts';
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

test('direct chat can use a second route while the mission and its source message stay independent', async t => {
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const f = await fixture(t, { complete: async request => {
        if (request.model.id === 'alternate-model') return answer('Independent response');
        started();
        return new Promise<InferenceResult>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    } });
    const conversation = await f.conversation();
    const mission = await f.send(conversation, { text: 'Implementa il progetto richiesto', mode: 'mission' });
    assert.equal(mission.status, 202);
    await entered;
    const chat = await f.send(conversation, { text: 'Spiegami i passaggi', mode: 'chat', routeId: f.routes['alternate-provider'].id, parentRunId: mission.data.id });
    assert.equal(chat.status, 202);
    const answerRun = await f.done(chat.data);
    assert.equal(answerRun.status, 'succeeded');
    assert.equal(answerRun.parentRunId, mission.data.id);
    assert.equal(f.app.store.require<Run>('run', mission.data.id).status, 'planning');
    const messages = f.app.store.require<Conversation>('conversation', conversation.id).messages;
    assert.equal(messages.find(message => message.id === answerRun.sourceMessageId)?.runId, chat.data.id);
    assert.equal(messages.at(-1)?.text, 'Independent response');
    assert.equal(f.calls[0].signal.aborted, false);
    await f.api(`/api/runs/${mission.data.id}/cancel`, {});
    await f.done(mission.data);
});

test('text-only planner and reviewer stay usable while the capable coder gets workspace tools', async t => {
    const seen: Array<{ model: string; role: string; tools: string[] }> = [];
    const endpoint = await http(t, (req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += String(chunk); });
        req.on('end', () => {
            const request = JSON.parse(raw);
            const rules = request.messages.find((message: { role: string }) => message.role === 'system').content;
            const role = /Your role: ([a-z]+)/u.exec(rules)?.[1] ?? 'unknown';
            const tools = (request.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
            seen.push({ model: request.model, role, tools });
            res.setHeader('Content-Type', 'application/json');
            if (request.model === 'alternate-model' && tools.length) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Tool calling is not supported on this router surface' }));
                return;
            }
            const message: Record<string, unknown> = { role: 'assistant' };
            if (role === 'primary') message.content = JSON.stringify({ tasks: [{ id: 'patch', title: 'Patch', role: 'coder', instruction: 'Create product.txt with the supplied content.', dependsOn: [] }] });
            if (role === 'coder') {
                if (!request.messages.some((entry: { role: string }) => entry.role === 'tool')) {
                    message.tool_calls = [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'product.txt', content: 'verified product' }) } }];
                } else message.content = 'Created product.txt.';
            }
            if (role === 'reviewer') message.content = JSON.stringify({ approved: true, issues: [], summary: 'Candidate ready for executable checks.' });
            res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
        });
    });
    const f = await fixture(t, { complete: request => completeHttp({ ...request, connection: { ...request.connection, baseUrl: `${endpoint}/v1` } }) });
    const textRoute = f.routes['alternate-provider'];
    f.app.store.put('model', { ...textRoute, capabilities: [], capabilitySource: 'unknown' });
    f.app.store.put('project', { ...f.project, routes: { ...f.project.routes, reviewer: textRoute.id } });
    const created = await f.api('/api/conversations', { projectId: f.project.id, title: 'Titolo esplicito conservato' });
    const invitation = await f.send(created.data, { text: 'Implementa la piccola consegna', mode: 'mission', routeId: textRoute.id, permissions: { write: true }, maxIterations: 1 });
    const run = await f.done(invitation.data);
    assert.equal(run.status, 'succeeded', run.error);
    assert.deepEqual(seen.map(({ role, model }) => [role, model]), [['primary', 'alternate-model'], ['coder', 'primary-model'], ['coder', 'primary-model'], ['reviewer', 'alternate-model']]);
    assert.ok(seen.filter(call => call.model === 'alternate-model').every(call => call.tools.length === 0));
    assert.ok(seen.filter(call => call.role === 'coder').every(call => call.tools.includes('write_file')));
    assert.equal(await readFile(path.join(f.workspace, 'product.txt'), 'utf8'), 'verified product');
    assert.equal(f.app.store.require<Conversation>('conversation', created.data.id).title, 'Titolo esplicito conservato');
});

test('a chat-only HTTP route cannot execute a coder assignment', async t => {
    const f = await fixture(t, { complete: async () => answer(JSON.stringify({ tasks: [{ id: 'patch', title: 'Patch', role: 'coder', instruction: 'Modify the fixture.', dependsOn: [] }] })) });
    const route = f.routes['primary-provider'];
    f.app.store.put('model', { ...route, capabilities: ['chat'], capabilitySource: 'operator' });
    const conversation = await f.conversation();
    const request = await f.send(conversation, { text: 'Implementa una modifica di prova', mode: 'mission', permissions: { write: true }, maxIterations: 1 });
    const run = await f.done(request.data);
    assert.equal(run.status, 'failed');
    assert.match(run.tasks.find(task => task.role === 'coder')?.error ?? '', /Capacità necessarie/u);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].tools, []);
    assert.deepEqual(await readdir(f.workspace), []);
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

test('native chat emits successful inference completion and reports observed token usage without a decode estimate', async t => {
    const f = await fixture(t, { models: false });
    const cli = fileURLToPath(new URL('./adapters-cli-fixture.ts', import.meta.url));
    for (const [mode, expected] of [
        ['run', [12, 4, 0, 16]],
        ['usage-zero', [0, 0, 0, 0]],
        ['usage-unknown', [undefined, undefined, undefined, undefined]],
    ] as const) {
        const provider = f.app.store.put<Provider>('provider', { id: mode, kind: 'codex', label: 'Codex fixture', command: process.execPath, args: [cli, mode], enabled: true, nodeIds: [], resourceGroupIds: [], ownerId: f.owner.user.id, createdAt: now() });
        const account = f.app.catalog.addAccount(f.owner.user, provider.id, 'Fixture');
        const { models: [route] } = await f.app.catalog.discover(f.owner.user, account.id, AbortSignal.timeout(5000));
        assert.ok(route?.enabled);
        const conversation = await f.conversation();
        const response = await f.send(conversation, { text: 'Summarize the fixture workspace.', mode: 'chat', routeId: route.id });
        assert.equal(response.status, 202);
        const run = await f.done(response.data);
        assert.equal(run.status, 'succeeded', run.error);
        assert.equal(run.budget.callsUsed, 1);
        if (mode === 'usage-unknown') assert.ok(run.budget.outputTokensUsed > 0);
        const saved = await f.api('/api/conversations/' + conversation.id);
        const metrics = saved.data.messages.at(-1).metrics;
        assert.deepEqual([metrics.inputTokens, metrics.outputTokens, metrics.cachedInputTokens, metrics.totalTokens], expected);
        assert.equal(metrics.source, mode === 'usage-unknown' ? 'unknown' : 'official-runtime');
        assert.ok(metrics.durationMs > 0);
        assert.equal(metrics.decodeTokensPerSecond, undefined);
        const history = await f.api(`/api/runs/${run.id}/events`);
        const events = history.data.events.filter((event: { type: string }) => event.type.startsWith('inference.'));
        assert.deepEqual(events.map((event: { type: string }) => event.type), ['inference.started', 'inference.completed']);
        assert.deepEqual(events[1].data, {
            routeId: route.id, accountId: route.accountId, durationMs: metrics.durationMs,
            ...(expected[0] === undefined ? {} : { inputTokens: expected[0], outputTokens: expected[1] })
        });
    }
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
    await f.app.knowledge.reindex(f.owner.user, f.project, f.project.routes.embedding!, async texts => texts.map(() => [1, 0]), AbortSignal.timeout(1000));
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

test('an explicit pre-output HTTP 429 can switch within the approved account pool on the same task', async t => {
    const requested: string[] = [];
    const endpoint = await http(t, (req, res) => {
        let body = '';
        req.on('data', chunk => { body += String(chunk); });
        req.on('end', () => {
            const model = String(JSON.parse(body).model);
            requested.push(model);
            res.setHeader('Content-Type', 'application/json');
            if (model === 'primary-model') {
                res.statusCode = 429;
                res.setHeader('Retry-After', '90');
                res.end(JSON.stringify({ error: 'quota' }));
            } else {
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Alternative reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } }));
            }
        });
    });
    const f = await fixture(t, { complete: request => completeHttp({ ...request, connection: { ...request.connection, baseUrl: `${endpoint}/v1` } }) });
    const conversation = await f.conversation();
    const preferred = f.routes['primary-provider'];
    const alternative = f.routes['alternate-provider'];
    const response = await f.send(conversation, { text: 'Spiegami la quota', mode: 'chat', routeId: preferred.id, routing: { strategy: 'auto', fallbackRouteIds: [alternative.id] } });
    const run = await f.done(response.data);
    assert.equal(run.status, 'succeeded', run.error);
    assert.deepEqual(requested, ['primary-model', 'alternate-model']);
    assert.equal(run.tasks.length, 1);
    assert.equal(run.tasks[0].attempts?.length, 1);
    assert.equal(run.tasks[0].attempts?.[0].requestedRouteId, preferred.id);
    assert.equal(run.tasks[0].attempts?.[0].routeId, alternative.id);
    assert.equal(run.budget.callsUsed, 2);
    assert.equal(f.app.store.require<Account>('account', preferred.accountId).status, 'cooldown');
    assert.ok(f.app.store.replay(f.owner.user.id).some(event => event.type === 'route.reselected' && event.data?.chosenRouteId === alternative.id));
    const messages = f.app.store.require<Conversation>('conversation', conversation.id).messages;
    assert.equal(messages.at(-1)?.routeId, alternative.id);
    assert.equal(messages.at(-1)?.text, 'Alternative reply');
});

test('pinned HTTP 429 never uses an alternative', async t => {
    const f = await fixture(t, { complete: async () => { throw Object.assign(new Error('Quota reached'), { status: 429 }); } });
    const conversation = await f.conversation();
    const response = await f.send(conversation, { text: 'Spiegami la quota', mode: 'chat', routing: { strategy: 'pinned', fallbackRouteIds: [f.routes['alternate-provider'].id] } });
    const run = await f.done(response.data);
    assert.equal(run.status, 'failed');
    assert.deepEqual(f.calls.map(call => call.model.id), ['primary-model']);
});

test('provider failure after a partial chat response never replays the prompt on an alternative', async t => {
    const f = await fixture(t, { complete: async request => { request.onText('Risposta parziale conservata'); throw Object.assign(new Error('Upstream connection interrupted'), { status: 429 }); } }), conversation = await f.conversation();
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
            if (request.messages.some(message => message.role === 'tool')) throw Object.assign(new Error('Provider failed after completed command'), { status: 429 });
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
    assert.equal(run.operations?.filter(op => op.kind === 'command').length, 1);
    assert.equal((await f.api(`/api/runs/${run.id}/resume`, {})).status, 200);
    const retried = await f.done(run);
    assert.equal(retried.checkpoint?.plannerTaskId, run.checkpoint?.plannerTaskId);
    assert.equal(retried.tasks.find(task => task.role === 'coder')?.attempts?.length, 2);
    assert.equal(retried.operations?.filter(op => op.kind === 'command').length, 1);
    assert.equal(await readFile(path.join(f.workspace, 'side-effect.txt'), 'utf8'), 'executed\n');
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

test('branch preserves a completed prefix and paged evidence is owner-scoped', async t => {
    const f = await fixture(t), c = await f.conversation();
    const result = await f.send(c, { text:'come stai?', mode:'auto' });
    const parent = (await f.api('/api/conversations/' + c.id)).data;
    const branch = await f.api('/api/conversations/' + c.id + '/branch', { messageId:parent.messages[0].id });
    assert.equal(branch.status,201); assert.deepEqual(branch.data.messages,[parent.messages[0]]); assert.equal(branch.data.branch.conversationId,c.id);
    await f.send(branch.data,{ text:'ciao', mode:'auto' });
    assert.deepEqual((await f.api('/api/conversations/' + c.id)).data.messages,parent.messages);
    for (let i=0;i<205;i++) f.app.store.emit({ ownerId:f.owner.user.id, projectId:c.projectId, runId:result.data.id, type:'test.step' });
    const path='/api/runs/' + result.data.id + '/events';
    const first = (await f.api(path)).data, next = (await f.api(path+'?after='+first.nextCursor)).data;
    assert.equal(first.events.length,200); assert.ok(next.events.length>=5); assert.equal(next.nextCursor,null);
    assert.ok(next.events[0].id>first.events.at(-1).id);
    const outsider=f.app.store.createUser('Un altro utente','operator');
    assert.equal((await f.api(path,undefined,outsider.token)).status,404);
    assert.equal((await f.api(path+'?after=-1')).status,400);
});

test('manual models validate account, expose unknown capability and archive with restore',async t=>{
    const f=await fixture(t), primary=f.routes['primary-provider'], alternate=f.routes['alternate-provider'];
    const value={providerId:primary.providerId,accountId:primary.accountId,model:'manual'};
    assert.equal((await f.api('/api/models',{...value,accountId:alternate.accountId})).status,400);
    const created=await f.api('/api/models',value); assert.equal(created.status,201); assert.equal(created.data.contextWindow,undefined); assert.deepEqual(created.data.capabilities,[]);
    const url='/api/models/'+created.data.id;
    assert.equal((await f.api(url,undefined,f.owner.token,'DELETE')).status,200);
    assert.equal(f.app.store.require<ModelRoute>('model',created.data.id).enabled,false);
    assert.equal((await f.api(url,{enabled:true},f.owner.token,'PATCH')).data.enabled,true);
});

test('facade records actual usage and public monitoring redacts client identity',async t=>{
    const f=await fixture(t), route=f.routes['primary-provider'];
    const login=await f.api('/api/auth/verify',{admin_key:f.owner.token});assert.equal(login.status,200);assert.equal(login.data.ok,true);
    const result=await f.api('/v1/chat/completions',{model:route.id,messages:[{role:'user',content:'private prompt marker'}],max_tokens:8});
    assert.equal(result.status,200);
    const monitor=(await f.api('/api/telemetry',undefined,null)).data;
    assert.equal(monitor.stats.totals.total_requests,1); assert.equal(monitor.stats.totals.total_tokens,52);
    assert.ok(!JSON.stringify(monitor).includes('private prompt marker'));assert.ok(!JSON.stringify(monitor).includes(f.owner.user.id));
});

test('Responses protocol retains tool namespaces, tool output and response event order',async t=>{
    const f=await fixture(t,{ complete:async r=>{
        if(r.messages.at(-1)?.role==='tool'){r.onText('OK');return answer('OK');}
        return answer('',[{id:'read-attempt-1',name:'repo__read',arguments:'{"file":"README"}'}]);
    }});
    const route=f.routes['primary-provider'], model=route.id;
    const tools=[{type:'namespace',name:'repo',tools:[{type:'function',name:'read',parameters:{type:'object'}}]}];
    const call=await f.api('/v1/responses',{model,input:'read',tools});
    assert.equal(call.status,200);const item=call.data.output[0];assert.equal(item.name,'read');assert.equal(item.namespace,'repo');
    const response=await fetch(f.url+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.owner.token},
      body:JSON.stringify({model,tools,stream:true,input:[item,{type:'function_call_output',call_id:item.call_id,output:'file content'}]})});
    assert.equal(response.status,200);const events=(await response.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
    assert.equal(events[0].type,'response.created');assert.equal(events.at(-1).type,'response.completed');
    assert.equal(events.at(-1).response.output[0].content[0].text,'OK');
    assert.deepEqual(events.map(x=>x.sequence_number),events.map((_,i)=>i));
    assert.equal(f.calls.at(-1)?.messages.at(-2)?.toolCalls?.[0].name,'repo__read');
});

test('facade rotates to approved account before inference while pinned honors provider cooldown',async t=>{
    const f=await fixture(t),first=f.routes['primary-provider'],fallback=f.routes['alternate-provider'];
    f.app.catalog.quota(f.app.store.require<Account>('account',first.accountId),{state:'limited',source:'provider-headers',observedAt:now(),retryAfterMs:60000});
    const request={model:first.id,messages:[{role:'user',content:'test'}]};
    assert.equal((await f.api('/v1/chat/completions',request)).status,429);
    const alternate=await f.api('/v1/chat/completions',{...request,routing:{strategy:'auto',fallbackRouteIds:[fallback.id]}});
    assert.equal(alternate.status,200);assert.equal(alternate.data.model,fallback.id);assert.equal(f.calls.length,1);
});

test('configured model aliases preserve the selected provider and respect private routes',async t=>{
    const f=await fixture(t);
    f.config.providers[0].models![0].aliases=['local-fast'];
    const result=await f.api('/v1/chat/completions',{model:'local-fast',messages:[{role:'user',content:'test'}]});
    assert.equal(result.status,200);assert.equal(result.data.model,f.routes['primary-provider'].id);
    const models=await f.api('/v1/models');assert.ok(models.data.data.find(m=>m.id===result.data.model).aliases.includes('local-fast'));
});

test('explicit upstream 429 rotates once through approved routes before output, and never retries partial text',async t=>{
    for(const partial of [false,true]) {
        const f=await fixture(t,{complete:async request=>{
            if(request.connection.id==='primary-provider' || request.model.id==='primary-model') {
                if(partial) request.onText('emitted');
                throw Object.assign(Error('limited'),{status:429});
            }
            return answer('OK');
        }});
        const first=f.routes['primary-provider'],next=f.routes['alternate-provider'];
        const r=await f.api('/v1/chat/completions',{model:first.id,messages:[{role:'user',content:'test'}],routing:{strategy:'auto',fallbackRouteIds:[next.id]}});
        assert.equal(r.status,partial?429:200);assert.equal(f.calls.length,partial?1:2);
        assert.equal(f.app.store.require<Account>('account',first.accountId).status,'cooldown');
        if(!partial)assert.equal(r.data.model,next.id);
    }
});

test('account owner grants and revokes individual routes without exposing the grant list or account key',async t=>{
 const f=await fixture(t),peer=f.app.store.createUser('Collaboratore','operator'),other=f.app.store.createUser('Esterno','member');
 const route=f.routes['primary-provider'], url='/api/accounts/'+route.accountId+'/delegates';
 assert.equal((await f.api(url,{userIds:[peer.user.id],shared:false},f.owner.token,'PUT')).status,200);
 const state=(await f.api('/api/bootstrap',undefined,peer.token)).data;
 assert.ok(state.models.some(m=>m.id===route.id));
 assert.equal(state.accounts.find(a=>a.id===route.accountId).grantedUserIds,undefined);
 assert.equal((await f.api(url,undefined,peer.token)).status,404);
 assert.ok(!(await f.api('/api/bootstrap',undefined,other.token)).data.models.some(m=>m.id===route.id));
 assert.equal((await f.api(url,{userIds:[],shared:false},f.owner.token,'PUT')).status,200);
 assert.equal((await f.api('/v1/chat/completions',{model:route.id,messages:[{role:'user',content:'test'}]},peer.token)).status,404);
});

test('browser loopback login and cookie mutations work alongside a configured public origin; untrusted origins remain blocked',async t=>{
 const f=await fixture(t);f.config.publicOrigin='https://control.example.test';
 const login=await fetch(f.url+'/api/login',{method:'POST',headers:{Origin:f.url,'content-type':'application/json'},body:JSON.stringify({token:f.owner.token})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
 for(const [origin,status] of [[f.url,201],['https://untrusted.example',403]] as const){
  const r=await fetch(f.url+'/api/projects',{method:'POST',headers:{Cookie:cookie,Origin:origin,'content-type':'application/json'},body:JSON.stringify({name:'Origin test'})});assert.equal(r.status,status);
 }
});

test('configured capability restoration handles legacy empty placeholders and retains later manual overrides',async t=>{
 const f=await fixture(t),route=f.routes['primary-provider'];
 f.app.store.put('model',{...route,capabilities:[],capabilitySource:'operator',discoveryStatus:undefined});
 f.app.catalog.seed(f.owner.user);assert.deepEqual(f.app.store.require<ModelRoute>('model',route.id).capabilities,['chat','tools']);
 assert.equal((await f.api('/api/models/'+route.id,{capabilities:[]},f.owner.token,'PATCH')).status,200);
 f.app.catalog.seed(f.owner.user);assert.deepEqual(f.app.store.require<ModelRoute>('model',route.id).capabilities,[]);
});

test('new projects inherit the configured visible encoder and local uploads acquire real vectors in the background',async t=>{
 const engine=await http(t,async(req,res)=>{let raw='';for await(const part of req) raw+=part;const values=JSON.parse(raw).input;
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:values.map((_,index)=>({index,embedding:[0.4,0.6]}))}));});
 const f=await fixture(t,{embeddingUrl:engine+'/v1'});const seed=f.config.providers.find(p=>p.id==='embedding-provider')!;seed.tag='local';f.config.defaultEmbeddingProviderId=seed.id;
 const created=await f.api('/api/projects',{name:'Encoder ready'});assert.equal(created.status,201);
 assert.equal(created.data.routes.embedding,f.routes['embedding-provider'].id);
 const doc=await f.api('/api/artifacts',{projectId:created.data.id,name:'decision.md',content:'Conservare tutte le righe vuote.'});assert.equal(doc.status,201);
 let count=0;for(let n=0;n<100&&!count;n++){await new Promise(r=>setTimeout(r,10));count=Number(f.app.store.db.prepare('SELECT count(*) AS n FROM knowledge_vectors WHERE encoder=?').get(created.data.routes.embedding)?.n);}
 assert.ok(count>0);
});
