import { readFile, readdir, statfs } from 'node:fs/promises';
import { hostname, totalmem, freemem, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface GpuTelemetry {
  name: string;
  vendor?: 'nvidia' | 'amd';
  utilization?: number;
  temperatureC?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  powerWatts?: number;
  clockMHz?: number;
  fanPercent?: number;
}
export interface LocalTelemetry {
  schema: 'yed1z.telemetry.v1';
  observedAt: string;
  hostname: string;
  cpu: { utilization?: number; temperatureC?: number };
  memory: { usedBytes?: number; totalBytes?: number };
  disk?: { usedBytes?: number; totalBytes?: number };
  gpus: GpuTelemetry[];
  network?: NetworkInterfaceTelemetry[];
  errors: string[];
}
export interface NetworkInterfaceTelemetry {
  name: string;
  up?: boolean;
  mac?: string;
  addresses?: string[];
  speedMbps?: number;
  rxBytes?: number;
  txBytes?: number;
  rxErrors?: number;
  txErrors?: number;
}
const numeric = (value: string, divisor = 1): number | undefined => { const n = Number(value.trim()); return value.trim() && Number.isFinite(n) && n >= 0 ? n / divisor : undefined; };
async function value(file: string, divisor = 1): Promise<number | undefined> { try { return numeric(await readFile(file, 'utf8'), divisor); } catch { return; } }
async function dirs(root: string): Promise<string[]> { try { return await readdir(root); } catch { return []; } }
async function cpuCounters(): Promise<{ total: number; idle: number } | undefined> {
  try {
    const fields = (await readFile('/proc/stat', 'utf8')).split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 8 || fields.some(n => !Number.isFinite(n))) return;
    // Guest counters are already included in user/nice and must not be counted twice.
    return { total: fields.slice(0, 8).reduce((a, b) => a + b, 0), idle: fields[3] + fields[4] };
  } catch { return; }
}
async function gpuSysfs(): Promise<GpuTelemetry[]> {
  const result: GpuTelemetry[] = [];
  for (const name of (await dirs('/sys/class/drm')).filter(name => /^card\d+$/.test(name)).slice(0, 16)) {
    const root = `/sys/class/drm/${name}/device`;
    let vendor = ''; try { vendor = (await readFile(join(root, 'vendor'), 'utf8')).trim(); } catch { continue; }
    if (vendor !== '0x1002') continue;
    const sensors = await dirs(join(root, 'hwmon'));
    const hwmon = sensors[0] ? join(root, 'hwmon', sensors[0]) : undefined;
    const [utilization, memoryUsedBytes, memoryTotalBytes, temperatureC, powerWatts] = await Promise.all([
      value(join(root, 'gpu_busy_percent')), value(join(root, 'mem_info_vram_used')), value(join(root, 'mem_info_vram_total')),
      hwmon ? value(join(hwmon, 'temp1_input'), 1000) : undefined, hwmon ? value(join(hwmon, 'power1_average'), 1_000_000) : undefined,
    ]);
    result.push({ name: `AMD ${name}`, vendor: 'amd', ...(utilization !== undefined ? { utilization } : {}), ...(memoryUsedBytes !== undefined ? { memoryUsedBytes } : {}), ...(memoryTotalBytes !== undefined ? { memoryTotalBytes } : {}), ...(temperatureC !== undefined ? { temperatureC } : {}), ...(powerWatts !== undefined ? { powerWatts } : {}) });
  }
  return result;
}
async function nvidia(signal?: AbortSignal): Promise<GpuTelemetry[]> {
  const result = await exec('nvidia-smi', ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,clocks.current.sm,fan.speed', '--format=csv,noheader,nounits'], { timeout: 2500, maxBuffer: 64 * 1024, signal, env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  return result.stdout.trim().split('\n').filter(Boolean).slice(0, 16).flatMap(line => {
    const row = line.split(',').map(p => p.trim()); if (row.length !== 8) return [];
    const [name, ...fields] = row; const values = fields.map(x => numeric(x));
    const keys: Array<keyof Omit<GpuTelemetry, 'name' | 'vendor'>> = ['utilization', 'temperatureC', 'memoryUsedBytes', 'memoryTotalBytes', 'powerWatts', 'clockMHz', 'fanPercent'];
    const gpu: GpuTelemetry = { name: name.slice(0, 180), vendor: 'nvidia' };
    keys.forEach((key, i) => { if (values[i] !== undefined) gpu[key] = values[i]! * (key.startsWith('memory') ? 1024 ** 2 : 1); });
    return [gpu];
  });
}

async function network(): Promise<NetworkInterfaceTelemetry[]> {
  const addresses = networkInterfaces();
  const names = (await dirs('/sys/class/net')).filter(name => name !== 'lo' && /^[A-Za-z0-9_.:@-]{1,64}$/.test(name)).slice(0, 128);
  return await Promise.all(names.map(async name => {
    const root = join('/sys/class/net', name), result: NetworkInterfaceTelemetry = { name };
    const observedAddresses = [...new Set((addresses[name] ?? []).map(row => row.cidr ?? row.address).filter(Boolean))];
    if (observedAddresses.length) result.addresses = observedAddresses.slice(0, 32);
    let state = ''; try { state = (await readFile(join(root, 'operstate'), 'utf8')).trim(); } catch { /* Unknown remains absent. */ }
    if (state === 'up') result.up = true;
    else if (['down', 'notpresent', 'lowerlayerdown', 'dormant'].includes(state)) result.up = false;
    else {
      const carrier = await value(join(root, 'carrier')); if (carrier === 0 || carrier === 1) result.up = carrier === 1;
    }
    try { const mac = (await readFile(join(root, 'address'), 'utf8')).trim(); if (/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(mac)) result.mac = mac; } catch { /* Optional hardware identifier. */ }
    const [speed, rx, tx, rxErrors, txErrors] = await Promise.all([
      value(join(root, 'speed')), value(join(root, 'statistics', 'rx_bytes')), value(join(root, 'statistics', 'tx_bytes')),
      value(join(root, 'statistics', 'rx_errors')), value(join(root, 'statistics', 'tx_errors')),
    ]);
    if (speed !== undefined) result.speedMbps = speed;
    for (const [key, n] of [['rxBytes', rx], ['txBytes', tx], ['rxErrors', rxErrors], ['txErrors', txErrors]] as const) {
      if (n !== undefined && Number.isSafeInteger(n)) result[key] = n;
    }
    return result;
  }));
}

/** One-shot probe; missing sensors stay absent. Never returns guessed hardware values. */
export async function collectLocalTelemetry(signal?: AbortSignal): Promise<LocalTelemetry> {
  signal?.throwIfAborted();
  const totalBytes = totalmem(), freeBytes = freemem();
  const result: LocalTelemetry = { schema: 'yed1z.telemetry.v1', hostname: hostname(), observedAt: new Date().toISOString(), cpu: {}, memory: { totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes) }, gpus: [], errors: [] };
  try {
    const info = await readFile('/proc/meminfo', 'utf8');
    const total = /^MemTotal:\s+(\d+)\s+kB$/m.exec(info), available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
    if (total && available) result.memory = { totalBytes: Number(total[1]) * 1024, usedBytes: Math.max(0, Number(total[1]) - Number(available[1])) * 1024 };
  } catch { /* Non-Linux systems retain the OS-provided total/free measurements. */ }
  const first = await cpuCounters();
  const sampling = (async () => {
    if (!first) return;
    await new Promise<void>(resolve => setTimeout(resolve, 120));
    const second = await cpuCounters(); const delta = second ? second.total - first.total : 0;
    if (second && delta > 0) result.cpu.utilization = Math.max(0, Math.min(100, (1 - (second.idle - first.idle) / delta) * 100));
  })();
  const [nv, amd] = await Promise.allSettled([nvidia(signal), gpuSysfs()]);
  if (nv.status === 'fulfilled') result.gpus.push(...nv.value);
  if (amd.status === 'fulfilled') result.gpus.push(...amd.value);
  if (!result.gpus.length) result.errors.push('gpu_sensor_unavailable');
  for (const directory of (await dirs('/sys/class/hwmon')).slice(0, 64)) {
    const root = join('/sys/class/hwmon', directory); let sensor = '';
    try { sensor = (await readFile(join(root, 'name'), 'utf8')).trim(); } catch { continue; }
    if (!['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'].includes(sensor)) continue;
    for (const input of (await dirs(root)).filter(p => /^temp\d+_input$/.test(p)).slice(0, 32)) {
      const c = await value(join(root, input), 1000); if (c !== undefined && c <= 150) result.cpu.temperatureC = Math.max(result.cpu.temperatureC ?? c, c);
    }
  }
  try {
    const info = await statfs('/'); result.disk = { totalBytes: info.blocks * info.bsize, usedBytes: (info.blocks - info.bfree) * info.bsize };
  } catch { result.errors.push('disk_sensor_unavailable'); }
  try { result.network = await network(); if (!result.network.length) result.errors.push('network_sensor_unavailable'); }
  catch { result.errors.push('network_sensor_unavailable'); }
  await sampling; signal?.throwIfAborted(); result.observedAt = new Date().toISOString(); return result;
}
