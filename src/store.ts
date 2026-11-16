import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Approval, Conversation, Project, Run, RunEvent, User } from './contracts.ts';
import { AppError, hash, id, now } from './util.ts';
type Entity = {
    id: string;
    ownerId?: string;
    projectId?: string;
};
export class Store {
    db: DatabaseSync;
    directory: string;
    events = new EventEmitter();
    key: Buffer;
    lock?: string;
    constructor(directory: string, options: {
        lock?: boolean;
    } = {}) {
        this.directory = path.resolve(directory);
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        chmodSync(this.directory, 0o700);
        if (options.lock !== false) {
            this.lock = path.join(this.directory, 'coordinator.lock');
            if (existsSync(this.lock)) {
                const pid = Number(readFileSync(this.lock, 'utf8'));
                let active = true;
                try {
                    process.kill(pid, 0);
                }
                catch (e) {
                    active = (e as NodeJS.ErrnoException).code !== 'ESRCH';
                }
                if (active)
                    throw new AppError(409, 'LOCKED', 'Un coordinator usa già questa directory di stato.');
                rmSync(this.lock);
            }
            const fd = openSync(this.lock, 'wx', 0o600);
            writeFileSync(fd, String(process.pid));
            closeSync(fd);
        }
        const keyPath = path.join(this.directory, 'master.key');
        if (!existsSync(keyPath))
            writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
        chmodSync(keyPath, 0o600);
        this.key = readFileSync(keyPath);
        if (this.key.length !== 32)
            throw new Error('Invalid master.key');
        const dbPath = path.join(this.directory, 'control.sqlite');
        this.db = new DatabaseSync(dbPath);
        chmodSync(dbPath, 0o600);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT,project TEXT,data TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind,owner,project);
      CREATE TABLE IF NOT EXISTS auth(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,expires INTEGER);
      CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,encrypted TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,project TEXT,run TEXT,data TEXT NOT NULL,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_owner ON events(owner,id);
      CREATE TABLE IF NOT EXISTS memory_versions(id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,document TEXT NOT NULL,content TEXT NOT NULL,model TEXT,vector TEXT);
      CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED,document UNINDEXED,content,tokenize='unicode61');
      PRAGMA user_version=1;`);
        this.events.setMaxListeners(300);
    }
    put<T extends Entity>(kind: string, value: T): T { this.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,owner=excluded.owner,project=excluded.project,data=excluded.data,updated=excluded.updated').run(value.id, kind, value.ownerId ?? null, value.projectId ?? null, JSON.stringify(value), now()); return structuredClone(value); }
    get<T>(kind: string, key: string): T | undefined { const row = this.db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, key); return row ? JSON.parse(String(row.data)) as T : undefined; }
    require<T>(kind: string, key: string): T { const value = this.get<T>(kind, key); if (!value)
        throw new AppError(404, 'NOT_FOUND', 'Elemento non trovato.'); return value; }
    all<T>(kind: string): T[] { return this.db.prepare('SELECT data FROM entities WHERE kind=? ORDER BY updated DESC').all(kind).map(r => JSON.parse(String(r.data)) as T); }
    remove(kind: string, key: string): void { this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, key); }
    transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try {
        const out = fn();
        this.db.exec('COMMIT');
        return out;
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    } }
    createUser(name: string, role: User['role']): {
        user: User;
        token: string;
    } { const user: User = { id: id('usr'), name, role, createdAt: now() }; const token = randomBytes(32).toString('base64url'); this.transaction(() => { this.put('user', user); this.db.prepare('INSERT INTO auth VALUES (?,?,?,NULL)').run(hash(token), user.id, 'key'); }); return { user, token }; }
    authenticate(token: string, kind?: 'key' | 'session'): User | undefined { if (token.length > 1024)
        return; const row = this.db.prepare('SELECT user_id,kind,expires FROM auth WHERE hash=?').get(hash(token)); if (!row || (kind && row.kind !== kind) || (row.expires !== null && Number(row.expires) < Date.now()))
        return; return this.get<User>('user', String(row.user_id)); }
    session(user: User): string { const token = randomBytes(32).toString('base64url'); this.db.prepare('INSERT INTO auth VALUES (?,?,?,?)').run(hash(token), user.id, 'session', Date.now() + 12 * 60 * 60 * 1000); this.db.prepare('DELETE FROM auth WHERE expires IS NOT NULL AND expires<?').run(Date.now()); return token; }
    logout(token: string): void { this.db.prepare('DELETE FROM auth WHERE hash=? AND kind=?').run(hash(token), 'session'); }
    setSecret(key: string, value: string): void { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); this.db.prepare('INSERT OR REPLACE INTO secrets VALUES (?,?)').run(key, Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')); }
    secret(key: string): string | undefined { const row = this.db.prepare('SELECT encrypted FROM secrets WHERE id=?').get(key); if (!row)
        return; const data = Buffer.from(String(row.encrypted), 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'); }
    emit(event: Omit<RunEvent, 'id' | 'createdAt'>): RunEvent { const createdAt = now(); const value = { ...event, createdAt }; const result = this.db.prepare('INSERT INTO events(owner,project,run,data,created) VALUES (?,?,?,?,?)').run(event.ownerId, event.projectId ?? null, event.runId ?? null, JSON.stringify(value), createdAt); const out = { ...value, id: Number(result.lastInsertRowid) }; this.events.emit('event', out); return out; }
    replay(owner: string, after = 0, limit = 500): RunEvent[] { return this.db.prepare('SELECT id,data FROM events WHERE owner=? AND id>? ORDER BY id LIMIT ?').all(owner, after, limit).map(r => ({ ...JSON.parse(String(r.data)), id: Number(r.id) })); }
    projectFor(user: User, key: string): Project { const p = this.require<Project>('project', key); if (p.ownerId !== user.id && !p.memberIds.includes(user.id) && user.role !== 'admin')
        throw new AppError(404, 'NOT_FOUND', 'Progetto non trovato.'); return p; }
    own<T extends Entity>(user: User, kind: string, key: string): T { const x = this.require<T>(kind, key); if (x.ownerId !== user.id)
        throw new AppError(404, 'NOT_FOUND', 'Elemento non trovato.'); if (x.projectId)
        this.projectFor(user, x.projectId); return x; }
    recover(): number {
        let count = 0;
        this.transaction(() => {
            for (const run of this.all<Run>('run'))
                if (['queued', 'planning', 'executing', 'reviewing', 'verifying', 'deploying'].includes(run.status)) {
                    run.status = 'interrupted';
                    run.phase = 'Coordinator riavviato: controllare evidenze prima di riprendere';
                    run.updatedAt = now();
                    for (const task of run.tasks)
                        if (task.status === 'running') {
                            task.status = 'blocked';
                            task.error = 'Esito interrotto: nessun replay automatico.';
                        }
                    this.put('run', run);
                    count++;
                    const c = this.get<Conversation>('conversation', run.conversationId);
                    if (c) {
                        for (const m of c.messages)
                            if (m.status === 'streaming')
                                m.status = 'error';
                        this.put('conversation', c);
                    }
                }
            for (const a of this.all<Approval>('approval'))
                if (a.status === 'pending') {
                    a.status = 'expired';
                    this.put('approval', a);
                }
        });
        return count;
    }
    async backup(destination: string): Promise<void> { await backup(this.db, destination); chmodSync(destination, 0o600); }
    close(): void { this.db.close(); if (this.lock)
        rmSync(this.lock, { force: true }); this.events.removeAllListeners(); }
}
