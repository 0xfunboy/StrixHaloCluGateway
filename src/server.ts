import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
import { aliasRoutes } from './model-aliases.ts';
import { accountUsage } from './usage.ts';
import { fromResponses, ResponsesOutput } from './responses-facade.ts';
import { RouteRouter } from './routing.ts';
import { publicBootstrap, publicTelemetry, guestUser } from './public-dashboard.ts';
import type { RoutingPreferences, RequestedMode } from './contracts.ts';
import { Orchestrator, type Completion } from './orchestrator.ts';
import { stopStrataEngine } from './adapters/lifecycle.ts';
import { isEngineReady } from './adapters/index.ts';
import { execute } from './execution/index.ts';
import { AppError, assert, endpoint, id, integer, now, object, safeError, str, textList } from './util.ts';

const VERSION = '1.0.0-rc.1';
const webCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const historicCsp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
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
    streams = new Map<string, Set<ServerResponse>>();
    failures = new Map<string, { count: number; until: number }>();
    inFlightCount = 0;
    readiness = new Map<string, { ready: boolean; observedAt: number }>();
    samplingEngines = false;

    async refreshEngines() {
        if (this.samplingEngines) return;
        this.samplingEngines = true;
        try {
            await Promise.allSettled(this.config.providers.filter(p => p.enabled && p.activation).map(async p => {
                const ready = await isEngineReady(p.activation!, this.shutdown.signal);
                this.readiness.set(p.id, { ready, observedAt: Date.now() });
            }));
        } finally { this.samplingEngines = false; }
    }

    engineStatus(providerId: string) {
        const sampled = this.readiness.get(providerId);
        if (sampled && Date.now() - sampled.observedAt <= this.config.telemetryIntervalMs * 2 + 5000)
            return sampled.ready ? 'ready' : 'standby';
        return 'unknown';
    }

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

    acceptsOrigin(req: IncomingMessage): boolean {
        const origin=req.headers.origin;
        if (origin===(this.config.publicOrigin ?? 'http://'+req.headers.host)) return true;
        if (!origin || !req.headers.host || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false;
        try {
            const local=new URL(origin);
            return local.origin===origin && ['http:','https:'].includes(local.protocol) && ['localhost','127.0.0.1','[::1]'].includes(local.hostname) && local.host===req.headers.host;
        } catch { return false; }
    }

    csrf(req: IncomingMessage, session?: string): void {
        if (!session || ['GET', 'HEAD'].includes(req.method ?? '')) return;
        assert(this.acceptsOrigin(req), 403, 'ORIGIN', 'Origine della richiesta non autorizzata.');
    }

    bootstrap(user: User): Bootstrap {
        if (user.id === 'guest') return publicBootstrap(VERSION, this.config, this.catalog, this.store);
        const projects = this.store.all<Project>('project').filter(p => p.ownerId === user.id || p.memberIds.includes(user.id) || user.role === 'admin');
        const ids = new Set(projects.map(p => p.id));
        const accounts = this.catalog.accounts(user), providerIds = new Set(accounts.map(a => a.providerId));
        const providers = this.store.all<Provider>('provider').filter(p => p.ownerId === user.id || providerIds.has(p.id)).map(p => { const { env, command, args, ...publicProvider } = p; return publicProvider; });
        const models = this.catalog.models(user);
        return {
            version: VERSION,
            user,
            projects,
            conversations: this.store.all<Conversation>('conversation').filter(c => c.ownerId === user.id && ids.has(c.projectId)),
            providers,
            accounts,
            models,
            nodes: this.config.nodes.map(n => { const { telemetry, ...visible } = n; return visible; }),
            links: this.config.links,
            resourceGroups: this.config.resourceGroups,
            telemetry: [...this.catalog.telemetry.values()],
            runs: this.store.all<Run>('run').filter(r => r.ownerId === user.id && ids.has(r.projectId)).slice(0, 200),
            approvals: this.store.all<Bootstrap['approvals'][number]>('approval').filter(a => a.ownerId === user.id),
            memories: this.knowledge.visibleMemories(user, ids),
            artifacts: this.store.all<Artifact>('artifact').filter(a => a.ownerId === user.id && ids.has(a.projectId)),
            evidence: this.store.all<Evidence & { ownerId: string }>('evidence').filter(e => e.ownerId === user.id && ids.has(e.projectId)).slice(0, 1000),
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

    activeEngines() {
        const loaded = this.catalog.loadMonitor.snapshot(this.config.providers);
        return this.config.providers.filter(p => ['local','cluster'].includes(p.tag ?? '') && (this.engineStatus(p.id) === 'ready' || loaded.some(l =>
            l.providerId === p.id && (l.status === 'available' || l.status === 'busy') && l.expiresAt && Date.parse(l.expiresAt) > Date.now())))
            .map(p => ({ providerId: p.id, label: p.label }));
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
            engines: this.config.providers.filter(p => ['local', 'cluster'].includes(p.tag ?? '') && p.enabled).map(p => ({
                id: p.id, label: p.label, nodeIds: p.nodeIds, switchable: Boolean(p.activation), canStop: Boolean(p.activation?.stop), status: this.engineStatus(p.id),
                load: this.catalog.loadMonitor.snapshot(this.config.providers).find(l => l.providerId === p.id)?.status ?? 'unknown'
            })),
            stats: { totals: this.store.db.prepare('SELECT count(*) AS total_requests, CASE WHEN count(input_tokens)+count(output_tokens)>0 THEN coalesce(sum(input_tokens),0)+coalesce(sum(output_tokens),0) END AS total_tokens FROM inference_usage').get(),
                source: 'gateway', scope: 'gateway_api', latest: this.store.db.prepare('SELECT created,total_ms,ttft_ms,decode_tps,prefill_tps FROM inference_usage ORDER BY created DESC LIMIT 1').get() ?? null }
        };
    }

    changed(user: User, projectId?: string): void {
        this.store.emit({ ownerId: user.id, projectId, type: 'state.changed' });
    }
    private changedSharedMemory(user: User, projectId: string): void {
        const project = this.store.projectFor(user, projectId);
        const recipients = new Set([project.ownerId, ...project.memberIds]);
        recipients.delete(user.id);
        for (const ownerId of recipients) {
            this.store.emit({ ownerId, projectId, type: 'state.changed', data: { knowledgeChanged: true } });
        }
    }

    private indexing = new Map<string,{pending:boolean; done:Promise<void>}>();

    private indexLocalSources(user:User, projectId:string):void {
        const providerId=this.config.defaultEmbeddingProviderId;
        if(!providerId || this.shutdown.signal.aborted) return;
        const seed=this.config.providers.find(p=>p.id===providerId && p.tag==='local');
        if(!seed?.baseUrl || !['127.0.0.1','localhost','[::1]'].includes(new URL(seed.baseUrl).hostname)) return;
        const key=user.id+'/'+projectId, existing=this.indexing.get(key);
        if(existing){existing.pending=true;return;}
        const job={pending:true,done:Promise.resolve()};
        this.indexing.set(key,job);
        job.done=(async()=>{
            while(job.pending && !this.shutdown.signal.aborted) {
                job.pending=false;
                const project=this.store.projectFor(user,projectId), routeId=project.routes.embedding;
                if(!routeId || this.store.get<ModelRoute>('model',routeId)?.providerId!==providerId) break;
                const signal=AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(120000)]);
                await this.knowledge.reindex(user,project,routeId,this.catalog.embedder(user,routeId),signal);
            }
        })().catch(()=>{
            if(!this.shutdown.signal.aborted) this.store.emit({ownerId:user.id,projectId,type:'knowledge.index_deferred',text:'Indicizzazione semantica da riprovare. Ricerca testuale disponibile.'});
        }).finally(()=>this.indexing.delete(key));
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://yed1z.local'), pathname = url.pathname, method = req.method ?? 'GET';
        assert(![...url.searchParams.keys()].some(k => /key|token|password|secret/i.test(k)), 400, 'AUTH', 'Credenziali nella query non ammesse.');

        if ((pathname === '/health' || pathname === '/api/health') && method === 'GET') {
            const active_model = this.activeEngines()[0]?.label ?? null;
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
            const state = this.publicDashboard();
            const active = this.activeEngines();
            const strix = active.find(e => e.providerId.startsWith('strix-'))?.providerId.slice(6);
            const cuda = active.find(e => e.providerId.startsWith('cuda-'))?.providerId.slice(5);
            const latest = this.store.db.prepare('SELECT ttft_ms,decode_tps,prefill_tps FROM inference_usage ORDER BY created DESC LIMIT 1').get();
            const actor = this.guestOrUser(req);
            const stats = state.stats as Record<string, unknown>;
            stats.daily_tokens = Object.fromEntries(this.store.db.prepare(`
                SELECT substr(u.created,1,10) AS day,sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) AS total,
                sum(CASE WHEN lower(json_extract(e.data,'$.model')) LIKE '%qwen%' THEN coalesce(input_tokens,0)+coalesce(output_tokens,0) END) AS qwen,
                sum(CASE WHEN lower(json_extract(e.data,'$.model')) LIKE '%deepseek%' THEN coalesce(input_tokens,0)+coalesce(output_tokens,0) END) AS deepseek
                FROM inference_usage u LEFT JOIN entities e ON e.id=u.route WHERE u.created>=date('now','-30 days') AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
                GROUP BY 1 ORDER BY 1`).all().map(r => [String(r.day), r]));
            stats.recent_sessions = actor.isGuest ? [] : this.store.db.prepare(`
                SELECT substr(u.created,12,8) AS time,json_extract(e.data,'$.label') AS model,u.input_tokens AS prompt,u.output_tokens AS gen,u.total_ms/1000.0 AS duration,u.decode_tps AS velocity
                FROM inference_usage u LEFT JOIN entities e ON e.id=u.route WHERE u.owner=? ORDER BY u.created DESC LIMIT 15`).all(actor.user.id)
                .map(row => ({ ...row, user: actor.user.name, app: 'API', status: 'COMPLETED' }));
            json(res, 200, { ...state, active_model: strix ?? cuda ?? active[0]?.label ?? null, activeEngines: active,
                active_strix: strix ?? null, active_aireward: cuda === 'qwen' ? 'qwen38-strata' : cuda === 'deepseek' ? 'ds41-strata' : null,
                speeds: { decode_tps: latest?.decode_tps ?? null, prefill_tps: latest?.prefill_tps ?? null, ttft_ms: latest?.ttft_ms ?? null, dspark_acc: null },
                in_flight: this.inFlightCount, server_time: now(), upstreamTelemetry: state.telemetry });
            return;
        }

        if (!pathname.startsWith('/api/') && !pathname.startsWith('/v1/')) {
            this.static(pathname, method, res);
            return;
        }

        if (['/api/login', '/api/auth/verify'].includes(pathname) && method === 'POST') {
            const input = await body(req), ip = req.socket.remoteAddress ?? 'unknown', prior = this.failures.get(ip);
            assert(!prior || prior.until < Date.now() || prior.count < 12, 429, 'RATE_LIMIT', 'Troppi tentativi. Attendi un minuto.');
            const token = str(input.token ?? input.admin_key ?? input.key ?? req.headers.authorization?.match(/^Bearer (.+)$/)?.[1], 'Chiave', 1024), user = this.store.authenticate(token, 'key');
            if (!user) {
                if (this.failures.size > 5000)
                    this.failures.clear();
                this.failures.set(ip, { count: prior && prior.until > Date.now() ? prior.count + 1 : 1, until: Date.now() + 60000 });
                throw new AppError(401, 'UNAUTHORIZED', 'Chiave non valida.');
            }
            if (req.headers.origin)
                assert(this.acceptsOrigin(req), 403, 'ORIGIN', 'Origine non autorizzata.');
            this.failures.delete(ip);
            const session = this.store.session(user);
            res.setHeader('Set-Cookie', `yed1z_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${this.config.secureCookies ? '; Secure' : ''}`);
            json(res, 200, { ok: true, user });
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
        if (pathname === '/api/me/appearance' && method === 'GET') {
            json(res, 200, user.appearance ?? {});
            return;
        }
        if (pathname === '/api/me/appearance' && method === 'PATCH') {
            const input = await body(req);
            assert(Object.keys(input).length > 0 && Object.keys(input).every(field => field === 'theme' || field === 'motion'), 400, 'PREFERENCES', 'Preferenza di visualizzazione sconosciuta.');
            const { theme, motion } = input;
            assert(theme === undefined || theme === 'light' || theme === 'dark' || theme === 'system', 400, 'PREFERENCES', 'Tema non valido.');
            assert(motion === undefined || motion === 'on' || motion === 'off', 400, 'PREFERENCES', 'Preferenza movimento non valida.');
            // Re-read after receiving the body so overlapping partial updates merge.
            const current = this.store.get<User>('user', user.id);
            assert(current, 401, 'UNAUTHORIZED', 'Account non disponibile.');
            current.appearance = { ...current.appearance, ...(theme ? { theme } : {}), ...(motion ? { motion } : {}) };
            this.store.put('user', current);
            this.changed(current);
            json(res, 200, current.appearance);
            return;
        }
        const segments = pathname.split('/').filter(Boolean), key = segments[2];
        const knowledgeSearch = method === 'POST' && segments[1] === 'projects' && segments.length === 5 && segments[3] === 'knowledge' && segments[4] === 'search';
        assert(method === 'GET' || knowledgeSearch || user.role !== 'viewer', 403, 'FORBIDDEN', 'Il profilo lettore non può modificare dati.');

        if (pathname === '/api/usage' && method === 'GET') {
            json(res,200,accountUsage(this.store,user)); return;
        }

        if (pathname === '/api/switch' && method === 'POST') {
            operator(user);
            const input = await body(req);
            const target = input.target === 'aireward' ? 'cuda' : input.target;
            const stopping=input.action==='stop' || input.model==='stop';
            const providerId = input.providerId === undefined ? (stopping && target==='cuda' ? this.config.providers.find(p=>p.id.startsWith('cuda-') && p.activation?.stop)?.id : [target, input.model].join('-')) : str(input.providerId, 'Provider');
            const stop=this.config.providers.find(p=>p.id===providerId)?.activation?.stop;
            if (stopping) assert(stop,400,'ACTIVATION','Arresto non configurato per questo motore.');
            assert(this.config.providers.some(p => p.id === providerId && p.activation), 400, 'ACTIVATION', 'Nessuna attivazione configurata per il motore selezionato.');
            const route = this.catalog.models(user).find(m => m.providerId === providerId && m.enabled);
            assert(route, 404, 'MODEL', 'Nessuna rotta disponibile per questo motore.');
            const controller = new AbortController();
            res.once('close', () => controller.abort());
            const signal = AbortSignal.any([controller.signal, this.shutdown.signal, AbortSignal.timeout(600000)]);
            const lease = await new RouteRouter(this.catalog).reserve({ user, preferredRouteId: route.id, signal, strategy: 'pinned', maxWaitMs: 10000 });
            try {
                if (stopping && stop) await stopStrataEngine(stop,signal); else await this.catalog.activate(route.providerId,signal);
                await this.refreshEngines();
            }
            finally { lease.release(); }
            json(res, 200, { ok: true, providerId, model: stopping ? null : route.model, stopped:stopping });
            return;
        }

        if (pathname === '/api/projects' && method === 'POST') {
            const b = await body(req);
            assert(this.store.all<Project>('project').filter(p => p.ownerId === user.id).length < 100, 413, 'LIMIT', 'Limite progetti raggiunto.');
            const project: Project = { id: id('prj'), ownerId: user.id, memberIds: [], name: str(b.name, 'Nome', 120), description: b.description === undefined ? '' : str(b.description, 'Descrizione', 12000, true), routes: this.catalog.initialProjectRoutes(user), verifyRecipeIds: [], createdAt: now(), updatedAt: now() };
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

        if (knowledgeSearch) {
            const project = this.store.projectFor(user, key), input = await body(req);
            const query = str(input.query, 'Ricerca', 12000);
            const modelKey = user.role === 'viewer' ? undefined : project.routes.embedding;
            const controller = new AbortController();
            res.once('close', () => controller.abort());
            const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
            const result = await this.knowledge.search(user, project.id, query, {
                signal, limit: integer(input.limit, 8, 1, 24), maxChars: integer(input.maxChars, 6400, 128, 12000),
                ...(modelKey ? { modelKey, embed: this.catalog.embedder(user, modelKey) } : {}),
            });
            res.setHeader('Cache-Control', 'no-store');
            json(res, 200, result);
            return;
        }

        if (segments[1] === 'projects' && segments.length === 6 && segments[3] === 'knowledge' && segments[4] === 'sources' && method === 'GET') {
            const revision = url.searchParams.get('revision');
            const sourceHash = url.searchParams.get('hash') ?? undefined;
            assert(revision === null || /^\d{1,12}$/.test(revision), 400, 'SOURCE', 'Revisione non valida.');
            assert(sourceHash === undefined || /^[a-f0-9]{64}$/.test(sourceHash), 400, 'SOURCE', 'Hash sorgente non valido.');
            const result = this.knowledge.source(user, key, segments[5], { revision: revision === null ? undefined : Number(revision), sourceHash });
            res.setHeader('Cache-Control', 'no-store');
            json(res, 200, result);
            return;
        }

        if (segments[1] === 'projects' && segments[3] === 'reindex' && method === 'POST') {
            const p = this.store.projectFor(user, key);
            assert(p.routes.embedding, 409, 'EMBEDDING', 'Scegli un modello embedding nelle impostazioni del progetto.');
            const force = url.searchParams.get('force') === '1';
            const result = await this.knowledge.reindex(user, p, p.routes.embedding, this.catalog.embedder(user, p.routes.embedding), AbortSignal.timeout(120000), force);
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

        if (segments[1] === 'conversations' && segments.length === 4 && segments[3] === 'branch' && method === 'POST') {
            const parent = this.store.own<Conversation>(user, 'conversation', key);
            this.store.projectFor(user, parent.projectId);
            const input = await body(req);
            const messageId = str(input.messageId, 'Messaggio');
            const index = parent.messages.findIndex(message => message.id === messageId);
            assert(index >= 0, 404, 'MESSAGE', 'Messaggio non trovato in questa conversazione.');
            const messages = parent.messages.slice(0, index + 1);
            assert(messages.every(message => message.status !== 'streaming'), 409, 'STREAMING', 'Attendi il completamento del turno prima di creare un ramo.');
            assert(this.store.all<Conversation>('conversation').filter(c => c.ownerId === user.id && c.projectId === parent.projectId).length < 250, 413, 'LIMIT', 'Limite conversazioni raggiunto.');
            const createdAt = now();
            const branch: Conversation = { ...parent, id: id('conv'), createdAt, updatedAt: createdAt, messages,
                title: input.title === undefined ? ('Ramo · ' + parent.title).slice(0, 200) : str(input.title, 'Titolo', 200),
                branch: { conversationId: parent.id, messageId, createdAt } };
            this.store.put('conversation', branch);
            this.changed(user, parent.projectId);
            json(res, 201, branch);
            return;
        }

        if (segments[1] === 'runs' && segments.length === 4 && segments[3] === 'events' && method === 'GET') {
            const run = this.store.own<Run>(user, 'run', key);
            this.store.projectFor(user, run.projectId);
            const after = Number(url.searchParams.get('after') ?? 0);
            assert(Number.isSafeInteger(after) && after >= 0, 400, 'CURSOR', 'Cursore non valido.');
            const rows = this.store.db.prepare('SELECT id,data FROM events WHERE owner=? AND run=? AND id>? ORDER BY id LIMIT 201').all(user.id, key, after);
            const events = rows.slice(0, 200).map(row => ({ ...JSON.parse(String(row.data)), id: Number(row.id) }));
            json(res, 200, { events, nextCursor: rows.length > 200 ? events.at(-1)!.id : null });
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
            const workspaceIsolation = b.workspaceIsolation;
            assert(workspaceIsolation === undefined || workspaceIsolation === 'shared' || workspaceIsolation === 'git-worktree', 400, 'INVALID', 'Modalità workspace non valida.');
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
                maxParallel: integer(b.maxParallel, 3, 1, 6),
                parentRunId: b.parentRunId === undefined ? undefined : str(b.parentRunId, 'Missione di origine', 120),
                workspaceIsolation
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
                const b = (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']) ? await body(req) : {};
                const digest = b.verificationDigest === undefined ? undefined : str(b.verificationDigest, 'Digest di verifica', 64);
                assert(!digest || /^[0-9a-f]{64}$/u.test(digest), 400, 'INVALID', 'Digest di verifica non valido.');
                json(res, 202, await this.orchestrator.release(user, key, digest));
                return;
            }
            if (action === 'reconcile') {
                const b = await body(req);
                const outcome = b.outcome;
                assert(outcome === 'applied' || outcome === 'not_applied' || outcome === 'rolled_back', 400, 'INVALID', 'Esito di riconciliazione non valido.');
                json(res, 200, this.orchestrator.reconcile(user, key, str(b.operationId, 'Operazione', 120), outcome, str(b.note, 'Evidenza osservata', 12000)));
                return;
            }
            if (action === 'promote') {
                const b = await body(req);
                const digest = str(b.verificationDigest, 'Digest di verifica', 64);
                assert(/^[0-9a-f]{64}$/u.test(digest), 400, 'INVALID', 'Digest di verifica non valido.');
                json(res, 200, await this.orchestrator.manageWorktree(user, key, 'promote', digest));
                return;
            }
            if (action === 'cleanup') {
                json(res, 200, await this.orchestrator.manageWorktree(user, key, 'cleanup'));
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

        if (segments[1]==='accounts' && segments.length===4 && segments[3]==='delegates' && ['GET','PUT'].includes(method)) {
            operator(user);
            const account=this.store.own<Account>(user,'account',key);
            const provider=this.store.require<Provider>('provider',account.providerId);
            const native=['antigravity','codex'].includes(provider.kind);
            const team=new Set(this.store.all<Project>('project').filter(p=>p.ownerId===user.id || p.memberIds.includes(user.id)).flatMap(p=>[p.ownerId,...p.memberIds]));
            const eligible=this.store.all<User>('user').filter(u=>u.id!==user.id && u.role!=='viewer' && (user.role==='admin' || team.has(u.id)) &&
                (!native || ['operator','admin'].includes(u.role))).map(({id,name,role})=>({id,name,role}));
            if (method==='PUT') {
                const input=await body(req), allowed=new Set(eligible.map(u=>u.id));
                const userIds=[...new Set(textList(input.userIds,128))];
                assert(typeof input.shared==='boolean' && !(input.shared && native),400,'ACCOUNT','Per una CLI nativa scegli gli operatori autorizzati.');
                assert(userIds.every(id=>allowed.has(id)),400,'ACCOUNT','Membro del team non disponibile per questo account.');
                const before=new Set(account.grantedUserIds ?? []), oldShared=account.shared;
                account.grantedUserIds=userIds; account.shared=input.shared;
                this.store.put('account',account); this.changed(user);
                const updated=oldShared!==account.shared ? this.store.all<User>('user').map(u=>u.id) : [...before,...userIds];
                for(const ownerId of new Set(updated)) if(ownerId!==user.id) this.store.emit({ownerId,type:'state.changed'});
            }
            json(res,200,{eligible,userIds:account.grantedUserIds ?? [],shared:account.shared}); return;
        }

        if (segments[1] === 'accounts' && segments[3] === 'discover' && method === 'POST') {
            const result = await this.catalog.discover(user, key, AbortSignal.timeout(45000));
            this.changed(user);
            json(res, 200, result);
            return;
        }

        if (segments[1] === 'accounts' && segments[3] === 'login' && segments[4] === 'respond' && segments.length === 5 && method === 'POST') {
            const input=await body(req);
            json(res,202,this.connections.respondNativeLogin(user,key,str(input.operationId,'Richiesta'),str(input.code,'Codice di autorizzazione',16384)));
            return;
        }

        if (segments[1] === 'accounts' && segments[3] === 'login' && segments.length === 4 && ['GET', 'POST', 'DELETE'].includes(method)) {
            res.setHeader('Cache-Control', 'no-store');
            if (method === 'GET') json(res, 200, this.connections.nativeLogin(user, key));
            else if (method === 'DELETE') json(res, 200, this.connections.cancelNativeLogin(user, key));
            else json(res, 202, this.connections.startNativeLogin(user, key, this.shutdown.signal, state => {
                this.store.events.emit('event', { id: 0, ownerId: user.id, type: 'account.login', createdAt: now(), data: { ...state } });
                if (state.status === 'complete') this.changed(user);
            }));
            return;
        }

        if (pathname === '/api/models' && method === 'POST') {
            operator(user);
            const b = await body(req);
            const providerId = str(b.providerId, 'Provider');
            const accountId = str(b.accountId, 'Account');
            const provider = this.store.require<Provider>('provider', providerId);
            const account = this.store.require<Account>('account', accountId);
            this.store.own<Account>(user, 'account', account.id);
            const modelName = str(b.model, 'ID modello', 200);
            assert(account.providerId === providerId, 400, 'ACCOUNT', 'Account e provider devono corrispondere.');
            assert(!this.store.all<ModelRoute>('model').some(m => m.accountId === accountId && m.model === modelName), 409, 'MODEL_EXISTS', 'Modello già registrato. Modifica la rotta esistente.');
            const label = b.label === undefined ? modelName : str(b.label, 'Nome', 200);
            const contextWindow = b.contextWindow === undefined ? undefined : integer(b.contextWindow, 16384, 4096, 2000000);
            const capabilities = b.capabilities ? textList(b.capabilities) : [];
            assert(capabilities.every(c => ['chat', 'tools', 'embedding', 'vision'].includes(c)), 400, 'CAPABILITY', 'Capacità non valida.');
            const m = this.store.put<ModelRoute>('model', {
                id: id('mdl'),
                providerId,
                accountId,
                label,
                model: modelName,
                nodeIds: provider.nodeIds,
                resourceGroupIds: provider.resourceGroupIds,
                contextWindow,
                capabilities,
                capabilitySource: capabilities.length ? 'operator' : 'unknown',
                enabled: true
            });
            this.changed(user);
            json(res, 201, m);
            return;
        }

        if (segments[1] === 'models' && segments.length === 3 && method === 'PATCH') {
            operator(user);
            const m = this.store.require<ModelRoute>('model', key);
            this.store.own<Account>(user, 'account', m.accountId);
            const b = await body(req);
            if (b.label !== undefined)
                m.label = str(b.label, 'Nome', 200);
            if (b.enabled !== undefined) {
                assert(typeof b.enabled === 'boolean', 400, 'MODEL', 'Stato modello non valido.');
                m.enabled = b.enabled;
                m.archived = !b.enabled;
            }
            if (b.contextWindow !== undefined)
                m.contextWindow = integer(b.contextWindow, 16384, 4096, 2000000);
            if (b.capabilities !== undefined) {
                m.capabilities = textList(b.capabilities);
                assert(m.capabilities.every(x => ['chat', 'tools', 'embedding', 'vision'].includes(x)), 400, 'CAPABILITY', 'Capacità non valida.');
                m.capabilitySource = 'operator';
                m.capabilitiesOverridden = true;
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

        if (segments[1] === 'models' && segments.length === 3 && method === 'DELETE') {
            operator(user);
            const m = this.store.require<ModelRoute>('model', key);
            this.store.own<Account>(user, 'account', m.accountId);
            this.store.put('model', { ...m, enabled: false, archived: true });
            this.changed(user);
            json(res, 200, { ok: true });
            return;
        }

        if (pathname === '/api/artifacts' && method === 'POST') {
            const b = await body(req);
            const a = this.knowledge.addArtifact(user, str(b.projectId, 'Progetto'), str(b.name, 'Nome', 200), str(b.content, 'Contenuto', 1048576, true));
            this.changed(user, a.projectId);
            this.indexLocalSources(user,a.projectId);
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
            const sources = b.sourceIds === undefined ? [] : textList(b.sourceIds, 32);
            const m = this.knowledge.addMemory(user, str(b.projectId, 'Progetto'), { title: str(b.title, 'Titolo', 200), content: str(b.content, 'Contenuto', 100000), kind: b.kind as Memory['kind'], scope: b.scope as Memory['scope'] | undefined, sourceIds: sources });
            this.changed(user, m.projectId);
            json(res, 201, m);
            return;
        }

        if (pathname === '/api/memories/search' && method === 'POST') {
            const b = await body(req), project = this.store.projectFor(user, str(b.projectId, 'Progetto')), query = str(b.query, 'Ricerca', 12000);
            const options = project.routes.embedding ? { embed: this.catalog.embedder(user, project.routes.embedding), modelKey: project.routes.embedding, signal: this.shutdown.signal } : {};
            const found = await this.knowledge.retrieve(user, project.id, query, options);
            const visible = new Map(this.knowledge.visibleMemory(user, project.id).map(m => [m.id, m]));
            const seen = new Set<string>();
            json(res, 200, { results: found.flatMap(r => {
                if (seen.has(r.id) || !visible.has(r.id)) return [];
                seen.add(r.id);
                return [{ memory: visible.get(r.id), score: r.score, method: r.method, citation: r.citation }];
            }) });
            return;
        }

        if (segments[1] === 'memories' && segments.length === 3 && method === 'PATCH') {
            const b = await body(req);
            const previous = this.store.get<Memory>('memory', key);
            const m = this.knowledge.updateMemory(user, key, b);
            if(m.status==='approved') this.indexLocalSources(user,m.projectId);
            this.changed(user, m.projectId);
            if ((previous?.scope === 'project' && previous.status === 'approved') || (m.scope === 'project' && m.status === 'approved')) this.changedSharedMemory(user, m.projectId);
            json(res, 200, m);
            return;
        }

        if (segments[1] === 'memories' && segments.length === 3 && method === 'DELETE') {
            const previous = this.store.get<Memory>('memory', key);
            this.knowledge.forget(user, key);
            this.changed(user);
            if (previous?.scope === 'project' && previous.status === 'approved') this.changedSharedMemory(user, previous.projectId);
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
        if (b.targetId !== undefined || b.workspace !== undefined || b.workspaceIsolation !== undefined || b.verifyRecipeIds !== undefined || b.deploymentRecipeId !== undefined) {
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
            if (b.workspaceIsolation !== undefined) {
                assert(b.workspaceIsolation === 'git-worktree' || b.workspaceIsolation === 'shared', 400, 'INVALID', 'Modalità workspace non valida.');
                p.workspaceIsolation = b.workspaceIsolation;
            }
            assert(p.workspaceIsolation !== 'git-worktree' || target?.kind === 'local', 400, 'WORKTREE_TARGET', 'I worktree gestiti richiedono un target Git locale.');
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
        if (['/', '/index.html', '/control', '/control/', '/control/index.html', '/cockpit', '/cockpit/classic'].includes(pathname)) {
            const controlHtml = path.resolve(this.staticDir, pathname === '/cockpit/classic' ? '../classic/index.html' : pathname === '/cockpit' ? 'cockpit.html' : 'index.html');
            if (existsSync(controlHtml)) {
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'X-Content-Type-Options': 'nosniff',
                    'Content-Security-Policy': pathname === '/cockpit/classic' ? historicCsp : webCsp
                });
                res.end(method === 'HEAD' ? undefined : readFileSync(controlHtml));
                return;
            }
        }

        // Control Room Web Assets
        const files: Record<string, [string, string]> = {
            '/static/style.css': ['../classic/style.css', 'text/css; charset=utf-8'],
            '/static/app.js': ['../classic/app.js', 'text/javascript; charset=utf-8'],
            '/static/assets/strix_halo_dual_cluster.jpg': ['../classic/assets/strix_halo_dual_cluster.jpg', 'image/jpeg'],
            '/static/assets/strix_halo_die_schematic.jpg': ['../classic/assets/strix_halo_die_schematic.jpg', 'image/jpeg'],
            '/assets/cockpit.js': ['cockpit.js', 'text/javascript; charset=utf-8'],
            '/assets/cockpit.css': ['cockpit.css', 'text/css; charset=utf-8'],
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
                'Content-Security-Policy': webCsp
            });
            res.end(method === 'HEAD' ? undefined : readFileSync(target));
            return;
        }

        throw new AppError(404, 'NOT_FOUND', 'Risorsa non trovata.');
    }

    async apiFacade(req: IncomingMessage, res: ServerResponse, user: User, pathname: string): Promise<void> {
        assert(req.headers.authorization?.startsWith('Bearer '), 401, 'AUTH', 'Le API compatibili richiedono Bearer.');
        if (pathname === '/v1/models' && req.method === 'GET') {
            const models = this.catalog.models(user).filter(m=>m.enabled), aliases=aliasRoutes(this.config,models);
            const data = models.map(m => ({ id: m.id, object: 'model', owned_by: m.providerId, name: m.label,
                underlying_model: m.model, context_length: m.contextWindow, aliases:[...aliases].filter(([,routes])=>routes.some(r=>r.id===m.id)).map(([name])=>name),
                endpoints:['codex','antigravity'].includes(this.store.require<Provider>('provider',m.providerId).kind)
                    ? ['conversation'] : ['conversation','chat/completions','responses'] }));
            json(res,200,{object:'list',data});
            return;
        }
        const responses = pathname === '/v1/responses';
        assert((responses || pathname === '/v1/chat/completions') && req.method === 'POST', 404, 'NOT_FOUND', 'Endpoint non supportato.');
        assert(user.role !== 'viewer', 403, 'FORBIDDEN', 'Profilo lettore.');
        const input = await body(req), b: Record<string, unknown> = responses ? fromResponses(input) : input;
        const selected = str(b.model, 'Modello'), available = this.catalog.models(user);
        let route = available.find(m => m.id === selected);
        if (!route) {
            const matches = aliasRoutes(this.config, available).get(selected) ?? available.filter(m => m.model === selected && m.enabled);
            assert(matches.length <= 1, 400, 'AMBIGUOUS_MODEL', 'Più account offrono questo modello. Usa l’ID della rotta restituito da /v1/models.');
            route = matches[0];
        }
        assert(route, 404, 'MODEL', 'Modello non trovato.');
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
        const tools = b.tools === undefined ? [] : (() => { assert(Array.isArray(b.tools) && b.tools.length <= (responses ? 128 : 32), 400, 'TOOLS', 'Tool non validi.'); return b.tools.map(raw => { const t = object(raw); assert(t.type === 'function', 400, 'TOOLS', 'Sono supportati function tools.'); const fn = object(t.function); return { name: str(fn.name, 'Nome tool', 200), description: fn.description === undefined ? '' : str(fn.description, 'Descrizione tool', responses ? 100000 : 4000, true), parameters: object(fn.parameters) }; }); })();
        assert(JSON.stringify({ messages, tools }).length <= 500000, 413, 'SIZE', 'Contesto troppo grande.');
        const controller = new AbortController();
        res.once('close', () => controller.abort());
        const signal = AbortSignal.any([controller.signal, this.shutdown.signal, AbortSignal.timeout(10 * 60000)]);
        const preferences = routingPreferences(user, this.catalog, b.routing, { strategy: 'pinned', fallbackRouteIds: [] });
        let remaining = [...new Set([route.id,...(preferences.strategy==='auto' ? preferences.fallbackRouteIds : [])])];
        const requestId = id('chatcmpl'), waitUntil = Date.now() + (preferences.maxWaitMs ?? 8000);
        while (remaining.length) {
            const lease = await new RouteRouter(this.catalog).reserve({ user, preferredRouteId: remaining[0], strategy: preferences.strategy,
                alternativeRouteIds: remaining.slice(1), purpose: 'chat', requiredCapabilities: tools.length ? ['tools'] : [],
                nativeAllowed: false, priority: 'interactive', maxWaitMs: Math.max(0,waitUntil-Date.now()), signal });
            const resolved = lease; const route = lease.route;
            const release = lease.release;
            res.setHeader('X-Yed1z-Route', route.id);
            res.setHeader('X-Yed1z-Queue-Ms', String(lease.waitMs));
            let streamed = false, receivedText = false, inferenceStarted = false;
            const begin = () => { if (!streamed) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
                streamed = true;
            } };
            const chunk = (value: unknown) => { begin(); res.write('data: ' + JSON.stringify(value) + '\n\n'); };
            const responseOutput = responses ? new ResponsesOutput(route.id, event => {
                begin(); res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
            }) : undefined;
            if (responseOutput) responseOutput.names = b.names as ResponsesOutput['names'];
            const tStart = Date.now();
            this.inFlightCount++;
            try {
                await this.catalog.activate(route.providerId, signal);
                inferenceStarted = true;
                const result = await this.orchestrator.completion({ connection: resolved.connection, model: { id: route.model, contextWindow: route.contextWindow, maxOutputTokens: integer(b.max_completion_tokens ?? b.max_tokens, route.maxOutputTokens ?? 4096, 1, 32000) }, secret: resolved.secret, messages, tools, signal, onText: text => { receivedText ||= Boolean(text); if (b.stream === true && responseOutput) responseOutput.text(text); else if (b.stream === true)
                        chunk({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }); } });
                this.catalog.succeeded(resolved.account, result.quota);
                const toolCalls = result.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
                const usage = result.usage ? { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens, total_tokens: result.usage.inputTokens + result.usage.outputTokens } : undefined;
                const finish = toolCalls.length ? 'tool_calls' : result.finishReason ?? 'stop';

                this.store.db.prepare('INSERT INTO inference_usage(id,owner,route,account,input_tokens,output_tokens,total_ms,ttft_ms,decode_tps,prefill_tps,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
                    requestId, user.id, route.id, route.accountId, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
                    Date.now() - tStart, result.metrics.ttftMs ?? null, result.metrics.decodeTokensPerSecond ?? null, result.metrics.prefillTokensPerSecond ?? null, now());

                if (responseOutput) {
                    const response = responseOutput.finish(result,b.stream === true);
                    if (b.stream === true) res.end(); else json(res,200,response);
                    return;
                }
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
                if (details.status === 429 && inferenceStarted)
                    this.catalog.quota(resolved.account, { ...details.quota, observedAt:details.quota?.observedAt ?? now(), source:details.quota?.source ?? 'provider-headers', state:'limited' });
                else if (details.quota) this.catalog.quota(resolved.account, details.quota);
                if (details.status === 429 && inferenceStarted && !receivedText && !streamed && remaining.length > 1 && !signal.aborted) {
                    remaining=remaining.filter(routeId=>routeId!==route.id);
                    this.store.emit({ownerId:user.id,type:'routing.quota_fallback',data:{requestId,routeId:route.id}});
                    continue;
                }
                const status = details.status && details.status >= 400 && details.status <= 599 ? details.status : 502;
                if (streamed && responseOutput) {
                    responseOutput.fail(safeError(error)); res.end();
                } else if (streamed) {
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
            return;
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
        void this.refreshEngines();
        this.timer = setInterval(() => {
            void this.refreshEngines();
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


        return (this.server.address() as { port: number }).port;
    }

    async close(): Promise<void> {
        clearInterval(this.timer);
        if (this.loadTimer) clearInterval(this.loadTimer);
        this.shutdown.abort();
        await Promise.allSettled([...this.indexing.values()].map(job=>job.done));
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
