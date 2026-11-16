import type { Account, AgentTask, Approval, Artifact, Bootstrap, ChatMessage, ContextReport, Conversation, Memory, ModelRoute, Project, Provider, Run, RunEvent, Telemetry } from '../src/contracts.ts';
import { ApiError, createApi, type ClientApi } from './api.ts';
import { renderMarkdown } from './markdown.ts';

type View = 'control' | 'infrastructure' | 'knowledge' | 'connections' | 'releases';
type ElementTag = keyof HTMLElementTagNameMap;
const labels: Record<string, string> = { queued: 'In coda', planning: 'Pianificazione', executing: 'In esecuzione', reviewing: 'Revisione', verifying: 'Verifica', awaiting_release: 'Pronto al rilascio', deploying: 'Rilascio in corso', succeeded: 'Completato', failed: 'Errore', paused: 'In pausa', cancelled: 'Annullato', interrupted: 'Interrotto', blocked: 'Bloccato', running: 'Al lavoro', online: 'Online', offline: 'Offline', stale: 'Dato non recente', unknown: 'Non rilevato', ready: 'Disponibile', cooldown: 'In attesa quota', approved: 'Approvata', candidate: 'Da confermare', retired: 'Archiviata', pending: 'Da approvare', denied: 'Negata', expired: 'Scaduta' };
const roleLabels: Record<string, string> = { primary: 'Orchestratore', coder: 'Sviluppatore', researcher: 'Ricercatore', reviewer: 'Revisore', tester: 'Verificatore', release: 'Release', admin: 'Amministratore', operator: 'Operatore', member: 'Membro', viewer: 'Osservatore' };
const paths: Record<string, string> = { grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', activity: 'M2 12h4l3-8 5 16 3-8h5', layers: 'm12 3 10 6-10 6L2 9zM2 15l10 6 10-6M2 12l10 6 10-6', plug: 'M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v5', rocket: 'M14 4c3-2 6-2 6-2s0 3-2 6l-6 6-5-5zM8 8l-4 1-2 4 5-1M14 14l-1 5-4 2 1-6M5 16l-2 5 5-2M14 6h.01', plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M6 18 18 6', menu: 'M4 6h16M4 12h16M4 18h16', down: 'm6 9 6 6 6-6', up: 'm6 15 6-6 6 6M12 9v12', arrow: 'M5 12h14m-6-6 6 6-6 6', refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16', server: 'M4 3h16v7H4zM4 14h16v7H4zM7 6h.01M7 17h.01M11 6h6M11 17h6', chip: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4', cloud: 'M6 18a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 0 10z', people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-4M16 3a4 4 0 0 1 0 8', code: 'm8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18', check: 'm5 12 4 4L19 6', checkSquare: 'M9 11l3 3L22 4M21 12v8H3V2h12', file: 'M14 2H5v20h14V7zM14 2v6h5M8 12h8M8 16h6', upload: 'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5', download: 'M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5', search: 'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2', logout: 'M9 3H3v18h6M9 12h13m-4-4 4 4-4 4', paperclip: 'm8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9M6 15l9-9', pause: 'M7 4v16M17 4v16', play: 'm6 3 15 9-15 9z', stop: 'M5 5h14v14H5z', edit: 'm15 4 5 5M3 21l6-1L21 8a3 3 0 0 0-5-5L4 15z', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', info: 'M12 8h.01M12 11v6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', book: 'M3 3h6a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H3zM21 3h-6a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3h6z', terminal: 'm4 5 6 7-6 7M12 19h8', share: 'M6 12h12M12 6v12M6 3h.01M18 3h.01', shield: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6' };
const activeRunStatuses = new Set(['queued', 'planning', 'executing', 'reviewing', 'verifying', 'deploying']);
const closedRunStatuses = new Set(['succeeded', 'failed', 'cancelled']);

export function mountApp(root: HTMLElement, api: ClientApi): ControlRoom { return new ControlRoom(root, api); }

export class ControlRoom {
  private readonly root: HTMLElement;
  private readonly api: ClientApi;
  private readonly document: Document;
  private readonly win: Window;
  private data?: Bootstrap;
  private projectId = '';
  private conversationId = '';
  private routeId = '';
  private runId = '';
  private taskId = '';
  private view: View = 'control';
  private knowledgeTab: 'memories' | 'files' | 'search' = 'memories';
  private taskTab: 'output' | 'events' | 'context' = 'output';
  private selectedAttachments: Artifact[] = [];
  private events: RunEvent[] = [];
  private taskProgress = new Map<string, { text: string; cursor: number; incomplete: boolean }>();
  private telemetryHistory = new Map<string, Array<{ observedAt: string; gpuPercent: number }>>();
  private drafts = new Map<string, { text: string; attachmentIds: string[]; routeId: string }>();
  private disposers: Array<() => void> = [];
  private subscription?: () => void;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private loading?: Promise<void>;
  private loginDialog?: HTMLDialogElement;
  private disposed = false;
  private sending = false;
  private connected = false;
  private searchQuery = '';
  private searchResults?: Array<{ memory: Memory; score: number; method: string }>;
  private autonomy = { write: false, commands: false, deploy: false, maxIterations: 3, maxParallel: 3 };
  private accountLoginDialog?: HTMLDialogElement;

  constructor(root: HTMLElement, api: ClientApi) {
    this.root = root; this.api = api;
    this.document = root.ownerDocument; this.win = this.document.defaultView!;
    root.innerHTML = `<a class="skip-link" href="#message-input">All'orchestratore</a>
      <div class="shell" id="shell"><aside class="sidebar" aria-label="Progetti e conversazioni">
      <div class="brand-row"><a href="#control" class="brand" aria-label="yed1z Control Room">yed1z<span class="brand-dot">.</span></a><span class="brand-tag">CONTROL<br>ROOM</span></div>
      <div class="project-label"><span class="eyebrow">IL TUO PROGETTO</span><button id="new-project" class="icon-button" title="Nuovo progetto" aria-label="Nuovo progetto"></button></div>
      <label class="sr-only" for="project-select">Progetto attivo</label><select id="project-select" class="project-switch"><option value="">Scegli un progetto</option></select>
      <nav class="nav" aria-label="Sezioni"><button class="nav-item active" data-view="control" aria-current="page">Control room</button><button class="nav-item" data-view="infrastructure">Infrastruttura</button><button class="nav-item" data-view="knowledge">Conoscenza</button><button class="nav-item" data-view="connections">Modelli e account</button><button class="nav-item" data-view="releases">Consegne e rilasci</button></nav>
      <div class="sidebar-line"></div><div class="history-heading"><span class="eyebrow">CONVERSAZIONI</span><button id="new-conversation" class="icon-button" title="Nuova conversazione" aria-label="Nuova conversazione"></button></div>
      <label class="sr-only" for="history-search">Cerca una conversazione</label><input id="history-search" class="history-search" type="search" placeholder="Cerca nelle tue conversazioni…" autocomplete="off"><div class="history" id="history"></div>
      <div class="sidebar-footer"><div class="avatar" id="user-avatar">y</div><div class="user-copy"><strong id="user-name">Il tuo spazio</strong><small id="user-role">Connessione…</small></div><button class="icon-button" id="user-action" aria-label="Esci" title="Esci"></button></div></aside>
      <button class="sidebar-backdrop" id="sidebar-backdrop" aria-label="Chiudi navigazione"></button>
      <main class="workspace"><header class="topbar"><div class="row"><button class="icon-button mobile-menu" id="mobile-menu" aria-label="Apri navigazione"></button><div><div class="breadcrumb" id="breadcrumb">yed1z / il tuo workspace</div><h1 id="page-title">Control room</h1></div></div><div class="topbar-actions"><span class="connection-state" id="connection-state"><i class="status-dot"></i>COLLEGAMENTO</span><button class="button subtle" id="project-settings"><span>Progetto</span></button><button class="button subtle mobile-team-button" id="show-team"><span>Squadra</span></button></div></header>
      <section class="fleet-ribbon" id="fleet-ribbon" aria-label="Stato dell'infrastruttura"></section><div class="banner" id="banner" role="status" hidden><span></span><button class="icon-button" id="close-banner" aria-label="Chiudi avviso"></button></div>
      <div class="content" id="content"><section class="control-room" id="control-view" aria-label="Control room"><section class="conversation" aria-label="Orchestratore e conversazione"><header class="conversation-heading"><div><h2><i class="role-orb"></i>Il tuo orchestratore</h2><p id="conversation-subtitle">Un obiettivo. Una squadra. Tutto sotto controllo.</p></div><div class="conversation-actions"><button id="export-conversation" class="icon-button export-button" aria-label="Esporta conversazione" title="Esporta conversazione"></button><button id="context-info" class="icon-button" aria-label="Contesto dell'ultima attività" title="Contesto dell'ultima attività"></button></div></header>
      <div id="messages" class="messages" role="log" aria-label="Messaggi" aria-live="off"></div><div class="composer-wrap"><form id="composer" class="composer"><div id="attachments-preview" class="attachments-preview" hidden></div><label class="sr-only" for="message-input">Parla con il tuo orchestratore</label><textarea id="message-input" rows="3" maxlength="100000" placeholder="Descrivi il risultato che vuoi ottenere. Al resto lavoriamo insieme." required></textarea><div class="composer-tools"><button id="attach-file" class="icon-button" type="button" aria-label="Allega un documento" title="Allega un documento"></button><button id="model-picker" class="model-button" type="button" aria-haspopup="dialog"><span id="model-label">Scegli modello e account</span></button><label class="sr-only" for="mode-select">Modalità</label><select id="mode-select"><option value="mission">Squadra</option><option value="chat">Chat</option></select><button id="mission-settings" class="icon-button" type="button" aria-label="Autonomia e limiti" title="Autonomia e limiti"></button><button id="send" class="send" type="submit" aria-label="Invia all'orchestratore"></button><button id="stop" class="send stop" type="button" aria-label="Interrompi attività" hidden></button></div></form><div class="composer-caption"><span id="composer-status">Il contesto resta nel progetto.</span><span class="keyboard-hint">Invio ↵ · A capo ⇧↵</span></div></div></section>
      <aside class="team-panel" aria-label="Squadra di agenti"><header class="team-header"><div class="row spread"><h2 class="row" id="team-title">La tua squadra</h2><button class="icon-button close-team" id="close-team" aria-label="Chiudi squadra"></button></div><p id="team-subtitle">Agenti, modelli e avanzamento in tempo reale.</p></header><div class="team-body" id="team-body"></div><div class="task-detail" id="task-detail" hidden></div><footer class="team-footer"><span id="team-footer-left">Nessuna attività in corso</span><span id="team-footer-right"></span></footer></aside></section><section id="page-view" class="page" hidden></section></div></main></div><div class="toast-stack" id="toasts" role="status" aria-live="polite"></div><input id="file-input" type="file" accept=".md,.txt,.json,.csv,.ts,.tsx,.js,.py,.go,.rs,.yaml,.yml,.toml,.log,text/*,application/json" multiple hidden>`;
    this.installIcons(); this.bind();
    if (api.onSelection) this.disposers.push(api.onSelection(selection => { void this.uploadText(selection.name, selection.content, true); }));
    if (api.onConfigured) this.disposers.push(api.onConfigured(() => { this.loginDialog?.close(); void this.refresh(true); }));
    void this.refresh(true);
  }

  private q<T extends HTMLElement = HTMLElement>(selector: string): T { const node = this.root.querySelector<T>(selector); if (!node) throw new Error(`UI node missing: ${selector}`); return node; }
  private el<K extends ElementTag>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] { const node = this.document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  private icon(name: string): SVGSVGElement { const svg = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); const path = this.document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name] ?? paths.info!); svg.append(path); return svg; }
  private button(label: string, action: () => void | Promise<void>, options: { className?: string; icon?: string; disabled?: boolean; title?: string } = {}): HTMLButtonElement { const button = this.el('button', options.className ?? 'button', label); button.type = 'button'; if (options.icon) button.prepend(this.icon(options.icon)); if (options.disabled) button.disabled = true; if (options.title) { button.title = options.title; if (!label) button.setAttribute('aria-label', options.title); } button.addEventListener('click', () => { void this.perform(button, action); }); return button; }
  private pill(status: string, text?: string): HTMLElement { return this.el('span', `pill ${statusTone(status)}`, text ?? labels[status] ?? status); }
  private field(label: string, input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, note?: string): HTMLElement { const field = this.el('div', 'form-field'); input.id ||= `field-${Math.random().toString(36).slice(2)}`; const labelNode = this.el('label', '', label); labelNode.htmlFor = input.id; field.append(labelNode, input); if (note) field.append(this.el('p', 'fine-print', note)); return field; }
  private input(type: string, value = '', placeholder = ''): HTMLInputElement { const input = this.el('input'); input.type = type; input.value = value; input.placeholder = placeholder; return input; }
  private select(options: Array<{ value: string; label: string }>, value = ''): HTMLSelectElement { const select = this.el('select'); for (const item of options) { const option = this.el('option', '', item.label); option.value = item.value; select.append(option); } select.value = value; return select; }

  private installIcons(): void {
    const ids: Record<string, string> = { 'new-project': 'plus', 'new-conversation': 'plus', 'user-action': this.api.native ? 'settings' : 'logout', 'mobile-menu': 'menu', 'project-settings': 'settings', 'show-team': 'people', 'close-banner': 'close', 'export-conversation': 'download', 'context-info': 'layers', 'attach-file': 'paperclip', 'mission-settings': 'settings', send: 'up', stop: 'stop', 'close-team': 'close' };
    for (const [id, icon] of Object.entries(ids)) this.q(`#${id}`).prepend(this.icon(icon));
    this.q('#team-title').prepend(this.icon('people'));
    const navigation: Record<View, string> = { control: 'grid', infrastructure: 'activity', knowledge: 'book', connections: 'plug', releases: 'rocket' };
    for (const [view, icon] of Object.entries(navigation)) this.q(`[data-view="${view}"]`).prepend(this.icon(icon));
    this.q('#model-picker').append(this.icon('down'));
  }

  private bind(): void {
    this.q('.brand').addEventListener('click', event => { event.preventDefault(); this.setView('control'); });
    this.q('.skip-link').addEventListener('click', event => { event.preventDefault(); this.setView('control'); this.q('#message-input').focus(); });
    if (this.api.native) { this.q('#user-action').setAttribute('aria-label', 'Configura connessione'); this.q('#user-action').title = 'Configura connessione'; }
    for (const item of this.root.querySelectorAll<HTMLButtonElement>('[data-view]')) item.addEventListener('click', () => this.setView(item.dataset.view as View));
    this.q<HTMLSelectElement>('#project-select').addEventListener('change', event => { this.saveDraft(); this.projectId = (event.target as HTMLSelectElement).value; this.conversationId = ''; this.runId = ''; this.taskId = ''; this.chooseConversation(); this.restoreDraft(); this.render(); });
    this.q('#history-search').addEventListener('input', () => this.renderHistory());
    this.q('#new-project').addEventListener('click', () => this.projectDialog());
    this.q('#project-settings').addEventListener('click', () => this.projectDialog(this.project));
    this.q('#new-conversation').addEventListener('click', () => { void this.newConversation(); });
    this.q('#model-picker').addEventListener('click', () => this.modelDialog());
    this.q('#composer').addEventListener('submit', event => { event.preventDefault(); void this.send(); });
    this.q<HTMLTextAreaElement>('#message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.q<HTMLFormElement>('#composer').requestSubmit(); } });
    this.q('#message-input').addEventListener('input', () => this.updateComposer());
    this.q('#mode-select').addEventListener('change', () => this.updateComposer());
    this.q('#stop').addEventListener('click', () => { const run = this.currentRun; if (run) void this.runAction(run, 'cancel'); });
    this.q('#attach-file').addEventListener('click', () => this.attachmentDialog());
    this.q<HTMLInputElement>('#file-input').addEventListener('change', event => { const input = event.target as HTMLInputElement; const files = Array.from(input.files ?? []); input.value = ''; void this.uploadFiles(files); });
    this.q('#mission-settings').addEventListener('click', () => this.autonomyDialog());
    this.q('#context-info').addEventListener('click', () => { const task = this.currentRun?.tasks.findLast(item => item.context); if (task?.context) this.contextDialog(task.context); else this.toast('Il contesto sarà visibile dopo la prima chiamata a un agente.'); });
    this.q('#export-conversation').addEventListener('click', () => { if (this.conversation) void this.downloadJson(`${safeFilename(this.conversation.title)}.json`, this.conversation).catch(error => this.showBanner(errorMessage(error), true)); });
    this.q('#user-action').addEventListener('click', () => { if (this.api.native) this.api.configure?.(); else void this.logout(); });
    this.q('#mobile-menu').addEventListener('click', () => this.q('#shell').classList.toggle('sidebar-open'));
    this.q('#sidebar-backdrop').addEventListener('click', () => this.q('#shell').classList.remove('sidebar-open'));
    this.q('#show-team').addEventListener('click', () => { this.setView('control'); this.q('#shell').classList.toggle('team-open'); });
    this.q('#close-team').addEventListener('click', () => this.q('#shell').classList.remove('team-open'));
    this.q('#close-banner').addEventListener('click', () => { this.q('#banner').hidden = true; });
  }

  get ready(): Promise<void> { return this.loading ?? Promise.resolve(); }
  private get project(): Project | undefined { return this.data?.projects.find(item => item.id === this.projectId); }
  private get conversation(): Conversation | undefined { return this.data?.conversations.find(item => item.id === this.conversationId); }
  private get currentRun(): Run | undefined { return this.data?.runs.find(item => item.id === this.runId) ?? this.data?.runs.filter(item => item.conversationId === this.conversationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; }
  private get canWrite(): boolean { return !!this.data && this.data.user.role !== 'viewer'; }
  private get operator(): boolean { return !!this.data && ['admin', 'operator'].includes(this.data.user.role); }
  private route(id?: string): ModelRoute | undefined { return this.data?.models.find(item => item.id === id); }
  private account(id?: string): Account | undefined { return this.data?.accounts.find(item => item.id === id); }
  private provider(id?: string): Provider | undefined { return this.data?.providers.find(item => item.id === id); }
  private usableRoute(route: ModelRoute, writeRole = false): boolean { const kind = this.provider(route.providerId)?.kind; return route.enabled && !(route.capabilities.includes('embedding') && !route.capabilities.includes('chat')) && (kind !== 'antigravity' || writeRole) && (this.operator || !['codex', 'antigravity'].includes(kind ?? '')); }

  async refresh(initial = false): Promise<void> {
    if (this.disposed) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const data = await this.api.request<Bootstrap>('GET', '/api/bootstrap');
        if (this.disposed) return;
        this.data = data;
        if (!data.projects.some(item => item.id === this.projectId)) this.projectId = data.projects[0]?.id ?? '';
        this.chooseConversation();
        if (!data.models.some(item => item.id === this.routeId && this.usableRoute(item))) { const suggested = this.conversation?.routeId ?? this.project?.routes.primary; this.routeId = data.models.find(item => item.id === suggested && this.usableRoute(item))?.id ?? data.models.find(item => this.usableRoute(item))?.id ?? ''; }
        this.loginDialog?.close(); this.loginDialog = undefined;
        this.render();
        if (!this.subscription) this.subscription = this.api.subscribe(event => this.onEvent(event), connected => { this.connected = connected; this.renderConnection(); if (!connected) this.scheduleRefresh(); });
        if (initial && data.demo) this.showBanner('MODALITÀ DEMO · Dati di esempio dichiarati. Nessuna connessione ai nodi reali.');
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.showLogin();
        else { this.showBanner(errorMessage(error), true); if (initial && this.api.native) this.showLogin(); }
      } finally { this.loading = undefined; }
    })();
    return this.loading;
  }

  private chooseConversation(): void {
    if (!this.data) return;
    const conversations = this.data.conversations.filter(item => item.projectId === this.projectId);
    if (!conversations.some(item => item.id === this.conversationId)) this.conversationId = conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? '';
    if (this.runId && !this.data.runs.some(item => item.id === this.runId && item.conversationId === this.conversationId)) this.runId = '';
  }

  private scheduleRefresh(): void { if (this.refreshTimer || this.disposed) return; this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, 250); }
  private onEvent(event: RunEvent): void {
    if (event.type === 'account.login') { this.loginEvent(event); return; }
    if (!event.type.endsWith('.delta')) { this.events.push(event); if (this.events.length > 300) this.events.splice(0, this.events.length - 300); }
    if (event.type === 'message.delta' && event.data && this.data) {
      const { messageId, delta, offset } = event.data;
      if (typeof messageId === 'string' && typeof delta === 'string') {
        let found = false;
        for (const conversation of this.data.conversations) {
          const message = conversation.messages.find(item => item.id === messageId);
          if (message) {
            found = true;
            if (typeof offset === 'number' && Number.isSafeInteger(offset)) {
              if (offset > message.text.length) { this.scheduleRefresh(); break; }
              if (offset + delta.length <= message.text.length) break;
              message.text += delta.slice(message.text.length - offset);
            } else message.text += delta;
            message.status = 'streaming'; if (conversation.id === this.conversationId) this.renderMessages(); break;
          }
        }
        if (!found) this.scheduleRefresh();
      }
    } else if (event.type === 'task.delta' && event.taskId && typeof event.data?.delta === 'string') {
      const progress = this.taskProgress.get(event.taskId) ?? { text: '', cursor: 0, incomplete: false };
      const offset = typeof event.data.offset === 'number' ? event.data.offset : progress.cursor;
      const delta = event.data.delta;
      if (offset > progress.cursor) { progress.incomplete = true; progress.cursor = offset; }
      if (offset + delta.length > progress.cursor) { progress.text += delta.slice(Math.max(0, progress.cursor - offset)); progress.cursor = offset + delta.length; }
      this.taskProgress.set(event.taskId, progress);
      if (this.taskId === event.taskId) this.renderTaskDetail();
    } else this.scheduleRefresh();
    if (this.taskId && this.taskTab === 'events') this.renderTaskDetail();
  }

  private render(): void {
    if (!this.data) return;
    const projectSelect = this.q<HTMLSelectElement>('#project-select'); projectSelect.replaceChildren();
    if (!this.data.projects.length) { const option = this.el('option', '', 'Crea un progetto'); option.value = ''; projectSelect.append(option); }
    for (const project of this.data.projects) { const option = this.el('option', '', project.name); option.value = project.id; projectSelect.append(option); }
    projectSelect.value = this.projectId;
    this.q('#user-name').textContent = this.data.user.name; this.q('#user-role').textContent = `${roleLabels[this.data.user.role]} · v${this.data.version}`;
    this.q('#user-avatar').textContent = initials(this.data.user.name);
    this.q('#breadcrumb').textContent = `yed1z / ${this.project?.name ?? 'il tuo workspace'}`;
    this.q<HTMLButtonElement>('#new-project').disabled = !this.canWrite;
    this.q<HTMLButtonElement>('#project-settings').disabled = !this.project || !this.canWrite || (this.project.ownerId !== this.data.user.id && this.data.user.role !== 'admin');
    this.q<HTMLButtonElement>('#new-conversation').disabled = !this.project || !this.canWrite;
    for (const view of ['knowledge', 'releases'] as const) {
      const nav = this.q(`[data-view="${view}"]`); nav.querySelector('.dot-badge')?.remove();
      const count = view === 'knowledge' ? this.data.memories.filter(item => item.projectId === this.projectId && item.status === 'candidate').length : this.data.runs.filter(item => item.projectId === this.projectId && item.status === 'awaiting_release').length;
      if (count) { const badge = this.el('span', 'dot-badge', String(count)); badge.setAttribute('aria-label', `${count} elementi in attesa`); nav.append(badge); }
    }
    this.renderConnection(); this.renderFleet(); this.renderHistory(); this.renderMessages(); this.renderTeam(); this.updateComposer(); this.renderAttachments();
    this.renderPage();
  }

  private renderConnection(): void {
    const target = this.q('#connection-state'); target.replaceChildren(); const dot = this.el('i', `status-dot ${this.connected ? 'good' : ''}`);
    target.append(dot, this.document.createTextNode(this.data?.demo ? 'DEMO' : this.connected ? 'LIVE' : 'RICONNESSIONE'));
  }

  private renderFleet(): void {
    const ribbon = this.q('#fleet-ribbon'); ribbon.replaceChildren();
    for (const node of this.data?.nodes ?? []) {
      const telemetry = this.data?.telemetry.find(item => item.nodeId === node.id);
      if (telemetry?.quality === 'measured' && telemetry.observedAt && typeof telemetry.gpuPercent === 'number' && Number.isFinite(telemetry.gpuPercent)) {
        const history = this.telemetryHistory.get(node.id) ?? [];
        if (!history.length || new Date(history.at(-1)!.observedAt).getTime() < new Date(telemetry.observedAt).getTime()) history.push({ observedAt: telemetry.observedAt, gpuPercent: telemetry.gpuPercent });
        if (history.length > 60) history.splice(0, history.length - 60); this.telemetryHistory.set(node.id, history);
      }
      const cell = this.el('button', 'fleet-mini'); cell.type = 'button'; cell.title = `Apri infrastruttura: ${node.label}`;
      const symbol = this.el('span', 'fleet-mini-icon'); symbol.append(this.icon(node.kind === 'cloud' ? 'cloud' : node.kind === 'server' ? 'server' : 'chip'));
      const copy = this.el('div'); const title = this.el('strong'); title.append(this.el('i', `status-dot ${statusTone(telemetry?.status ?? 'unknown')}`), this.document.createTextNode(node.label));
      const metrics = this.el('p', '', `${value(telemetry?.gpuPercent, '%')} GPU · ${value(telemetry?.gpuTempC, '°C')} · ${value(telemetry?.gpuPowerW, ' W')}`);
      if (!telemetry || telemetry.status !== 'online') metrics.textContent = `${labels[telemetry?.status ?? 'unknown']} · ultimo dato ${relativeTime(telemetry?.observedAt)}`;
      copy.append(title, metrics); cell.append(symbol, copy); cell.addEventListener('click', () => this.setView('infrastructure')); ribbon.append(cell);
    }
    const active = this.data?.runs.filter(item => activeRunStatuses.has(item.status)).length ?? 0;
    const cell = this.el('button', 'fleet-mini badged'); cell.type = 'button'; const copy = this.el('div'); copy.append(this.el('strong', '', `${active} ${active === 1 ? 'missione attiva' : 'missioni attive'}`), this.el('p', '', `${this.data?.models.filter(item => item.enabled).length ?? 0} modelli · ${this.data?.approvals.filter(item => item.status === 'pending').length ?? 0} approvazioni`)); cell.append(copy); cell.addEventListener('click', () => this.runsDialog()); ribbon.append(cell);
  }

  private renderHistory(): void {
    const history = this.q('#history'); const query = this.q<HTMLInputElement>('#history-search').value.toLocaleLowerCase(); history.replaceChildren();
    const conversations = this.data?.conversations.filter(item => item.projectId === this.projectId && item.title.toLocaleLowerCase().includes(query)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? [];
    for (const conversation of conversations) {
      const button = this.el('button', `history-item ${conversation.id === this.conversationId ? 'active' : ''}`); button.type = 'button'; button.dataset.conversationId = conversation.id;
      const title = this.el('strong', 'truncate', conversation.title); button.append(title, this.el('small', '', `${relativeTime(conversation.updatedAt)} · ${conversation.messages.length} messaggi`));
      if (conversation.id === this.conversationId) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => { this.saveDraft(); this.conversationId = conversation.id; this.runId = ''; this.taskId = ''; this.restoreDraft(); this.setView('control'); this.render(); }); history.append(button);
    }
    if (!conversations.length) history.append(this.el('p', 'empty', query ? 'Nessuna conversazione trovata.' : 'Le conversazioni di questo progetto compariranno qui.'));
  }

  private renderMessages(): void {
    const messages = this.q('#messages'); const scrollAtBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    messages.replaceChildren();
    const conversation = this.conversation;
    this.q('#conversation-subtitle').textContent = conversation?.title ?? 'Un obiettivo. Una squadra. Tutto sotto controllo.';
    if (!conversation?.messages.length) {
      const welcome = this.el('div', 'welcome'); welcome.append(this.el('div', 'welcome-eyebrow', 'DAL TUO OBIETTIVO ALLA CONSEGNA'));
      const heading = this.el('h2', '', 'Guida il lavoro.'); heading.append(this.el('br'), this.el('span', '', 'La squadra è qui per te.'));
      welcome.append(heading, this.el('p', '', this.project ? `Descrivi ciò che vuoi realizzare in ${this.project.name}. L’orchestratore organizza il lavoro, coordina modelli e agenti e rende visibili risultati, verifiche e decisioni.` : 'Crea un progetto per riunire conversazioni, contesto, documenti e agenti. La tua infrastruttura resta sempre visibile.'));
      const starters = this.el('div', 'welcome-grid');
      for (const entry of [{ title: 'Costruiamo una funzionalità', text: 'Definisci il risultato e i criteri di verifica.', icon: 'code', prompt: 'Voglio realizzare una nuova funzionalità in questo progetto. Aiutami a definire il risultato, poi organizza sviluppo e verifica.' }, { title: 'Analizziamo il progetto', text: 'Comprendi il codice, trova ciò che manca.', icon: 'layers', prompt: 'Analizza questo progetto: individua architettura, problemi e interventi prioritari. Presentami un piano verificabile.' }, { title: 'Risolviamo un problema', text: 'Diagnosi, correzione e test di regressione.', icon: 'activity', prompt: 'Aiutami a diagnosticare e risolvere questo problema. Prima cerca la causa, poi prepara una correzione con una verifica riproducibile.' }, { title: 'Prepariamo una consegna', text: 'Revisione, evidenze e rilascio controllato.', icon: 'rocket', prompt: 'Controlla cosa manca per consegnare questo progetto. Verifica il lavoro ed evidenzia ciò che blocca il rilascio.' }]) {
        const button = this.el('button', 'starter'); button.type = 'button'; const copy = this.el('span'); copy.append(this.el('strong', '', entry.title), this.el('small', '', entry.text)); button.append(this.icon(entry.icon), copy); button.addEventListener('click', () => { this.q<HTMLTextAreaElement>('#message-input').value = entry.prompt; this.q('#message-input').focus(); this.updateComposer(); }); starters.append(button);
      }
      welcome.append(starters); if (!this.project) welcome.append(this.button('Crea il primo progetto', () => this.projectDialog(), { className: 'button primary', icon: 'plus', disabled: !this.canWrite })); messages.append(welcome);
    } else for (const message of conversation.messages) messages.append(this.messageElement(message));
    if (scrollAtBottom) messages.scrollTop = messages.scrollHeight;
  }

  private messageElement(message: ChatMessage): HTMLElement {
    const article = this.el('article', `message ${message.role} ${message.status === 'streaming' ? 'pending' : ''}`); article.dataset.messageId = message.id;
    const meta = this.el('div', 'message-meta'); meta.append(this.el('span', 'message-avatar', message.role === 'user' ? initials(this.data!.user.name) : 'y'), this.el('strong', '', message.role === 'user' ? this.data!.user.name : message.role === 'system' ? 'Progetto' : 'Orchestratore'));
    if (message.routeId) meta.append(this.el('span', 'message-model truncate', this.route(message.routeId)?.label ?? 'Modello precedente'));
    meta.append(this.el('time', 'timestamp', time(message.createdAt))); article.append(meta);
    const body = this.el('div', 'message-body'); body.append(renderMarkdown(this.document, message.text || (message.status === 'streaming' ? 'Preparazione della risposta…' : ''))); article.append(body);
    if (message.attachmentIds?.length) { const files = this.el('div', 'response-metrics'); for (const id of message.attachmentIds) { const artifact = this.data?.artifacts.find(item => item.id === id); files.append(this.button(artifact?.name ?? 'Allegato', () => this.openArtifact(id), { className: 'context-chip', icon: 'file' })); } article.append(files); }
    if (message.metrics) article.append(this.metricsElement(message.metrics));
    if (message.runId) { const run = this.data?.runs.find(item => item.id === message.runId); if (run) { const row = this.el('div', 'response-metrics'); row.append(this.button(`${run.mode === 'mission' ? 'Squadra' : 'Attività'} · ${labels[run.status]}`, () => { this.runId = run.id; this.taskId = ''; this.renderTeam(); this.q('#shell').classList.add('team-open'); }, { className: 'context-chip', icon: 'people' })); article.append(row); } }
    if (message.status === 'error' || message.status === 'cancelled') { const row = this.el('div', 'response-metrics'); row.append(this.pill(message.status, message.status === 'error' ? 'Risposta incompleta' : 'Risposta interrotta')); article.append(row); }
    return article;
  }

  private metricsElement(metrics: ChatMessage['metrics']): HTMLElement {
    const row = this.el('div', 'response-metrics'); if (!metrics) return row;
    const values = [ ['in', metrics.inputTokens, ' token'], ['out', metrics.outputTokens, ' token'], ['cache', metrics.cachedInputTokens, ' token'], ['velocità', metrics.decodeTokensPerSecond, ' tok/s'], ['TTFT', metrics.ttftMs === undefined ? undefined : metrics.ttftMs / 1000, ' s'], ['prefill', metrics.prefillMs === undefined ? undefined : metrics.prefillMs / 1000, ' s'] ] as const;
    for (const [label, amount, suffix] of values) { const text = this.el('span', '', `${label} `); text.append(this.el('b', '', value(amount, suffix))); row.append(text); }
    if (metrics.contextWindow !== undefined) row.append(this.el('span', '', `contesto ${value(metrics.contextUsed)} / ${formatNumber(metrics.contextWindow)}${metrics.contextSource === 'estimated' ? ' · stimato' : ''}`));
    row.title = `Fonte: ${metrics.source}. TTFT osservato dal gateway comprende attesa e rete. Le misure assenti non sono stimate.`;
    return row;
  }

  private updateComposer(): void {
    const active = this.currentRun && !closedRunStatuses.has(this.currentRun.status);
    const route = this.route(this.routeId); const account = this.account(route?.accountId);
    const mode = this.q<HTMLSelectElement>('#mode-select'); const mission = mode.querySelector<HTMLOptionElement>('[value="mission"]')!; mission.disabled = !this.operator; mission.textContent = this.operator ? 'Squadra' : 'Squadra · solo operatori'; if (!this.operator) mode.value = 'chat';
    const chat = mode.querySelector<HTMLOptionElement>('[value="chat"]')!; chat.disabled = this.provider(route?.providerId)?.kind === 'antigravity'; if (chat.disabled && this.operator) mode.value = 'mission';
    this.q<HTMLTextAreaElement>('#message-input').maxLength = active ? 12000 : 100000;
    this.q<HTMLButtonElement>('#mission-settings').disabled = !this.operator;
    mode.title = this.operator ? 'Modalità della prossima attività' : 'Le missioni con esecuzione richiedono un operatore autorizzato.';
    this.q('#model-label').textContent = route ? `${route.label} · ${account?.label ?? 'account'}` : 'Scegli modello e account';
    this.q<HTMLButtonElement>('#send').hidden = false; this.q<HTMLButtonElement>('#stop').hidden = !active;
    this.q<HTMLButtonElement>('#send').setAttribute('aria-label', active ? 'Invia una nuova istruzione alla squadra' : 'Invia all’orchestratore');
    this.q<HTMLButtonElement>('#send').disabled = this.sending || !this.canWrite || !this.project || !route || !this.usableRoute(route) || !this.q<HTMLTextAreaElement>('#message-input').value.trim();
    this.q<HTMLButtonElement>('#stop').disabled = this.sending;
    this.q<HTMLButtonElement>('#attach-file').disabled = !this.project || !this.canWrite;
    this.q('#composer-status').textContent = this.sending ? 'Invio in corso…' : active ? `${labels[this.currentRun!.status]} · il prossimo messaggio guiderà la squadra.` : !this.project ? 'Crea un progetto per iniziare.' : !route ? 'Collega un provider e scegli il modello dell’orchestratore.' : !this.usableRoute(route) ? 'Scegli un modello compatibile con il ruolo di orchestratore.' : account?.status === 'cooldown' ? 'Account in attesa quota. Puoi scegliere un altro account.' : 'Cambio modello dal prossimo messaggio · cronologia condivisa';
  }

  private renderTeam(): void {
    const body = this.q('#team-body'); body.replaceChildren(); const run = this.currentRun;
    const pending = this.data?.approvals.filter(item => item.status === 'pending' && item.projectId === this.projectId && (!run || item.runId === run.id)) ?? [];
    for (const approval of pending) body.append(this.approvalElement(approval));
    if (!run) {
      const empty = this.el('div', 'team-empty'); empty.append(this.icon('people'), this.el('strong', '', 'Dai una direzione alla squadra.'), this.el('p', '', 'Quando avvii una missione, qui vedi chi lavora, con quale modello, da cosa dipende ogni attività e cosa ha prodotto.'));
      body.append(empty); this.q('#task-detail').hidden = true; this.q('#team-footer-left').textContent = 'Nessuna attività in corso'; this.q('#team-footer-right').textContent = ''; return;
    }
    const card = this.el('div', 'run-card'); const header = this.el('div', 'row spread'); header.append(this.el('span', 'eyebrow', run.mode === 'mission' ? 'MISSIONE' : 'CONVERSAZIONE'), this.pill(run.status)); card.append(header, this.el('h3', '', run.goal));
    const complete = run.tasks.filter(item => item.status === 'succeeded').length;
    if (run.tasks.length) { const meter = this.progress(complete / run.tasks.length * 100); meter.classList.add('progress-line'); const copy = this.el('div', 'progress-copy'); copy.append(this.el('span', '', `${complete}/${run.tasks.length} attività`), this.el('span', '', `Iterazione ${run.iteration}/${run.maxIterations}`)); card.append(meter, copy); }
    const controls = this.el('div', 'run-controls');
    if (activeRunStatuses.has(run.status)) controls.append(this.button('Pausa', () => this.runAction(run, 'pause'), { className: 'button small subtle', icon: 'pause', disabled: !this.canWrite }), this.button('Guida', () => this.steerDialog(run), { className: 'button small subtle', icon: 'edit', disabled: !this.canWrite }), this.button('Stop', () => this.runAction(run, 'cancel'), { className: 'button small danger', icon: 'stop', disabled: !this.canWrite }));
    else if (['paused', 'interrupted'].includes(run.status)) controls.append(this.button('Riprendi', () => this.runAction(run, 'resume'), { className: 'button small primary', icon: 'play', disabled: !this.canWrite }), this.button('Annulla', () => this.runAction(run, 'cancel'), { className: 'button small danger', disabled: !this.canWrite }));
    else if (run.status === 'awaiting_release') controls.append(this.button('Esamina la consegna', () => this.setView('releases'), { className: 'button small primary', icon: 'rocket' }), this.button('Annulla', () => this.runAction(run, 'cancel'), { className: 'button small subtle', disabled: !this.canWrite }));
    else if (!closedRunStatuses.has(run.status)) controls.append(this.button('Metti in pausa', () => this.runAction(run, 'pause'), { className: 'button small', icon: 'pause', disabled: !this.canWrite }), this.button('Annulla', () => this.runAction(run, 'cancel'), { className: 'button small danger', disabled: !this.canWrite }));
    if (run.error) card.append(this.el('p', 'fine-print', run.error)); if (controls.childElementCount) card.append(controls); body.append(card);
    const heading = this.el('div', 'section-heading'); heading.append(this.el('span', 'eyebrow', 'AGENTI E DIPENDENZE'), this.el('span', 'fine-print', `max ${run.maxParallel} in parallelo`)); body.append(heading);
    if (run.tasks.length > 1) body.append(this.taskGraph(run));
    const list = this.el('div', 'task-list');
    for (const [index, task] of run.tasks.entries()) {
      const visibleStatus = taskPaused(task) ? 'paused' : task.status;
      const button = this.el('button', `task-card ${visibleStatus} ${task.id === this.taskId ? 'selected' : ''}`); button.type = 'button'; button.dataset.taskId = task.id;
      const role = this.el('div', 'task-role'); role.append(this.el('i', `status-dot ${statusTone(visibleStatus)}`), this.document.createTextNode(roleLabels[task.role] ?? task.role), this.el('span', 'task-number', String(index + 1).padStart(2, '0')));
      const footer = this.el('div', 'task-footer'); footer.append(this.el('span', 'task-model', task.role === 'tester' ? 'Verifiche eseguibili' : task.role === 'release' ? 'Ricetta di rilascio' : this.route(task.routeId)?.label ?? task.routeId), this.el('span', '', labels[visibleStatus] ?? visibleStatus));
      button.append(role, this.el('p', 'task-title', task.label), footer);
      if (task.dependencies.length) button.append(this.el('p', 'task-deps', `Dopo: ${task.dependencies.map(id => run.tasks.find(item => item.id === id)?.label ?? id).join(' · ')}`));
      button.addEventListener('click', () => { this.taskId = task.id; this.renderTeam(); }); list.append(button);
    }
    if (!run.tasks.length) list.append(this.el('p', 'empty', 'L’orchestratore sta preparando il piano di lavoro.'));
    body.append(list);
    this.q('#team-footer-left').textContent = `${run.budget.callsUsed}/${run.budget.maxModelCalls} chiamate`;
    this.q('#team-footer-right').textContent = `${formatNumber(run.budget.outputTokensUsed)} token output`;
    this.renderTaskDetail();
  }

  private renderTaskDetail(): void {
    const target = this.q('#task-detail'); const task = this.currentRun?.tasks.find(item => item.id === this.taskId); target.replaceChildren(); target.hidden = !task; if (!task) return;
    const heading = this.el('div', 'row spread'); heading.append(this.el('h3', '', task.label), this.button('', () => { this.taskId = ''; this.renderTeam(); }, { className: 'icon-button', icon: 'close', title: 'Chiudi dettaglio agente' })); target.append(heading);
    const route = this.route(task.routeId); const account = this.account(route?.accountId); const meta = this.el('dl', 'detail-meta');
    const deterministic = ['tester', 'release'].includes(task.role); const targetConfig = this.data?.targets.find(item => item.id === this.project?.targetId);
    for (const [label, text] of [['Agente', roleLabels[task.role] ?? task.role], [deterministic ? 'Motore' : 'Modello', deterministic ? task.role === 'tester' ? 'Verifica eseguibile' : 'Controller di rilascio' : route?.label ?? task.routeId], ['Account', deterministic ? '—' : account?.label ?? '—'], ['Nodi', deterministic ? this.data?.nodes.find(item => item.id === targetConfig?.nodeId)?.label ?? targetConfig?.nodeId ?? '—' : route?.nodeIds.map(id => this.data?.nodes.find(item => item.id === id)?.label ?? id).join(', ') || 'Provider remoto'], ['Stato', taskPaused(task) ? 'In pausa' : labels[task.status] ?? task.status]]) meta.append(this.el('dt', '', label), this.el('dd', '', text));
    target.append(meta);
    if (!deterministic && (task.status === 'queued' || taskPaused(task))) target.append(this.button('Cambia modello / account', () => this.modelDialog(task), { className: 'text-button', disabled: !this.operator }));
    const individualControl = this.operator && ['researcher', 'coder'].includes(task.role) && this.currentRun?.mode === 'mission' && activeRunStatuses.has(this.currentRun.status) && (taskPaused(task) || ['queued', 'running'].includes(task.status));
    if (individualControl) {
      const controls = this.el('div', 'run-controls agent-controls');
      controls.append(this.button(taskPaused(task) ? 'Riprendi agente' : 'Pausa agente', () => this.taskAction(task, taskPaused(task) ? 'resume' : 'pause'), { className: `button small ${taskPaused(task) ? 'primary' : 'subtle'}`, icon: taskPaused(task) ? 'play' : 'pause' }), this.button('Istruzione', () => this.taskSteerDialog(task), { className: 'button small subtle', icon: 'edit' }), this.button('Annulla', () => this.taskAction(task, 'cancel'), { className: 'button small danger', icon: 'stop', title: 'Annulla questa attività e ferma le attività dipendenti' })); target.append(controls);
    }
    const tabs = this.el('div', 'detail-tabs'); for (const [id, title] of [['output', 'Risultato'], ['events', 'Attività'], ['context', 'Contesto']] as const) tabs.append(this.button(title, () => { this.taskTab = id; this.renderTaskDetail(); }, { className: this.taskTab === id ? 'active' : '' })); target.append(tabs);
    if (this.taskTab === 'output') { const progress = this.taskProgress.get(task.id); const content = this.el('div', 'message-body'); content.style.paddingLeft = '0'; content.append(renderMarkdown(this.document, task.output ?? task.error ?? progress?.text ?? 'Il risultato sarà disponibile al termine dell’attività.')); target.append(content); if (!task.output && progress?.incomplete) target.append(this.el('p', 'fine-print', 'Flusso ripreso dopo una disconnessione. Il risultato completo sarà disponibile al termine.')); }
    else if (this.taskTab === 'events') {
      const events = this.events.filter(item => item.taskId === task.id).slice(-40);
      for (const event of events) { const row = this.el('div', 'event-line'); row.append(this.el('time', '', time(event.createdAt)), this.el('strong', '', event.text ?? event.type)); target.append(row); }
      if (!events.length) target.append(this.el('p', 'fine-print', 'Nessun evento ricevuto per questo agente. Il flusso conserva solo gli eventi autorizzati.'));
    } else if (task.context) target.append(this.contextElement(task.context)); else target.append(this.el('p', 'fine-print', 'Il contesto viene compilato quando l’agente parte.'));
    const evidence = this.data?.evidence.filter(item => task.evidenceIds.includes(item.id)) ?? [];
    if (evidence.length) { target.append(this.el('div', 'eyebrow', 'EVIDENZE')); for (const item of evidence) target.append(this.button(`${item.ok ? '✓' : '!'} ${item.title}`, () => this.textDialog(item.title, item.output), { className: 'text-button' })); }
  }

  private approvalElement(approval: Approval): HTMLElement {
    const card = this.el('div', 'approval-card'); card.dataset.approvalId = approval.id; card.append(this.el('h3', '', approval.title), this.el('p', '', `${approval.kind === 'release' ? 'Rilascio' : 'Azione'} in attesa · scade ${relativeTime(approval.expiresAt)}`), this.el('pre', 'tool-code', approval.detail));
    const buttons = this.el('div', 'row'); for (const approved of [false, true]) buttons.append(this.button(approved ? 'Approva' : 'Nega', async () => { await this.api.request('POST', `/api/approvals/${encodeURIComponent(approval.id)}`, { approved }); await this.refresh(); }, { className: `button small ${approved ? 'primary' : 'subtle'}`, disabled: !this.canWrite || (approval.kind === 'release' && !this.operator) })); card.append(buttons); return card;
  }

  private taskGraph(run: Run): HTMLElement {
    const wrapper = this.el('div', 'task-graph'); const ns = 'http://www.w3.org/2000/svg';
    const svg = this.document.createElementNS(ns, 'svg'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', 'Mappa delle dipendenze della squadra');
    const markerId = `task-arrow-${run.id.replace(/[^a-z0-9_-]/gi, '')}`; const defs = this.document.createElementNS(ns, 'defs'); const marker = this.document.createElementNS(ns, 'marker'); marker.setAttribute('id', markerId); marker.setAttribute('viewBox', '0 0 8 8'); marker.setAttribute('refX', '7'); marker.setAttribute('refY', '4'); marker.setAttribute('markerWidth', '5'); marker.setAttribute('markerHeight', '5'); marker.setAttribute('orient', 'auto'); const arrow = this.document.createElementNS(ns, 'path'); arrow.setAttribute('d', 'M0 0L8 4L0 8z'); arrow.setAttribute('fill', '#3d5c67'); marker.append(arrow); defs.append(marker); svg.append(defs);
    const depths = new Map<string, number>(); const visiting = new Set<string>();
    const depth = (task: AgentTask): number => { if (depths.has(task.id)) return depths.get(task.id)!; if (visiting.has(task.id)) return 0; visiting.add(task.id); const parents = task.dependencies.map(id => run.tasks.find(item => item.id === id)).filter((item): item is AgentTask => !!item); const level = parents.length ? Math.max(...parents.map(item => depth(item))) + 1 : 0; visiting.delete(task.id); depths.set(task.id, level); return level; };
    for (const task of run.tasks) depth(task);
    const levels = Array.from(new Set(depths.values())).sort((a, b) => a - b); const positions = new Map<string, { x: number; y: number }>(); let y = 8;
    for (const level of levels) { const items = run.tasks.filter(task => depths.get(task.id) === level); for (let index = 0; index < items.length; index++) { const row = Math.floor(index / 3); const rowCount = Math.min(3, items.length - row * 3); const x = (280 - rowCount * 84 - (rowCount - 1) * 8) / 2 + (index % 3) * 92; positions.set(items[index]!.id, { x, y: y + row * 47 }); } y += Math.ceil(items.length / 3) * 47 + 9; }
    svg.setAttribute('viewBox', `0 0 280 ${y}`);
    for (const task of run.tasks) for (const dependency of task.dependencies) { const from = positions.get(dependency); const to = positions.get(task.id); if (!from || !to) continue; const line = this.document.createElementNS(ns, 'path'); line.setAttribute('d', `M${from.x + 42},${from.y + 30} C${from.x + 42},${from.y + 42} ${to.x + 42},${to.y - 12} ${to.x + 42},${to.y}`); line.setAttribute('class', 'graph-edge'); line.setAttribute('marker-end', `url(#${markerId})`); svg.append(line); }
    for (const [index, task] of run.tasks.entries()) { const visibleStatus = taskPaused(task) ? 'paused' : task.status; const position = positions.get(task.id)!; const group = this.document.createElementNS(ns, 'g'); group.setAttribute('class', `graph-task ${statusTone(visibleStatus)} ${task.id === this.taskId ? 'selected' : ''}`); group.setAttribute('transform', `translate(${position.x},${position.y})`); group.setAttribute('role', 'button'); group.setAttribute('tabindex', '0'); group.setAttribute('aria-label', `${roleLabels[task.role]}: ${task.label}. ${labels[visibleStatus]}`); const title = this.document.createElementNS(ns, 'title'); title.textContent = `${task.label} · ${labels[visibleStatus]}`; const rect = this.document.createElementNS(ns, 'rect'); rect.setAttribute('width', '84'); rect.setAttribute('height', '30'); rect.setAttribute('rx', '5'); const text = this.document.createElementNS(ns, 'text'); text.setAttribute('x', '42'); text.setAttribute('y', '13'); text.textContent = `${String(index + 1).padStart(2, '0')} ${roleLabels[task.role] ?? task.role}`; const status = this.document.createElementNS(ns, 'text'); status.setAttribute('x', '42'); status.setAttribute('y', '24'); status.setAttribute('class', 'graph-status'); status.textContent = labels[visibleStatus] ?? visibleStatus; group.append(title, rect, text, status); const select = () => { this.taskId = task.id; this.renderTeam(); }; group.addEventListener('click', select); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } }); svg.append(group); }
    wrapper.append(svg); return wrapper;
  }

  private progress(percent?: number): HTMLElement { const meter = this.el('div', 'meter'); if (percent !== undefined && Number.isFinite(percent)) { const fill = this.el('div', `meter-fill ${percent >= 90 ? 'hot' : ''}`); fill.style.width = `${Math.max(0, Math.min(100, percent))}%`; meter.append(fill); } return meter; }
  private setView(view: View): void { this.view = view; this.q('#shell').classList.remove('sidebar-open'); const titles: Record<View, string> = { control: 'Control room', infrastructure: 'Infrastruttura', knowledge: 'Conoscenza del progetto', connections: 'Modelli e account', releases: 'Consegne e rilasci' }; this.q('#page-title').textContent = titles[view]; for (const item of this.root.querySelectorAll<HTMLButtonElement>('[data-view]')) { item.classList.toggle('active', item.dataset.view === view); if (item.dataset.view === view) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); } this.q('#control-view').hidden = view !== 'control'; this.q('#page-view').hidden = view === 'control'; this.renderPage(); }

  private renderPage(): void {
    const page = this.q('#page-view'); if (this.view === 'control' || !this.data) return;
    const active = this.document.activeElement as HTMLInputElement | null;
    const activeId = active && page.contains(active) ? active.id : '';
    const selection = activeId && active?.tagName === 'INPUT' ? [active.selectionStart, active.selectionEnd] : undefined;
    page.replaceChildren();
    if (this.view === 'infrastructure') this.renderInfrastructure(page);
    else if (this.view === 'knowledge') this.renderKnowledge(page);
    else if (this.view === 'connections') this.renderConnections(page);
    else this.renderReleases(page);
    if (activeId) { const replacement = page.querySelector<HTMLInputElement>(`#${activeId}`); if (replacement) { replacement.focus(); if (selection && replacement.type === 'search') replacement.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0); } }
  }

  private pageIntro(title: string, subtitle: string, eyebrow: string, action?: HTMLButtonElement): HTMLElement {
    const intro = this.el('header', 'page-intro'); const copy = this.el('div'); copy.append(this.el('div', 'eyebrow', eyebrow), this.el('h2', '', title), this.el('p', '', subtitle)); intro.append(copy); if (action) intro.append(action); return intro;
  }

  private renderInfrastructure(page: HTMLElement): void {
    page.append(this.pageIntro('Tutta la potenza. Un solo sguardo.', 'Nodi fisici, motori distribuiti e provider restano distinti. Vedi dove gira ogni modello e quali risorse condivide.', 'INFRASTRUTTURA DISTRIBUITA', this.button('Aggiorna telemetria', async () => { await this.api.request('POST', '/api/telemetry/refresh', {}); await this.refresh(); }, { icon: 'refresh' })));
    const grid = this.el('div', 'cards-grid');
    for (const node of this.data!.nodes) {
      const telemetry = this.data!.telemetry.find(item => item.nodeId === node.id);
      const card = this.el('article', 'card node-card'); card.dataset.nodeId = node.id;
      const head = this.el('div', 'row spread'); const copy = this.el('div'); const title = this.el('h3', 'node-title'); title.append(this.icon(node.kind === 'cloud' ? 'cloud' : 'chip'), this.document.createTextNode(node.label)); copy.append(title, this.el('p', 'node-subtitle mono', node.host ?? 'Indirizzo gestito dal server')); head.append(copy, this.pill(telemetry?.status ?? 'unknown')); card.append(head);
      card.append(this.el('p', 'node-hardware', node.kind === 'strix' ? 'AMD Strix Halo · inferenza distribuita' : node.kind === 'cuda' ? 'NVIDIA CUDA · nodo di accelerazione' : node.kind === 'cloud' ? 'Provider esterno · metriche fornite dal servizio' : 'Nodo di coordinamento / esecuzione'));
      const metrics = this.el('div', 'metrics-grid');
      for (const [name, amount, suffix] of [['Utilizzo GPU', telemetry?.gpuPercent, '%'], ['Temperatura GPU', telemetry?.gpuTempC, '°C'], ['Potenza GPU', telemetry?.gpuPowerW, 'W'], ['Utilizzo CPU', telemetry?.cpuPercent, '%']] as const) { const item = this.el('div'); const number = this.el('div', 'metric-value', value(amount)); if (amount !== undefined) number.append(this.el('small', '', suffix)); item.append(number, this.el('div', 'metric-label', name)); metrics.append(item); }
      card.append(metrics);
      const history = this.telemetryHistory.get(node.id) ?? [];
      const chart = this.el('div', 'telemetry-history');
      if (history.length >= 2) {
        const svg = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 250 45'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Utilizzo GPU: ultime ${history.length} misure della sessione`);
        const start = new Date(history[0]!.observedAt).getTime(); const end = new Date(history.at(-1)!.observedAt).getTime();
        const line = this.document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); line.setAttribute('points', history.map(point => `${2 + ((new Date(point.observedAt).getTime() - start) / Math.max(1, end - start)) * 246},${42 - Math.max(0, Math.min(100, point.gpuPercent)) * .39}`).join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '1.5'); svg.append(line); chart.append(svg, this.el('p', 'fine-print', `GPU · ${history.length} misure di questa sessione · scala 0–100%`));
      } else chart.append(this.el('p', 'fine-print', 'Il grafico GPU compare dopo due misure reali.'));
      card.append(chart);
      for (const [name, used, total] of [['RAM', telemetry?.ramUsedBytes, telemetry?.ramTotalBytes], ['Memoria GPU', telemetry?.gpuMemoryUsedBytes, telemetry?.gpuMemoryTotalBytes]] as const) { const row = this.el('div', 'quota-meter'); const label = this.el('div', 'meter-label'); label.append(this.el('span', '', name), this.el('span', 'mono', `${bytes(used)} / ${bytes(total)}`)); row.append(label, this.progress(used === undefined || !total ? undefined : used / total * 100)); card.append(row); }
      const detail = this.el('div', 'node-detail'); detail.append(this.el('div', '', node.capabilities.length ? node.capabilities.join(' · ') : 'Capacità non dichiarate'));
      if (telemetry && telemetry.status !== 'online') detail.append(this.el('p', 'fine-print', 'Sono mostrate le ultime misure disponibili, non uno stato live.'));
      if (telemetry?.quality === 'legacy-unverified') detail.append(this.el('p', 'fine-print', 'Fonte legacy: alcune misure non sono verificate.'));
      if (telemetry?.error) detail.append(this.el('p', 'fine-print', telemetry.error));
      card.append(detail, this.el('p', 'node-time', `Osservato: ${telemetry?.observedAt ? new Date(telemetry.observedAt).toLocaleString('it-IT') : 'mai'} · ${telemetry?.quality === 'measured' ? 'misurato' : 'non verificato'}`)); grid.append(card);
      const interfaces = telemetry?.details?.network;
      const network = this.el('details', 'advanced network-details'); network.append(this.el('summary', '', 'Interfacce e traffico di rete'));
      if (Array.isArray(interfaces) && interfaces.length) {
        const rows = interfaces.filter(item => item && typeof item === 'object').map(item => { const n = item as Record<string, unknown>; return [typeof n.name === 'string' ? n.name : '—', typeof n.up === 'boolean' ? n.up ? 'UP' : 'DOWN' : '—', Array.isArray(n.addresses) ? n.addresses.filter(value => typeof value === 'string').join(', ') : '—', value(n.speedMbps, ' Mbps'), typeof n.rxBytesPerSecond === 'number' ? `${bytes(n.rxBytesPerSecond)}/s` : '—', typeof n.txBytesPerSecond === 'number' ? `${bytes(n.txBytesPerSecond)}/s` : '—', `${value(n.rxErrors)} / ${value(n.txErrors)}`]; });
        network.append(this.table(['Interfaccia', 'Stato', 'Indirizzi', 'Link', 'RX', 'TX', 'Errori RX/TX'], rows), this.el('p', 'fine-print', 'RX/TX derivano da contatori osservati. Il valore Link è la velocità dichiarata dall’interfaccia, non un test di banda.'));
      } else network.append(this.el('p', 'fine-print', 'Nessun campione di rete disponibile per questo nodo.'));
      if (typeof telemetry?.details?.probeMs === 'number') network.append(this.el('p', 'fine-print', `Tempo della richiesta di telemetria: ${value(telemetry.details.probeMs, ' ms')}. Include servizio e trasporto.`));
      card.append(network);
    }
    if (!this.data!.nodes.length) grid.append(this.el('p', 'empty', 'Nessun nodo configurato. L’operatore registra i nodi e gli endpoint nel file di configurazione del servizio.'));
    page.append(grid);
    const section = this.el('section', 'page-section'); const heading = this.el('div', 'section-heading'); heading.append(this.el('h3', '', 'Risorse condivise e parallelismo'), this.el('span', 'fine-print', 'Un modello distribuito riserva tutti i nodi dichiarati')); section.append(heading);
    const pools = this.el('div', 'topology');
    for (const group of this.data!.resourceGroups) { const card = this.el('article', 'pool-card'); const title = this.el('h3'); title.append(this.icon('layers'), this.document.createTextNode(group.label)); const used = this.data!.resourceUsage[group.id] ?? 0; card.append(title, this.el('p', '', `${used}/${group.capacity} slot occupati. Le attività in eccesso attendono la disponibilità delle risorse.`)); const nodes = this.el('div', 'pool-nodes'); for (const nodeId of group.nodeIds) nodes.append(this.pill('unknown', this.data!.nodes.find(item => item.id === nodeId)?.label ?? nodeId)); card.append(nodes); pools.append(card); }
    if (!this.data!.resourceGroups.length) pools.append(this.el('p', 'empty', 'Nessun gruppo di risorse configurato.')); section.append(pools); page.append(section);
    if (this.data!.links.length) {
      const network = this.el('section', 'page-section'); network.append(this.el('div', 'section-heading', 'Collegamenti di rete'));
      network.append(this.table(['Da', 'A', 'Collegamento', 'Indirizzo', 'Fonte'], this.data!.links.map(link => [this.data!.nodes.find(node => node.id === link.from)?.label ?? link.from, this.data!.nodes.find(node => node.id === link.to)?.label ?? link.to, link.label, link.address ?? '—', link.status === 'observed' ? 'Osservato' : link.status === 'configured' ? 'Configurato, da verificare' : 'Da verificare']))); page.append(network);
    }
    const routes = this.el('section', 'page-section'); routes.append(this.el('div', 'section-heading', 'Dove vengono eseguiti i modelli'));
    routes.append(this.table(['Modello', 'Fornitore / account', 'Nodi', 'Risorse', 'Contesto'], this.data!.models.map(model => [model.label, `${this.provider(model.providerId)?.label ?? model.providerId} · ${this.account(model.accountId)?.label ?? ''}`, model.nodeIds.map(id => this.data!.nodes.find(node => node.id === id)?.label ?? id).join(' + ') || 'Provider remoto', model.resourceGroupIds.map(id => this.data!.resourceGroups.find(group => group.id === id)?.label ?? id).join(', ') || 'Nessuna risorsa locale riservata', model.contextWindow ? formatNumber(model.contextWindow) : 'Non dichiarato']))); page.append(routes);
    page.append(this.info('Le connessioni di rete mostrate descrivono la topologia configurata. Non vengono dedotte latenza, banda o raggiungibilità da un semplice nome host. Una metrica assente resta sconosciuta.'));
  }

  private renderKnowledge(page: HTMLElement): void {
    page.append(this.pageIntro('Il progetto ricorda come lavori.', 'Documenti, decisioni e metodi hanno una fonte e uno stato. Il contesto usa soltanto ciò che è autorizzato e pertinente al compito.', 'MEMORIA E CONTESTO', this.button('Aggiungi conoscenza', () => this.memoryDialog(), { className: 'button primary', icon: 'plus', disabled: !this.project || !this.canWrite })));
    const tabs = this.el('div', 'knowledge-tabs');
    for (const [id, text] of [['memories', 'Metodi e decisioni'], ['files', 'Allegati e documenti'], ['search', 'Cerca nel contesto']] as const) tabs.append(this.button(text, () => { this.knowledgeTab = id; this.renderPage(); }, { className: this.knowledgeTab === id ? 'active' : '' })); page.append(tabs);
    if (!this.project) { page.append(this.el('p', 'empty', 'Scegli o crea un progetto per gestirne la conoscenza.')); return; }
    if (this.knowledgeTab === 'memories') {
      const memories = this.data!.memories.filter(item => item.projectId === this.projectId);
      if (!memories.length) page.append(this.info('Aggiungi una procedura, una decisione o il brief del progetto. Le nuove voci vengono proposte come candidate: le rendi disponibili agli agenti quando le approvi.'));
      for (const memory of memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) page.append(this.memoryCard(memory));
    } else if (this.knowledgeTab === 'files') {
      const toolbar = this.el('div', 'page-toolbar'); toolbar.append(this.el('span', 'grow fine-print', 'Testo e Markdown · massimo 1 MiB per documento'), this.button('Carica documenti', () => this.q<HTMLInputElement>('#file-input').click(), { icon: 'upload', disabled: !this.canWrite })); page.append(toolbar);
      const artifacts = this.data!.artifacts.filter(item => item.projectId === this.projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const artifact of artifacts) {
        const card = this.el('article', 'file-card'); const info = this.el('div', 'grow'); info.append(this.el('h3', '', artifact.name), this.el('p', '', `${bytes(artifact.bytes)} · ${relativeTime(artifact.createdAt)} · ${artifact.kind === 'attachment' ? 'Documento' : artifact.kind === 'evidence' ? 'Evidenza' : 'Consegna'}`)); const actions = this.el('div', 'file-actions');
        actions.append(this.button('', () => this.openArtifact(artifact.id), { className: 'icon-button', icon: 'file', title: 'Apri documento' }), this.button('', () => this.downloadArtifact(artifact), { className: 'icon-button', icon: 'download', title: 'Scarica documento' }));
        if (artifact.kind === 'attachment') actions.append(this.button('', () => this.confirm('Dimentica questo allegato?', `Il file “${artifact.name}” verrà eliminato con il suo indice. Un utilizzo attivo ne impedisce la rimozione.`, async () => { await this.api.request('DELETE', `/api/artifacts/${encodeURIComponent(artifact.id)}`); this.selectedAttachments = this.selectedAttachments.filter(item => item.id !== artifact.id); await this.refresh(); }), { className: 'icon-button', icon: 'trash', title: 'Elimina documento', disabled: !this.canWrite }));
        card.append(this.el('div', 'file-icon', artifact.name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'TXT'), info, actions); page.append(card);
      }
      if (!artifacts.length) page.append(this.el('p', 'empty', 'Nessun documento. Carica un Markdown, un brief o un file di testo.'));
    } else {
      const form = this.el('form', 'page-toolbar'); const input = this.input('search', this.searchQuery, 'Cerca una procedura, una decisione, un metodo…'); input.id = 'memory-search'; input.setAttribute('aria-label', 'Cerca nella memoria del progetto'); input.addEventListener('input', () => { this.searchQuery = input.value; }); const submit = this.el('button', 'button primary', 'Cerca'); submit.type = 'submit'; form.append(input, submit); form.addEventListener('submit', event => { event.preventDefault(); void this.perform(submit, async () => { const result = await this.api.request<{ results: Array<{ memory: Memory; score: number; method: string }> }>('POST', '/api/memories/search', { projectId: this.projectId, query: input.value }); this.searchResults = result.results; this.searchQuery = input.value; this.renderPage(); }); }); page.append(form);
      const embedding = this.route(this.project.routes.embedding);
      page.append(this.info(embedding ? `Ricerca lessicale e vettoriale tramite ${embedding.label}. Gli embedding vengono calcolati dal provider configurato; la selezione rispetta sempre i permessi del progetto.` : 'La ricerca lessicale è attiva. Per aggiungere la ricerca vettoriale, scegli una route di embedding nelle impostazioni del progetto. Non vengono generati vettori artificiali.'));
      if (embedding) page.append(this.button('Aggiorna indice vettoriale', async () => { const result = await this.api.request<{ indexed: number; skipped: number }>('POST', `/api/projects/${encodeURIComponent(this.projectId)}/reindex`, {}); this.toast(`${result.indexed} voci indicizzate · ${result.skipped} saltate.`); await this.refresh(); }, { icon: 'refresh', disabled: !this.canWrite }));
      if (this.searchResults) { page.append(this.el('p', 'search-count', `${this.searchResults.length} risultati`)); for (const item of this.searchResults) { const card = this.memoryCard(item.memory); card.append(this.el('p', 'provenance', `${item.method} · punteggio ${value(item.score, '', 3)}`)); page.append(card); } if (!this.searchResults.length) page.append(this.el('p', 'empty', 'Nessuna memoria pertinente trovata.')); }
    }
  }

  private memoryCard(memory: Memory): HTMLElement {
    const card = this.el('article', 'knowledge-card'); card.dataset.memoryId = memory.id; const head = this.el('div', 'row spread'); head.append(this.el('h3', '', memory.title), this.pill(memory.status));
    card.append(head, this.el('div', 'body', memory.content));
    const sources = memory.sourceIds.map(id => this.data!.artifacts.find(item => item.id === id)?.name ?? this.data!.runs.find(item => item.id === id)?.goal ?? id);
    card.append(this.el('p', 'provenance', `Revisione ${memory.revision} · ${memory.kind === 'method' ? 'Metodo di lavoro' : memory.kind === 'decision' ? 'Decisione' : memory.kind === 'brief' ? 'Brief' : 'Documento'} · ${memory.indexed ? 'Indicizzata' : 'Indice lessicale'}${sources.length ? ` · Fonti: ${sources.join(', ')}` : ' · Fonte: inserimento esplicito'}`));
    const actions = this.el('div', 'card-actions');
    if (memory.status === 'candidate') actions.append(this.button('Approva per il contesto', async () => { await this.api.request('PATCH', `/api/memories/${encodeURIComponent(memory.id)}`, { status: 'approved' }); await this.refresh(); }, { className: 'button small primary', icon: 'check', disabled: !this.canWrite }));
    actions.append(this.button('Modifica', () => this.memoryDialog(memory), { className: 'button small subtle', icon: 'edit', disabled: !this.canWrite }), this.button('Dimentica', () => this.confirm('Dimentica questa memoria?', 'Testo, revisioni e vettori di questa voce verranno rimossi. La cronologia della conversazione resta separata.', async () => { await this.api.request('DELETE', `/api/memories/${encodeURIComponent(memory.id)}`); this.searchResults = undefined; await this.refresh(); }), { className: 'button small subtle', icon: 'trash', disabled: !this.canWrite }), this.el('span', 'memory-scope', memory.scope === 'project' ? 'Condivisa nel progetto' : 'Privata')); card.append(actions); return card;
  }

  private renderConnections(page: HTMLElement): void {
    page.append(this.pageIntro('Scegli la risorsa giusta per ogni agente.', 'Collega un provider, trova i suoi modelli e assegna gli account. GemRouter è un fornitore di inferenza selezionabile come gli altri.', 'MODELLI · ACCOUNT · QUOTE', this.button('Collega un account', () => this.connectionDialog(), { className: 'button primary', icon: 'plus', disabled: !this.canWrite })));
    const grid = this.el('div', 'cards-grid');
    for (const provider of this.data!.providers) {
      const card = this.el('article', 'card connection-card'); const heading = this.el('div', 'row'); const copy = this.el('div', 'grow'); copy.append(this.el('h3', '', provider.label), this.el('p', 'provider-kind', `${provider.tag === 'gemrouter' ? 'GemRouter · ' : ''}${provider.kind}`)); heading.append(this.el('div', 'provider-logo', initials(provider.label)), copy, this.pill(provider.enabled ? 'ready' : 'unknown', provider.enabled ? 'Configurato' : 'Disabilitato')); card.append(heading);
      card.append(this.el('p', 'provider-url', provider.baseUrl ?? 'CLI ufficiale sul server · configurazione dell’operatore'));
      const accounts = this.data!.accounts.filter(item => item.providerId === provider.id);
      for (const account of accounts) {
        const accountRow = this.el('div', 'account-row'); accountRow.append(this.el('span', '', `${account.label}${account.shared ? ' · condiviso' : ''}`), this.pill(account.status)); card.append(accountRow, this.quotaElement(account));
        const models = this.data!.models.filter(item => item.accountId === account.id); const tags = this.el('div', 'model-tags'); for (const model of models) tags.append(this.button(model.label, () => this.modelSettingsDialog(model), { className: 'model-tag', disabled: !this.operator, title: this.operator ? 'Configura capacità del modello' : model.model })); card.append(tags);
        const actions = this.el('div', 'card-actions'); actions.append(this.button('Trova modelli', async () => { const result = await this.api.request<{ models: ModelRoute[] }>('POST', `/api/accounts/${encodeURIComponent(account.id)}/discover`, {}); this.toast(`${result.models.length} modelli rilevati.`); await this.refresh(); }, { className: 'button small', icon: 'search', disabled: !this.canWrite || (['codex', 'antigravity'].includes(provider.kind) && !this.operator) }));
        if (provider.kind === 'codex') actions.append(this.button('Accedi a Codex', async () => { await this.api.request('POST', `/api/accounts/${encodeURIComponent(account.id)}/login`, {}); this.toast('Accesso avviato. Attendi le istruzioni del servizio ufficiale.'); }, { className: 'button small subtle', disabled: !this.operator }));
        card.append(actions);
      }
      if (!accounts.length) card.append(this.el('p', 'fine-print', 'Nessun account collegato.'));
      card.append(this.button('Aggiungi account', () => this.connectionDialog(provider), { className: 'text-button', disabled: !this.canWrite || provider.kind === 'antigravity' || (provider.kind === 'codex' && !this.operator) }));
      if (provider.kind === 'antigravity') card.append(this.el('p', 'fine-print', 'Disponibile per il ruolo Sviluppatore, con login della CLI sul server. Orchestratore e revisore richiedono una modalità sola lettura verificata. Quote numeriche e isolamento multiaccount non sono dichiarati dal bridge.'));
      grid.append(card);
    }
    if (!this.data!.providers.length) grid.append(this.el('p', 'empty', 'Collega il primo provider. I modelli del cluster si registrano dalla configurazione dell’operatore.'));
    page.append(grid, this.info('Le quote sono quelle osservate dal provider, con la data dell’ultimo aggiornamento. Una quota sconosciuta non significa illimitata. Il cambio account conserva la conversazione e non ripete automaticamente azioni già eseguite.'));
    if (this.data!.user.role === 'admin') { const section = this.el('section', 'page-section'); const heading = this.el('div', 'section-heading'); heading.append(this.el('h3', '', 'Utenti della control room'), this.button('Gestisci utenti', () => this.usersDialog(), { icon: 'people' })); section.append(heading, this.el('p', 'fine-print', 'Identità, accessi e ruoli sono verificati sul server. Le conversazioni personali restano separate.')); page.append(section); }
  }

  private quotaElement(account: Account): HTMLElement {
    const element = this.el('div', 'quota-meter'); const quota = account.quota;
    if (!quota) { element.append(this.el('p', 'fine-print', 'Quota: non comunicata dal provider')); return element; }
    if (quota.windows?.length) for (const window of quota.windows) { const label = this.el('div', 'meter-label'); label.append(this.el('span', '', window.label), this.el('span', 'mono', window.usedPercent === undefined ? '—' : `${value(Math.max(0, 100 - window.usedPercent), '%')} disponibile`)); element.append(label, this.progress(window.usedPercent === undefined ? undefined : 100 - window.usedPercent)); if (window.resetAt) element.append(this.el('p', 'fine-print', `Reset ${relativeTime(window.resetAt)}`)); }
    if (quota.remainingRequests !== undefined) element.append(this.el('p', 'fine-print', `${formatNumber(quota.remainingRequests)} richieste residue`));
    if (quota.remainingTokens !== undefined) element.append(this.el('p', 'fine-print', `${formatNumber(quota.remainingTokens)} token residui`));
    if (quota.cooldownUntil) element.append(this.el('p', 'fine-print', `Nuovo tentativo ${relativeTime(quota.cooldownUntil)}`));
    const stale = Date.now() - new Date(quota.observedAt).getTime() > 300_000;
    element.append(this.el('p', 'fine-print', `Osservata ${relativeTime(quota.observedAt)}${stale ? ' · dato non recente' : ''}`)); return element;
  }

  private renderReleases(page: HTMLElement): void {
    page.append(this.pageIntro('Una consegna dimostrabile.', 'Risultati, verifiche e rilascio sono passi distinti. Ogni missione conserva le evidenze che permettono di decidere cosa portare in produzione.', 'CONSEGNE E PRODUZIONE'));
    const runs = this.data!.runs.filter(item => item.projectId === this.projectId && item.mode === 'mission').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const run of runs) {
      const card = this.el('article', 'release-card'); const heading = this.el('div', 'row spread'); heading.append(this.el('h3', '', run.goal), this.pill(run.status)); card.append(heading);
      if (run.summary || run.error) card.append(this.el('p', 'release-goal', run.summary ?? run.error));
      const evidence = this.data!.evidence.filter(item => item.runId === run.id); const evidenceList = this.el('div', 'release-evidence');
      for (const item of evidence) { const element = this.el('article', 'evidence-item'); const title = this.el('div', 'row'); title.append(this.el('i', `status-dot ${item.ok ? 'good' : 'error'}`), this.el('strong', '', item.title)); element.append(title, this.el('p', '', `${item.kind} · ${relativeTime(item.createdAt)}`), this.button('Leggi risultato', () => this.textDialog(item.title, item.output), { className: 'text-button' })); evidenceList.append(element); }
      if (!evidence.length) evidenceList.append(this.el('p', 'fine-print', 'Nessuna evidenza registrata. La consegna non è ancora verificata.'));
      card.append(evidenceList);
      const actions = this.el('div', 'row actions'); actions.append(this.button('Apri missione', () => { this.saveDraft(); this.conversationId = run.conversationId; this.runId = run.id; this.taskId = ''; this.restoreDraft(); this.setView('control'); this.render(); }, { icon: 'people', className: 'button small' }));
      if (run.status === 'awaiting_release') actions.append(this.button('Esamina e rilascia', () => this.releaseDialog(run), { icon: 'rocket', className: 'button small primary', disabled: !this.operator || !run.verificationPassed }));
      const label = run.releasedAt ? `Rilascio registrato ${relativeTime(run.releasedAt)}` : run.verificationPassed ? 'Verifica superata' : 'Verifica di produzione non superata'; actions.append(this.el('span', 'fine-print', label)); card.append(actions); page.append(card);
    }
    if (!runs.length) page.append(this.el('p', 'empty', 'Le missioni del progetto compariranno qui con i risultati e le verifiche.'));
    const project = this.project;
    if (project) page.append(this.info(project.deploymentRecipeId ? `Ricetta di rilascio configurata: ${project.deploymentRecipeId}. Il rilascio richiede verifiche riuscite e un’autorizzazione esplicita.` : 'Nessuna ricetta di rilascio configurata per questo progetto. Puoi preparare e verificare il lavoro; l’operatore deve definire un percorso di deploy e controllo dell’esito.'));
  }

  private table(headers: string[], rows: string[][]): HTMLElement { const wrapper = this.el('div', 'table-wrap'); const table = this.el('table', 'data-table'); const thead = this.el('thead'); const header = this.el('tr'); for (const text of headers) header.append(this.el('th', '', text)); thead.append(header); const tbody = this.el('tbody'); for (const values of rows) { const row = this.el('tr'); for (const text of values) row.append(this.el('td', '', text)); tbody.append(row); } if (!rows.length) { const row = this.el('tr'); const cell = this.el('td', 'empty', 'Nessun dato disponibile.'); cell.colSpan = headers.length; row.append(cell); tbody.append(row); } table.append(thead, tbody); wrapper.append(table); return wrapper; }
  private info(text: string): HTMLElement { const info = this.el('div', 'info-card'); info.append(this.icon('info'), this.el('p', '', text)); return info; }

  private modal(title: string, description = '', className = ''): { dialog: HTMLDialogElement; body: HTMLElement } {
    const active = this.document.activeElement as HTMLElement | null;
    const dialog = this.el('dialog', `dialog ${className}`); dialog.setAttribute('aria-label', title);
    const header = this.el('header', 'dialog-header'); const copy = this.el('div'); copy.append(this.el('h2', '', title)); if (description) copy.append(this.el('p', '', description));
    const close = this.button('', () => dialog.close(), { className: 'icon-button', icon: 'close', title: 'Chiudi' }); close.setAttribute('aria-label', 'Chiudi'); header.append(copy, close);
    const body = this.el('div', 'dialog-body'); dialog.append(header, body); this.root.append(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); if (active?.isConnected) active.focus(); });
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    return { dialog, body };
  }

  private showLogin(): void {
    if (this.loginDialog?.isConnected) return;
    this.subscription?.(); this.subscription = undefined;
    const { dialog, body } = this.modal('La tua control room.', '', 'login-dialog'); this.loginDialog = dialog;
    dialog.querySelector('.dialog-header')?.remove(); body.append(this.el('div', 'login-symbol', 'y'), this.el('div', 'eyebrow', 'YED1Z CONTROL ROOM'), this.el('h1', '', 'Tutto il lavoro, connesso.'), this.el('p', 'login-note', 'Accedi al tuo spazio per ritrovare progetti, conversazioni e la tua squadra di agenti.'));
    dialog.addEventListener('cancel', event => event.preventDefault());
    if (this.api.native) {
      body.append(this.el('p', 'fine-print', 'Indirizzo e chiave del gateway si configurano nella finestra sicura di VS Code.'), this.button('Configura connessione', () => this.api.configure?.(), { className: 'button primary full', icon: 'plug' })); return;
    }
    const form = this.el('form'); const token = this.input('password', '', 'Chiave personale del gateway'); token.autocomplete = 'current-password'; token.required = true;
    const submit = this.el('button', 'button primary full', 'Accedi'); submit.type = 'submit';
    const error = this.el('p', 'form-error'); error.hidden = true; error.setAttribute('role', 'alert'); form.append(this.field('Chiave di accesso', token), error, submit); body.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); const secret = token.value; token.value = ''; error.hidden = true; submit.disabled = true;
      void this.api.request('POST', '/api/login', { token: secret }).then(async () => { dialog.close(); this.loginDialog = undefined; await this.refresh(true); }).catch(reason => { error.textContent = errorMessage(reason); error.hidden = false; }).finally(() => { submit.disabled = false; }); });
    token.focus();
  }

  private async logout(): Promise<void> { try { await this.api.request('POST', '/api/logout', {}); this.subscription?.(); this.subscription = undefined; this.data = undefined; this.projectId = ''; this.conversationId = ''; this.runId = ''; this.taskId = ''; this.events = []; this.selectedAttachments = []; this.taskProgress.clear(); this.telemetryHistory.clear(); this.drafts.clear(); this.searchResults = undefined; this.searchQuery = ''; this.root.querySelectorAll('dialog').forEach(dialog => dialog.close()); for (const id of ['history', 'messages', 'team-body', 'page-view', 'fleet-ribbon', 'task-detail', 'project-select', 'attachments-preview']) this.q(`#${id}`).replaceChildren(); this.q<HTMLTextAreaElement>('#message-input').value = ''; this.q('#user-name').textContent = 'Il tuo spazio'; this.q('#user-role').textContent = 'Non connesso'; this.q('#user-avatar').textContent = 'y'; this.q('#breadcrumb').textContent = 'yed1z / il tuo workspace'; this.q('#conversation-subtitle').textContent = ''; this.q('#team-footer-left').textContent = ''; this.q('#team-footer-right').textContent = ''; this.q('#banner').hidden = true; this.updateComposer(); this.showLogin(); } catch (error) { this.showBanner(errorMessage(error), true); } }

  private projectDialog(project?: Project): void {
    if (!this.data || !this.canWrite) return;
    const { dialog, body } = this.modal(project ? 'Impostazioni del progetto' : 'Un posto per il tuo prossimo risultato.', project ? 'Obiettivo, squadra e destinazione restano legati al progetto.' : 'Inizia con un nome e un orchestratore. Le impostazioni avanzate possono aspettare.');
    const form = this.el('form'); const name = this.input('text', project?.name ?? '', 'Per esempio: AIR3, Portale clienti, Nuova API'); name.required = true; name.maxLength = 100;
    const description = this.el('textarea'); description.value = project?.description ?? ''; description.rows = 3; description.placeholder = 'Scopo, convenzioni e criteri di riuscita del progetto';
    const options = [{ value: '', label: 'Scegli al primo messaggio' }, ...this.data.models.filter(item => this.usableRoute(item)).map(item => ({ value: item.id, label: `${item.label} · ${this.account(item.accountId)?.label ?? ''}` }))];
    const primary = this.select(options, project?.routes.primary ?? this.routeId);
    form.append(this.field('Nome del progetto', name), this.field('Orchestratore primario', primary));
    const advanced = this.el('details', 'advanced'); advanced.append(this.el('summary', '', 'Squadra, contesto e destinazione'));
    advanced.append(this.field('Obiettivo e convenzioni', description));
    const roleInputs = {} as Record<'coder' | 'reviewer' | 'researcher' | 'embedding', HTMLSelectElement>;
    const roles = this.el('div', 'form-grid');
    for (const [role, label] of [['coder', 'Sviluppatore'], ['reviewer', 'Revisore'], ['researcher', 'Ricercatore'], ['embedding', 'Embedding per la memoria']] as const) { const choices = role === 'embedding' ? this.data.models.filter(item => item.enabled && item.capabilities.includes('embedding')).map(item => ({ value: item.id, label: `${item.label} · ${this.account(item.accountId)?.label ?? ''}` })) : role === 'coder' ? this.data.models.filter(item => this.usableRoute(item, true)).map(item => ({ value: item.id, label: `${item.label} · ${this.account(item.accountId)?.label ?? ''}` })) : options.slice(1); const input = this.select([{ value: '', label: role === 'embedding' ? 'Solo ricerca lessicale' : 'Come l’orchestratore' }, ...choices], project?.routes[role] ?? ''); roleInputs[role] = input; roles.append(this.field(label, input)); } advanced.append(roles);
    const target = this.select([{ value: '', label: 'Nessuna esecuzione su filesystem' }, ...this.data.targets.map(item => ({ value: item.id, label: item.label }))], project?.targetId ?? '');
    const workspace = this.input('text', project?.workspace ?? '', 'Percorso relativo alla radice autorizzata');
    if (this.operator) advanced.append(this.field('Macchina di esecuzione', target, 'La macchina che esegue i tool può essere diversa da quella che fornisce inferenza.'), this.field('Workspace', workspace, 'Percorso relativo alla radice configurata dall’operatore. Vuoto = radice del target.'));
    else if (project?.targetId) advanced.append(this.info('La destinazione di esecuzione e le verifiche di questo progetto sono gestite da un operatore.'));
    const recipes = this.el('div'); const deployments = this.select([{ value: '', label: 'Nessun rilascio configurato' }], project?.deploymentRecipeId ?? '');
    const renderRecipes = () => { recipes.replaceChildren(); const targetConfig = this.data!.targets.find(item => item.id === target.value); for (const recipe of targetConfig?.commands ?? []) { const label = this.el('label', 'row fine-print'); const checkbox = this.input('checkbox'); checkbox.value = recipe.id; checkbox.checked = project?.verifyRecipeIds.includes(recipe.id) ?? false; checkbox.disabled = !this.operator; label.append(checkbox, this.document.createTextNode(recipe.label)); recipes.append(label); } deployments.replaceChildren(); const none = this.el('option', '', 'Nessun rilascio configurato'); none.value = ''; deployments.append(none); for (const recipe of targetConfig?.deployments ?? []) { const option = this.el('option', '', recipe.label); option.value = recipe.id; deployments.append(option); } deployments.value = project?.deploymentRecipeId ?? ''; deployments.disabled = !this.operator; };
    target.addEventListener('change', renderRecipes); renderRecipes();
    if (this.operator || project?.verifyRecipeIds.length || project?.deploymentRecipeId) { advanced.append(this.el('p', 'field-label', 'Verifiche obbligatorie'), recipes, this.field('Ricetta di rilascio', deployments)); }
    const members = this.input('text', project?.memberIds.join(', ') ?? '', 'ID utenti separati da virgola');
    if (project && this.operator && (project.ownerId === this.data.user.id || this.data.user.role === 'admin')) advanced.append(this.field('Membri del progetto', members, 'I membri condividono risorse e memorie pubblicate del progetto. Le conversazioni personali restano separate.'));
    form.append(advanced);
    const submit = this.el('button', 'button primary full', project ? 'Salva progetto' : 'Crea progetto'); submit.type = 'submit'; const error = this.el('p', 'form-error'); error.hidden = true; form.append(error, submit); body.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); void this.formAction(submit, error, async () => {
      const routes: Project['routes'] = { primary: primary.value }; for (const [role, input] of Object.entries(roleInputs)) routes[role as keyof Project['routes']] = input.value;
      const value: Record<string, unknown> = { name: name.value.trim(), description: description.value.trim(), routes };
      if (this.operator) { value.targetId = target.value; value.workspace = workspace.value.trim(); value.verifyRecipeIds = Array.from(recipes.querySelectorAll<HTMLInputElement>('input:checked')).map(item => item.value); value.deploymentRecipeId = deployments.value; }
      if (project && this.operator && (project.ownerId === this.data!.user.id || this.data!.user.role === 'admin')) value.memberIds = members.value.split(',').map(item => item.trim()).filter(Boolean);
      const saved = await this.api.request<Project>(project ? 'PATCH' : 'POST', project ? `/api/projects/${encodeURIComponent(project.id)}` : '/api/projects', value);
      const changed = saved.id !== this.projectId; if (changed) this.saveDraft(); this.projectId = saved.id; this.routeId = saved.routes.primary ?? this.routeId; if (changed) { this.conversationId = ''; this.runId = ''; } await this.refresh(); dialog.close(); if (changed) this.restoreDraft(); this.setView('control'); this.updateComposer();
    }); }); name.focus();
  }

  private modelDialog(task?: AgentTask): void {
    const { dialog, body } = this.modal(task ? `Modello per ${task.label}` : 'Modello e account', task ? 'Puoi riassegnare un’attività in coda o in pausa.' : 'La scelta vale dal prossimo messaggio. La conversazione resta nel progetto.');
    body.className = ''; const searchWrap = this.el('div', 'model-search'); const search = this.input('search', '', 'Cerca un modello, un account o una macchina…'); search.setAttribute('aria-label', 'Cerca un modello o un account'); searchWrap.append(search); const list = this.el('div', 'model-options'); body.append(searchWrap, list);
    const render = () => { list.replaceChildren(); const query = search.value.toLocaleLowerCase(); const models = this.data?.models.filter(model => this.usableRoute(model, task?.role === 'coder') && `${model.label} ${model.model} ${this.account(model.accountId)?.label} ${this.provider(model.providerId)?.label} ${model.nodeIds.join(' ')}`.toLocaleLowerCase().includes(query)) ?? [];
      for (const model of models) { const account = this.account(model.accountId); const provider = this.provider(model.providerId); const selected = model.id === (task?.routeId ?? this.routeId); const button = this.el('button', `model-option ${selected ? 'selected' : ''}`); button.type = 'button'; button.dataset.routeId = model.id; const check = this.el('span', 'check'); if (selected) check.append(this.icon('check')); const info = this.el('div', 'grow'); info.append(this.el('h3', '', model.label), this.el('p', '', `${provider?.label ?? 'Provider'} · ${account?.label ?? 'Account'}${model.nodeIds.length ? ` · ${model.nodeIds.map(id => this.data?.nodes.find(node => node.id === id)?.label ?? id).join(' + ')}` : ''}`)); const quota = this.el('span', 'option-quota'); quota.append(this.document.createTextNode(account?.quota?.remainingRequests === undefined ? labels[account?.status ?? 'unknown']! : `${formatNumber(account.quota.remainingRequests)} richieste`)); if (account?.quota?.windows?.[0]?.usedPercent !== undefined) quota.textContent = `${value(100 - account.quota.windows[0].usedPercent, '%')} disponibile`; button.append(check, info, quota); button.addEventListener('click', () => { void this.perform(button, async () => { if (task) await this.api.request('POST', `/api/tasks/${encodeURIComponent(task.id)}/route`, { routeId: model.id }); else this.routeId = model.id; dialog.close(); if (task) await this.refresh(); this.updateComposer(); }); }); list.append(button); }
      if (!models.length) list.append(this.el('p', 'empty', 'Nessun modello trovato. Collega un account e verifica i modelli disponibili.'));
    }; search.addEventListener('input', render); render();
    const footer = this.el('footer', 'dialog-footer'); footer.append(this.el('span', '', 'Account e quote restano distinti.'), this.button('Collega un account', () => { dialog.close(); this.connectionDialog(); }, { className: 'text-button', disabled: !this.canWrite })); body.append(footer); search.focus();
  }

  private connectionDialog(existing?: Provider): void {
    if (!this.data || !this.canWrite) return;
    const { dialog, body } = this.modal('Collega un account', 'Scegli il servizio. Verifichiamo la connessione e troviamo i modelli disponibili.'); const form = this.el('form');
    const presets = [ { value: 'ollama', label: 'Ollama · modelli locali' }, { value: 'lmstudio', label: 'LM Studio · modelli locali' }, { value: 'openai-compatible', label: 'Endpoint compatibile OpenAI' }, { value: 'gemrouter', label: 'GemRouter · provider di inferenza' }, { value: 'openai-responses', label: 'OpenAI · API' }, { value: 'gemini', label: 'Gemini · API' }, { value: 'codex', label: 'Codex · accesso ufficiale' } ];
    const options = [ ...this.data.providers.filter(item => item.kind !== 'antigravity' && (this.operator || item.kind !== 'codex')).map(item => ({ value: `existing:${item.id}`, label: `${item.label} · nuovo account` })), ...(this.operator ? presets : []) ];
    const service = this.select(options, existing ? `existing:${existing.id}` : this.operator ? 'ollama' : options[0]?.value ?? '');
    const providerName = this.input('text', '', 'Nome della connessione'); const url = this.input('url'); const label = this.input('text', '', 'Personale, Lavoro, Account 2…'); label.required = true; label.maxLength = 80;
    const secret = this.input('password'); secret.autocomplete = 'off'; const nativeSecret = this.input('checkbox'); const shared = this.input('checkbox');
    const urlField = this.field('Indirizzo del servizio', url, 'Deve essere raggiungibile dal server yed1z, anche quando usi VS Code.');
    const secretField = this.api.native ? this.el('label', 'row fine-print') : this.field('API key, se richiesta', secret);
    if (this.api.native) secretField.append(nativeSecret, this.document.createTextNode('Inserisci l’API key nella richiesta sicura di VS Code'));
    const note = this.el('p', 'fine-print');
    form.append(this.field('Servizio', service), note, urlField, this.field('Nome dell’account', label), secretField);
    const advanced = this.el('details', 'advanced'); advanced.append(this.el('summary', '', 'Nome e risorse della connessione'), this.field('Nome del provider', providerName));
    const nodeChecks = this.el('div'); const groupChecks = this.el('div');
    for (const node of this.data.nodes) { const row = this.el('label', 'row fine-print'); const check = this.input('checkbox'); check.value = node.id; row.append(check, this.document.createTextNode(node.label)); nodeChecks.append(row); }
    for (const group of this.data.resourceGroups) { const row = this.el('label', 'row fine-print'); const check = this.input('checkbox'); check.value = group.id; row.append(check, this.document.createTextNode(group.label)); groupChecks.append(row); }
    if (this.operator) { advanced.append(this.el('p', 'fine-print', 'Nodi che forniscono inferenza'), nodeChecks, this.el('p', 'fine-print', 'Risorse da riservare durante le richieste'), groupChecks); const row = this.el('label', 'row fine-print'); row.append(shared, this.document.createTextNode('Rendi questo account disponibile agli utenti autorizzati')); advanced.append(row); }
    form.append(advanced); const error = this.el('p', 'form-error'); error.hidden = true; const submit = this.el('button', 'button primary full', 'Verifica e trova modelli'); submit.type = 'submit'; form.append(error, submit); body.append(form);
    let createdProviderId: string | undefined; let createdAccountId: string | undefined;
    const apply = () => { const chosen = this.data!.providers.find(item => service.value === `existing:${item.id}`); const kind = chosen?.kind ?? service.value; const cli = ['codex', 'antigravity'].includes(kind); urlField.hidden = !!chosen || cli; providerName.disabled = !!chosen; nodeChecks.hidden = !!chosen || cli; groupChecks.hidden = !!chosen || cli; secretField.hidden = cli; const defaults: Record<string, string> = { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234/v1', 'openai-responses': 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta', gemrouter: '', 'openai-compatible': '' }; url.value = chosen?.baseUrl ?? defaults[service.value] ?? ''; url.required = !chosen && !cli; providerName.value = chosen?.label ?? presets.find(item => item.value === service.value)?.label.split(' · ')[0] ?? ''; note.textContent = cli ? kind === 'codex' ? 'La CLI ufficiale Codex deve essere installata sul server. Creiamo un profilo isolato e avviamo l’accesso ufficiale; dopo il login usa Trova modelli.' : 'Usa l’account Antigravity già autenticato nella CLI sul server. Account isolati multipli non supportati.' : 'Un provider può esporre più modelli. Li rileveremo senza aggiungerli uno per uno.'; submit.textContent = kind === 'codex' ? 'Collega e accedi a Codex' : 'Verifica e trova modelli'; createdProviderId = undefined; createdAccountId = undefined; };
    const changeService = () => { secret.value = ''; nativeSecret.checked = false; const cli = service.value === 'codex' || this.data!.providers.some(item => service.value === `existing:${item.id}` && ['codex', 'antigravity'].includes(item.kind)); shared.disabled = cli; if (cli) { shared.checked = false; for (const check of [...nodeChecks.querySelectorAll<HTMLInputElement>('input'), ...groupChecks.querySelectorAll<HTMLInputElement>('input')]) check.checked = false; } apply(); };
    service.addEventListener('change', changeService); changeService();
    if (!options.length) { submit.disabled = true; note.textContent = 'L’operatore deve prima configurare almeno un provider.'; }
    form.addEventListener('submit', event => { event.preventDefault(); void this.formAction(submit, error, async () => {
      const chosen = this.data!.providers.find(item => service.value === `existing:${item.id}`);
      if (!createdProviderId) {
        if (chosen) createdProviderId = chosen.id;
        else {
          const kind = ['lmstudio', 'gemrouter'].includes(service.value) ? 'openai-compatible' : service.value;
          const provider = await this.api.request<Provider>('POST', '/api/providers', { label: providerName.value.trim() || 'Provider', kind, ...(kind === 'codex' ? {} : { baseUrl: url.value.trim() }), tag: service.value === 'gemrouter' ? 'gemrouter' : ['ollama', 'lmstudio'].includes(service.value) ? 'local' : 'cloud', nodeIds: Array.from(nodeChecks.querySelectorAll<HTMLInputElement>('input:checked')).map(item => item.value), resourceGroupIds: Array.from(groupChecks.querySelectorAll<HTMLInputElement>('input:checked')).map(item => item.value) }); createdProviderId = provider.id;
        }
      }
      if (!createdAccountId) { const data: Record<string, unknown> = { providerId: createdProviderId, label: label.value.trim(), shared: this.operator && shared.checked }; if (this.api.native && nativeSecret.checked) data.requestSecret = true; else if (!this.api.native && secret.value) data.secret = secret.value; secret.value = ''; const account = await this.api.request<Account>('POST', '/api/accounts', data); createdAccountId = account.id; }
      if ((chosen?.kind ?? service.value) === 'codex') { await this.api.request('POST', `/api/accounts/${encodeURIComponent(createdAccountId)}/login`, {}); dialog.close(); await this.refresh(); this.toast('Account creato. Attendi le istruzioni di accesso ufficiali.'); return; }
      const discovered = await this.api.request<{ models: ModelRoute[] }>('POST', `/api/accounts/${encodeURIComponent(createdAccountId)}/discover`, {}); await this.refresh(); dialog.close(); if (!this.routeId) this.routeId = discovered.models[0]?.id ?? ''; this.updateComposer(); this.toast(`Account collegato · ${discovered.models.length} modelli rilevati.`);
    }); });
  }

  private modelSettingsDialog(model: ModelRoute): void {
    if (!this.operator) return;
    const { dialog, body } = this.modal('Capacità del modello', 'Dichiara soltanto limiti e funzionalità verificati sul motore.'); const form = this.el('form'); const label = this.input('text', model.label); const context = this.input('number', model.contextWindow?.toString() ?? '', 'Non dichiarato'); context.min = '4096'; context.max = '2000000'; const capabilities = this.el('div');
    for (const capability of ['chat', 'tools', 'embedding', 'vision']) { const row = this.el('label', 'row fine-print'); const check = this.input('checkbox'); check.value = capability; check.checked = model.capabilities.includes(capability); row.append(check, this.document.createTextNode(capability === 'chat' ? 'Conversazione' : capability === 'tools' ? 'Chiamata di tool verificata' : capability === 'embedding' ? 'Embedding' : 'Visione dichiarata dal provider')); capabilities.append(row); }
    form.append(this.field('Nome visibile', label), this.field('Finestra di contesto, token', context), capabilities);
    const submit = this.el('button', 'button primary full', 'Salva capacità'); submit.type = 'submit'; const error = this.el('p', 'form-error'); error.hidden = true; form.append(error, submit); body.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); void this.formAction(submit, error, async () => { const enabled = Array.from(capabilities.querySelectorAll<HTMLInputElement>('input:checked')).map(item => item.value); await this.api.request('PATCH', `/api/models/${encodeURIComponent(model.id)}`, { label: label.value.trim(), ...(context.value ? { contextWindow: Number(context.value) } : {}), capabilities: enabled }); dialog.close(); await this.refresh(); }); });
  }

  private memoryDialog(memory?: Memory): void {
    if (!this.project) return;
    const { dialog, body } = this.modal(memory ? 'Aggiorna conoscenza' : 'Aggiungi conoscenza', 'Le nuove voci sono candidate. L’approvazione le rende disponibili al contesto degli agenti.');
    const form = this.el('form'); const title = this.input('text', memory?.title ?? '', 'Per esempio: Come prepariamo una release'); title.required = true; title.maxLength = 200;
    const content = this.el('textarea'); content.value = memory?.content ?? ''; content.required = true; content.rows = 8; content.maxLength = 300_000; content.placeholder = 'Procedura, decisione o regola di lavoro con informazioni verificabili…';
    const kind = this.select([{ value: 'method', label: 'Metodo di lavoro' }, { value: 'decision', label: 'Decisione' }, { value: 'brief', label: 'Brief del progetto' }, { value: 'document', label: 'Documento' }], memory?.kind ?? 'method'); kind.disabled = !!memory;
    const scope = this.select([{ value: 'private', label: 'Solo per me' }, { value: 'project', label: 'Condivisa nel progetto' }], memory?.scope ?? 'private');
    form.append(this.field('Titolo', title), this.field('Contenuto', content), this.field('Tipo', kind), this.field('Visibilità', scope, 'La condivisione richiede i permessi del progetto. Nessun dato viene promosso a memoria personale in modo nascosto.'));
    const source = this.select([{ value: '', label: 'Inserimento esplicito' }, ...this.data!.artifacts.filter(item => item.projectId === this.projectId).map(item => ({ value: item.id, label: item.name }))], memory?.sourceIds[0] ?? ''); if (!memory) form.append(this.field('Documento di origine', source));
    const error = this.el('p', 'form-error'); error.hidden = true; const submit = this.el('button', 'button primary full', memory ? 'Salva revisione' : 'Crea proposta'); submit.type = 'submit'; form.append(error, submit); body.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); void this.formAction(submit, error, async () => { await this.api.request(memory ? 'PATCH' : 'POST', memory ? `/api/memories/${encodeURIComponent(memory.id)}` : '/api/memories', memory ? { title: title.value.trim(), content: content.value, scope: scope.value } : { projectId: this.projectId, title: title.value.trim(), content: content.value, kind: kind.value, scope: scope.value, sourceIds: source.value ? [source.value] : [] }); await this.refresh(); dialog.close(); }); });
  }

  private autonomyDialog(): void {
    const { dialog, body } = this.modal('Autonomia della prossima missione', 'La squadra lavora entro questi limiti. Puoi intervenire in ogni momento.');
    const form = this.el('form'); const checks: Record<string, HTMLInputElement> = {};
    for (const [id, label] of [['write', 'Autorizza modifiche nel workspace del progetto'], ['commands', 'Autorizza le ricette di comando configurate'], ['deploy', 'Consenti il percorso di rilascio configurato']] as const) { const row = this.el('label', 'row fine-print'); const input = this.input('checkbox'); input.checked = this.autonomy[id]; if (id === 'deploy') input.disabled = !this.operator; checks[id] = input; row.append(input, this.document.createTextNode(label)); form.append(row); }
    form.append(this.info('Le azioni non già autorizzate restano soggette a richiesta puntuale. Il rilascio viene valutato sui risultati delle verifiche e sulla ricetta configurata.'));
    const parallel = this.input('number', String(this.autonomy.maxParallel)); parallel.min = '1'; parallel.max = '6'; parallel.required = true; const iterations = this.input('number', String(this.autonomy.maxIterations)); iterations.min = '1'; iterations.max = '6'; iterations.required = true;
    const grid = this.el('div', 'form-grid'); grid.append(this.field('Agenti in parallelo', parallel, 'La capacità dei nodi può ridurre il parallelismo effettivo.'), this.field('Iterazioni massime', iterations, 'Quando raggiunge il limite, la squadra si ferma con un resoconto.')); form.append(grid);
    const submit = this.el('button', 'button primary full', 'Usa questi limiti'); submit.type = 'submit'; form.append(submit); body.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); this.autonomy = { write: checks.write!.checked, commands: checks.commands!.checked, deploy: this.operator && checks.deploy!.checked, maxParallel: Number(parallel.value), maxIterations: Number(iterations.value) }; dialog.close(); this.toast('Limiti aggiornati per la prossima missione.'); });
  }

  private async newConversation(): Promise<Conversation | undefined> {
    if (!this.projectId || !this.canWrite) return;
    try { const conversation = await this.api.request<Conversation>('POST', '/api/conversations', { projectId: this.projectId, routeId: this.routeId || undefined }); this.saveDraft(); this.conversationId = conversation.id; this.runId = ''; this.taskId = ''; await this.refresh(); this.restoreDraft(); this.setView('control'); this.updateComposer(); this.q('#message-input').focus(); return conversation; }
    catch (error) { this.showBanner(errorMessage(error), true); return; }
  }

  private runsDialog(): void {
    const { dialog, body } = this.modal('Le tue missioni', 'Tutti i progetti, gli agenti attivi e le decisioni in attesa.');
    const runs = [...(this.data?.runs ?? [])].sort((a, b) => Number(activeRunStatuses.has(b.status)) - Number(activeRunStatuses.has(a.status)) || b.updatedAt.localeCompare(a.updatedAt));
    for (const run of runs.slice(0, 40)) {
      const button = this.el('button', 'model-option'); button.type = 'button'; const copy = this.el('div', 'grow'); copy.append(this.el('h3', '', run.goal), this.el('p', '', `${this.data?.projects.find(item => item.id === run.projectId)?.name ?? 'Progetto'} · ${run.tasks.length} attività · ${relativeTime(run.updatedAt)}`)); button.append(copy, this.pill(run.status));
      button.addEventListener('click', () => { this.saveDraft(); this.projectId = run.projectId; this.conversationId = run.conversationId; this.runId = run.id; this.taskId = ''; this.restoreDraft(); dialog.close(); this.setView('control'); this.render(); this.q('#shell').classList.add('team-open'); }); body.append(button);
    }
    if (!runs.length) body.append(this.el('p', 'empty', 'Nessuna missione avviata. Descrivi un obiettivo al tuo orchestratore per cominciare.'));
    const pending = this.data?.approvals.filter(item => item.status === 'pending') ?? [];
    if (pending.length) { body.append(this.el('div', 'section-heading', 'Decisioni in attesa')); for (const approval of pending) body.append(this.approvalElement(approval)); }
  }

  private async send(): Promise<void> {
    if (this.sending || !this.canWrite || !this.project || !this.routeId) return;
    const input = this.q<HTMLTextAreaElement>('#message-input'); const text = input.value.trim(); if (!text) return;
    const active = this.currentRun && !closedRunStatuses.has(this.currentRun.status);
    if (!active && this.q<HTMLSelectElement>('#mode-select').value === 'mission' && (!this.project.targetId || !this.project.verifyRecipeIds.length)) { this.toast('Per avviare la squadra, scegli workspace e verifiche del progetto. La bozza resta qui.'); this.projectDialog(this.project); const advanced = this.root.querySelector<HTMLDetailsElement>('dialog details'); if (advanced) advanced.open = true; return; }
    this.sending = true; this.updateComposer();
    try {
      if (active) { await this.api.request('POST', `/api/runs/${encodeURIComponent(this.currentRun!.id)}/steer`, { text, attachmentIds: this.selectedAttachments.map(item => item.id) }); input.value = ''; this.selectedAttachments = []; this.saveDraft(); await this.refresh(); this.renderAttachments(); this.toast('Indicazione salvata. La missione si mette in pausa: usa Riprendi per ripianificare.'); return; }
      if (!this.conversationId) { const conversation = await this.api.request<Conversation>('POST', '/api/conversations', { projectId: this.projectId, routeId: this.routeId }); this.conversationId = conversation.id; }
      const run = await this.api.request<Run>('POST', `/api/conversations/${encodeURIComponent(this.conversationId)}/messages`, { text, routeId: this.routeId, mode: this.q<HTMLSelectElement>('#mode-select').value, attachmentIds: this.selectedAttachments.map(item => item.id), permissions: { write: this.autonomy.write, commands: this.autonomy.commands, deploy: this.autonomy.deploy }, maxIterations: this.autonomy.maxIterations, maxParallel: this.autonomy.maxParallel });
      this.runId = run.id; this.taskId = ''; input.value = ''; this.selectedAttachments = []; this.saveDraft(); await this.refresh(); this.renderAttachments(); this.setView('control');
    } catch (error) { this.showBanner(errorMessage(error), true); }
    finally { this.sending = false; this.updateComposer(); }
  }

  private async runAction(run: Run, action: 'pause' | 'resume' | 'cancel'): Promise<void> { try { await this.api.request('POST', `/api/runs/${encodeURIComponent(run.id)}/${action}`, {}); await this.refresh(); } catch (error) { this.showBanner(errorMessage(error), true); } }
  private async taskAction(task: AgentTask, action: 'pause' | 'resume' | 'cancel'): Promise<void> { await this.api.request('POST', `/api/tasks/${encodeURIComponent(task.id)}/${action}`, {}); if (action === 'resume') this.taskProgress.delete(task.id); await this.refresh(); }
  private taskSteerDialog(task: AgentTask): void { const { dialog, body } = this.modal(`Guida ${roleLabels[task.role] ?? 'l’agente'}`, 'L’istruzione riguarda questa attività. Se l’agente è al lavoro viene messo in pausa; gli altri rami indipendenti possono continuare.'); const form = this.el('form'); const text = this.el('textarea'); text.rows = 5; text.required = true; text.maxLength = 12000; text.placeholder = 'Indica cosa deve cambiare in questa attività…'; const error = this.el('p', 'form-error'); error.hidden = true; const submit = this.el('button', 'button primary full', 'Invia all’agente'); submit.type = 'submit'; form.append(this.field(task.label, text), error, submit); body.append(form); form.addEventListener('submit', event => { event.preventDefault(); void this.formAction(submit, error, async () => { await this.api.request('POST', `/api/tasks/${encodeURIComponent(task.id)}/steer`, { text: text.value }); await this.refresh(); dialog.close(); }); }); text.focus(); }
  private saveDraft(): void { if (!this.projectId) return; this.drafts.set(`${this.projectId}/${this.conversationId || 'new'}`, { text: this.q<HTMLTextAreaElement>('#message-input').value, attachmentIds: this.selectedAttachments.map(item => item.id), routeId: this.routeId }); if (this.drafts.size > 100) this.drafts.delete(this.drafts.keys().next().value!); }
  private restoreDraft(): void { const draft = this.drafts.get(`${this.projectId}/${this.conversationId || 'new'}`); this.q<HTMLTextAreaElement>('#message-input').value = draft?.text ?? ''; this.selectedAttachments = this.data?.artifacts.filter(item => item.projectId === this.projectId && draft?.attachmentIds.includes(item.id)) ?? []; this.routeId = draft?.routeId ?? this.conversation?.routeId ?? this.project?.routes.primary ?? this.data?.models.find(item => item.enabled)?.id ?? ''; }
  private steerDialog(run: Run): void { const { dialog, body } = this.modal('Guida la squadra', 'L’istruzione viene conservata. La missione si mette in pausa; premi Riprendi per ripianificare il lavoro.'); const form = this.el('form'); const text = this.el('textarea'); text.rows = 5; text.required = true; text.maxLength = 12000; const submit = this.el('button', 'button primary full', 'Invia istruzione'); submit.type = 'submit'; const error = this.el('p', 'form-error'); error.hidden = true; form.append(this.field('Nuova indicazione', text), error, submit); body.append(form); form.addEventListener('submit', event => { event.preventDefault(); void this.formAction(submit, error, async () => { await this.api.request('POST', `/api/runs/${encodeURIComponent(run.id)}/steer`, { text: text.value }); dialog.close(); await this.refresh(); }); }); text.focus(); }

  private releaseDialog(run: Run): void {
    const project = this.data!.projects.find(item => item.id === run.projectId); const target = this.data!.targets.find(item => item.id === project?.targetId);
    const { dialog, body } = this.modal('Rilascio in produzione', 'Approvi questa consegna e la ricetta configurata, con le evidenze registrate.');
    body.append(this.el('h3', '', run.goal), this.el('p', 'fine-print', `Target: ${target?.label ?? 'Non configurato'} · Ricetta: ${project?.deploymentRecipeId ?? 'Non configurata'}`));
    for (const evidence of this.data!.evidence.filter(item => item.runId === run.id)) { const row = this.el('p', 'fine-print'); row.textContent = `${evidence.ok ? '✓' : '!'} ${evidence.title}`; body.append(row); }
    body.append(this.info('Il servizio eseguirà la ricetta autorizzata sul target indicato e ne registrerà l’esito. La produzione sarà dichiarata riuscita soltanto dopo i controlli previsti.'));
    const error = this.el('p', 'form-error'); error.hidden = true; body.append(error);
    const button = this.button('Autorizza questo rilascio', () => this.formAction(button, error, async () => { await this.api.request('POST', `/api/runs/${encodeURIComponent(run.id)}/release`, {}); dialog.close(); await this.refresh(); }), { className: 'button primary full', icon: 'rocket', disabled: !this.operator || !run.verificationPassed || !project?.deploymentRecipeId }); body.append(button);
  }

  private attachmentDialog(): void {
    if (!this.project) return;
    const { dialog, body } = this.modal('Aggiungi contesto al messaggio', 'Carica un documento o riutilizza un allegato del progetto.');
    body.append(this.button('Carica file di testo o Markdown', () => { dialog.close(); this.q<HTMLInputElement>('#file-input').click(); }, { className: 'button primary full', icon: 'upload' }));
    if (this.api.native && this.api.attachSelection) body.append(this.button('Allega la selezione di VS Code', () => { dialog.close(); this.api.attachSelection?.(); }, { className: 'button full', icon: 'code' }));
    const files = this.data!.artifacts.filter(item => item.projectId === this.projectId && item.kind === 'attachment');
    for (const file of files) body.append(this.button(file.name, () => { if (!this.selectedAttachments.some(item => item.id === file.id)) this.selectedAttachments.push(file); this.renderAttachments(); dialog.close(); }, { className: 'model-option', icon: 'file' }));
    body.append(this.el('p', 'fine-print', 'Massimo 1 MiB per documento. I documenti restano associati al progetto e sono accessibili solo agli utenti autorizzati.'));
  }

  private async uploadFiles(files: File[]): Promise<void> {
    for (const file of files) {
      try { if (file.size > 1024 * 1024) throw new Error(`${file.name}: supera il limite di 1 MiB.`); const content = await file.text(); if (content.includes('\0') || content.includes('\ufffd')) throw new Error(`${file.name}: usa un file di testo UTF-8.`); await this.uploadText(file.name, content, this.view === 'control'); }
      catch (error) { this.showBanner(errorMessage(error), true); }
    }
  }

  private async uploadText(name: string, content: string, attach: boolean): Promise<void> {
    if (!this.projectId) { this.toast('Scegli prima un progetto.', true); return; }
    try { const artifact = await this.api.request<Artifact>('POST', '/api/artifacts', { projectId: this.projectId, name, content, kind: 'attachment' }); if (attach && !this.selectedAttachments.some(item => item.id === artifact.id)) this.selectedAttachments.push(artifact); await this.refresh(); this.renderAttachments(); this.toast(`Documento aggiunto: ${artifact.name}`); }
    catch (error) { this.showBanner(errorMessage(error), true); }
  }

  private renderAttachments(): void { const container = this.q('#attachments-preview'); container.replaceChildren(); container.hidden = !this.selectedAttachments.length; for (const artifact of this.selectedAttachments) { const chip = this.el('span', 'attachment-chip'); chip.append(this.icon('file'), this.el('span', 'truncate', artifact.name), this.button('', () => { this.selectedAttachments = this.selectedAttachments.filter(item => item.id !== artifact.id); this.renderAttachments(); }, { className: 'icon-button', icon: 'close', title: `Rimuovi ${artifact.name} dal prossimo messaggio` })); container.append(chip); } }
  private async openArtifact(id: string): Promise<void> { const value = await this.api.request<Artifact & { content: string }>('GET', `/api/artifacts/${encodeURIComponent(id)}`); this.textDialog(value.name, value.content); }
  private async downloadArtifact(artifact: Artifact): Promise<void> { const value = await this.api.request<Artifact & { content: string }>('GET', `/api/artifacts/${encodeURIComponent(artifact.id)}`); await this.downloadText(artifact.name, value.content, 'text/plain;charset=utf-8'); }

  private contextElement(report: ContextReport): HTMLElement { const fragment = this.el('div'); fragment.append(this.el('p', 'context-summary', `${formatNumber(report.estimatedTokens)} token stimati / ${formatNumber(report.budgetTokens)} disponibili · ${formatNumber(report.reservedOutputTokens)} riservati alla risposta. ${report.truncated ? 'Alcune fonti sono state escluse o ridotte.' : 'Le fonti selezionate rientrano nel budget.'}`)); const list = this.el('ul', 'context-list'); for (const source of report.sources) { const item = this.el('li'); const copy = this.el('span', '', `${source.included ? '✓' : '−'} ${source.title}`); copy.append(this.el('p', 'fine-print', source.reason)); item.append(copy, this.el('small', '', `${formatNumber(source.estimatedTokens)} tok`)); list.append(item); } fragment.append(list, this.el('p', 'fine-print', `Stima: ${report.estimator}. L’occupazione del contesto non equivale alla memoria GPU o alla KV cache.`)); return fragment; }
  private contextDialog(report: ContextReport): void { const { body } = this.modal('Il contesto dell’agente', 'Fonti incluse, esclusioni e budget della richiesta.'); body.append(this.contextElement(report)); }
  private textDialog(title: string, text: string): void { const { body } = this.modal(title); const content = this.el('div', 'message-body'); content.style.paddingLeft = '0'; content.append(renderMarkdown(this.document, text)); body.append(content); }

  private async usersDialog(): Promise<void> {
    const result = await this.api.request<{ users: Array<{ id: string; name: string; role: string }> } | Array<{ id: string; name: string; role: string }>>('GET', '/api/users'); const users = Array.isArray(result) ? result : result.users;
    const { dialog, body } = this.modal('Utenti della control room', 'Ogni persona ha una chiave distinta e un ruolo verificato sul server.'); body.append(this.table(['Nome', 'Ruolo', 'ID'], users.map(item => [item.name, roleLabels[item.role] ?? item.role, item.id])));
    const form = this.el('form'); const name = this.input('text', '', 'Nome della persona'); name.required = true; const role = this.select([{ value: 'member', label: 'Membro · progetti e agenti' }, { value: 'viewer', label: 'Osservatore · sola lettura' }, { value: 'operator', label: 'Operatore · infrastruttura e rilasci' }, { value: 'admin', label: 'Amministratore' }], 'member'); const error = this.el('p', 'form-error'); error.hidden = true; const submit = this.el('button', 'button primary full', 'Crea utente'); submit.type = 'submit'; form.append(this.field('Nome', name), this.field('Ruolo', role), error, submit); body.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); void this.formAction(submit, error, async () => { const result = await this.api.request<{ user: { name: string }; token: string }>('POST', '/api/users', { name: name.value, role: role.value }); dialog.close(); const secret = this.modal('Chiave del nuovo utente', `Chiave di ${result.user.name}. Copiala ora e consegnala alla persona tramite un canale appropriato.`); const input = this.input('text', result.token); input.readOnly = true; input.setAttribute('aria-label', 'Chiave personale mostrata una sola volta'); secret.body.append(input, this.el('p', 'fine-print', 'Questa chiave viene mostrata una sola volta e non sarà inclusa nello storico della chat.')); input.select(); }); });
  }

  private loginEvent(event: RunEvent): void {
    const data = event.data; if (!data) return;
    if (data.status === 'complete') { this.accountLoginDialog?.close(); this.accountLoginDialog = undefined; this.toast('Accesso completato. Usa Trova modelli per aggiornare il catalogo.'); this.scheduleRefresh(); return; }
    if (data.status === 'error') { this.accountLoginDialog?.close(); this.accountLoginDialog = undefined; this.showBanner(typeof data.message === 'string' ? data.message : 'Accesso non riuscito.', true); return; }
    if (typeof data.verificationUri !== 'string' && typeof data.userCode !== 'string') return;
    this.accountLoginDialog?.close(); const { dialog, body } = this.modal('Accedi con il servizio ufficiale', 'Completa l’autorizzazione nel sito del provider. I codici sono temporanei e non entrano nella cronologia.'); this.accountLoginDialog = dialog;
    if (typeof data.userCode === 'string') { const code = this.input('text', data.userCode); code.readOnly = true; code.setAttribute('aria-label', 'Codice temporaneo di accesso'); body.append(code); }
    if (typeof data.verificationUri === 'string') { try { const url = new URL(data.verificationUri); if (url.protocol === 'https:' && !url.username && !url.password) { if (this.api.native && this.api.openAuth) body.append(this.button('Apri autorizzazione ufficiale', () => this.api.openAuth?.(url.href), { className: 'button primary full' })); else { const link = this.el('a', 'button primary full', 'Apri autorizzazione ufficiale'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link); } } } catch { /* Invalid login links are not navigable. */ } }
    body.append(this.el('p', 'fine-print', 'La finestra si aggiornerà quando il servizio confermerà l’accesso.'));
  }

  private confirm(title: string, detail: string, action: () => Promise<void>): void { const { dialog, body } = this.modal(title, detail); const error = this.el('p', 'form-error'); error.hidden = true; const actions = this.el('div', 'dialog-actions'); const confirm = this.button('Conferma', () => this.formAction(confirm, error, async () => { await action(); dialog.close(); }), { className: 'button danger' }); actions.append(this.button('Annulla', () => dialog.close(), { className: 'button subtle' }), confirm); body.append(error, actions); }
  private async formAction(button: HTMLButtonElement, error: HTMLElement, action: () => Promise<void>): Promise<void> { button.disabled = true; error.hidden = true; try { await action(); } catch (reason) { error.textContent = errorMessage(reason); error.hidden = false; } finally { button.disabled = false; } }
  private async perform(button: HTMLButtonElement, action: () => void | Promise<void>): Promise<void> { if (button.disabled) return; button.disabled = true; try { await action(); } catch (error) { this.showBanner(errorMessage(error), true); } finally { if (button.isConnected) button.disabled = false; } }
  private toast(text: string, error = false): void { const toast = this.el('div', `toast ${error ? 'error' : ''}`, text); this.q('#toasts').append(toast); setTimeout(() => toast.remove(), 5500); }
  private showBanner(message: string, error = false): void { const banner = this.q('#banner'); banner.hidden = false; banner.classList.toggle('error', error); this.q('#banner > span').textContent = message; }
  private async downloadJson(name: string, value: unknown): Promise<void> { await this.downloadText(name, JSON.stringify(value, null, 2), 'application/json'); }
  private async downloadText(name: string, text: string, mime: string): Promise<void> { if (this.api.native && this.api.saveFile) { await this.api.saveFile(name, text, mime); this.toast('Esportazione salvata.'); return; } const url = URL.createObjectURL(new Blob([text], { type: mime })); const link = this.el('a'); link.href = url; link.download = safeFilename(name); this.root.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  dispose(): void { this.disposed = true; this.subscription?.(); if (this.refreshTimer) clearTimeout(this.refreshTimer); for (const dispose of this.disposers) dispose(); this.api.dispose?.(); this.root.replaceChildren(); }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Operazione non riuscita.'; }
function taskPaused(task: AgentTask): boolean { return 'control' in task && task.control === 'paused'; }
function statusTone(status: string): string { return ['online', 'succeeded', 'ready', 'approved'].includes(status) ? 'good' : ['running', 'executing', 'planning', 'reviewing', 'verifying', 'deploying', 'streaming'].includes(status) ? 'active' : ['paused', 'blocked', 'cooldown', 'stale', 'pending', 'awaiting_release', 'candidate', 'interrupted'].includes(status) ? 'warning' : ['failed', 'error', 'offline', 'denied', 'expired'].includes(status) ? 'error' : ''; }
function value(input: unknown, suffix = '', digits = 1): string { return typeof input === 'number' && Number.isFinite(input) ? `${formatNumber(input, digits)}${suffix}` : '—'; }
function formatNumber(input: number, digits = 0): string { return input.toLocaleString('it-IT', { maximumFractionDigits: digits }); }
function bytes(input?: number): string { if (input === undefined || !Number.isFinite(input)) return '—'; if (input < 1024) return `${input} B`; if (input < 1024 ** 2) return `${formatNumber(input / 1024, 1)} KB`; if (input < 1024 ** 3) return `${formatNumber(input / 1024 ** 2, 1)} MB`; return `${formatNumber(input / 1024 ** 3, 1)} GB`; }
function initials(name: string): string { return name.trim().split(/\s+/).slice(0, 2).map(item => item.charAt(0).toUpperCase()).join('') || 'y'; }
function time(date?: string): string { if (!date) return '—'; const value = new Date(date); return Number.isFinite(value.getTime()) ? value.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '—'; }
function relativeTime(date?: string): string { if (!date) return 'mai'; const timestamp = new Date(date).getTime(); if (!Number.isFinite(timestamp)) return '—'; const seconds = Math.round((timestamp - Date.now()) / 1000); const relative = new Intl.RelativeTimeFormat('it-IT', { numeric: 'auto' }); if (Math.abs(seconds) < 60) return seconds > 0 ? 'tra poco' : 'ora'; if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), 'minute'); if (Math.abs(seconds) < 86400) return relative.format(Math.round(seconds / 3600), 'hour'); return relative.format(Math.round(seconds / 86400), 'day'); }
function safeFilename(input: string): string { return input.replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 80) || 'conversazione'; }

if (typeof document !== 'undefined') { const root = document.getElementById('app'); if (root && !root.dataset.mounted) { root.dataset.mounted = 'true'; mountApp(root, createApi()); } }
