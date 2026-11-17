import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mountApp } from '../web/app.ts';
import { ApiError, createNativeApi, createBrowserApi, type ClientApi } from '../web/api.ts';
import { renderMarkdown } from '../web/markdown.ts';
import type { Bootstrap, RunEvent, Run, Conversation, ModelRoute, Artifact } from '../src/contracts.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const now = new Date().toISOString();

export function fixture(): Bootstrap {
  const models: ModelRoute[] = [
    { id: 'qwen', providerId: 'cluster', accountId: 'local', label: 'Qwen · Dual Strix', model: 'qwen-coder', nodeIds: ['strix01', 'strix02'], resourceGroupIds: ['dual'], contextWindow: 32768, capabilities: ['chat', 'tools'], enabled: true },
    { id: 'remote', providerId: 'gemrouter', accountId: 'work', label: 'Gemini · GemRouter', model: 'gemini-test', nodeIds: [], resourceGroupIds: [], contextWindow: 100000, capabilities: ['chat', 'tools'], enabled: true },
  ];
  const conversation: Conversation = { id: 'c1', projectId: 'p1', ownerId: 'u1', title: 'Portale distribuito', routeId: 'qwen', createdAt: now, updatedAt: now, messages: [{ id: 'm1', role: 'user', text: 'Questo è il contesto da mantenere.', createdAt: now }, { id: 'm2', role: 'assistant', text: 'Pronto. <img src=x onerror=alert(1)>', createdAt: now, routeId: 'qwen', metrics: { inputTokens: 0, outputTokens: 15, decodeTokensPerSecond: 22.3, ttftMs: 432, source: 'fixture' } }] };
  return {
    version: '0.3.0', user: { id: 'u1', name: 'Funboy', role: 'admin', createdAt: now }, demo: true,
    projects: [{ id: 'p1', ownerId: 'u1', memberIds: [], name: 'yed1z', description: 'Il portale distribuito', routes: { primary: 'qwen', reviewer: 'remote' }, targetId: 'coordinator', workspace: 'project', verifyRecipeIds: ['test'], deploymentRecipeId: 'deploy', createdAt: now, updatedAt: now }],
    conversations: [conversation],
    providers: [{ id: 'cluster', ownerId: 'u1', label: 'Dual Strix', kind: 'openai-compatible', baseUrl: 'http://cluster.test/v1', nodeIds: ['strix01', 'strix02'], resourceGroupIds: ['dual'], enabled: true, createdAt: now, tag: 'cluster' }, { id: 'gemrouter', ownerId: 'u1', label: 'GemRouter', kind: 'openai-compatible', baseUrl: 'http://gemrouter.test/v1', nodeIds: [], resourceGroupIds: [], enabled: true, createdAt: now, tag: 'gemrouter' }],
    accounts: [{ id: 'local', providerId: 'cluster', ownerId: 'u1', label: 'Cluster condiviso', shared: true, status: 'ready', hasSecret: false }, { id: 'work', providerId: 'gemrouter', ownerId: 'u1', label: 'Lavoro', shared: false, status: 'ready', hasSecret: true, quota: { source: 'provider', observedAt: now, remainingRequests: 0 } }], models,
    nodes: [{ id: 'strix01', label: '01-EVO-X3', kind: 'strix', host: '01-evo-x3', capabilities: ['inferenza', 'coordinator'] }, { id: 'strix02', label: '02-EVO-X3', kind: 'strix', host: '02-evo-x3-tb', capabilities: ['inferenza'] }, { id: 'cuda', label: 'RTX 3090', kind: 'cuda', host: '192.168.178.47', capabilities: ['cuda'] }],
    links: [{ id: 'tb', from: 'strix01', to: 'strix02', label: 'Thunderbolt', address: '02-evo-x3-tb', status: 'configured' }], resourceGroups: [{ id: 'dual', label: 'Dual Strix · modello distribuito', nodeIds: ['strix01', 'strix02'], capacity: 1 }], resourceUsage: { dual: 0 },
    telemetry: [{ nodeId: 'strix01', status: 'online', observedAt: now, quality: 'measured', gpuPercent: 0, gpuTempC: 45, gpuPowerW: 12, cpuPercent: 5, ramUsedBytes: 1024 ** 3 * 40, ramTotalBytes: 1024 ** 3 * 128 }, { nodeId: 'strix02', status: 'unknown', quality: 'unknown' }, { nodeId: 'cuda', status: 'offline', observedAt: now, quality: 'unknown', error: 'Nodo non raggiungibile.' }],
    runs: [], approvals: [], artifacts: [{ id: 'doc1', projectId: 'p1', ownerId: 'u1', name: 'Metodo.md', mime: 'text/markdown', bytes: 50, sha256: 'a'.repeat(64), createdAt: now, kind: 'attachment' }],
    memories: [{ id: 'mem1', projectId: 'p1', ownerId: 'u1', scope: 'private', kind: 'method', title: 'Metodo di release', content: 'Prima esegui i test. <script>evil()</script>', status: 'candidate', revision: 1, sourceIds: ['doc1'], createdAt: now, updatedAt: now }], evidence: [],
    targets: [{ id: 'coordinator', label: 'Coordinator · workspace', nodeId: 'strix01', kind: 'local', commands: [{ id: 'test', label: 'Test del progetto' }], deployments: [{ id: 'deploy', label: 'Deploy staging' }] }],
  };
}

function runFixture(status: Run['status'] = 'executing'): Run {
  return { id: 'r1', projectId: 'p1', conversationId: 'c1', ownerId: 'u1', goal: 'Costruisci e verifica il portale', mode: 'mission', status, phase: status, routeId: 'qwen', tasks: [{ id: 't1', runId: 'r1', label: 'Analizza i requisiti', role: 'researcher', instruction: 'Analizza', dependencies: [], routeId: 'qwen', status: 'succeeded', attempt: 1, output: 'Analisi completata.', evidenceIds: [] }, { id: 't2', runId: 'r1', label: 'Implementa il backend', role: 'coder', instruction: 'Implementa', dependencies: ['t1'], routeId: 'qwen', status: 'queued', attempt: 0, evidenceIds: [], context: { budgetTokens: 4000, estimatedTokens: 500, reservedOutputTokens: 1000, estimator: 'fixture', truncated: false, sources: [{ id: 'mem1', kind: 'memory', title: 'Metodo di lavoro', estimatedTokens: 50, included: true, reason: 'Approvato e pertinente' }] } }], iteration: 1, maxIterations: 3, maxParallel: 2, budget: { callsUsed: 1, maxModelCalls: 20, outputTokensUsed: 100, maxOutputTokens: 10000 }, permissions: { write: false, commands: false, deploy: false }, createdAt: now, updatedAt: now };
}

class FixtureApi implements ClientApi {
  native = false;
  state = fixture();
  calls: Array<{ method: string; path: string; body?: any }> = [];
  listener?: (event: RunEvent) => void;
  selection?: (selection: { name: string; content: string }) => void;
  fault?: (method: string, path: string, body: any) => Error | undefined;
  configureCount = 0;
  saved?: { name: string; content: string };
  connectionGate?: Promise<void>;
  detectionGate?: Promise<void>;
  async request<T>(method: string, path: string, body?: any): Promise<T> {
    this.calls.push({ method, path, body });
    const fault = this.fault?.(method, path, body); if (fault) throw fault;
    if (path === '/api/bootstrap') return structuredClone(this.state) as T;
    if (path === '/api/login' || path === '/api/logout') return { ok: true } as T;
    if (path === '/api/conversations' && method === 'POST') { const conversation = { ...this.state.conversations[0]!, id: 'c2', messages: [], projectId: body.projectId, routeId: body.routeId }; this.state.conversations.push(conversation); return structuredClone(conversation) as T; }
    if (/\/messages$/.test(path)) { const run = runFixture('planning'); this.state.runs.push(run); return structuredClone(run) as T; }
    if (path === '/api/memories/search') return { results: [{ memory: this.state.memories[0], score: 0.7, method: 'lexical' }] } as T;
    if (path === '/api/memories/mem1' && method === 'PATCH') { Object.assign(this.state.memories[0]!, body); return structuredClone(this.state.memories[0]) as T; }
    if (path === '/api/tasks/t2/route') { this.state.runs[0]!.tasks[1]!.routeId = body.routeId; return structuredClone(this.state.runs[0]) as T; }
    if (path === '/api/tasks/t2/pause') { Object.assign(this.state.runs[0]!.tasks[1]!, { status: 'blocked', control: 'paused' }); return structuredClone(this.state.runs[0]) as T; }
    if (path === '/api/tasks/t2/resume') { Object.assign(this.state.runs[0]!.tasks[1]!, { status: 'queued', control: undefined }); return structuredClone(this.state.runs[0]) as T; }
    if (path === '/api/artifacts' && method === 'POST') { const artifact: Artifact = { id: 'doc2', projectId: body.projectId, ownerId: 'u1', name: body.name, mime: 'text/plain', bytes: body.content.length, sha256: 'b'.repeat(64), createdAt: now, kind: 'attachment' }; this.state.artifacts.push(artifact); return structuredClone(artifact) as T; }
    if (path === '/api/artifacts/doc1') return { ...this.state.artifacts[0], content: '# Metodo\nUsare le verifiche.' } as T;
    if (path === '/api/connections') {
      await this.connectionGate;
      const provider = { ...this.state.providers[0], id: body.providerId ?? 'provider-new', kind: body.preset === 'codex' ? 'codex' : body.preset === 'antigravity' ? 'antigravity' : 'openai-compatible', label: body.label || 'Collegamento' };
      const account = { ...this.state.accounts[0], id: body.accountId ?? 'account-new', providerId: provider.id, label: body.accountLabel || 'Principale' };
      return { provider, account, models: body.preset === 'codex' ? [] : [this.state.models[0]], status: body.preset === 'codex' ? 'login-required' : 'ready', message: 'Connessione verificata', warnings: [], reused: { provider: false, account: false }, ...(body.preset === 'codex' ? { nextAction: { kind: 'login', label: 'Accedi', accountId: account.id } } : {}) } as T;
    }
    if (path === '/api/connections/detect') { await this.detectionGate; return { candidates: [{ preset: 'ollama', label: 'Ollama rilevato', baseUrl: 'http://127.0.0.1:11434', modelCount: 2, status: 'available', message: 'Rilevato' }], scope: 'Indirizzi del coordinator' } as T; }
    if (path === '/api/providers') { const provider = { ...body, id: 'provider-new', ownerId: 'u1', enabled: true, createdAt: now }; this.state.providers.push(provider); return provider as T; }
    if (path === '/api/accounts') { const account = { ...body, id: 'account-new', ownerId: 'u1', status: 'unknown', hasSecret: false }; this.state.accounts.push(account); return account as T; }
    if (path.endsWith('/discover')) return { models: [this.state.models[0]], account: this.state.accounts[0] } as T;
    if (path === '/api/projects') { const project = { ...this.state.projects[0], ...body, id: 'p2' }; this.state.projects.push(project); return project as T; }
    if (path === '/api/projects/p1') { Object.assign(this.state.projects[0]!, body); return structuredClone(this.state.projects[0]) as T; }
    if (path === '/api/users' && method === 'GET') return { users: [this.state.user] } as T;
    if (path === '/api/users' && method === 'POST') return { user: { id: 'u2', name: body.name, role: body.role }, token: 'only-once-fixture-key' } as T;
    if (path.startsWith('/api/runs/')) return structuredClone(this.state.runs[0] ?? runFixture()) as T;
    return { ok: true } as T;
  }
  subscribe(listener: (event: RunEvent) => void, onState?: (connected: boolean) => void): () => void { this.listener = listener; onState?.(true); return () => { this.listener = undefined; }; }
  configure(): void { this.configureCount++; }
  onSelection(handler: (selection: { name: string; content: string }) => void): () => void { this.selection = handler; return () => { this.selection = undefined; }; }
  async saveFile(name: string, content: string): Promise<void> { this.saved = { name, content }; }
  emit(event: Partial<RunEvent>): void { this.listener?.({ id: 0, ownerId: 'u1', createdAt: now, type: 'state.changed', ...event }); }
}

async function setup(t: any, api = new FixtureApi()) {
  const dom = new JSDOM('<!doctype html><html lang="it"><body><div id="root"></div></body></html>', { url: 'https://portal.test', pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const root = dom.window.document.getElementById('root')!;
  const app = mountApp(root, api); await app.ready;
  t.after(() => { app.dispose(); dom.window.close(); });
  const click = (selector: string) => { const item = root.querySelector(selector) as HTMLButtonElement; assert.ok(item, selector); item.click(); };
  const buttonText = (text: string, within: ParentNode = root) => { const button = Array.from(within.querySelectorAll('button')).find(item => item.textContent?.trim() === text) as HTMLButtonElement | undefined; assert.ok(button, `Button: ${text}`); return button; };
  const flush = async () => { await new Promise(resolve => setTimeout(resolve, 10)); await app.ready; };
  return { dom, root, app, api, click, buttonText, flush };
}

test('cockpit mostra tutti i nodi, distingue zero da misure ignote e non interpreta markup del modello', async t => {
  const { root, click } = await setup(t);
  const ribbon = root.querySelector('#fleet-ribbon')!;
  assert.match(ribbon.textContent!, /01-EVO-X3/); assert.match(ribbon.textContent!, /02-EVO-X3/); assert.match(ribbon.textContent!, /RTX 3090/);
  assert.match(ribbon.textContent!, /0% GPU/); assert.match(ribbon.textContent!, /Non rilevato/); assert.match(ribbon.textContent!, /Offline/);
  assert.equal(root.querySelector('.message-body img'), null);
  assert.match(root.querySelector('.message-body')!.parentElement!.parentElement!.textContent!, /contesto da mantenere/);
  assert.match(root.querySelector('.response-metrics')!.textContent!, /in 0 token/);
  click('[data-view="infrastructure"]');
  assert.equal(root.querySelectorAll('.node-card').length, 3); assert.match(root.querySelector('#page-view')!.textContent!, /Configurato, da verificare/); assert.match(root.querySelector('#page-view')!.textContent!, /Dual Strix · modello distribuito/);
});

test('switch modello/account conserva conversazione e invia la route scelta al prossimo messaggio', async t => {
  const { root, click, api, flush, dom } = await setup(t);
  click('#model-picker'); click('[data-route-id="remote"]'); await flush();
  assert.match(root.querySelector('#messages')!.textContent!, /Questo è il contesto da mantenere/);
  const input = root.querySelector<HTMLTextAreaElement>('#message-input')!; input.value = 'Continua il lavoro'; input.dispatchEvent(new dom.window.Event('input'));
  root.querySelector<HTMLFormElement>('#composer')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  const sent = api.calls.find(call => call.path.endsWith('/messages'))!; assert.equal(sent.path, '/api/conversations/c1/messages'); assert.equal(sent.body.routeId, 'remote'); assert.equal(sent.body.text, 'Continua il lavoro');
  assert.deepEqual(sent.body.permissions, { write: false, commands: false, deploy: false });
});

test('parlare durante una missione produce una istruzione persistente senza avviare una seconda missione', async t => {
  const api = new FixtureApi(); api.state.runs.push(runFixture());
  const { root, dom, flush } = await setup(t, api);
  const input = root.querySelector<HTMLTextAreaElement>('#message-input')!; input.value = 'Dai priorità alla sicurezza'; input.dispatchEvent(new dom.window.Event('input'));
  root.querySelector<HTMLFormElement>('#composer')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  assert.equal(api.calls.filter(call => call.path.endsWith('/messages')).length, 0); assert.deepEqual(api.calls.find(call => call.path.endsWith('/steer'))?.body, { text: 'Dai priorità alla sicurezza', attachmentIds: [] });
  assert.equal(root.querySelector<HTMLButtonElement>('#stop')!.hidden, false);
});

test('attività in coda riassegnabile e dipendenze/contesto restano visibili', async t => {
  const api = new FixtureApi(); api.state.runs.push(runFixture());
  const { root, click, buttonText, flush } = await setup(t, api);
  assert.match(root.querySelector('.task-deps')!.textContent!, /Analizza i requisiti/);
  click('[data-task-id="t2"]'); buttonText('Cambia modello / account').click(); click('[data-route-id="remote"]'); await flush();
  assert.deepEqual(api.calls.find(call => call.path === '/api/tasks/t2/route')?.body, { routeId: 'remote' });
  buttonText('Contesto').click(); assert.match(root.querySelector('#task-detail')!.textContent!, /Metodo di lavoro/); assert.match(root.querySelector('#task-detail')!.textContent!, /500 token stimati/);
});

test('memorie candidate vengono approvate esplicitamente, con fonte visibile e contenuto inerte', async t => {
  const { root, api, click, buttonText, flush } = await setup(t);
  click('[data-view="knowledge"]'); assert.match(root.querySelector('.knowledge-card')!.textContent!, /Metodo.md/); assert.equal(root.querySelector('.knowledge-card script'), null);
  buttonText('Approva per il contesto').click(); await flush();
  assert.deepEqual(api.calls.find(call => call.path === '/api/memories/mem1')?.body, { status: 'approved' }); assert.match(root.querySelector('.knowledge-card')!.textContent!, /Approvata/);
});

test('ricerca memoria usa endpoint del progetto e indica metodo effettivo senza embedding fittizi', async t => {
  const { root, api, click, buttonText, flush, dom } = await setup(t);
  click('[data-view="knowledge"]'); buttonText('Cerca nel contesto').click();
  const input = root.querySelector<HTMLInputElement>('#memory-search')!; input.value = 'release'; input.dispatchEvent(new dom.window.Event('input'));
  root.querySelector<HTMLFormElement>('.page-toolbar')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  assert.deepEqual(api.calls.find(call => call.path === '/api/memories/search')?.body, { projectId: 'p1', query: 'release' });
  assert.match(root.querySelector('#page-view')!.textContent!, /lexical/); assert.match(root.querySelector('#page-view')!.textContent!, /Non vengono generati vettori artificiali/);
});

test('allegato dalla selezione native viene caricato, conservato e riferito nella richiesta', async t => {
  const api = new FixtureApi(); api.native = true;
  const { root, dom, flush } = await setup(t, api);
  api.selection?.({ name: 'README.md', content: '# Linee guida\nUsa TypeScript.' }); await flush();
  assert.match(root.querySelector('#attachments-preview')!.textContent!, /README.md/);
  const input = root.querySelector<HTMLTextAreaElement>('#message-input')!; input.value = 'Segui questo documento'; input.dispatchEvent(new dom.window.Event('input'));
  root.querySelector<HTMLFormElement>('#composer')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  assert.deepEqual(api.calls.find(call => call.path.endsWith('/messages'))?.body.attachmentIds, ['doc2']);
});

test('discovery native usa richiesta di segreto host senza campo API key nella webview', async t => {
  const api = new FixtureApi(); api.native = true;
  const { root, click, buttonText, flush, dom } = await setup(t, api);
  click('[data-view="connections"]'); buttonText('Collega un account').click(); const dialog = root.querySelector('dialog')!;
  const service = dialog.querySelector('select')!; service.value = 'existing:cluster'; service.dispatchEvent(new dom.window.Event('change'));
  const label = Array.from(dialog.querySelectorAll<HTMLInputElement>('input')).find(item => item.placeholder.startsWith('Personale'))!; label.value = 'Secondo account';
  const checkbox = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(item => item.parentElement!.textContent!.includes('finestra protetta'))!; checkbox.checked = true;
  assert.equal(dialog.querySelector('input[type="password"]'), null);
  dialog.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  const request = api.calls.find(call => call.path === '/api/connections')!; assert.equal(request.body.requestSecret, true); assert.equal(request.body.secret, undefined); assert.equal(request.body.providerId, 'cluster'); assert.equal(api.calls.some(call => call.path === '/api/accounts'), false); assert.match(root.querySelector('.connection-result')!.textContent!, /modelli collegati/);
});

test('preset Codex avvia l’accesso ufficiale senza richiedere endpoint o chiave API', async t => {
  const { root, api, click, buttonText, flush, dom } = await setup(t);
  click('[data-view="connections"]'); buttonText('Collega un account').click(); const dialog = root.querySelector('dialog')!; const service = dialog.querySelector('select')!; service.value = 'codex'; service.dispatchEvent(new dom.window.Event('change'));
  const endpoint = dialog.querySelector<HTMLInputElement>('input[type="url"]')!; assert.equal(endpoint.required, false); assert.equal(endpoint.parentElement!.hidden, true);
  const label = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="text"]')).find(item => item.placeholder.startsWith('Personale'))!; label.value = 'Codex personale';
  dialog.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  const provider = api.calls.find(item => item.path === '/api/connections')!; assert.equal(provider.body.preset, 'codex'); assert.equal('baseUrl' in provider.body, false); assert.equal('secret' in provider.body, false); assert.equal('command' in provider.body, false);
  assert.ok(api.calls.some(item => item.path === '/api/accounts/account-new/login')); assert.equal(api.calls.some(item => item.path.endsWith('/discover')), false);
});

test('una risposta 429 mantiene la bozza e non ruota né ripete il task automaticamente', async t => {
  const api = new FixtureApi(); api.fault = (_method, path) => path.endsWith('/messages') ? new ApiError('Quota esaurita', 429, 'rate_limit') : undefined;
  const { root, dom, flush } = await setup(t, api); const input = root.querySelector<HTMLTextAreaElement>('#message-input')!; input.value = 'Correggi il problema'; input.dispatchEvent(new dom.window.Event('input')); root.querySelector('form#composer')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  assert.equal(api.calls.filter(call => call.path.endsWith('/messages')).length, 1); assert.equal(input.value, 'Correggi il problema'); assert.match(root.querySelector('#banner')!.textContent!, /Quota esaurita/);
});

test('viewer ispeziona infrastruttura ma non avvia agenti o crea connessioni', async t => {
  const api = new FixtureApi(); api.state.user.role = 'viewer'; const { root, click } = await setup(t, api);
  assert.equal(root.querySelector<HTMLButtonElement>('#new-project')!.disabled, true); assert.equal(root.querySelector<HTMLButtonElement>('#send')!.disabled, true);
  click('[data-view="connections"]'); const create = Array.from(root.querySelectorAll('button')).find(item => item.textContent === 'Collega un account')!; assert.equal((create as HTMLButtonElement).disabled, true);
});

test('member crea un progetto senza campi esecutivi riservati e usa chat senza missioni', async t => {
  const api = new FixtureApi(); api.state.user.role = 'member'; const { root, click, flush, dom } = await setup(t, api);
  assert.equal(root.querySelector<HTMLSelectElement>('#mode-select')!.value, 'chat'); assert.equal(root.querySelector<HTMLOptionElement>('#mode-select option[value="mission"]')!.disabled, true);
  click('#new-project'); const dialog = root.querySelector('dialog')!; const name = dialog.querySelector<HTMLInputElement>('input[type="text"]')!; name.value = 'Nuovo progetto personale';
  dialog.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  const payload = api.calls.find(item => item.path === '/api/projects')!.body;
  for (const key of ['targetId', 'workspace', 'verifyRecipeIds', 'deploymentRecipeId', 'memberIds']) assert.equal(key in payload, false, key);
});

test('stream con offset ignora delta già compresi nello snapshot e conserva il risultato', async t => {
  const api = new FixtureApi(); api.state.conversations[0]!.messages[1]!.text = 'Risposta'; const { root } = await setup(t, api);
  api.emit({ type: 'message.delta', data: { messageId: 'm2', delta: 'posta', offset: 3 } });
  api.emit({ type: 'message.delta', data: { messageId: 'm2', delta: ' completa', offset: 8 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(root.querySelector('[data-message-id="m2"] .message-body')!.textContent, 'Risposta completa');
});

test('grafo usa le dipendenze effettive e il dettaglio agente riceve output live', async t => {
  const api = new FixtureApi(); const run = runFixture(); run.tasks[1]!.status = 'running'; api.state.runs.push(run);
  const { root, click } = await setup(t, api);
  assert.equal(root.querySelectorAll('.graph-edge').length, 1); assert.equal(root.querySelectorAll('.graph-task').length, 2);
  click('[data-task-id="t2"]');
  api.emit({ type: 'task.delta', taskId: 't2', data: { delta: 'Sto verificando', offset: 0 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(root.querySelector('#task-detail')!.textContent!, /Sto verificando/);
  api.emit({ type: 'task.delta', taskId: 't2', data: { delta: ' il codice.', offset: 15 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(root.querySelector('#task-detail')!.textContent!, /Sto verificando il codice/);
});

test('un agente può essere messo in pausa, riassegnato e ripreso senza fermare l’intera missione', async t => {
  const api = new FixtureApi(); const run = runFixture(); run.tasks[1]!.status = 'running'; api.state.runs.push(run);
  const { root, click, buttonText, flush } = await setup(t, api);
  click('[data-task-id="t2"]'); buttonText('Pausa agente').click(); await flush();
  assert.ok(api.calls.some(item => item.path === '/api/tasks/t2/pause')); assert.equal(api.calls.some(item => item.path === '/api/runs/r1/pause'), false);
  assert.match(root.querySelector('#task-detail')!.textContent!, /In pausa/); assert.ok(buttonText('Cambia modello / account'));
  buttonText('Riprendi agente').click(); await flush(); assert.ok(api.calls.some(item => item.path === '/api/tasks/t2/resume')); assert.equal(api.state.runs[0]!.status, 'executing');
});

test('una missione in attesa di rilascio riceve istruzioni senza tentare una nuova missione in conflitto', async t => {
  const api = new FixtureApi(); api.state.runs.push(runFixture('awaiting_release'));
  const { root, dom, flush } = await setup(t, api); const input = root.querySelector<HTMLTextAreaElement>('#message-input')!; input.value = 'Aggiungi un controllo prima del rilascio'; input.dispatchEvent(new dom.window.Event('input')); root.querySelector('#composer')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  assert.ok(api.calls.some(item => item.path === '/api/runs/r1/steer')); assert.equal(api.calls.some(item => item.path.endsWith('/messages')), false);
});

test('la rete distingue velocità nominale, traffico osservato e contatori mancanti', async t => {
  const api = new FixtureApi(); api.state.telemetry[0]!.details = { probeMs: 12.3, network: [{ name: 'eth0', up: true, addresses: ['192.168.178.77/24'], speedMbps: 2500, rxBytesPerSecond: 0, txBytesPerSecond: 1024, rxErrors: 0, txErrors: 0 }, { name: 'tb0', addresses: ['10.55.0.1/30'] }] };
  const { root, click } = await setup(t, api); click('[data-view="infrastructure"]'); const card = root.querySelector('[data-node-id="strix01"]')!;
  assert.match(card.textContent!, /2[.\u00a0]?500 Mbps/); assert.match(card.textContent!, /0 B\/s/); assert.match(card.textContent!, /1 KB\/s/); assert.match(card.textContent!, /192.168.178.77\/24/); assert.match(card.textContent!, /12,3 ms/); assert.match(card.textContent!, /non un test di banda/);
});

test('cambiare progetto separa le bozze e non invia per errore il contesto di un altro workspace', async t => {
  const api = new FixtureApi(); api.state.projects.push({ ...api.state.projects[0]!, id: 'p2', name: 'Altro progetto' });
  const { root, dom } = await setup(t, api); const input = root.querySelector<HTMLTextAreaElement>('#message-input')!; input.value = 'Bozza privata del progetto uno';
  const select = root.querySelector<HTMLSelectElement>('#project-select')!; select.value = 'p2'; select.dispatchEvent(new dom.window.Event('change')); assert.equal(input.value, '');
  input.value = 'Bozza del progetto due'; select.value = 'p1'; select.dispatchEvent(new dom.window.Event('change')); assert.equal(input.value, 'Bozza privata del progetto uno');
});

test('rilascio mostra target e verifiche prima dell’autorizzazione concreta', async t => {
  const api = new FixtureApi(); const run = runFixture('awaiting_release'); run.verificationPassed = true; api.state.runs.push(run); api.state.evidence.push({ id: 'e1', projectId: 'p1', runId: 'r1', kind: 'test', title: 'Suite integrazione', ok: true, output: '20 pass', createdAt: now });
  const { root, click, buttonText, flush } = await setup(t, api);
  click('[data-view="releases"]'); buttonText('Esamina e rilascia').click(); assert.match(root.querySelector('dialog')!.textContent!, /Coordinator · workspace/); assert.match(root.querySelector('dialog')!.textContent!, /Suite integrazione/); assert.equal(api.calls.filter(call => call.path.endsWith('/release')).length, 0);
  buttonText('Autorizza questo rilascio').click(); await flush(); assert.equal(api.calls.filter(call => call.path === '/api/runs/r1/release').length, 1);
});

test('accesso OAuth effimero non finisce nella conversazione e non apre URL non HTTPS', async t => {
  const { root, api } = await setup(t);
  api.emit({ type: 'account.login', data: { status: 'pending', userCode: 'ABCD-1234', verificationUri: 'javascript:alert(1)' } });
  assert.equal(root.querySelector('dialog a'), null); assert.equal(root.querySelector<HTMLInputElement>('dialog input')!.value, 'ABCD-1234'); assert.doesNotMatch(root.querySelector('#messages')!.textContent!, /ABCD/);
  api.emit({ type: 'account.login', data: { status: 'complete' } }); assert.equal(root.querySelector('dialog'), null);
});

test('esportazione da VSCode usa la finestra native e conserva il testo della conversazione', async t => {
  const api = new FixtureApi(); api.native = true; const { click, flush } = await setup(t, api);
  click('#export-conversation'); await flush(); assert.match(api.saved!.name, /\.json$/); assert.equal(JSON.parse(api.saved!.content).id, 'c1');
});

test('renderer Markdown lascia HTML inerte e rifiuta link eseguibili o con credenziali', () => {
  const dom = new JSDOM('<body></body>'); const body = dom.window.document.body;
  body.append(renderMarkdown(dom.window.document, '# Titolo\n<script>window.pwned=1</script>\n\n[pericolo](javascript:alert) [credenziali](https://u:p@example.com) [valido](https://example.com/a)\n\n```ts\n<img src=x onerror=alert()>\n```'));
  assert.equal(body.querySelector('script'), null); assert.equal(body.querySelector('img'), null); assert.equal(body.querySelectorAll('a').length, 1); assert.equal(body.querySelector('a')!.getAttribute('rel'), 'noopener noreferrer'); assert.match(body.querySelector('pre')!.textContent!, /<img/); dom.window.close();
});

test('transport native correla richieste, sottoscrizione, salvataggio e cancella risposte non richieste', async () => {
  const dom = new JSDOM('<body></body>'); const sent: any[] = []; const api = createNativeApi(dom.window as unknown as Window, { postMessage: message => sent.push(message) });
  const result = api.request<{ ok: boolean }>('GET', '/api/bootstrap'); const id = sent[0].id;
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'api.result', id: 'unknown', ok: true, data: { bad: true } } }));
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'api.result', id, ok: true, status: 200, data: { ok: true } } })); assert.deepEqual(await result, { ok: true });
  let count = 0; const unsubscribe = api.subscribe(() => count++); dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'event', event: { id: 0, type: 'telemetry' } } })); assert.equal(count, 1); unsubscribe();
  const saved = api.saveFile!('chat.json', '{}'); assert.equal(sent.at(-1).type, 'saveFile'); dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'savedFile', ok: true } })); await saved;
  assert.throws(() => api.request('GET', 'https://elsewhere.test/api/steal'), /Percorso/); api.dispose?.(); dom.window.close();
});

test('transport browser include cookie, vieta redirect e non azzera il replay cursor per eventi effimeri', async () => {
  const dom = new JSDOM('<body></body>'); let fetchOptions: any; let eventSource: any;
  dom.window.fetch = async (_path: string, options: any) => { fetchOptions = options; return { ok: true, json: async () => ({ ok: true }) }; };
  dom.window.EventSource = class { onmessage: any; onopen: any; onerror: any; constructor() { eventSource = this; } close() {} };
  const api = createBrowserApi(dom.window as unknown as Window); await api.request('POST', '/api/login', { token: 'fixture-only' }); assert.equal(fetchOptions.credentials, 'same-origin'); assert.equal(fetchOptions.redirect, 'error');
  const received: number[] = []; const close = api.subscribe(event => received.push(event.id));
  for (const id of [2, 0, 1, 3]) eventSource.onmessage({ data: JSON.stringify({ id, type: 'telemetry' }) });
  assert.deepEqual(received, [2, 0, 3]); close(); dom.window.close();
});

test('Auto risponde ai saluti senza modello e senza sospendere la missione aperta', async t => {
  const api = new FixtureApi(); api.state.runs.push(runFixture()); api.state.models = []; api.state.projects[0]!.routes = {};
  const { root, dom, flush } = await setup(t, api);
  assert.equal(root.querySelector<HTMLSelectElement>('#mode-select')!.value, 'auto');
  const input = root.querySelector<HTMLTextAreaElement>('#message-input')!; input.value = 'Come stai?'; input.dispatchEvent(new dom.window.Event('input'));
  assert.equal(root.querySelector<HTMLButtonElement>('#send')!.disabled, false);
  assert.match(root.querySelector('#composer-status')!.textContent!, /nessuna inferenza/i);
  root.querySelector('form#composer')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  const request = api.calls.find(call => call.path.endsWith('/messages'))!; assert.ok(request); assert.equal(request.body.mode, 'auto');
  assert.equal(api.calls.some(call => call.path.endsWith('/steer')), false); assert.equal(api.calls.some(call => call.path.endsWith('/pause')), false);
});

test('il picker mostra occupazione reale e inoltra soltanto le alternative autorizzate', async t => {
  const api = new FixtureApi(); api.state.routeAvailability = [
    { routeId: 'qwen', status: 'busy', activeCount: 1, queueCount: 2, resourceGroupIds: ['dual'], busyResourceIds: ['dual'], busyResourceLabels: ['Dual Strix'], reason: 'Dual Strix occupato da una richiesta.', observedAt: now, source: 'coordinator' },
    { routeId: 'remote', status: 'available', activeCount: 0, queueCount: 0, resourceGroupIds: [], busyResourceIds: [], busyResourceLabels: [], reason: 'Slot libero nel coordinator.', observedAt: now, source: 'coordinator' }
  ];
  const { root, click, dom, flush } = await setup(t, api); click('#model-picker');
  const dialog = root.querySelector('dialog')!;
  assert.match(dialog.querySelector('[data-route-id="qwen"]')!.textContent!, /Occupato/); assert.match(dialog.textContent!, /2 in coda/);
  assert.equal(dialog.querySelectorAll('.fallback-choices input:checked').length, 0);
  const alternate = dialog.querySelector<HTMLInputElement>('.fallback-choices input[value="remote"]')!; alternate.checked = true; alternate.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  (dialog.querySelector('[data-route-id="qwen"]') as HTMLButtonElement).click(); await flush();
  const input = root.querySelector<HTMLTextAreaElement>('#message-input')!; input.value = 'Spiegami come funziona il contesto.'; input.dispatchEvent(new dom.window.Event('input')); root.querySelector('form#composer')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  const request = api.calls.find(call => call.path.endsWith('/messages'))!;
  assert.deepEqual(request.body.routing.fallbackRouteIds, ['remote']); assert.equal(request.body.routing.strategy, 'auto');
});

test('il flusso HUD distingue attesa e attività, gli impulsi arrivano dagli eventi e possono essere disattivati', async t => {
  const api = new FixtureApi(); const run = runFixture('queued'); api.state.runs.push(run);
  const { root, click } = await setup(t, api);
  assert.equal(root.querySelectorAll('#activity-strip .activity-node.live').length, 0);
  assert.match(root.querySelector('#activity-strip')!.textContent!, /In attesa di risorse/);
  api.emit({ type: 'task.delta', taskId: 't2', data: { delta: 'test', offset: 0 } });
  assert.equal(root.querySelector('#activity-strip [data-activity-node="models"]')!.classList.contains('packet'), true);
  click('#fx-toggle'); assert.equal(root.dataset.motion, 'off');
  api.emit({ type: 'context.warning', taskId: 't2', message: 'Ricerca lessicale' });
  assert.equal(root.querySelector('#activity-strip [data-activity-node="knowledge"]')!.classList.contains('packet'), false);
});

test('le risposte deterministiche sono etichettate come servizio e non come inferenza del modello', async t => {
  const api = new FixtureApi(); const message = api.state.conversations[0]!.messages[1]!; message.source = 'service'; message.routeId = undefined; message.metrics = undefined;
  const { root } = await setup(t, api);
  const response = root.querySelector('[data-message-id="m2"]')!;
  assert.match(response.textContent!, /Servizio yed1z/); assert.match(response.textContent!, /Nessuna inferenza/);
  assert.equal(response.querySelector('.message-model'), null); assert.equal(response.querySelector('.response-metrics'), null);
});

test('la cronologia lunga carica progressivamente i messaggi senza alterare il contesto inviato', async t => {
  const api = new FixtureApi(); api.state.conversations[0]!.messages = Array.from({ length: 95 }, (_, index) => ({ id: `long-${index}`, role: index % 2 ? 'assistant' : 'user', text: `Messaggio ${index}`, createdAt: now }));
  const { root, buttonText } = await setup(t, api);
  assert.equal(root.querySelectorAll('.message').length, 80); assert.equal(root.querySelector('[data-message-id="long-0"]'), null);
  buttonText('Mostra 15 messaggi precedenti').click(); assert.equal(root.querySelectorAll('.message').length, 95);
  assert.equal(api.state.conversations[0]!.messages.length, 95);
});

test('il wizard nasconde configurazione superflua e conserva l’identità del tentativo per il retry', async t => {
  const { root, click, api, dom, flush } = await setup(t); click('#quick-connect');
  const dialog = root.querySelector('dialog')!; (dialog.querySelector('[data-preset="openai"]') as HTMLButtonElement).click();
  assert.equal(dialog.querySelector<HTMLInputElement>('input[type="url"]')!.parentElement!.hidden, true);
  assert.equal(dialog.querySelector<HTMLInputElement>('input[placeholder^="Personale"]')!.required, false);
  const form = dialog.querySelector('form')!; form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  const calls = api.calls.filter(call => call.path === '/api/connections'); assert.equal(calls.length, 2); assert.equal(calls[0].body.requestId, calls[1].body.requestId); assert.equal(calls[1].body.accountId, 'account-new');
  assert.equal(api.calls.some(call => call.path === '/api/providers' || call.path === '/api/accounts'), false);
});

test('la modalità ospite atterra realmente sulla dashboard e il login non lascia una vista nascosta', async t => {
  const api = new FixtureApi(); api.state.user = { ...api.state.user, id: 'guest', role: 'viewer' }; api.state.projects = []; api.state.conversations = []; api.state.models = []; api.state.providers = []; api.state.accounts = [];
  const { root, app } = await setup(t, api);
  assert.equal((root.querySelector('#control-view') as HTMLElement).hidden, true); assert.equal((root.querySelector('#page-view') as HTMLElement).hidden, false);
  assert.match(root.querySelector('#page-title')!.textContent!, /Dashboard cluster/); assert.equal(root.querySelectorAll('.node-card').length, 3);
  api.state = fixture(); await app.refresh();
  assert.equal((root.querySelector('#control-view') as HTMLElement).hidden, false); assert.equal(root.querySelector<HTMLSelectElement>('#mode-select')!.value, 'auto');
});

test('gli aggiornamenti di occupazione preservano form e focus e separano coordinator e motore', async t => {
  const { root, api, click, dom } = await setup(t);
  click('#project-settings');
  const projectInput = root.querySelector<HTMLInputElement>('dialog input[type="text"]')!; projectInput.value = 'Nome ancora in modifica'; projectInput.focus();
  const observation = { routeAvailability: [{ routeId: 'qwen', status: 'busy', activeCount: 0, queueCount: 0, externalActiveRequests: 2, externalQueuedRequests: 3, resourceGroupIds: ['dual'], busyResourceIds: ['dual'], busyResourceLabels: ['Dual Strix'], reason: 'Il motore osserva richieste esterne.', observedAt: now, source: 'provider' }], providerLoads: [], resourceUsage: { dual: 1 } };
  api.emit({ type: 'routing.updated', data: observation });
  assert.equal(root.querySelector('dialog input[type="text"]'), projectInput); assert.equal(projectInput.value, 'Nome ancora in modifica'); assert.equal(dom.window.document.activeElement, projectInput);
  (root.querySelector('dialog') as HTMLDialogElement).close(); click('#model-picker');
  let route = root.querySelector<HTMLButtonElement>('[data-route-id="qwen"]')!; route.focus();
  api.emit({ type: 'routing.updated', data: observation }); route = root.querySelector<HTMLButtonElement>('[data-route-id="qwen"]')!;
  assert.equal(dom.window.document.activeElement, route); assert.match(route.textContent!, /Motore: 2 attive · 3 in coda/);
  (root.querySelector('dialog') as HTMLDialogElement).close(); click('[data-view="infrastructure"]');
  const cells = Array.from(root.querySelectorAll('#route-availability tbody td')).map(cell => cell.textContent);
  assert.equal(cells[2], '0 / 0'); assert.equal(cells[3], '2 / 3'); assert.match(root.querySelector('.pool-usage')!.textContent!, /1\/1/);
  const calls = api.calls.length;
  api.emit({ type: 'telemetry', data: { ...observation, telemetry: [{ ...api.state.telemetry[0], gpuPercent: 73 }] } });
  assert.match(root.querySelector('#fleet-ribbon')!.textContent!, /73% GPU/); assert.equal(api.calls.length, calls);
});

test('un ospite può annullare il login e riprendere il monitor live, una sessione privata scaduta richiede accesso', async t => {
  const api = new FixtureApi(); api.state.user = { ...api.state.user, id: 'guest', role: 'viewer' };
  const { root, click, dom, flush } = await setup(t, api);
  click('#guest-login-btn'); assert.ok(root.querySelector('dialog')); assert.equal(api.listener, undefined);
  root.querySelector('dialog')!.dispatchEvent(new dom.window.Event('cancel', { cancelable: true })); await flush();
  assert.equal(root.querySelector('dialog'), null); assert.equal(root.querySelector<HTMLElement>('#page-view')!.hidden, false); assert.ok(api.listener);
  assert.equal(api.calls.some(call => call.path === '/api/login'), false);

  const privateApi = new FixtureApi(); const privateUi = await setup(t, privateApi);
  privateApi.fault = (_method, path) => path === '/api/bootstrap' ? new ApiError('Sessione scaduta', 401, 'SESSION') : undefined;
  await privateUi.app.refresh();
  privateUi.root.querySelector('dialog')!.dispatchEvent(new privateUi.dom.window.Event('cancel', { cancelable: true }));
  assert.ok(privateUi.root.querySelector('dialog[open]')); assert.doesNotMatch(privateUi.root.querySelector('dialog')!.textContent!, /Torna al monitor pubblico/);
});

test('la navigazione stretta esclude i controlli nascosti e ripristina il focus alla chiusura', async t => {
  const { root, click, dom } = await setup(t);
  Object.defineProperty(dom.window, 'innerWidth', { value: 320, configurable: true }); dom.window.dispatchEvent(new dom.window.Event('resize'));
  const sidebar = root.querySelector<HTMLElement>('.sidebar')!; const menu = root.querySelector<HTMLButtonElement>('#mobile-menu')!;
  assert.equal(sidebar.inert, true); assert.equal(sidebar.getAttribute('aria-hidden'), 'true'); assert.equal(menu.getAttribute('aria-expanded'), 'false');
  click('#mobile-menu'); assert.equal(sidebar.inert, false); assert.equal(menu.getAttribute('aria-expanded'), 'true'); assert.ok(sidebar.contains(dom.window.document.activeElement));
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(sidebar.inert, true); assert.equal(dom.window.document.activeElement, menu);
  for (const selector of ['#quick-connect', '#project-settings', '#show-team']) assert.ok(root.querySelector(selector)!.getAttribute('aria-label'));
  Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true }); dom.window.dispatchEvent(new dom.window.Event('resize'));
  assert.equal(sidebar.inert, false); assert.equal(sidebar.getAttribute('aria-hidden'), 'false');
});

test('il wizard blocca cambi durante connect e ignora risposte tardive dopo chiusura o cambio preset', async t => {
  const api = new FixtureApi(); let complete!: () => void; api.connectionGate = new Promise<void>(resolve => { complete = resolve; });
  const { root, click, dom, flush, buttonText } = await setup(t, api); click('#quick-connect');
  buttonText('Rileva servizi locali e configurati').click(); await flush();
  const dialog = root.querySelector<HTMLDialogElement>('dialog')!; const candidate = dialog.querySelector<HTMLButtonElement>('.detected-service')!;
  dialog.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.equal(candidate.disabled, true); assert.equal(dialog.querySelector<HTMLButtonElement>('[data-preset="ollama"]')!.disabled, true); assert.equal(dialog.querySelector<HTMLInputElement>('input[type="url"]')!.disabled, true);
  candidate.click(); assert.equal(dialog.querySelector('select')!.value, 'codex'); dialog.close(); complete(); await flush();
  assert.equal(root.querySelector('dialog'), null); assert.equal(api.calls.some(call => call.path.endsWith('/login')), false);

  let finishDetection!: () => void; api.detectionGate = new Promise<void>(resolve => { finishDetection = resolve; }); click('#quick-connect');
  buttonText('Rileva servizi locali e configurati').click(); click('[data-preset="openai"]'); finishDetection(); await flush();
  assert.equal(root.querySelector('.detected-service'), null); assert.equal(root.querySelector('dialog select')!.value, 'openai');
});

test('il wizard conserva hardware esistente e invia solo modifiche esplicite anche nei retry', async t => {
  const { root, click, dom, flush, api } = await setup(t); click('#quick-connect'); click('[data-preset="custom"]');
  const dialog = root.querySelector<HTMLDialogElement>('dialog')!; const form = dialog.querySelector('form')!;
  dialog.querySelector<HTMLInputElement>('input[type="url"]')!.value = 'http://cluster.test/v1';
  const node = dialog.querySelector<HTMLInputElement>('.resource-checkboxes input[value="strix01"]')!;
  node.checked = true; node.dispatchEvent(new dom.window.Event('change', { bubbles: true })); form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  assert.deepEqual(api.calls.filter(call => call.path === '/api/connections').at(-1)!.body.nodeIds, ['strix01']);
  node.checked = false; node.dispatchEvent(new dom.window.Event('change', { bubbles: true })); form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  assert.deepEqual(api.calls.filter(call => call.path === '/api/connections').at(-1)!.body.nodeIds, []);
  click('[data-preset="openai"]'); assert.equal(dialog.querySelectorAll('.resource-checkboxes input:checked').length, 0);
  const service = dialog.querySelector('select')!; service.value = 'existing:cluster'; service.dispatchEvent(new dom.window.Event('change')); form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush();
  const existing = api.calls.filter(call => call.path === '/api/connections').at(-1)!.body;
  assert.equal('nodeIds' in existing, false); assert.equal('resourceGroupIds' in existing, false); assert.equal(existing.providerId, 'cluster');
});
