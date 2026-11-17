import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Artifact, Memory, Project, User } from './contracts.ts';
import { Store } from './store.ts';
import { AppError, assert, hash, id, now, str } from './util.ts';
export interface Retrieved {
    id: string;
    title: string;
    text: string;
    kind: 'memory' | 'attachment';
    score: number;
    method: 'lexical' | 'hybrid' | 'vector';
}
export interface EmbeddingFunction {
    (texts: string[], signal: AbortSignal): Promise<number[][]>;
}
export function chunks(text: string, size = 1800, overlap = 180): string[] { const out: string[] = []; for (let start = 0; start < text.length; start += size - overlap)
    out.push(text.slice(start, start + size)); return out; }
export function cosine(a: number[], b: number[]): number { if (a.length !== b.length || !a.length)
    return 0; let sum = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
} return aa && bb ? sum / Math.sqrt(aa * bb) : 0; }
export class Knowledge {
    store: Store;
    blobDir: string;
    constructor(store: Store) { this.store = store; this.blobDir = path.join(store.directory, 'artifacts'); mkdirSync(this.blobDir, { recursive: true, mode: 0o700 }); }
    visibleMemory(user: User, projectId: string): Memory[] { this.store.projectFor(user, projectId); return this.store.all<Memory>('memory').filter(m => m.projectId === projectId && (m.ownerId === user.id || m.scope === 'project')); }
    artifacts(user: User, projectId: string): Artifact[] { this.store.projectFor(user, projectId); return this.store.all<Artifact>('artifact').filter(a => a.projectId === projectId && a.ownerId === user.id); }
    artifact(user: User, key: string): {
        artifact: Artifact;
        content: string;
    } { const a = this.store.own<Artifact>(user, 'artifact', key); assert(/^[a-f0-9]{64}$/.test(a.sha256), 500, 'INTEGRITY', 'Hash allegato non valido.'); const content = readFileSync(path.join(this.blobDir, a.sha256), 'utf8'); assert(hash(content) === a.sha256, 500, 'INTEGRITY', 'Integrità allegato non valida.'); return { artifact: a, content }; }
    addArtifact(user: User, projectId: string, name: string, content: string, kind: Artifact['kind'] = 'attachment', runId?: string): Artifact {
        this.store.projectFor(user, projectId);
        str(name, 'Nome', 200);
        str(content, 'Contenuto', 1048576, true);
        assert(!/[\x00-\x08\x0e-\x1f]/.test(content), 400, 'BINARY', 'Sono supportati allegati testuali UTF-8.');
        assert(Buffer.byteLength(content) <= 1048576, 413, 'SIZE', 'Allegato oltre 1 MiB.');
        const owned = this.store.all<Artifact>('artifact').filter(a => a.ownerId === user.id);
        assert(owned.length < 1000 && owned.reduce((n, a) => n + a.bytes, 0) + Buffer.byteLength(content) <= 64 * 1024 * 1024, 413, 'STORAGE', 'Limite allegati utente raggiunto (64 MiB).');
        const a: Artifact = { id: id('art'), projectId, ownerId: user.id, name: name.replace(/[\\/\r\n]/g, '_'), mime: 'text/plain; charset=utf-8', bytes: Buffer.byteLength(content), sha256: hash(content), createdAt: now(), kind, ...(runId ? { runId } : {}) };
        try {
            writeFileSync(path.join(this.blobDir, a.sha256), content, { flag: 'wx', mode: 0o600 });
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                throw e;
        }
        this.store.transaction(() => { this.store.put('artifact', a); this.index(a.id, content); });
        return a;
    }
    removeArtifact(user: User, key: string): void { const a = this.store.own<Artifact>(user, 'artifact', key); this.store.transaction(() => { this.store.remove('artifact', key); this.unindex(key); }); if (!this.store.all<Artifact>('artifact').some(other => other.sha256 === a.sha256))
        rmSync(path.join(this.blobDir, a.sha256), { force: true }); }
    addMemory(user: User, projectId: string, input: Pick<Memory, 'title' | 'content' | 'kind'> & Partial<Pick<Memory, 'scope' | 'sourceIds'>>): Memory {
        this.store.projectFor(user, projectId);
        str(input.title, 'Titolo', 200);
        str(input.content, 'Memoria', 100000);
        assert(['method', 'decision', 'brief', 'document'].includes(input.kind), 400, 'INVALID', 'Tipo memoria non valido.');
        const count = this.store.all<Memory>('memory').filter(m => m.ownerId === user.id).length;
        assert(count < 2000, 413, 'STORAGE', 'Limite memorie raggiunto.');
        const m: Memory = { id: id('mem'), projectId, ownerId: user.id, title: input.title, content: input.content, kind: input.kind, scope: 'private', status: 'candidate', revision: 1, sourceIds: input.sourceIds ?? [], createdAt: now(), updatedAt: now() };
        if (input.scope === 'project') {
            const p = this.store.projectFor(user, projectId);
            assert(p.ownerId === user.id || ['admin', 'operator'].includes(user.role), 403, 'FORBIDDEN', 'Pubblicazione di memoria condivisa riservata al responsabile.');
            m.scope = 'project';
        }
        this.store.transaction(() => { this.store.put('memory', m); this.store.db.prepare('INSERT INTO memory_versions VALUES (?,?,?)').run(m.id, m.revision, JSON.stringify(m)); this.index(m.id, m.content); });
        return m;
    }
    updateMemory(user: User, key: string, input: Partial<Pick<Memory, 'title' | 'content' | 'scope' | 'status'>>): Memory {
        const m = this.store.own<Memory>(user, 'memory', key);
        const p = this.store.projectFor(user, m.projectId);
        if (input.title !== undefined)
            m.title = str(input.title, 'Titolo', 200);
        if (input.content !== undefined)
            m.content = str(input.content, 'Memoria', 100000);
        if (input.scope !== undefined) {
            assert(['private', 'project'].includes(input.scope), 400, 'INVALID', 'Scope non valido.');
            if (input.scope === 'project')
                assert(p.ownerId === user.id || ['admin', 'operator'].includes(user.role), 403, 'FORBIDDEN', 'Pubblicazione condivisa riservata al responsabile.');
            m.scope = input.scope;
        }
        if (input.status !== undefined) {
            assert(['candidate', 'approved', 'retired'].includes(input.status), 400, 'INVALID', 'Stato non valido.');
            m.status = input.status;
        }
        m.revision++;
        m.updatedAt = now();
        m.indexed = false;
        this.store.transaction(() => { this.store.put('memory', m); this.store.db.prepare('INSERT INTO memory_versions VALUES (?,?,?)').run(m.id, m.revision, JSON.stringify(m)); this.index(m.id, m.content); });
        return m;
    }
    forget(user: User, key: string): void { this.store.own<Memory>(user, 'memory', key); this.store.transaction(() => { this.store.remove('memory', key); this.store.db.prepare('DELETE FROM memory_versions WHERE id=?').run(key); this.unindex(key); }); }
    index(document: string, text: string): void { this.unindex(document); for (const [i, content] of chunks(text).entries()) {
        const key = `${document}:${i}`;
        this.store.db.prepare('INSERT INTO chunks VALUES (?,?,?,NULL,NULL)').run(key, document, content);
        this.store.db.prepare('INSERT INTO chunks_fts VALUES (?,?,?)').run(key, document, content);
    } }
    unindex(document: string): void { this.store.db.prepare('DELETE FROM chunks WHERE document=?').run(document); this.store.db.prepare('DELETE FROM chunks_fts WHERE document=?').run(document); }
    documents(user: User, projectId: string): Map<string, {
        title: string;
        kind: 'memory' | 'attachment';
    }> { return new Map<string, {
        title: string;
        kind: 'memory' | 'attachment';
    }>([...this.visibleMemory(user, projectId).filter(m => m.status === 'approved').map(m => [m.id, { title: m.title, kind: 'memory' }] as const), ...this.artifacts(user, projectId).map(a => [a.id, { title: a.name, kind: 'attachment' }] as const)]); }
    async retrieve(user: User, projectId: string, query: string, options: {
        embed?: EmbeddingFunction;
        modelKey?: string;
        signal?: AbortSignal;
        limit?: number;
    } = {}): Promise<Retrieved[]> {
        const documents = this.documents(user, projectId);
        if (!documents.size)
            return [];
        const allowed = new Set(documents.keys());
        const candidates = new Map<string, Retrieved>();
        const words = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])].slice(0, 24);
        if (words.length) {
            const match = words.map(w => '"' + w.replaceAll('"', '""') + '"').join(' OR ');
            // SQL ACL applied before ranking/limit: unrelated private records never affect retrieval.
            const ids = [...allowed];
            const rows = this.store.db.prepare(`SELECT c.id,c.document,c.content,bm25(chunks_fts) AS score FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.id WHERE chunks_fts MATCH ? AND c.document IN (${ids.map(() => '?').join(',')}) ORDER BY score LIMIT 80`).all(match, ...ids);
            rows.forEach((row, i) => { const document = String(row.document), meta = documents.get(document)!; candidates.set(String(row.id), { id: document, title: meta.title, text: String(row.content), kind: meta.kind, score: 1 / (20 + i), method: 'lexical' }); });
        }
        if (options.embed && options.modelKey) {
            const [vector] = await options.embed([query], options.signal ?? AbortSignal.timeout(15000));
            validateVector(vector);
            const rows = this.store.db.prepare('SELECT id,document,content,vector FROM chunks WHERE model=? AND vector IS NOT NULL').all(options.modelKey).filter(r => allowed.has(String(r.document)));
            const ranked = rows.map(r => ({ row: r, score: cosine(vector, JSON.parse(String(r.vector))) })).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 80);
            ranked.forEach(({ row }, i) => { const old = candidates.get(String(row.id)); if (old) {
                old.score += 1 / (20 + i);
                old.method = 'hybrid';
            }
            else {
                const document = String(row.document), meta = documents.get(document)!;
                candidates.set(String(row.id), { id: document, title: meta.title, text: String(row.content), kind: meta.kind, score: 1 / (20 + i), method: 'vector' });
            } });
        }
        return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, options.limit ?? 8);
    }
    async reindex(user: User, project: Project, modelKey: string, embed: EmbeddingFunction, signal: AbortSignal): Promise<{
        indexed: number;
        skipped: number;
    }> {
        const allowed = this.documents(user, project.id);
        let indexed = 0, skipped = 0;
        const rows = this.store.db.prepare('SELECT id,document,content,model FROM chunks').all().filter(r => allowed.has(String(r.document)));
        for (let i = 0; i < rows.length; i += 16) {
            signal.throwIfAborted();
            const batch = rows.slice(i, i + 16);
            const vectors = await embed(batch.map(r => String(r.content)), signal);
            assert(vectors.length === batch.length, 502, 'EMBEDDING', 'Numero embeddings non valido.');
            for (const vector of vectors)
                validateVector(vector);
            assert(vectors.every(v => v.length === vectors[0].length), 502, 'EMBEDDING', 'Dimensioni embeddings inconsistenti.');
            this.store.transaction(() => { batch.forEach((r, j) => { const current = this.store.db.prepare('SELECT content FROM chunks WHERE id=?').get(String(r.id)); if (!current || current.content !== r.content) {
                skipped++;
                return;
            } this.store.db.prepare('UPDATE chunks SET model=?,vector=? WHERE id=?').run(modelKey, JSON.stringify(vectors[j]), String(r.id)); indexed++; }); });
        }
        for (const m of this.visibleMemory(user, project.id))
            if (m.ownerId === user.id && m.status === 'approved') {
                m.indexed = true;
                this.store.put('memory', m);
            }
        return { indexed, skipped };
    }
}
export function validateVector(vector: unknown): asserts vector is number[] { assert(Array.isArray(vector) && vector.length > 0 && vector.length <= 32768 && vector.every(n => typeof n === 'number' && Number.isFinite(n)), 502, 'EMBEDDING', 'Vettore embedding non valido.'); }
