import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/server.ts';
import { defaultConfig } from '../src/config.ts';
import { mountApp } from '../web/app.ts';
import { createBrowserApi } from '../web/api.ts';
import type { Project, Conversation, ModelRoute, Account, Provider } from '../src/contracts.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
async function eventually(predicate: () => boolean, description: string): Promise<void> {
  const until = Date.now() + 7000;
  while (!predicate()) { if (Date.now() > until) throw new Error(description); await new Promise(resolve => setTimeout(resolve, 15)); }
}

/** JSDOM supplies DOM; requests, cookies and SSE reach the real server on loopback. */
async function realUi(t: test.TestContext, role: 'admin' | 'member' = 'member') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yed1z-web-http-'));
  const config = defaultConfig(); config.port = 0; config.telemetryIntervalMs = 300000;
  config.providers = [{ id: 'fixture', label: 'Inference fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', nodeIds: [], resourceGroupIds: [], enabled: true, models: [{ model: 'fixture-chat', label: 'Fixture chat', capabilities: ['chat'] }] }];
  const app = new Application({ directory, config, complete: async request => { request.onText('Risposta dalla fixture HTTP'); return { text: 'Risposta dalla fixture HTTP', toolCalls: [], usage: { inputTokens: 5, outputTokens: 4 }, metrics: { totalMs: 12, sources: { usage: 'provider', ttft: 'gateway', prefill: 'unknown', decode: 'unknown', context: 'unknown' } }, quota: { state: 'unknown', source: 'unknown', observedAt: new Date().toISOString() } }; } });
  const administrator = app.store.createUser('Operatore', 'admin'); app.catalog.seed(administrator.user);
  const identity = role === 'admin' ? administrator : app.store.createUser('Utente web', 'member');
  const port = await app.listen(); const origin = `http://127.0.0.1:${port}`;
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: origin, pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  let cookie = '';
  const requests: Array<{ method: string; path: string; status: number; body?: any }> = [];
  dom.window.fetch = async (relative: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers); if (cookie) headers.set('Cookie', cookie); if (options.method && options.method !== 'GET') headers.set('Origin', origin);
    const response = await fetch(origin + relative, { ...options, headers }); const session = response.headers.get('set-cookie'); if (session) cookie = session.split(';')[0]!;
    requests.push({ method: options.method ?? 'GET', path: relative, status: response.status, body: options.body ? JSON.parse(String(options.body)) : undefined }); return response;
  };
  dom.window.EventSource = class {
    onopen?: () => void; onerror?: () => void; onmessage?: (event: { data: string }) => void;
    controller = new AbortController();
    constructor(relative: string) { void this.read(relative); }
    async read(relative: string) {
      try { const response = await fetch(origin + relative, { headers: { Cookie: cookie }, signal: this.controller.signal }); if (!response.ok || !response.body) throw new Error('SSE failed'); this.onopen?.(); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; for (;;) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let end; while ((end = buffer.indexOf('\n\n')) !== -1) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'); if (data) this.onmessage?.({ data }); } } }
      catch { if (!this.controller.signal.aborted) this.onerror?.(); }
    }
    close() { this.controller.abort(); }
  };
  const root = dom.window.document.getElementById('root')!; const client = mountApp(root, createBrowserApi(dom.window as unknown as Window)); await client.ready;
  t.after(async () => { client.dispose(); dom.window.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const button = (text: string, parent: ParentNode = root) => { const result = Array.from(parent.querySelectorAll('button')).find(element => element.textContent?.trim() === text) as HTMLButtonElement | undefined; assert.ok(result, text); return result; };
  const submit = (form: HTMLFormElement) => form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  if (!root.querySelector('dialog')) root.querySelector<HTMLButtonElement>('#guest-login-btn')!.click();
  const login = root.querySelector<HTMLInputElement>('dialog input[type="password"]')!; assert.ok(login); login.value = identity.token; submit(root.querySelector('dialog form')!); await eventually(() => !root.querySelector('dialog'), 'Login UI failed'); await client.ready;
  return { app, root, dom, client, button, submit, identity, requests, origin };
}

test('web reale: login cookie, progetto member, memoria e conversazione attraversano API/SSE/SQLite', async t => {
  const f = await realUi(t, 'member');
  f.root.querySelector<HTMLButtonElement>('#new-project')!.click();
  const projectDialog = f.root.querySelector('dialog')!; projectDialog.querySelector<HTMLInputElement>('input[type="text"]')!.value = 'Progetto dall’interfaccia'; f.submit(projectDialog.querySelector('form')!);
  await eventually(() => !f.root.querySelector('dialog'), 'Project creation UI failed');
  const project = f.app.store.all<Project>('project')[0]!; assert.equal(project.ownerId, f.identity.user.id); assert.equal(project.targetId, undefined);
  const projectRequest = f.requests.find(item => item.path === '/api/projects')!; assert.equal(projectRequest.status, 201); assert.equal('workspace' in projectRequest.body, false);
  f.root.querySelector<HTMLButtonElement>('[data-view="knowledge"]')!.click(); f.button('Aggiungi conoscenza').click();
  const memoryDialog = f.root.querySelector('dialog')!; memoryDialog.querySelector<HTMLInputElement>('input[type="text"]')!.value = 'Metodo corretto'; memoryDialog.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Prima il test, poi la modifica.'; f.submit(memoryDialog.querySelector('form')!);
  await eventually(() => !f.root.querySelector('dialog'), 'Memory creation failed'); await f.client.refresh();
  f.button('Approva per il contesto').click(); await eventually(() => f.app.store.all<{ status: string }>('memory')[0]?.status === 'approved', 'Memory approval failed');
  f.root.querySelector<HTMLButtonElement>('[data-view="control"]')!.click();
  const input = f.root.querySelector<HTMLTextAreaElement>('#message-input')!; input.value = 'Ciao, applica il nostro metodo.'; input.dispatchEvent(new f.dom.window.Event('input')); f.submit(f.root.querySelector('#composer')!);
  await eventually(() => f.app.store.all<Conversation>('conversation')[0]?.messages.some(message => message.role === 'assistant' && message.status === 'complete') === true, 'Chat completion failed');
  await f.client.refresh(); assert.match(f.root.querySelector('#messages')!.textContent!, /Risposta dalla fixture HTTP/);
  f.root.querySelector<HTMLButtonElement>('#context-info')!.click(); assert.match(f.root.querySelector('dialog')!.textContent!, /Metodo corretto/);
  const request = f.requests.find(item => item.path.endsWith('/messages'))!; assert.equal(request.status, 202); assert.equal(request.body.mode, 'chat');
  assert.equal(f.root.querySelector<HTMLSelectElement>('#mode-select')!.value, 'chat'); assert.equal(f.root.querySelector<HTMLButtonElement>('#mission-settings')!.disabled, true);
  assert.ok(f.requests.every(item => item.status < 400 || item.path === '/api/bootstrap'));
});

test('web reale: preset GemRouter crea provider/account e scopre modelli tramite un vero upstream HTTP', async t => {
  let authorization: string | undefined;
  const upstream = createServer((req, res) => { authorization = req.headers.authorization; assert.equal(req.url, '/v1/models'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'gemini-fixture', name: 'Gemini fixture', capabilities: ['chat', 'tools'] }] })); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const f = await realUi(t, 'admin');
  f.root.querySelector<HTMLButtonElement>('[data-view="connections"]')!.click(); f.button('Collega un account').click();
  const dialog = f.root.querySelector('dialog')!; const service = dialog.querySelector<HTMLSelectElement>('select')!; service.value = 'gemrouter'; service.dispatchEvent(new f.dom.window.Event('change'));
  dialog.querySelector<HTMLInputElement>('input[type="url"]')!.value = `http://127.0.0.1:${address.port}/v1`;
  const label = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="text"]')).find(item => item.placeholder.startsWith('Personale'))!; label.value = 'Account fixture';
  dialog.querySelector<HTMLInputElement>('input[type="password"]')!.value = 'fixture-upstream-key'; f.submit(dialog.querySelector('form')!);
  await eventually(() => !!f.root.querySelector('[data-connected-model]'), 'Provider form failed: ' + f.root.querySelector('.form-error')?.textContent);
  f.button('Fatto, torna al progetto').click(); await eventually(() => !f.root.querySelector('dialog'), 'Provider setup completion failed');
  assert.equal(authorization, 'Bearer fixture-upstream-key'); const provider = f.app.store.all<Provider>('provider').find(item => item.tag === 'gemrouter')!; assert.ok(provider);
  const account = f.app.store.all<Account>('account').find(item => item.providerId === provider.id)!; assert.equal(account.label, 'Account fixture'); assert.equal(account.hasSecret, true);
  const model = f.app.store.all<ModelRoute>('model').find(item => item.providerId === provider.id)!; assert.equal(model.model, 'gemini-fixture'); assert.equal(model.capabilities.includes('tools'), true);
  await f.client.refresh(); assert.doesNotMatch(JSON.stringify(f.app.bootstrap(f.identity.user)), /fixture-upstream-key/); assert.doesNotMatch(f.root.textContent!, /fixture-upstream-key/);
  f.button(model.label).click(); const modelDialog = f.root.querySelector('dialog')!; const embedding = modelDialog.querySelector<HTMLInputElement>('input[value="embedding"]') ?? Array.from(modelDialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(item => item.value === 'embedding')!; embedding.checked = true; f.submit(modelDialog.querySelector('form')!);
  await eventually(() => !f.root.querySelector('dialog'), 'Capability update failed'); assert.ok(f.app.store.require<ModelRoute>('model', model.id).capabilities.includes('embedding'));
});
