import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Artifact, KnowledgePassage, KnowledgeSearchResult, KnowledgeSource, Memory, Project, User } from './contracts.ts';
import { querySlots, readSemanticSlots, selectMemoryPassages, type ReaderPassage, type SemanticSignal, type VectorPassage } from './knowledge-reader.ts';
import { Store } from './store.ts';
import { AppError, assert, hash, id, now, str } from './util.ts';
export type Retrieved = Omit<KnowledgePassage, 'citation' | 'signals'> & Partial<Pick<KnowledgePassage, 'citation' | 'signals'>>;
export interface EmbeddingFunction {
    (texts: string[], signal: AbortSignal): Promise<number[][]>;
}
export function chunks(text: string, size = 1800, overlap = 180): string[] { const out: string[] = []; for (let start = 0; start < text.length; start += size - overlap)
    out.push(text.slice(start, start + size)); return out; }
const MAX_SCANNED_PASSAGES = 8192;
const CHUNK_STEP = 1620;
interface SearchOptions {
    embed?: EmbeddingFunction;
    modelKey?: string;
    signal?: AbortSignal;
    limit?: number;
    maxChars?: number;
}
interface IndexedDocument extends KnowledgeSource { ownerId: string; relatedSources: ReadonlySet<string>; }
interface ChunkRow { id: string; document: string; content: string; }
function* batches<T>(values: T[], count: number): Iterable<T[]> {
    for (let start = 0; start < values.length; start += count) yield values.slice(start, start + count);
}

export class Knowledge {
    store: Store;
    blobDir: string;
    private readonly activeReindex = new Set<string>();
    constructor(store: Store) {
        this.store = store;
        this.blobDir = path.join(store.directory, 'artifacts');
        mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
        this.store.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_vectors (
            chunk TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
            encoder TEXT NOT NULL,
            vector TEXT NOT NULL,
            PRIMARY KEY (chunk,encoder)
        )`);
    }
    visibleMemories(user: User, projects: ReadonlySet<string>): Memory[] {
        for (const projectId of projects) this.store.projectFor(user, projectId);
        const entries = this.store.all<Memory>('memory').filter(m => projects.has(m.projectId) && (m.ownerId === user.id || (m.scope === 'project' && m.status === 'approved')));
        const publicSources = new Set(entries.filter(m => m.scope === 'project' && m.status === 'approved').map(m => m.id));
        return entries.map(memory => memory.ownerId === user.id ? memory : { ...memory, sourceIds: (memory.sourceIds ?? []).filter(source => publicSources.has(source)) });
    }
    visibleMemory(user: User, projectId: string): Memory[] {
        return this.visibleMemories(user, new Set([projectId]));
    }
    artifacts(user: User, projectId: string): Artifact[] { this.store.projectFor(user, projectId); return this.store.all<Artifact>('artifact').filter(a => a.projectId === projectId && a.ownerId === user.id); }
    artifact(user: User, key: string): {
        artifact: Artifact;
        content: string;
    } { const a = this.ownSource<Artifact>(user, 'artifact', key); assert(/^[a-f0-9]{64}$/.test(a.sha256), 500, 'INTEGRITY', 'Hash allegato non valido.'); const content = readFileSync(path.join(this.blobDir, a.sha256), 'utf8'); assert(hash(content) === a.sha256, 500, 'INTEGRITY', 'Integrità allegato non valida.'); return { artifact: a, content }; }
    private ownSource<T extends Memory | Artifact>(user: User, kind: 'memory' | 'artifact', id: string): T {
        assert(this.store.db.prepare('SELECT 1 FROM entities WHERE id=? AND kind=? AND owner=?').get(id, kind, user.id), 404, 'NOT_FOUND', 'Fonte non disponibile.');
        return this.store.own<T>(user, kind, id);
    }
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
    removeArtifact(user: User, key: string): void { const a = this.ownSource<Artifact>(user, 'artifact', key); this.store.transaction(() => { this.store.remove('artifact', key); this.unindex(key); }); if (!this.store.all<Artifact>('artifact').some(other => other.sha256 === a.sha256))
        rmSync(path.join(this.blobDir, a.sha256), { force: true }); }
    addMemory(user: User, projectId: string, input: Pick<Memory, 'title' | 'content' | 'kind'> & Partial<Pick<Memory, 'scope' | 'sourceIds'>>): Memory {
        this.store.projectFor(user, projectId);
        str(input.title, 'Titolo', 200);
        str(input.content, 'Memoria', 100000);
        assert(['method', 'decision', 'brief', 'document'].includes(input.kind), 400, 'INVALID', 'Tipo memoria non valido.');
        assert(input.scope === undefined || input.scope === 'private' || input.scope === 'project', 400, 'INVALID', 'Scope non valido.');
        const sourceIds = [...new Set(input.sourceIds ?? [])];
        assert(sourceIds.length <= 32, 400, 'SOURCE', 'La memoria può indicare fino a 32 fonti.');
        const ownedSource = this.store.db.prepare("SELECT 1 FROM entities WHERE id=? AND owner=? AND project=? AND kind IN ('artifact','memory','run','conversation')");
        for (const source of sourceIds) assert(ownedSource.get(source, user.id, projectId), 400, 'SOURCE', 'Fonte memoria non accessibile.');
        const count = this.store.all<Memory>('memory').filter(m => m.ownerId === user.id).length;
        assert(count < 2000, 413, 'STORAGE', 'Limite memorie raggiunto.');
        const m: Memory = { id: id('mem'), projectId, ownerId: user.id, title: input.title, content: input.content, kind: input.kind, scope: 'private', status: 'candidate', revision: 1, sourceIds, createdAt: now(), updatedAt: now() };
        if (input.scope === 'project') {
            const p = this.store.projectFor(user, projectId);
            assert(p.ownerId === user.id || ['admin', 'operator'].includes(user.role), 403, 'FORBIDDEN', 'Pubblicazione di memoria condivisa riservata al responsabile.');
            m.scope = 'project';
        }
        this.store.transaction(() => { this.store.put('memory', m); this.store.db.prepare('INSERT INTO memory_versions VALUES (?,?,?)').run(m.id, m.revision, JSON.stringify(m)); });
        return m;
    }
    updateMemory(user: User, key: string, input: Partial<Pick<Memory, 'title' | 'content' | 'scope' | 'status'>>): Memory {
        const m = this.ownSource<Memory>(user, 'memory', key);
        const p = this.store.projectFor(user, m.projectId);
        const previousContent = m.content;
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
        if (m.scope === 'project' && m.status === 'approved' && previousContent !== m.content && input.status === undefined) m.status = 'candidate';
        if (m.scope === 'project' && m.status === 'approved') assert(p.ownerId === user.id || ['admin', 'operator'].includes(user.role), 403, 'FORBIDDEN', 'Pubblicazione di memoria condivisa riservata al responsabile.');
        m.revision++;
        m.updatedAt = now();
        if (m.status !== 'approved' || previousContent !== m.content) m.indexed = false;
        this.store.transaction(() => {
            this.store.put('memory', m);
            this.store.db.prepare('INSERT INTO memory_versions VALUES (?,?,?)').run(m.id, m.revision, JSON.stringify(m));
            if (m.status === 'approved') this.index(m.id, m.content);
            else this.unindex(m.id);
        });
        return m;
    }
    forget(user: User, key: string): void { this.ownSource<Memory>(user, 'memory', key); this.store.transaction(() => { this.store.remove('memory', key); this.store.db.prepare('DELETE FROM memory_versions WHERE id=?').run(key); this.unindex(key); }); }
    index(document: string, text: string): void {
        const previous = new Map(this.store.db.prepare('SELECT id,content FROM chunks WHERE document=?').all(document).map(row => [String(row.id), String(row.content)]));
        const erase = (id: string) => {
            this.store.db.prepare('DELETE FROM chunks WHERE id=?').run(id);
            this.store.db.prepare('DELETE FROM chunks_fts WHERE id=?').run(id);
        };
        const insert = this.store.db.prepare('INSERT INTO chunks VALUES (?,?,?,NULL,NULL)');
        const insertFts = this.store.db.prepare('INSERT INTO chunks_fts VALUES (?,?,?)');
        for (const [position, content] of chunks(text).entries()) {
            const id = `${document}:${position}`;
            if (previous.get(id) !== content) {
                if (previous.has(id)) erase(id);
                insert.run(id, document, content);
                insertFts.run(id, document, content);
            }
            previous.delete(id);
        }
        for (const id of previous.keys()) erase(id);
    }
    unindex(document: string): void { this.store.db.prepare('DELETE FROM chunks WHERE document=?').run(document); this.store.db.prepare('DELETE FROM chunks_fts WHERE document=?').run(document); }
    private documents(user: User, projectId: string): Map<string, IndexedDocument> {
        const documents = new Map<string, IndexedDocument>();
        for (const memory of this.visibleMemory(user, projectId)) if (memory.status === 'approved') documents.set(memory.id, {
            id: memory.id, title: memory.title, kind: 'memory', scope: memory.scope, revision: memory.revision,
            sourceHash: hash(memory.content), ownerId: memory.ownerId, relatedSources: new Set(memory.sourceIds),
        });
        for (const artifact of this.artifacts(user, projectId)) documents.set(artifact.id, {
            id: artifact.id, title: artifact.name, kind: 'attachment', scope: 'private', sourceHash: artifact.sha256,
            ownerId: artifact.ownerId, relatedSources: new Set(),
        });
        return documents;
    }
    source(user: User, projectId: string, id: string, expected: { revision?: number; sourceHash?: string } = {}): { source: KnowledgeSource; content: string } {
        const document = this.documents(user, projectId).get(id);
        assert(document, 404, 'NOT_FOUND', 'Fonte non disponibile nel progetto.');
        assert(expected.revision === undefined || expected.revision === document.revision, 409, 'SOURCE_CHANGED', 'La fonte è stata aggiornata dopo la ricerca.');
        assert(!expected.sourceHash || expected.sourceHash === document.sourceHash, 409, 'SOURCE_CHANGED', 'La fonte è stata aggiornata dopo la ricerca.');
        const { ownerId, relatedSources, ...source } = document;
        const content = document.kind === 'memory' ? this.store.require<Memory>('memory', id).content : this.artifact(user, id).content;
        return { source, content };
    }
    private chunkRows(documentIds: string[], maximum = Number.MAX_SAFE_INTEGER): ChunkRow[] {
        const rows: ChunkRow[] = [];
        for (const batch of batches(documentIds.sort(), 400)) {
            const scoped = this.store.db.prepare('SELECT id,document,content FROM chunks WHERE document IN (' + batch.map(() => '?').join(',') + ') ORDER BY document,id LIMIT ?');
            for (const row of scoped.iterate(...batch, maximum - rows.length)) {
                rows.push({ id: String(row.id), document: String(row.document), content: String(row.content) });
            }
            if (rows.length >= maximum) break;
        }
        return rows;
    }
    private *vectorRows(ids: string[], modelKey: string): Generator<VectorPassage> {
        for (const batch of batches(ids, 400)) {
            const rows = this.store.db.prepare('SELECT c.id,coalesce(v.vector,CASE WHEN c.model=? THEN c.vector END) AS vector FROM chunks c LEFT JOIN knowledge_vectors v ON c.id=v.chunk AND v.encoder=? WHERE c.id IN (' + batch.map(() => '?').join(',') + ') ORDER BY c.id');
            for (const row of rows.iterate(modelKey, modelKey, ...batch)) if (typeof row.vector === 'string') {
                const vector = storedVector(row.vector);
                if (vector) yield { id: String(row.id), vector };
            }
        }
    }
    async search(user: User, projectId: string, query: string, options: SearchOptions = {}): Promise<KnowledgeSearchResult> {
        options.signal?.throwIfAborted();
        let documents = this.documents(user, projectId);
        let rows = this.chunkRows([...documents.keys()], MAX_SCANNED_PASSAGES + 1);
        const limit = Math.max(1, Math.min(24, options.limit ?? 8));
        const maxChars = Math.max(128, Math.min(12000, options.maxChars ?? 6400));
        let embeddingStatus: KnowledgeSearchResult['report']['embeddingStatus'] = 'not-configured';
        let semantic = new Map<string, SemanticSignal>();
        if (options.embed && options.modelKey) {
            embeddingStatus = 'not-indexed';
            const modelKey = options.modelKey;
            const first = this.vectorRows(rows.slice(0, MAX_SCANNED_PASSAGES).map(row => row.id), modelKey);
            const hasVectors = !first.next().done;
            first.return(undefined);
            if (hasVectors) {
                try {
                    const queries = querySlots(query);
                    const deadline = AbortSignal.timeout(4000);
                    const embeddings = await options.embed(queries, options.signal ? AbortSignal.any([options.signal, deadline]) : deadline);
                    assert(embeddings.length === queries.length, 502, 'EMBEDDING', 'Numero embeddings non valido.');
                    for (const embedding of embeddings) validateVector(embedding);
                    options.signal?.throwIfAborted();
                    // A withdrawal or edit may have happened while the encoder was working.
                    documents = this.documents(user, projectId);
                    rows = this.chunkRows([...documents.keys()], MAX_SCANNED_PASSAGES + 1);
                    semantic = readSemanticSlots(embeddings, () => this.vectorRows(rows.slice(0, MAX_SCANNED_PASSAGES).map(row => row.id), modelKey));
                    embeddingStatus = semantic.size ? 'used' : 'incompatible';
                } catch {
                    options.signal?.throwIfAborted();
                    documents = this.documents(user, projectId);
                    rows = this.chunkRows([...documents.keys()], MAX_SCANNED_PASSAGES + 1);
                    embeddingStatus = 'unavailable';
                }
            }
        }
        const passages: ReaderPassage[] = rows.slice(0, MAX_SCANNED_PASSAGES).map(row => {
            const source = documents.get(row.document)!;
            return { id: row.id, sourceId: row.document, position: Number(row.id.slice(row.document.length + 1)), title: source.title, text: row.content, relatedSources: source.relatedSources };
        });
        const { selections, considered } = selectMemoryPassages(passages, query, semantic, limit, maxChars);
        const results = selections.map<KnowledgePassage>((selection) => {
            const { passage, text, score, method, semantic, matchingTerms, relatedTo } = selection;
            const source = documents.get(passage.sourceId)!;
            const start = passage.position * CHUNK_STEP + selection.start;
            return {
                id: source.id, title: source.title, kind: source.kind, text, method, score,
                citation: { sourceId: source.id, passageId: passage.id, scope: source.scope, revision: source.revision,
                    sourceHash: source.sourceHash, excerptHash: hash(text), start, end: start + text.length },
                signals: { matchingTerms, ...(semantic ? { semanticSimilarity: semantic.similarity, semanticAlignment: semantic.alignment, slots: semantic.slots } : {}), ...(relatedTo ? { relatedTo } : {}) },
            };
        });
        return { results, report: {
            mode: semantic.size ? 'hybrid' : 'lexical', scannedPassages: passages.length, scannedSources: new Set(passages.map(passage => passage.sourceId)).size,
            consideredPassages: considered, usedChars: results.reduce((bytes, passage) => bytes + passage.text.length, 0),
            maxChars, truncated: rows.length > MAX_SCANNED_PASSAGES || considered > selections.length, embeddingStatus,
        } };
    }
    async retrieve(user: User, projectId: string, query: string, options: SearchOptions = {}): Promise<Retrieved[]> {
        return (await this.search(user, projectId, query, options)).results;
    }
    async reindex(user: User, project: Project, modelKey: string, embed: EmbeddingFunction, signal: AbortSignal, force = false): Promise<{
        indexed: number;
        skipped: number;
        reused: number;
    }> {
        const key = JSON.stringify([user.id, project.id, modelKey]);
        assert(!this.activeReindex.has(key), 409, 'REINDEX_BUSY', 'Indice in aggiornamento per questo account e modello.');
        this.activeReindex.add(key);
        try { return await this.rebuildVectors(user, project, modelKey, embed, signal, force); }
        finally { this.activeReindex.delete(key); }
    }
    private async rebuildVectors(user: User, project: Project, modelKey: string, embed: EmbeddingFunction, signal: AbortSignal, force: boolean) {
        signal.throwIfAborted();
        const owned = () => [...this.documents(user, project.id).values()].filter(document => document.ownerId === user.id);
        const docs = owned();
        let indexed = 0, skipped = 0;
        const rows = this.chunkRows(docs.map(document => document.id));
        const cached = new Set(force ? [] : Array.from(this.vectorRows(rows.map(row => row.id), modelKey), row => row.id));
        const pending = rows.filter(row => !cached.has(row.id));
        const reused = cached.size;
        const saveVector = this.store.db.prepare('INSERT INTO knowledge_vectors(chunk,encoder,vector) VALUES (?,?,?) ON CONFLICT(chunk,encoder) DO UPDATE SET vector=excluded.vector');
        const currentChunk = this.store.db.prepare('SELECT content FROM chunks WHERE id=?');
        const sourceState = this.store.db.prepare('SELECT kind,data FROM entities WHERE id=? AND owner=? AND project=?');
        const canIndex = (row: ChunkRow) => {
            const source = sourceState.get(row.document, user.id, project.id);
            const approved = source?.kind === 'memory' && (JSON.parse(String(source.data)) as Memory).status === 'approved';
            return (source?.kind === 'artifact' || approved) && currentChunk.get(row.id)?.content === row.content;
        };
        for (const batch of batches(pending, 16)) {
            signal.throwIfAborted();
            this.store.projectFor(user, project.id);
            const valid = batch.filter(canIndex);
            skipped += batch.length - valid.length;
            if (!valid.length) continue;
            const vectors = await embed(valid.map(row => row.content), signal);
            signal.throwIfAborted();
            assert(vectors.length === valid.length, 502, 'EMBEDDING', 'Numero embeddings non valido.');
            for (const vector of vectors)
                validateVector(vector);
            assert(vectors.every(v => v.length === vectors[0].length), 502, 'EMBEDDING', 'Dimensioni embeddings inconsistenti.');
            this.store.projectFor(user, project.id);
            this.store.transaction(() => {
                for (const [index, row] of valid.entries()) {
                    if (!canIndex(row)) { skipped++; continue; }
                    saveVector.run(row.id, modelKey, JSON.stringify(vectors[index]));
                    indexed++;
                }
            });
        }
        const status = new Map<string, boolean>();
        const memoryRows = this.chunkRows(owned().filter(document => document.kind === 'memory').map(document => document.id));
        const persisted = new Set(Array.from(this.vectorRows(memoryRows.map(row => row.id), modelKey), row => row.id));
        for (const row of memoryRows) {
            status.set(row.document, status.get(row.document) !== false && persisted.has(row.id));
        }
        for (const [id, indexed] of status) {
            const memory = this.store.require<Memory>('memory', id);
            if (memory.indexed !== indexed) this.store.put('memory', { ...memory, indexed });
        }
        return { indexed, skipped, reused };
    }
}
export function validateVector(vector: unknown): asserts vector is number[] { assert(Array.isArray(vector) && vector.length > 0 && vector.length <= 32768 && vector.every(n => typeof n === 'number' && Number.isFinite(n)), 502, 'EMBEDDING', 'Vettore embedding non valido.'); }
function storedVector(raw: string): number[] | undefined {
    try { const vector: unknown = JSON.parse(raw); validateVector(vector); return vector; }
    catch { return undefined; }
}
