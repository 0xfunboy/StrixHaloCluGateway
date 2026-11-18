import type { ResourceGroup } from './contracts.ts';
import { AppError } from './util.ts';

export type SchedulePriority = 'interactive' | 'normal' | 'background';
export interface ScheduleChoice { id: string; groups: string[]; }
export interface QueueWait {
    queuedAt: string;
    waitedMs: number;
    /** Position among requests sharing at least one candidate resource. */
    position: number;
    candidateIds: string[];
    busyResourceIds: string[];
}
export interface ScheduleOptions {
    priority?: SchedulePriority;
    maxWaitMs?: number;
    onQueued?: (wait: QueueWait) => void;
}
export interface Reservation { choiceId: string; release: () => void; waitMs: number; }
interface Waiter {
    choices: ScheduleChoice[];
    groups: string[];
    signal: AbortSignal;
    priority: SchedulePriority;
    queuedAt: number;
    sequence: number;
    bypasses: number;
    resolve: (reservation: Reservation) => void;
    reject: (error: Error) => void;
    abort: () => void;
    timer?: ReturnType<typeof setTimeout>;
    onQueued?: (wait: QueueWait) => void;
}
export interface ResourceInspection {
    activeCount: number;
    queueCount: number;
    busyResourceIds: string[];
    oldestWaitMs?: number;
}

/**
 * Atomic reservations across all groups of one inference route. An automatic
 * request is one queue entry with alternatives, never several competing leases.
 * Interactive requests can bypass older work at most three grants in a row.
 */
export class Scheduler {
    groups: Map<string, ResourceGroup>;
    used = new Map<string, number>();
    queue: Waiter[] = [];
    private hidden = new Set<string>();
    private sequence = 0;
    private draining = false;
    private dirty = false;

    constructor(groups: ResourceGroup[]) {
        this.groups = new Map();
        for (const group of groups) {
            if (this.groups.has(group.id)) throw new AppError(400, 'RESOURCE', 'Risorsa duplicata: ' + group.id);
            this.ensureGroup(group);
        }
    }

    /** Private account semaphores must not appear in the public fleet snapshot. */
    ensureGroup(group: ResourceGroup, hidden = false): void {
        if (!group.id || !Number.isSafeInteger(group.capacity) || group.capacity < 1 || group.capacity > 64)
            throw new AppError(400, 'RESOURCE', 'Capacità della risorsa non valida.');
        const changed = this.groups.get(group.id)?.capacity !== group.capacity;
        this.groups.set(group.id, { ...group, nodeIds: [...group.nodeIds] });
        if (hidden) this.hidden.add(group.id);
        if (changed && this.queue.length) this.drain();
    }

    snapshot(): Record<string, number> {
        return Object.fromEntries([...this.used].filter(([key]) => !this.hidden.has(key)));
    }

    inspect(groupIds: string[]): ResourceInspection {
        const groups = new Set(groupIds), waiters = this.queue.filter(item => item.groups.some(g => groups.has(g)));
        const busyResourceIds = groupIds.filter(g => (this.used.get(g) ?? 0) >= (this.groups.get(g)?.capacity ?? 1));
        return {
            activeCount: Math.max(0, ...groupIds.map(g => this.used.get(g) ?? 0)),
            queueCount: waiters.length,
            busyResourceIds,
            ...(waiters.length ? { oldestWaitMs: Math.max(0, Date.now() - Math.min(...waiters.map(item => item.queuedAt))) } : {})
        };
    }

    async acquire(groupIds: string[], signal: AbortSignal, options: ScheduleOptions = {}): Promise<() => void> {
        return (await this.acquireAny([{ id: 'selected', groups: groupIds }], signal, options)).release;
    }

    acquireAny(input: ScheduleChoice[], signal: AbortSignal, options: ScheduleOptions = {}): Promise<Reservation> {
        signal.throwIfAborted();
        if (!input.length || input.length > 64 || new Set(input.map(c => c.id)).size !== input.length)
            throw new AppError(400, 'RESOURCE', 'Elenco delle alternative non valido.');
        if (options.maxWaitMs !== undefined && (!Number.isSafeInteger(options.maxWaitMs) || options.maxWaitMs < 0 || options.maxWaitMs > 300000))
            throw new AppError(400, 'RESOURCE', 'Attesa massima non valida.');
        if (options.priority && !['interactive', 'normal', 'background'].includes(options.priority))
            throw new AppError(400, 'RESOURCE', 'Priorità non valida.');
        const choices = input.map(choice => ({ id: choice.id, groups: [...new Set(choice.groups)].sort() }));
        const groups = [...new Set(choices.flatMap(choice => choice.groups))];
        for (const key of groups)
            if (!this.groups.has(key)) throw new AppError(400, 'RESOURCE', 'Risorsa non configurata: ' + key);
        return new Promise((resolve, reject) => {
            const item: Waiter = {
                choices, groups, signal, priority: options.priority ?? 'normal', queuedAt: Date.now(), sequence: ++this.sequence, bypasses: 0,
                resolve, reject, onQueued: options.onQueued,
                abort: () => this.reject(item, signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled', 'AbortError'))
            };
            signal.addEventListener('abort', item.abort, { once: true });
            this.queue.push(item);
            this.drain();
            if (!this.queue.includes(item)) return;
            const timeout = () => this.reject(item, new AppError(503, 'QUEUE_TIMEOUT', 'Risorse occupate: attesa massima raggiunta. Scegli una connessione disponibile o riprova.'));
            if (options.maxWaitMs === 0) timeout();
            else if (options.maxWaitMs !== undefined) item.timer = setTimeout(timeout, options.maxWaitMs);
        });
    }

    private remove(item: Waiter): boolean {
        const index = this.queue.indexOf(item);
        if (index < 0) return false;
        this.queue.splice(index, 1);
        item.signal.removeEventListener('abort', item.abort);
        clearTimeout(item.timer);
        return true;
    }

    private reject(item: Waiter, error: Error): void {
        if (!this.remove(item)) return;
        item.reject(error);
        this.drain();
    }

    private ordered(): Waiter[] {
        const rank = { interactive: 0, normal: 1, background: 2 };
        // Protection belongs to each waiter, rather than a global oldest request:
        // a blocked request on B must not starve an independent old request on A.
        return [...this.queue].sort((a, b) => {
            const protectedA = a.bypasses >= 3, protectedB = b.bypasses >= 3;
            if (protectedA !== protectedB) return protectedA ? -1 : 1;
            return (protectedA ? 0 : rank[a.priority] - rank[b.priority]) || a.sequence - b.sequence;
        });
    }

    drain(): void {
        if (this.draining) { this.dirty = true; return; }
        this.draining = true;
        try {
            do {
                this.dirty = false;
                const blocked = new Set<string>();
                for (const item of this.ordered()) {
                    if (!this.queue.includes(item)) continue;
                    if (item.signal.aborted) { this.reject(item, item.signal.reason instanceof Error ? item.signal.reason : new DOMException('Cancelled', 'AbortError')); continue; }
                    const choice = item.choices.find(candidate => candidate.groups.every(g => !blocked.has(g) && (this.used.get(g) ?? 0) < this.groups.get(g)!.capacity));
                    if (!choice) {
                        for (const g of item.groups) blocked.add(g);
                        continue;
                    }
                    let newlyProtected = false;
                    for (const other of this.queue) {
                        if (other.sequence < item.sequence && other.priority !== item.priority && other.groups.some(g => choice.groups.includes(g))) {
                            other.bypasses++;
                            newlyProtected ||= other.bypasses === 3;
                        }
                    }
                    this.remove(item);
                    for (const group of choice.groups) this.used.set(group, (this.used.get(group) ?? 0) + 1);
                    let released = false;
                    item.resolve({ choiceId: choice.id, waitMs: Math.max(0, Date.now() - item.queuedAt), release: () => {
                        if (released) return;
                        released = true;
                        for (const group of choice.groups) this.used.set(group, Math.max(0, (this.used.get(group) ?? 0) - 1));
                        this.drain();
                    } });
                    if (newlyProtected) { this.dirty = true; break; }
                }
                const remaining = this.ordered();
                for (const item of remaining) {
                    if (!this.queue.includes(item) || !item.onQueued) continue;
                    const inspection = this.inspect(item.groups);
                    try { item.onQueued({ queuedAt: new Date(item.queuedAt).toISOString(), waitedMs: Math.max(0, Date.now() - item.queuedAt), position: remaining.slice(0, remaining.indexOf(item) + 1).filter(other => other.groups.some(g => item.groups.includes(g))).length, candidateIds: item.choices.map(c => c.id), busyResourceIds: inspection.busyResourceIds }); }
                    catch { /* Observability callbacks cannot change lease ownership. */ }
                }
            } while (this.dirty);
        } finally { this.draining = false; }
    }
}
