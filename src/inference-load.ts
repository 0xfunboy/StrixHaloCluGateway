import { pinnedFetch, readJSON } from './adapters/http-utils.ts';
import type { LoadProbe, LoadProbeTarget, ProviderLoadObservation } from './load-types.ts';
import { Scheduler, type SchedulePriority } from './scheduler.ts';
export type { LoadProbe, LoadProbeTarget, ProviderLoadObservation } from './load-types.ts';

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
function invalid(): never { throw new Error('LOAD_SCHEMA'); }
function config(probe: LoadProbe): { url: URL; timeoutMs: number; maxAgeMs: number } {
    const url = new URL(probe.url);
    if (!['llama-slots', 'json'].includes(probe.kind) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('LOAD_CONFIG');
    if (probe.capacity !== undefined && (!isCount(probe.capacity) || probe.capacity < 1 || probe.capacity > 1024)) throw new Error('LOAD_CONFIG');
    const timeoutMs = probe.timeoutMs ?? 1500, maxAgeMs = probe.maxAgeMs ?? 6000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 100 || maxAgeMs > 60000) throw new Error('LOAD_CONFIG');
    return { url, timeoutMs, maxAgeMs };
}

/** Public validation for config loading. Does not make a network request. */
export function validateLoadProbe(probe: LoadProbe): void { config(probe); }

function counters(payload: unknown, probe: LoadProbe): Pick<ProviderLoadObservation, 'activeRequests' | 'queuedRequests' | 'capacity'> {
    if (probe.kind === 'llama-slots') {
        if (!Array.isArray(payload) || payload.length > 1024) invalid();
        let activeRequests = 0;
        const ids = new Set<number>();
        for (const slot of payload) {
            if (!slot || typeof slot !== 'object' || Array.isArray(slot) || typeof slot.is_processing !== 'boolean') invalid();
            if (slot.id !== undefined) {
                if (!isCount(slot.id) || ids.has(slot.id)) invalid();
                ids.add(slot.id);
            }
            if (slot.is_processing) activeRequests++;
        }
        // Slot count is observed capacity. An operator cap can only lower it.
        return { activeRequests, capacity: probe.capacity === undefined ? payload.length : Math.min(payload.length, probe.capacity) };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid();
    const raw = payload as Record<string, unknown>;
    if (!isCount(raw.activeRequests)) invalid();
    if (raw.queuedRequests !== undefined && !isCount(raw.queuedRequests)) invalid();
    if (raw.capacity !== undefined && (!isCount(raw.capacity) || raw.capacity > 1024)) invalid();
    const reported = raw.capacity as number | undefined;
    const capacity = probe.capacity === undefined ? reported : reported === undefined ? probe.capacity : Math.min(probe.capacity, reported);
    return { activeRequests: raw.activeRequests, ...(raw.queuedRequests !== undefined ? { queuedRequests: raw.queuedRequests as number } : {}), ...(capacity !== undefined ? { capacity } : {}) };
}

/** Freshness must be evaluated when routing, not only when the polling timer runs. */
export function currentLoad(observation: ProviderLoadObservation | undefined, probe: LoadProbe, now = Date.now()): ProviderLoadObservation | undefined {
    if (!observation) return undefined;
    if (observation.kind !== probe.kind) return { ...observation, status: 'unknown', reason: 'Il probe configurato è cambiato; serve una nuova osservazione.' };
    if (observation.status === 'unknown' && !observation.observedAt) return observation;
    const observedAt = observation.observedAt ? Date.parse(observation.observedAt) : NaN;
    const age = now - observedAt;
    const maximum = probe.maxAgeMs ?? 6000;
    if (!Number.isFinite(observedAt) || age < -1000 || age > maximum || (observation.expiresAt && Date.parse(observation.expiresAt) < now))
        return { ...observation, status: 'stale', reason: 'Il dato di carico è scaduto; attendo un nuovo campione dal motore.' };
    return observation;
}

/** One bounded GET to the exact operator-configured endpoint. No autodiscovery. */
export async function sampleProviderLoad(target: LoadProbeTarget, signal: AbortSignal): Promise<ProviderLoadObservation> {
    if (!target.loadProbe) throw new Error('LOAD_CONFIG');
    const probe = target.loadProbe, lastAttemptAt = new Date().toISOString();
    const base = { providerId: target.id, kind: probe.kind, lastAttemptAt, source: 'engine' as const };
    let attempt: AbortSignal | undefined;
    try {
        const validated = config(probe);
        attempt = AbortSignal.any([signal, AbortSignal.timeout(validated.timeoutMs)]);
        const response = await pinnedFetch(validated.url, { method: 'GET', signal: attempt, headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
        if (!response.ok) { await response.body?.cancel(); throw new Error('LOAD_HTTP_' + response.status); }
        const values = counters(await readJSON(response, attempt, 512 * 1024), probe);
        const observedAt = new Date().toISOString();
        const saturated = (values.queuedRequests ?? 0) > 0 || (values.capacity !== undefined && values.activeRequests! >= values.capacity);
        const uncertain = values.capacity === undefined && values.activeRequests! > 0 && !saturated;
        return {
            ...base, ...values, status: saturated ? 'busy' : uncertain ? 'unknown' : 'available', observedAt,
            expiresAt: new Date(Date.parse(observedAt) + validated.maxAgeMs).toISOString(),
            reason: saturated ? 'Il motore segnala slot occupati o richieste in coda.' : uncertain ? 'Richieste attive osservate; capacità del motore non dichiarata.' : 'Contatori del motore osservati: capacità disponibile.'
        };
    } catch (error) {
        signal.throwIfAborted();
        const code = error instanceof Error ? error.message : '';
        const reason = attempt?.aborted ? 'Il probe del motore ha superato il timeout.'
            : /^LOAD_HTTP_\d{3}$/.test(code) ? 'Il probe del motore ha risposto HTTP ' + code.slice(-3) + '.'
            : code === 'LOAD_CONFIG' ? 'Configurazione del probe non valida.'
            : 'Carico del motore non verificabile: probe non raggiungibile o risposta non valida.';
        // A failed probe does not retain zeros (or old nonzero counts) as if current.
        return { ...base, status: 'unknown', reason };
    }
}

export class InferenceLoadMonitor {
    readonly observations: Map<string, ProviderLoadObservation>;
    private refreshing?: Promise<ProviderLoadObservation[]>;
    private sequence = 0;
    private releaseBarriers = new Map<string, number>();
    private observationSequence = new WeakMap<ProviderLoadObservation, number>();
    private pending = new Map<string, Promise<ProviderLoadObservation>>();
    private slots = new Scheduler([{ id: 'load-probes', label: 'Load probes', nodeIds: [], capacity: 4 }]);
    constructor(observations: Map<string, ProviderLoadObservation> = new Map()) { this.observations = observations; }

    /** A sample started before a local release cannot distinguish our finished
     * request from external work. Require a new read, never subtract a count. */
    afterRelease(providerIds: string[]): void {
        if (!providerIds.length) return;
        const barrier = ++this.sequence;
        for (const id of providerIds) this.releaseBarriers.set(id, barrier);
    }
    needsReconciliation(providerId: string): boolean {
        const barrier = this.releaseBarriers.get(providerId);
        if (barrier === undefined) return false;
        const observation = this.observations.get(providerId);
        return !observation || (this.observationSequence.get(observation) ?? -1) <= barrier;
    }

    private waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
            promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        });
    }
    private read(target: LoadProbeTarget, signal: AbortSignal, priority: SchedulePriority): Promise<ProviderLoadObservation> {
        const pending = this.pending.get(target.id);
        if (pending) return this.waitFor(pending, signal);
        const reading = (async () => {
            const release = await this.slots.acquire(['load-probes'], signal, { priority });
            try {
                signal.throwIfAborted();
                // Monotonic ordering also handles two operations in one millisecond
                // and a response arriving after the lease that it sampled ended.
                const sequence = ++this.sequence;
                const observation = await sampleProviderLoad(target, signal);
                this.observationSequence.set(observation, sequence);
                this.observations.set(target.id, observation);
                return observation;
            } finally { release(); }
        })();
        this.pending.set(target.id, reading);
        void reading.finally(() => { if (this.pending.get(target.id) === reading) this.pending.delete(target.id); }).catch(() => {});
        return reading;
    }

    /** Only operator-configured related probes; no eviction of other observations.
     * Caller supplies a deadline covering queueing and any pre-release read. */
    async reconcile(providers: LoadProbeTarget[], signal: AbortSignal): Promise<void> {
        const targets = [...new Map(providers.filter(provider => provider.enabled !== false && provider.loadProbe).map(provider => [provider.id, provider])).values()];
        await Promise.all(targets.map(async target => {
            while (this.needsReconciliation(target.id)) {
                signal.throwIfAborted();
                await this.read(target, signal, 'interactive');
            }
        }));
    }

    refresh(providers: LoadProbeTarget[], signal: AbortSignal): Promise<ProviderLoadObservation[]> {
        if (this.refreshing) return this.refreshing;
        const targets = providers.filter(provider => provider.enabled !== false && provider.loadProbe).slice(0, 200);
        const activeIds = new Set(targets.map(target => target.id));
        for (const id of this.observations.keys()) if (!activeIds.has(id)) { this.observations.delete(id); this.releaseBarriers.delete(id); }
        this.refreshing = (async () => {
            let cursor = 0;
            const worker = async () => {
                while (cursor < targets.length) {
                    signal.throwIfAborted();
                    const target = targets[cursor++];
                    await this.read(target, signal, 'background');
                }
            };
            await Promise.allSettled(Array.from({ length: Math.min(4, targets.length) }, worker));
            return this.snapshot(providers);
        })().finally(() => { this.refreshing = undefined; });
        return this.refreshing;
    }
    snapshot(providers: LoadProbeTarget[]): ProviderLoadObservation[] {
        return providers.filter(target => target.enabled !== false && target.loadProbe).flatMap(target => {
            const observation = currentLoad(this.observations.get(target.id), target.loadProbe!);
            return observation ? [observation] : [];
        });
    }
}
