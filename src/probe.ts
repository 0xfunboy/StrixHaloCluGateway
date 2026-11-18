import { complete, discoverModels } from './adapters/index.ts';
import type { AdapterConnection } from './adapters/types.ts';
import { assert } from './util.ts';

export async function probeInference(connection: AdapterConnection, options: { secret?: string; model?: string; generate: boolean; signal: AbortSignal }) {
    const catalog = await discoverModels(connection, options.secret, options.signal);
    const models = catalog.models.map(m => m.id);
    const result = { models, catalogWarnings: catalog.warnings, quota: catalog.quota.state };
    if (!options.generate) return result;
    const model = options.model ?? catalog.models.find(m => !m.capabilities.includes('embedding') || m.capabilities.includes('chat'))?.id;
    assert(model && models.includes(model), 400, 'MODEL', 'Modello di chat assente dal catalogo.');
    let chunks = 0;
    const turn = await complete({ connection, model: { id: model, maxOutputTokens: 192, temperature: 0 },
        secret: options.secret, signal: options.signal, messages: [{ role: 'user', content: 'Return just the two letters OK. /no_think' }],
        onText: () => { chunks++; } });
    return { ...result, inference: { model, textReceived: Boolean(turn.text.trim()), exactOK: turn.text.trim() === 'OK',
        chunks, usage: turn.usage ?? null, ttftMs: turn.metrics.ttftMs ?? null, totalMs: turn.metrics.totalMs, finishReason: turn.finishReason ?? null } };
}
