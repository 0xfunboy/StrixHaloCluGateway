/** Config-only read endpoint. Never accepted from a chat message or web client. */
export interface LoadProbe {
    kind: 'llama-slots' | 'json';
    url: string;
    capacity?: number;
    timeoutMs?: number;
    maxAgeMs?: number;
}
/** Engine counters only: raw slot parameters/prompts and probe URLs are discarded. */
export interface ProviderLoadObservation {
    providerId: string;
    kind: LoadProbe['kind'];
    status: 'available' | 'busy' | 'unknown' | 'stale';
    activeRequests?: number;
    queuedRequests?: number;
    capacity?: number;
    observedAt?: string;
    lastAttemptAt: string;
    expiresAt?: string;
    reason: string;
    source: 'engine';
}
export interface LoadProbeTarget {
    id: string;
    enabled?: boolean;
    loadProbe?: LoadProbe;
}
