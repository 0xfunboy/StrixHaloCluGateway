import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

type Resolver = (hostname: string) => Promise<LookupAddress[]>;
interface TransportOptions {
  /** Injected only by transport tests, never accepted in the worker protocol. */
  resolve?: Resolver;
  /** A test CA; production uses Node's normal verified trust store. */
  ca?: string | Buffer;
}
interface FetchOptions { method?: string; headers?: HeadersInit; body?: string; signal?: AbortSignal; redirect?: 'error'; }

const DENIED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'metadata.tencentyun.com']);
const resolveAll: Resolver = hostname => dnsLookup(hostname, { all: true, verbatim: true });

function ipv4Forbidden(bytes: number[]): boolean {
  const [a, b, c, d] = bytes;
  return a === 0 || a >= 224 || (a === 169 && b === 254)
    || (a === 100 && b === 100 && c === 100 && d === 200);
}
function ipv6Bytes(address: string): number[] {
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const tail = text.slice(text.lastIndexOf(':') + 1).split('.').map(Number);
    text = text.slice(0, text.lastIndexOf(':') + 1) + ((tail[0] << 8) | tail[1]).toString(16) + ':' + ((tail[2] << 8) | tail[3]).toString(16);
  }
  const [left, right] = text.split('::');
  const head = left ? left.split(':') : [], tail = right ? right.split(':') : [];
  const fields = right !== undefined ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  return fields.flatMap(field => { const n = Number.parseInt(field, 16); return [n >> 8, n & 255]; });
}

/** Local/LAN inference is allowed; metadata, link-local and non-unicast targets are not. */
export function assertAllowedAddress(address: string): void {
  const version = isIP(address);
  if (!version || address.includes('%')) throw new Error('Endpoint resolved to an invalid or scoped address.');
  if (version === 4) {
    if (ipv4Forbidden(address.split('.').map(Number))) throw new Error('Endpoint resolved to a reserved metadata or non-unicast address.');
    return;
  }
  const bytes = ipv6Bytes(address);
  const zero = bytes.every(n => n === 0);
  const loopback = bytes.slice(0, 15).every(n => n === 0) && bytes[15] === 1;
  if (loopback) return;
  const mapped = bytes.slice(0, 10).every(n => n === 0) && bytes[10] === 255 && bytes[11] === 255;
  const compatible = bytes.slice(0, 12).every(n => n === 0);
  const translated = bytes.slice(0, 8).every(n => n === 0) && bytes[8] === 255 && bytes[9] === 255 && bytes[10] === 0 && bytes[11] === 0;
  const nat64 = bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every(n => n === 0);
  const awsMetadata = bytes[0] === 0xfd && bytes[1] === 0 && bytes[2] === 0x0e && bytes[3] === 0xc2
    && bytes.slice(4, 14).every(n => n === 0) && bytes[14] === 2 && bytes[15] === 0x54;
  const googleMetadata = bytes[0] === 0xfd && bytes[1] === 0x20 && bytes[2] === 0 && bytes[3] === 0xce
    && bytes.slice(4, 14).every(n => n === 0) && bytes[14] === 2 && bytes[15] === 0x54;
  if (zero || bytes[0] === 0xff || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80)
    || awsMetadata || googleMetadata || ((mapped || compatible || translated || nat64) && ipv4Forbidden(bytes.slice(12)))) {
    throw new Error('Endpoint resolved to a reserved metadata or non-unicast address.');
  }
}

/** Validation and connection use the same records; there is no second DNS resolution. */
export function pinnedLookup(resolve: Resolver = resolveAll): LookupFunction {
  const cache = new Map<string, Promise<LookupAddress[]>>();
  return (hostname, options, callback) => {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    let pending = cache.get(normalized);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        if (DENIED_HOSTS.has(normalized)) throw new Error('Reserved metadata hostname is not an inference endpoint.');
        const rows = await resolve(hostname);
        if (!rows.length || rows.length > 128) throw new Error('Endpoint DNS returned no usable address set.');
        for (const row of rows) {
          assertAllowedAddress(row.address);
          if (isIP(row.address) !== row.family) throw new Error('Endpoint DNS returned an invalid address family.');
        }
        return rows.map(row => ({ address: row.address, family: row.family }));
      });
      cache.set(normalized, pending);
    }
    void pending.then(rows => {
      const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
      const selected = family ? rows.filter(row => row.family === family) : rows;
      if (!selected.length) throw new Error('Endpoint has no address in the requested family.');
      if (options.all) callback(null, selected);
      else callback(null, selected[0].address, selected[0].family);
    }).catch(error => callback(error instanceof Error ? error : new Error('Endpoint DNS lookup failed.'), '', 0));
  };
}

/** Minimal verified HTTP transport returning the Response interface used by the adapters. */
export function pinnedFetch(input: string | URL, init: FetchOptions = {}, transport: TransportOptions = {}): Promise<Response> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return Promise.reject(new Error('Provider URL must use HTTP(S) without embedded credentials.'));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  try {
    if (DENIED_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ''))) throw new Error('Reserved metadata hostname is not an inference endpoint.');
    if (isIP(hostname)) assertAllowedAddress(hostname);
    init.signal?.throwIfAborted();
  } catch (error) { return Promise.reject(error); }

  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers);
    headers.set('host', url.host);
    headers.set('accept-encoding', 'identity');
    headers.set('connection', 'close');
    headers.delete('transfer-encoding');
    headers.set('content-length', String(Buffer.byteLength(init.body ?? '')));
    const options: RequestOptions = { method: init.method ?? 'GET', headers: Object.fromEntries(headers),
      agent: false, lookup: pinnedLookup(transport.resolve), signal: init.signal,
      ...(url.protocol === 'https:' ? { servername: isIP(hostname) ? undefined : hostname,
        ...(transport.ca ? { ca: transport.ca } : {}), rejectUnauthorized: true } : {}) };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy(); reject(new Error('Provider redirects are not followed. Configure the final inference endpoint.')); return;
      }
      if (status < 200 || status > 599) { response.destroy(); reject(new Error('Provider returned an unsupported HTTP status.')); return; }
      try {
        const responseHeaders = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        let stream: Readable = response;
        const encoding = (responseHeaders.get('content-encoding') ?? 'identity').trim().toLowerCase();
        if (encoding && encoding !== 'identity') {
          const decompressor = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
          if (!decompressor) throw new Error('Provider returned an unsupported content encoding.');
          response.on('error', error => decompressor.destroy(error));
          decompressor.on('close', () => response.destroy());
          stream = response.pipe(decompressor);
          responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
        }
        if (status === 204 || status === 205 || init.method === 'HEAD') {
          response.resume(); resolve(new Response(null, { status, statusText: response.statusMessage, headers: responseHeaders }));
        } else {
          const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
          resolve(new Response(body, { status, statusText: response.statusMessage, headers: responseHeaders }));
        }
      } catch (error) { response.destroy(); reject(error); }
    });
    request.on('error', reject);
    request.end(init.body ?? '');
  });
}
