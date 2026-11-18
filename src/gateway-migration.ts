import { readFileSync, statSync } from 'node:fs';
import type { User } from './contracts.ts';
import { Store } from './store.ts';
import { AppError, assert, hash, now } from './util.ts';

type Data = Record<string, unknown>;
interface Options {
    store: Store;
    keysPath?: string;
    ownersPath?: string;
    statsPath?: string;
    usageOwnerId?: string;
    apply?: boolean;
}
interface KeyReceipt { id: string; ownerId: string; sourceOwner: string; importedAt: string; }
interface UsageReceipt {
    id: string;
    ownerId: string;
    source: 'legacy-gateway-stats';
    quality: 'legacy-reported';
    sourceDigest: string;
    importedAt: string;
    totals: Record<string, number>;
    days: Record<string, Record<string, number>>;
}

function object(value: unknown): Data {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), 400, 'GATEWAY_IMPORT', 'Formato JSON dell’importazione non valido.');
    return value as Data;
}

function read(path: string, kind: 'chiavi' | 'proprietari' | 'statistiche'): { data: Data; digest: string } {
    try {
        const file = statSync(path);
        assert(file.isFile() && file.size <= 16 * 1024 * 1024, 400, 'GATEWAY_IMPORT', 'File di importazione non valido.');
        const raw = readFileSync(path, 'utf8');
        return { data: object(JSON.parse(raw)), digest: hash(raw) };
    } catch {
        // Parser errors can include snippets of the input, including credentials.
        throw new AppError(400, 'GATEWAY_IMPORT', `File ${kind} non leggibile o non valido.`);
    }
}

function token(value: unknown): string {
    const key = typeof value === 'string' ? value.trim() : '';
    assert(/^[a-zA-Z0-9_-]{1,1024}$/.test(key), 400, 'GATEWAY_IMPORT', 'L’archivio contiene una chiave incompatibile con il formato Bearer.');
    return key;
}

/** The original token-to-user table and the later user-to-key records had different shapes. */
function assignments(data: Data): Map<string, string | undefined> {
    const keys = new Map<string, string | undefined>();
    if (data.keys !== undefined) {
        assert(Array.isArray(data.keys), 400, 'GATEWAY_IMPORT', 'Lista delle chiavi legacy non valida.');
        for (const value of data.keys) keys.set(hash(token(value)), undefined);
    }
    const owners = data.users === undefined
        ? Object.fromEntries(Object.entries(data).filter(([field]) => field !== 'keys' && field !== 'ip_map'))
        : object(data.users);
    const add = (value: unknown, owner: string): void => {
        assert(owner.trim().length > 0 && owner.length <= 200 && !/[\x00-\x1f\x7f]/.test(owner), 400, 'GATEWAY_IMPORT', 'Proprietario legacy non valido.');
        const digest = hash(token(value)), existing = keys.get(digest);
        assert(!existing || existing === owner, 409, 'GATEWAY_IMPORT_CONFLICT', 'L’archivio assegna una chiave a più proprietari.');
        keys.set(digest, owner);
    };
    for (const [key, entry] of Object.entries(owners)) {
        if (typeof entry === 'string') add(key, entry);
        else {
            const account = object(entry);
            if (account.key !== undefined) add(account.key, key);
            if (account.keys !== undefined) {
                assert(Array.isArray(account.keys), 400, 'GATEWAY_IMPORT', 'Lista delle chiavi di un proprietario non valida.');
                for (const value of account.keys) add(value, key);
            }
        }
    }
    return keys;
}

function counts(data: unknown, fields: string[]): Record<string, number> {
    const source = data === undefined ? {} : object(data);
    return Object.fromEntries(fields.flatMap(field => Number.isSafeInteger(source[field]) && Number(source[field]) >= 0
        ? [[field, Number(source[field])]] : []));
}

function usage(data: Data): Pick<UsageReceipt, 'totals' | 'days'> {
    const totals = counts(data.totals, ['total_tokens', 'total_requests', 'deepseek_tokens', 'qwen_tokens']);
    const daily = object(data.daily_tokens ?? {});
    const days = Object.fromEntries(Object.keys(daily).sort().flatMap(day => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
        const date = new Date(day + 'T00:00:00Z');
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return [];
        const values = counts(daily[day], ['total', 'deepseek', 'qwen']);
        return Object.keys(values).length ? [[day, values]] : [];
    }));
    return { totals, days };
}

export function importGateway(options: Options) {
    const { store, keysPath, ownersPath, statsPath, usageOwnerId, apply = false } = options;
    assert(keysPath || statsPath, 400, 'GATEWAY_IMPORT', 'Indica il file chiavi e/o il file statistiche da importare.');
    assert(Boolean(keysPath) === Boolean(ownersPath), 400, 'GATEWAY_IMPORT', 'Per le chiavi serve un file proprietari con nome legacy esatto e ID utente yed1z.');
    assert(Boolean(statsPath) === Boolean(usageOwnerId), 400, 'GATEWAY_IMPORT', 'Per le statistiche serve l’ID dell’amministratore che conserva l’archivio privato.');
    const keys = keysPath && ownersPath ? assignments(read(keysPath, 'chiavi').data) : new Map<string, string | undefined>();
    const owners = ownersPath ? read(ownersPath, 'proprietari').data : {};
    const principals = new Map(store.all<User>('user').map(user => [user.id, user]));
    const mapped = new Map<string, string>();
    const targets = new Set<string>();
    for (const [legacy, target] of Object.entries(owners)) {
        assert(typeof target === 'string' && principals.has(target) && !targets.has(target), 400, 'GATEWAY_IMPORT', 'Ogni proprietario legacy deve avere un ID utente yed1z esistente e distinto.');
        mapped.set(legacy, target);
        targets.add(target);
    }
    const stats = statsPath ? read(statsPath, 'statistiche') : undefined;
    const usageOwner = usageOwnerId ? principals.get(usageOwnerId) : undefined;
    assert(!usageOwnerId || usageOwner?.role === 'admin', 400, 'GATEWAY_IMPORT', 'Lo storico aggregato deve essere assegnato a un amministratore esistente.');
    const importedUsage = stats && usageOwner ? usage(stats.data) : undefined;
    return store.transaction(() => {
        const byOwner = new Map<string, { imported: number; existing: number; revoked: number }>();
        let unmapped = 0;
        const find = store.db.prepare('SELECT user_id,kind FROM auth WHERE hash=?');
        const insert = store.db.prepare("INSERT INTO auth (hash,user_id,kind,expires) VALUES (?,?,'key',NULL)");
        for (const [digest, legacy] of keys) {
            const ownerId = legacy === undefined ? undefined : mapped.get(legacy);
            if (!legacy || !ownerId) { unmapped++; continue; }
            const tally = byOwner.get(legacy) ?? { imported: 0, existing: 0, revoked: 0 };
            byOwner.set(legacy, tally);
            const existing = find.get(digest);
            const id = 'legacy_gateway_auth_' + digest;
            const receipt = store.get<KeyReceipt>('legacy-gateway-key', id);
            assert(!existing || (existing.kind === 'key' && existing.user_id === ownerId), 409, 'GATEWAY_IMPORT_CONFLICT', 'Una chiave appartiene già a un’identità o sessione diversa.');
            assert(!receipt || receipt.ownerId === ownerId, 409, 'GATEWAY_IMPORT_CONFLICT', 'Una precedente importazione assegna una chiave a un altro utente.');
            if (existing) tally.existing++;
            else if (receipt) tally.revoked++;
            else {
                tally.imported++;
                if (apply) insert.run(digest, ownerId);
            }
            if (apply && !receipt) store.put<KeyReceipt>('legacy-gateway-key', { id, ownerId, sourceOwner: legacy, importedAt: now() });
        }
        let historicalUsage;
        if (stats && usageOwner && importedUsage) {
            const id = 'legacy_gateway_usage_' + hash(usageOwner.id + '\0' + JSON.stringify(importedUsage));
            const existing = !!store.get<UsageReceipt>('legacy-gateway-usage', id);
            historicalUsage = { days: Object.keys(importedUsage.days).length, action: existing ? 'existing' : apply ? 'imported' : 'planned' };
            if (apply && !existing) store.put<UsageReceipt>('legacy-gateway-usage', {
                id, ownerId: usageOwner.id, source: 'legacy-gateway-stats', quality: 'legacy-reported', sourceDigest: stats.digest, importedAt: now(), ...importedUsage
            });
        }
        return { applied: apply, keys: { byOwner: Object.fromEntries(byOwner), unmapped }, ...(historicalUsage ? { historicalUsage } : {}) };
    });
}
