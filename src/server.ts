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
import { Connections } from './connections.ts';
import type { ConnectionInput } from './connection-types.ts';
import { routingPreferences } from './request-policy.ts';
import { RouteRouter } from './routing.ts';
import { publicBootstrap, publicTelemetry, guestUser } from './public-dashboard.ts';
import type { RoutingPreferences, RequestedMode } from './contracts.ts';
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
            stats.daily_tokens[today] = { total: 0, deepseek: 0, qwen: 0 };
        }
        stats.daily_tokens[today].total += compToks;
        stats.daily_tokens[today][modKey] = (stats.daily_tokens[today][modKey] || 0) + compToks;
    }

    const shortId = `req-${Math.random().toString(16).slice(2, 7)}`;
    const sessionRecord = {
        id: shortId,
        time: nowTime,
        user: userName,
        app: clientApp,
        model: modelId.includes('qwen') ? 'Qwen 3.8' : (modelId.includes('ds41') ? 'DeepSeek V4.1' : modelId),
        prompt: promptToks || 0,
        gen: compToks || 0,
        duration: `${Math.round(durationS * 100) / 100}s`,
        velocity: tps !== undefined ? `${tps} tok/s` : '—',
        status: 'COMPLETED'
    };
    stats.recent_sessions = stats.recent_sessions || [];
    stats.recent_sessions.unshift(sessionRecord);
    if (stats.recent_sessions.length > 50) {
        stats.recent_sessions = stats.recent_sessions.slice(0, 50);
    }
    try {
        writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');
    } catch {}
}

const VERSION = '0.4.0';
const closed = new Set(['succeeded', 'failed', 'cancelled']);

function json(res: ServerResponse, status: number, data: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    assert((req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 415, 'CONTENT_TYPE', 'Usa application/json.');
    let bytes = 0;
    const parts: Buffer[] = [];
    for await (const part of req) {
        bytes += part.length;
        assert(bytes <= 7 * 1024 * 1024, 413, 'SIZE', 'Richiesta troppo grande.');
        parts.push(Buffer.from(part));
    }
    try {
        return object(JSON.parse(Buffer.concat(parts).toString('utf8')));
    } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError(400, 'JSON', 'JSON non valido.');
    }
}

function operator(user: User): void {
    assert(['admin', 'operator'].includes(user.role), 403, 'FORBIDDEN', 'Operazione riservata agli operatori.');
}

function cookie(req: IncomingMessage): string | undefined {
    const values = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith('yed1z_session='));
    assert(values.length <= 1, 400, 'COOKIE', 'Cookie duplicato.');
    return values[0]?.slice('yed1z_session='.length);
}

export class Application {
    config: Config;
    store: Store;
    catalog: Catalog;
    knowledge: Knowledge;
    connections: Connections;
    scheduler: Scheduler;
    orchestrator: Orchestrator;
    server: Server;
    staticDir: string;
    shutdown = new AbortController();
    timer?: NodeJS.Timeout;
    loadTimer?: NodeJS.Timeout;
    probeTimer?: NodeJS.Timeout;
    streams = new Map<string, Set<ServerResponse>>();
    failures = new Map<string, { count: number; until: number }>();
    clusterTelemetry: ClusterTelemetryState = { ...defaultClusterTelemetry };
    inFlightCount = 0;

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
        this.connections = new Connections(this.catalog);
        this.orchestrator = new Orchestrator({
            store: this.store,
            config: this.config,
            catalog: this.catalog,
            knowledge: this.knowledge,
            scheduler: this.scheduler,
            complete: options.complete
        });
        this.staticDir = options.staticDir ?? path.resolve('dist/web');
        this.server = createServer((req, res) => {
            this.handle(req, res).catch(error => {
                if (res.headersSent) {
                    res.end();
                    return;
                }
                json(res, error instanceof AppError ? error.status : 500, {
                    error: error instanceof AppError ? error.message : 'Errore interno. Controlla la configurazione e i log locali.',
                    code: error instanceof AppError ? error.code : 'INTERNAL'
                });
                if (!(error instanceof AppError))
                    process.stderr.write('[yed1z] ' + safeError(error) + '\n');
            });
        });
        this.server.headersTimeout = 15000;
        this.server.requestTimeout = 30000;
        this.server.keepAliveTimeout = 5000;
        const administrator = this.store.all<User>('user').find(u => u.role === 'admin');
        if (administrator)
            this.catalog.seed(administrator);
    }

    user(req: IncomingMessage): { user: User; session?: string } {
        const authHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization');
        assert(authHeaders.length <= 1, 400, 'AUTH', 'Authorization duplicata.');
        const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
        const session = bearer ? undefined : cookie(req);
        const user = bearer ? this.store.authenticate(bearer, 'key') : session ? this.store.authenticate(session, 'session') : undefined;
        assert(user, 401, 'UNAUTHORIZED', 'Accedi con una chiave del servizio.');
        return { user, session };
    }

    guestOrUser(req: IncomingMessage): { user: User; session?: string; isGuest: boolean } {
        const authHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization');
        if (authHeaders.length > 1) throw new AppError(400, 'AUTH', 'Authorization duplicata.');
        const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
        const session = bearer ? undefined : cookie(req);
        const user = bearer ? this.store.authenticate(bearer, 'key') : session ? this.store.authenticate(session, 'session') : undefined;
        if (!user) {
            assert(!req.headers.authorization && !session, 401, 'UNAUTHORIZED', 'Chiave o sessione non valida. Accedi di nuovo.');
            assert(this.config.publicDashboard !== false, 401, 'UNAUTHORIZED', 'Accedi con una chiave personale.');
            return { user: { ...guestUser }, isGuest: true };
        }
        return { user, session, isGuest: false };
    }

    csrf(req: IncomingMessage, session?: string): void {
        if (!session || ['GET', 'HEAD'].includes(req.method ?? '')) return;
        const origin = req.headers.origin;
        const expected = this.config.publicOrigin ?? `http://${req.headers.host}`;
        assert(origin === expected, 403, 'ORIGIN', 'Origine della richiesta non autorizzata.');
    }

    bootstrap(user: User): Bootstrap {
        if (user.id === 'guest') return publicBootstrap(VERSION, this.config, this.catalog, this.store);
        const isGuest = false;
        const projects = isGuest ? [] : this.store.all<Project>('project').filter(p => p.ownerId === user.id || p.memberIds.includes(user.id) || user.role === 'admin');
        const ids = new Set(projects.map(p => p.id));
        const accounts = isGuest ? [] : this.catalog.accounts(user), providerIds = new Set(accounts.map(a => a.providerId));
        const providers = isGuest ? this.store.all<Provider>('provider').map(p => { const { env, command, args, ...publicProvider } = p; return publicProvider; }) : this.store.all<Provider>('provider').filter(p => p.ownerId === user.id || providerIds.has(p.id)).map(p => { const { env, command, args, ...publicProvider } = p; return publicProvider; });
        const models = isGuest ? this.store.all<ModelRoute>('model').filter(m => m.enabled) : this.catalog.models(user);
        return {
            version: VERSION,
            user,
            projects,
            conversations: isGuest ? [] : this.store.all<Conversation>('conversation').filter(c => c.ownerId === user.id && ids.has(c.projectId)),
            providers,
            accounts,
            models,
            nodes: this.config.nodes.map(n => { const { telemetry, ...visible } = n; return visible; }),
            links: this.config.links,
            resourceGroups: this.config.resourceGroups,
            telemetry: [...this.catalog.telemetry.values()],
            runs: isGuest ? [] : this.store.all<Run>('run').filter(r => r.ownerId === user.id && ids.has(r.projectId)).slice(0, 200),
            approvals: isGuest ? [] : this.store.all<Bootstrap['approvals'][number]>('approval').filter(a => a.ownerId === user.id),
            memories: isGuest ? [] : this.store.all<Memory>('memory').filter(m => ids.has(m.projectId) && (m.ownerId === user.id || m.scope === 'project')),
            artifacts: isGuest ? [] : this.store.all<Artifact>('artifact').filter(a => a.ownerId === user.id && ids.has(a.projectId)),
            evidence: isGuest ? [] : this.store.all<Evidence & { ownerId: string }>('evidence').filter(e => e.ownerId === user.id && ids.has(e.projectId)).slice(0, 1000),
            targets: this.config.targets.map(t => ({
                id: t.id,
                label: t.id,
                nodeId: t.nodeId,
                kind: t.kind,
                commands: t.commands.filter(c => c.verification === true).map(c => ({ id: c.id, label: c.label })),
                deployments: (t.deployments ?? []).map(d => ({ id: d.id, label: d.label }))
            })),
            resourceUsage: this.scheduler.snapshot(),
            routeAvailability: new RouteRouter(this.catalog).availability(user),
            providerLoads: this.catalog.loadMonitor.snapshot(this.config.providers).filter(load => providerIds.has(load.providerId)),
            demo: this.config.demo
        };
    }

    publicDashboard(): Record<string, unknown> {
        const state = publicBootstrap(VERSION, this.config, this.catalog, this.store);
        return {
            version: VERSION,
            clusterId: 'yed1z',
            nodes: state.nodes,
            links: state.links,
            resourceGroups: state.resourceGroups,
            telemetry: state.telemetry,
            models: state.models,
            resourceUsage: state.resourceUsage,
            stats: { totals: { total_tokens: null }, source: 'unavailable' }
        };
    }

    changed(user: User, projectId?: string): void {
        this.store.emit({ ownerId: user.id, projectId, type: 'state.changed' });
    }

    identifyClientUser(req: IncomingMessage, user?: User): { user: string; app: string } {
        let clientUser = user?.name || user?.id || 'funboy';
        const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
        const xUser = req.headers['x-user'] as string;
        if (xUser) {
            clientUser = xUser;
        } else if (clientIp.includes('37.118.7.208')) {
            clientUser = 'cooper';
        } else {
            const authHeader = req.headers.authorization;
            if (authHeader?.startsWith('Bearer ')) {
                const key = authHeader.slice(7);
                const apiKeysPath = path.resolve('data/api_keys.json');
                if (existsSync(apiKeysPath)) {
                    try {
                        const keysData = JSON.parse(readFileSync(apiKeysPath, 'utf8'));
                        for (const [uname, uinfo] of Object.entries<any>(keysData.users || {})) {
                            if (uinfo.key === key || (Array.isArray(uinfo.keys) && uinfo.keys.includes(key))) {
                                clientUser = uname;
                                break;
                            }
                        }
                    } catch {}
                }
            }
        }
        let clientApp = 'API / Agent';
        const ua = req.headers['user-agent'] || '';
        if (ua.includes('GitHubCopilot') || ua.includes('Copilot')) {
            clientApp = 'Copilot Chat';
        } else if (ua.includes('Mozilla') || ua.includes('Chrome')) {
            clientApp = 'Web GUI';
        } else if (ua) {
            clientApp = ua.slice(0, 30);
        }
        return { user: clientUser, app: clientApp };
    }

    async sampleClusterHardware(): Promise<void> {
        try {
            const n1Script = '/home/funboy/scripts/node01-sensors.sh';
            if (existsSync(n1Script)) {
                const { stdout } = await execFileAsync(n1Script, [], { timeout: 2500 });
                const parsed = JSON.parse(stdout);
                this.clusterTelemetry.node01 = { ...this.clusterTelemetry.node01, ...parsed };
            }
        } catch {}

        try {
            const { stdout } = await execFileAsync('ssh', ['-o', 'ConnectTimeout=1', '-o', 'BatchMode=yes', '02-evo-x3-tb', '/home/funboy/scripts/node02-sensors.sh'], { timeout: 2500 });
            const parsed = JSON.parse(stdout);
            this.clusterTelemetry.node02 = { ...this.clusterTelemetry.node02, ...parsed };
        } catch {}

        try {
            const ac = new AbortController();
            const tm = setTimeout(() => ac.abort(), 1800);
            const resp = await fetch('http://192.168.1.50:8080/health', { signal: ac.signal });
            clearTimeout(tm);
            if (resp.ok) {
                const data = await resp.json() as any;
                this.clusterTelemetry.aireward = {
                    ...this.clusterTelemetry.aireward,
                    status: 'online',
                    gpu: { ...this.clusterTelemetry.aireward.gpu, ...data.gpu }
                };
            }
        } catch {}

        try {
            const t0 = Date.now();
            await execFileAsync('ping', ['-c', '1', '-W', '1', '10.55.0.2'], { timeout: 1500 });
            this.clusterTelemetry.tb_link = {
                rtt_ms: Math.round((Date.now() - t0) * 10) / 10,
                status: 'active',
                bandwidth: '40 Gbps USB4 Mesh',
                ip_mesh: '10.55.0.0/30'
            };
        } catch {
            this.clusterTelemetry.tb_link = {
                rtt_ms: 0,
                status: 'inactive',
                bandwidth: '40 Gbps USB4 Mesh',
                ip_mesh: '10.55.0.0/30'
            };
        }

        this.clusterTelemetry.last_updated = Date.now();
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://yed1z.local'), pathname = url.pathname, method = req.method ?? 'GET';
        assert(![...url.searchParams.keys()].some(k => /key|token|password|secret/i.test(k)), 400, 'AUTH', 'Credenziali nella query non ammesse.');

        if ((pathname === '/health' || pathname === '/api/health') && method === 'GET') {
            const active_model = 'qwen';
            json(res, 200, { ok: true, status: 'healthy', version: VERSION, active_model });
            return;
        }

        if (pathname === '/api/dashboard' && method === 'GET') {
            if (this.config.publicDashboard === false) this.user(req);
            json(res, 200, this.publicDashboard());
            return;
        }

        if (pathname === '/api/telemetry' && method === 'GET') {
            if (this.config.publicDashboard === false) this.user(req);
            const statsPath = path.resolve('data/stats.json');
            let stats = { totals: { total_tokens: 0, total_requests: 0, deepseek_tokens: 0, qwen_tokens: 0 }, daily_tokens: {}, recent_sessions: [] };
            if (existsSync(statsPath)) {
                try {
                    stats = JSON.parse(readFileSync(statsPath, 'utf8'));
                } catch {}
            }
            const active_strix = 'qwen';
            const active_aireward = null;
            const active_model = active_strix;
            json(res, 200, {
                active_model,
                active_strix,
                active_aireward,
                in_flight: this.inFlightCount,
                speeds: {
                    decode_tps: 42.4,
                    prefill_tps: 177,
                    ttft_ms: 280,
                    dspark_acc: 49.2
                },
                telemetry: this.clusterTelemetry,
                stats,
                server_time: new Date().toISOString(),
                upstreamTelemetry: publicTelemetry([...this.catalog.telemetry.values()])
            });
            return;
        }

        if (!pathname.startsWith('/api/') && !pathname.startsWith('/v1/')) {
            this.static(pathname, method, res);
            return;
        }

        if (pathname === '/api/auth/verify' && method === 'POST') {
            const b = await body(req);
            const token = str(b.key || b.token || '', 'Chiave', 1024);
            let user = this.store.authenticate(token, 'key');
            if (!user) {
                const apiKeysPath = path.resolve('data/api_keys.json');
                if (existsSync(apiKeysPath)) {
                    try {
                        const keysData = JSON.parse(readFileSync(apiKeysPath, 'utf8'));
                        for (const [uname, uinfo] of Object.entries<any>(keysData.users || {})) {
                            if (uinfo.key === token || (Array.isArray(uinfo.keys) && uinfo.keys.includes(token))) {
                                const role = uname === 'funboy' ? 'admin' : (uinfo.role || 'operator');
                                user = { id: uname, name: uname, role: role as Role, createdAt: now() };
                                break;
                            }
                        }
                    } catch {}
                }
            }
            if (!user) {
                throw new AppError(401, 'UNAUTHORIZED', 'Chiave non valida.');
            }
            const session = this.store.session(user);
            res.setHeader('Set-Cookie', `yed1z_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${this.config.secureCookies ? '; Secure' : ''}`);
            json(res, 200, { ok: true, user: { id: user.id, name: user.name, role: user.role } });
            return;
        }

        if (pathname === '/api/switch' && method === 'POST') {
            const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
            const session = bearer ? undefined : cookie(req);
            let u = bearer ? this.store.authenticate(bearer, 'key') : session ? this.store.authenticate(session, 'session') : undefined;
            if (!u && bearer) {
                const apiKeysPath = path.resolve('data/api_keys.json');
                if (existsSync(apiKeysPath)) {
                    try {
                        const keysData = JSON.parse(readFileSync(apiKeysPath, 'utf8'));
                        for (const [uname, uinfo] of Object.entries<any>(keysData.users || {})) {
                            if (uinfo.key === bearer || (Array.isArray(uinfo.keys) && uinfo.keys.includes(bearer))) {
                                const role = uname === 'funboy' ? 'admin' : (uinfo.role || 'operator');
                                u = { id: uname, name: uname, role: role as Role, createdAt: now() };
                                break;
                            }
                        }
                    } catch {}
                }
            }
            assert(u && ['admin', 'operator'].includes(u.role), 403, 'FORBIDDEN', 'Operazione riservata agli operatori.');
            const b = await body(req);
            const target = str(b.target || b.model || '', 'Target model', 128);
            const clusterModel = '/home/funboy/.local/bin/cluster-model';
            let output = '';
            if (existsSync(clusterModel)) {
                try {
                    const res = await execFileAsync(clusterModel, [target], { timeout: 30000 });
                    output = res.stdout + res.stderr;
                } catch (err: any) {
                    output = err.message || String(err);
                }
            } else {
                output = `cluster-model script not found at ${clusterModel}`;
            }
            json(res, 200, { ok: true, target, output });
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
            assert(b.mode === undefined || b.mode === 'auto' || b.mode === 'chat' || b.mode === 'mission', 400, 'MODE', 'Modalità non valida.');
            const p = b.permissions === undefined ? {} : object(b.permissions);
            for (const field of ['write', 'commands', 'deploy'])
                assert(p[field] === undefined || typeof p[field] === 'boolean', 400, 'INVALID', 'Permesso non valido.');
            const run = this.orchestrator.start(user, key, {
                text: str(b.text, 'Messaggio', 100000),
                routeId: b.routeId ? str(b.routeId, 'Modello') : undefined,
                mode: (b.mode ?? 'auto') as RequestedMode,
                routing: b.routing === undefined ? undefined : routingPreferences(user, this.catalog, b.routing),
                attachmentIds: b.attachmentIds === undefined ? [] : textList(b.attachmentIds, 12),
                permissions: p,
                maxIterations: integer(b.maxIterations, 3, 1, 6),
                maxParallel: integer(b.maxParallel, 3, 1, 6)
            });
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

        if (pathname === '/api/connections/options' && method === 'GET') {
            json(res, 200, this.connections.options(user));
            return;
        }

        if (pathname === '/api/connections/detect' && method === 'POST') {
            await body(req);
            json(res, 200, await this.connections.detect(user, AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(8000)])));
            return;
        }

        if (pathname === '/api/connections' && method === 'POST') {
            const input = await body(req);
            const result = await this.connections.connect(user, input as ConnectionInput, AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15000)]));
            this.changed(user);
            json(res, 200, result);
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
            operator(user);
            void this.catalog.login(user, key, event => emit({ ...event, status: 'pending' }), AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(300000)])).then(async () => {
                const result = await this.catalog.discover(user, key, AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30000)]));
                emit({ status: 'complete', discovered: true, models: result.models, warnings: result.warnings });
                this.changed(user);
            }).catch(e => emit({ status: 'error', message: safeError(e) }));
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
                m.capabilitySource = 'operator';
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
            } else {
                json(res, 200, { ...artifact, content });
            }
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
                const allowed = ['artifact', 'memory', 'run'].some(kind => { const x = this.store.get<{ ownerId: string; projectId: string }>(kind, source); return x?.ownerId === user.id && x.projectId === b.projectId; });
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
        if (b.routing !== undefined) p.routing = routingPreferences(user, this.catalog, b.routing);
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

    async prepareProject(project: Project): Promise<void> {
        if (!project.targetId) return;
        const target = this.config.targets.find(t => t.id === project.targetId);
        assert(target, 400, 'TARGET', 'Target sconosciuto.');
        const result = await execute({ target, workspace: project.workspace, operation: { kind: 'prepare' }, signal: AbortSignal.timeout(30000), approve: async () => true });
        assert(result.ok, 409, 'WORKSPACE', 'Impossibile preparare il workspace: ' + result.output);
    }

    events(req: IncomingMessage, res: ServerResponse, user: User, after: number): void {
        assert(Number.isSafeInteger(after) && after >= 0, 400, 'CURSOR', 'Cursore non valido.');
        let set = this.streams.get(user.id);
        if (!set) {
            set = new Set();
            this.streams.set(user.id, set);
        }
        const limit = user.id === 'guest' ? 128 : 8;
        assert(set.size < limit, 429, 'STREAMS', user.id === 'guest' ? 'La dashboard pubblica ha raggiunto il limite complessivo di connessioni live.' : 'Troppe connessioni eventi per questo account.');
        set.add(res);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        const write = (event: RunEvent) => {
            if (event.ownerId !== user.id || res.writableEnded) return;
            const { ownerId, ...visible } = event;
            const frame = `${event.id > 0 ? `id: ${event.id}\n` : ''}data: ${JSON.stringify(visible)}\n\n`;
            if (!res.write(frame) && res.writableLength > 1024 * 1024) res.end();
        };
        const rows = this.store.replay(user.id, after);
        for (const e of rows) write(e);
        if (rows.length === 500)
            res.write('data: ' + JSON.stringify({ id: 0, type: 'state.changed', createdAt: now(), data: { replayTruncated: true } }) + '\n\n');
        this.store.events.on('event', write);
        const ping = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 15000);
        const clean = () => { clearInterval(ping); this.store.events.off('event', write); set!.delete(res); };
        res.once('close', clean);
        req.once('aborted', () => res.end());
    }

    static(pathname: string, method: string, res: ServerResponse): void {
        assert(method === 'GET' || method === 'HEAD', 405, 'METHOD', 'Metodo non consentito.');
        // Map root / to the Cyberpunk Cockpit HUD
        if (pathname === '/' || pathname === '/index.html') {
            const indexHtml = path.resolve('static/index.html');
            if (existsSync(indexHtml)) {
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'X-Content-Type-Options': 'nosniff',
                    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://yed1z.ai http://127.0.0.1:* ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
                });
                res.end(method === 'HEAD' ? undefined : readFileSync(indexHtml));
                return;
            }
        }

        // Map /control or /control/* to the Control Room web app
        if (pathname === '/control' || pathname === '/control/' || pathname === '/control/index.html') {
            const controlHtml = path.resolve(this.staticDir, 'index.html');
            if (existsSync(controlHtml)) {
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'X-Content-Type-Options': 'nosniff',
                    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://yed1z.ai http://127.0.0.1:* ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
                });
                res.end(method === 'HEAD' ? undefined : readFileSync(controlHtml));
                return;
            }
        }

        // Map static assets for the HUD
        if (pathname.startsWith('/static/')) {
            const subpath = pathname.slice('/static/'.length);
            const safePath = path.normalize(subpath).replace(/^(\.\.[\/\\])+/, '');
            const filePath = path.resolve('static', safePath);
            if (existsSync(filePath)) {
                const ext = path.extname(filePath).toLowerCase();
                const mimeTypes: Record<string, string> = {
                    '.html': 'text/html; charset=utf-8',
                    '.css': 'text/css; charset=utf-8',
                    '.js': 'text/javascript; charset=utf-8',
                    '.json': 'application/json; charset=utf-8',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                    '.svg': 'image/svg+xml',
                    '.ico': 'image/x-icon',
                    '.woff2': 'font/woff2'
                };
                const mime = mimeTypes[ext] || 'application/octet-stream';
                res.writeHead(200, {
                    'Content-Type': mime,
                    'Cache-Control': 'public, max-age=3600',
                    'X-Content-Type-Options': 'nosniff'
                });
                res.end(method === 'HEAD' ? undefined : readFileSync(filePath));
                return;
            }
        }

        // Control Room Web Assets
        const files: Record<string, [string, string]> = {
            '/assets/app.js': ['app.js', 'text/javascript; charset=utf-8'],
            '/assets/style.css': ['style.css', 'text/css; charset=utf-8'],
            '/assets/favicon.svg': ['favicon.svg', 'image/svg+xml']
        };
        const file = files[pathname];
        if (file) {
            const target = path.join(this.staticDir, file[0]);
            assert(existsSync(target), 503, 'BUILD', 'Interfaccia non compilata: esegui npm run build.');
            res.writeHead(200, {
                'Content-Type': file[1],
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://yed1z.ai http://127.0.0.1:* ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
            });
            res.end(method === 'HEAD' ? undefined : readFileSync(target));
            return;
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
        let resolved = this.catalog.resolve(user, route.id);
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
        const controller = new AbortController();
        res.once('close', () => controller.abort());
        const signal = AbortSignal.any([controller.signal, this.shutdown.signal, AbortSignal.timeout(10 * 60000)]);
        const lease = await new RouteRouter(this.catalog).reserve({ user, preferredRouteId: route.id, strategy: 'pinned', purpose: 'chat', nativeAllowed: false, priority: 'interactive', maxWaitMs: 8000, signal });
        resolved = lease; route = lease.route;
        const release = lease.release, requestId = id('chatcmpl');
        res.setHeader('X-Yed1z-Queue-Ms', String(lease.waitMs));
        let streamed = false;
        const begin = () => { if (!streamed) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
            streamed = true;
        } };
        const chunk = (value: unknown) => { begin(); res.write('data: ' + JSON.stringify(value) + '\n\n'); };
        const tStart = Date.now();
        this.inFlightCount++;
        try {
            await this.catalog.activate(route.providerId, signal);
            const result = await this.orchestrator.completion({ connection: resolved.connection, model: { id: route.model, contextWindow: route.contextWindow, maxOutputTokens: integer(b.max_completion_tokens ?? b.max_tokens, route.maxOutputTokens ?? 4096, 128, 32000) }, secret: resolved.secret, messages, tools, signal, onText: text => { if (b.stream === true)
                    chunk({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }); } });
            this.catalog.succeeded(resolved.account, result.quota);
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

    broadcastTelemetry(): void {
        const router = new RouteRouter(this.catalog), telemetry = [...this.catalog.telemetry.values()];
        for (const user of this.store.all<User>('user')) {
            const allowed = new Set(this.catalog.accounts(user).map(a => a.providerId));
            this.store.events.emit('event', { id: 0, ownerId: user.id, type: 'telemetry', data: {
                telemetry, resourceUsage: this.scheduler.snapshot(), routeAvailability: router.availability(user),
                providerLoads: this.catalog.loadMonitor.snapshot(this.config.providers).filter(p => allowed.has(p.providerId))
            }, createdAt: now() });
        }
        if (this.config.publicDashboard !== false) this.store.events.emit('event', { id: 0, ownerId: 'guest', type: 'telemetry', data: { telemetry: publicTelemetry(telemetry), resourceUsage: this.scheduler.snapshot() }, createdAt: now() });
    }

    broadcastRouting(): void {
        const router = new RouteRouter(this.catalog), resourceUsage = this.scheduler.snapshot();
        const loads = this.catalog.loadMonitor.snapshot(this.config.providers);
        for (const user of this.store.all<User>('user')) {
            if (!this.streams.has(user.id)) continue;
            const allowed = new Set(this.catalog.accounts(user).map(a => a.providerId));
            this.store.events.emit('event', { id: 0, ownerId: user.id, type: 'routing.updated', data: {
                resourceUsage, routeAvailability: router.availability(user), providerLoads: loads.filter(p => allowed.has(p.providerId))
            }, createdAt: now() });
        }
        if (this.config.publicDashboard !== false && this.streams.has('guest')) this.store.events.emit('event', { id: 0, ownerId: 'guest', type: 'routing.updated', data: { resourceUsage }, createdAt: now() });
    }

    async listen(): Promise<number> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.config.port, this.config.bind, () => resolve());
        });
        this.timer = setInterval(() => {
            void this.catalog.refresh(this.shutdown.signal).then(() => this.broadcastTelemetry()).catch(() => {});
        }, this.config.telemetryIntervalMs);
        this.timer.unref();
        void this.catalog.refresh(this.shutdown.signal).then(() => this.broadcastTelemetry()).catch(() => {});
        const hasLoadProbes = this.config.providers.some(p => p.loadProbe);
        if (hasLoadProbes) {
            await this.catalog.loadMonitor.refresh(this.config.providers, this.shutdown.signal);
        }
        this.loadTimer = setInterval(() => {
            this.broadcastRouting();
            if (hasLoadProbes) void this.catalog.loadMonitor.refresh(this.config.providers, this.shutdown.signal).catch(() => {});
        }, 2000);
        this.loadTimer.unref();

        this.probeTimer = setInterval(() => { void this.sampleClusterHardware().catch(() => {}); }, 3000);
        this.probeTimer.unref();
        void this.sampleClusterHardware().catch(() => {});

        return (this.server.address() as { port: number }).port;
    }

    async close(): Promise<void> {
        clearInterval(this.timer);
        if (this.loadTimer) clearInterval(this.loadTimer);
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

async function main(): Promise<void> {
    const directory = path.resolve(process.env.YED1Z_STATE_DIR ?? 'state'), file = process.env.YED1Z_CONFIG ?? path.join(directory, 'config.json');
    assert(existsSync(file), 500, 'SETUP', 'Esegui prima node dist/cli.mjs init.');
    const app = new Application({ directory, config: loadConfig(file), staticDir: path.resolve(process.env.YED1Z_WEB_DIR ?? 'dist/web') });
    assert(app.store.all<User>('user').length, 500, 'SETUP', 'Nessun utente: esegui setup.');
    const port = await app.listen();
    process.stdout.write(`yed1z ${VERSION} · http://${app.config.bind}:${port}\n`);
    let closing = false;
    const close = () => { if (closing) return; closing = true; void app.close().then(() => process.exit(0)); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    main().catch(error => { process.stderr.write(safeError(error) + '\n'); process.exitCode = 1; });
