/** Public routing data. No account owners, credentials or other users' task text. */
export type RoutePurpose = 'chat' | 'primary' | 'researcher' | 'coder' | 'reviewer' | 'embedding';
export interface RouteDecision {
    requestedRouteId: string;
    chosenRouteId: string;
    switched: boolean;
    waitMs: number;
    reason: string;
}
export interface RouteAvailability {
    routeId: string;
    status: 'available' | 'busy' | 'cooldown' | 'disabled' | 'unavailable' | 'unknown';
    activeCount: number;
    queueCount: number;
    externalActiveRequests?: number;
    externalQueuedRequests?: number;
    resourceGroupIds: string[];
    busyResourceIds: string[];
    busyResourceLabels: string[];
    oldestWaitMs?: number;
    cooldownUntil?: string;
    reason: string;
    observedAt: string;
    source: 'coordinator' | 'provider' | 'configuration';
}
