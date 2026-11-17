import { performance } from 'node:perf_hooks';
import { enrichOllamaModels } from './ollama-info.ts';
import { createHttpCompleter, HttpProviderError } from './vendor/providers/http.ts';
import type { Profile } from './vendor/core/types.ts';
import { completeOllama } from './ollama.ts';
import { AdapterError, baseURL, checkedJSON, cleanLabel, count, endpoint, headers, integer, pinnedFetch, quotaHeaders, readJSON, record, unknownQuota } from './http-utils.ts';
import type { AdapterConnection, DiscoveryResult, DiscoveredModel, EmbedRequest, EmbeddingResult, InferenceMetrics, InferenceRequest, InferenceResult, ModelSelection, QuotaObservation } from './types.ts';

export { AdapterError } from './http-utils.ts';
export function profile(connection: AdapterConnection, model: ModelSelection): Profile {
  const kind = connection.kind === 'cluster' || connection.kind === 'gemrouter' ? 'openai-compatible' : connection.kind;
  if (kind === 'ollama') throw new Error('Ollama uses its native adapter.');
  return { id: connection.id, name: connection.label, kind, accountId: connection.accountId ?? connection.id, model: model.id,
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}), ...(connection.command ? { command: connection.command } : {}),
    ...(connection.args ? { args: connection.args } : {}), ...(connection.env ? { env: connection.env } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}), ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}) };
}
export function baseMetrics(started: number, first: number | undefined, model: ModelSelection): InferenceMetrics {
  return { totalMs: performance.now() - started, ...(first !== undefined ? { ttftMs: first - started } : {}),
    ...(model.contextWindow ? { contextLimit: model.contextWindow } : {}),
    sources: { usage: 'unknown', ttft: 'gateway', prefill: 'unknown', decode: 'unknown', context: model.contextWindow ? 'configured' : 'unknown' } };
}
export function addUsageMetrics(metrics: InferenceMetrics, usage: InferenceResult['usage']): void {
  if (!usage) return;
  metrics.contextUsed = usage.inputTokens + usage.outputTokens;
  if (metrics.contextLimit !== undefined) metrics.contextRemaining = Math.max(0, metrics.contextLimit - metrics.contextUsed);
}

/** One model invocation only. Scheduling/retries/tool execution belong to the orchestrator. */
export async function complete(request: InferenceRequest): Promise<InferenceResult> {
  if (request.connection.kind === 'ollama') return completeOllama(request);
  if (['codex', 'antigravity'].includes(request.connection.kind)) throw new AdapterError('Use runNativeAgent for an official coding-agent runtime.');
  baseURL(request.connection); // Reject query credentials before the shared transport.
  request.signal.throwIfAborted();
  const started = performance.now(); let first: number | undefined;
  try {
    const result = await createHttpCompleter({ requestTimeoutMs: request.timeoutMs ?? 15 * 60_000 }).complete({ profile: profile(request.connection, request.model), apiKey: request.secret,
      messages: request.messages, tools: request.tools ?? [], signal: request.signal,
      onText: text => { first ??= performance.now(); request.onText(text); } });
    const metrics = baseMetrics(started, first, request.model);
    addUsageMetrics(metrics, result.usage); if (result.usage) metrics.sources.usage = 'provider';
    if (result.engineTiming) {
      Object.assign(metrics, result.engineTiming);
      if (metrics.prefillMs !== undefined || metrics.prefillTokensPerSecond !== undefined) metrics.sources.prefill = 'engine';
      if (metrics.decodeTokensPerSecond !== undefined) metrics.sources.decode = 'engine';
    }
    const quota = unknownQuota();
    if (result.remainingRequests !== undefined) Object.assign(quota, { state: result.remainingRequests === 0 ? 'limited' : 'known', source: 'provider-headers', remainingRequests: result.remainingRequests });
    return { text: result.text, toolCalls: result.toolCalls, usage: result.usage, finishReason: result.finishReason, providerMetadata: result.providerMetadata, metrics, quota };
  } catch (error) {
    request.signal.throwIfAborted();
    if (error instanceof HttpProviderError) {
      const quota: QuotaObservation = { state: error.status === 429 ? 'limited' : 'unknown', source: error.status === 429 || error.remainingRequests !== undefined ? 'provider-headers' : 'unknown', observedAt: new Date().toISOString(), ...(error.remainingRequests !== undefined ? { remainingRequests: error.remainingRequests } : {}), ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
      throw new AdapterError(error.message, error.status, quota);
    }
    throw error;
  }
}

export async function discoverModels(connection: AdapterConnection, secret?: string, providedSignal?: AbortSignal, options: { metadata?: boolean } = {}): Promise<DiscoveryResult> {
  if (['codex', 'antigravity'].includes(connection.kind)) throw new AdapterError('Use inspectNative for official CLI model discovery.');
  const signal = providedSignal ? AbortSignal.any([providedSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const models = new Map<string, DiscoveredModel>(); let quota = unknownQuota(); const warnings: string[] = [];
  let pageToken: string | undefined; const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const url = endpoint(connection, connection.kind === 'ollama' ? '/api/tags' : '/models');
    if (connection.kind === 'gemini') { url.searchParams.set('pageSize', '1000'); if (pageToken) url.searchParams.set('pageToken', pageToken); }
    const response = await pinnedFetch(url, { headers: headers(connection, secret), signal }); quota = quotaHeaders(response.headers, response.status);
    if (!response.ok) { await response.body?.cancel(); throw new AdapterError(`Model discovery returned HTTP ${response.status}.`, response.status, quota); }
    const data = record(await readJSON(response, signal));
    const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    for (const item of rows.slice(0, 2000)) {
      const row = record(item);
      let id = cleanLabel(row.id ?? row.model ?? row.name);
      if (connection.kind === 'gemini') id = id.replace(/^models\//, '');
      if (!id || models.has(id)) continue;
      const advertised = Array.isArray(row.capabilities) ? row.capabilities : [];
      const methods = Array.isArray(row.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
      const capabilities: DiscoveredModel['capabilities'] = [];
      if (advertised.includes('completion') || advertised.includes('chat') || methods.includes('generateContent')) capabilities.push('chat');
      if (advertised.includes('tools')) capabilities.push('tools');
      if (advertised.includes('embedding') || methods.includes('embedContent') || methods.includes('batchEmbedContents')) capabilities.push('embedding');
      if (advertised.includes('vision')) capabilities.push('vision');
      const contextWindow = integer(row.context_window ?? row.context_length ?? row.inputTokenLimit ?? row.max_context_length);
      models.set(id, { id, label: cleanLabel(row.displayName ?? row.name ?? row.id, id), ...(contextWindow ? { contextWindow } : {}), capabilities, capabilitySource: advertised.length || methods.length ? 'provider' : 'unknown' });
    }
    pageToken = connection.kind === 'gemini' && typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined;
    if (!pageToken || cursors.has(pageToken)) break;
    cursors.add(pageToken); if (page === 19) warnings.push('The model catalog exceeded the 20-page discovery limit.');
  }
  const discovered = [...models.values()];
  if (connection.kind === 'ollama' && options.metadata !== false) warnings.push(...await enrichOllamaModels(connection, discovered, secret, signal));
  return { models: discovered, quota, warnings };
}

/** Dense vectors come only from a configured embedding model, never hashes of text. */
export async function embed(request: EmbedRequest): Promise<EmbeddingResult> {
  if (!['ollama', 'cluster', 'gemrouter', 'openai-compatible', 'openai-responses'].includes(request.connection.kind)) throw new AdapterError('This connection has no embedding adapter. Select an Ollama or OpenAI-compatible embedding model.');
  if (!request.model || request.model.length > 300 || !Array.isArray(request.texts) || request.texts.length < 1 || request.texts.length > 128 || request.texts.some(text => typeof text !== 'string' || text.length > 500_000) || Buffer.byteLength(JSON.stringify(request.texts)) > 4 * 1024 * 1024) throw new AdapterError('Invalid or oversized embedding batch.');
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
  const ollama = request.connection.kind === 'ollama';
  const { data } = await checkedJSON(request.connection, ollama ? '/api/embed' : '/embeddings', request.secret, signal,
    { model: request.model, input: request.texts, ...(ollama ? { truncate: false } : { encoding_format: 'float' }) });
  const raw = record(data); let vectors: unknown[];
  if (ollama) vectors = Array.isArray(raw.embeddings) ? raw.embeddings : [];
  else {
    const rows = Array.isArray(raw.data) ? raw.data.map(record) : [];
    if (rows.length !== request.texts.length || rows.some(row => integer(row.index) === undefined) || new Set(rows.map(row => row.index)).size !== rows.length || rows.some(row => Number(row.index) >= rows.length)) throw new AdapterError('Embedding response has invalid input indices.');
    vectors = rows.sort((a, b) => Number(a.index) - Number(b.index)).map(row => row.embedding);
  }
  const dimensions = Array.isArray(vectors[0]) ? vectors[0].length : 0;
  if (vectors.length !== request.texts.length || dimensions < 1 || dimensions > 65_536 || vectors.some(vector => !Array.isArray(vector) || vector.length !== dimensions || vector.some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw new AdapterError('Embedding response has invalid dimensions or non-finite values.');
  const usage = record(raw.usage); const inputTokens = integer(ollama ? raw.prompt_eval_count : usage.prompt_tokens ?? usage.total_tokens);
  return { model: cleanLabel(raw.model, request.model), dimensions, vectors: vectors as number[][], ...(inputTokens !== undefined ? { inputTokens } : {}) };
}
