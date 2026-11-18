import type { Profile } from './core/types.ts';
import { JsonRpcProcess, RpcMethodError, record, string, bounded } from './backends/rpc.ts';
import { codexArgs, confirmCodexProfile } from './backends/codex-profile.ts';

type Data = Record<string, unknown>;
export interface ObservedModel { id: string; name: string; context_window?: number; }
interface Window { name: string; used_percent: number; remaining_percent: number; window_minutes?: number; resets_at?: number; }
interface Bucket { id: string; label: string; windows: Window[]; observed_at: string; }

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function label(value: unknown, fallback: string): string {
  const text = string(value).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
  return text || fallback;
}
/** Return only documented numeric quota fields, never arbitrary RPC payloads. */
export function quotaSnapshot(value: unknown): Data {
  const data = record(value);
  const observed_at = new Date().toISOString();
  const multiple = record(data.rateLimitsByLimitId);
  const source: Array<[string, Data]> = Object.keys(multiple).length
    ? Object.entries(multiple).slice(0, 32).map(([id, row]) => [id, record(row)])
    : Object.keys(record(data.rateLimits)).length ? [['codex', record(data.rateLimits)]] : [];
  const buckets: Bucket[] = [];
  for (const [fallbackId, row] of source) {
    const windows: Window[] = [];
    for (const name of ['primary', 'secondary']) {
      const window = record(row[name]);
      if (!nonnegative(window.usedPercent)) continue;
      windows.push({ name, used_percent: window.usedPercent, remaining_percent: Math.max(0, 100 - window.usedPercent),
        ...(nonnegative(window.windowDurationMins) ? { window_minutes: window.windowDurationMins } : {}),
        ...(nonnegative(window.resetsAt) ? { resets_at: window.resetsAt } : {}) });
    }
    if (windows.length) buckets.push({ id: label(row.limitId, label(fallbackId, 'codex')), label: label(row.limitName, label(row.limitId, fallbackId)), windows, observed_at });
  }
  return { state: !buckets.length ? 'unknown' : buckets.some(row => row.windows.some(window => window.used_percent >= 100)) ? 'limited' : 'known',
    buckets, scope: 'reported-windows', observed_at };
}

export async function inspectCodex(profile: Profile, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<Data> {
  const warnings: string[] = [];
  const models: ObservedModel[] = [];
  let account: Data = { label: profile.name, state: 'unknown' };
  let quota: Data = quotaSnapshot({});
  const login_help = 'On the server, run the official codex login command in the same isolated account directory configured for this profile. No credentials are returned by inspection.';
  const rpc = new JsonRpcProcess({
    label: 'Codex inspection', command: profile.command || 'codex',
    args: codexArgs(profile), cwd, env: profile.env,
    requestTimeoutMs: timeoutMs, omitJsonRpcVersion: true,
    onNotification: () => {},
    onRequest: async () => { throw new RpcMethodError('Inspection does not authorize tools or interactive actions.'); },
  });
  const run = async () => {
    const initialized = await rpc.request('initialize', {
      clientInfo: { name: 'yed1z_harness', title: 'yed1z', version: '0.2.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, { signal });
    rpc.notify('initialized');
    await confirmCodexProfile(rpc, initialized, profile.env?.CODEX_HOME, signal);
    // Each read is independent; unavailable quota does not erase a valid model catalog.
    const reads = await Promise.allSettled([
      (async () => {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        const ids = new Set<string>();
        for (let page = 0; page < 20; page++) {
          const result = record(await rpc.request('model/list', { ...(cursor ? { cursor } : {}), limit: 100, includeHidden: false }, { signal }));
          const rows = Array.isArray(result.data) ? result.data : Array.isArray(result.models) ? result.models : [];
          for (const raw of rows.slice(0, 100)) {
            const row = record(raw), id = string(row.model) || string(row.id);
            if (!id || id.length > 300 || ids.has(id)) continue;
            ids.add(id);
            const context = row.contextWindow ?? row.context_window ?? row.maxContextTokens;
            models.push({ id, name: label(row.displayName ?? row.name, id),
              ...(Number.isSafeInteger(context) && Number(context) > 0 ? { context_window: Number(context) } : {}) });
          }
          cursor = string(result.nextCursor);
          if (!cursor || cursors.has(cursor)) break;
          cursors.add(cursor);
        }
      })(),
      (async () => {
        const result = record(await rpc.request('account/read', { refreshToken: false }, { signal }));
        const identity = record(result.account);
        const authenticated = identity.type === 'chatgpt' || identity.type === 'apiKey' || identity.type === 'amazonBedrock';
        account = { label: profile.name, state: authenticated ? 'authenticated' : result.requiresOpenaiAuth === true ? 'unauthenticated' : 'unknown' };
      })(),
      (async () => {
        try { quota = quotaSnapshot(await rpc.request('account/rateLimits/read', {}, { signal })); }
        catch (error) { quota = quotaSnapshot({}); throw error; }
      })(),
    ]);
    const names = ['Model discovery', 'Account status', 'Quota observation'];
    reads.forEach((result, i) => { if (result.status === 'rejected') warnings.push(`${names[i]} is unavailable in this runtime or login session.`); });
  };
  try {
    await bounded(run(), signal, Math.max(timeoutMs * 4, 1_000), 'Codex inspection', rpc.failure);
  } catch (error) {
    if (signal.aborted) throw error;
    warnings.push('Unable to inspect the official Codex runtime. Check its executable, version and local login.');
  } finally { rpc.dispose(); }
  signal.throwIfAborted();
  return { models, quota, account, ...(warnings.length ? { warnings } : {}),
    ...(account.state !== 'authenticated' ? { login_help } : {}),
    capabilities: { modes: ['chat', 'agent', 'plan'], inspect: true, login: Boolean(profile.env?.CODEX_HOME), live_streaming: true, approval_boundary: 'official-runtime' } };
}
