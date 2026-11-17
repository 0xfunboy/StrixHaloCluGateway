import type { Account, ModelRoute, Provider, User } from './contracts.ts';
import type { Catalog } from './catalog.ts';
import { routeResources, type SeedProvider } from './config.ts';
import type { QueueWait, SchedulePriority } from './scheduler.ts';
import { AppError } from './util.ts';
import type { RouteAvailability, RouteDecision, RoutePurpose } from './routing-types.ts';
import { currentLoad } from './inference-load.ts';
import type { LoadProbe, ProviderLoadObservation } from './load-types.ts';
export type { RouteAvailability, RouteDecision, RoutePurpose } from './routing-types.ts';

export interface RouteRequirements {
    purpose?: RoutePurpose;
    requiredCapabilities?: string[];
    minimumContextTokens?: number;
    /** Granted only after the caller has checked trusted role and local target. */
    nativeAllowed?: boolean;
}
export interface RoutingRequest extends RouteRequirements {
    user: User;
    preferredRouteId: string;
    /** Explicit user/project-approved pool. Never expanded to all visible models. */
    alternativeRouteIds?: string[];
    strategy?: 'auto' | 'pinned';
    priority?: SchedulePriority;
    maxWaitMs?: number;
    signal: AbortSignal;
    onQueued?: (wait: QueueWait) => void;
}
export interface RouteReservation extends RouteDecision {
    route: ModelRoute;
    provider: Provider;
    account: Account;
    connection: ReturnType<Catalog['resolve']>['connection'];
    secret?: string;
    release: () => void;
}
interface Candidate {
    route: ModelRoute;
    provider: Provider;
    account: Account;
    groups: string[];
    load?: ProviderLoadObservation;
    unavailable?: { code: string; reason: string; status: RouteAvailability['status'] };
}

/** Selects and reserves an allowed route. It never sends a prompt or retries inference. */
export class RouteRouter {
    readonly catalog: Catalog;
    constructor(catalog: Catalog) { this.catalog = catalog; }

    private candidate(user: User, route: ModelRoute, options: RouteRequirements = {}): Candidate {
        const provider = this.catalog.store.require<Provider>('provider', route.providerId);
        const account = this.catalog.store.require<Account>('account', route.accountId);
        // Every route must retain the provider's own resource constraints. A route
        // override cannot remove either node of a configured distributed engine.
        const hardware = routeResources({
            ...route,
            nodeIds: [...new Set([...route.nodeIds, ...provider.nodeIds])],
            resourceGroupIds: [...new Set([...route.resourceGroupIds, ...provider.resourceGroupIds])]
        }, this.catalog.config);
        const native = provider.kind === 'codex' || provider.kind === 'antigravity';
        const accountGroup = 'account:' + account.id;
        const configured = provider.maxConcurrent ?? 4;
        const capacity = native ? 1 : (Number.isSafeInteger(configured) && configured >= 1 && configured <= 16 ? configured : 1);
        this.catalog.scheduler.ensureGroup({ id: accountGroup, label: 'Account · ' + account.label, nodeIds: [], capacity }, true);
        const candidate: Candidate = { route, provider, account, groups: [...new Set([...hardware, accountGroup])] };
        const deny = (code: string, reason: string, status: RouteAvailability['status'] = 'unavailable') => { candidate.unavailable = { code, reason, status }; return candidate; };
        if (account.ownerId !== user.id && !account.shared) return deny('NOT_FOUND', 'Modello non disponibile.');
        if (!route.enabled || !provider.enabled) return deny('DISABLED', 'Connessione disabilitata.', 'disabled');
        if (hardware.some(group => !this.catalog.scheduler.groups.has(group))) return deny('RESOURCE', 'Gruppo di risorse non configurato.');
        if (account.quota?.cooldownUntil && Date.parse(account.quota.cooldownUntil) > Date.now()) return deny('QUOTA', 'Account in attesa di ripristino quota.', 'cooldown');
        if (account.status === 'error') return deny('CONNECTION', 'Accesso alla connessione da verificare.');
        if (native && !['admin', 'operator'].includes(user.role)) return deny('TRUSTED_EXECUTION', 'La CLI richiede un operatore fidato.');
        if (native && options.nativeAllowed === false) return deny('NATIVE_TARGET', 'Questa richiesta richiede un modello HTTP; la CLI necessita di un workspace locale autorizzato.');
        const required = new Set(options.requiredCapabilities ?? []);
        if (options.purpose === 'embedding') required.add('embedding');
        else if (options.purpose && !(route.capabilities.length === 0 && (!route.capabilitySource || route.capabilitySource === 'unknown'))) required.add('chat');
        if ([...required].some(capability => !route.capabilities.includes(capability))) return deny('CAPABILITY', 'Capacità necessarie non dichiarate per questo modello.');
        if (options.minimumContextTokens !== undefined && (route.contextWindow ?? 16384) < options.minimumContextTokens)
            return deny('CONTEXT', 'Finestra di contesto insufficiente per questa richiesta.');
        const constraint = this.externalLoad(provider.id, hardware);
        if (constraint) { candidate.load = constraint.load; return deny(constraint.code, constraint.reason, constraint.status); }
        return candidate;
    }

    private externalLoad(providerId: string, hardware: string[]): { code: string; reason: string; status: 'busy' | 'unavailable'; load?: ProviderLoadObservation } | undefined {
        const observations = (this.catalog as Catalog & { loadObservations?: Map<string, ProviderLoadObservation> }).loadObservations;
        let unknown: { code: string; reason: string; status: 'unavailable'; load?: ProviderLoadObservation } | undefined;
        for (const configured of this.relatedLoadTargets(providerId, hardware)) {
            const probe = (configured as typeof configured & { loadProbe?: LoadProbe }).loadProbe;
            if (!probe || configured.enabled === false) continue;
            const relatedGroups = this.catalog.config.resourceGroups.filter(group => configured.resourceGroupIds.includes(group.id) || group.nodeIds.some(node => configured.nodeIds.includes(node))).map(group => group.id);
            const shared = hardware.filter(group => relatedGroups.includes(group));
            const load = currentLoad(observations?.get(configured.id), probe);
            if (this.catalog.loadMonitor.needsReconciliation(configured.id)) {
                unknown ??= { code: 'LOAD_UNAVAILABLE', status: 'unavailable', load, reason: 'La precedente prenotazione è terminata; serve una lettura aggiornata del carico prima della nuova ammissione.' };
                continue;
            }
            const exclusive = (configured.id === providerId ? hardware : shared).some(group => this.catalog.scheduler.groups.get(group)?.capacity === 1);
            if (load && load.status !== 'stale' && load.observedAt && ((exclusive && (load.activeRequests ?? 0) > 0) || load.status === 'busy'))
                return { code: 'EXTERNAL_BUSY', status: 'busy', load, reason: configured.id === providerId ? 'Il motore segnala richieste attive o in coda: uso esterno delle risorse rilevato.' : 'Un altro motore sulle stesse risorse segnala attività: la commutazione è sospesa.' };
            if (!load || load.status === 'unknown' || load.status === 'stale') unknown ??= {
                code: 'LOAD_UNAVAILABLE', status: 'unavailable', load,
                reason: load?.status === 'stale' ? 'Il dato di carico del motore è scaduto; attendo una nuova verifica.' : 'Il carico del motore configurato non è verificabile; attendo il probe prima di usare o commutare le risorse.'
            };
        }
        return unknown;
    }

    private relatedLoadTargets(providerId: string, hardware: string[]): SeedProvider[] {
        return this.catalog.config.providers.filter(provider => provider.enabled !== false && provider.loadProbe && (provider.id === providerId ||
            this.catalog.config.resourceGroups.some(group => hardware.includes(group.id) && (provider.resourceGroupIds.includes(group.id) || group.nodeIds.some(node => provider.nodeIds.includes(node))))));
    }

    private reconcile(candidates: Candidate[], signal: AbortSignal, remainingMs: number): Promise<void> | undefined {
        const targets = new Map<string, SeedProvider>();
        for (const candidate of candidates) {
            // Never contact an endpoint for a route already denied by ACL, quota,
            // capabilities or configuration, even if it was explicitly listed.
            if (candidate.unavailable && !['EXTERNAL_BUSY', 'LOAD_UNAVAILABLE'].includes(candidate.unavailable.code)) continue;
            for (const target of this.relatedLoadTargets(candidate.provider.id, candidate.groups))
                if (this.catalog.loadMonitor.needsReconciliation(target.id)) targets.set(target.id, target);
        }
        if (!targets.size) return;
        const unavailable = () => new AppError(503, 'LOAD_UNAVAILABLE', 'Impossibile verificare il carico dopo la precedente prenotazione entro il limite di attesa. Riprova o scegli un’alternativa.');
        if (remainingMs <= 0) return Promise.reject(unavailable());
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, remainingMs))]);
        return this.catalog.loadMonitor.reconcile([...targets.values()], bounded).catch(error => {
            if (signal.aborted) throw error;
            throw unavailable();
        });
    }

    private describe(candidate: Candidate): RouteAvailability {
        const { route, account, groups, unavailable } = candidate;
        const inspection = this.catalog.scheduler.inspect(groups);
        const base: RouteAvailability = {
            routeId: route.id,
            status: 'unknown',
            activeCount: inspection.activeCount,
            queueCount: inspection.queueCount,
            resourceGroupIds: groups.filter(id => !id.startsWith('account:')),
            busyResourceIds: inspection.busyResourceIds.filter(id => !id.startsWith('account:')),
            busyResourceLabels: inspection.busyResourceIds.map(id => this.catalog.scheduler.groups.get(id)?.label ?? id),
            ...(inspection.oldestWaitMs !== undefined ? { oldestWaitMs: inspection.oldestWaitMs } : {}),
            reason: 'Capacità del coordinator disponibile; accesso al provider non ancora verificato.',
            observedAt: new Date().toISOString(),
            source: 'coordinator'
        };
        if (unavailable) return {
            ...base, status: unavailable.status, reason: unavailable.reason,
            source: unavailable.status === 'cooldown' || ['EXTERNAL_BUSY', 'LOAD_UNAVAILABLE'].includes(unavailable.code) ? 'provider' : 'configuration',
            ...(candidate.load ? { observedAt: candidate.load.observedAt ?? candidate.load.lastAttemptAt } : {}),
            ...(candidate.load?.activeRequests !== undefined ? { externalActiveRequests: candidate.load.activeRequests } : {}),
            ...(candidate.load?.queuedRequests !== undefined ? { externalQueuedRequests: candidate.load.queuedRequests } : {}),
            ...(unavailable.code === 'EXTERNAL_BUSY' ? {
                busyResourceIds: groups.filter(group => !group.startsWith('account:')),
                busyResourceLabels: groups.filter(group => !group.startsWith('account:')).map(group => this.catalog.scheduler.groups.get(group)?.label ?? group)
            } : {}),
            ...(unavailable.status === 'cooldown' && account.quota?.cooldownUntil ? { cooldownUntil: account.quota.cooldownUntil, observedAt: account.quota.observedAt } : {})
        };
        if (inspection.busyResourceIds.length || inspection.queueCount) return {
            ...base, status: 'busy', reason: inspection.busyResourceIds.length ? 'Risorse o concorrenza account occupate da richieste in corso.' : 'Richieste precedenti in attesa sulle stesse risorse.'
        };
        if (!route.capabilities.length && (!route.capabilitySource || route.capabilitySource === 'unknown')) return { ...base, reason: 'Capacità del modello non dichiarate dal provider; la chat può essere provata senza dichiararle verificate.' };
        if (account.status === 'ready') return { ...base, status: 'available', reason: 'Capacità del coordinator disponibile. La risposta del provider viene verificata all’invio.' };
        return base;
    }

    /** Synchronous, ACL-filtered coordinator observations. GPU% is never capacity. */
    availability(user: User, options: RouteRequirements = {}): RouteAvailability[] {
        return this.catalog.models(user).map(route => this.describe(this.candidate(user, route, options)));
    }

    async reserve(request: RoutingRequest): Promise<RouteReservation> {
        const { user, signal } = request;
        signal.throwIfAborted();
        const strategy = request.strategy ?? 'pinned';
        if (!['auto', 'pinned'].includes(strategy)) throw new AppError(400, 'ROUTING', 'Strategia di routing non valida.');
        if (request.minimumContextTokens !== undefined && (!Number.isSafeInteger(request.minimumContextTokens) || request.minimumContextTokens < 0))
            throw new AppError(400, 'CONTEXT', 'Dimensione del contesto non valida.');
        if ((request.alternativeRouteIds?.length ?? 0) > 32) throw new AppError(400, 'ROUTING', 'Troppe alternative di routing.');
        const maxWaitMs = request.maxWaitMs ?? (request.purpose === 'chat' ? 8000 : 30000);
        if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 300000) throw new AppError(400, 'ROUTING', 'Attesa massima non valida.');
        const started = Date.now();
        const ids = [...new Set([request.preferredRouteId, ...(strategy === 'auto' ? request.alternativeRouteIds ?? [] : [])])];
        const options: RouteRequirements = { ...request, nativeAllowed: request.nativeAllowed ?? false };
        let lastFailure: AppError | undefined;
        const excluded = new Set<string>();
        while (true) {
            signal.throwIfAborted();
            const visible = new Map(this.catalog.models(user).map(route => [route.id, route]));
            if (!visible.has(request.preferredRouteId)) throw new AppError(404, 'NOT_FOUND', 'Modello non disponibile.');
            // A fallback from a shared project may belong to another user. Filter
            // it privately; do not reveal that account or its reason for denial.
            let candidates = ids.flatMap(id => {
                const route = visible.get(id);
                return route && !excluded.has(id) ? [this.candidate(user, route, options)] : [];
            });
            // An already admissible approved alternative should not wait for a
            // different engine's reconciliation. Pinned work has no such escape.
            const immediate = candidates.some(candidate => {
                if (candidate.unavailable) return false;
                const inspection = this.catalog.scheduler.inspect(candidate.groups);
                return !inspection.busyResourceIds.length && !inspection.queueCount;
            });
            const reconciliation = immediate ? undefined : this.reconcile(candidates, signal, maxWaitMs - (Date.now() - started));
            if (reconciliation) {
                await reconciliation;
                signal.throwIfAborted();
                candidates = candidates.map(candidate => this.candidate(user, this.catalog.store.require<ModelRoute>('model', candidate.route.id), options));
            }
            const eligible = candidates.filter(candidate => !candidate.unavailable);
            if (!eligible.length) {
                const issue = candidates.find(c => c.route.id === request.preferredRouteId)?.unavailable ?? candidates[0]?.unavailable;
                if (issue) throw new AppError(issue.code === 'QUOTA' ? 429 : ['EXTERNAL_BUSY', 'LOAD_UNAVAILABLE'].includes(issue.code) ? 503 : 409, issue.code, issue.reason);
                throw lastFailure ?? new AppError(409, 'NO_ROUTE', 'Nessun modello autorizzato compatibile con questa richiesta.');
            }
            if (strategy === 'auto') {
                const rank = (candidate: Candidate) => {
                    const available = this.describe(candidate);
                    return available.status === 'available' ? 0 : available.status === 'unknown' ? 1 : 2;
                };
                eligible.sort((a, b) => rank(a) - rank(b));
            }
            const lease = await this.catalog.scheduler.acquireAny(eligible.map(candidate => ({ id: candidate.route.id, groups: candidate.groups })), signal, {
                priority: request.priority ?? (request.purpose === 'chat' ? 'interactive' : 'normal'),
                maxWaitMs: Math.max(0, maxWaitMs - (Date.now() - started)),
                onQueued: request.onQueued
            });
            try {
                signal.throwIfAborted();
                // Quota/ACL/config can change while the request waits. Recheck
                // after the atomic grant, before handing out credentials.
                const current = this.catalog.store.require<ModelRoute>('model', lease.choiceId);
                let candidate = this.candidate(user, current, options);
                const reconciliation = this.reconcile([candidate], signal, maxWaitMs - (Date.now() - started));
                if (reconciliation) {
                    await reconciliation;
                    signal.throwIfAborted();
                    candidate = this.candidate(user, this.catalog.store.require<ModelRoute>('model', lease.choiceId), options);
                }
                if (candidate.unavailable) throw new AppError(candidate.unavailable.code === 'QUOTA' ? 429 : ['EXTERNAL_BUSY', 'LOAD_UNAVAILABLE'].includes(candidate.unavailable.code) ? 503 : 409, candidate.unavailable.code, candidate.unavailable.reason);
                const grantedGroups = eligible.find(item => item.route.id === lease.choiceId)!.groups;
                if (candidate.groups.length !== grantedGroups.length || candidate.groups.some(group => !grantedGroups.includes(group))) {
                    lease.release();
                    if (Date.now() - started >= maxWaitMs) throw new AppError(503, 'QUEUE_TIMEOUT', 'Le risorse del modello sono cambiate durante l’attesa. Riprova.');
                    continue;
                }
                const resolved = this.catalog.resolve(user, lease.choiceId);
                const switched = lease.choiceId !== request.preferredRouteId;
                let released = false;
                return {
                    ...resolved, release: () => {
                        if (released) return;
                        released = true;
                        // Mark before waking another queued reservation. A busy
                        // sample taken during this lease must be read again.
                        try { this.catalog.loadMonitor.afterRelease(this.relatedLoadTargets(candidate.provider.id, candidate.groups).map(provider => provider.id)); }
                        finally { lease.release(); }
                    },
                    requestedRouteId: request.preferredRouteId, chosenRouteId: lease.choiceId, switched,
                    waitMs: Math.max(0, Date.now() - started),
                    reason: switched ? 'Scelta un’alternativa autorizzata compatibile con le risorse e le quote disponibili.' : lease.waitMs > 0 ? 'Modello selezionato prenotato dopo l’attesa delle risorse.' : 'Modello selezionato prenotato.'
                };
            } catch (error) {
                lease.release();
                if (signal.aborted) throw error;
                if (strategy !== 'auto' || !(error instanceof AppError) || !['QUOTA', 'DISABLED', 'CONNECTION', 'CAPABILITY', 'CONTEXT', 'NOT_FOUND', 'NATIVE_TARGET', 'TRUSTED_EXECUTION', 'EXTERNAL_BUSY', 'LOAD_UNAVAILABLE'].includes(error.code)) throw error;
                lastFailure = error;
                excluded.add(lease.choiceId);
                if (Date.now() - started >= maxWaitMs) throw error;
            }
        }
    }
}
