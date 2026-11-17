import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import type { ApprovalRequest, ExternalRequest } from '../core/types.ts';
import { runtimeEnvironment } from '../environment.ts';

type ObjectValue = Record<string, unknown>;
type RpcId = string | number;

export interface BackendOptions {
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
}

interface ProcessOptions {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  requestTimeoutMs: number;
  /** Codex app-server omits the JSON-RPC version field; ACP requires it. */
  omitJsonRpcVersion?: boolean;
  onNotification: (method: string, params: ObjectValue) => void;
  onRequest: (method: string, params: ObjectValue) => Promise<unknown>;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export function record(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectValue : {};
}

export function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function cancelled(): Error {
  const error = new Error('Operation cancelled.');
  error.name = 'AbortError';
  return error;
}

export class RpcMethodError extends Error {
  readonly code: number;
  constructor(message: string, code = -32601) {
    super(message);
    this.name = 'RpcMethodError';
    this.code = code;
  }
}

/** Wire errors deliberately exclude raw error data and stderr, which can contain credentials. */
export class RpcRemoteError extends Error {
  readonly code: number;
  readonly category: string;
  constructor(label: string, method: string, value: unknown) {
    const error = record(value);
    const category = string(record(error.data).type);
    const knownCategory = category === 'modelProviderMismatch' ? category : '';
    const code = typeof error.code === 'number' ? error.code : -32603;
    super(`${label}: ${method} failed (RPC ${code}${knownCategory ? `, ${knownCategory}` : ''}). Check the official CLI's login and configuration.`);
    this.name = 'RpcRemoteError';
    this.code = code;
    this.category = knownCategory;
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Notifications/process exits can arrive before a caller begins awaiting this promise.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export async function bounded<T>(
  operation: Promise<T>, signal: AbortSignal, timeoutMs: number, label: string,
  failure?: Promise<never>,
): Promise<T> {
  if (signal.aborted) throw cancelled();
  let abort!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
  });
  try {
    return await Promise.race(failure ? [operation, guard, failure] : [operation, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** Limit approval lifetime to this run; closing the UI never implies consent. */
export async function approveOnce(request: ExternalRequest, approval: ApprovalRequest): Promise<boolean> {
  if (request.signal.aborted || approval.detail.length > 24_000) return false;
  let abort!: () => void;
  const aborted = new Promise<false>((resolve) => {
    abort = () => resolve(false);
    request.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => request.approve(approval)).then(value => value === true, () => false),
      aborted,
    ]) && !request.signal.aborted;
  } finally {
    request.signal.removeEventListener('abort', abort);
  }
}

/** Approval previews must not expose credential fields returned by an external runtime. */
export function preview(value: unknown): string {
  const text = JSON.stringify(value, (key, entry: unknown) => {
    if (/authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential/i.test(key)) return '[redacted]';
    return entry;
  }, 2) ?? '';
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted]');
}

/** Newline-delimited JSON-RPC transport shared by the official CLI adapters. */
export class JsonRpcProcess {
  readonly failure: Promise<never>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: ProcessOptions;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly rejectFailure: (error: Error) => void;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private stderrTail = Buffer.alloc(0);
  private nextId = 1;
  private terminalError?: Error;
  private disposed = false;
  private killTimer?: ReturnType<typeof setTimeout>;
  private windowsTreeKillStarted = false;
  private static readonly MAX_FRAME_BYTES = 8 * 1024 * 1024;
  private static readonly MAX_STDERR_BYTES = 8192;

  constructor(options: ProcessOptions) {
    this.options = options;
    const failed = deferred<never>();
    this.failure = failed.promise;
    this.rejectFailure = failed.reject;
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: runtimeEnvironment(options.env),
      shell: false,
      windowsHide: true,
      // A separate Unix process group lets cancellation also stop spawned tools.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (data: Buffer) => this.receive(data));
    this.child.stderr.on('data', (data: Buffer) => {
      // Drain stderr to prevent pipe deadlocks. Never log or forward its content.
      this.stderrTail = Buffer.from(Buffer.concat([this.stderrTail, data]).subarray(-JsonRpcProcess.MAX_STDERR_BYTES));
    });
    this.child.stdin.on('error', () => this.fail(new Error(`${options.label}: input stream closed.`)));
    this.child.stdout.on('error', () => this.fail(new Error(`${options.label}: output stream failed.`)));
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      const suffix = error.code === 'ENOENT' ? 'Executable not found. Install the official CLI or configure a native executable path.' : 'Unable to launch the official CLI.';
      this.fail(new Error(`${options.label}: ${suffix}`));
    });
    this.child.on('close', (code, signal) => {
      if (!this.disposed) this.fail(new Error(`${options.label}: runtime exited before completion (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`));
      this.stderrTail = Buffer.alloc(0);
    });
  }

  request<T = unknown>(method: string, params: unknown = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (options.signal?.aborted) return Promise.reject(cancelled());
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(cancelled());
      };
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(new Error(`${this.options.label}: ${method} timed out.`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { method, resolve, reject, cleanup });
      options.signal?.addEventListener('abort', abort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
    return promise as Promise<T>;
  }

  notify(method: string, params: unknown = {}): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new Error(`${this.options.label}: runtime closed.`));
    this.child.stdin.end();
    this.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.kill('SIGKILL'), 800);
    // Keep the worker alive through escalation even if the runtime parent exits
    // first, otherwise a detached tool ignoring SIGTERM could survive cancellation.
    this.stderrTail = Buffer.alloc(0);
  }

  private kill(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal);
      else if (!this.windowsTreeKillStarted) {
        this.windowsTreeKillStarted = true;
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore',
        });
        killer.once('error', () => { try { this.child.kill(); } catch { /* Already exited. */ } });
        killer.unref();
      } else this.child.kill(signal);
    } catch { /* Already exited. */ }
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.rejectFailure(error);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private send(message: ObjectValue): void {
    if (this.terminalError || this.disposed) return;
    if (this.options.omitJsonRpcVersion) delete message.jsonrpc;
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > JsonRpcProcess.MAX_FRAME_BYTES) {
      this.fail(new Error(`${this.options.label}: RPC message exceeded the 8 MiB limit.`));
      return;
    }
    this.child.stdin.write(frame, (error) => {
      if (error) this.fail(new Error(`${this.options.label}: unable to write an RPC message.`));
    });
  }

  private receive(data: Buffer): void {
    if (this.terminalError || this.disposed) return;
    this.buffer += this.decoder.write(data);
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > JsonRpcProcess.MAX_FRAME_BYTES) {
        this.fail(new Error(`${this.options.label}: RPC message exceeded the 8 MiB limit.`));
        return;
      }
      try {
        const message = JSON.parse(line) as unknown;
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid RPC message');
        this.dispatch(message as ObjectValue);
      } catch {
        this.fail(new Error(`${this.options.label}: invalid JSON-RPC output from the official CLI.`));
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > JsonRpcProcess.MAX_FRAME_BYTES) {
      this.fail(new Error(`${this.options.label}: RPC frame exceeded the 8 MiB limit.`));
    }
  }

  private dispatch(message: ObjectValue): void {
    if (typeof message.method === 'string') {
      const params = record(message.params);
      if (typeof message.id === 'string' || typeof message.id === 'number') {
        const id = message.id;
        Promise.resolve().then(() => this.options.onRequest(message.method as string, params)).then(
          result => this.send({ jsonrpc: '2.0', id, result: result ?? {} }),
          error => this.send({ jsonrpc: '2.0', id, error: {
            code: error instanceof RpcMethodError ? error.code : -32603,
            message: error instanceof RpcMethodError ? error.message : 'Client could not handle this request.',
          } }),
        );
      } else {
        this.options.onNotification(message.method, params);
      }
      return;
    }
    if (typeof message.id !== 'number' && typeof message.id !== 'string') throw new Error('Missing RPC id');
    const pending = this.pending.get(message.id);
    // A response can race with timeout/cancellation, in which case it is stale.
    if (!pending) return;
    this.pending.delete(message.id);
    pending.cleanup();
    if ('error' in message) pending.reject(new RpcRemoteError(this.options.label, pending.method, message.error));
    else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error(`${this.options.label}: RPC response contained neither a result nor an error.`));
  }
}
