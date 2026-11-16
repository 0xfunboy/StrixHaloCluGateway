import { createHash, randomUUID } from 'node:crypto';
import type {
  CompletionRequest, CompletionResult, HttpCompleter, Message,
  Profile, ProviderMetadata, ToolCall, Usage,
} from '../core/types.ts';
import { parseSse } from './sse.ts';
import { pinnedFetch } from './transport.ts';

type JsonObject = Record<string, unknown>;
type ErrorDetails = { status?: number; retryAfterMs?: number; remainingRequests?: number; code?: string };

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_ARGUMENT_CHARS = 2 * 1024 * 1024;
const MAX_TOOL_CALLS = 128;

/** Deliberately contains no request headers, URLs with query strings, or credentials. */
export class HttpProviderError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly remainingRequests?: number;
  readonly code?: string;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'HttpProviderError';
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.remainingRequests = details.remainingRequests;
    this.code = details.code;
  }
}

export interface HttpCompleterOptions { requestTimeoutMs?: number; }

/** Stateless HTTP transports. The caller owns credentials, history, approval, and tool execution. */
export function createHttpCompleter(options: HttpCompleterOptions = {}): HttpCompleter {
  const timeoutMs = options.requestTimeoutMs ?? 15 * 60 * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('requestTimeoutMs must be positive.');
  return {
    async complete(request) {
      request.signal.throwIfAborted();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException('Provider request timed out.', 'TimeoutError')), timeoutMs);
      timeout.unref();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      let details: ErrorDetails = {};
      try {
        const url = endpoint(request.profile);
        const messages = prepareHistory(request, url);
        const body = requestBody(request, messages, url);
        const serialized = JSON.stringify(body);
        if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw new HttpProviderError('The model request exceeds the 16 MiB limit. Reduce the conversation or attached context.');
        const headers = requestHeaders(request);
        const response = await pinnedFetch(url, { method: 'POST', headers, body: serialized, signal, redirect: 'error' });
        details = observedLimits(response.headers);
        details.status = response.status;
        if (!response.ok) {
          const raw = await readBody(response, signal, 16 * 1024, true);
          throw new HttpProviderError(`Provider returned HTTP ${response.status}: ${safeError(errorText(raw), request)}`, details);
        }
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        let result: CompletionResult;
        if (contentType.includes('text/event-stream')) {
          if (!response.body) throw new HttpProviderError('The provider returned an empty event stream.', details);
          const events = parseSse(response.body, signal);
          if (request.profile.kind === 'openai-compatible') result = await chatStream(events, request);
          else if (request.profile.kind === 'openai-responses') result = await responsesStream(events, request, url);
          else result = await geminiStream(events, request, url);
        } else if (contentType.includes('json')) {
          const raw = await readBody(response, signal, MAX_BODY_BYTES);
          const value: unknown = parseJson(raw);
          if (request.profile.kind === 'openai-compatible') result = chatJson(object(value), request);
          else if (request.profile.kind === 'openai-responses') result = responsesJson(object(value), request, url);
          else result = geminiJson(value, request, url);
        } else {
          await response.body?.cancel();
          throw new HttpProviderError('The provider returned neither JSON nor an SSE event stream. Check the endpoint URL.', details);
        }
        signal.throwIfAborted();
        if (details.remainingRequests !== undefined) result.remainingRequests = details.remainingRequests;
        return result;
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason ?? new DOMException('Cancelled.', 'AbortError');
        if (controller.signal.aborted) throw new HttpProviderError('The model request timed out. Check the server or reduce the context.', { ...details, code: 'timeout' });
        const known = error instanceof HttpProviderError ? error : undefined;
        const message = error instanceof Error ? error.message : 'The model request failed.';
        throw new HttpProviderError(safeError(message, request), {
          ...details,
          ...(known ? { status: known.status ?? details.status, retryAfterMs: known.retryAfterMs ?? details.retryAfterMs, remainingRequests: known.remainingRequests ?? details.remainingRequests, code: known.code ? safeError(known.code, request).slice(0, 256) : undefined } : {}),
        });
      } finally { clearTimeout(timeout); }
    },
  };
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function count(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new HttpProviderError('The provider returned malformed JSON.'); }
}
function newCallId(): string { return `call_${randomUUID().replaceAll('-', '')}`; }
function wireId(value: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : `call_${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}
function append(current: string, delta: string, max = MAX_TEXT_CHARS): string {
  if (current.length + delta.length > max) throw new HttpProviderError('The provider output exceeds the size limit.');
  return current + delta;
}
function safeError(value: string, request: CompletionRequest): string {
  let text = value;
  const secrets = [request.apiKey, ...Object.values(request.profile.headers ?? {})].filter((secret): secret is string => Boolean(secret));
  // Endpoint query parameters may also contain credentials. They are never recorded in metadata.
  if (request.profile.baseUrl) {
    try {
      const url = new URL(request.profile.baseUrl);
      secrets.push(...url.searchParams.values());
      if (url.password) secrets.push(url.password);
    } catch { /* Invalid URLs are handled before network access. */ }
  }
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 2000);
}
function errorText(raw: string): string {
  try {
    const parsed = object(JSON.parse(raw));
    const error = object(parsed.error);
    return string(error.message) || string(parsed.message) || string(parsed.error) || 'Request rejected.';
  } catch {
    // Never dump an HTML proxy page into a conversation or output channel.
    return raw.trimStart().startsWith('<') ? 'The endpoint returned an HTML error page.' : raw.trim() || 'Request rejected.';
  }
}
function observedLimits(headers: Headers): ErrorDetails {
  const result: ErrorDetails = {};
  const remaining = headers.get('x-ratelimit-remaining-requests') ?? headers.get('ratelimit-remaining');
  if (remaining !== null && /^\d+(?:\.\d+)?$/.test(remaining.trim())) result.remainingRequests = Number(remaining);
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const numeric = Number(retryAfter);
    if (retryAfter.trim() && Number.isFinite(numeric) && numeric >= 0) result.retryAfterMs = numeric * 1000;
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) result.retryAfterMs = Math.max(0, date - Date.now());
    }
  }
  return result;
}
async function readBody(response: Response, signal: AbortSignal, limit: number, truncate = false): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      const available = limit - size;
      if (chunk.value.length > available) {
        if (!truncate) throw new HttpProviderError('The provider response exceeds the size limit.');
        chunks.push(chunk.value.slice(0, Math.max(0, available)));
        break;
      }
      chunks.push(chunk.value);
      size += chunk.value.length;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function endpoint(profile: Profile): URL {
  if (!['openai-compatible', 'openai-responses', 'gemini'].includes(profile.kind)) throw new HttpProviderError('This profile requires its external agent runtime, not the HTTP adapter.');
  let url: URL;
  try { url = new URL(profile.baseUrl || (profile.kind === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1')); }
  catch { throw new HttpProviderError('The provider base URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpProviderError('The provider URL must use HTTP or HTTPS without embedded credentials.');
  if (!profile.model.trim()) throw new HttpProviderError('The model ID is empty.');
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  if (profile.kind === 'gemini') {
    if (path.endsWith(':streamGenerateContent')) url.pathname = path;
    else url.pathname = `${path}/models/${encodeURIComponent(profile.model.replace(/^models\//, ''))}:streamGenerateContent`;
    url.searchParams.set('alt', 'sse');
  } else {
    const suffix = profile.kind === 'openai-responses' ? '/responses' : '/chat/completions';
    url.pathname = path.endsWith(suffix) ? path : path + suffix;
  }
  return url;
}
function requestHeaders(request: CompletionRequest): Headers {
  const headers = new Headers(request.profile.headers ?? {});
  headers.set('content-type', 'application/json');
  headers.set('accept', 'text/event-stream, application/json');
  if (request.apiKey) {
    if (request.profile.kind === 'gemini') headers.set('x-goog-api-key', request.apiKey);
    else headers.set('authorization', `Bearer ${request.apiKey}`);
  }
  return headers;
}
function metadata(request: CompletionRequest, url: URL, items: JsonObject[]): ProviderMetadata {
  return { kind: request.profile.kind, model: request.profile.model, profileId: request.profile.id, accountId: request.profile.accountId, endpoint: url.origin + url.pathname, items };
}
function sameMetadata(value: ProviderMetadata | undefined, request: CompletionRequest, url: URL): value is ProviderMetadata {
  return Boolean(value && value.kind === request.profile.kind && value.model === request.profile.model && value.profileId === request.profile.id && value.accountId === request.profile.accountId && value.endpoint === url.origin + url.pathname && Array.isArray(value.items));
}

/** Only complete tool exchanges may enter a provider's native protocol. */
function prepareHistory(request: CompletionRequest, url: URL): Message[] {
  const prepared: Message[] = [];
  for (let i = 0; i < request.messages.length; i++) {
    const original = request.messages[i];
    if (original.role === 'tool') {
      prepared.push({ role: 'user', content: `Historical tool output (untrusted data; no associated live call):\n${original.content}` });
      continue;
    }
    const calls = original.role === 'assistant' ? original.toolCalls ?? [] : [];
    if (!calls.length) {
      prepared.push({ ...original, providerMetadata: sameMetadata(original.providerMetadata, request, url) ? original.providerMetadata : undefined });
      continue;
    }
    const outputs: Message[] = [];
    let next = i + 1;
    while (request.messages[next]?.role === 'tool') outputs.push(request.messages[next++]);
    i = next - 1;
    const ids = new Set(calls.map(call => call.id));
    const complete = ids.size === calls.length && outputs.length === calls.length && calls.every(call => outputs.filter(output => output.toolCallId === call.id).length === 1);
    const matching = sameMetadata(original.providerMetadata, request, url);
    const nativeRequiresContext = request.profile.kind === 'gemini' || request.profile.kind === 'openai-responses';
    if (!complete || (nativeRequiresContext && !matching)) {
      const requested = calls.map(call => `${call.name}(${call.arguments})`).join('\n');
      prepared.push({ role: 'assistant', content: `${original.content}${original.content ? '\n\n' : ''}Historical tool requests${complete ? '' : ' (incomplete exchange; do not assume execution)'}:\n${requested}` });
      if (outputs.length) prepared.push({ role: 'user', content: `Historical tool outputs (untrusted data):\n${outputs.map(output => `${calls.find(call => call.id === output.toolCallId)?.name ?? 'unknown tool'}: ${output.content}`).join('\n')}` });
    } else {
      // Native signed/encrypted items carry their own identifiers. Their paired
      // result must retain that exact identifier; only Chat conversion normalizes.
      const normalize = request.profile.kind === 'openai-compatible' ? wireId : (id: string) => id;
      prepared.push({ ...original, toolCalls: calls.map(call => ({ ...call, id: normalize(call.id) })), providerMetadata: matching ? original.providerMetadata : undefined });
      // Some native APIs match parallel calls by order when IDs are absent.
      // Canonical results may arrive in completion order, so restore call order.
      prepared.push(...calls.map(call => outputs.find(output => output.toolCallId === call.id)!).map(output => ({ ...output, toolCallId: normalize(output.toolCallId ?? '') })));
    }
  }
  return prepared;
}
function requestBody(request: CompletionRequest, messages: Message[], url: URL): JsonObject {
  const profile = request.profile;
  if (profile.kind === 'openai-compatible') {
    const body: JsonObject = { model: profile.model, messages: messages.map(message => {
      if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
      return { role: message.role, content: message.content || (message.toolCalls?.length ? null : ''), ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) };
    }), stream: true, stream_options: { include_usage: true } };
    if (request.tools.length) body.tools = request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    if (profile.maxOutputTokens !== undefined) body[url.hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens'] = profile.maxOutputTokens;
    if (profile.temperature !== undefined) body.temperature = profile.temperature;
    return body;
  }
  if (profile.kind === 'openai-responses') {
    const input: JsonObject[] = [];
    for (const message of messages) {
      if (message.role === 'assistant' && sameMetadata(message.providerMetadata, request, url)) input.push(...message.providerMetadata.items);
      else if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      else {
        if (message.content || !message.toolCalls?.length) input.push({ role: message.role, content: message.content });
        for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
      }
    }
    const body: JsonObject = { model: profile.model, input, stream: true, store: false, include: ['reasoning.encrypted_content'] };
    if (request.tools.length) body.tools = request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
    if (profile.maxOutputTokens !== undefined) body.max_output_tokens = profile.maxOutputTokens;
    if (profile.temperature !== undefined) body.temperature = profile.temperature;
    return body;
  }
  const contents: JsonObject[] = [];
  const system: string[] = [];
  const calls = new Map<string, { name: string; id?: string }>();
  for (const message of messages) {
    if (message.role === 'system') { system.push(message.content); continue; }
    const parts: JsonObject[] = [];
    if (message.role === 'tool') {
      const call = calls.get(message.toolCallId ?? '');
      if (!call) throw new HttpProviderError('A Gemini tool output has no matching function name.');
      const response: JsonObject = { result: message.content };
      try { response.result = JSON.parse(message.content); } catch { /* Tool text is valid data. */ }
      parts.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response } });
    } else if (message.role === 'assistant' && sameMetadata(message.providerMetadata, request, url)) {
      parts.push(...message.providerMetadata.items);
      const nativeCalls = parts.map(part => object(part.functionCall)).filter(call => typeof call.name === 'string');
      for (const [index, call] of (message.toolCalls ?? []).entries()) calls.set(call.id, { name: call.name, id: string(nativeCalls[index]?.id) || undefined });
    } else {
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: parseJson(call.arguments) } });
        calls.set(call.id, { name: call.name });
      }
    }
    if (!parts.length) parts.push({ text: '' });
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = contents.at(-1);
    if (previous?.role === role) (previous.parts as JsonObject[]).push(...parts);
    else contents.push({ role, parts });
  }
  const body: JsonObject = { contents };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (request.tools.length) body.tools = [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }];
  const config: JsonObject = {};
  if (profile.maxOutputTokens !== undefined) config.maxOutputTokens = profile.maxOutputTokens;
  if (profile.temperature !== undefined) config.temperature = profile.temperature;
  if (Object.keys(config).length) body.generationConfig = config;
  return body;
}

function checkedCalls(calls: ToolCall[], finishReason?: string): ToolCall[] {
  if (calls.length > MAX_TOOL_CALLS) throw new HttpProviderError('The provider returned too many tool calls in one turn.');
  if (calls.length && ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS', 'incomplete'].includes(finishReason ?? '')) throw new HttpProviderError('The model reached its output limit during a tool call. No partial call will be executed. Increase maxOutputTokens.');
  const ids = new Set<string>();
  return calls.map(call => {
    if (!call.name || call.name.length > 256) throw new HttpProviderError('The provider returned a tool call without a valid function name.');
    if (call.arguments.length > MAX_ARGUMENT_CHARS) throw new HttpProviderError('Tool arguments exceed the size limit.');
    const args = call.arguments.trim() || '{}';
    const parsed = parseJson(args);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpProviderError(`Tool ${call.name} returned arguments that are not a JSON object.`);
    const id = call.id || newCallId();
    if (ids.has(id)) throw new HttpProviderError('The provider returned duplicate tool-call identifiers.');
    ids.add(id);
    return { id, name: call.name, arguments: args };
  });
}
function chatUsage(value: unknown): Usage | undefined {
  const usage = object(value);
  const inputTokens = count(usage.prompt_tokens), outputTokens = count(usage.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return;
  return { inputTokens, outputTokens, cachedInputTokens: count(object(usage.prompt_tokens_details).cached_tokens) };
}
function responsesUsage(value: unknown): Usage | undefined {
  const usage = object(value);
  const inputTokens = count(usage.input_tokens), outputTokens = count(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return;
  return { inputTokens, outputTokens, cachedInputTokens: count(object(usage.input_tokens_details).cached_tokens) };
}
function geminiUsage(value: unknown): Usage | undefined {
  const usage = object(value);
  const inputTokens = count(usage.promptTokenCount), candidates = count(usage.candidatesTokenCount), total = count(usage.totalTokenCount);
  if (inputTokens === undefined || (candidates === undefined && total === undefined)) return;
  return { inputTokens, outputTokens: candidates !== undefined ? candidates + (count(usage.thoughtsTokenCount) ?? 0) : Math.max(0, (total ?? inputTokens) - inputTokens), cachedInputTokens: count(usage.cachedContentTokenCount) };
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  return array(value).map(part => string(object(part).text)).join('');
}
function inlineError(value: JsonObject): void {
  if (value.error) {
    const error = object(value.error);
    throw new HttpProviderError(string(error.message) || string(value.error) || 'The provider reported a stream error.', { code: string(error.code) || undefined });
  }
}

function engineTiming(value: JsonObject): NonNullable<CompletionResult['engineTiming']> {
  const timings = object(value.timings), strix = object(value.strix);
  const result: NonNullable<CompletionResult['engineTiming']> = {};
  const prefillMs = count(timings.prompt_ms ?? strix.prefill_ms);
  const prefillTokensPerSecond = count(timings.prompt_per_second ?? strix.prefill_tokens_per_second);
  const decodeTokensPerSecond = count(timings.predicted_per_second ?? strix.decode_tokens_per_second);
  if (prefillMs !== undefined) result.prefillMs = prefillMs;
  if (prefillTokensPerSecond !== undefined) result.prefillTokensPerSecond = prefillTokensPerSecond;
  if (decodeTokensPerSecond !== undefined) result.decodeTokensPerSecond = decodeTokensPerSecond;
  return result;
}

async function chatStream(events: AsyncIterable<{ data: string }>, request: CompletionRequest): Promise<CompletionResult> {
  let text = '', finishReason: string | undefined, usage: Usage | undefined, done = false;
  let timing: CompletionResult['engineTiming'] = {};
  const calls = new Map<number, ToolCall>();
  for await (const event of events) {
    if (event.data.trim() === '[DONE]') { done = true; break; }
    const chunk = object(parseJson(event.data));
    inlineError(chunk);
    usage = chatUsage(chunk.usage) ?? usage;
    timing = { ...timing, ...engineTiming(chunk) };
    const choices = array(chunk.choices).map(object);
    const choice = choices.find(item => item.index === 0) ?? (choices.length === 1 && choices[0].index === undefined ? choices[0] : undefined);
    if (!choice) continue;
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    const delta = object(choice.delta);
    const added = contentText(delta.content) || string(delta.refusal);
    if (added) { text = append(text, added); request.onText(added); }
    for (const raw of array(delta.tool_calls)) {
      const part = object(raw), fn = object(part.function), index = count(part.index);
      if (index === undefined || !Number.isInteger(index) || index >= MAX_TOOL_CALLS) throw new HttpProviderError('The provider returned an invalid tool-call index.');
      const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
      const id = string(part.id);
      if (id) {
        if (call.id && call.id !== id) throw new HttpProviderError('A streamed tool-call identifier changed unexpectedly.');
        call.id = id;
      }
      call.name = append(call.name, string(fn.name), 256);
      call.arguments = append(call.arguments, string(fn.arguments), MAX_ARGUMENT_CHARS);
      calls.set(index, call);
    }
  }
  if (!done && !finishReason) throw new HttpProviderError('The provider stream ended before a completion marker. Retry the request.');
  if (finishReason === 'content_filter') throw new HttpProviderError('The provider stopped the response because of its content filter.');
  return { text, toolCalls: checkedCalls([...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call), finishReason), usage, finishReason, engineTiming: timing };
}
function chatJson(value: JsonObject, request: CompletionRequest): CompletionResult {
  inlineError(value);
  const choice = object(array(value.choices)[0]);
  if (!Object.keys(choice).length) throw new HttpProviderError('The provider returned no completion choice.');
  const message = object(choice.message), finishReason = string(choice.finish_reason) || undefined;
  const text = contentText(message.content) || string(message.refusal);
  if (text.length > MAX_TEXT_CHARS) throw new HttpProviderError('The provider output exceeds the size limit.');
  const toolCalls = checkedCalls(array(message.tool_calls).map(raw => {
    const call = object(raw), fn = object(call.function);
    return { id: string(call.id), name: string(fn.name), arguments: string(fn.arguments) };
  }), finishReason);
  if (finishReason === 'content_filter') throw new HttpProviderError('The provider stopped the response because of its content filter.');
  if (text) request.onText(text);
  return { text, toolCalls, usage: chatUsage(value.usage), finishReason, engineTiming: engineTiming(value) };
}

function responseOutput(value: JsonObject): JsonObject[] {
  return array(value.output).map(object).filter(item => ['message', 'reasoning', 'function_call'].includes(string(item.type)));
}
function responseText(items: JsonObject[]): string {
  return items.filter(item => item.type === 'message').map(item => array(item.content).map(part => {
    const content = object(part);
    return content.type === 'output_text' ? string(content.text) : content.type === 'refusal' ? string(content.refusal) : '';
  }).join('')).join('');
}
function emitRemainder(finalText: string, streamed: string, request: CompletionRequest): void {
  if (finalText.length > MAX_TEXT_CHARS) throw new HttpProviderError('The provider output exceeds the size limit.');
  if (!finalText.startsWith(streamed)) throw new HttpProviderError('The final provider response does not match its streamed text.');
  const remainder = finalText.slice(streamed.length);
  if (remainder) request.onText(remainder);
}
function responsesJson(value: JsonObject, request: CompletionRequest, url: URL, streamed = ''): CompletionResult {
  inlineError(value);
  if (value.status === 'failed' || value.status === 'cancelled') throw new HttpProviderError(string(object(value.error).message) || `The provider response ${string(value.status)}.`);
  const output = responseOutput(value);
  const text = responseText(output);
  const status = string(value.status);
  if (status && status !== 'completed' && status !== 'incomplete') throw new HttpProviderError(`The provider returned a nonterminal response (${status}).`);
  if (!Array.isArray(value.output)) throw new HttpProviderError('The provider returned no Responses output array.');
  const finishReason = status === 'incomplete' ? string(object(value.incomplete_details).reason) || 'incomplete' : status || 'completed';
  const toolCalls = checkedCalls(output.filter(item => item.type === 'function_call').map(item => ({ id: string(item.call_id), name: string(item.name), arguments: string(item.arguments) })), status === 'incomplete' ? 'incomplete' : finishReason);
  emitRemainder(text, streamed, request);
  return { text, toolCalls, finishReason, usage: responsesUsage(value.usage), providerMetadata: metadata(request, url, output) };
}
async function responsesStream(events: AsyncIterable<{ event?: string; data: string }>, request: CompletionRequest, url: URL): Promise<CompletionResult> {
  let text = '';
  const items = new Map<number, JsonObject>();
  for await (const event of events) {
    if (event.data.trim() === '[DONE]') break;
    const chunk = object(parseJson(event.data));
    inlineError(chunk);
    const type = string(chunk.type) || event.event;
    if (type === 'error') throw new HttpProviderError(string(chunk.message) || 'The Responses API reported a stream error.', { code: string(chunk.code) || undefined });
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const delta = string(chunk.delta);
      text = append(text, delta);
      if (delta) request.onText(delta);
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const index = count(chunk.output_index);
      if (index === undefined || !Number.isInteger(index) || index >= 1024) throw new HttpProviderError('The Responses stream returned an invalid output index.');
      items.set(index, object(chunk.item));
    } else if (type === 'response.function_call_arguments.delta') {
      const index = count(chunk.output_index);
      const item = index === undefined ? undefined : items.get(index);
      if (!item || item.type !== 'function_call') throw new HttpProviderError('The Responses stream sent function arguments before their call.');
      item.arguments = append(string(item.arguments), string(chunk.delta), MAX_ARGUMENT_CHARS);
    } else if (type === 'response.function_call_arguments.done') {
      const index = count(chunk.output_index);
      const item = index === undefined ? undefined : items.get(index);
      if (item && typeof chunk.arguments === 'string') item.arguments = chunk.arguments;
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = object(chunk.response);
      if (!response.status) response.status = type === 'response.completed' ? 'completed' : 'incomplete';
      // Official servers provide the complete snapshot. The collected items also
      // support compatible implementations that only send item.done snapshots.
      if (!Array.isArray(response.output)) response.output = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      return responsesJson(response, request, url, text);
    } else if (type === 'response.failed') {
      const response = object(chunk.response);
      throw new HttpProviderError(string(object(response.error).message) || 'The Responses API failed to complete the request.');
    }
  }
  throw new HttpProviderError('The Responses stream ended before a terminal response. Retry the request.');
}

interface GeminiState { text: string; parts: JsonObject[]; calls: ToolCall[]; metadataBytes: number; usage?: Usage; finishReason?: string; }
function geminiChunk(value: JsonObject, state: GeminiState, request: CompletionRequest): void {
  inlineError(value);
  const blocked = string(object(value.promptFeedback).blockReason);
  if (blocked) throw new HttpProviderError(`Gemini blocked the prompt (${blocked}).`);
  state.usage = geminiUsage(value.usageMetadata) ?? state.usage;
  const candidates = array(value.candidates).map(object);
  const candidate = candidates.find(item => item.index === 0) ?? candidates[0];
  if (!candidate) return;
  const finishReason = string(candidate.finishReason);
  if (finishReason) state.finishReason = finishReason;
  for (const raw of array(object(candidate.content).parts)) {
    const part = object(raw);
    state.metadataBytes += Buffer.byteLength(JSON.stringify(part));
    if (state.metadataBytes > MAX_BODY_BYTES) throw new HttpProviderError('Gemini response metadata exceeds the size limit.');
    state.parts.push(part);
    const fn = object(part.functionCall);
    if (Object.keys(fn).length) {
      if (state.calls.length >= MAX_TOOL_CALLS) throw new HttpProviderError('Gemini returned too many tool calls in one turn.');
      const args = fn.args === undefined ? {} : fn.args;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new HttpProviderError('Gemini returned non-object function arguments.');
      state.calls.push({ id: string(fn.id) || newCallId(), name: string(fn.name), arguments: JSON.stringify(args) });
    }
    if (typeof part.text === 'string' && part.thought !== true) {
      state.text = append(state.text, part.text);
      if (part.text) request.onText(part.text);
    }
    if (state.parts.length > 100_000) throw new HttpProviderError('Gemini returned too many content parts.');
  }
}
function finishGemini(state: GeminiState, request: CompletionRequest, url: URL): CompletionResult {
  if (!state.finishReason) throw new HttpProviderError('The Gemini response ended before a finish reason. Retry the request.');
  if (!['STOP', 'MAX_TOKENS'].includes(state.finishReason)) throw new HttpProviderError(`Gemini stopped the response (${state.finishReason}).`);
  if (Buffer.byteLength(JSON.stringify(state.parts)) > MAX_BODY_BYTES) throw new HttpProviderError('Gemini response metadata exceeds the size limit.');
  return { text: state.text, toolCalls: checkedCalls(state.calls, state.finishReason), usage: state.usage, finishReason: state.finishReason, providerMetadata: metadata(request, url, state.parts) };
}
function geminiJson(value: unknown, request: CompletionRequest, url: URL): CompletionResult {
  const state: GeminiState = { text: '', parts: [], calls: [], metadataBytes: 0 };
  for (const chunk of Array.isArray(value) ? value : [value]) geminiChunk(object(chunk), state, request);
  return finishGemini(state, request, url);
}
async function geminiStream(events: AsyncIterable<{ data: string }>, request: CompletionRequest, url: URL): Promise<CompletionResult> {
  const state: GeminiState = { text: '', parts: [], calls: [], metadataBytes: 0 };
  for await (const event of events) {
    if (event.data.trim() === '[DONE]') break;
    geminiChunk(object(parseJson(event.data)), state, request);
  }
  return finishGemini(state, request, url);
}
