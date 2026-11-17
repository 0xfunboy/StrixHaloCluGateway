import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';

export const MAX_FILE_BYTES = 500_000;
const EXCLUDED = new Set(['.git', 'node_modules', '.venv', 'venv', '.next', 'dist', 'build', '.ssh', '.aws', '.azure', '.gnupg', '.cloudflared', '.codex']);
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export function protectedPath(relative: string): boolean {
  return relative.split(/[\\/]/).some(part => EXCLUDED.has(part) ||
    (/^\.env(?:\.|$)/i.test(part) && !/^\.env\.(?:example|sample|template)$/i.test(part)) ||
    /^(?:id_rsa|id_ed25519|credentials|auth\.json|secrets?\.(?:json|ya?ml|toml))$/i.test(part) || /\.(?:pem|p12|pfx|key)$/i.test(part));
}
export function relativePath(value: string, label = 'path'): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || path.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..') || protectedPath(value)) {
    throw new Error(`Invalid ${label}: it must stay inside the configured workspace and cannot include protected credentials.`);
  }
  return value;
}
export async function workspaceRoot(configuredRoot: string, workspace = '.'): Promise<string> {
  if (!path.isAbsolute(configuredRoot)) throw new Error('The operator must configure an absolute workspace root.');
  relativePath(workspace, 'workspace');
  const root = await realpath(configuredRoot), target = path.resolve(root, workspace);
  const check = new Workspace(root, new AbortController().signal);
  await check.resolve(workspace);
  if (!(await lstat(target)).isDirectory()) throw new Error('Configured workspace is not a directory.');
  return target;
}
export class Workspace {
  readonly root: string;
  readonly signal: AbortSignal;
  constructor(root: string, signal: AbortSignal) { this.root=root; this.signal=signal; }
  async resolve(relative: string, missing = false): Promise<string> {
    this.signal.throwIfAborted(); relativePath(relative);
    const root = await realpath(this.root), target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Path escapes the workspace.');
    let cursor = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symlinks are not allowed in workspace tools.'); }
      catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
    return target;
  }
  async read(relative: string): Promise<string> {
    const target = await this.resolve(relative), handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Only text files up to 500 KB are supported.');
      const value = await handle.readFile('utf8'); if (value.includes('\0')) throw new Error('Binary files are not text context.');
      return value;
    } finally { await handle.close(); }
  }
  async list(directory = '.'): Promise<{ files: string[]; truncated: boolean }> {
    const start = await this.resolve(directory), files: string[] = []; let directories = 0, truncated = false;
    const visit = async (folder: string, depth: number): Promise<void> => {
      this.signal.throwIfAborted();
      if (depth > 12 || directories++ >= 2000 || files.length >= 500) { truncated = true; return; }
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        if (files.length >= 500) { truncated = true; break; }
        const absolute = path.join(folder, entry.name), relative = path.relative(this.root, absolute).split(path.sep).join('/');
        if (entry.isSymbolicLink() || protectedPath(relative)) continue;
        if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(absolute, depth + 1);
        else if (entry.isFile()) files.push(relative);
      }
    };
    await visit(start, 0); return { files, truncated };
  }
  async write(relative: string, after: string, expectedBefore: string | undefined): Promise<void> {
    if (typeof after !== 'string' || after.includes('\0') || Buffer.byteLength(after) > MAX_FILE_BYTES) throw new Error('Invalid text content or file too large.');
    const target = await this.resolve(relative, true);
    let before: string | undefined;
    try { before = await this.read(relative); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (before !== expectedBefore) throw new Error('File changed during approval. Read it again before writing.');
    await mkdir(path.dirname(target), { recursive: true }); await this.resolve(relative, true);
    const flags = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (before === undefined ? constants.O_CREAT | constants.O_EXCL : 0);
    const handle = await open(target, flags, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new Error('Writing non-regular or hard-linked files is not allowed.');
      if (before !== undefined && (stat.size > MAX_FILE_BYTES || await handle.readFile('utf8') !== before)) throw new Error('File changed before the write.');
      const bytes = Buffer.from(after); let offset = 0;
      while (offset < bytes.length) { this.signal.throwIfAborted(); const written = await handle.write(bytes, offset, bytes.length - offset, offset); if (!written.bytesWritten) throw new Error('Incomplete write.'); offset += written.bytesWritten; }
      await handle.truncate(bytes.length); await handle.sync();
    } finally { await handle.close(); }
  }
}
