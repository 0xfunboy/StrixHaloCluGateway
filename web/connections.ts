import type { Bootstrap, Provider } from '../src/contracts.ts';
import type { ConnectionResult as ConnectResult, ConnectionDetection } from '../src/connection-types.ts';
import type { ClientApi } from './api.ts';

interface WizardOptions {
  body: HTMLElement; dialog: HTMLDialogElement; api: ClientApi; data: Bootstrap; existing?: Provider;
  connected(result: ConnectResult, selectedRoute?: string): Promise<void>;
  login(accountId: string): Promise<void>;
}

const presets = [
  { id: 'codex', label: 'Codex', detail: 'Accedi con il tuo account', mark: '>_', url: '' },
  { id: 'antigravity', label: 'Antigravity', detail: 'Collega la CLI ufficiale', mark: 'A', url: '' },
  { id: 'openai', label: 'OpenAI API', detail: 'Basta la tua API key', mark: 'OAI', url: 'https://api.openai.com/v1' },
  { id: 'gemini', label: 'Gemini API', detail: 'Basta la tua API key', mark: '✦', url: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'ollama', label: 'Ollama', detail: 'Modelli sulla tua rete', mark: 'OL', url: 'http://127.0.0.1:11434' },
  { id: 'lmstudio', label: 'LM Studio', detail: 'Modelli sulla tua rete', mark: 'LM', url: 'http://127.0.0.1:1234/v1' },
  { id: 'gemrouter', label: 'GemRouter', detail: 'Un altro fornitore di inferenza', mark: 'GR', url: '' },
  { id: 'custom', label: 'Altro endpoint', detail: 'API compatibile OpenAI', mark: 'API', url: '' },
];

export function mountConnectionWizard(options: WizardOptions): void {
  const { body, dialog, api, data } = options, document = body.ownerDocument;
  const operator = ['admin', 'operator'].includes(data.user.role);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  const input = (type: string, placeholder = '') => { const node = element('input'); node.type = type; node.placeholder = placeholder; return node; };
  const field = (label: string, control: HTMLElement, help?: string) => {
    const wrapper = element('label', 'form-field'); wrapper.append(element('span', 'field-label', label), control);
    if (help) wrapper.append(element('span', 'fine-print', help)); return wrapper;
  };
  const form = element('form', 'connection-wizard'); body.append(form);
  const choice = element('select', 'provider-select'); choice.setAttribute('aria-label', 'Servizio da collegare');
  for (const provider of data.providers.filter(item => operator || !['codex', 'antigravity'].includes(item.kind))) {
    const option = element('option', '', `${provider.label} · altro account`); option.value = `existing:${provider.id}`; choice.append(option);
  }
  if (operator) for (const preset of presets) { const option = element('option', '', preset.label); option.value = preset.id; choice.append(option); }
  const choices = element('div', 'provider-tiles'); choices.setAttribute('aria-label', 'Scegli il provider');
  if (operator) for (const preset of presets) {
    const button = element('button', 'provider-tile'); button.type = 'button'; button.dataset.preset = preset.id;
    const copy = element('span'); copy.append(element('strong', '', preset.label), element('small', '', preset.detail));
    button.append(element('span', 'provider-mark', preset.mark), copy); button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => { choice.value = preset.id; apply(); }); choices.append(button);
  }
  choice.value = options.existing ? `existing:${options.existing.id}` : operator ? 'codex' : choice.options[0]?.value ?? '';
  const selected = element('div', 'connect-selected');
  const existingChoices = element('details', 'advanced existing-connections');
  existingChoices.append(element('summary', '', 'Usa una connessione già configurata'), field('Connessione', choice));
  existingChoices.open = !!options.existing || !operator;
  if (!data.providers.length && operator) existingChoices.hidden = true;
  form.append(element('p', 'wizard-step', '01 / SCEGLI LA CONNESSIONE'), choices, existingChoices, selected);
  const detection = element('div', 'connection-detection');
  const detect = element('button', 'button subtle full', 'Rileva servizi locali e configurati'); detect.type = 'button';
  const detected = element('div', 'detected-services'); detected.setAttribute('aria-live', 'polite');
  if (operator) { detection.append(detect, detected); selected.before(detection); }
  const url = input('url', 'http://macchina:porta/v1'); url.setAttribute('aria-label', 'Indirizzo del servizio');
  const urlField = field('Indirizzo del servizio', url, 'Raggiungibile dal coordinator yed1z, anche quando usi VS Code.');
  const secret = input('password', 'Incolla la API key'); secret.autocomplete = 'off'; secret.setAttribute('aria-label', 'API key');
  const requestSecret = input('checkbox'); requestSecret.checked = api.native;
  const secretField = api.native ? field('API key', requestSecret, 'Richiedi la chiave nella finestra protetta di VS Code.') : field('API key, se richiesta', secret, 'Salvata in forma cifrata sul coordinator.');
  const accountLabel = input('text', 'Personale, Lavoro, Account 2…'); accountLabel.maxLength = 80;
  const providerLabel = input('text'); providerLabel.maxLength = 120;
  const modelIds = input('text', 'modello-a, modello-b');
  const shared = input('checkbox');
  const advanced = element('details', 'advanced connect-advanced'); advanced.append(element('summary', '', 'Personalizza nome, modelli e risorse'));
  advanced.append(field('Nome account facoltativo', accountLabel, 'Se lo lasci vuoto viene creato un nome automatico.'), field('Nome connessione', providerLabel), field('ID modelli manuali, facoltativi', modelIds, 'Solo per servizi senza discovery. Gli ID restano dichiarati e non verificati.'));
  const nodeChecks = element('div', 'resource-checkboxes');
  const groupChecks = element('div', 'resource-checkboxes');
  for (const node of data.nodes) { const check = input('checkbox'); check.value = node.id; nodeChecks.append(field(node.label, check)); }
  for (const group of data.resourceGroups) { const check = input('checkbox'); check.value = group.id; groupChecks.append(field(group.label, check)); }
  if (operator) advanced.append(field('Account condiviso con gli utenti autorizzati', shared), element('p', 'fine-print', 'Nodi di inferenza'), nodeChecks, element('p', 'fine-print', 'Risorse esclusive da prenotare'), groupChecks);
  const error = element('p', 'form-error'); error.hidden = true; error.setAttribute('role', 'alert');
  const progress = element('div', 'connection-progress'); progress.hidden = true; progress.setAttribute('role', 'status');
  const resultPanel = element('section', 'connection-result'); resultPanel.hidden = true; resultPanel.setAttribute('aria-live', 'polite');
  const submit = element('button', 'button primary full', 'Continua'); submit.type = 'submit';
  form.append(element('p', 'wizard-step', '02 / COLLEGA E TROVA I MODELLI'), urlField, secretField, advanced, progress, resultPanel, error, submit);
  let requestId = newId(), accountId: string | undefined, providerId: string | undefined, pending = false, detecting = false, generation = 0, nodesChanged = false, groupsChanged = false;
  const current = (attempt: number) => dialog.isConnected && dialog.open && generation === attempt;
  dialog.addEventListener('close', () => { generation++; });
  nodeChecks.addEventListener('change', () => { nodesChanged = true; });
  groupChecks.addEventListener('change', () => { groupsChanged = true; });
  function apply(): void {
    if (pending) return;
    generation++; nodesChanged = false; groupsChanged = false;
    detected.replaceChildren();
    const existing = data.providers.find(provider => choice.value === `existing:${provider.id}`);
    const preset = presets.find(preset => preset.id === choice.value);
    const kind = existing?.kind ?? choice.value, native = ['codex', 'antigravity'].includes(kind);
    requestId = newId(); accountId = undefined; providerId = existing?.id; secret.value = ''; resultPanel.hidden = true; error.hidden = true;
    for (const tile of choices.querySelectorAll<HTMLButtonElement>('[data-preset]')) { const active = tile.dataset.preset === choice.value; tile.classList.toggle('selected', active); tile.setAttribute('aria-pressed', String(active)); }
    selected.replaceChildren(element('strong', '', existing?.label ?? preset?.label ?? 'Scegli un servizio'), element('p', '', kind === 'codex' ? 'Usa il login ufficiale. Non servono URL o API key.' : kind === 'antigravity' ? 'Verifichiamo la CLI e il profilo sul coordinator. Se serve il login, qui troverai il comando ufficiale.' : 'Una connessione, tutti i modelli rilevati.'));
    url.value = existing?.baseUrl ?? preset?.url ?? ''; url.required = !native && !existing; urlField.hidden = native || !!existing || ['openai', 'gemini'].includes(choice.value);
    secretField.hidden = native; shared.disabled = native; if (native) shared.checked = false;
    nodeChecks.hidden = native || !!existing; groupChecks.hidden = native || !!existing;
    for (const check of nodeChecks.querySelectorAll<HTMLInputElement>('input')) check.checked = existing?.nodeIds.includes(check.value) ?? false;
    for (const check of groupChecks.querySelectorAll<HTMLInputElement>('input')) check.checked = existing?.resourceGroupIds.includes(check.value) ?? false;
    modelIds.closest('label')!.hidden = native; providerLabel.disabled = !!existing;
    providerLabel.value = existing?.label ?? preset?.label ?? '';
    if (existing) accountLabel.value = `Account ${data.accounts.filter(account => account.providerId === existing.id).length + 1}`;
    submit.textContent = kind === 'codex' ? 'Accedi con Codex' : kind === 'antigravity' ? 'Collega Antigravity' : 'Collega e trova modelli';
    submit.disabled = !choice.value;
  }
  choice.addEventListener('change', apply); apply();
  url.addEventListener('input', () => { if (pending) return; generation++; requestId = newId(); accountId = undefined; providerId = data.providers.find(provider => choice.value === `existing:${provider.id}`)?.id; resultPanel.hidden = true; });
  detect.addEventListener('click', () => {
    if (pending || detecting) return;
    detecting = true; const attempt = generation;
    detect.disabled = true; detected.replaceChildren(element('p', 'fine-print', 'Verifico gli indirizzi locali noti e le connessioni configurate dal coordinator…'));
    void api.request<ConnectionDetection>('POST', '/api/connections/detect', {}).then(result => {
      if (!current(attempt) || pending) return;
      detected.replaceChildren(element('p', 'fine-print', result.scope));
      for (const candidate of result.candidates.filter(candidate => candidate.status !== 'unavailable')) {
        const button = element('button', 'detected-service'); button.type = 'button';
        button.append(element('strong', '', candidate.label), element('span', '', `${candidate.modelCount} modelli · ${candidate.status === 'standby' ? 'In standby' : 'Rilevato'}`), element('small', '', candidate.baseUrl));
        button.addEventListener('click', () => { if (pending) return; choice.value = candidate.providerId && data.providers.some(provider => provider.id === candidate.providerId) ? `existing:${candidate.providerId}` : candidate.preset; apply(); url.value = candidate.baseUrl; selected.scrollIntoView?.({ block: 'nearest' }); }); detected.append(button);
      }
      if (!result.candidates.some(candidate => candidate.status !== 'unavailable')) detected.append(element('p', 'fine-print', 'Nessun servizio rilevato. Puoi inserire l’indirizzo del tuo nodo scegliendo un provider locale.'));
    }).catch(reason => { if (current(attempt) && !pending) detected.replaceChildren(element('p', 'fine-print', message(reason))); }).finally(() => { detecting = false; if (dialog.isConnected && dialog.open) detect.disabled = pending; });
  });
  async function showResult(result: ConnectResult): Promise<void> {
    accountId = result.account.id; providerId = result.provider.id;
    resultPanel.replaceChildren(); resultPanel.hidden = false;
    const success = result.status === 'ready' || result.status === 'standby';
    resultPanel.classList.toggle('success', success);
    resultPanel.append(element('h3', '', success ? `${result.models.length} modelli collegati` : 'Completa il collegamento'), element('p', '', result.message));
    for (const warning of result.warnings ?? []) resultPanel.append(element('p', 'fine-print', warning));
    if (result.status === 'login-required' && result.nextAction?.kind === 'login') {
      dialog.close(); await options.login(result.account.id); return;
    }
    if (result.nextAction?.command) { const code = element('pre', 'connect-command', result.nextAction.command); code.setAttribute('aria-label', 'Comando ufficiale da eseguire sul coordinator'); resultPanel.append(code); }
    if (result.nextAction?.docsUrl) {
      try { const url = new URL(result.nextAction.docsUrl); if (url.protocol === 'https:' && !url.username && !url.password) { const link = element('a', 'text-button', 'Istruzioni ufficiali'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; resultPanel.append(link); } } catch { /* malformed link is not navigable */ }
    }
    if (result.models.length) {
      const list = element('div', 'connected-models');
      for (const model of result.models) {
        const button = element('button', 'connected-model'); button.type = 'button'; button.dataset.connectedModel = model.id;
        button.append(element('span', '', model.label), element('small', '', result.status === 'unverified' ? 'Dichiarato · da verificare' : model.capabilities.includes('embedding') && !model.capabilities.includes('chat') ? 'Embedding' : result.provider.kind === 'antigravity' ? 'Usa per sviluppatore' : 'Usa questo modello ↗'));
        button.addEventListener('click', () => { button.disabled = true; void options.connected(result, model.id).then(() => dialog.close()).catch(reason => { error.textContent = message(reason); error.hidden = false; button.disabled = false; }); }); list.append(button);
      }
      resultPanel.append(list);
      const done = element('button', 'button full', 'Fatto, torna al progetto'); done.type = 'button'; done.addEventListener('click', () => { done.disabled = true; void options.connected(result).then(() => dialog.close()).catch(reason => { error.textContent = message(reason); error.hidden = false; done.disabled = false; }); }); resultPanel.append(done);
    }
    submit.textContent = result.nextAction?.label ?? 'Verifica di nuovo';
    resultPanel.scrollIntoView?.({ block: 'nearest' });
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (pending) return;
    pending = true; const attempt = generation;
    const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')).map(control => ({ control, disabled: control.disabled }));
    for (const { control } of controls) control.disabled = true;
    error.hidden = true; progress.hidden = false;
    progress.textContent = ['codex', 'antigravity'].includes(choice.value) ? 'Controllo della CLI e dell’accesso in corso…' : 'Verifica della connessione e ricerca dei modelli…';
    for (const button of choices.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true; choice.disabled = true;
    const existing = data.providers.find(provider => choice.value === `existing:${provider.id}`);
    const preset = existing ? existing.kind === 'openai-responses' ? 'openai' : ['openai-compatible', 'cluster'].includes(existing.kind) ? existing.tag === 'gemrouter' ? 'gemrouter' : 'custom' : existing.kind : choice.value;
    const native = ['codex', 'antigravity'].includes(preset);
    const payload: Record<string, unknown> = { preset, requestId, ...(providerId ? { providerId } : {}), ...(accountId ? { accountId } : {}), label: providerLabel.value.trim(), accountLabel: accountLabel.value.trim(), ...(!native ? { baseUrl: url.value.trim(), modelIds: modelIds.value.split(',').map(value => value.trim()).filter(Boolean) } : {}), shared: operator && !native && shared.checked };
    if (operator && !nodeChecks.hidden && nodesChanged) payload.nodeIds = Array.from(nodeChecks.querySelectorAll<HTMLInputElement>('input:checked')).map(input => input.value);
    if (operator && !groupChecks.hidden && groupsChanged) payload.resourceGroupIds = Array.from(groupChecks.querySelectorAll<HTMLInputElement>('input:checked')).map(input => input.value);
    if (!native && api.native && requestSecret.checked) payload.requestSecret = true;
    else if (!native && !api.native && secret.value) payload.secret = secret.value;
    secret.value = '';
    void api.request<ConnectResult>('POST', '/api/connections', payload).then(result => current(attempt) ? showResult(result) : undefined).catch(reason => { if (current(attempt)) { error.textContent = message(reason); error.hidden = false; } }).finally(() => { if (!current(attempt)) return; pending = false; for (const { control, disabled } of controls) control.disabled = disabled; detect.disabled = detecting; progress.hidden = true; });
  });
}

function newId(): string { return globalThis.crypto?.randomUUID?.() ?? `connect-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function message(error: unknown): string { return error instanceof Error ? error.message : 'Collegamento non riuscito.'; }
