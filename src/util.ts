import { createHash, randomUUID } from 'node:crypto';
export const now = () => new Date().toISOString();
export const id = (prefix = 'id') => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export class AppError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export function assert(condition: unknown, status: number, code: string, message: string): asserts condition { if (!condition)
    throw new AppError(status, code, message); }
export function object(value: unknown): Record<string, unknown> { assert(value && typeof value === 'object' && !Array.isArray(value), 400, 'INVALID', 'Oggetto JSON non valido.'); return value as Record<string, unknown>; }
export function str(value: unknown, name: string, max = 200, empty = false): string { assert(typeof value === 'string' && !value.includes('\0') && value.length <= max && (empty || value.trim().length), 400, 'INVALID', `${name} non valido.`); return value; }
export function integer(value: unknown, fallback: number, min: number, max: number): number { if (value === undefined)
    return fallback; assert(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max, 400, 'INVALID', `Intero richiesto tra ${min} e ${max}.`); return Number(value); }
export function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]').replace(/((?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]').slice(0, 2000); }
export function endpoint(value: unknown): string { const raw = str(value, 'URL', 4000); let url: URL; try {
    url = new URL(raw);
}
catch {
    throw new AppError(400, 'INVALID', 'URL non valido.');
} assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 400, 'INVALID', 'Endpoint HTTP(S) senza credenziali, query o fragment.'); return url.href.replace(/\/$/, ''); }
export function textList(value: unknown, max = 50): string[] { assert(Array.isArray(value) && value.length <= max && value.every(v => typeof v === 'string' && v.length <= 200 && !v.includes('\0')), 400, 'INVALID', 'Elenco non valido.'); return [...new Set(value as string[])]; }
export function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal { return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms); }
