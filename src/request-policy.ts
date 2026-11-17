import type { RoutingPreferences, User } from './contracts.ts';
import type { Catalog } from './catalog.ts';
import { assert, integer, object, textList } from './util.ts';

export function routingPreferences(user: User, catalog: Catalog, value: unknown, defaults?: RoutingPreferences): RoutingPreferences {
  const input = value === undefined ? {} : object(value);
  const strategy = input.strategy ?? defaults?.strategy ?? 'auto';
  assert(strategy === 'auto' || strategy === 'pinned', 400, 'ROUTING', 'Strategia di routing non valida.');
  const explicitAlternatives = input.fallbackRouteIds !== undefined;
  const requestedAlternatives = [...new Set(explicitAlternatives ? textList(input.fallbackRouteIds, 32) : defaults?.fallbackRouteIds ?? [])];
  const visible = new Set(catalog.models(user).map(route => route.id));
  // A shared project may inherit its owner's private routes. They are not
  // authorized for a member and must not prevent that member's own chat.
  if (explicitAlternatives) assert(requestedAlternatives.every(routeId => visible.has(routeId)), 404, 'NOT_FOUND', 'Una delle alternative di routing non è disponibile per questo account.');
  const fallbackRouteIds = requestedAlternatives.filter(routeId => visible.has(routeId));
  const maxWaitMs = input.maxWaitMs === undefined ? defaults?.maxWaitMs : integer(input.maxWaitMs, 8000, 0, 120000);
  return { strategy, fallbackRouteIds, ...(maxWaitMs === undefined ? {} : { maxWaitMs }) };
}
