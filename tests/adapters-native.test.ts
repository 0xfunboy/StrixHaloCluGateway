import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectNative, loginNative, runNativeAgent, normalizeNativeQuota } from '../src/adapters/native.ts';
import type { AdapterConnection, RuntimeEvent } from '../src/adapters/types.ts';

const fixture = fileURLToPath(new URL('./adapters-cli-fixture.ts', import.meta.url));
async function account(mode = 'run') {
  const home = await mkdtemp(join(tmpdir(), 'yed1z-codex-fixture-')); await chmod(home, 0o700);
  const connection: AdapterConnection = { id: 'codex-account', label: 'Codex fixture', kind: 'codex', command: process.execPath, args: [fixture, mode], env: { CODEX_HOME: home } };
  return { home, connection, close: () => rm(home, { recursive: true, force: true }) };
}
const signal = () => AbortSignal.timeout(5000);

test('native discovery uses official app-server protocol and returns only sanitized models/quotas', async () => {
  const a = await account();
  try {
    const result = await inspectNative({ connection: a.connection, cwd: a.home, signal: signal(), timeoutMs: 1500 });
    assert.equal(result.authenticated, true); assert.equal(result.models[0].id, 'fixture-model'); assert.equal(result.quota.state, 'known'); assert.equal(result.quota.buckets?.[0].windows[0].remainingPercent, 75); assert(!JSON.stringify(result).includes('PRIVATE_'));
  } finally { await a.close(); }
});

test('native Codex turn relays approvals, captures usage, captures reasoning and observes quota', async () => {
  const a = await account(); const events: RuntimeEvent[] = []; let approvals = 0;
  try {
    const result = await runNativeAgent({ connection: a.connection, model: { id: 'fixture-model' }, cwd: a.home, prompt: 'Inspect', readOnly: false, signal: signal(), requestTimeoutMs: 1500, turnTimeoutMs: 3000,
      approve: async approval => { approvals++; assert.equal(approval.kind, 'command'); return true; }, onEvent: event => events.push(event) });
    assert.equal(result.text, 'Hello. Approved.'); assert.equal(result.thinking, 'Model reasoning process'); assert.equal(approvals, 1); assert.equal(result.usage?.inputTokens, 12); assert.equal(result.quota.buckets?.[0].windows[0].usedPercent, 25); assert(!JSON.stringify({ result, events }).includes('PRIVATE_'));
  } finally { await a.close(); }
});

test('read-only Codex turn never asks user to approve a write-capable runtime action', async () => {
  const a = await account(); let approvals = 0;
  try {
    const result = await runNativeAgent({ connection: a.connection, model: { id: 'fixture-model' }, cwd: a.home, prompt: 'Inspect', readOnly: true, signal: signal(), requestTimeoutMs: 1500, turnTimeoutMs: 3000, approve: async () => { approvals++; return true; }, onEvent: () => {} });
    assert.equal(result.text, 'Hello. Denied.'); assert.equal(approvals, 0);
  } finally { await a.close(); }
});

test('guided device login forwards ephemeral official URL/code and requires authenticated confirmation', async () => {
  const a = await account(); const auth: unknown[] = [];
  try {
    const result = await loginNative({ connection: a.connection, cwd: a.home, signal: signal(), onAuth: event => auth.push(event), timeoutMs: 3000 });
    assert.deepEqual(result, { authenticated: true, invalidateSessions: true }); assert.deepEqual(auth, [{ verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH', loginId: 'fixture-login' }]); assert(!JSON.stringify({ auth, result }).includes('PRIVATE_'));
  } finally { await a.close(); }
});

test('guided login rejects unofficial verification URLs', async () => {
  const a = await account('bad-url');
  try { await assert.rejects(loginNative({ connection: a.connection, cwd: a.home, signal: signal(), onAuth: () => assert.fail('unofficial URL must not be shown'), timeoutMs: 3000 }), /official HTTPS/); } finally { await a.close(); }
});

test('CLI account isolation is mandatory and runtime sandbox downgrade is rejected', async () => {
  await assert.rejects(inspectNative({ connection: { id: 'no-home', kind: 'codex', label: 'Unsafe' }, cwd: tmpdir(), signal: signal() }), /isolated absolute CODEX_HOME/);
  const a = await account('unsafe');
  try { await assert.rejects(runNativeAgent({ connection: a.connection, model: { id: 'fixture' }, cwd: a.home, prompt: 'Inspect', readOnly: true, signal: signal(), approve: async () => true, onEvent: () => {} }), /sandbox policy/); } finally { await a.close(); }
});

test('active native turn is interruptible and returns no success on cancellation', async () => {
  const a = await account('hang'); const controller = new AbortController();
  try { await assert.rejects(runNativeAgent({ connection: a.connection, model: { id: 'fixture' }, cwd: a.home, prompt: 'Inspect', readOnly: true, signal: controller.signal, approve: async () => false, onEvent: event => { if (event.type === 'text') controller.abort(); } }), /cancel|abort/i); } finally { await a.close(); }
});

test('unknown native quota is unknown; real zero usage remains zero and windows stay separate', () => {
  assert.equal(normalizeNativeQuota({ accessToken: 'private' }).state, 'unknown');
  const quota = normalizeNativeQuota({ buckets: [{ id: 'c', label: 'Codex', windows: [{ name: 'primary', used_percent: 0 }, { name: 'secondary', used_percent: 100 }] }] });
  assert.equal(quota.state, 'limited'); assert.equal(quota.buckets?.[0].windows[0].remainingPercent, 100); assert.equal(quota.buckets?.[0].windows[1].remainingPercent, 0);
});

test('a queued account operation can cancel promptly without bypassing the active account lock', async () => {
  const a = await account('hang'); const active = new AbortController(), queued = new AbortController();
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const running = runNativeAgent({ connection: a.connection, model: { id: 'fixture' }, cwd: a.home, prompt: 'Inspect', readOnly: true, signal: active.signal, approve: async () => false, onEvent: event => { if (event.type === 'text') started(); } });
  void running.catch(() => {});
  try {
    await ready;
    const waiting = inspectNative({ connection: a.connection, cwd: a.home, signal: queued.signal });
    queued.abort(new Error('queued cancellation'));
    await assert.rejects(waiting, /queued cancellation/);
    let inspected = false;
    const third = inspectNative({ connection: a.connection, cwd: a.home, signal: signal() }).then(value => { inspected = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(inspected, false);
    active.abort(); await assert.rejects(running, /cancel|abort/i); assert.equal((await third).authenticated, true);
  } finally { active.abort(); await a.close(); }
});
