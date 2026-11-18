import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelRoute, NetworkLink, NodeConfig, Provider, ResourceGroup } from './contracts.ts';
import type { ExecutionTarget } from './execution/types.ts';
import type { LoadProbe } from './load-types.ts';
import { validateLoadProbe } from './inference-load.ts';
import { assert, endpoint, integer, object, str, textList } from './util.ts';
export interface Activation {
    targetId?: string;
    recipeId?: string;
    switchUrl?: string;
    stop?: { url: string; healthUrl: string };
    body?: Record<string, unknown>;
    modelsUrl: string;
    expectedModel: string;
    timeoutMs?: number;
}
export interface SeedProvider extends Omit<Provider, 'ownerId' | 'createdAt'> {
    models?: Array<{
        model: string;
        label: string;
        aliases?: string[];
        contextWindow?: number;
        capabilities?: string[];
    }>;
    secretEnv?: string;
    sharedAccount?: boolean;
    loadProbe?: LoadProbe;
    activation?: Activation;
    maxEmbeddingChars?: number;
}
export interface Config {
    defaultEmbeddingProviderId?: string;
    bind: string;
    port: number;
    publicOrigin?: string;
    secureCookies: boolean;
    demo: boolean;
    publicDashboard?: boolean;
    telemetryIntervalMs: number;
    nodes: NodeConfig[];
    links: NetworkLink[];
    resourceGroups: ResourceGroup[];
    targets: ExecutionTarget[];
    providers: SeedProvider[];
}
export const defaultConfig = (): Config => ({ bind: '127.0.0.1', port: 8081, secureCookies: false, demo: false, publicDashboard: true, telemetryIntervalMs: 10000, nodes: [
        { id: 'strix01', label: '01-EVO-X3', kind: 'strix', host: '01-EVO-X3', capabilities: ['coordinator', 'inference', 'execution'] },
        { id: 'strix02', label: '02-EVO-X3', kind: 'strix', host: '02-evo-x3-tb', capabilities: ['inference'] },
        { id: 'aireward', label: 'aireward-llm · RTX 3090', kind: 'cuda', host: '192.168.178.47', capabilities: ['inference'] },
        { id: 'gemrouter', label: 'GemRouter', kind: 'cloud', capabilities: ['inference'] }
    ], links: [{ id: 'tb', from: 'strix01', to: 'strix02', label: 'Thunderbolt · alias SSH configurato', address: '10.55.0.2', status: 'configured' }, { id: 'lan', from: 'strix01', to: 'aireward', label: 'LAN · stato da verificare', address: '192.168.178.47', status: 'configured' }], resourceGroups: [{ id: 'strix01-memory', label: 'Memoria Strix 01', nodeIds: ['strix01'], capacity: 1 }, { id: 'strix02-memory', label: 'Memoria Strix 02', nodeIds: ['strix02'], capacity: 1 }, { id: 'cuda3090-memory', label: 'Memoria RTX 3090', nodeIds: ['aireward'], capacity: 1 }], targets: [], providers: [] });
export function loadConfig(file: string): Config {
    const raw = object(JSON.parse(readFileSync(file, 'utf8')));
    const base = defaultConfig();
    const cfg = { ...base, ...raw } as Config;
    str(cfg.bind, 'Bind', 200);
    cfg.port = integer(cfg.port, 8081, 0, 65535);
    cfg.telemetryIntervalMs = integer(cfg.telemetryIntervalMs, 10000, 1000, 300000);
    assert(typeof cfg.secureCookies === 'boolean' && typeof cfg.demo === 'boolean', 400, 'CONFIG', 'Flag configurazione non validi.');
    assert(cfg.publicDashboard === undefined || typeof cfg.publicDashboard === 'boolean', 400, 'CONFIG', 'publicDashboard deve essere booleano.');
    if (cfg.publicOrigin) {
        const url = new URL(endpoint(cfg.publicOrigin));
        assert(url.pathname === '/', 400, 'CONFIG', 'publicOrigin deve essere solo origine.');
        cfg.publicOrigin = url.origin;
    }
    for (const name of ['nodes', 'links', 'resourceGroups', 'targets', 'providers'] as const)
        assert(Array.isArray(cfg[name]) && cfg[name].length <= 200, 400, 'CONFIG', `${name} non valido.`);
    const unique = (rows: Array<{
        id: string;
    }>) => { const keys = rows.map(r => str(r.id, 'ID', 120)); assert(new Set(keys).size === keys.length && keys.every(k => /^[a-zA-Z0-9_-]+$/.test(k)), 400, 'CONFIG', 'ID duplicati o non validi.'); };
    unique(cfg.nodes);
    unique(cfg.resourceGroups);
    unique(cfg.targets);
    unique(cfg.providers);
    const nodes = new Set(cfg.nodes.map(n => n.id));
    const groups = new Set(cfg.resourceGroups.map(g => g.id));
    for (const g of cfg.resourceGroups) {
        g.capacity = integer(g.capacity, 1, 1, 64);
        assert(g.nodeIds.every(n => nodes.has(n)), 400, 'CONFIG', 'Nodo risorsa sconosciuto.');
    }
    for (const t of cfg.targets) {
        assert(['local', 'ssh'].includes(t.kind) && path.isAbsolute(t.workspaceRoot) && nodes.has(t.nodeId), 400, 'CONFIG', 'Target non valido.');
        assert(Array.isArray(t.commands) && t.commands.length <= 100, 400, 'CONFIG', 'Ricette non valide.');
        unique(t.commands);
        for (const c of t.commands) {
            assert(Array.isArray(c.argv) && c.argv.length > 0 && c.argv.length <= 100 && c.argv.every(a => typeof a === 'string' && !a.includes('\0') && a.length < 16384), 400, 'CONFIG', 'argv ricetta non valido.');
        }
        if (t.kind === 'ssh')
            str(t.sshHost, 'SSH host', 200);
    }
    for (const p of cfg.providers) {
        if (p.loadProbe) validateLoadProbe(p.loadProbe);
        if (p.maxConcurrent !== undefined) p.maxConcurrent = integer(p.maxConcurrent, 4, 1, 16);
        if (p.maxEmbeddingChars !== undefined)
            assert(Number.isInteger(p.maxEmbeddingChars) && p.maxEmbeddingChars >= 32 && p.maxEmbeddingChars <= 4096, 400, 'CONFIG', 'maxEmbeddingChars deve essere un intero tra 32 e 4096.');
        assert(['openai-compatible', 'openai-responses', 'ollama', 'gemini', 'codex', 'antigravity'].includes(p.kind), 400, 'CONFIG', 'Provider non valido.');
        if (p.baseUrl)
            p.baseUrl = endpoint(p.baseUrl);
        for (const model of p.models ?? []) if (model.aliases !== undefined)
            model.aliases = textList(model.aliases,64).map(alias=>str(alias,'Alias modello',200));
        p.nodeIds = textList(p.nodeIds);
        p.resourceGroupIds = textList(p.resourceGroupIds);
        assert(p.nodeIds.every(n => nodes.has(n)) && p.resourceGroupIds.every(g => groups.has(g)), 400, 'CONFIG', 'Risorse provider non valide.');
    }
    for (const p of cfg.providers)
        if (p.activation) {
            if (p.activation.stop) {
                p.activation.stop.url=endpoint(p.activation.stop.url);
                p.activation.stop.healthUrl=endpoint(p.activation.stop.healthUrl);
            }
            const covered = cfg.resourceGroups.filter(g => p.resourceGroupIds.includes(g.id) || g.nodeIds.some(n => p.nodeIds.includes(n)));
            assert(covered.length > 0 && covered.every(g => g.capacity === 1), 400, 'CONFIG', 'Gli engine commutabili richiedono risorse esclusive capacity:1.');
            if (p.activation.recipeId) {
                const recipe = cfg.targets.find(t => t.id === p.activation?.targetId)?.commands.find(c => c.id === p.activation?.recipeId);
                assert(recipe, 400, 'CONFIG', 'Ricetta attivazione mancante.');
                recipe.controllerOnly = true;
            }
        }
    return cfg;
}
export function routeResources(model: ModelRoute, config: Config): string[] {
    const inferred = config.resourceGroups.filter(g => g.nodeIds.some(id => model.nodeIds.includes(id))).map(g => g.id);
    return [...new Set([...model.resourceGroupIds, ...inferred])];
}
