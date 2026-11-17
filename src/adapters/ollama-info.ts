import type { AdapterConnection, DiscoveredModel } from './types.ts';
import { checkedJSON, integer, record } from './http-utils.ts';

/** /api/show reads metadata. It never generates, pulls or activates a model. */
export async function enrichOllamaModels(connection: AdapterConnection, models: DiscoveredModel[], secret: string | undefined, signal: AbortSignal): Promise<string[]> {
  const pending = models.filter(model => model.capabilitySource === 'unknown' || !model.contextWindow);
  const selected = pending.slice(0, 20);
  let unavailable = 0;
  for (let index = 0; index < selected.length; index += 4) {
    signal.throwIfAborted();
    await Promise.all(selected.slice(index, index + 4).map(async model => {
      try {
        const { data } = await checkedJSON(connection, '/api/show', secret, AbortSignal.any([signal, AbortSignal.timeout(1000)]), { model: model.id, verbose: false });
        const info = record(data), advertised = Array.isArray(info.capabilities) ? info.capabilities : undefined;
        if (advertised?.length) {
          const capabilities: DiscoveredModel['capabilities'] = [];
          if (advertised.includes('completion') || advertised.includes('chat')) capabilities.push('chat');
          if (advertised.includes('tools')) capabilities.push('tools');
          if (advertised.includes('embedding')) capabilities.push('embedding');
          if (advertised.includes('vision')) capabilities.push('vision');
          model.capabilities = capabilities;
          model.capabilitySource = 'provider';
        }
        const metadata = record(info.model_info), architecture = metadata['general.architecture'];
        const maximum = typeof architecture === 'string' ? integer(metadata[`${architecture}.context_length`]) : undefined;
        const parameters = record(info.parameters);
        const configured = integer(parameters.num_ctx) ?? (typeof info.parameters === 'string' ? Number(info.parameters.match(/^\s*num_ctx\s+(\d+)\s*$/m)?.[1] ?? 0) : 0);
        // Architecture maximum is not a measurement of allocated runtime context.
        // Only an explicit model num_ctx is admitted as the default context limit.
        if (Number.isSafeInteger(configured) && configured > 0 && configured <= 2000000) model.contextWindow = maximum && maximum > 0 ? Math.min(configured, maximum) : configured;
      } catch (error) {
        if (signal.aborted) throw error;
        unavailable++;
      }
    }));
  }
  signal.throwIfAborted();
  const warnings: string[] = [];
  if (unavailable) warnings.push(`Metadati Ollama non disponibili per ${unavailable} modelli. Le capacità non osservate restano sconosciute.`);
  if (pending.length > selected.length) warnings.push('La verifica metadati Ollama è limitata ai primi 20 modelli; gli altri mantengono le informazioni del catalogo.');
  return warnings;
}
