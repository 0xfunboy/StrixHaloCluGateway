import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Profile } from './core/types.ts';
import { JsonRpcProcess, RpcMethodError, bounded, deferred, record, string } from './backends/rpc.ts';
import { codexArgs, confirmCodexProfile } from './backends/codex-profile.ts';

type Data = Record<string, unknown>;
const OFFICIAL_LOGIN_HOSTS = new Set(['auth.openai.com', 'auth0.openai.com', 'chatgpt.com']);

function officialUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Codex returned an invalid login URL.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Codex returned an invalid login URL.'); }
  if (url.protocol !== 'https:' || !OFFICIAL_LOGIN_HOSTS.has(url.hostname) || url.username || url.password || url.port || url.hash) {
    throw new Error('Codex login URL is not an allowed official HTTPS endpoint.');
  }
  return url.href;
}

async function privateHome(profile: Profile): Promise<string> {
  const configured = profile.env?.CODEX_HOME;
  if (!configured || !path.isAbsolute(configured)) throw new Error('Device login requires a server-configured absolute CODEX_HOME.');
  let home: string, info;
  try { info = await lstat(configured); home = await realpath(configured); }
  catch { throw new Error('The isolated Codex account directory must exist before login.'); }
  if (!info.isDirectory() || info.isSymbolicLink() || home !== path.resolve(configured)
    || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) {
    throw new Error('The isolated Codex directory must be owned by the worker user, private (0700) and not a symlink.');
  }
  return home;
}

/** Device code is emitted only to the owning live supervisor, never saved as conversation. */
export async function loginCodex(profile: Profile, cwd: string, signal: AbortSignal, requestTimeoutMs: number, turnTimeoutMs: number, onAuth: (event: Data) => void): Promise<Data> {
  const home = await privateHome(profile);
  const completed = deferred<boolean>();
  let loginId = '', succeeded = false;
  const early: Array<{ id: string; success: boolean }> = [];
  const rpc = new JsonRpcProcess({
    label: 'Codex login', command: profile.command || 'codex', args: codexArgs(profile, true),
    cwd, env: profile.env, requestTimeoutMs, omitJsonRpcVersion: true,
    onRequest: async () => { throw new RpcMethodError('Device login does not authorize tools or interactive actions.'); },
    onNotification: (method, params) => {
      if (method !== 'account/login/completed') return;
      const id = string(params.loginId);
      if (!loginId) { if (early.length < 16 && id) early.push({ id, success: params.success === true }); return; }
      if (id === loginId) completed.resolve(params.success === true);
    },
  });
  const run = async () => {
    const initialized = record(await rpc.request('initialize', {
      clientInfo: { name: 'yed1z_harness', title: 'yed1z', version: '0.2.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, { signal }));
    rpc.notify('initialized');
    await confirmCodexProfile(rpc, initialized, home, signal, true);
    const result = record(await rpc.request('account/login/start', { type: 'chatgptDeviceCode' }, { signal }));
    loginId = string(result.loginId);
    if (!loginId || loginId.length > 512 || /[\x00-\x1f\x7f]/.test(loginId)) throw new Error('Codex returned an invalid login identifier.');
    if (result.type !== 'chatgptDeviceCode') throw new Error('This Codex version did not start the requested device login flow.');
    const verification_url = officialUrl(result.verificationUrl);
    const user_code = string(result.userCode);
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(user_code)) throw new Error('Codex returned an invalid device code.');
    onAuth({ type: 'auth', verification_url, user_code, login_id: loginId });
    for (const event of early) if (event.id === loginId) completed.resolve(event.success);
    early.length = 0;
    succeeded = await completed.promise;
    signal.throwIfAborted();
    if (!succeeded) throw new Error('Codex device login did not complete. Retry from the account panel.');
    const account = record(record(await rpc.request('account/read', { refreshToken: false }, { signal })).account);
    if (account.type !== 'chatgpt') throw new Error('Codex reported completion but did not confirm an authenticated ChatGPT account.');
    return { account: { label: profile.name, state: 'authenticated' }, authenticated: true,
      text: 'Codex account connected.', invalidate_sessions: true };
  };
  try {
    return await bounded(run(), signal, Math.min(turnTimeoutMs, 5 * 60_000), 'Codex device login', rpc.failure);
  } finally {
    if (loginId && !succeeded) await rpc.request('account/login/cancel', { loginId }, { timeoutMs: 500 }).catch(() => undefined);
    completed.reject(new Error('Codex login ended.'));
    rpc.dispose();
  }
}
