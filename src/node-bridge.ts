import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { pinnedFetch } from './adapters/http-utils.ts';
import { collectLocalTelemetry } from './adapters/local-telemetry.ts';

const openAI = new Map([['/v1/models','GET'],['/v1/chat/completions','POST'],['/v1/embeddings','POST'],['/v1/responses','POST']]);
const ollama = new Map([['/api/tags','GET'],['/api/show','POST'],['/api/chat','POST'],['/api/embed','POST']]);
const digest = (input: string) => createHash('sha256').update(input).digest();

export function createNodeBridge(options: { upstream: string; token: string; upstreamToken?: string; kind: 'openai' | 'ollama' }) {
    if (!['openai', 'ollama'].includes(options.kind)) throw new Error('Protocollo nodo non valido.');
    const upstream = new URL(options.upstream);
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash)
        throw new Error('Usa la base HTTP del motore, senza credenziali o query.');
    if (options.token.length < 24) throw new Error('La chiave del nodo deve avere almeno 24 caratteri.');
    const expected = digest('Bearer ' + options.token);
    const routes = options.kind === 'openai' ? openAI : ollama;
    return createServer(async (req, res) => {
        const fail = (status: number, message: string) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: message })); };
        if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ''))) { fail(401, 'Chiave del nodo richiesta.'); return; }
        if (req.method === 'GET' && req.url === '/health') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok: true, kind: options.kind })); return; }
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]);
        try {
            if (req.method === 'GET' && req.url === '/telemetry') {
                const telemetry = await collectLocalTelemetry(signal);
                res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(telemetry)); return;
            }
            const route = req.url ?? '';
            if (routes.get(route) !== req.method || !routes.has(route)) { fail(404, 'Endpoint non disponibile.'); return; }
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const part of req) {
                bytes += part.length;
                if (bytes > 7 * 1024 * 1024) { fail(413, 'Richiesta troppo grande.'); return; }
                chunks.push(Buffer.from(part));
            }
            const url = new URL(upstream);
            url.pathname = upstream.pathname.replace(/\/(?:v1|api)\/?$/, '').replace(/\/$/, '') + route;
            const response = await pinnedFetch(url, { method: req.method, signal,
                headers: { 'content-type': 'application/json', ...(options.upstreamToken ? { authorization: 'Bearer ' + options.upstreamToken } : {}) },
                ...(req.method === 'POST' ? { body: Buffer.concat(chunks).toString('utf8') } : {}) });
            const headers: Record<string,string> = { 'Cache-Control': 'no-store' };
            for (const name of ['content-type', 'retry-after', 'x-ratelimit-remaining-requests', 'ratelimit-remaining']) {
                const v = response.headers.get(name); if (v !== null) headers[name] = v;
            }
            res.writeHead(response.status, headers);
            if (response.body) await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), res, { signal });
            else res.end();
        } catch {
            if (!res.headersSent && !res.destroyed) fail(502, 'Motore del nodo irraggiungibile o risposta interrotta.');
            else if (!res.destroyed) res.destroy();
        }
    });
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    const bind = process.env.YED1Z_NODE_BIND ?? '127.0.0.1', port = Number(process.env.YED1Z_NODE_PORT ?? 8181);
    const server = createNodeBridge({ upstream: process.env.YED1Z_NODE_UPSTREAM ?? 'http://127.0.0.1:8080/v1',
        kind: (process.env.YED1Z_NODE_KIND ?? 'openai') as 'openai' | 'ollama',
        token: process.env.YED1Z_NODE_TOKEN ?? '', upstreamToken: process.env.YED1Z_ENGINE_TOKEN });
    server.listen(port, bind, () => process.stdout.write('Adapter di inferenza in ascolto su ' + bind + ':' + port + '\n'));
}
