import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readlink, realpath } from 'node:fs/promises';

export const MAX_FILE_BYTES = 500_000;
export const WORKTREE_DIRECTORY = 'yed1z-worktrees';
const EXCLUDED = new Set(['.git', 'node_modules', '.venv', 'venv', '.next', 'dist', 'build', '.ssh', '.aws', '.azure', '.gnupg', '.cloudflared', '.codex', WORKTREE_DIRECTORY]);
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
  const root = await realpath(configuredRoot), target = path.resolve(root, workspace);
  if (/(?:^|\/)\.git\/yed1z-worktrees\/run_[a-f0-9]{32}$/u.test(workspace)) {
    if (path.isAbsolute(workspace) || workspace.includes('\\') || workspace.split('/').includes('..') || !target.startsWith(root + path.sep)) throw new Error('Managed worktree is outside the configured root.');
    if ((await realpath(target)) !== target) throw new Error('Managed worktree must not use a symlink.');
  } else {
    relativePath(workspace, 'workspace');
    const check = new Workspace(root, new AbortController().signal);
    await check.resolve(workspace);
  }
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

/** Digest source and project files without enumerating credentials, dependencies and build caches. */
export async function workspaceDigest(workspace: Workspace): Promise<string> {
  const manifest = createHash('sha256');
  let entries = 0;
  let bytes = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    workspace.signal.throwIfAborted();
    if (depth > 64) throw new Error('Workspace exceeds the verification snapshot depth limit.');
    await workspace.resolve(path.relative(workspace.root, directory) || '.');
    const children = (await readdir(directory)).sort();
    for (const name of children) {
      const absolute = path.join(directory, name);
      const relative = path.relative(workspace.root, absolute).split(path.sep).join('/');
      if (protectedPath(relative)) continue;
      workspace.signal.throwIfAborted();
      if (++entries > 30_000) throw new Error('Workspace exceeds the verification snapshot entry limit.');
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        manifest.update(JSON.stringify(['directory', relative, info.mode & 0o777]));
        await visit(absolute, depth + 1);
        continue;
      }
      if (info.isSymbolicLink()) {
        manifest.update(JSON.stringify(['symlink', relative, await readlink(absolute)]));
        continue;
      }
      if (!info.isFile()) throw new Error('Workspace contains an unsupported entry for a verification snapshot.');
      bytes += info.size;
      if (bytes > 512 * 1024 * 1024) throw new Error('Workspace exceeds the verification snapshot byte limit.');
      const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Workspace entry changed during verification.');
        const content = createHash('sha256');
        if (info.size > 0) {
          const stream = file.createReadStream({ autoClose: false, signal: workspace.signal, end: info.size - 1 });
          for await (const chunk of stream) content.update(chunk as Buffer);
        }
        const after = await lstat(absolute);
        if (after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.mode !== info.mode) {
          throw new Error('Workspace changed while creating the verification snapshot. Retry the check.');
        }
        manifest.update(JSON.stringify(['file', relative, info.mode & 0o777, content.digest('hex')]));
      } finally {
        await file.close();
      }
    }
  }
  await visit(workspace.root, 0);
  return manifest.digest('hex');
}
