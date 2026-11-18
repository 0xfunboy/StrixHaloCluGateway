import { setTimeout as delay } from 'node:timers/promises';
import { AdapterError, pinnedFetch, readJSON, record } from './http-utils.ts';

export interface EngineReadiness {
  /** Direct engine /v1/models URL, never a node-agent static catalog. */
  modelsUrl: string;
  expectedModel: string | string[];
  modelsSecret?: string;
  timeoutMs?: number;
  pollMs?: number;
}
export interface HttpEngineSpec extends EngineReadiness {
  /** Operator-configured lifecycle endpoint, called at most once under an exclusive resource lease. */
  switchUrl?: string;
  body?: Record<string, unknown>;
  switchSecret?: string;
}
function url(value: string): URL {
  let parsed: URL; try { parsed = new URL(value); } catch { throw new AdapterError('Invalid engine endpoint.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new AdapterError('Engine endpoint must be HTTP(S) without embedded credentials or query parameters.');
  return parsed;
}
function expected(spec: EngineReadiness): string[] {
  const ids = typeof spec.expectedModel === 'string' ? [spec.expectedModel] : spec.expectedModel;
  if (!Array.isArray(ids) || !ids.length || ids.length > 32 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 1000)) throw new AdapterError('Readiness requires explicit expected engine model identifiers.');
  return ids;
}
function timeout(spec: EngineReadiness): number {
  const n = spec.timeoutMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(n) || n < 100 || n > 60 * 60_000) throw new AdapterError('Invalid engine readiness timeout.'); return n;
}
function auth(secret?: string): Record<string, string> { return secret ? { authorization: `Bearer ${secret}` } : {}; }

/** An advertised catalog is not enough: point this at the actual inference engine. */
export async function isEngineReady(spec: EngineReadiness, signal: AbortSignal): Promise<boolean> {
  const target = url(spec.modelsUrl), ids = expected(spec);
  const attempt = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  try {
    const response = await pinnedFetch(target, { headers: auth(spec.modelsSecret), signal: attempt });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new AdapterError(`Engine readiness requires valid authorization (HTTP ${response.status}).`, response.status);
      return false;
    }
    const payload = record(await readJSON(response, attempt, 1024 * 1024));
    const models = Array.isArray(payload.data) ? payload.data : [];
    return models.some(item => {
      const model = record(item);
      return ids.includes(String(model.id ?? '')) && !['available', 'unloaded', 'loading', 'testing'].includes(String(model.status ?? '').toLowerCase());
    });
  } catch (error) {
    signal.throwIfAborted();
    if (attempt.aborted) return false;
    const code = record(error).code;
    if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)) return false;
    // Misconfiguration, redirects, metadata targets and malformed responses are
    // not evidence that an engine is simply unloaded: do not activate on them.
    throw error;
  }
}
export async function waitEngineReady(spec: EngineReadiness, signal: AbortSignal, onStatus: (status: string) => void = () => {}): Promise<void> {
  url(spec.modelsUrl); expected(spec);
  const scoped = AbortSignal.any([signal, AbortSignal.timeout(timeout(spec))]);
  const pollMs = spec.pollMs ?? 1000; if (!Number.isSafeInteger(pollMs) || pollMs < 20 || pollMs > 30_000) throw new AdapterError('Invalid readiness polling interval.');
  try {
    onStatus('loading');
    while (!await isEngineReady(spec, scoped)) await delay(pollMs, undefined, { signal: scoped });
    onStatus('ready');
  } catch (error) { signal.throwIfAborted(); if (scoped.aborted) throw new AdapterError('The expected engine model did not become ready before the deadline.'); throw error; }
}

/** The caller must hold all required resource groups until inference completes. */
export async function ensureHttpEngine(spec: HttpEngineSpec, signal: AbortSignal, onStatus: (status: string) => void = () => {}): Promise<void> {
  url(spec.modelsUrl); expected(spec);
  const switchUrl = spec.switchUrl ? url(spec.switchUrl) : undefined;
  const serialized = JSON.stringify(spec.body ?? {}); if (Buffer.byteLength(serialized) > 32 * 1024) throw new AdapterError('Engine activation payload exceeds the limit.');
  const scoped = AbortSignal.any([signal, AbortSignal.timeout(timeout(spec))]);
  try {
    onStatus('checking'); if (await isEngineReady(spec, scoped)) { onStatus('ready'); return; }
    if (switchUrl) {
      onStatus('switching');
      const response = await pinnedFetch(switchUrl, { method: 'POST', body: serialized, headers: { ...auth(spec.switchSecret), 'content-type': 'application/json' }, signal: scoped });
      if (!response.ok) { await response.body?.cancel(); throw new AdapterError(`Engine activation returned HTTP ${response.status}.`, response.status); }
      if (response.status !== 204) {
        const result = record(await readJSON(response, scoped, 1024 * 1024));
        if (result.ok === false || result.error) throw new AdapterError('The node agent rejected engine activation.');
      }
    }
    await waitEngineReady(spec, scoped, onStatus);
  } catch (error) { signal.throwIfAborted(); if (scoped.aborted) throw new AdapterError('Engine activation exceeded its deadline.'); throw error; }
}

/** The Strata node agent acknowledges the stop, then independently reports idle via health. */
export async function stopStrataEngine(spec: { url:string; healthUrl:string },signal:AbortSignal):Promise<void> {
  const stop=url(spec.url), health=url(spec.healthUrl);
  const scope=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
  const response=await pinnedFetch(stop,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:scope});
  if(!response.ok){await response.body?.cancel();throw new AdapterError('Il nodo non ha accettato l’arresto del motore.',response.status);}
  if(record(await readJSON(response,scope,65536)).ok!==true) throw new AdapterError('Arresto non confermato.');
  while(true) {
    const checked=await pinnedFetch(health,{signal:scope});
    if(checked.ok) {
      const data=record(await readJSON(checked,scope,65536));
      if(data.strata_state==='idle' && (data.active_model===null || data.active_model==='none')) return;
    } else await checked.body?.cancel();
    await delay(350,undefined,{signal:scope});
  }
}
