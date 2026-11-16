import type { RunEvent } from '../src/contracts.ts';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  constructor(message: string, status: number, code = 'request_failed') { super(message); this.status = status; this.code = code; }
}

export interface ClientApi {
  readonly native: boolean;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  subscribe(onEvent: (event: RunEvent) => void, onState?: (connected: boolean) => void): () => void;
  configure?(): void;
  attachSelection?(): void;
  openAuth?(url: string): void;
  saveFile?(name: string, content: string, mime?: string): Promise<void>;
  onSelection?(handler: (selection: { name: string; content: string }) => void): () => void;
  onConfigured?(handler: () => void): () => void;
  dispose?(): void;
}

type VsCodeHandle = { postMessage(message: unknown): void };
type NativeWindow = Window & { acquireVsCodeApi?: () => VsCodeHandle };

export function createApi(win: Window = window): ClientApi {
  const nativeWindow = win as NativeWindow;
  if (typeof nativeWindow.acquireVsCodeApi === 'function') return createNativeApi(win, nativeWindow.acquireVsCodeApi());
  return createBrowserApi(win);
}

export function createBrowserApi(win: Window): ClientApi {
  return {
    native: false,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      assertApiPath(path);
      const response = await win.fetch(path, { method, credentials: 'same-origin', redirect: 'error',
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : `Richiesta non riuscita (${response.status}).`, response.status,
        typeof data.code === 'string' ? data.code : undefined);
      return data as T;
    },
    subscribe(onEvent, onState) {
      let lastEventId = 0;
      let closed = false;
      const source = new (win as Window & { EventSource: typeof EventSource }).EventSource('/api/events');
      source.onopen = () => onState?.(true);
      source.onerror = () => { if (!closed) onState?.(false); };
      source.onmessage = event => {
        try {
          const parsed = JSON.parse(event.data) as RunEvent;
          if (!parsed || typeof parsed.type !== 'string' || !Number.isSafeInteger(parsed.id)) return;
          if (parsed.id <= lastEventId && parsed.id !== 0) return;
          if (parsed.id > 0) lastEventId = parsed.id;
          onEvent(parsed);
        } catch { /* Invalid data cannot become UI markup or commands. */ }
      };
      return () => { closed = true; source.close(); };
    },
  };
}

export function createNativeApi(win: Window, host: VsCodeHandle): ClientApi {
  let sequence = 0;
  const requests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  const events = new Set<(event: RunEvent) => void>();
  const selections = new Set<(selection: { name: string; content: string }) => void>();
  const configured = new Set<() => void>();
  const states = new Set<(connected: boolean) => void>();
  let saving: { resolve: () => void; reject: (error: Error) => void } | undefined;
  const listener = (message: MessageEvent) => {
    const value = message.data;
    if (!value || typeof value !== 'object') return;
    if (value.type === 'api.result' && typeof value.id === 'string') {
      const pending = requests.get(value.id); if (!pending) return;
      requests.delete(value.id); clearTimeout(pending.timeout);
      if (value.ok) pending.resolve(value.data);
      else pending.reject(new ApiError(value.data?.error ?? value.error ?? 'Richiesta non riuscita.', Number(value.status) || 500, value.data?.code));
    } else if (value.type === 'event' && value.event && typeof value.event.type === 'string') {
      for (const handler of events) handler(value.event as RunEvent);
      for (const handler of states) handler(true);
    } else if (value.type === 'configured') {
      for (const handler of configured) handler();
    } else if (value.type === 'selection' && typeof value.name === 'string' && typeof value.content === 'string') {
      for (const handler of selections) handler({ name: value.name, content: value.content });
    } else if (value.type === 'connection' && typeof value.connected === 'boolean') {
      for (const handler of states) handler(value.connected);
    } else if (value.type === 'savedFile' && saving) {
      const pending = saving; saving = undefined;
      if (value.ok) pending.resolve(); else pending.reject(new Error(value.error ?? 'Esportazione non riuscita.'));
    }
  };
  win.addEventListener('message', listener);
  return {
    native: true,
    request<T>(method: string, path: string, body?: unknown): Promise<T> {
      assertApiPath(path);
      const id = `ui-${++sequence}`;
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => { requests.delete(id); reject(new ApiError('Il server non ha risposto in tempo. Verifica lo stato prima di ripetere un’operazione.', 504, 'timeout')); }, 120_000);
        requests.set(id, { resolve: value => resolve(value as T), reject, timeout });
        host.postMessage({ type: 'api', id, method, path, ...(body === undefined ? {} : { body }) });
      });
    },
    subscribe(onEvent, onState) {
      events.add(onEvent); if (onState) states.add(onState);
      host.postMessage({ type: 'subscribe' });
      return () => { events.delete(onEvent); if (onState) states.delete(onState); if (!events.size) host.postMessage({ type: 'unsubscribe' }); };
    },
    configure: () => host.postMessage({ type: 'configure' }),
    attachSelection: () => host.postMessage({ type: 'attachSelection' }),
    openAuth: url => host.postMessage({ type: 'openAuth', url }),
    saveFile(name, content, mime) {
      if (saving) return Promise.reject(new Error('Completa prima l’esportazione in corso.'));
      return new Promise<void>((resolve, reject) => { saving = { resolve, reject }; host.postMessage({ type: 'saveFile', name, content, mime }); });
    },
    onSelection(handler) { selections.add(handler); return () => selections.delete(handler); },
    onConfigured(handler) { configured.add(handler); return () => configured.delete(handler); },
    dispose() {
      win.removeEventListener('message', listener);
      for (const request of requests.values()) { clearTimeout(request.timeout); request.reject(new ApiError('La vista è stata chiusa.', 499, 'closed')); }
      requests.clear(); events.clear(); selections.clear(); states.clear(); configured.clear();
      saving?.reject(new Error('La vista è stata chiusa.')); saving = undefined;
      host.postMessage({ type: 'unsubscribe' });
    },
  };
}

function assertApiPath(path: string): void {
  if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('\\') || /[\u0000-\u001f]/.test(path)) throw new Error('Percorso API non valido.');
}
