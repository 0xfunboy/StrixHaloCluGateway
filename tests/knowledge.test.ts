import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultConfig } from '../src/config.ts';
import type { Conversation, KnowledgeSearchResult, Project } from '../src/contracts.ts';
import { compileContext } from '../src/context.ts';
import { OnlineMemorySlot } from '../src/knowledge-reader.ts';
import { Knowledge } from '../src/knowledge.ts';
import { Application } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { hash, now } from '../src/util.ts';

const signal = () => AbortSignal.timeout(5000);
async function fixture(t: test.TestContext, http = false) {
    const directory = await mkdtemp(path.join(tmpdir(), 'yed1z-knowledge-'));
    const app = http ? new Application({ directory, config: { ...defaultConfig(), port: 0, nodes: [], providers: [] } }) : undefined;
    const store = app?.store ?? new Store(directory);
    t.after(async () => {
        if (app) await app.close();
        else store.close();
        await rm(directory, { recursive: true, force: true });
    });
    const knowledge = app?.knowledge ?? new Knowledge(store);
    const owner = store.createUser('Owner', 'operator');
    const member = store.createUser('Member', 'member');
    const viewer = store.createUser('Viewer', 'viewer');
    const unrelated = store.createUser('Outside', 'member');
    const project = store.put<Project>('project', {
        id: 'project', name: 'Release fixture', description: '', ownerId: owner.user.id, memberIds: [member.user.id, viewer.user.id],
        createdAt: now(), updatedAt: now(), routes: {}, verifyRecipeIds: [],
    });
    return { app, store, knowledge, owner, member, viewer, unrelated, project };
}

test('online weighted slots equal stable batch softmax at large logits', () => {
    const documents = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const logits = [1001, 1000, 999];
    const expected = logits.map(logit => Math.exp(logit - 1001));
    const mass = expected.reduce((total, weight) => total + weight, 0);
    const forward = new OnlineMemorySlot(3), reverse = new OnlineMemorySlot(3);
    for (const [index, vector] of documents.entries()) forward.add(logits[index], vector);
    for (const index of [2, 1, 0]) reverse.add(logits[index], documents[index]);
    for (const [index, weight] of expected.entries()) {
        assert(Math.abs(forward.mean()![index] - weight / mass) < 1e-12);
        assert(Math.abs(reverse.mean()![index] - weight / mass) < 1e-12);
        assert(Math.abs(forward.contribution(logits[index]) - weight / mass) < 1e-12);
    }
});

test('semantic slots recover two separate clues with reproducible passages under a fixed output budget', async t => {
    const { knowledge: k, project, owner } = await fixture(t);
    const first = k.addArtifact(owner.user, project.id, 'Container', 'Use the penguin-green image for the rollout.');
    const second = k.addArtifact(owner.user, project.id, 'Gate', 'The canary must pass the health probe before promotion.');
    k.addArtifact(owner.user, project.id, 'Cafeteria', 'Vegetable soup is available here.');
    const encode = async (texts: string[]) => texts.map(text => {
        if (text.includes('penguin') || text === 'Describe launch prerequisites') return [1, 0, 0];
        if (text.includes('health') || text === 'explain acceptance criteria') return [0, 1, 0];
        if (text.startsWith('Describe')) return [1, 1, 0];
        return [0, 0, 1];
    });
    await k.reindex(owner.user, project, 'encoder-one', encode, signal());
    const query = 'Describe launch prerequisites e explain acceptance criteria';
    const output = await k.search(owner.user, project.id, query, { modelKey: 'encoder-one', embed: encode, maxChars: 128, limit: 2 });
    assert.equal(output.report.embeddingStatus, 'used');
    assert.equal(output.report.scannedSources, 3);
    assert(output.report.usedChars <= 128);
    assert.deepEqual(new Set(output.results.map(result => result.id)), new Set([first.id, second.id]));
    const left = output.results.find(result => result.id === first.id)!;
    const right = output.results.find(result => result.id === second.id)!;
    assert(left.signals.slots![1].weight > right.signals.slots![1].weight);
    assert(right.signals.slots![2].weight > left.signals.slots![2].weight);
    for (const result of output.results) {
        const source = k.source(owner.user, project.id, result.id, { sourceHash: result.citation.sourceHash });
        assert.equal(source.content.slice(result.citation.start, result.citation.end), result.text);
        assert.equal(result.citation.excerptHash, hash(result.text));
    }
    const compiled = compileContext({ project, goal: query, history: [], memories: [], retrieved: output.results, instructions: 'Read-only evaluation.' });
    assert.equal(compiled.report.sources.find(source => source.id === left.id)?.citation?.sourceHash, left.citation.sourceHash);
    assert(compiled.messages.some(message => message.role === 'user' && message.content.includes('penguin-green image')));
    k.removeArtifact(owner.user, first.id);
    const after = await k.search(owner.user, project.id, query, { modelKey: 'encoder-one', embed: encode, limit: 2 });
    assert(!after.results.some(result => result.id === first.id));
    assert(after.results.find(result => result.id === second.id)!.signals.slots![0].weight > right.signals.slots![0].weight);
});

test('reindex reuses unchanged passages separately by encoder and cannot restore a withdrawn vector batch', async t => {
    const { knowledge: k, store, project, owner } = await fixture(t);
    const memory = k.addMemory(owner.user, project.id, { title: 'Prior method', content: 'Keep the kiosk dry.', kind: 'method', scope: 'project' });
    k.updateMemory(owner.user, memory.id, { status: 'approved' });
    let embeddings = 0;
    const encode = async (texts: string[]) => { embeddings += texts.length; return texts.map(() => [1, 0]); };
    assert.equal((await k.reindex(owner.user, project, 'first', encode, signal())).indexed, 1);
    k.updateMemory(owner.user, memory.id, { title: 'Updated title' });
    assert.deepEqual(await k.reindex(owner.user, project, 'first', encode, signal()), { indexed: 0, skipped: 0, reused: 1 });
    assert.equal((await k.reindex(owner.user, project, 'second', encode, signal())).indexed, 1);
    assert.equal((await k.search(owner.user, project.id, 'meaning', { embed: encode, modelKey: 'first' })).report.embeddingStatus, 'used');
    assert.equal(embeddings, 3);
    let produce!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { produce = resolve; });
    const start = new Promise<void>(resolve => { entered = resolve; });
    const pending = k.reindex(owner.user, project, 'third', async texts => { entered(); await waiting; return texts.map(() => [1, 0]); }, signal());
    await start;
    await assert.rejects(k.reindex(owner.user, project, 'third', encode, signal()), { code: 'REINDEX_BUSY' });
    k.updateMemory(owner.user, memory.id, { status: 'retired' });
    produce();
    assert.deepEqual(await pending, { indexed: 0, skipped: 1, reused: 0 });
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM knowledge_vectors').get()?.n, 0);
    assert.equal((await k.search(owner.user, project.id, 'kiosk', { modelKey: 'first', embed: encode })).results.length, 0);
});

test('legacy vectors remain readable and a forced rebuild repairs incompatible dimensions', async t => {
    const { knowledge: k, store, project, owner } = await fixture(t);
    const artifact = k.addArtifact(owner.user, project.id, 'Coffee', 'La procedura caffè è documentata.');
    store.db.prepare('UPDATE chunks SET model=?,vector=? WHERE document=?').run('encoder', '[1,0]', artifact.id);
    const old = async (texts: string[]) => texts.map(() => [1, 0]);
    const current = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    assert.equal((await k.search(owner.user, project.id, 'coffee recipe', { modelKey: 'encoder', embed: old })).report.embeddingStatus, 'used');
    const incompatible = await k.search(owner.user, project.id, 'caffe', { modelKey: 'encoder', embed: current });
    assert.equal(incompatible.report.embeddingStatus, 'incompatible');
    assert.equal(incompatible.results[0].method, 'lexical');
    assert.deepEqual(await k.reindex(owner.user, project, 'encoder', current, signal(), true), { indexed: 1, skipped: 0, reused: 0 });
    assert.equal((await k.search(owner.user, project.id, 'coffee recipe', { modelKey: 'encoder', embed: current })).report.embeddingStatus, 'used');
});

test('a shared withdrawal during query encoding removes its passage before readout', async t => {
    const { knowledge: k, project, owner, member } = await fixture(t);
    const memory = k.addMemory(owner.user, project.id, { title: 'Shared', content: 'The approved document contains a zircon reference.', kind: 'document', scope: 'project' });
    k.updateMemory(owner.user, memory.id, { status: 'approved' });
    await k.reindex(owner.user, project, 'encoder', async texts => texts.map(() => [1, 0]), signal());
    let produce!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { produce = resolve; });
    const start = new Promise<void>(resolve => { entered = resolve; });
    const search = k.search(member.user, project.id, 'zircon', {
        modelKey: 'encoder', embed: async texts => { entered(); await wait; return texts.map(() => [1, 0]); },
    });
    await start;
    k.updateMemory(owner.user, memory.id, { status: 'retired' });
    produce();
    assert.deepEqual((await search).results, []);
    assert.throws(() => k.source(member.user, project.id, memory.id), { code: 'NOT_FOUND' });
});

test('knowledge HTTP search, source read and bootstrap share publication ACLs and enforce revision', async t => {
    const { app, knowledge: k, project, owner, member, viewer, unrelated, store } = await fixture(t, true);
    const port = await app!.listen();
    const source = store.put<Conversation>('conversation', { id: 'prior-conversation', projectId: project.id, ownerId: owner.user.id, title: 'Private discussion', createdAt: now(), updatedAt: now(), messages: [] });
    const note = k.addMemory(owner.user, project.id, { title: 'Release note', kind: 'decision', content: 'Approved cobalt branch.', scope: 'project', sourceIds: [source.id] });
    const req = (token: string, route: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${route}`, {
        ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    });
    const search = '/api/projects/project/knowledge/search', anchor = '/api/projects/project/knowledge/sources/' + note.id;
    assert.equal((await (await req(member.token, '/api/bootstrap')).json()).memories.length, 0);
    assert.equal((await req(member.token, anchor)).status, 404);
    k.updateMemory(owner.user, note.id, { status: 'approved' });
    const bootstrap = await (await req(member.token, '/api/bootstrap')).json();
    assert.equal(bootstrap.memories.length, 1);
    assert.deepEqual(bootstrap.memories[0].sourceIds, []);
    assert.equal((await req(unrelated.token, search, { query: 'cobalt' })).status, 404);
    const response = await req(viewer.token, search, { query: 'cobalt' });
    assert.equal(response.status, 200);
    const result = await response.json() as KnowledgeSearchResult;
    assert.equal(result.results[0].citation.scope, 'project');
    const pinned = anchor + '?revision=' + result.results[0].citation.revision + '&hash=' + result.results[0].citation.sourceHash;
    assert.equal((await req(member.token, pinned)).status, 200);
    k.updateMemory(owner.user, note.id, { title: 'Revised note' });
    assert.equal((await req(member.token, pinned)).status, 409);
    k.updateMemory(owner.user, note.id, { content: 'Unapproved replacement.' });
    assert.equal((await req(member.token, anchor)).status, 404);
    assert.equal((await (await req(member.token, '/api/bootstrap')).json()).memories.length, 0);
});
