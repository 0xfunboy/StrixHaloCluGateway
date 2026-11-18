import path from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import type { RunWorktree } from '../contracts.ts';
import { AppError, assert, now } from '../util.ts';
import { runProcess } from './process.ts';
import type { ExecutionTarget } from './types.ts';
import { protectedPath, sha256, WORKTREE_DIRECTORY, workspaceRoot } from './workspace.ts';

const GIT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

async function git(cwd: string, args: string[], signal: AbortSignal, input?: string) {
    return runProcess(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=yed1z', '-c', 'user.email=yed1z@localhost', ...args], { cwd, signal, timeoutMs: 60000, input });
}

async function gitOutput(cwd: string, args: string[], signal: AbortSignal, errorCode = 'WORKTREE'): Promise<string> {
    const result = await git(cwd, args, signal);
    signal.throwIfAborted();
    assert(result.ok && !result.truncated, 409, errorCode, result.truncated ? 'Risultato Git troppo grande per questa operazione.' : `Git: ${result.output.trim().slice(-1200)}`);
    return result.output;
}

async function hasPath(file: string): Promise<boolean> {
    try { await lstat(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function repositoryIdentity(directory: string, signal: AbortSignal): Promise<string> {
    const commonDir = (await gitOutput(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim();
    return sha256(await realpath(commonDir));
}

function managedPath(sourceWorkspace = '.', runId: string): string {
    assert(/^run_[a-f0-9]{32}$/u.test(runId), 400, 'WORKTREE', 'Identificatore del worktree non valido.');
    return path.posix.join(sourceWorkspace, '.git', WORKTREE_DIRECTORY, runId);
}

export async function identifyWorktree(target: ExecutionTarget, sourceWorkspace: string | undefined, runId: string, signal: AbortSignal): Promise<RunWorktree> {
    assert(target.kind === 'local', 409, 'WORKTREE_TARGET', 'I worktree gestiti richiedono un target Git locale.');
    const source = await workspaceRoot(target.workspaceRoot, sourceWorkspace);
    const top = (await gitOutput(source, ['rev-parse', '--show-toplevel'], signal)).trim();
    assert(await realpath(top) === source, 409, 'WORKTREE_ROOT', 'Per un worktree usa la radice di un repository Git.');
    const commonDir = (await gitOutput(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim();
    assert(await realpath(commonDir) === path.join(source, '.git'), 409, 'WORKTREE_ROOT', 'Seleziona il checkout Git principale con metadata locali.');
    const baseCommit = (await gitOutput(source, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
    assert(GIT_ID.test(baseCommit), 409, 'WORKTREE_BASE', 'Il repository richiede un commit di partenza.');
    const ref = await git(source, ['symbolic-ref', '--quiet', 'HEAD'], signal);
    const sourceRef = ref.ok && ref.output.trim().startsWith('refs/heads/') ? ref.output.trim() : undefined;
    return { workspace: managedPath(sourceWorkspace, runId), baseCommit, sourceRef, sourceRepository: await repositoryIdentity(source, signal), state: 'preparing', createdAt: now() };
}

export async function ensureWorktree(target: ExecutionTarget, sourceWorkspace: string | undefined, info: RunWorktree, runId: string, signal: AbortSignal): Promise<void> {
    assert(info.workspace === managedPath(sourceWorkspace, runId) && info.state !== 'removed', 409, 'WORKTREE', 'Il worktree della missione non è disponibile.');
    const source = await workspaceRoot(target.workspaceRoot, sourceWorkspace);
    assert(await repositoryIdentity(source, signal) === info.sourceRepository, 409, 'WORKTREE_REPOSITORY', 'Il repository di origine è cambiato.');
    const root = await realpath(target.workspaceRoot);
    const parent = path.dirname(path.join(root, info.workspace));
    await mkdir(parent, { mode: 0o700, recursive: true });
    assert(await realpath(parent) === parent, 409, 'WORKTREE', 'La directory dei worktree deve essere locale e senza collegamenti simbolici.');
    const checkout = path.join(root, info.workspace);
    if (!await hasPath(checkout)) {
        assert(info.state === 'preparing', 409, 'WORKTREE_MISSING', 'Il worktree è stato spostato o rimosso. Recuperalo prima di riprendere.');
        await gitOutput(source, ['worktree', 'add', '--detach', '--', checkout, info.baseCommit], signal);
    }
    assert(await realpath(checkout) === checkout && await repositoryIdentity(checkout, signal) === info.sourceRepository, 409, 'WORKTREE_REPOSITORY', 'Il percorso del worktree non corrisponde al repository di origine.');
}

export async function createCandidate(target: ExecutionTarget, info: RunWorktree, runId: string, signal: AbortSignal): Promise<{ commit: string; ref: string; files: string[]; diff: string; truncated: boolean }> {
    const suffix = managedPath('.', runId);
    assert(info.workspace === suffix || info.workspace.endsWith('/' + suffix), 409, 'WORKTREE', 'Percorso del worktree non valido.');
    const checkout = await workspaceRoot(target.workspaceRoot, info.workspace);
    assert(await repositoryIdentity(checkout, signal) === info.sourceRepository, 409, 'WORKTREE_REPOSITORY', 'Il repository di lavoro è cambiato.');
    const head = (await gitOutput(checkout, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
    const detached = await git(checkout, ['symbolic-ref', '--quiet', 'HEAD'], signal);
    assert(!detached.ok, 409, 'WORKTREE_HEAD', 'Il checkout è passato a un ramo. Consultalo prima di creare una consegna.');
    if (head !== info.baseCommit && head !== info.candidateCommit) {
        // A crash may occur after Git writes the private ref and moves detached HEAD.
        const priorCandidates = (await gitOutput(checkout, ['for-each-ref', '--format=%(objectname)', `refs/yed1z/runs/${runId}/`], signal)).trim().split('\n');
        assert(priorCandidates.includes(head), 409, 'WORKTREE_HEAD', 'Il checkout è passato a un commit esterno. Consultalo prima di creare una consegna.');
    }
    await gitOutput(checkout, ['read-tree', info.baseCommit], signal);
    const edited = (await gitOutput(checkout, ['ls-files', '-m', '-d', '-z'], signal)).split('\0').filter(Boolean);
    const untracked = (await gitOutput(checkout, ['ls-files', '-o', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean);
    assert(edited.every(file => !protectedPath(file)), 409, 'WORKTREE_PROTECTED', 'La modifica contiene file protetti. Riesamina il worktree prima di creare una consegna.');
    const files = [...new Set([...edited, ...untracked.filter(file => !protectedPath(file))])].sort();
    for (let start = 0; start < files.length; start += 50) {
        await gitOutput(checkout, ['--literal-pathspecs', 'add', '-A', '--', ...files.slice(start, start + 50)], signal);
    }
    const tree = (await gitOutput(checkout, ['write-tree'], signal)).trim();
    assert(GIT_ID.test(tree), 409, 'WORKTREE', 'Git non ha restituito un digest valido per la consegna.');
    const ref = `refs/yed1z/runs/${runId}/${tree}`;
    const existing = await git(checkout, ['rev-parse', '--verify', '--quiet', ref], signal);
    const commit = existing.ok ? existing.output.trim() : (await gitOutput(checkout, ['commit-tree', tree, '-p', info.baseCommit, '-m', `yed1z mission ${runId}`], signal)).trim();
    const expectedTree = (await gitOutput(checkout, ['rev-parse', `${commit}^{tree}`], signal)).trim();
    assert(GIT_ID.test(commit) && expectedTree === tree, 409, 'WORKTREE', 'Il riferimento della consegna non corrisponde ai file staged.');
    if (!existing.ok) await gitOutput(checkout, ['update-ref', ref, commit, '0'.repeat(commit.length)], signal);
    if (head !== commit) await gitOutput(checkout, ['update-ref', '--no-deref', 'HEAD', commit, head], signal);
    const diff = await git(checkout, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', info.baseCommit, commit, '--'], signal);
    signal.throwIfAborted();
    assert(diff.ok, 409, 'WORKTREE', 'Git non ha prodotto la revisione del diff.');
    return { commit, ref, files, diff: diff.output, truncated: diff.truncated };
}

export async function promoteCandidate(target: ExecutionTarget, sourceWorkspace: string | undefined, info: RunWorktree, runId: string, signal: AbortSignal): Promise<string> {
    assert(info.candidateCommit && GIT_ID.test(info.candidateCommit) && info.workspace === managedPath(sourceWorkspace, runId), 409, 'WORKTREE', 'Nessun commit candidato per questa missione.');
    const source = await workspaceRoot(target.workspaceRoot, sourceWorkspace);
    assert(await repositoryIdentity(source, signal) === info.sourceRepository, 409, 'WORKTREE_REPOSITORY', 'Il repository di origine è cambiato.');
    const branch = `refs/heads/yed1z/${runId}-${info.candidateCommit.slice(0, 12)}`;
    const prior = await git(source, ['rev-parse', '--verify', '--quiet', branch], signal);
    if (prior.ok) {
        assert(prior.output.trim() === info.candidateCommit, 409, 'WORKTREE_CONFLICT', 'Il branch di consegna esiste già con un commit diverso.');
        return branch;
    }
    const ref = info.sourceRef ?? 'HEAD';
    assert(ref === 'HEAD' || ref.startsWith('refs/heads/'), 409, 'WORKTREE', 'Riferimento Git di origine non valido.');
    const command = `start\nverify ${ref} ${info.baseCommit}\ncreate ${branch} ${info.candidateCommit}\nprepare\ncommit\n`;
    const result = await git(source, ['update-ref', '--stdin'], signal, command);
    signal.throwIfAborted();
    assert(result.ok, 409, 'WORKTREE_DRIFT', 'La base Git è avanzata o il branch di consegna è già occupato. Il checkout di origine non è stato modificato.');
    return branch;
}

export async function promotedSource(target: ExecutionTarget, sourceWorkspace: string | undefined, info: RunWorktree, signal: AbortSignal): Promise<string> {
    assert(info.promotedRef && info.candidateCommit, 409, 'WORKTREE_PROMOTION', 'La consegna Git non è stata promossa.');
    const source = await workspaceRoot(target.workspaceRoot, sourceWorkspace);
    assert(await repositoryIdentity(source, signal) === info.sourceRepository, 409, 'WORKTREE_REPOSITORY', 'Il repository di origine è cambiato.');
    const promoted = await git(source, ['rev-parse', '--verify', '--quiet', info.promotedRef], signal);
    assert(promoted.ok && promoted.output.trim() === info.candidateCommit, 409, 'WORKTREE_PROMOTION', 'Il riferimento promosso non identifica più la consegna.');
    return source;
}

export async function removeWorktree(target: ExecutionTarget, sourceWorkspace: string | undefined, info: RunWorktree, runId: string, signal: AbortSignal): Promise<void> {
    assert(info.workspace === managedPath(sourceWorkspace, runId) && info.promotedRef && info.candidateCommit, 409, 'WORKTREE', 'La pulizia richiede una consegna promossa.');
    const source = await promotedSource(target, sourceWorkspace, info, signal);
    const checkout = path.join(await realpath(target.workspaceRoot), info.workspace);
    if (!await hasPath(checkout)) return;
    assert(await realpath(checkout) === checkout && await repositoryIdentity(checkout, signal) === info.sourceRepository, 409, 'WORKTREE_REPOSITORY', 'Il worktree di lavoro è cambiato.');
    const status = await gitOutput(checkout, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], signal);
    assert(!status.trim(), 409, 'WORKTREE_DIRTY', 'Il worktree contiene modifiche o file aggiuntivi. Rivedili prima della pulizia.');
    await gitOutput(source, ['worktree', 'remove', '--', checkout], signal, 'WORKTREE_DIRTY');
}
