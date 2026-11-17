import { pinnedFetch } from './vendor/providers/transport.ts';
import type { AdapterConnection, QuotaObservation } from './types.ts';

export { pinnedFetch };
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export const integer = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
export const cleanLabel = (value: unknown, fallback = ''): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300) : fallback;

export function baseURL(connection: AdapterConnection): URL {
  const fallback = connection.kind === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : connection.kind === 'openai-responses' ? 'https://api.openai.com/v1' : undefined;
  let url: URL;
  try { url = new URL(connection.baseUrl ?? fallback ?? ''); } catch { throw new Error('Configure a valid inference endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Inference endpoint must use HTTP(S), without embedded credentials, query or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}
export function endpoint(connection: AdapterConnection, suffix: string): URL {
  const url = baseURL(connection);
  if (connection.kind === 'ollama') url.pathname = url.pathname.replace(/\/(?:api|v1)$/, '');
  else url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|embeddings)$/, '');
  url.pathname = url.pathname.replace(/\/$/, '') + suffix;
  return url;
}
export function headers(connection: AdapterConnection, secret?: string): Headers {
  const result = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
  if (secret) result.set(connection.kind === 'gemini' ? 'x-goog-api-key' : 'authorization', connection.kind === 'gemini' ? secret : `Bearer ${secret}`);
  return result;
}
export function unknownQuota(): QuotaObservation { return { state: 'unknown', observedAt: new Date().toISOString(), source: 'unknown' }; }
export function quotaHeaders(headers: Headers, status?: number): QuotaObservation {
  const result = unknownQuota();
  const remaining = headers.get('x-ratelimit-remaining-requests') ?? headers.get('ratelimit-remaining');
  if (remaining !== null && /^\d+(?:\.\d+)?$/.test(remaining.trim()) && Number.isFinite(Number(remaining))) {
    result.remainingRequests = Number(remaining); result.state = result.remainingRequests === 0 ? 'limited' : 'known'; result.source = 'provider-headers';
  }
  const retry = headers.get('retry-after');
  if (retry !== null) {
    const numeric = retry.trim() ? Number(retry) : NaN;
    const ms = Number.isFinite(numeric) && numeric >= 0 ? numeric * 1000 : Date.parse(retry) - Date.now();
    if (Number.isFinite(ms)) { result.retryAfterMs = Math.max(0, ms); result.source = 'provider-headers'; }
  }
  if (status === 429) { result.state = 'limited'; result.source = 'provider-headers'; }
  return result;
}

export class AdapterError extends Error {
  readonly status?: number;
  readonly quota?: QuotaObservation;
  constructor(message: string, status?: number, quota?: QuotaObservation) { super(message); this.name = 'AdapterError'; this.status = status; this.quota = quota; }
}
export async function readJSON(response: Response, signal: AbortSignal, max = 16 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new AdapterError('Provider returned an empty body.', response.status);
  let size = 0; const chunks: Uint8Array[] = []; const reader = response.body.getReader(); let done = false;
  try {
    while (true) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) { done = true; break; } size += item.value.length; if (size > max) throw new AdapterError('Provider response exceeds the size limit.'); chunks.push(item.value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AdapterError('Provider returned malformed JSON.', response.status); }
  } finally { if (!done) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function checkedJSON(connection: AdapterConnection, suffix: string, secret: string | undefined, signal: AbortSignal, body?: unknown): Promise<{ data: unknown; quota: QuotaObservation }> {
  const response = await pinnedFetch(endpoint(connection, suffix), { method: body === undefined ? 'GET' : 'POST', headers: headers(connection, secret), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal });
  const quota = quotaHeaders(response.headers, response.status);
  if (!response.ok) { await response.body?.cancel(); throw new AdapterError(`Provider returned HTTP ${response.status}.`, response.status, quota); }
  return { data: await readJSON(response, signal), quota };
}
