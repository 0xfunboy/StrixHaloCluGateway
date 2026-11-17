import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Account, Artifact, Bootstrap, Conversation, Evidence, Memory, ModelRoute, Project, Provider, Role, Run, RunEvent, User } from './contracts.ts';
import { defaultConfig, loadConfig, type Config, routeResources } from './config.ts';
import { Store } from './store.ts';
import { Scheduler } from './scheduler.ts';
import { Catalog } from './catalog.ts';
import { Knowledge } from './knowledge.ts';
import { Orchestrator, type Completion } from './orchestrator.ts';
import { complete } from './adapters/index.ts';
import { execute } from './execution/index.ts';
import { AppError, assert, endpoint, id, integer, now, object, safeError, str, textList } from './util.ts';

const execFileAsync = promisify(execFile);

interface NodeSensors {
    hostname?: string;
    role?: string;
    status: string;
    alert_level?: string;
    temps?: Record<string, number>;
    cooling?: Record<string, unknown>;
    gpu?: Record<string, unknown>;
    cpu?: Record<string, unknown>;
    ram?: { used_gb: number; total_gb: number; free_gb: number; pct: number };
    disk?: { used_gb: number; total_gb: number; free_gb: number; pct: number };
    [key: string]: unknown;
}

interface ClusterTelemetryState {
    node01: NodeSensors;
    node02: NodeSensors;
    aireward: NodeSensors;
    tb_link: { rtt_ms: number; status: string; bandwidth: string; ip_mesh?: string };
    lan_link: { rtt_ms: number; status: string; bandwidth: string };
    last_updated: number;
}

const defaultClusterTelemetry: ClusterTelemetryState = {
    node01: {
        hostname: '01-EVO-X3',
        role: 'Coordinator (Rank 0)',
        status: 'online',
        alert_level: 'healthy',
        temps: { cpu_c: 42.0, gpu_c: 41.0, nvme_c: 32.0 },
        gpu: { load_pct: 0, sclk_mhz: 605, power_w: 11.0, arch: 'gfx1151 / RDNA 3.5' },
        cooling: { fan_rpm: 1940, fan_pwm_pct: 40, profile: 'Smart Thermal EC' },
        ram: { used_gb: 100.9, total_gb: 122.2, free_gb: 21.3, pct: 83 },
        disk: { used_gb: 522.6, total_gb: 1831.7, free_gb: 1216.0, pct: 29 }
    },
    node02: {
        hostname: '02-evo-x3-tb',
        role: 'Worker (Rank 1)',
        status: 'online',
        alert_level: 'healthy',
        temps: { cpu_c: 29.2, gpu_c: 27.0, nvme_c: 23.9 },
        gpu: { load_pct: 0, sclk_mhz: 600, power_w: 5.1, arch: 'gfx1151 / RDNA 3.5' },
        cooling: { fan_rpm: 1800, fan_pwm_pct: 38, profile: 'Smart Thermal EC' },
        ram: { used_gb: 2.0, total_gb: 122.2, free_gb: 120.2, pct: 2 },
        disk: { used_gb: 426.7, total_gb: 1831.7, free_gb: 1311.9, pct: 23 }
    },
    aireward: {
        hostname: 'aireward-llm',
        role: 'CUDA MoE Accelerator (RTX 3090)',
        status: 'online',
        alert_level: 'healthy',
        temps: { cpu_c: 33.0, gpu_c: 36.0, nvme_c: 37.9 },
        gpu: { name: 'NVIDIA GeForce RTX 3090', load_pct: 0, sclk_mhz: 210, power_w: 13.1, vram_used_gb: 0.0, vram_total_gb: 24.0, arch: 'GA102 / Ampere 24GB' },
        cooling: { gpu_fan_pct: 0, profile: 'Dual Axial Dynamic' },
        ram: { used_gb: 1.9, total_gb: 61.6, free_gb: 59.7, pct: 3 },
        disk: { used_gb: 542.6, total_gb: 1829.7, free_gb: 1194.0, pct: 30 }
    },
    tb_link: { rtt_ms: 0.42, status: 'active', bandwidth: '40 Gbps USB4 Mesh', ip_mesh: '10.55.0.0/30' },
    lan_link: { rtt_ms: 0.52, status: 'active', bandwidth: '1 Gbps Ethernet LAN' },
    last_updated: Date.now()
};

function recordRequestMetric(
    modelId: string,
    promptToks: number | undefined,
    compToks: number | undefined,
    durationS: number,
    rateDurationS: number,
    userName: string,
    clientApp: string,
    overrideTps?: number
): void {
    const statsPath = path.resolve('data/stats.json');
    let stats: any = { totals: { total_tokens: 0, total_requests: 0, deepseek_tokens: 0, qwen_tokens: 0 }, daily_tokens: {}, recent_sessions: [] };
    if (existsSync(statsPath)) {
        try {
            stats = JSON.parse(readFileSync(statsPath, 'utf8'));
        } catch {}
    }
    const today = new Date().toISOString().slice(0, 10);
    const nowTime = new Date().toTimeString().slice(0, 8);
    const tps = overrideTps !== undefined ? overrideTps : (compToks && rateDurationS > 0 ? Math.round((compToks / rateDurationS) * 10) / 10 : undefined);
    const modKey = (modelId.includes('ds41') || modelId.includes('deepseek')) ? 'deepseek' : 'qwen';

    stats.totals = stats.totals || {};
    stats.totals.total_requests = (stats.totals.total_requests || 0) + 1;
    if (compToks !== undefined && compToks > 0) {
        stats.totals.total_tokens = (stats.totals.total_tokens || 0) + compToks;
        const tokKey = `${modKey}_tokens`;
        stats.totals[tokKey] = (stats.totals[tokKey] || 0) + compToks;
        stats.daily_tokens = stats.daily_tokens || {};
        if (!stats.daily_tokens[today]) {
            stats.daily_tokens[today] = { deepseek: 0, qwen: 0 };
        }
        stats.daily_tokens[today][modKey] = (stats.daily_tokens[today][modKey] || 0) + compToks;
    }

    const sessionItem = {
        id: `req-${Date.now().toString(16).slice(-5)}`,
        time: nowTime,
        date: today,
        user: userName,
        client_app: clientApp,
        model: modelId,
        prompt_tokens: promptToks,
        completion_tokens: compToks,
        duration_s: Math.round(durationS * 100) / 100,
        tok_per_sec: tps,
        status: 'completed'
    };
    stats.recent_sessions = [sessionItem, ...(stats.recent_sessions || [])].slice(0, 20);
    try {
        writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');
    } catch (e) {
        process.stderr.write(`[yed1z] Error saving stats: ${safeError(e)}\n`);
    }
}
const VERSION = '0.3.0';
const closed = new Set(['succeeded', 'failed', 'cancelled']);
function json(res: ServerResponse, status: number, data: unknown): void { if (res.writableEnded)
    return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); }
async function body(req: IncomingMessage): Promise<Record<string, unknown>> { assert((req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 415, 'CONTENT_TYPE', 'Usa application/json.'); let bytes = 0; const parts: Buffer[] = []; for await (const part of req) {
    bytes += part.length;
    assert(bytes <= 7 * 1024 * 1024, 413, 'SIZE', 'Richiesta troppo grande.');
    parts.push(Buffer.from(part));
} try {
    return object(JSON.parse(Buffer.concat(parts).toString('utf8')));
}
catch (e) {
    if (e instanceof AppError)
        throw e;
    throw new AppError(400, 'JSON', 'JSON non valido.');
} }
function operator(user: User): void { assert(['admin', 'operator'].includes(user.role), 403, 'FORBIDDEN', 'Operazione riservata agli operatori.'); }
function cookie(req: IncomingMessage): string | undefined { const values = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith('yed1z_session=')); assert(values.length <= 1, 400, 'COOKIE', 'Cookie duplicato.'); return values[0]?.slice('yed1z_session='.length); }
export class Application {
    config: Config;
    store: Store;
    catalog: Catalog;
    knowledge: Knowledge;
    scheduler: Scheduler;
    orchestrator: Orchestrator;
    server: Server;
    staticDir: string;
    shutdown = new AbortController();
    timer?: NodeJS.Timeout;
    probeTimer?: NodeJS.Timeout;
    clusterTelemetry: ClusterTelemetryState = JSON.parse(JSON.stringify(defaultClusterTelemetry));
    inFlightCount = 0;
    activeStrix: 'deepseek' | 'qwen' | null = null;
    activeAireward: 'ds41-strata' | 'qwen38-strata' | null = null;
    streams = new Map<string, Set<ServerResponse>>();
    failures = new Map<string, {
        count: number;
        until: number;
    }>();
    constructor(options: {
        directory: string;
        config: Config;
        staticDir?: string;
        complete?: Completion;
    }) {
        this.config = options.config;
        this.store = new Store(options.directory);
        this.store.recover();
        this.scheduler = new Scheduler(this.config.resourceGroups);
        this.catalog = new Catalog(this.store, this.config, this.scheduler);
        this.knowledge = new Knowledge(this.store);
        this.orchestrator = new Orchestrator({ store: this.store, config: this.config, catalog: this.catalog, knowledge: this.knowledge, scheduler: this.scheduler, complete: options.complete });
        this.staticDir = options.staticDir ?? path.resolve('dist/web');
        this.server = createServer((req, res) => { this.handle(req, res).catch(error => { if (res.headersSent) {
            res.end();
            return;
        } json(res, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'Errore interno. Controlla la configurazione e i log locali.', code: error instanceof AppError ? error.code : 'INTERNAL' }); if (!(error instanceof AppError))
            process.stderr.write('[yed1z] ' + safeError(error) + '\n'); }); });
        this.server.headersTimeout = 15000;
        this.server.requestTimeout = 30000;
        this.server.keepAliveTimeout = 5000;
        const administrator = this.store.all<User>('user').find(u => u.role === 'admin');
        if (administrator)
            this.catalog.seed(administrator);
    }
    authenticateToken(token: string): User | undefined {
        if (!token || typeof token !== 'string') return undefined;
        const clean = token.replace(/^Bearer\s+/i, '').trim();
        const directUser = this.store.authenticate(clean, 'key') || this.store.authenticate(clean, 'session');
        if (directUser) return directUser;

        const keysPath = path.resolve('data/api_keys.json');
        if (existsSync(keysPath)) {
            try {
                const data = JSON.parse(readFileSync(keysPath, 'utf8'));
                const matchedName = data.users?.[clean];
                if (matchedName) {
                    const found = this.store.all<User>('user').find(u => u.name.toLowerCase() === matchedName.toLowerCase());
                    if (found) return found;
                }
                if (Array.isArray(data.keys) && data.keys.includes(clean)) {
                    const isCooper = clean.toLowerCase().includes('cooper');
                    const targetName = isCooper ? 'cooper' : 'funboy';
                    const found = this.store.all<User>('user').find(u => u.name.toLowerCase() === targetName);
                    if (found) return found;
                }
            } catch {}
        }
        return undefined;
    }
    identifyClientUser(req: IncomingMessage, authenticatedUser?: User): { user: string; app: string } {
        const ua = (req.headers['user-agent'] ?? '').toLowerCase();
        const app = (ua.includes('copilot') || ua.includes('vscode')) ? 'Copilot Chat' : 'Inference Client';

        if (authenticatedUser && authenticatedUser.id !== 'guest') {
            return { user: authenticatedUser.name, app };
        }
        if (req.headers['x-user']) {
            return { user: String(req.headers['x-user']), app };
        }
        const rawIp = (req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '127.0.0.1') as string;
        const ip = rawIp.split(',')[0].trim();
        if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
            return { user: 'funboy (local)', app };
        }
        const keysPath = path.resolve('data/api_keys.json');
        if (existsSync(keysPath)) {
            try {
                const data = JSON.parse(readFileSync(keysPath, 'utf8'));
                if (data.ip_map?.[ip]) {
                    return { user: data.ip_map[ip], app };
                }
            } catch {}
        }
        if (ip === '37.118.7.208') {
            return { user: 'cooper', app };
        }
        let sum = 0;
        for (let i = 0; i < ip.length; i++) sum = (sum * 31 + ip.charCodeAt(i)) >>> 0;
        return { user: (sum % 2 === 0) ? 'cooper' : 'funboy', app };
    }
    async sampleClusterHardware(): Promise<void> {
        try {
            const r1 = await execFileAsync('/home/funboy/.local/bin/strix-probe.py', [], { timeout: 2000 });
            const d1 = JSON.parse(r1.stdout);
            this.clusterTelemetry.node01 = { ...this.clusterTelemetry.node01, ...d1, status: 'online' };
        } catch {
            this.clusterTelemetry.node01.status = 'offline';
        }

        try {
            const r2 = await execFileAsync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', '02-evo-x3-tb', '/home/funboy/.local/bin/strix-probe.py'], { timeout: 3000 });
            const d2 = JSON.parse(r2.stdout);
            this.clusterTelemetry.node02 = { ...this.clusterTelemetry.node02, ...d2, status: 'online' };
        } catch {
            this.clusterTelemetry.node02.status = 'offline';
        }

        try {
            const c = new AbortController();
            const to = setTimeout(() => c.abort(), 2000);
            const airRes = await fetch('http://192.168.178.47:8090/telemetry', { signal: c.signal });
            clearTimeout(to);
            if (airRes.ok) {
                const airData = (await airRes.json()) as any;
                this.clusterTelemetry.aireward = { ...this.clusterTelemetry.aireward, ...airData, status: 'online' };
                if (airData.engine?.active_model) {
                    this.activeAireward = airData.engine.active_model.includes('ds') ? 'ds41-strata' : 'qwen38-strata';
                }
            }
        } catch {}

        try {
            const tbPing = await execFileAsync('ping', ['-c', '1', '-W', '1', '10.55.0.2'], { timeout: 1500 });
            const match = tbPing.stdout.match(/rtt min\/avg\/max\/mdev = [0-9.]+\/([0-9.]+)/) || tbPing.stdout.match(/round-trip min\/avg\/max = [0-9.]+\/([0-9.]+)/);
            if (match) {
                this.clusterTelemetry.tb_link.rtt_ms = parseFloat(match[1]);
                this.clusterTelemetry.tb_link.status = 'active';
            }
        } catch {
            this.clusterTelemetry.tb_link.status = 'degraded';
        }

        try {
            const lanPing = await execFileAsync('ping', ['-c', '1', '-W', '1', '192.168.178.47'], { timeout: 1500 });
            const match = lanPing.stdout.match(/rtt min\/avg\/max\/mdev = [0-9.]+\/([0-9.]+)/) || lanPing.stdout.match(/round-trip min\/avg\/max = [0-9.]+\/([0-9.]+)/);
            if (match) {
                this.clusterTelemetry.lan_link.rtt_ms = parseFloat(match[1]);
                this.clusterTelemetry.lan_link.status = 'active';
            }
        } catch {
            this.clusterTelemetry.lan_link.status = 'offline';
        }

        try {
            const dsCheck = await fetch('http://127.0.0.1:18231/v1/models', { signal: AbortSignal.timeout(1500) });
            if (dsCheck.ok) {
                this.activeStrix = 'deepseek';
            } else {
                const qwCheck = await fetch('http://127.0.0.1:18562/v1/models', { signal: AbortSignal.timeout(1500) });
                this.activeStrix = qwCheck.ok ? 'qwen' : null;
            }
        } catch {
            try {
                const qwCheck = await fetch('http://127.0.0.1:18562/v1/models', { signal: AbortSignal.timeout(1500) });
                this.activeStrix = qwCheck.ok ? 'qwen' : null;
            } catch {
                this.activeStrix = null;
            }
        }
        this.clusterTelemetry.last_updated = Date.now();
    }
    getTelemetryPayload(): Record<string, unknown> {
        const statsPath = path.resolve('data/stats.json');
        let statsData = { totals: { total_tokens: 0, total_requests: 0, deepseek_tokens: 0, qwen_tokens: 0 }, daily_tokens: {}, recent_sessions: [] };
        if (existsSync(statsPath)) {
            try {
                statsData = JSON.parse(readFileSync(statsPath, 'utf8'));
            } catch {}
        }
        const active = this.activeStrix;
        const speed = {
            decode_tps: active === 'deepseek' ? 51.4 : 42.4,
            prefill_tps: active === 'deepseek' ? 442.0 : 177.0,
            ttft_ms: active === 'deepseek' ? 185 : 280,
            dspark_acc: 49.2
        };
        return {
            active_model: active,
            active_strix: active,
            active_aireward: this.activeAireward,
            in_flight: this.inFlightCount,
            speeds: speed,
            telemetry: this.clusterTelemetry,
            stats: statsData,
            server_time: new Date().toISOString().replace('T', ' ').substring(0, 19)
        };
    }
    async executeSwitch(target: string, model: string): Promise<void> {
        if (target === 'strix') {
            const cmd = (model === 'deepseek' || model === 'ds41') ? 'deepseek' : 'qwen';
            const p = spawn('/home/funboy/.local/bin/cluster-model', [cmd], {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env, PATH: '/home/funboy/.local/bin:/usr/local/bin:/usr/bin:/bin' }
            });
            p.unref();
        } else if (target === 'aireward') {
            const airModel = (model === 'deepseek' || model === 'ds41') ? 'deepseek' : 'qwen';
            try {
                await fetch('http://192.168.178.47:8090/switch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: airModel }),
                    signal: AbortSignal.timeout(5000)
                });
            } catch (e) {
                process.stderr.write(`[yed1z] Switch Aireward error: ${safeError(e)}\n`);
            }
        }
    }
    user(req: IncomingMessage): {
        user: User;
        session?: string;
    } {
        const authHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization');
        assert(authHeaders.length <= 1, 400, 'AUTH', 'Authorization duplicata.');
        const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
        const session = bearer ? undefined : cookie(req);
        const user = bearer ? this.authenticateToken(bearer) : session ? this.store.authenticate(session, 'session') : undefined;
        assert(user, 401, 'UNAUTHORIZED', 'Accedi con una chiave del servizio.');
        return { user, session };
    }
    guestOrUser(req: IncomingMessage): {
        user: User;
        session?: string;
        isGuest: boolean;
    } {
        const authHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization');
        if (authHeaders.length > 1) throw new AppError(400, 'AUTH', 'Authorization duplicata.');
        const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
        const session = bearer ? undefined : cookie(req);
        const user = bearer ? this.authenticateToken(bearer) : session ? this.store.authenticate(session, 'session') : undefined;
        if (!user) {
            return {
                user: { id: 'guest', name: 'Ospite', role: 'viewer', createdAt: '2026-01-01T00:00:00.000Z' },
                session: undefined,
                isGuest: true
            };
        }
        return { user, session, isGuest: false };
    }
    csrf(req: IncomingMessage, session?: string): void { if (!session || ['GET', 'HEAD'].includes(req.method ?? ''))
        return; const origin = req.headers.origin; const expected = this.config.publicOrigin ?? `http://${req.headers.host}`; assert(origin === expected, 403, 'ORIGIN', 'Origine della richiesta non autorizzata.'); }
    bootstrap(user: User): Bootstrap {
        const isGuest = user.id === 'guest';
        const projects = isGuest ? [] : this.store.all<Project>('project').filter(p => p.ownerId === user.id || p.memberIds.includes(user.id) || user.role === 'admin');
        const ids = new Set(projects.map(p => p.id));
        const accounts = isGuest ? [] : this.catalog.accounts(user), providerIds = new Set(accounts.map(a => a.providerId));
        const providers = isGuest ? this.store.all<Provider>('provider').map(p => { const { env, command, args, ...publicProvider } = p; return publicProvider; }) : this.store.all<Provider>('provider').filter(p => p.ownerId === user.id || providerIds.has(p.id)).map(p => { const { env, command, args, ...publicProvider } = p; return publicProvider; });
        const models = isGuest ? this.store.all<ModelRoute>('model').filter(m => m.enabled) : this.catalog.models(user);
        return { version: VERSION, user, projects, conversations: isGuest ? [] : this.store.all<Conversation>('conversation').filter(c => c.ownerId === user.id && ids.has(c.projectId)), providers, accounts, models, nodes: this.config.nodes.map(n => { const { telemetry, ...visible } = n; return visible; }), links: this.config.links, resourceGroups: this.config.resourceGroups, telemetry: [...this.catalog.telemetry.values()], runs: isGuest ? [] : this.store.all<Run>('run').filter(r => r.ownerId === user.id && ids.has(r.projectId)).slice(0, 200), approvals: isGuest ? [] : this.store.all<Bootstrap['approvals'][number]>('approval').filter(a => a.ownerId === user.id), memories: isGuest ? [] : this.store.all<Memory>('memory').filter(m => ids.has(m.projectId) && (m.ownerId === user.id || m.scope === 'project')), artifacts: isGuest ? [] : this.store.all<Artifact>('artifact').filter(a => a.ownerId === user.id && ids.has(a.projectId)), evidence: isGuest ? [] : this.store.all<Evidence & {
                ownerId: string;
            }>('evidence').filter(e => e.ownerId === user.id && ids.has(e.projectId)).slice(0, 1000), targets: this.config.targets.map(t => ({ id: t.id, label: t.id, nodeId: t.nodeId, kind: t.kind, commands: t.commands.filter(c => c.verification === true).map(c => ({ id: c.id, label: c.label })), deployments: (t.deployments ?? []).map(d => ({ id: d.id, label: d.label })) })), resourceUsage: this.scheduler.snapshot(), demo: this.config.demo };
    }
    publicDashboard(): Record<string, unknown> {
        const nodes = this.config.nodes.map(n => { const { telemetry, ...visible } = n; return visible; });
        const models = this.store.all<ModelRoute>('model').filter(m => m.enabled);
        return {
            version: VERSION,
            clusterId: 'HYBRID_TRINITY_GFX1151_GA102',
            backplane: '40Gbps USB4 + 1Gbps LAN MESH',
            nodes,
            links: this.config.links,
            resourceGroups: this.config.resourceGroups,
            telemetry: [...this.catalog.telemetry.values()],
            models,
            stats: this.store.get('stats', 'daily') ?? { totals: { total_tokens: 1558876 } }
        };
    }
    changed(user: User, projectId?: string): void { this.store.emit({ ownerId: user.id, projectId, type: 'state.changed' }); }
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://yed1z.local'), pathname = url.pathname, method = req.method ?? 'GET';
        assert(![...url.searchParams.keys()].some(k => /key|token|password|secret/i.test(k)), 400, 'AUTH', 'Credenziali nella query non ammesse.');
        if ((pathname === '/health' || pathname === '/api/health') && method === 'GET') {
            const active = this.activeStrix;
            json(res, 200, { ok: true, status: active ? 'healthy' : 'standby', version: VERSION, active_model: active });
            return;
        }
        if (pathname === '/api/dashboard' && method === 'GET') {
            json(res, 200, this.publicDashboard());
            return;
        }
        if (pathname === '/api/telemetry' && method === 'GET') {
            json(res, 200, this.getTelemetryPayload());
            return;
        }
        if (pathname === '/api/auth/verify' && method === 'POST') {
            const b = await body(req);
            const authHeader = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
            const token = (b.admin_key ?? authHeader) as string | undefined;
            if (!token) {
                json(res, 401, { ok: false, error: 'Chiave mancante.' });
                return;
            }
            const authUser = this.authenticateToken(token);
            if (!authUser) {
                json(res, 401, { ok: false, error: 'Chiave non valida.' });
                return;
            }
            const session = this.store.session(authUser);
            res.setHeader('Set-Cookie', `yed1z_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${this.config.secureCookies ? '; Secure' : ''}`);
            json(res, 200, { ok: true, user: { id: authUser.id, name: authUser.name, role: authUser.role } });
            return;
        }
        if (pathname === '/api/switch' && method === 'POST') {
            const b = await body(req);
            const authHeader = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
            const token = (b.admin_key ?? authHeader) as string | undefined;
            const { user: reqUser, isGuest } = this.guestOrUser(req);
            const switchUser = token ? this.authenticateToken(token) : (!isGuest ? reqUser : undefined);
            assert(switchUser && switchUser.role !== 'viewer', 401, 'UNAUTHORIZED', 'Accesso amministratore richiesto per lo switch.');
            const target = str(b.target, 'Target', 32);
            const model = str(b.model, 'Modello', 32);
            await this.executeSwitch(target, model);
            json(res, 200, { ok: true, target, model, message: `Switch avviato: ${target} -> ${model}` });
            return;
        }
        if (!pathname.startsWith('/api/') && !pathname.startsWith('/v1/')) {
            this.static(pathname, method, res);
            return;
        }
        if (pathname === '/api/login' && method === 'POST') {
            const input = await body(req), ip = req.socket.remoteAddress ?? 'unknown', prior = this.failures.get(ip);
            assert(!prior || prior.until < Date.now() || prior.count < 12, 429, 'RATE_LIMIT', 'Troppi tentativi. Attendi un minuto.');
            const token = str(input.token, 'Chiave', 1024), user = this.store.authenticate(token, 'key');
            if (!user) {
                if (this.failures.size > 5000)
                    this.failures.clear();
                this.failures.set(ip, { count: prior && prior.until > Date.now() ? prior.count + 1 : 1, until: Date.now() + 60000 });
                throw new AppError(401, 'UNAUTHORIZED', 'Chiave non valida.');
            }
            // Login itself is origin-checked when the browser supplies one (CLI clients omit it).
            if (req.headers.origin)
                assert(req.headers.origin === (this.config.publicOrigin ?? `http://${req.headers.host}`), 403, 'ORIGIN', 'Origine non autorizzata.');
            this.failures.delete(ip);
            const session = this.store.session(user);
            res.setHeader('Set-Cookie', `yed1z_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${this.config.secureCookies ? '; Secure' : ''}`);
            json(res, 200, { user });
            return;
        }
        const { user, session, isGuest } = this.guestOrUser(req);
        this.csrf(req, session);
        if (pathname === '/api/logout' && method === 'POST') {
            if (session)
                this.store.logout(session);
            res.setHeader('Set-Cookie', 'yed1z_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
            json(res, 200, { ok: true });
            return;
        }
        if (pathname === '/api/bootstrap' && method === 'GET') {
            assert(!isGuest, 401, 'UNAUTHORIZED', 'Accedi con una chiave personale per modificare o accedere a queste risorse.');
            json(res, 200, this.bootstrap(user));
            return;
        }
        if (pathname === '/api/events' && method === 'GET') {
            this.events(req, res, user, Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0));
            return;
        }
        if (pathname.startsWith('/v1/')) {
            assert(!isGuest, 401, 'UNAUTHORIZED', 'Le API compatibili richiedono Bearer.');
            await this.apiFacade(req, res, user, pathname);
            return;
        }
        assert(!isGuest, 401, 'UNAUTHORIZED', 'Accedi con una chiave personale per modificare o accedere a queste risorse.');
        assert(method === 'GET' || user.role !== 'viewer', 403, 'FORBIDDEN', 'Il profilo lettore non può modificare dati.');
        const segments = pathname.split('/').filter(Boolean), key = segments[2];
        if (pathname === '/api/projects' && method === 'POST') {
            const b = await body(req);
            assert(this.store.all<Project>('project').filter(p => p.ownerId === user.id).length < 100, 413, 'LIMIT', 'Limite progetti raggiunto.');
            const project: Project = { id: id('prj'), ownerId: user.id, memberIds: [], name: str(b.name, 'Nome', 120), description: b.description === undefined ? '' : str(b.description, 'Descrizione', 12000, true), routes: {}, verifyRecipeIds: [], createdAt: now(), updatedAt: now() };
            this.configureProject(user, project, b);
            await this.prepareProject(project);
            this.store.put('project', project);
            this.changed(user, project.id);
            json(res, 201, project);
            return;
        }
        if (segments[1] === 'projects' && segments.length === 3 && method === 'PATCH') {
            const p = this.store.projectFor(user, key);
            assert(p.ownerId === user.id || user.role === 'admin', 403, 'FORBIDDEN', 'Modifica riservata al responsabile del progetto.');
            assert(!this.store.all<Run>('run').some(r => r.projectId === key && !closed.has(r.status)), 409, 'ACTIVE_RUN', 'Concludi i task aperti prima di cambiare configurazione.');
            const b = await body(req);
            this.configureProject(user, p, b);
            if (b.targetId !== undefined || b.workspace !== undefined)
                await this.prepareProject(p);
            p.updatedAt = now();
            this.store.put('project', p);
            this.changed(user, p.id);
            json(res, 200, p);
            return;
        }
        if (segments[1] === 'projects' && segments[3] === 'reindex' && method === 'POST') {
            const p = this.store.projectFor(user, key);
            assert(p.routes.embedding, 409, 'EMBEDDING', 'Scegli un modello embedding nelle impostazioni del progetto.');
            const result = await this.knowledge.reindex(user, p, p.routes.embedding, this.catalog.embedder(user, p.routes.embedding), AbortSignal.timeout(120000));
            this.changed(user, p.id);
            json(res, 200, result);
            return;
        }
        if (pathname === '/api/conversations' && method === 'POST') {
            const b = await body(req), project = this.store.projectFor(user, str(b.projectId, 'Progetto'));
            if (b.routeId)
                this.catalog.resolve(user, str(b.routeId, 'Modello'));
            assert(this.store.all<Conversation>('conversation').filter(c => c.ownerId === user.id).length < 250, 413, 'LIMIT', 'Limite conversazioni raggiunto.');
            const c: Conversation = { id: id('conv'), projectId: project.id, ownerId: user.id, title: b.title ? str(b.title, 'Titolo', 200) : 'Nuova conversazione', routeId: b.routeId as string | undefined, messages: [], createdAt: now(), updatedAt: now() };
            this.store.put('conversation', c);
            this.changed(user, c.projectId);
            json(res, 201, c);
            return;
        }
        if (segments[1] === 'conversations' && segments.length === 3) {
            const c = this.store.own<Conversation>(user, 'conversation', key);
            if (method === 'GET') {
                json(res, 200, c);
                return;
            }
            if (method === 'DELETE') {
                assert(!this.store.all<Run>('run').some(r => r.conversationId === key && !closed.has(r.status)), 409, 'ACTIVE_RUN', 'Conversazione con task aperto.');
                this.store.remove('conversation', key);
                this.changed(user, c.projectId);
                json(res, 200, { ok: true });
                return;
            }
        }
        if (segments[1] === 'conversations' && segments[3] === 'messages' && method === 'POST') {
            const b = await body(req);
            assert(b.mode === 'chat' || b.mode === 'mission', 400, 'MODE', 'Modalità non valida.');
            const p = b.permissions === undefined ? {} : object(b.permissions);
            for (const field of ['write', 'commands', 'deploy'])
                assert(p[field] === undefined || typeof p[field] === 'boolean', 400, 'INVALID', 'Permesso non valido.');
            const run = this.orchestrator.start(user, key, { text: str(b.text, 'Messaggio', 100000), routeId: str(b.routeId, 'Modello'), mode: b.mode, attachmentIds: b.attachmentIds === undefined ? [] : textList(b.attachmentIds, 12), permissions: p, maxIterations: integer(b.maxIterations, 3, 1, 6), maxParallel: integer(b.maxParallel, 3, 1, 6) });
            json(res, 202, run);
            return;
        }
        if (segments[1] === 'runs' && segments.length === 4 && method === 'POST') {
            const action = segments[3];
            if (['pause', 'resume', 'cancel'].includes(action)) {
                json(res, 200, this.orchestrator.control(user, key, action as 'pause' | 'resume' | 'cancel'));
                return;
            }
            if (action === 'steer') {
                const b = await body(req);
                const run = this.store.own<Run>(user, 'run', key);
                const attachments = b.attachmentIds === undefined ? [] : textList(b.attachmentIds, 12);
                for (const key of attachments) {
                    const a = this.store.own<Artifact>(user, 'artifact', key);
                    assert(a.projectId === run.projectId, 400, 'PROJECT', 'Allegato di un altro progetto.');
                }
                json(res, 200, this.orchestrator.control(user, key, 'pause', str(b.text, 'Istruzione', 12000), attachments));
                return;
            }
            if (action === 'release') {
                json(res, 202, await this.orchestrator.release(user, key));
                return;
            }
        }
        if (segments[1] === 'tasks' && segments[3] === 'route' && method === 'POST') {
            const b = await body(req);
            json(res, 200, this.orchestrator.setTaskRoute(user, key, str(b.routeId, 'Modello')));
            return;
        }
        if (segments[1] === 'tasks' && segments.length === 4 && method === 'POST' && ['pause', 'resume', 'cancel', 'steer'].includes(segments[3])) {
            const b = await body(req);
            json(res, 200, this.orchestrator.controlTask(user, key, segments[3] as 'pause' | 'resume' | 'cancel' | 'steer', segments[3] === 'steer' ? str(b.text, 'Istruzione agente', 12000) : undefined));
            return;
        }
        if (segments[1] === 'approvals' && segments.length === 3 && method === 'POST') {
            const b = await body(req);
            assert(typeof b.approved === 'boolean', 400, 'INVALID', 'Decisione richiesta.');
            json(res, 200, this.orchestrator.decide(user, key, b.approved));
            this.changed(user);
            return;
        }
        if (pathname === '/api/providers' && method === 'POST') {
            operator(user);
            const b = await body(req);
            assert(['openai-compatible', 'openai-responses', 'ollama', 'gemini', 'codex', 'antigravity'].includes(String(b.kind)), 400, 'PROVIDER', 'Tipo provider non valido.');
            const p: Provider = { id: id('prv'), label: str(b.label, 'Nome', 120), kind: b.kind as Provider['kind'], nodeIds: b.nodeIds ? textList(b.nodeIds) : [], resourceGroupIds: b.resourceGroupIds ? textList(b.resourceGroupIds) : [], enabled: true, ownerId: user.id, createdAt: now() };
            if (!['codex', 'antigravity'].includes(p.kind))
                p.baseUrl = endpoint(b.baseUrl ?? (p.kind === 'openai-responses' ? 'https://api.openai.com/v1' : p.kind === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : undefined));
            else
                p.command = p.kind === 'codex' ? 'codex' : 'agy';
            if (b.tag !== undefined) {
                assert(['gemrouter', 'cluster', 'cloud', 'local'].includes(String(b.tag)), 400, 'INVALID', 'Tag non valido.');
                p.tag = b.tag as Provider['tag'];
            }
            assert(p.nodeIds.every(n => this.config.nodes.some(x => x.id === n)) && p.resourceGroupIds.every(g => this.config.resourceGroups.some(x => x.id === g)), 400, 'RESOURCE', 'Risorsa sconosciuta.');
            this.store.put('provider', p);
            this.changed(user);
            json(res, 201, p);
            return;
        }
        if (pathname === '/api/accounts' && method === 'POST') {
            const b = await body(req);
            const a = this.catalog.addAccount(user, str(b.providerId, 'Provider'), str(b.label, 'Nome account', 120), b.secret ? str(b.secret, 'Credenziale', 65536) : undefined, b.shared === true);
            this.changed(user);
            json(res, 201, a);
            return;
        }
        if (segments[1] === 'accounts' && segments[3] === 'discover' && method === 'POST') {
            const result = await this.catalog.discover(user, key, AbortSignal.timeout(45000));
            this.changed(user);
            json(res, 200, result);
            return;
        }
        if (segments[1] === 'accounts' && segments[3] === 'login' && method === 'POST') {
            this.store.own<Account>(user, 'account', key);
            const operationId = id('login');
            const emit = (data: Record<string, unknown>) => this.store.events.emit('event', { id: 0, ownerId: user.id, type: 'account.login', createdAt: now(), data: { operationId, accountId: key, ...data } });
            void this.catalog.login(user, key, event => emit({ ...event, status: 'pending' }), AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(300000)])).then(() => { emit({ status: 'complete' }); this.changed(user); }).catch(e => emit({ status: 'error', message: safeError(e) }));
            json(res, 202, { operationId });
            return;
        }
        if (segments[1] === 'models' && segments.length === 3 && method === 'PATCH') {
            operator(user);
            const m = this.store.require<ModelRoute>('model', key);
            this.store.own<Account>(user, 'account', m.accountId);
            const b = await body(req);
            if (b.label !== undefined)
                m.label = str(b.label, 'Nome', 200);
            if (b.contextWindow !== undefined)
                m.contextWindow = integer(b.contextWindow, 16384, 4096, 2000000);
            if (b.capabilities !== undefined) {
                m.capabilities = textList(b.capabilities);
                assert(m.capabilities.every(x => ['chat', 'tools', 'embedding', 'vision'].includes(x)), 400, 'CAPABILITY', 'Capacità non valida.');
            }
            if (b.resourceGroupIds !== undefined) {
                m.resourceGroupIds = textList(b.resourceGroupIds);
                assert(m.resourceGroupIds.every(g => this.config.resourceGroups.some(x => x.id === g)), 400, 'RESOURCE', 'Risorsa sconosciuta.');
            }
            this.store.put('model', m);
            this.changed(user);
            json(res, 200, m);
            return;
        }
        if (pathname === '/api/artifacts' && method === 'POST') {
            const b = await body(req);
            const a = this.knowledge.addArtifact(user, str(b.projectId, 'Progetto'), str(b.name, 'Nome', 200), str(b.content, 'Contenuto', 1048576, true));
            this.changed(user, a.projectId);
            json(res, 201, a);
            return;
        }
        if (segments[1] === 'artifacts' && method === 'GET') {
            const { artifact, content } = this.knowledge.artifact(user, key);
            if (segments[3] === 'download') {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${artifact.name.replace(/[^a-zA-Z0-9._-]/g, '_')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                res.end(content);
            }
            else
                json(res, 200, { ...artifact, content });
            return;
        }
        if (segments[1] === 'artifacts' && method === 'DELETE') {
            const active = this.store.all<Run>('run').some(r => r.ownerId === user.id && !closed.has(r.status));
            assert(!active, 409, 'ACTIVE_RUN', 'Concludi i task aperti prima di eliminare allegati.');
            this.knowledge.removeArtifact(user, key);
            this.changed(user);
            json(res, 200, { ok: true });
            return;
        }
        if (pathname === '/api/memories' && method === 'POST') {
            const b = await body(req);
            const sources = b.sourceIds === undefined ? [] : textList(b.sourceIds);
            for (const source of sources) {
                const allowed = ['artifact', 'memory', 'run'].some(kind => { const x = this.store.get<{
                    ownerId: string;
                    projectId: string;
                }>(kind, source); return x?.ownerId === user.id && x.projectId === b.projectId; });
                assert(allowed, 400, 'SOURCE', 'Fonte memoria non accessibile.');
            }
            const m = this.knowledge.addMemory(user, str(b.projectId, 'Progetto'), { title: str(b.title, 'Titolo', 200), content: str(b.content, 'Contenuto', 100000), kind: b.kind as Memory['kind'], scope: b.scope as Memory['scope'] | undefined, sourceIds: sources });
            this.changed(user, m.projectId);
            json(res, 201, m);
            return;
        }
        if (pathname === '/api/memories/search' && method === 'POST') {
            const b = await body(req), project = this.store.projectFor(user, str(b.projectId, 'Progetto')), query = str(b.query, 'Ricerca', 12000);
            const options = project.routes.embedding ? { embed: this.catalog.embedder(user, project.routes.embedding), modelKey: project.routes.embedding, signal: AbortSignal.timeout(15000) } : {};
            const found = await this.knowledge.retrieve(user, project.id, query, options);
            const visible = new Map(this.knowledge.visibleMemory(user, project.id).map(m => [m.id, m]));
            json(res, 200, { results: found.filter(r => visible.has(r.id)).map(r => ({ memory: visible.get(r.id), score: r.score, method: r.method })) });
            return;
        }
        if (segments[1] === 'memories' && segments.length === 3 && method === 'PATCH') {
            const b = await body(req);
            const m = this.knowledge.updateMemory(user, key, b);
            this.changed(user, m.projectId);
            json(res, 200, m);
            return;
        }
        if (segments[1] === 'memories' && segments.length === 3 && method === 'DELETE') {
            this.knowledge.forget(user, key);
            this.changed(user);
            json(res, 200, { ok: true });
            return;
        }
        if (pathname === '/api/telemetry/refresh' && method === 'POST') {
            json(res, 200, { telemetry: await this.catalog.refresh(this.shutdown.signal) });
            return;
        }
        if (pathname === '/api/users') {
            assert(user.role === 'admin', 403, 'FORBIDDEN', 'Ruolo amministratore richiesto.');
            if (method === 'GET') {
                json(res, 200, { users: this.store.all<User>('user') });
                return;
            }
            if (method === 'POST') {
                const b = await body(req);
                assert(['admin', 'operator', 'member', 'viewer'].includes(String(b.role)), 400, 'ROLE', 'Ruolo non valido.');
                json(res, 201, this.store.createUser(str(b.name, 'Nome', 120), b.role as Role));
                return;
            }
        }
        throw new AppError(404, 'NOT_FOUND', 'Endpoint non trovato.');
    }
    configureProject(user: User, p: Project, b: Record<string, unknown>): void {
        if (b.name !== undefined)
            p.name = str(b.name, 'Nome', 120);
        if (b.description !== undefined)
            p.description = str(b.description, 'Descrizione', 12000, true);
        if (b.memberIds !== undefined) {
            operator(user);
            p.memberIds = textList(b.memberIds);
            assert(p.memberIds.every(key => !!this.store.get<User>('user', key)), 400, 'USER', 'Utente sconosciuto.');
        }
        if (b.routes !== undefined) {
            const routes = object(b.routes);
            for (const key of ['primary', 'coder', 'reviewer', 'researcher', 'embedding'] as const)
                if (routes[key] !== undefined) {
                    if (routes[key] === '') {
                        delete p.routes[key];
                        continue;
                    }
                    const routeId = str(routes[key], 'Modello');
                    this.catalog.resolve(user, routeId);
                    p.routes[key] = routeId;
                }
        }
        if (b.targetId !== undefined || b.workspace !== undefined || b.verifyRecipeIds !== undefined || b.deploymentRecipeId !== undefined) {
            operator(user);
            if (b.targetId !== undefined)
                p.targetId = b.targetId ? str(b.targetId, 'Target') : undefined;
            const target = this.config.targets.find(t => t.id === p.targetId);
            assert(target || !p.targetId, 400, 'TARGET', 'Target sconosciuto.');
            if (b.workspace !== undefined) {
                const workspace = str(b.workspace, 'Workspace', 2000, true) || '.';
                assert(!path.isAbsolute(workspace) && !workspace.split(/[\\/]/).includes('..') && !workspace.includes('\0'), 400, 'WORKSPACE', 'Workspace relativo al target richiesto.');
                p.workspace = workspace;
            }
            if (b.verifyRecipeIds !== undefined) {
                p.verifyRecipeIds = textList(b.verifyRecipeIds);
                assert(p.verifyRecipeIds.every(key => target?.commands.some(c => c.id === key && c.verification === true)), 400, 'VERIFY', 'Ricetta di verifica non valida o non marcata verification:true.');
            }
            if (b.deploymentRecipeId !== undefined) {
                p.deploymentRecipeId = b.deploymentRecipeId ? str(b.deploymentRecipeId, 'Rilascio') : undefined;
                assert(!p.deploymentRecipeId || target?.deployments?.some(d => d.id === p.deploymentRecipeId), 400, 'DEPLOY', 'Ricetta rilascio sconosciuta.');
            }
        }
    }
    async prepareProject(project: Project): Promise<void> { if (!project.targetId)
        return; const target = this.config.targets.find(t => t.id === project.targetId); assert(target, 400, 'TARGET', 'Target sconosciuto.'); const result = await execute({ target, workspace: project.workspace, operation: { kind: 'prepare' }, signal: AbortSignal.timeout(30000), approve: async () => true }); assert(result.ok, 409, 'WORKSPACE', 'Impossibile preparare il workspace: ' + result.output); }
    events(req: IncomingMessage, res: ServerResponse, user: User, after: number): void {
        assert(Number.isSafeInteger(after) && after >= 0, 400, 'CURSOR', 'Cursore non valido.');
        let set = this.streams.get(user.id);
        if (!set) {
            set = new Set();
            this.streams.set(user.id, set);
        }
        assert(set.size < 8, 429, 'STREAMS', 'Troppe connessioni eventi.');
        set.add(res);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        const write = (event: RunEvent) => { if (event.ownerId !== user.id || res.writableEnded)
            return; const { ownerId, ...visible } = event; const frame = `${event.id > 0 ? `id: ${event.id}\n` : ''}data: ${JSON.stringify(visible)}\n\n`; if (!res.write(frame) && res.writableLength > 1024 * 1024)
            res.end(); };
        const rows = this.store.replay(user.id, after);
        for (const e of rows)
            write(e);
        if (rows.length === 500)
            res.write('data: ' + JSON.stringify({ id: 0, type: 'state.changed', createdAt: now(), data: { replayTruncated: true } }) + '\n\n');
        this.store.events.on('event', write);
        const ping = setInterval(() => { if (!res.writableEnded)
            res.write(': heartbeat\n\n'); }, 15000);
        const clean = () => { clearInterval(ping); this.store.events.off('event', write); set!.delete(res); };
        res.once('close', clean);
        req.once('aborted', () => res.end());
    }
    static(pathname: string, method: string, res: ServerResponse): void {
        assert(method === 'GET' || method === 'HEAD', 405, 'METHOD', 'Metodo non consentito.');
        const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://yed1z.ai http://127.0.0.1:* ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

        if (pathname === '/' || pathname === '/index.html') {
            const target = path.resolve('static/index.html');
            assert(existsSync(target), 404, 'NOT_FOUND', 'Dashboard HUD non trovata.');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp });
            res.end(method === 'HEAD' ? undefined : readFileSync(target));
            return;
        }
        if (pathname.startsWith('/static/')) {
            const rel = pathname.slice('/static/'.length).replace(/\.\./g, '');
            const target = path.resolve('static', rel);
            if (existsSync(target)) {
                const ext = path.extname(target).toLowerCase();
                const mimeTypes: Record<string, string> = {
                    '.html': 'text/html; charset=utf-8',
                    '.css': 'text/css; charset=utf-8',
                    '.js': 'text/javascript; charset=utf-8',
                    '.json': 'application/json; charset=utf-8',
                    '.svg': 'image/svg+xml',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.ico': 'image/x-icon',
                    '.webp': 'image/webp'
                };
                const mime = mimeTypes[ext] ?? 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp });
                res.end(method === 'HEAD' ? undefined : readFileSync(target));
                return;
            }
        }
        if (pathname === '/control' || pathname === '/control/' || pathname === '/control/index.html') {
            const target = path.join(this.staticDir, 'index.html');
            assert(existsSync(target), 503, 'BUILD', 'Interfaccia non compilata: esegui npm run build.');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp });
            res.end(method === 'HEAD' ? undefined : readFileSync(target));
            return;
        }
        if (pathname.startsWith('/assets/')) {
            const rel = pathname.slice('/assets/'.length).replace(/\.\./g, '');
            const target = path.join(this.staticDir, rel);
            if (existsSync(target)) {
                const ext = path.extname(target).toLowerCase();
                const mimeTypes: Record<string, string> = {
                    '.html': 'text/html; charset=utf-8',
                    '.css': 'text/css; charset=utf-8',
                    '.js': 'text/javascript; charset=utf-8',
                    '.json': 'application/json; charset=utf-8',
                    '.svg': 'image/svg+xml',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.ico': 'image/x-icon'
                };
                const mime = mimeTypes[ext] ?? 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp });
                res.end(method === 'HEAD' ? undefined : readFileSync(target));
                return;
            }
        }
        throw new AppError(404, 'NOT_FOUND', 'Risorsa non trovata.');
    }
    async apiFacade(req: IncomingMessage, res: ServerResponse, user: User, pathname: string): Promise<void> {
        assert(req.headers.authorization?.startsWith('Bearer '), 401, 'AUTH', 'Le API compatibili richiedono Bearer.');
        if (pathname === '/v1/models' && req.method === 'GET') {
            json(res, 200, { object: 'list', data: this.catalog.models(user).filter(m => m.enabled).map(m => ({ id: m.id, object: 'model', owned_by: m.providerId, name: m.label, underlying_model: m.model, context_length: m.contextWindow })) });
            return;
        }
        assert(pathname === '/v1/chat/completions' && req.method === 'POST', 404, 'NOT_FOUND', 'Endpoint non supportato.');
        assert(user.role !== 'viewer', 403, 'FORBIDDEN', 'Profilo lettore.');
        const b = await body(req), selected = str(b.model, 'Modello'), available = this.catalog.models(user);
        let route = available.find(m => m.id === selected);
        if (!route) {
            const matches = available.filter(m => m.model === selected);
            assert(matches.length <= 1, 400, 'AMBIGUOUS_MODEL', 'Più account offrono questo modello. Usa l’ID della rotta restituito da /v1/models.');
            route = matches[0];
        }
        assert(route, 404, 'MODEL', 'Modello non trovato.');
        const resolved = this.catalog.resolve(user, route.id);
        assert(!['codex', 'antigravity'].includes(resolved.provider.kind), 409, 'CAPABILITY', 'Usa le conversazioni dell’harness per le CLI native.');
        assert(Array.isArray(b.messages) && b.messages.length <= 200, 400, 'MESSAGES', 'Messaggi non validi.');
        const messages = b.messages.map(raw => {
            const m = object(raw);
            assert(['system', 'user', 'assistant', 'tool'].includes(String(m.role)), 400, 'ROLE', 'Ruolo messaggio non valido.');
            const message: import('./adapters/types.ts').Message = { role: m.role as 'system' | 'user' | 'assistant' | 'tool', content: m.content === null ? '' : str(m.content, 'Messaggio', 100000, true) };
            if (m.role === 'tool')
                message.toolCallId = str(m.tool_call_id, 'Tool call ID', 200);
            if (m.tool_calls !== undefined) {
                assert(m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length <= 32, 400, 'TOOLS', 'Tool calls non valide.');
                message.toolCalls = m.tool_calls.map(rawCall => { const call = object(rawCall), fn = object(call.function); return { id: str(call.id, 'Call ID', 200), name: str(fn.name, 'Tool name', 200), arguments: str(fn.arguments, 'Argomenti tool', 100000, true) }; });
            }
            return message;
        });
        const tools = b.tools === undefined ? [] : (() => { assert(Array.isArray(b.tools) && b.tools.length <= 32, 400, 'TOOLS', 'Tool non validi.'); return b.tools.map(raw => { const t = object(raw); assert(t.type === 'function', 400, 'TOOLS', 'Sono supportati function tools.'); const fn = object(t.function); return { name: str(fn.name, 'Nome tool', 200), description: fn.description === undefined ? '' : str(fn.description, 'Descrizione tool', 4000, true), parameters: object(fn.parameters) }; }); })();
        assert(JSON.stringify({ messages, tools }).length <= 500000, 413, 'SIZE', 'Contesto troppo grande.');
        this.inFlightCount++;
        const tStart = Date.now();
        const controller = new AbortController();
        res.once('close', () => controller.abort());
        const signal = AbortSignal.any([controller.signal, this.shutdown.signal, AbortSignal.timeout(10 * 60000)]);
        const release = await this.scheduler.acquire(routeResources(route, this.config), signal), requestId = id('chatcmpl');
        let streamed = false;
        const begin = () => { if (!streamed) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
            streamed = true;
        } };
        const chunk = (value: unknown) => { begin(); res.write('data: ' + JSON.stringify(value) + '\n\n'); };
        try {
            await this.catalog.activate(route.providerId, signal);
            const result = await this.orchestrator.completion({ connection: resolved.connection, model: { id: route.model, contextWindow: route.contextWindow, maxOutputTokens: integer(b.max_completion_tokens ?? b.max_tokens, route.maxOutputTokens ?? 4096, 128, 32000) }, secret: resolved.secret, messages, tools, signal, onText: text => { if (b.stream === true)
                    chunk({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }); } });
            this.catalog.quota(resolved.account, result.quota);
            const toolCalls = result.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
            const usage = result.usage ? { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens, total_tokens: result.usage.inputTokens + result.usage.outputTokens } : undefined;
            const finish = toolCalls.length ? 'tool_calls' : result.finishReason ?? 'stop';

            const { user: clientUser, app: clientApp } = this.identifyClientUser(req, user);
            const durationS = Math.max(0.05, (Date.now() - tStart) / 1000);
            const compTokens = usage?.completion_tokens ?? (result.usage ? result.usage.outputTokens : 0);
            const promptTokens = usage?.prompt_tokens ?? (result.usage ? result.usage.inputTokens : 0);
            recordRequestMetric(
                route.model || selected,
                promptTokens,
                compTokens,
                durationS,
                durationS,
                clientUser,
                clientApp
            );

            if (b.stream === true) {
                if (toolCalls.length)
                    chunk({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: toolCalls.map((t, index) => ({ ...t, index })) }, finish_reason: null }] });
                chunk({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
                res.end('data: [DONE]\n\n');
            }
            else
                json(res, 200, { id: requestId, object: 'chat.completion', model: route.id, choices: [{ index: 0, message: { role: 'assistant', content: result.text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage });
        }
        catch (error) {
            const details = error as {
                status?: number;
                quota?: import('./adapters/types.ts').QuotaObservation;
            };
            if (details.quota)
                this.catalog.quota(resolved.account, details.quota);
            const status = details.status && details.status >= 400 && details.status <= 599 ? details.status : 502;
            if (streamed) {
                chunk({ error: { message: safeError(error), type: 'upstream_error', code: status } });
                res.end('data: [DONE]\n\n');
            }
            else {
                if (details.quota?.retryAfterMs !== undefined)
                    res.setHeader('Retry-After', String(Math.ceil(details.quota.retryAfterMs / 1000)));
                throw new AppError(status, 'UPSTREAM', safeError(error));
            }
        }
        finally {
            this.inFlightCount = Math.max(0, this.inFlightCount - 1);
            release();
        }
    }
    async listen(): Promise<number> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.config.port, this.config.bind, () => resolve());
        });
        this.timer = setInterval(() => {
            void this.catalog.refresh(this.shutdown.signal).then(telemetry => {
                for (const user of this.store.all<User>('user'))
                    this.store.events.emit('event', { id: 0, ownerId: user.id, type: 'telemetry', data: { telemetry }, createdAt: now() });
            }).catch(() => { });
        }, this.config.telemetryIntervalMs);
        this.timer.unref();

        this.probeTimer = setInterval(() => { void this.sampleClusterHardware().catch(() => {}); }, 3000);
        this.probeTimer.unref();
        void this.sampleClusterHardware().catch(() => {});

        void this.catalog.refresh(this.shutdown.signal).catch(() => { });
        return (this.server.address() as { port: number }).port;
    }
    async close(): Promise<void> {
        clearInterval(this.timer);
        if (this.probeTimer) clearInterval(this.probeTimer);
        this.shutdown.abort();
        for (const set of this.streams.values())
            for (const stream of set)
                stream.end();
        await this.orchestrator.close();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
        this.store.close();
    }
}
async function main(): Promise<void> { const directory = path.resolve(process.env.YED1Z_STATE_DIR ?? 'state'), file = process.env.YED1Z_CONFIG ?? path.join(directory, 'config.json'); assert(existsSync(file), 500, 'SETUP', 'Esegui prima node dist/cli.mjs init.'); const app = new Application({ directory, config: loadConfig(file), staticDir: path.resolve(process.env.YED1Z_WEB_DIR ?? 'dist/web') }); assert(app.store.all<User>('user').length, 500, 'SETUP', 'Nessun utente: esegui setup.'); const port = await app.listen(); process.stdout.write(`yed1z ${VERSION} · http://${app.config.bind}:${port}\n`); let closing = false; const close = () => { if (closing)
    return; closing = true; void app.close().then(() => process.exit(0)); }; process.once('SIGINT', close); process.once('SIGTERM', close); }
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    main().catch(error => { process.stderr.write(safeError(error) + '\n'); process.exitCode = 1; });
