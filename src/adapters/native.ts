import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CodexBackend } from './vendor/backends/codex.ts';
import { AntigravityBackend } from './vendor/backends/antigravity.ts';
import { inspectCodex } from './vendor/inspect.ts';
import { loginCodex } from './vendor/login.ts';
import { inspectAntigravity } from './antigravity-inspect.ts';
import { googleLogin, type LoginPrompt } from './antigravity-login.ts';
import { profile } from './inference.ts';
import { cleanLabel, count, record, unknownQuota } from './http-utils.ts';
import type { AdapterConnection, DiscoveryResult, NativeRequest, NativeResult, QuotaObservation } from './types.ts';

const queues = new Map<string, Promise<void>>();
async function exclusive<T>(key: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  const predecessor = queues.get(key) ?? Promise.resolve(); queues.set(key, tail);
  let entered = false;
  const finish = () => { release(); if (queues.get(key) === tail) queues.delete(key); };
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Operation cancelled.')); };
      signal.addEventListener('abort', abort, { once: true });
      void predecessor.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      if (signal.aborted) abort();
    });
    entered = true; signal.throwIfAborted(); return await action();
  } finally {
    // A cancelled waiter returns promptly, but its queue slot cannot release a
    // later account operation before the current account operation has ended.
    if (entered) finish(); else void predecessor.then(finish);
  }
}
async function accountKey(connection: AdapterConnection): Promise<string> {
  if (connection.kind !== 'codex' && connection.kind !== 'antigravity') throw new Error('This is not an official CLI connection.');
  if (connection.kind === 'antigravity' && !connection.isolatedProfilePath) return 'antigravity-global-cli';
  const configured = connection.kind === 'codex' ? connection.env?.CODEX_HOME : connection.isolatedProfilePath;
  if (!configured || !path.isAbsolute(configured)) throw new Error('Every Codex account requires an isolated absolute CODEX_HOME configured on the server.');
  const info = await lstat(configured); const real = await realpath(configured);
  if (!info.isDirectory() || info.isSymbolicLink() || real !== path.resolve(configured) || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) throw new Error('Native account directory must be owned by the service user, private (0700) and not a symlink.');
  return `${connection.kind}:${real}`;
}
export async function nativeAccountBusy(connection: AdapterConnection): Promise<boolean> {
  return queues.has(await accountKey(connection));
}
export function normalizeNativeQuota(value: unknown): QuotaObservation {
  const raw = record(value), result = unknownQuota();
  result.source = 'official-runtime';
  if (typeof raw.observed_at === 'string' && Number.isFinite(Date.parse(raw.observed_at))) result.observedAt = raw.observed_at;
  const buckets = Array.isArray(raw.buckets) ? raw.buckets : [];
  result.buckets = buckets.slice(0, 32).flatMap(value => {
    const row = record(value); const windows = (Array.isArray(row.windows) ? row.windows : []).slice(0, 8).flatMap(value => {
      const window = record(value), usedPercent = count(window.used_percent); if (usedPercent === undefined) return [];
      const windowMinutes = count(window.window_minutes), resetsAt = count(window.resets_at);
      return [{ name: cleanLabel(window.name, 'window'), usedPercent, remainingPercent: Math.max(0, 100 - usedPercent), ...(windowMinutes !== undefined ? { windowMinutes } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) }];
    });
    return windows.length ? [{ id: cleanLabel(row.id, 'codex'), label: cleanLabel(row.label, 'Codex'), windows }] : [];
  });
  result.state = !result.buckets.length ? 'unknown' : result.buckets.some(bucket => bucket.windows.some(window => window.usedPercent >= 100)) ? 'limited' : 'known';
  return result;
}
export async function runNativeAgent(request: NativeRequest): Promise<NativeResult> {
  const key = await accountKey(request.connection);
  return exclusive(key, request.signal, async () => {
    const instance = request.connection.kind === 'codex' ? new CodexBackend({ requestTimeoutMs: request.requestTimeoutMs, turnTimeoutMs: request.turnTimeoutMs }) : new AntigravityBackend({ requestTimeoutMs: request.requestTimeoutMs, turnTimeoutMs: request.turnTimeoutMs });
    let quota = unknownQuota();
    const result = await instance.run({ profile: profile(request.connection, request.model), cwd: request.cwd, prompt: request.prompt, readOnly: request.readOnly, workspaceTools: request.workspaceTools, signal: request.signal, resumeId: request.resumeId, approve: request.approve,
      onEvent: event => { if (event.type === 'quota') quota = normalizeNativeQuota(event.quota); request.onEvent(event); } });
    return { ...result, quota };
  });
}
export async function inspectNative(options: { connection: AdapterConnection; cwd: string; signal: AbortSignal; timeoutMs?: number }): Promise<DiscoveryResult & { authenticated: boolean; capabilities: Record<string, unknown> }> {
  const key = await accountKey(options.connection);
  if (options.connection.kind === 'antigravity') return exclusive(key, options.signal, () => inspectAntigravity(options));
  return exclusive(key, options.signal, async () => {
    const result = await inspectCodex(profile(options.connection, { id: '' }), options.cwd, options.signal, options.timeoutMs ?? 30_000);
    const models = (Array.isArray(result.models) ? result.models : []).map(value => {
      const row = record(value); const contextWindow = count(row.context_window);
      return { id: cleanLabel(row.id), label: cleanLabel(row.name, cleanLabel(row.id)), ...(contextWindow ? { contextWindow } : {}), capabilities: ['chat', 'tools'] as Array<'chat' | 'tools'>, capabilitySource: 'provider' as const };
    }).filter(row => row.id);
    return { models, quota: normalizeNativeQuota(result.quota), warnings: Array.isArray(result.warnings) ? result.warnings.filter(v => typeof v === 'string') as string[] : [], authenticated: record(result.account).state === 'authenticated', capabilities: record(result.capabilities) };
  });
}
export async function loginNative(options: { connection: AdapterConnection; cwd: string; signal: AbortSignal; onAuth: (event: LoginPrompt & { loginId?: string }) => void; timeoutMs?: number }): Promise<{ authenticated: boolean; invalidateSessions: boolean }> {
  if (options.connection.kind === 'antigravity') {
    const signal=AbortSignal.any([options.signal,AbortSignal.timeout(options.timeoutMs ?? 5*60000)]);
    return exclusive(await accountKey(options.connection),signal,async()=>{
      await googleLogin(options.connection,options.cwd,signal,options.onAuth);
      return {authenticated:true,invalidateSessions:false};
    });
  }
  if (options.connection.kind !== 'codex') throw new Error('Guided device login is available only for the official Codex runtime.');
  const key = await accountKey(options.connection);
  return exclusive(key, options.signal, async () => {
    const result = await loginCodex(profile(options.connection, { id: '' }), options.cwd, options.signal, 30_000, options.timeoutMs ?? 5 * 60_000,
      event => { if (event.type === 'auth') options.onAuth({ verificationUrl: String(event.verification_url), userCode: String(event.user_code), loginId: String(event.login_id) }); });
    return { authenticated: result.authenticated === true, invalidateSessions: result.invalidate_sessions === true };
  });
}
