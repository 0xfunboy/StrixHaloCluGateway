import path from 'node:path';
import type { Project, Account, Metrics, ModelRoute, Provider, Quota, Telemetry, User } from './contracts.ts';
import { routeResources, type Config } from './config.ts';
import { Store } from './store.ts';
import { Scheduler } from './scheduler.ts';
import { RouteRouter } from './routing.ts';
import { InferenceLoadMonitor } from './inference-load.ts';
import type { ProviderLoadObservation } from './load-types.ts';
import { discoverModels, embed, inspectNative, loginNative, sampleTelemetry } from './adapters/index.ts';
import { normalizeTelemetry } from './adapters/telemetry.ts';
import type { AdapterConnection, InferenceResult, QuotaObservation } from './adapters/types.ts';
import { bindAntigravityProfile, privateRuntimeDirectory } from './adapters/antigravity-profile.ts';
import { execute } from './execution/index.ts';
import { ensureHttpEngine, isEngineReady, waitEngineReady } from './adapters/lifecycle.ts';
import { AppError, assert, id, now, safeError } from './util.ts';
export class Catalog {
    store: Store;
    config: Config;
    scheduler: Scheduler;
    telemetry = new Map<string, Telemetry>();
    loadObservations = new Map<string, ProviderLoadObservation>();
    loadMonitor = new InferenceLoadMonitor(this.loadObservations);
    refreshing?: Promise<Telemetry[]>;
    constructor(store: Store, config: Config, scheduler: Scheduler) { this.store = store; this.config = config; this.scheduler = scheduler; }
    seed(user: User): void {
        for (const seed of this.config.providers) {
            const previous = this.store.get<Provider>('provider', seed.id);
            const { models, secretEnv, sharedAccount, activation, loadProbe, maxEmbeddingChars, ...rest } = seed;
            const p: Provider = { ...rest, ownerId: previous?.ownerId ?? user.id, createdAt: previous?.createdAt ?? now() };
            this.store.put('provider', p);
            const native = p.kind === 'codex' || p.kind === 'antigravity';
            const secret = !native && secretEnv ? process.env[secretEnv] : undefined;
            const a = this.store.all<Account>('account').find(a => a.providerId === p.id && a.ownerId === p.ownerId && a.label === 'Principale') ?? this.addAccount(user, p.id, 'Principale', secret, !native && sharedAccount !== false);
            if (secret) {
                this.store.setSecret(a.id, secret);
                a.hasSecret = true;
                this.store.put('account', a);
            }
            for (const route of this.store.all<ModelRoute>('model').filter(m => m.providerId === p.id))
                this.store.put('model', { ...route, nodeIds: p.nodeIds, resourceGroupIds: p.resourceGroupIds, enabled: p.enabled && !route.archived && route.discoveryStatus !== 'missing' && (!native || route.discoveryStatus === 'present' || (route.discoveryStatus === undefined && route.enabled)) });
            for (const m of models ?? []) {
                const old = this.store.all<ModelRoute>('model').find(r => r.accountId === a.id && r.model === m.model);
                const legacyEmpty = old && !old.capabilitiesOverridden && old.capabilitySource==='operator' && old.discoveryStatus===undefined && !old.capabilities.length;
                this.store.put<ModelRoute>('model', { ...old, id: old?.id ?? id('mdl'), providerId: p.id, accountId: a.id, label: old?.label ?? m.label, model: m.model, nodeIds: p.nodeIds, resourceGroupIds: p.resourceGroupIds, contextWindow: old?.contextWindow ?? m.contextWindow, capabilities: (legacyEmpty ? undefined : old?.capabilities) ?? m.capabilities ?? ['chat'], capabilitySource: old?.capabilitySource ?? 'operator', discoveryStatus: old?.discoveryStatus, enabled: p.enabled && !old?.archived && old?.discoveryStatus !== 'missing' && (!native || old?.discoveryStatus === 'present' || (old?.discoveryStatus === undefined && old?.enabled === true)) });
            }
        }
    }
    canUseAccount(user: User, account: Account): boolean {
        return account.ownerId === user.id || account.shared || account.grantedUserIds?.includes(user.id) === true;
    }
    accounts(user: User): Account[] {
        const accounts = this.store.all<Account>('account');
        return accounts.filter(account => this.canUseAccount(user,account)).map(account => {
            const quota = this.effectiveQuota(account, accounts);
            const status = account.status === 'ready' && quota?.cooldownUntil && Date.parse(quota.cooldownUntil) > Date.now() ? 'cooldown' : account.status;
            const { quotaDomain, grantedUserIds, ...published } = account;
            return { ...published, quota, status, ...(account.ownerId === user.id ? { quotaDomain,grantedUserIds } : {}) };
        });
    }
    effectiveQuota(account: Account, accounts?: Account[]): Quota | undefined {
        if (!account.quotaDomain) return account.quota;
        const key = account.quotaDomain.toLowerCase().normalize('NFC');
        const time = Date.now();
        const futureReset = (quota: Quota): number => {
            const reset = Date.parse(quota.cooldownUntil ?? '');
            return reset > time ? reset : 0;
        };
        return (accounts ?? this.store.all<Account>('account'))
            .filter(peer => peer.ownerId === account.ownerId && peer.quotaDomain?.toLowerCase().normalize('NFC') === key)
            .flatMap(peer => peer.quota ? [peer.quota] : [])
            .sort((left, right) => futureReset(right) - futureReset(left) || Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? account.quota;
    }
    initialProjectRoutes(user:User): Project['routes'] {
        const providerId=this.config.defaultEmbeddingProviderId;
        if (!providerId) return {};
        const route=this.models(user).find(m=>m.providerId===providerId && m.enabled && m.capabilities.includes('embedding'));
        return route ? {embedding:route.id} : {};
    }
    models(user: User): ModelRoute[] { const accounts = new Set(this.accounts(user).map(a => a.id)); return this.store.all<ModelRoute>('model').filter(m => accounts.has(m.accountId)); }
    resolve(user: User, routeId: string): {
        route: ModelRoute;
        provider: Provider;
        account: Account;
        connection: AdapterConnection;
        secret?: string;
    } {
        const route = this.store.require<ModelRoute>('model', routeId), provider = this.store.require<Provider>('provider', route.providerId), account = this.store.require<Account>('account', route.accountId);
        assert(this.canUseAccount(user,account), 404, 'NOT_FOUND', 'Modello non disponibile.');
        assert(route.enabled && provider.enabled, 409, 'DISABLED', 'Connessione disabilitata.');
        const quota = this.effectiveQuota(account);
        assert(!quota?.cooldownUntil || Date.parse(quota.cooldownUntil) <= Date.now(), 429, 'QUOTA', 'Account o dominio quota in attesa di ripristino. Scegli un altro account o attendi.');
        return { route, provider, account: { ...account, quota }, connection: this.connection(provider, account), secret: this.store.secret(account.id) };
    }
    connection(p: Provider, a: Account): AdapterConnection {
        const connection: AdapterConnection = { id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl, accountId: a.id, command: p.command, args: p.args, env: p.env ? { ...p.env } : undefined };
        if (p.kind === 'codex') {
            const dir = privateRuntimeDirectory(path.join(this.store.directory, 'accounts', a.id));
            connection.env = { ...connection.env, CODEX_HOME: dir };
        }
        if (p.kind === 'antigravity' && a.nativeProfile === 'isolated') {
            return bindAntigravityProfile(connection, path.join(this.store.directory, 'accounts', a.id, 'antigravity'));
        }
        return connection;
    }
    addAccount(user: User, providerId: string, label: string, secret?: string, shared = false): Account {
        const p = this.store.require<Provider>('provider', providerId);
        assert(p.ownerId === user.id || this.config.providers.some(s => s.id === p.id) || this.store.all<Account>('account').some(a => a.providerId === p.id && a.shared), 404, 'NOT_FOUND', 'Connessione non disponibile.');
        const native = p.kind === 'codex' || p.kind === 'antigravity';
        if (native) {
            assert(['admin', 'operator'].includes(user.role), 403, 'TRUSTED_EXECUTION', 'CLI riservate a operatori fidati.');
            assert(!secret, 400, 'NATIVE_AUTH', 'Per questa CLI usa il login ufficiale.');
        }
        assert(!shared || ['admin', 'operator'].includes(user.role), 403, 'FORBIDDEN', 'Condivisione account riservata agli operatori.');
        const a: Account = { id: id('acc'), providerId, ownerId: user.id, label, shared: !native && shared, status: 'unknown', hasSecret: !!secret, ...(native ? { nativeProfile: 'isolated' as const } : {}) };
        this.store.transaction(() => { this.store.put('account', a); if (secret)
            this.store.setSecret(a.id, secret); });
        return a;
    }
    quota(account: Account, observation: QuotaObservation): void {
        if (observation.state === 'unknown')
            return;
        const q: Quota = { observedAt: observation.observedAt, source: observation.state === 'limited' ? 'rate-limit' : 'provider', observationSource: observation.source === 'unknown' ? undefined : observation.source, remainingRequests: observation.remainingRequests };
        if (observation.retryAfterMs !== undefined)
            q.cooldownUntil = new Date(Date.now() + observation.retryAfterMs).toISOString();
        if (observation.buckets?.length)
            q.windows = observation.buckets.flatMap(bucket => bucket.windows.map(window => ({
                label: `${bucket.label} · ${window.name}`,
                bucketId: bucket.id,
                windowName: window.name,
                windowMinutes: window.windowMinutes,
                usedPercent: window.usedPercent,
                ...(window.resetsAt && window.resetsAt < 8_640_000_000_000 ? { resetAt: new Date(window.resetsAt * 1000).toISOString() } : {}),
            })));
        const exhausted = q.windows?.filter(w => (w.usedPercent ?? 0) >= 100 && w.resetAt).map(w => Date.parse(w.resetAt!)) ?? [];
        if (exhausted.length)
            q.cooldownUntil = new Date(Math.max(...exhausted)).toISOString();
        if (observation.state === 'limited' && !q.cooldownUntil)
            q.cooldownUntil = new Date(Date.now() + 60000).toISOString();
        const current = this.store.require<Account>('account', account.id);
        current.quota = q;
        current.status = observation.state === 'limited' ? 'cooldown' : 'ready';
        this.store.put('account', current);
    }
    async discover(user: User, accountId: string, signal: AbortSignal): Promise<{
        models: ModelRoute[];
        account: Account;
        warnings: string[];
        standby?: boolean;
    }> {
        const account = this.store.own<Account>(user, 'account', accountId), provider = this.store.require<Provider>('provider', account.providerId), connection = this.connection(provider, account);
        if (['codex', 'antigravity'].includes(provider.kind))
            assert(['admin', 'operator'].includes(user.role), 403, 'TRUSTED_EXECUTION', 'CLI riservate a operatori fidati.');
        let result: Awaited<ReturnType<typeof discoverModels>> & { authenticated?: boolean };
        try {
            result = ['codex', 'antigravity'].includes(provider.kind) ? await inspectNative({ connection, cwd: this.store.directory, signal }) : await discoverModels(connection, this.store.secret(account.id), signal);
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            const details = error as { status?: number; quota?: QuotaObservation } | null | undefined;
            const limited = details?.status === 429 || details?.quota?.state === 'limited';
            if (limited) {
                this.quota(account, { ...(details?.quota ?? { source: 'provider-headers', observedAt: now() }), state: 'limited' });
                throw new AppError(429, 'QUOTA', 'Limite quota raggiunto sul provider.');
            }
            if (details?.status === 401 || details?.status === 403) {
                const current = this.store.require<Account>('account', accountId);
                current.status = 'error';
                this.store.put('account', current);
                throw Object.assign(new AppError(502, 'UPSTREAM', `Autenticazione rifiutata da ${provider.label} (HTTP ${details.status}). Controlla la credenziale di questo account.`), { upstreamStatus: details.status });
            }
            // Standby is a configured lifecycle state, not evidence that a failed
            // endpoint or an old cached model has authenticated successfully.
            const configuredProvider = this.config.providers.find(p => p.id === provider.id);
            const staticModels = configuredProvider?.models;
            const existingModels = this.store.all<ModelRoute>('model').filter(m => m.accountId === accountId);
            if (configuredProvider?.activation && ((staticModels && staticModels.length) || existingModels.length)) {
                const recovered = (staticModels ?? []).map(m => {
                    const old = existingModels.find(k => k.model === m.model);
                    return this.store.put<ModelRoute>('model', {
                        ...old,
                        id: old?.id ?? id('mdl'),
                        providerId: provider.id,
                        accountId,
                        label: old?.label ?? m.label,
                        model: m.model,
                        nodeIds: provider.nodeIds,
                        resourceGroupIds: provider.resourceGroupIds,
                        contextWindow: old?.contextWindow ?? m.contextWindow,
                        maxOutputTokens: old?.maxOutputTokens,
                        capabilities: old?.capabilities ?? m.capabilities ?? ['chat'],
                        enabled: provider.enabled && !old?.archived
                    });
                });
                const current = this.store.require<Account>('account', accountId);
                current.status = 'unknown';
                this.store.put('account', current);
                return {
                    models: recovered.length ? recovered : existingModels,
                    account: current,
                    standby: true,
                    warnings: [
                        `Modelli configurati per ${provider.label}; motore non verificato. L'attivazione configurata sarà tentata quando le risorse saranno libere.`
                    ]
                };
            }
            throw new AppError(502, 'UPSTREAM', `Impossibile raggiungere ${provider.label} (${provider.baseUrl || 'endpoint'}). Verifica che il servizio sia avviato o raggiungibile: ` + safeError(error));
        }
        this.quota(account, result.quota);
        const known = this.store.all<ModelRoute>('model').filter(m => m.accountId === accountId);
        const reported = new Set(result.models.map(m => m.id));
        // Keep route identities for history, but an authoritative successful
        // catalog must not leave removed models available to the scheduler.
        const isAuthenticated = !('authenticated' in result) || result.authenticated === true;
        const models = this.store.transaction(() => {
            if (isAuthenticated) {
                for (const old of known) if (!reported.has(old.model)) this.store.put<ModelRoute>('model', { ...old, discoveryStatus: 'missing', enabled: false });
            } else {
                for (const old of known) this.store.put<ModelRoute>('model', { ...old, discoveryStatus: 'unverified', enabled: false });
            }
            if (result.models.length) {
                return result.models.map(m => {
                    const old = known.find(k => k.model === m.id), keepDeclaration = old?.capabilitySource === 'operator' && !m.capabilities.length;
                    return this.store.put<ModelRoute>('model', { ...old, id: old?.id ?? id('mdl'), providerId: provider.id, accountId, label: m.label, model: m.id, nodeIds: provider.nodeIds, resourceGroupIds: provider.resourceGroupIds, contextWindow: m.contextWindow ?? old?.contextWindow, maxOutputTokens: old?.maxOutputTokens, capabilities: keepDeclaration ? old!.capabilities : m.capabilities, capabilitySource: keepDeclaration ? 'operator' : m.capabilitySource, discoveryStatus: isAuthenticated ? 'present' : 'unverified', enabled: provider.enabled && isAuthenticated && !old?.archived });
                });
            }
            return this.store.all<ModelRoute>('model').filter(m => m.accountId === accountId);
        });
        const current = this.store.require<Account>('account', accountId);
        current.status = result.quota.state === 'limited' ? 'cooldown' : ('authenticated' in result && result.authenticated !== true) ? 'unknown' : 'ready';
        this.store.put('account', current);
        return { models, account: current, warnings: result.warnings };
    }
    async login(user: User, accountId: string, onAuth: (event: { verificationUri: string; userCode?: string; respond?: (value:string)=>void }) => void, signal: AbortSignal): Promise<void> {
        assert(['admin', 'operator'].includes(user.role), 403, 'TRUSTED_EXECUTION', 'CLI riservate a operatori fidati.');
        const account = this.store.own<Account>(user, 'account', accountId);
        const provider = this.store.require<Provider>('provider', account.providerId);
        const result = await loginNative({ connection: this.connection(provider, account), cwd: this.store.directory, signal,
            onAuth: event => onAuth({ verificationUri: event.verificationUrl, userCode: event.userCode, respond:event.respond }) });
        assert(result.authenticated, 409, 'NATIVE_AUTH', 'Il runtime ufficiale non ha confermato il login.');
        const current = this.store.require<Account>('account', accountId);
        current.status = 'unknown';
        delete current.quota;
        this.store.put('account', current);
    }
    succeeded(account: Account, observation?: QuotaObservation): void {
        if (observation) this.quota(account, observation);
        const current = this.store.require<Account>('account', account.id);
        if (!current.quota?.cooldownUntil || Date.parse(current.quota.cooldownUntil) <= Date.now()) {
            current.status = 'ready';
            this.store.put('account', current);
        }
    }
    embedder(user: User, routeId: string): (texts: string[], signal: AbortSignal) => Promise<number[][]> {
        return async (texts, signal) => {
            const lease = await new RouteRouter(this).reserve({ user, preferredRouteId: routeId, purpose: 'embedding', strategy: 'pinned', priority: 'background', maxWaitMs: 5000, signal });
            try {
                await this.activate(lease.provider.id, signal);
                const maxEmbeddingChars = this.config.providers.find(provider => provider.id === lease.provider.id)?.maxEmbeddingChars;
                const result = await embed({ connection: lease.connection, model: lease.route.model, secret: lease.secret, texts, signal, maxEmbeddingChars });
                this.succeeded(lease.account);
                return result.vectors;
            } finally { lease.release(); }
        };
    }
    async activate(providerId: string, signal: AbortSignal, onStatus: (text: string) => void = () => { }): Promise<void> {
        const spec = this.config.providers.find(p => p.id === providerId)?.activation;
        if (!spec)
            return;
        if (spec.switchUrl) {
            await ensureHttpEngine(spec, signal, onStatus);
            return;
        }
        if (await isEngineReady(spec, signal))
            return;
        assert(spec.targetId && spec.recipeId, 409, 'ENGINE', 'Motore non pronto e attivazione non configurata.');
        const target = this.config.targets.find(t => t.id === spec.targetId);
        assert(target, 409, 'CONFIG', 'Target attivazione non trovato.');
        onStatus('Attivazione del modello configurato');
        const result = await execute({ target, operation: { kind: 'command', recipeId: spec.recipeId }, signal, approve: async () => true });
        assert(result.ok, 502, 'ENGINE', 'Avvio motore fallito.');
        await waitEngineReady(spec, signal, onStatus);
    }
    async refresh(signal: AbortSignal): Promise<Telemetry[]> {
        if (this.refreshing)
            return this.refreshing;
        this.refreshing = (async () => {
            await Promise.allSettled(this.config.nodes.map(async (node) => {
                const spec = node.telemetry;
                if (!spec) {
                    this.telemetry.set(node.id, { nodeId: node.id, status: 'unknown', quality: 'unknown' });
                    return;
                }
                try {
                    let data;
                    const started = Date.now();
                    if (spec.kind === 'native' && spec.targetId) {
                        const target = this.config.targets.find(t => t.id === spec.targetId);
                        assert(target, 400, 'CONFIG', 'Target telemetria mancante.');
                        const result = await execute({ target, operation: { kind: 'telemetry' }, signal, approve: async () => false });
                        data = normalizeTelemetry(result.data, { id: node.id });
                    }
                    else {
                        assert(spec.url, 400, 'CONFIG', 'URL telemetria mancante.');
                        data = await sampleTelemetry({ id: node.id, url: spec.url, secret:spec.secretEnv ? process.env[spec.secretEnv] : undefined, gatewayNodeKey: spec.key as 'node01' | 'node02' | 'aireward' | undefined }, signal);
                    }
                    const previous = this.telemetry.get(node.id), previousNetwork = (previous?.details?.network ?? []) as NonNullable<typeof data.network>;
                    const elapsed = data.observedAt && previous?.observedAt ? (Date.parse(data.observedAt) - Date.parse(previous.observedAt)) / 1000 : 0;
                    const network = data.network?.map(n => { const before = previousNetwork.find(old => old.name === n.name); const rx = elapsed > 0 && n.rxBytes !== undefined && before?.rxBytes !== undefined && n.rxBytes >= before.rxBytes ? (n.rxBytes - before.rxBytes) / elapsed : undefined; const tx = elapsed > 0 && n.txBytes !== undefined && before?.txBytes !== undefined && n.txBytes >= before.txBytes ? (n.txBytes - before.txBytes) / elapsed : undefined; return { ...n, rxBytesPerSecond: rx, txBytesPerSecond: tx }; });
                    const gpu = data.gpus[0];
                    this.telemetry.set(node.id, { nodeId: node.id, status: data.status, observedAt: data.observedAt, quality: data.quality, cpuPercent: data.cpu.utilization, cpuTempC: data.cpu.temperatureC, ramUsedBytes: data.memory.usedBytes, ramTotalBytes: data.memory.totalBytes, gpuPercent: gpu?.utilization, gpuTempC: gpu?.temperatureC, gpuPowerW: gpu?.powerWatts, gpuMemoryUsedBytes: gpu?.memoryUsedBytes, gpuMemoryTotalBytes: gpu?.memoryTotalBytes, details: { gpus: data.gpus, disk: data.disk, network, probeMs: Date.now() - started, errors: data.errors } });
                }
                catch (error) {
                    this.telemetry.set(node.id, { nodeId: node.id, status: 'offline', quality: 'unknown', error: safeError(error) });
                }
            }));
            return [...this.telemetry.values()];
        })();
        try {
            return await this.refreshing;
        }
        finally {
            this.refreshing = undefined;
        }
    }
}
export function resultMetrics(result: InferenceResult): Metrics {
    const u = result.usage, m = result.metrics;
    return { inputTokens: u?.inputTokens, outputTokens: u?.outputTokens, cachedInputTokens: u?.cachedInputTokens, totalTokens: u ? u.inputTokens + u.outputTokens : undefined, ttftMs: m.ttftMs, durationMs: m.totalMs, decodeTokensPerSecond: m.decodeTokensPerSecond, prefillMs: m.prefillMs, prefillTokensPerSecond: m.prefillTokensPerSecond, contextWindow: m.contextLimit, contextUsed: m.contextUsed, contextSource: m.contextUsed !== undefined ? 'provider' : undefined, source: m.sources.usage };
}
