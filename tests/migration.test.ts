import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { importLegacy, legacyMetrics } from '../src/migration.ts';
import { hash } from '../src/util.ts';
import type { Conversation, Project } from '../src/contracts.ts';

const stamp = '2026-11-15T18:00:00.000+00:00';
const alice = hash('named:funboy').slice(0, 32), bob = hash('named:cooper').slice(0, 32);
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'yed1z-migrate-'));
  const databasePath = join(root, 'portal.sqlite3'), source = new DatabaseSync(databasePath);
  source.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, updated_at TEXT NOT NULL, active_turn TEXT, body TEXT NOT NULL); CREATE TABLE providers(id TEXT,owner TEXT,body TEXT); CREATE TABLE browser_sessions(id_hash TEXT,key_hash TEXT,expires REAL);');
  const store = new Store(join(root, 'new-state'));
  const owner = store.createUser('funboy', 'operator').user, other = store.createUser('other', 'member').user;
  const project: Project = { id: 'project-one', ownerId: owner.id, memberIds: [], name: 'Migrated', description: '', routes: {}, verifyRecipeIds: [], createdAt: stamp, updatedAt: stamp };
  store.put('project', project);
  const insert = (id: string, legacyOwner: string, payload: unknown, active: string | null = null) => source.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(id, legacyOwner, stamp, active, typeof payload === 'string' ? payload : JSON.stringify(payload));
  t.after(async () => { source.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, databasePath, source, store, owner, other, project, insert };
}

test('imports only the chosen legacy owner, preserves visible text/dates/metrics and never imports native state or secrets', async t => {
  const f = await fixture(t);
  f.insert('one', alice, { id: 'one', title: 'Progetto Qwen', created_at: stamp, updated_at: stamp, route_id: 'PRIVATE_ROUTE', history: [{ role: 'system', content: 'PRIVATE_INTERNAL_CONTEXT' }], remote_sessions: { profile: { token: 'PRIVATE_NATIVE_TOKEN', id: 'PRIVATE_SESSION' } }, api_key: 'PRIVATE_BODY_KEY', messages: [
    { id: 'old-u', role: 'user', content: 'Implementa il progetto.', created_at: stamp, status: 'complete' },
    { id: 'old-a', role: 'assistant', content: 'Risposta reale.', created_at: stamp, status: 'complete', reasoning: 'PRIVATE_REASONING', providerMetadata: { secret: 'PRIVATE_SIGNED_METADATA' }, model_name: 'Qwen locale', account_label: 'Strix', metrics: { usage: { input_tokens: 34, output_tokens: 0, total_tokens: 34, cached_input_tokens: 0 }, timing: { ttft_ms: 0, total_ms: 14, prefill_ms: 0, decode_tokens_per_second: 0 }, context: { limit_tokens: 32768, used_tokens: 34 }, sources: { usage: 'engine' } } },
  ] });
  f.insert('two', bob, { title: 'PRIVATE_OTHER_USER', messages: [{ role: 'user', content: 'PRIVATE_OTHER_TEXT' }] });
  f.source.prepare('INSERT INTO providers VALUES(?,?,?)').run('p', alice, JSON.stringify({ api_key: 'PRIVATE_PROVIDER_KEY' }));
  f.source.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run('PRIVATE_COOKIE', 'PRIVATE_AUTH_HASH', 9999999999);
  const before = await readFile(f.databasePath), modified = (await stat(f.databasePath)).mtimeMs;
  const result = importLegacy({ store: f.store, databasePath: f.databasePath, owner: f.owner, projectId: f.project.id, legacyOwner: alice });
  assert.equal(result.imported, 1); assert.equal(result.skipped, 0); assert.equal(result.resolvedOwner, alice);
  const imported = f.store.all<Conversation>('conversation'); assert.equal(imported.length, 1); assert.equal(imported[0].ownerId, f.owner.id); assert.equal(imported[0].title, 'Progetto Qwen'); assert.equal(imported[0].createdAt, stamp); assert.equal(imported[0].updatedAt, stamp);
  assert.equal(imported[0].messages[0].text, 'Implementa il progetto.'); assert.equal(imported[0].messages[1].createdAt, stamp); assert.equal(imported[0].messages[1].metrics?.outputTokens, 0); assert.equal(imported[0].messages[1].metrics?.ttftMs, 0); assert.equal(imported[0].messages[1].metrics?.source, 'legacy-reported:engine');
  assert(!JSON.stringify(imported).includes('PRIVATE_')); assert.equal(f.store.all('provider').length, 0); assert.equal(f.store.all('run').length, 0);
  assert.deepEqual(await readFile(f.databasePath), before); assert.equal((await stat(f.databasePath)).mtimeMs, modified);
});

test('label and owner hash select the same source identity; replay and a copied backup are idempotent', async t => {
  const f = await fixture(t); f.insert('one', alice, { title: 'Thread', created_at: stamp, updated_at: stamp, messages: [{ role: 'user', content: 'hello' }] });
  const options = { store: f.store, databasePath: f.databasePath, owner: f.owner, projectId: f.project.id, legacyOwner: 'funboy' };
  const first = importLegacy(options); assert.equal(first.imported, 1); assert.equal(first.resolvedOwner, alice);
  const original = f.store.all<Conversation>('conversation')[0]; original.messages.push({ id: 'new-msg', role: 'assistant', text: 'Nuovo lavoro', createdAt: stamp }); f.store.put('conversation', original);
  assert.equal(importLegacy({ ...options, legacyOwner: alice }).skipped, 1);
  const copy = join(f.root, 'backup.sqlite3'); await copyFile(f.databasePath, copy);
  const repeated = importLegacy({ ...options, databasePath: copy }); assert.equal(repeated.imported, 0); assert.equal(repeated.skipped, 1);
  assert.equal(f.store.all<Conversation>('conversation').length, 1); assert.equal(f.store.all<Conversation>('conversation')[0].messages.at(-1)?.text, 'Nuovo lavoro');
});

test('changed source and deleted destination are never silently overwritten or resurrected', async t => {
  const f = await fixture(t); f.insert('one', alice, { title: 'Thread', created_at: stamp, updated_at: stamp, messages: [{ role: 'user', content: 'originale' }] });
  const options = { store: f.store, databasePath: f.databasePath, owner: f.owner, projectId: f.project.id, legacyOwner: alice };
  importLegacy(options); const original = f.store.all<Conversation>('conversation')[0];
  f.source.prepare('UPDATE conversations SET body=? WHERE id=?').run(JSON.stringify({ title: 'Thread', created_at: stamp, updated_at: stamp, messages: [{ role: 'user', content: 'cambiato' }] }), 'one');
  const changed = importLegacy(options); assert.equal(changed.skipped, 1); assert(changed.warnings.some(w => w.includes('cambiate nella sorgente'))); assert.equal(f.store.get<Conversation>('conversation', original.id)?.messages[0].text, 'originale');
  f.store.remove('conversation', original.id); const deleted = importLegacy(options); assert.equal(deleted.imported, 0); assert(deleted.warnings.some(w => w.includes('non ricreate'))); assert.equal(f.store.all('conversation').length, 0);
});

test('system/tool text loses instruction authority and interrupted turns never become active jobs', async t => {
  const f = await fixture(t); f.insert('active', alice, { title: 'Old active', messages: [
    { role: 'system', content: 'Old instructions', status: 'complete' }, { role: 'tool', content: 'Old command output', status: 'complete' }, { role: 'user', content: 'Request', status: 'complete' }, { role: 'assistant', content: 'Partial answer', status: 'streaming' },
  ] }, 'old-active-turn');
  const result = importLegacy({ store: f.store, databasePath: f.databasePath, owner: f.owner, projectId: f.project.id, legacyOwner: alice });
  const c = f.store.all<Conversation>('conversation')[0]; assert(c.messages.every(m => m.role !== 'system')); assert.match(c.messages[0].text, /senza autorità/); assert.match(c.messages[1].text, /Old command output/); assert.equal(c.messages[3].text, 'Partial answer'); assert.equal(c.messages[3].status, 'error'); assert.equal(f.store.all('run').length, 0); assert(result.warnings.some(w => w.includes('interrotti')));
  assert.equal(f.source.prepare('SELECT active_turn FROM conversations WHERE id=?').get('active')?.active_turn, 'old-active-turn');
});

test('invalid records are isolated and a missing selector never imports other users', async t => {
  const f = await fixture(t); f.insert('bad', alice, 'PRIVATE_BAD_JSON'); f.insert('good', alice, { messages: [{ role: 'user', content: 'valid' }] }); f.insert('other', bob, { messages: [{ role: 'user', content: 'private other' }] });
  const options = { store: f.store, databasePath: f.databasePath, owner: f.owner, projectId: f.project.id, legacyOwner: alice };
  const result = importLegacy(options); assert.equal(result.imported, 1); assert.equal(result.skipped, 1); assert(result.warnings.some(w => w.includes('Record non validi'))); assert(!JSON.stringify(result).includes('PRIVATE_BAD_JSON'));
  const absent = importLegacy({ ...options, legacyOwner: 'nonexistent-name' }); assert.equal(absent.imported, 0); assert.match(absent.warnings.join('\n'), /Nessuna conversazione/); assert.equal(f.store.all('conversation').length, 1);
  assert.throws(() => importLegacy({ ...options, legacyOwner: '' }), /Proprietario legacy/);
});

test('destination project ACL and source schema are enforced before any import', async t => {
  const f = await fixture(t); f.insert('one', alice, { messages: [{ role: 'user', content: 'private' }] });
  assert.throws(() => importLegacy({ store: f.store, databasePath: f.databasePath, owner: f.other, projectId: f.project.id, legacyOwner: alice }), /Progetto non trovato/);
  assert.equal(f.store.all('conversation').length, 0);
  assert.throws(() => importLegacy({ store: f.store, databasePath: join(f.store.directory, 'control.sqlite'), owner: f.owner, projectId: f.project.id, legacyOwner: alice }), /distinto/);
  const unknownPath = join(f.root, 'unknown.sqlite'), unknown = new DatabaseSync(unknownPath); unknown.exec('CREATE TABLE conversations(id TEXT,body TEXT)'); unknown.close();
  assert.throws(() => importLegacy({ store: f.store, databasePath: unknownPath, owner: f.owner, projectId: f.project.id, legacyOwner: alice }), /Colonne/);
});

test('read-only import includes committed WAL data without checkpointing or changing the source', async t => {
  const f = await fixture(t); f.source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  f.insert('wal-one', alice, { title: 'Committed WAL', messages: [{ role: 'user', content: 'In WAL' }] });
  const before = await readFile(f.databasePath), walBefore = await readFile(f.databasePath + '-wal');
  const result = importLegacy({ store: f.store, databasePath: f.databasePath, owner: f.owner, projectId: f.project.id, legacyOwner: alice });
  assert.equal(result.imported, 1); assert.equal(f.store.all<Conversation>('conversation')[0].messages[0].text, 'In WAL');
  assert.deepEqual(await readFile(f.databasePath), before); assert.deepEqual(await readFile(f.databasePath + '-wal'), walBefore);
});

test('legacy numeric validation keeps zeros, drops invalid values and does not mislabel aggregate context', () => {
  const metrics = legacyMetrics({ usage: { input_tokens: 20, output_tokens: 0, cached_input_tokens: -1 }, timing: { decode_tokens_per_second: Infinity, prefill_ms: 0 }, context: { used_tokens: 20, limit_tokens: 1024 }, sources: { usage: 'provider_aggregate' } });
  assert.equal(metrics?.outputTokens, 0); assert.equal(metrics?.cachedInputTokens, undefined); assert.equal(metrics?.decodeTokensPerSecond, undefined); assert.equal(metrics?.prefillMs, 0); assert.equal(metrics?.contextUsed, undefined); assert.equal(metrics?.source, 'legacy-reported:provider_aggregate'); assert.equal(legacyMetrics({ secret: 'nope' }), undefined);
});
