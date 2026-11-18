import type { Account, Bootstrap, ModelRoute, Provider, Telemetry, User } from './contracts.ts';
import type { Config } from './config.ts';
import type { Catalog } from './catalog.ts';
import type { Store } from './store.ts';

export const guestUser: User = { id: 'guest', name: 'Ospite', role: 'viewer', createdAt: '2026-01-01T00:00:00.000Z' };

/** Public HUD observations intentionally exclude private connection endpoints,
 * account identities, node addresses, command recipes and sensor error strings. */
export function publicTelemetry(values: Telemetry[]): Telemetry[] {
  return values.map(value => {
    const { error: _error, details: _details, ...result } = value;
    return result;
  });
}

export function publicBootstrap(version: string, config: Config, catalog: Catalog, store: Store): Bootstrap {
  const configured = new Set(config.providers.filter(p => !['codex', 'antigravity'].includes(p.kind) && (p.tag === 'cluster' || p.tag === 'local' || p.nodeIds.length > 0)).map(p => p.id));
  const sharedAccounts = new Set(store.all<Account>('account').filter(a => a.shared && configured.has(a.providerId)).map(a => a.id));
  const providers = store.all<Provider>('provider').filter(p => configured.has(p.id)).map(p => ({
    id: p.id, label: p.label, kind: p.kind, tag: p.tag, nodeIds: p.nodeIds,
    resourceGroupIds: p.resourceGroupIds, enabled: p.enabled, ownerId: 'public', createdAt: p.createdAt
  }));
  const models = store.all<ModelRoute>('model').filter(m => m.enabled && configured.has(m.providerId) && sharedAccounts.has(m.accountId)).map(m => ({ ...m, accountId: 'public' }));
  return {
    version, user: { ...guestUser }, projects: [], conversations: [], providers, accounts: [], models,
    nodes: config.nodes.map(n => ({ id: n.id, label: n.label, kind: n.kind, capabilities: n.capabilities })),
    links: config.links.map(l => ({ id: l.id, from: l.from, to: l.to, label: l.label, status: l.status })),
    resourceGroups: config.resourceGroups,
    telemetry: publicTelemetry([...catalog.telemetry.values()]), runs: [], approvals: [], memories: [], artifacts: [], evidence: [], targets: [],
    resourceUsage: catalog.scheduler.snapshot(), routeAvailability: [], demo: config.demo
  };
}
