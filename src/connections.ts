import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import type { Account, ModelRoute, Project, Provider, Run, User } from './contracts.ts';
import type { ConnectionDetection, ConnectionInput, ConnectionOptions, ConnectionPreset, ConnectionPresetId, ConnectionResult, PublicConnectionProvider } from './connection-types.ts';
import { Catalog } from './catalog.ts';
import { discoverModels } from './adapters/index.ts';
import { nativeAccountBusy } from './adapters/native.ts';
import { AppError, assert, endpoint, hash, id, now, object, safeError, str, textList } from './util.ts';

const PRESETS: ConnectionPreset[] = [
  { id: 'codex', label: 'Codex', kind: 'codex', authentication: 'device-login', docsUrl: 'https://developers.openai.com/codex/cli', description: 'Accesso ufficiale con un profilo privato per account.' },
  { id: 'antigravity', label: 'Antigravity', kind: 'antigravity', authentication: 'runtime-login', docsUrl: 'https://antigravity.google/docs/ide/extensions/acp', description: 'Profilo ufficiale della CLI sul coordinator, con modelli rilevati via ACP.' },
  { id: 'openai', label: 'OpenAI API', kind: 'openai-responses', authentication: 'api-key', defaultUrl: 'https://api.openai.com/v1', description: 'Chiave API e discovery dei modelli.' },
  { id: 'gemini', label: 'Gemini API', kind: 'gemini', authentication: 'api-key', defaultUrl: 'https://generativelanguage.googleapis.com/v1beta', description: 'Chiave API Google e catalogo Gemini.' },
  { id: 'ollama', label: 'Ollama', kind: 'ollama', authentication: 'optional-key', defaultUrl: 'http://127.0.0.1:11434', description: 'Modelli locali sul coordinator o su un endpoint configurato.' },
  { id: 'lmstudio', label: 'LM Studio', kind: 'openai-compatible', authentication: 'optional-key', defaultUrl: 'http://127.0.0.1:1234/v1', description: 'Server locale compatibile OpenAI.' },
  { id: 'gemrouter', label: 'GemRouter', kind: 'openai-compatible', authentication: 'optional-key', description: 'Il tuo router come ulteriore fornitore di inferenza.' },
  { id: 'custom', label: 'API compatibile OpenAI', kind: 'openai-compatible', authentication: 'optional-key', description: 'Incolla l’URL del server; i modelli vengono rilevati insieme.' }
];
const SCOPE = 'Solo Ollama e LM Studio su loopback del coordinator, più gli endpoint già configurati e visibili. Nessuna scansione della rete.';
const NATIVE = new Set(['codex', 'antigravity']);
const allowedFields = new Set(['preset', 'providerId', 'accountId', 'label', 'accountLabel', 'baseUrl', 'secret', 'shared', 'requestId', 'nodeIds', 'resourceGroupIds', 'modelIds']);
interface Enrollment { id: string; ownerId: string; providerId: string; accountId: string; createdAt: string; }
const optional = (value: unknown, name: string, max = 200): string | undefined => value === undefined || value === '' ? undefined : str(value, name, max).trim();
const operator = (user: User): boolean => user.role === 'admin' || user.role === 'operator';
const publicProvider = ({ command, args, env, ...provider }: Provider): PublicConnectionProvider => provider;
const sameIds = (left: string[], right: string[]): boolean => left.length === right.length && left.every(value => right.includes(value));
const closedRuns = new Set<Run['status']>(['succeeded', 'failed', 'cancelled']);
function presetId(value: unknown): ConnectionPresetId | undefined {
  if (value === undefined) return;
  const name = value === 'openai-compatible' ? 'custom' : value === 'openai-responses' ? 'openai' : value;
  assert(PRESETS.some(p => p.id === name), 400, 'PRESET', 'Scegli una connessione supportata.');
  return name as ConnectionPresetId;
}
function presetFor(provider: Provider): ConnectionPresetId {
  return provider.tag === 'gemrouter' ? 'gemrouter' : provider.kind === 'openai-compatible' ? 'custom' : provider.kind === 'openai-responses' ? 'openai' : provider.kind;
}
/** Accept a copied API method URL as well as its base URL; never retain URL credentials or queries. */
function baseUrl(value: string, preset: ConnectionPreset): string {
  let parsed = endpoint(value);
  parsed = preset.kind === 'ollama' ? parsed.replace(/\/api\/(?:tags|chat|generate|embed)$/, '') : parsed.replace(/\/(?:chat\/completions|responses|models)$/, '');
  if (preset.kind === 'openai-compatible' && new URL(parsed).pathname === '/') parsed += '/v1';
  return parsed;
}
async function executableAvailable(provider: Provider): Promise<boolean> {
  const command = provider.command ?? (provider.kind === 'antigravity' ? 'agy' : 'codex');
  const candidates = path.isAbsolute(command) || command.includes(path.sep) ? [path.resolve(command)] : (provider.env?.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(folder => path.join(folder, command));
  for (const candidate of candidates) try { await access(candidate, constants.X_OK); return true; } catch { /* Try the next configured PATH entry. */ }
  return false;
}

/** One recoverable enrollment: credentials never leave the encrypted store or enter the receipt. */
export class Connections {
  readonly catalog: Catalog;
  private readonly pending = new Map<string, { signature: string; promise: Promise<ConnectionResult> }>();
  constructor(catalog: Catalog) { this.catalog = catalog; }
  private visible(user: User): Provider[] {
    const accountProviders = new Set(this.catalog.accounts(user).map(account => account.providerId));
    return this.catalog.store.all<Provider>('provider').filter(provider => provider.ownerId === user.id || accountProviders.has(provider.id) || this.catalog.config.providers.some(p => p.id === provider.id));
  }
  options(user: User): ConnectionOptions {
    assert(user.role !== 'viewer', 403, 'FORBIDDEN', 'Il profilo lettore non può collegare account.');
    const accounts = this.catalog.accounts(user), models = this.catalog.models(user);
    return { presets: operator(user) ? structuredClone(PRESETS) : [], configured: this.visible(user).filter(p => operator(user) || !NATIVE.has(p.kind)).map(provider => ({ provider: publicProvider(provider), accounts: accounts.filter(a => a.providerId === provider.id), modelCount: models.filter(m => m.providerId === provider.id).length })), detectionScope: SCOPE };
  }
  private assertTopologyIdle(provider: Provider): void {
    const store = this.catalog.store;
    // These private semaphores also cover facade API and embedding requests,
    // which can own a lease without a persisted harness run.
    const accountGroups = store.all<Account>('account').filter(account => account.providerId === provider.id).map(account => 'account:' + account.id);
    const activity = this.catalog.scheduler.inspect(accountGroups);
    assert(activity.activeCount === 0 && activity.queueCount === 0, 409, 'TOPOLOGY_BUSY', 'La connessione ha richieste attive o in coda. Attendi la conclusione prima di modificare nodi e risorse.');
    const routeIds = new Set(store.all<ModelRoute>('model').filter(model => model.providerId === provider.id).map(model => model.id));
    const openRun = store.all<Run>('run').some(run => {
      if (closedRuns.has(run.status)) return false;
      const project = store.get<Project>('project', run.projectId);
      const referenced = [run.routeId, ...(run.routing?.strategy === 'auto' ? run.routing.fallbackRouteIds : []),
        ...run.tasks.flatMap(task => [task.routeId, task.routing?.requestedRouteId, task.routing?.chosenRouteId]),
        ...(run.mode === 'mission' ? Object.values(project?.routes ?? {}) : [project?.routes.embedding])];
      return referenced.some(route => route !== undefined && routeIds.has(route));
    });
    assert(!openRun, 409, 'TOPOLOGY_BUSY', 'Una missione o conversazione aperta usa questa connessione. Concludila o annullala prima di modificare nodi e risorse.');
  }
  async connect(user: User, raw: ConnectionInput, signal: AbortSignal): Promise<ConnectionResult> {
    assert(user.role !== 'viewer', 403, 'FORBIDDEN', 'Il profilo lettore non può collegare account.');
    const body = object(raw);
    assert(Object.keys(body).every(key => allowedFields.has(key)), 400, 'INVALID', 'La connessione contiene campi non consentiti.');
    const requestId = optional(body.requestId, 'Richiesta', 120);
    if (requestId) assert(/^[a-zA-Z0-9_-]+$/.test(requestId), 400, 'INVALID', 'Identificatore richiesta non valido.');
    const key = requestId ? `${user.id}:${requestId}` : id('connect');
    const signature = hash(JSON.stringify(body));
    const active = this.pending.get(key);
    if (active) { assert(active.signature === signature, 409, 'IN_PROGRESS', 'Questa connessione è già in verifica. Attendi l’esito prima di modificarla.'); return active.promise; }
    assert(this.pending.size < 64, 429, 'BUSY', 'Sono già in corso molte verifiche di connessione. Riprova tra poco.');
    const promise = this.enroll(user, body, requestId, signal);
    this.pending.set(key, { signature, promise });
    try { return await promise; } finally { this.pending.delete(key); }
  }
  private async enroll(user: User, body: Record<string, unknown>, requestId: string | undefined, signal: AbortSignal): Promise<ConnectionResult> {
    signal.throwIfAborted();
    const store = this.catalog.store;
    const receiptId = requestId ? 'enroll_' + hash(`${user.id}:${requestId}`) : undefined;
    const receipt = receiptId ? store.get<Enrollment>('connection-enrollment', receiptId) : undefined;
    const requestedProvider = optional(body.providerId, 'Connessione');
    const requestedAccount = optional(body.accountId, 'Account');
    if (receipt) assert((!requestedProvider || receipt.providerId === requestedProvider) && (!requestedAccount || receipt.accountId === requestedAccount), 409, 'ENROLLMENT', 'La richiesta appartiene a un altro collegamento.');
    let account = requestedAccount || receipt?.accountId ? store.own<Account>(user, 'account', requestedAccount ?? receipt!.accountId) : undefined;
    const existingId = requestedProvider ?? receipt?.providerId ?? account?.providerId;
    let provider = existingId ? this.visible(user).find(p => p.id === existingId) : undefined;
    if (existingId) assert(provider, 404, 'NOT_FOUND', 'Connessione non disponibile.');
    if (account) assert(provider?.id === account.providerId, 400, 'ACCOUNT', 'Account e connessione non corrispondono.');
    const selected = presetId(body.preset) ?? (provider ? presetFor(provider) : undefined);
    assert(selected, 400, 'PRESET', 'Scegli il tipo di connessione.');
    const preset = PRESETS.find(p => p.id === selected)!;
    if (provider) assert(provider.kind === preset.kind, 400, 'PRESET', 'Tipo di connessione non corrispondente.');
    const native = NATIVE.has(preset.kind);
    if (native) assert(operator(user), 403, 'TRUSTED_EXECUTION', 'Le CLI sono riservate agli operatori fidati.');
    const secret = optional(body.secret, 'Credenziale', 65536);
    assert(!native || !secret, 400, 'NATIVE_AUTH', 'Per questa CLI usa il login ufficiale, senza incollare API key o token.');
    const suppliedUrl = optional(body.baseUrl, 'URL', 4000);
    const url = native ? undefined : provider && (!suppliedUrl || endpoint(suppliedUrl) === endpoint(provider.baseUrl)) ? endpoint(provider.baseUrl) : baseUrl(suppliedUrl ?? preset.defaultUrl ?? '', preset);
    if (provider && url) assert(endpoint(provider.baseUrl) === url, 409, 'ENDPOINT_CHANGED', 'L’endpoint è cambiato: avvia una nuova connessione per non modificare gli account già collegati.');
    if (!provider) provider = this.visible(user).find(p => p.kind === preset.kind && (native || p.baseUrl === url) && (native || p.ownerId === user.id || this.catalog.config.providers.some(seed => seed.id === p.id)));
    if (provider) assert(provider.enabled, 409, 'DISABLED', 'Questa connessione è disabilitata nella configurazione del servizio.');
    if (preset.kind === 'antigravity') {
      const other = store.all<Account>('account').find(a => store.get<Provider>('provider', a.providerId)?.kind === 'antigravity');
      assert(!other || other.ownerId === user.id, 409, 'ISOLATION', 'Antigravity usa il profilo CLI già assegnato a un altro operatore del servizio.');
      if (other) { account = other; provider = store.require<Provider>('provider', other.providerId); }
      if (provider) assert(provider.ownerId === user.id, 403, 'ISOLATION', 'Il profilo Antigravity è gestito dall’operatore che lo ha configurato.');
    }
    const reusedProvider = !!provider;
    const label = optional(body.label, 'Nome connessione', 120) ?? preset.label;
    const accountLabel = optional(body.accountLabel, 'Nome account', 120) ?? account?.label ?? 'Principale';
    let nodeIds = body.nodeIds === undefined ? provider?.nodeIds ?? [] : textList(body.nodeIds);
    let resourceGroupIds = body.resourceGroupIds === undefined ? provider?.resourceGroupIds ?? [] : textList(body.resourceGroupIds);
    if (!provider && !nodeIds.length && url && ['ollama', 'lmstudio'].includes(selected)) {
      const host = new URL(url).hostname.toLowerCase();
      const known = new Set(this.catalog.config.nodes.filter(node => node.host?.toLowerCase() === host).map(node => node.id));
      for (const link of this.catalog.config.links) if (link.address?.toLowerCase() === host) known.add(link.to);
      if (['localhost', '127.0.0.1', '[::1]'].includes(host)) {
        for (const target of this.catalog.config.targets.filter(target => target.kind === 'local')) known.add(target.nodeId);
        if (!known.size) for (const node of this.catalog.config.nodes.filter(node => node.capabilities.includes('coordinator'))) known.add(node.id);
      }
      if (known.size === 1) nodeIds = [...known];
      if (nodeIds.length && !resourceGroupIds.length) resourceGroupIds = this.catalog.config.resourceGroups.filter(group => group.nodeIds.some(node => nodeIds.includes(node))).map(group => group.id);
    }
    assert(nodeIds.every(key => this.catalog.config.nodes.some(node => node.id === key)) && resourceGroupIds.every(key => this.catalog.config.resourceGroups.some(group => group.id === key)), 400, 'RESOURCE', 'Risorsa sconosciuta.');
    let previousTopology: Pick<Provider, 'nodeIds' | 'resourceGroupIds'> | undefined;
    if (provider && (!sameIds(nodeIds, provider.nodeIds) || !sameIds(resourceGroupIds, provider.resourceGroupIds))) {
      assert(!this.catalog.config.providers.some(configured => configured.id === provider!.id), 409, 'CONFIGURED_PROVIDER', 'Questa connessione è definita nel file di configurazione del coordinator. Modifica nodi e risorse nel file e riavvia il servizio; il collegamento dell’account non li sovrascrive.');
      assert(operator(user) && provider.ownerId === user.id, 403, 'FORBIDDEN', 'Solo l’operatore proprietario può modificare i nodi e le risorse di questa connessione.');
      this.assertTopologyIdle(provider);
      previousTopology = { nodeIds: provider.nodeIds, resourceGroupIds: provider.resourceGroupIds };
      provider = { ...provider, nodeIds, resourceGroupIds };
    }
    if (!provider) {
      assert(operator(user), 403, 'FORBIDDEN', 'Un operatore deve prima configurare questo endpoint.');
      assert(store.all<Provider>('provider').filter(p => p.ownerId === user.id).length < 100, 413, 'LIMIT', 'Limite connessioni raggiunto.');
      provider = { id: id('prv'), ownerId: user.id, label, kind: preset.kind, baseUrl: url, ...(native ? { command: preset.kind === 'codex' ? 'codex' : 'agy' } : {}), nodeIds, resourceGroupIds, enabled: true, createdAt: now(), tag: selected === 'gemrouter' ? 'gemrouter' : ['ollama', 'lmstudio'].includes(selected) ? 'local' : 'cloud' };
    }
    if (!account) account = store.all<Account>('account').find(a => a.ownerId === user.id && a.providerId === provider!.id && a.label === accountLabel);
    const reusedAccount = !!account;
    const shared = native ? false : body.shared === undefined ? account?.shared ?? false : body.shared === true;
    assert(body.shared === undefined || typeof body.shared === 'boolean', 400, 'INVALID', 'Condivisione account non valida.');
    assert(!shared || operator(user), 403, 'FORBIDDEN', 'La condivisione di account richiede un operatore.');
    if (!account) {
      assert(store.all<Account>('account').filter(a => a.ownerId === user.id).length < 100, 413, 'LIMIT', 'Limite account raggiunto.');
      account = { id: id('acc'), ownerId: user.id, providerId: provider.id, label: accountLabel, shared, hasSecret: !!secret, status: 'unknown' };
    } else { account.label = accountLabel; account.shared = shared; }
    const manualIds = body.modelIds === undefined ? [] : textList(body.modelIds, 32).map(value => str(value.trim(), 'Modello', 200));
    assert(!native || !manualIds.length, 400, 'MODELS', 'Le CLI devono esporre i propri modelli attraverso il protocollo ufficiale.');
    if (secret && secret !== store.secret(account.id)) { account.hasSecret = true; account.status = 'unknown'; delete account.quota; }
    store.transaction(() => {
      if (!reusedProvider || previousTopology) store.put('provider', provider!);
      if (previousTopology) for (const route of store.all<ModelRoute>('model').filter(model => model.providerId === provider!.id)) {
        // Move inherited bindings together with the provider; retain explicit
        // per-model constraints, including constraints on other accounts.
        store.put('model', { ...route,
          nodeIds: sameIds(route.nodeIds, previousTopology.nodeIds) ? provider!.nodeIds : route.nodeIds,
          resourceGroupIds: sameIds(route.resourceGroupIds, previousTopology.resourceGroupIds) ? provider!.resourceGroupIds : route.resourceGroupIds });
      }
      store.put('account', account!);
      if (secret) store.setSecret(account!.id, secret);
      if (receiptId) {
        store.put<Enrollment>('connection-enrollment', { id: receiptId, ownerId: user.id, providerId: provider!.id, accountId: account!.id, createdAt: receipt?.createdAt ?? now() });
        for (const old of store.all<Enrollment>('connection-enrollment').filter(r => r.ownerId === user.id).slice(200)) store.remove('connection-enrollment', old.id);
      }
    });
    const bindingWarnings = ['ollama', 'lmstudio'].includes(selected) && !provider.nodeIds.length ? [this.catalog.config.providers.some(configured => configured.id === provider!.id)
      ? 'Questo endpoint locale non è associato a un nodo. Aggiorna nodi e risorse nel file di configurazione del coordinator e riavvia il servizio.'
      : 'Questo endpoint locale non è associato a un nodo noto. Assegna il nodo nelle opzioni avanzate per coordinare le risorse hardware condivise.'] : [];
    const result = (status: ConnectionResult['status'], message: string, warnings: string[] = [], nextAction?: ConnectionResult['nextAction']): ConnectionResult => ({ provider: publicProvider(provider!), account: store.require<Account>('account', account!.id), models: store.all<ModelRoute>('model').filter(m => m.accountId === account!.id), status, message, warnings: [...warnings, ...bindingWarnings], reused: { provider: reusedProvider, account: reusedAccount }, ...(nextAction ? { nextAction } : {}) });
    const retry: ConnectionResult['nextAction'] = { kind: 'retry', label: 'Riprova', accountId: account.id };
    const disableNative = () => { const current = store.require<Account>('account', account!.id); current.status = 'unknown'; store.put('account', current); for (const route of store.all<ModelRoute>('model').filter(m => m.accountId === current.id)) store.put('model', { ...route, enabled: false }); };
    if (native && !await executableAvailable(provider)) {
      disableNative();
      return result('setup-required', `La CLI ${preset.label} non è disponibile al processo del coordinator. Installa la CLI ufficiale o configura il percorso dell’eseguibile nel servizio.`, [], { kind: 'configure-runtime', label: 'Guida alla CLI', command: preset.kind === 'codex' ? 'codex --version' : 'agy acp --help', docsUrl: preset.docsUrl, accountId: account.id });
    }
    if (native && await nativeAccountBusy(this.catalog.connection(provider, account))) return result('unavailable', 'Questo account CLI sta lavorando. Il collegamento è conservato: riprova la verifica quando il task termina.', [], retry);
    try {
      const discovered = await this.catalog.discover(user, account.id, AbortSignal.any([signal, AbortSignal.timeout(10000)])) as Awaited<ReturnType<Catalog['discover']>> & { standby?: boolean };
      if (native && discovered.account.status !== 'ready' && discovered.account.status !== 'cooldown') {
        disableNative();
        if (discovered.warnings.some(warning => /Unable to inspect|unsupported|not negotiate/i.test(warning))) return result('setup-required', 'La CLI è presente ma non ha confermato il protocollo richiesto. Controlla la versione e la configurazione del servizio.', discovered.warnings, { kind: 'configure-runtime', label: 'Guida al runtime', docsUrl: preset.docsUrl, accountId: account.id });
        return result('login-required', preset.kind === 'codex' ? 'Collegamento creato. Completa l’accesso ufficiale a Codex; i modelli saranno rilevati al termine.' : 'Completa l’accesso Google nella CLI del coordinator, poi premi Riprova.', discovered.warnings, preset.kind === 'codex' ? { kind: 'login', label: 'Accedi a Codex', accountId: account.id } : { kind: 'configure-runtime', label: 'Accedi nella CLI', command: 'agy acp --login', docsUrl: preset.docsUrl, accountId: account.id });
      }
      if (discovered.standby) return result('standby', 'Modelli già configurati. Il motore è in standby e verrà attivato dalla sua ricetta alla prima richiesta.', discovered.warnings);
      if (discovered.account.status === 'cooldown') return result('unavailable', 'Account collegato; la quota osservata richiede attesa prima di una nuova richiesta.', discovered.warnings, retry);
      if (!discovered.models.length && manualIds.length) { this.manualModels(provider, account, manualIds); return result('unverified', 'Modelli salvati manualmente. La prima richiesta verificherà il percorso di inferenza.', discovered.warnings); }
      return result('ready', discovered.models.length ? `${discovered.models.length} modelli rilevati. Scegli quello da usare.` : 'Endpoint raggiunto, ma il catalogo non contiene modelli. Carica un modello oppure inserisci gli ID nelle opzioni avanzate.', discovered.warnings);
    } catch (error) {
      if (signal.aborted) throw error;
      const message = safeError(error);
      const limited = error instanceof AppError && error.status === 429;
      const upstreamStatus = (error as { upstreamStatus?: number } | undefined)?.upstreamStatus;
      const rejectedKey = upstreamStatus === 401 || upstreamStatus === 403 || /\bHTTP (401|403)\b/.test(message);
      if (native) disableNative();
      if (native && /version.*unsupported|not negotiate|Executable not found/i.test(message)) return result('setup-required', 'Il runtime non ha confermato un protocollo compatibile. Controlla la CLI installata sul coordinator.', [message], { kind: 'configure-runtime', label: 'Guida al runtime', docsUrl: preset.docsUrl, accountId: account.id });
      if (!native && manualIds.length && !limited && !rejectedKey) { this.manualModels(provider, account, manualIds); return result('unverified', 'ID modello salvati. Il catalogo del provider non è stato verificato; nessuna inferenza è stata ancora eseguita.', [message], retry); }
      if (!limited) { const current = store.require<Account>('account', account.id); current.status = 'error'; store.put('account', current); }
      return result('unavailable', limited ? 'Quota esaurita o limite temporaneo del provider. Il collegamento è conservato.' : rejectedKey ? 'Il provider ha rifiutato la credenziale. Correggi la chiave e premi Riprova sullo stesso account.' : 'La connessione è salvata, ma la verifica non è riuscita. Controlla indirizzo, runtime o credenziali e riprova.', [message], retry);
    }
  }
  private manualModels(provider: Provider, account: Account, models: string[]): void {
    const store = this.catalog.store, known = store.all<ModelRoute>('model').filter(m => m.accountId === account.id);
    store.transaction(() => {
      for (const model of models) { const previous = known.find(m => m.model === model); store.put<ModelRoute>('model', { id: previous?.id ?? id('mdl'), providerId: provider.id, accountId: account.id, model, label: previous?.label ?? model, nodeIds: provider.nodeIds, resourceGroupIds: provider.resourceGroupIds, contextWindow: previous?.contextWindow, capabilities: previous?.capabilities ?? ['chat'], capabilitySource: previous?.capabilitySource ?? 'operator', enabled: provider.enabled }); }
      const current = store.require<Account>('account', account.id); current.status = 'unknown'; store.put('account', current);
    });
  }
  async detect(user: User, signal: AbortSignal): Promise<ConnectionDetection> {
    assert(operator(user), 403, 'FORBIDDEN', 'La ricerca dei server locali richiede un operatore.');
    const candidates: Array<{ preset: ConnectionPresetId; label: string; baseUrl: string; provider?: Provider; account?: Account }> = [
      { preset: 'ollama', label: 'Ollama sul coordinator', baseUrl: 'http://127.0.0.1:11434' },
      { preset: 'lmstudio', label: 'LM Studio sul coordinator', baseUrl: 'http://127.0.0.1:1234/v1' }
    ];
    for (const provider of this.visible(user).filter(p => p.enabled && p.baseUrl && !NATIVE.has(p.kind)).slice(0, 10)) {
      const item = { preset: presetFor(provider), label: provider.label, baseUrl: provider.baseUrl!, provider, account: this.catalog.accounts(user).find(a => a.providerId === provider.id) };
      const existing = candidates.findIndex(c => c.baseUrl === item.baseUrl && PRESETS.find(p => p.id === c.preset)?.kind === provider.kind);
      if (existing >= 0) candidates[existing] = item; else candidates.push(item);
    }
    const results: ConnectionDetection['candidates'] = [];
    for (let index = 0; index < candidates.length; index += 4) {
      signal.throwIfAborted();
      const batch = await Promise.all(candidates.slice(index, index + 4).map(async item => {
        const preset = PRESETS.find(p => p.id === item.preset)!;
        try {
          const response = await discoverModels({ id: item.provider?.id ?? 'probe', label: item.label, kind: item.provider?.kind ?? preset.kind, baseUrl: item.baseUrl }, item.account ? this.catalog.store.secret(item.account.id) : undefined, AbortSignal.any([signal, AbortSignal.timeout(1500)]), { metadata: false });
          return { preset: item.preset, label: item.label, baseUrl: item.baseUrl, providerId: item.provider?.id, modelCount: response.models.length, status: 'available' as const, message: response.models.length ? `${response.models.length} modelli rilevati` : 'Server raggiunto; catalogo vuoto' };
        } catch (error) {
          const standby = item.provider && this.catalog.config.providers.some(p => p.id === item.provider!.id && p.activation && p.models?.length);
          const auth = /\bHTTP (401|403|429)\b/.test(safeError(error));
          return { preset: item.preset, label: item.label, baseUrl: item.baseUrl, providerId: item.provider?.id, modelCount: 0, status: standby && !auth ? 'standby' as const : 'unavailable' as const, message: standby && !auth ? 'Motore configurato con attivazione su richiesta; readiness non osservata.' : 'Non disponibile alla verifica. Nessun modello è stato avviato.' };
        }
      }));
      results.push(...batch);
    }
    signal.throwIfAborted();
    return { candidates: results, scope: SCOPE };
  }
}
