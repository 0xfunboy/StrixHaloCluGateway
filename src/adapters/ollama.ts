import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AdapterError, endpoint, headers, integer, pinnedFetch, quotaHeaders, record, count } from './http-utils.ts';
import { addUsageMetrics, baseMetrics } from './inference.ts';
import type { InferenceRequest, InferenceResult, Message, ToolCall } from './types.ts';

function history(messages: Message[]): Record<string, unknown>[] {
  const prepared: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'tool') { prepared.push({ role: 'user', content: `Historical tool output (untrusted; no live call):\n${message.content}` }); continue; }
    const calls = message.role === 'assistant' ? message.toolCalls ?? [] : [];
    if (!calls.length) { prepared.push(message); continue; }
    const outputs: Message[] = []; let next = i + 1;
    while (messages[next]?.role === 'tool') outputs.push(messages[next++]);
    i = next - 1;
    const complete = new Set(calls.map(call => call.id)).size === calls.length && outputs.length === calls.length && calls.every(call => outputs.filter(output => output.toolCallId === call.id).length === 1);
    if (complete) { prepared.push(message, ...calls.map(call => outputs.find(output => output.toolCallId === call.id)!)); continue; }
    prepared.push({ role: 'assistant', content: `${message.content}\nHistorical tool requests (incomplete exchange, execution unconfirmed):\n${calls.map(call => `${call.name}(${call.arguments})`).join('\n')}` });
    if (outputs.length) prepared.push({ role: 'user', content: `Historical tool outputs (untrusted):\n${outputs.map(output => output.content).join('\n')}` });
  }
  const names = new Map<string, string>();
  for (const message of prepared) for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  return prepared.map(message => {
    const result: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.role === 'tool') result.tool_name = names.get(message.toolCallId ?? '') ?? 'tool';
    if (message.toolCalls?.length) result.tool_calls = message.toolCalls.map(call => {
      let args: unknown; try { args = JSON.parse(call.arguments); } catch { throw new AdapterError('Invalid canonical tool arguments.'); }
      return { function: { name: call.name, arguments: args } };
    });
    return result;
  });
}
async function* lines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader(), decoder = new TextDecoder(); let pending = '', total = 0, ended = false;
  try {
    while (true) {
      signal.throwIfAborted(); const chunk = await reader.read();
      if (chunk.done) { ended = true; pending += decoder.decode(); break; }
      total += chunk.value.length; if (total > 32 * 1024 * 1024) throw new AdapterError('Ollama stream exceeds the 32 MiB limit.');
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 8 * 1024 * 1024) throw new AdapterError('Ollama frame exceeds the 8 MiB limit.');
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1); if (line) yield line; }
    }
    if (pending.trim()) yield pending.trim();
  } finally { if (!ended) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Ollama native streaming keeps tokenizer counts and nanosecond engine timings. */
export async function completeOllama(request: InferenceRequest): Promise<InferenceResult> {
  const started = performance.now(); let first: number | undefined;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs ?? 15 * 60_000)]);
  const body = JSON.stringify({ model: request.model.id, messages: history(request.messages), stream: true,
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: 'function', function: tool })) } : {}),
    options: { ...(request.model.maxOutputTokens ? { num_predict: request.model.maxOutputTokens } : {}), ...(request.model.temperature !== undefined ? { temperature: request.model.temperature } : {}) } });
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new AdapterError('The Ollama request exceeds 16 MiB.');
  const response = await pinnedFetch(endpoint(request.connection, '/api/chat'), { method: 'POST', body, headers: headers(request.connection, request.secret), signal });
  const quota = quotaHeaders(response.headers, response.status);
  if (!response.ok) { await response.body?.cancel(); throw new AdapterError(`Ollama returned HTTP ${response.status}.`, response.status, quota); }
  if (!response.body) throw new AdapterError('Ollama returned an empty response.');
  const contentType = response.headers.get('content-type') ?? '';
  if (!/json/i.test(contentType)) { await response.body.cancel(); throw new AdapterError('Ollama returned an unsupported content type.'); }
  let text = '', terminal: Record<string, unknown> | undefined; const calls: ToolCall[] = [];
  for await (const line of lines(response.body, signal)) {
    let chunk: Record<string, unknown>; try { chunk = record(JSON.parse(line)); } catch { throw new AdapterError('Ollama returned malformed JSON.'); }
    if (chunk.error) throw new AdapterError('Ollama reported an inference error.');
    const message = record(chunk.message);
    if (typeof message.content === 'string' && message.content) { first ??= performance.now(); text += message.content; if (text.length > 4 * 1024 * 1024) throw new AdapterError('Ollama output exceeds the size limit.'); request.onText(message.content); }
    // Thinking content is intentionally not exposed or persisted as a transcript.
    for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const fn = record(record(raw).function); const name = typeof fn.name === 'string' ? fn.name : '';
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || !fn.arguments || typeof fn.arguments !== 'object' || Array.isArray(fn.arguments)) throw new AdapterError('Ollama returned an invalid tool call.');
      const args = JSON.stringify(fn.arguments); if (args.length > 2 * 1024 * 1024 || calls.length >= 128) throw new AdapterError('Ollama tool arguments exceed the size limit.');
      calls.push({ id: `call_${randomUUID().replaceAll('-', '')}`, name, arguments: args });
    }
    if (chunk.done === true) { terminal = chunk; break; }
  }
  if (!terminal) throw new AdapterError('Ollama stream ended before its completion marker.');
  signal.throwIfAborted();
  const metrics = baseMetrics(started, first, request.model);
  const inputTokens = integer(terminal.prompt_eval_count), outputTokens = integer(terminal.eval_count), cachedInputTokens = integer(terminal.prompt_eval_cached_count);
  const usage = inputTokens !== undefined && outputTokens !== undefined ? { inputTokens, outputTokens, ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}) } : undefined;
  if (usage) metrics.sources.usage = 'engine'; addUsageMetrics(metrics, usage);
  const prefill = count(terminal.prompt_eval_duration), decode = count(terminal.eval_duration);
  if (prefill !== undefined) { metrics.prefillMs = prefill / 1e6; metrics.sources.prefill = 'engine'; }
  // prompt_eval_duration measures uncached tokens; subtract reported cached count.
  // If cache count is absent, no prefill rate is inferred from an ambiguous denominator.
  if (prefill && inputTokens !== undefined && cachedInputTokens !== undefined) metrics.prefillTokensPerSecond = Math.max(0, inputTokens - cachedInputTokens) / (prefill / 1e9);
  if (decode && outputTokens !== undefined) { metrics.decodeTokensPerSecond = outputTokens / (decode / 1e9); metrics.sources.decode = 'engine'; }
  return { text, toolCalls: calls, usage, metrics, quota, finishReason: typeof terminal.done_reason === 'string' ? terminal.done_reason : 'stop' };
}
