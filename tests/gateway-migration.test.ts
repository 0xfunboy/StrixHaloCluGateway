import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importGateway } from '../src/gateway-migration.ts';
import { Store } from '../src/store.ts';
import { hash } from '../src/util.ts';

async function fixture(t: test.TestContext) {
    const directory = await mkdtemp(path.join(tmpdir(), 'yed1z-gateway-import-'));
    const store = new Store(directory);
    t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
    const admin = store.createUser('funboy', 'admin');
    const operator = store.createUser('cooper', 'operator');
    const file = async (name: string, data: unknown) => {
        const target = path.join(directory, name);
        await writeFile(target, JSON.stringify(data), { mode: 0o600 });
        return target;
    };
    return { store, admin, operator, file };
}

test('original Gateway import preserves exact owners and private aggregate usage, and can be run twice', async t => {
    const { store, admin, operator, file } = await fixture(t);
    const keysPath = await file('keys.json', {
        keys: ['fixture-a', 'fixture-b', 'fixture-unassigned', 'fixture-other-case'],
        users: { 'fixture-a': 'funboy', 'fixture-b': 'cooper', 'fixture-other-case': 'Cooper' },
        ip_map: { '127.0.0.1': 'funboy' },
    });
    const ownersPath = await file('owners.json', { funboy: admin.user.id, cooper: operator.user.id });
    const statsPath = await file('stats.json', {
        totals: { total_requests: 12, total_tokens: 67, bogus: 'PRIVATE_FIELD' },
        daily_tokens: { '2026-11-17': { deepseek: 22, qwen: 45 }, '2026-02-31': { total: 99 } },
        recent_sessions: [{ user: 'PRIVATE_PERSON', client: 'PRIVATE_ADDRESS' }],
    });
    const options = { store, keysPath, ownersPath, statsPath, usageOwnerId: admin.user.id };
    const plan = importGateway(options);
    assert.deepEqual(plan.keys.byOwner, { funboy: { imported: 1, existing: 0, revoked: 0 }, cooper: { imported: 1, existing: 0, revoked: 0 } });
    assert.equal(plan.keys.unmapped, 2);
    assert.deepEqual(plan.historicalUsage, { days: 1, action: 'planned' });
    assert.equal(store.authenticate('fixture-a', 'key'), undefined);
    assert.deepEqual(store.all('legacy-gateway-usage'), []);
    const applied = importGateway({ ...options, apply: true });
    assert.deepEqual(applied.historicalUsage, { days: 1, action: 'imported' });
    assert.deepEqual(store.authenticate('fixture-a', 'key'), admin.user);
    assert.deepEqual(store.authenticate('fixture-b', 'key'), operator.user);
    assert.equal(store.authenticate('fixture-other-case', 'key'), undefined);
    assert.equal(store.authenticate('fixture-unassigned', 'key'), undefined);
    const archived = store.all<{ ownerId: string; days: unknown; totals: unknown; quality: string }>('legacy-gateway-usage')[0];
    assert.equal(archived.ownerId, admin.user.id);
    assert.equal(archived.quality, 'legacy-reported');
    assert.deepEqual(archived.days, { '2026-11-17': { deepseek: 22, qwen: 45 } });
    assert.deepEqual(archived.totals, { total_tokens: 67, total_requests: 12 });
    const replay = importGateway({ ...options, apply: true });
    assert.deepEqual(replay.historicalUsage, { days: 1, action: 'existing' });
    assert.equal(replay.keys.byOwner.cooper.existing, 1);
    assert.equal(store.all('legacy-gateway-key').length, 2);
    assert.equal(store.all('legacy-gateway-usage').length, 1);
    assert(!/fixture-a|fixture-b|PRIVATE_/.test(JSON.stringify({ plan, applied, archived, replay, receipts: store.all('legacy-gateway-key') })));
});

test('account-key handoff format cannot elevate roles or restore a revoked migrated key', async t => {
    const { store, operator, file } = await fixture(t);
    const keysPath = await file('keys.json', { users: { cooper: { key: 'fixture-primary', keys: ['fixture-secondary'], role: 'admin' } } });
    const ownersPath = await file('owners.json', { cooper: operator.user.id });
    const options = { store, keysPath, ownersPath, apply: true };
    const result = importGateway(options);
    assert.equal(result.keys.byOwner.cooper.imported, 2);
    assert.equal(store.authenticate('fixture-primary', 'key')?.role, 'operator');
    store.db.prepare("DELETE FROM auth WHERE hash=? AND kind='key'").run(hash('fixture-primary'));
    const repeated = importGateway(options);
    assert.deepEqual(repeated.keys.byOwner.cooper, { imported: 0, existing: 1, revoked: 1 });
    assert.equal(store.authenticate('fixture-primary', 'key'), undefined);
});

test('Gateway migration rolls back an earlier write on owner collision or malformed input', async t => {
    const { store, admin, operator, file } = await fixture(t);
    const keysPath = await file('keys.json', { keys: ['fixture-insert-first', operator.token], users: { 'fixture-insert-first': 'funboy', [operator.token]: 'funboy' } });
    const ownersPath = await file('owners.json', { funboy: admin.user.id });
    const statsPath = await file('stats.json', { totals: { total_requests: 21 } });
    assert.throws(() => importGateway({ store, keysPath, ownersPath, statsPath, usageOwnerId: admin.user.id, apply: true }), { code: 'GATEWAY_IMPORT_CONFLICT' });
    assert.equal(store.authenticate('fixture-insert-first'), undefined);
    assert.deepEqual(store.authenticate(operator.token, 'key'), operator.user);
    assert.deepEqual(store.all('legacy-gateway-key'), []);
    assert.deepEqual(store.all('legacy-gateway-usage'), []);
    await writeFile(keysPath, '{"keys":["fixture-must-stay-private"');
    assert.throws(() => importGateway({ store, keysPath, ownersPath, apply: true }), error => error instanceof Error && !error.message.includes('fixture-must-stay-private'));
    assert.equal(store.authenticate('fixture-must-stay-private'), undefined);
});
