/** Small, dependency-free SSE decoder. It never assumes a fetch chunk is a line. */
export interface SseEvent { event?: string; id?: string; data: string; }

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  maxEventChars = 4 * 1024 * 1024,
  maxStreamBytes = 64 * 1024 * 1024,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let eventChars = 0;
  let finished = false;
  let streamBytes = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });

  const line = (value: string): SseEvent | undefined => {
    if (value === '') {
      const result = data.length ? { event, id, data: data.join('\n') } : undefined;
      data = [];
      event = undefined;
      eventChars = 0;
      return result;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let payload = colon < 0 ? '' : value.slice(colon + 1);
    if (payload.startsWith(' ')) payload = payload.slice(1);
    if (field === 'data') {
      eventChars += payload.length + 1;
      if (eventChars > maxEventChars) throw new Error('Provider SSE event exceeds the size limit.');
      data.push(payload);
    } else if (field === 'event') event = payload;
    else if (field === 'id' && !payload.includes('\0')) id = payload;
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) { buffer += decoder.decode(); finished = true; }
      else {
        streamBytes += chunk.value.byteLength;
        if (streamBytes > maxStreamBytes) throw new Error('Provider SSE stream exceeds the size limit.');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      if (buffer.length > maxEventChars) throw new Error('Provider SSE line exceeds the size limit.');

      while (true) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (!finished && end === buffer.length - 1 && buffer[end] === '\r')) break;
        const value = buffer.slice(0, end);
        const width = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(end + width);
        const result = line(value);
        if (result) yield result;
      }
      if (finished) break;
    }
    if (buffer) {
      const result = line(buffer);
      if (result) yield result;
    }
    // A few compatible servers omit the final blank line. The protocol adapters
    // still require their own terminal event before accepting a completion.
    const tail = line('');
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
