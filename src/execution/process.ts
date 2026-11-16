import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const MAX_OUTPUT = 96_000;
export interface ProcessResult {
  ok: boolean; output: string; exitCode: number | null; signal: string | null;
  timedOut: boolean; cancelled: boolean; truncated: boolean; outputSha256: string;
  startedAt: string; finishedAt: string;
}
export function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}
/** No shell; bounded output; kills the complete local process group on timeout/cancel. */
export async function runProcess(argv: string[], options: { cwd?: string; signal: AbortSignal; timeoutMs?: number; input?: string; onData?: (data: string) => void }): Promise<ProcessResult> {
  if (!argv.length || argv.length > 100 || argv.some(v => typeof v !== 'string' || v.length > 16_384 || v.includes('\0')) || !argv[0]) throw new Error('Invalid configured command argv.');
  options.signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 1_800_000) throw new Error('Invalid execution timeout.');
  return await new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, shell: false, env: cleanEnvironment(), windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, timedOut = false, cancelled = false, stopping = false;
    const digest = createHash('sha256');
    const append = (chunk: Buffer) => {
      size += chunk.length; digest.update(chunk); const text = chunk.toString('utf8');
      output = (output + text).slice(-MAX_OUTPUT); options.onData?.(text);
    };
    const stop = () => {
      if (stopping) return; stopping = true;
      const pid = child.pid;
      if (pid && process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* Already exited. */ }
        const escalation = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 500);
        escalation.unref();
      } else child.kill('SIGKILL');
    };
    const onAbort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    options.signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener('abort', onAbort); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.stdin.on('error', () => {});
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, signal) => {
      cleanup(); resolve({ ok: code === 0 && !timedOut && !cancelled, output, exitCode: code, signal, timedOut, cancelled,
        truncated: size > MAX_OUTPUT, outputSha256: digest.digest('hex'), startedAt, finishedAt: new Date().toISOString() });
    });
    child.stdin.end(options.input ?? '');
    if (options.signal.aborted) onAbort();
  });
}
