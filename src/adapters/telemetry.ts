import { pinnedFetch, record, count, cleanLabel, readJSON } from './http-utils.ts';
import { isIP } from 'node:net';
import type { GpuTelemetry, LocalTelemetry, NetworkInterfaceTelemetry } from './local-telemetry.ts';

export interface TelemetryTarget { id: string; url: string; secret?: string; gatewayNodeKey?: 'node01' | 'node02' | 'aireward'; staleAfterMs?: number; }
export interface NodeTelemetry extends Omit<LocalTelemetry, 'schema' | 'observedAt'> {
  nodeId: string;
  observedAt?: string;
  lastAttemptAt: string;
  status: 'online' | 'offline' | 'stale' | 'unknown';
  quality: 'measured' | 'legacy-unverified' | 'unknown';
}
function finiteFields<T extends object>(raw: unknown, names: string[]): T {
  const source = record(raw), result: Record<string, number> = {};
  for (const key of names) { const n = count(source[key]); if (n !== undefined) result[key] = n; }
  return result as T;
}
function timestamp(value: unknown, now: number): string | undefined {
  const date = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) && date > 0 && date <= now + 60_000 ? new Date(date).toISOString() : undefined;
}
export function normalizeTelemetry(payload: unknown, target: Pick<TelemetryTarget, 'id' | 'gatewayNodeKey' | 'staleAfterMs'>, now = Date.now()): NodeTelemetry {
  const outer = record(payload), telemetry = record(outer.telemetry);
  const raw = target.gatewayNodeKey ? record((Object.keys(telemetry).length ? telemetry : outer)[target.gatewayNodeKey]) : outer;
  const result: NodeTelemetry = { nodeId: target.id, hostname: cleanLabel(raw.hostname, target.id), lastAttemptAt: new Date(now).toISOString(), status: 'unknown', quality: 'unknown', cpu: {}, memory: {}, gpus: [], errors: [] };
  if (raw.schema !== 'yed1z.telemetry.v1') {
    // The old node agent fabricates temperatures/power/RAM on probe failure. A gateway
    // timestamp certifies receipt only; it cannot certify those upstream measurements.
    result.quality = 'legacy-unverified'; result.errors.push('legacy_sensor_values_not_verified');
    return result;
  }
  result.observedAt = timestamp(raw.observedAt, now);
  result.quality = 'measured';
  result.status = !result.observedAt ? 'unknown' : now - Date.parse(result.observedAt) > (target.staleAfterMs ?? 15_000) ? 'stale' : 'online';
  result.cpu = finiteFields(raw.cpu, ['utilization', 'temperatureC']);
  result.memory = finiteFields(raw.memory, ['usedBytes', 'totalBytes']);
  result.disk = finiteFields(raw.disk, ['usedBytes', 'totalBytes']);
  result.gpus = Array.isArray(raw.gpus) ? raw.gpus.slice(0, 16).map(value => {
    const gpu = record(value);
    return { name: cleanLabel(gpu.name, 'GPU'), ...(gpu.vendor === 'amd' || gpu.vendor === 'nvidia' ? { vendor: gpu.vendor } : {}), ...finiteFields<Record<string, number>>(gpu, ['utilization', 'temperatureC', 'memoryUsedBytes', 'memoryTotalBytes', 'powerWatts', 'clockMHz', 'fanPercent']) } as GpuTelemetry;
  }) : [];
  if (Array.isArray(raw.network)) result.network = raw.network.slice(0, 128).flatMap(value => {
    const row = record(value); if (typeof row.name !== 'string' || !/^[A-Za-z0-9_.:@-]{1,64}$/.test(row.name)) return [];
    const item: NetworkInterfaceTelemetry = { name: row.name };
    if (typeof row.up === 'boolean') item.up = row.up;
    if (typeof row.mac === 'string' && /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(row.mac)) item.mac = row.mac;
    if (Array.isArray(row.addresses)) item.addresses = row.addresses.filter((address): address is string => {
      if (typeof address !== 'string' || address.length > 100) return false;
      const parts = address.split('/'), family = isIP(parts[0]);
      return family > 0 && (parts.length === 1 || (parts.length === 2 && /^\d{1,3}$/.test(parts[1]) && Number(parts[1]) <= (family === 4 ? 32 : 128)));
    }).slice(0, 32);
    const speed = count(row.speedMbps); if (speed !== undefined) item.speedMbps = speed;
    for (const key of ['rxBytes', 'txBytes', 'rxErrors', 'txErrors'] as const) {
      const n = count(row[key]); if (n !== undefined && Number.isSafeInteger(n)) item[key] = n;
    }
    return [item];
  });
  result.errors = Array.isArray(raw.errors) ? raw.errors.filter(v => typeof v === 'string' && /^[a-z0-9_]{1,80}$/.test(v)).slice(0, 32) as string[] : [];
  return result;
}
export async function sampleTelemetry(target: TelemetryTarget, signal?: AbortSignal): Promise<NodeTelemetry> {
  const attempt = new Date().toISOString();
  const scoped = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  try {
    const url = new URL(target.url);
    if (url.username || url.password || url.search || url.hash) throw new Error('Invalid telemetry endpoint.');
    const response = await pinnedFetch(url, { headers: target.secret ? { authorization: `Bearer ${target.secret}` } : {}, signal: scoped });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Telemetry unavailable.'); }
    return normalizeTelemetry(await readJSON(response, scoped, 1024 * 1024), target);
  } catch {
    signal?.throwIfAborted();
    return { nodeId: target.id, hostname: target.id, lastAttemptAt: attempt, status: 'offline', quality: 'unknown', cpu: {}, memory: {}, gpus: [], errors: ['probe_failed'] };
  }
}
