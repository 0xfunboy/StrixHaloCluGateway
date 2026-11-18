import test from 'node:test';
import assert from 'node:assert/strict';
import type { Catalog } from '../src/catalog.ts';
import type { User } from '../src/contracts.ts';
import { routingPreferences } from '../src/request-policy.ts';

const member: User = { id: 'member', name: 'Member', role: 'member', createdAt: '2026-11-17T00:00:00.000Z' };
const catalog = { models: () => [{ id: 'visible-route' }] } as unknown as Catalog;

test('shared project defaults cannot authorize private fallback routes or prevent a member chat', () => {
  const inherited = { strategy: 'auto' as const, fallbackRouteIds: ['private-owner-route', 'visible-route'], maxWaitMs: 1000 };
  assert.deepEqual(routingPreferences(member, catalog, undefined, inherited), { strategy: 'auto', fallbackRouteIds: ['visible-route'], maxWaitMs: 1000 });
  assert.deepEqual(routingPreferences(member, catalog, { strategy: 'pinned' }, inherited), { strategy: 'pinned', fallbackRouteIds: ['visible-route'], maxWaitMs: 1000 });
  assert.deepEqual(inherited.fallbackRouteIds, ['private-owner-route', 'visible-route']);
});

test('explicit inaccessible routing alternatives remain an error and an empty pool removes inherited alternatives', () => {
  assert.throws(() => routingPreferences(member, catalog, { fallbackRouteIds: ['private-owner-route'] }), { status: 404, code: 'NOT_FOUND' });
  assert.deepEqual(routingPreferences(member, catalog, { fallbackRouteIds: [] }, { strategy: 'auto', fallbackRouteIds: ['visible-route'] }), { strategy: 'auto', fallbackRouteIds: [] });
});
