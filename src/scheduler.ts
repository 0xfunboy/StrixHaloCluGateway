import type { ResourceGroup } from './contracts.ts';
import { AppError } from './util.ts';
/** Atomic multi-resource reservations. Never hold half a distributed inference route. */
export class Scheduler {
    groups: Map<string, ResourceGroup>;
    used = new Map<string, number>();
    queue: Array<{
        groups: string[];
        signal: AbortSignal;
        resolve: (release: () => void) => void;
        reject: (e: Error) => void;
        abort: () => void;
    }> = [];
    constructor(groups: ResourceGroup[]) { this.groups = new Map(groups.map(g => [g.id, g])); }
    snapshot(): Record<string, number> { return Object.fromEntries(this.used); }
    acquire(groupIds: string[], signal: AbortSignal): Promise<() => void> {
        signal.throwIfAborted();
        const groups = [...new Set(groupIds)].sort();
        for (const key of groups)
            if (!this.groups.has(key))
                throw new AppError(400, 'RESOURCE', 'Risorsa non configurata: ' + key);
        return new Promise((resolve, reject) => { const item = { groups, signal, resolve, reject, abort: () => { this.queue = this.queue.filter(x => x !== item); reject(new DOMException('Cancelled', 'AbortError')); this.drain(); } }; signal.addEventListener('abort', item.abort, { once: true }); this.queue.push(item); this.drain(); });
    }
    drain(): void {
        const blocked = new Set<string>();
        for (const item of [...this.queue]) {
            if (item.signal.aborted)
                continue;
            if (item.groups.some(g => blocked.has(g) || (this.used.get(g) ?? 0) >= this.groups.get(g)!.capacity)) {
                for (const g of item.groups)
                    blocked.add(g);
                continue;
            }
            this.queue = this.queue.filter(x => x !== item);
            item.signal.removeEventListener('abort', item.abort);
            for (const g of item.groups)
                this.used.set(g, (this.used.get(g) ?? 0) + 1);
            let released = false;
            item.resolve(() => { if (released)
                return; released = true; for (const g of item.groups)
                this.used.set(g, Math.max(0, (this.used.get(g) ?? 0) - 1)); this.drain(); });
        }
    }
}
