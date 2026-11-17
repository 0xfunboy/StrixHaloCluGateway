import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdapterConnection, DiscoveryResult, DiscoveredModel } from './types.ts';
import { cleanLabel, unknownQuota } from './http-utils.ts';
import { JsonRpcProcess, RpcMethodError, RpcRemoteError, bounded, record } from './vendor/backends/rpc.ts';

/** Metadata-only ACP handshake. No prompt, tool capability, permission grant or OAuth-token read. */
export async function inspectAntigravity(options: { connection: AdapterConnection; signal: AbortSignal; timeoutMs?: number }): Promise<DiscoveryResult & { authenticated: boolean; capabilities: Record<string, unknown> }> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const directory = await mkdtemp(path.join(tmpdir(), 'yed1z-acp-inspection-'));
  const rpc = new JsonRpcProcess({
    label: 'Antigravity inspection', command: options.connection.command || 'agy',
    args: options.connection.args ?? ['acp', '--sandbox'], cwd: directory, env: options.connection.env,
    requestTimeoutMs: timeoutMs,
    onNotification: () => {},
    onRequest: async () => { throw new RpcMethodError('Model inspection does not authorize file, terminal or tool actions.'); }
  });
  const run = async () => {
    const initialized = record(await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'yed1z', title: 'yed1z Control Room', version: '0.4.0' }
    }, { signal: options.signal }));
    if (initialized.protocolVersion !== 1) throw new Error('Antigravity ACP version is unsupported. Update the official CLI or this adapter.');
    const authMethods = (Array.isArray(initialized.authMethods) ? initialized.authMethods : []).slice(0, 16)
      .map(value => record(value)).map(value => ({ id: cleanLabel(value.id), label: cleanLabel(value.name) })).filter(value => value.id);
    const capabilities = { modes: ['agent'], login: false, inspection: true, authMethods, approvalBoundary: 'official-runtime' };
    let session: Record<string, unknown>;
    try {
      session = record(await rpc.request('session/new', { cwd: directory, mcpServers: [] }, { signal: options.signal }));
    } catch (error) {
      if (!(error instanceof RpcRemoteError) || error.code !== -32000) throw error;
      return { models: [], authenticated: false, quota: unknownQuota(), capabilities,
        warnings: ['Accesso Antigravity richiesto. Sul coordinator, con lo stesso utente del servizio, esegui agy acp --login e poi Riprova.'] };
    }
    if (typeof session.sessionId !== 'string' || !session.sessionId) throw new Error('Antigravity did not confirm an ACP session.');
    const models = new Map<string, DiscoveredModel>();
    const add = (id: unknown, name: unknown) => {
      const key = cleanLabel(id);
      if (key && models.size < 500) models.set(key, { id: key, label: cleanLabel(name, key), capabilities: ['chat', 'tools'], capabilitySource: 'provider' });
    };
    const collect = (rows: unknown, depth = 0): void => {
      if (!Array.isArray(rows) || depth > 4) return;
      for (const raw of rows.slice(0, 500)) {
        const row = record(raw);
        if (typeof row.value === 'string') add(row.value, row.name);
        else collect(row.options, depth + 1);
      }
    };
    const configs = (Array.isArray(session.configOptions) ? session.configOptions : []).map(record);
    for (const config of configs.filter(option => option.category === 'model' && option.type === 'select')) collect(config.options);
    const legacy = record(session.models);
    if (!models.size) for (const raw of (Array.isArray(legacy.availableModels) ? legacy.availableModels : []).slice(0, 500)) {
      const row = record(raw); add(row.modelId, row.name);
    }
    const warnings: string[] = [];
    if (!models.size) {
      // "current" is a supported adapter selection, not an invented provider model ID.
      models.set('current', { id: 'current', label: 'Modello corrente della CLI Antigravity', capabilities: ['chat', 'tools'], capabilitySource: 'unknown' });
      warnings.push('La CLI è autenticata ma non espone un selettore modelli: viene mantenuto il modello corrente della CLI.');
    }
    warnings.push('Antigravity usa un solo profilo CLI del servizio. Quote numeriche e isolamento multiaccount non sono esposti da questo adapter.');
    return { models: [...models.values()], authenticated: true, quota: unknownQuota(), capabilities, warnings };
  };
  try { return await bounded(run(), options.signal, timeoutMs * 2, 'Antigravity inspection', rpc.failure); }
  finally { rpc.dispose(); await rm(directory, { recursive: true, force: true }); }
}
