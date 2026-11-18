import { Workspace, workspaceRoot, workspaceDigest, sha256, MAX_FILE_BYTES } from './workspace.ts';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './process.ts';
import type { CommandRecipe, DeploymentRecipe, ExecutionEvidence, ExecutionRequest, ExecutionResult, ExecutionTarget, WorkspaceRevision } from './types.ts';

function recipe(request: ExecutionRequest, id: string): CommandRecipe {
  const value = request.target.commands.find(item => item.id === id);
  if (!value) throw new Error('Command recipe is not configured for this target.');
  return value;
}
export function recipeDigest(target: ExecutionTarget, kind: 'verify' | 'deploy', recipeId: string): string {
  const command = (key: string) => {
    const value = target.commands.find(item => item.id === key);
    if (!value) throw new Error('Command recipe is not configured for this target.');
    return [value.id, value.argv, value.cwd ?? '.', value.timeoutMs ?? 90000, value.verification === true];
  };
  if (kind === 'verify') return sha256(JSON.stringify([target.id, target.workspaceRoot, command(recipeId)]));
  const deployment = target.deployments?.find(item => item.id === recipeId);
  if (!deployment) throw new Error('Deployment recipe is not configured for this target.');
  const health = deployment.health;
  return sha256(JSON.stringify([target.id, target.workspaceRoot, deployment.id, deployment.verify.map(command), deployment.steps.map(command), deployment.rollback?.map(command) ?? [], health.url, health.expectedStatus ?? 200, health.expectedText, health.timeoutMs ?? 5000, health.attempts ?? 3]));
}
async function runRecipe(request: ExecutionRequest, workspace: Workspace, command: CommandRecipe): Promise<ExecutionResult> {
  const cwd = await workspace.resolve(command.cwd ?? '.');
  request.onEvent?.({ type: 'execution', targetId: request.target.id, kind: command.verification ? 'verify' : 'command', message: command.label });
  const result = await runProcess(command.argv, { cwd, signal: request.signal, timeoutMs: command.timeoutMs });
  return { ok: result.ok, output: result.output, exitCode: result.exitCode, evidence: [{ ...result, output: undefined, kind: command.verification ? 'verification' : 'command', targetId: request.target.id, workspace: request.workspace ?? '.', recipeId: command.id } as ExecutionEvidence] };
}
async function approval(request: ExecutionRequest, kind: 'write' | 'command' | 'deployment', title: string, detail: string): Promise<boolean> {
  request.signal.throwIfAborted();
  const allowed = await request.approve({ kind, title, detail, targetId: request.target.id, workspace: request.workspace ?? '.', digest: sha256(detail) });
  request.signal.throwIfAborted(); return allowed === true;
}
function result(request: ExecutionRequest, startedAt: string, output: string, data?: unknown): ExecutionResult {
  return { ok: true, output, data, evidence: [{ kind: request.operation.kind, targetId: request.target.id, workspace: request.workspace ?? '.', startedAt, finishedAt: new Date().toISOString(), outputSha256: sha256(output) }] };
}
function denied(): ExecutionResult { return { ok: false, denied: true, output: 'Action denied. Do not retry it through another tool or target.', evidence: [] }; }
async function revision(workspace: Workspace): Promise<WorkspaceRevision> {
  const git = await runProcess(['git', 'rev-parse', '--verify', 'HEAD'], { cwd: workspace.root, signal: workspace.signal, timeoutMs: 3000 })
    .catch(() => undefined);
  const gitCommit = git?.ok && /^[0-9a-f]{40,64}$/u.test(git.output.trim()) ? git.output.trim() : undefined;
  const digest = sha256(JSON.stringify([gitCommit, await workspaceDigest(workspace)]));
  return { digest, gitCommit };
}
export async function executeLocal(request: ExecutionRequest): Promise<ExecutionResult> {
  request.signal.throwIfAborted(); const startedAt = new Date().toISOString(), op = request.operation;
  if (op.kind === 'telemetry') {
    const { collectLocalTelemetry } = await import('../adapters/local-telemetry.ts');
    const data = await collectLocalTelemetry(request.signal); return result(request, startedAt, JSON.stringify(data), data);
  }
  if (op.kind === 'prepare') {
    // Only the operator creates workspaceRoot; this operation can create a project beneath it.
    if (!path.isAbsolute(request.target.workspaceRoot)) throw new Error('Configured workspace root must be absolute.');
    const base=await realpath(request.target.workspaceRoot);
    if (!(await lstat(base)).isDirectory()) throw new Error('Configured workspace root must already be a directory.');
    const relative=request.workspace??'.',guard=new Workspace(base,request.signal),destination=await guard.resolve(relative,true);
    let exists=false;
    try { const entry=await lstat(destination);if(!entry.isDirectory())throw new Error('Project workspace is not a directory.');exists=true; }
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(exists)return result(request,startedAt,'Workspace already available.',{targetId:request.target.id,workspace:relative,created:false});
    const detail=`Target: ${request.target.id}\nCreate project workspace: ${relative}\nThe operator-configured parent must already exist.`;
    if(!await approval(request,'write',`Prepare workspace ${relative}`,detail))return denied();
    await guard.resolve(relative,true);await mkdir(destination,{recursive:true,mode:0o700});await guard.resolve(relative);
    return result(request,startedAt,'Project workspace prepared.',{targetId:request.target.id,workspace:relative,created:true});
  }
  const root = await workspaceRoot(request.target.workspaceRoot, request.workspace), workspace = new Workspace(root, request.signal);
  if ((op.kind === 'verify' || op.kind === 'deploy') && op.expectedRecipeDigest && recipeDigest(request.target, op.kind, op.recipeId) !== op.expectedRecipeDigest) {
    return { ok: false, output: 'The recipe installed on the runner differs from the verified definition.', evidence: [] };
  }
  if (op.kind === 'snapshot') {
    const data = await revision(workspace);
    return result(request, startedAt, `Workspace SHA256 ${data.digest}`, data);
  }
  if (op.kind === 'list') { const data = await workspace.list(op.directory); return result(request, startedAt, data.files.join('\n') + (data.truncated ? '\n[bounded listing truncated]' : ''), data); }
  if (op.kind === 'read') {
    const content = await workspace.read(op.path), lines = content.split('\n');
    const start = op.startLine ?? 1, end = op.endLine ?? start + 299;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 2000) throw new Error('Invalid bounded line range.');
    const output = `SHA256 ${sha256(content)} · lines ${start}-${Math.min(end, lines.length)} / ${lines.length}\n` + lines.slice(start-1, end).map((line,index) => `${start+index}: ${line}`).join('\n').slice(0,96_000);
    return result(request, startedAt, output, { sha256: sha256(content), totalLines: lines.length });
  }
  if (op.kind === 'search') {
    if (typeof op.query !== 'string' || !op.query || op.query.length > 2000) throw new Error('Search requires 1–2000 literal characters.');
    const listing = await workspace.list(op.directory), matches: string[] = [];
    for (const file of listing.files) {
      request.signal.throwIfAborted();
      try { for (const [index,line] of (await workspace.read(file)).split('\n').entries()) { if (line.includes(op.query)) matches.push(`${file}:${index+1}: ${line.slice(0,600)}`); if (matches.length >= 100) break; } }
      catch (error) { request.signal.throwIfAborted(); /* Binary/large/unavailable files excluded. */ }
      if (matches.length >= 100) break;
    }
    return result(request, startedAt, matches.join('\n') || 'No matches in the bounded scan.', { matches: matches.length, bounded: true });
  }
  if (op.kind === 'write') {
    if (typeof op.content !== 'string' || Buffer.byteLength(op.content) > MAX_FILE_BYTES || op.content.includes('\0')) throw new Error('Text file exceeds 500 KB or is invalid.');
    await workspace.resolve(op.path, true); let before: string | undefined;
    try { before = await workspace.read(op.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (before !== undefined && op.expectedSha256 === undefined) throw new Error('Modifying an existing file requires expectedSha256 from read_file.');
    if (op.expectedSha256 !== undefined && op.expectedSha256 !== sha256(before ?? '')) throw new Error('File hash changed. Read the current file before editing.');
    if (before === op.content) return result(request, startedAt, 'No change needed.');
    const detail = `Target: ${request.target.id}\nWorkspace: ${request.workspace ?? '.'}\nFile: ${op.path}\n\n--- Before\n${before ?? '(new file)'}\n\n+++ After\n${op.content}`;
    if (!await approval(request, 'write', `Write ${op.path}`, detail)) return denied();
    await workspace.write(op.path, op.content, before);
    return { ...result(request, startedAt, `Saved ${op.path}; SHA256 ${sha256(op.content)}`), changedFiles: [op.path] };
  }
  if (op.kind === 'command' || op.kind === 'verify') {
    const command = recipe(request, op.recipeId);
    if (op.kind === 'verify' && command.verification !== true) throw new Error('This recipe is not an operator-defined verification.');
    if (op.kind === 'command' && !await approval(request, 'command', command.label, `Target: ${request.target.id}\nWorkspace: ${request.workspace ?? '.'}\nRecipe: ${command.id}\nArgv: ${JSON.stringify(command.argv)}\nDirectory: ${command.cwd ?? '.'}`)) return denied();
    return await runRecipe(request, workspace, command);
  }
  if (op.kind === 'deploy') {
    const deployment = request.target.deployments?.find(item => item.id === op.recipeId);
    if (!deployment) throw new Error('Deployment recipe is not configured.');
    return await deploy(request, workspace, deployment, startedAt);
  }
  throw new Error('Unsupported operation.');
}
async function checkHealth(request: ExecutionRequest, deployment: DeploymentRecipe): Promise<{ ok: boolean; status?: number; output: string }> {
  const health = deployment.health, url = new URL(health.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid operator-configured health URL.');
  const attempts = Math.max(1, Math.min(10, health.attempts ?? 3)); let status: number | undefined, detail = '';
  for (let i=0; i<attempts; i++) {
    request.signal.throwIfAborted();
    try {
      const response = await fetch(url, { redirect:'error', signal: AbortSignal.any([request.signal,AbortSignal.timeout(Math.max(100,Math.min(30_000, health.timeoutMs ?? 5000)))]) });
      status = response.status;
      let matches = true;
      if (health.expectedText) {
        if (!response.body) matches = false;
        else {
          const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '', bytes = 0;
          try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1_000_000) throw new Error('Health response too large.'); text += decoder.decode(part.value,{stream:true}); } text += decoder.decode(); matches = text.includes(health.expectedText); }
          finally { await reader.cancel().catch(()=>{}); }
        }
      } else await response.body?.cancel();
      if (status === (health.expectedStatus ?? 200) && matches) return { ok:true,status,output:`Health verified: HTTP ${status}.` };
      detail = `Health mismatch: HTTP ${status}${!matches ? ', expected text absent' : ''}.`;
    } catch (error) { request.signal.throwIfAborted(); detail = `Health check failed: ${error instanceof Error ? error.message : 'request error'}`; }
    if (i+1 < attempts) await new Promise<void>((resolve,reject) => { const timer=setTimeout(done,300); function done(){request.signal.removeEventListener('abort',abort);resolve();} function abort(){clearTimeout(timer);request.signal.removeEventListener('abort',abort);reject(request.signal.reason);} request.signal.addEventListener('abort',abort,{once:true}); });
  }
  return {ok:false,status,output:detail};
}
async function deploy(request: ExecutionRequest, workspace: Workspace, deployment: DeploymentRecipe, startedAt: string): Promise<ExecutionResult> {
  if (!deployment.verify.length || !deployment.steps.length) throw new Error('A deployment requires verification and deployment steps.');
  for (const id of deployment.verify) if (!recipe(request,id).verification) throw new Error('Deployment verification recipes must be explicitly marked verification.');
  for (const id of [...deployment.steps,...deployment.rollback ?? []]) recipe(request,id);
  const evidence: ExecutionEvidence[] = [], output: string[] = [];
  for (const id of deployment.verify) {
    const verified = await runRecipe(request,workspace,recipe(request,id)); evidence.push(...verified.evidence); output.push(`[verify ${id}]\n${verified.output}`);
    if (!verified.ok) return {ok:false,output:output.join('\n'),evidence};
  }
  const expectedDigest = request.operation.kind === 'deploy' ? request.operation.expectedWorkspaceDigest : undefined;
  const detail = `Target: ${request.target.id}\nWorkspace: ${request.workspace ?? '.'}\nRelease: ${deployment.label}\nWorkspace digest: ${expectedDigest ?? 'not specified'}\nVerification passed: ${deployment.verify.join(', ')}\nSteps: ${deployment.steps.map(id=>JSON.stringify(recipe(request,id).argv)).join('\n')}\nHealth: ${deployment.health.url}\nRollback on failure: ${(deployment.rollback ?? []).join(', ') || 'not configured'}`;
  if (expectedDigest && (await revision(workspace)).digest !== expectedDigest) {
    return { ok: false, output: 'Workspace changed after verification. Reverify the new revision before releasing.', evidence };
  }
  if (!await approval(request,'deployment',`Deploy ${deployment.label}`,detail)) return {...denied(),evidence};
  if (expectedDigest && (await revision(workspace)).digest !== expectedDigest) {
    return { ok: false, output: 'Workspace changed during release approval. No deployment step ran.', evidence };
  }
  let ok = true, healthStatus: number | undefined, rollback: ExecutionEvidence['rollback']='not-needed';
  try {
    for (const id of deployment.steps) { const step=await runRecipe(request,workspace,recipe(request,id));evidence.push(...step.evidence);output.push(`[deploy ${id}]\n${step.output}`);if(!step.ok){ok=false;break;} }
    if(ok){ const health=await checkHealth(request,deployment);ok=health.ok;healthStatus=health.status;output.push(health.output); }
  } catch(error) {ok=false;output.push(error instanceof Error?error.message:'Deployment interrupted.');}
  if(!ok){
    rollback=deployment.rollback?.length?'succeeded':'not-configured';
    // Rollback was disclosed in the release grant; use a bounded cleanup signal even if the main task was cancelled.
    const cleanupSignal=AbortSignal.timeout(90_000), cleanup={...request,signal:cleanupSignal};
    for(const id of deployment.rollback ?? []){try{const step=await runRecipe(cleanup,new Workspace(workspace.root,cleanupSignal),recipe(request,id));evidence.push(...step.evidence);output.push(`[rollback ${id}]\n${step.output}`);if(!step.ok)rollback='failed';}catch(error){rollback='failed';output.push(`Rollback error: ${error instanceof Error?error.message:'unknown'}`);}}
  }
  evidence.push({kind:'deployment',targetId:request.target.id,workspace:request.workspace ?? '.',recipeId:deployment.id,startedAt,finishedAt:new Date().toISOString(),healthStatus,healthUrl:deployment.health.url,rollback,cancelled:request.signal.aborted});
  return {ok,output:output.join('\n').slice(-96_000),evidence};
}
