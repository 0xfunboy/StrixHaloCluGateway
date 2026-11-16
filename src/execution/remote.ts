import { spawn } from 'node:child_process';
import { cleanEnvironment } from './process.ts';
import type { ExecutionApproval, ExecutionRequest, ExecutionResult, ExecutionTarget } from './types.ts';

const MAX_FRAME = 2_000_000;
export class RemoteExecutionUncertainError extends Error {
  readonly code='REMOTE_UNCERTAIN';
  constructor(message:string){super(message);this.name='RemoteExecutionUncertainError';}
}
export function quoteRemote(value: string): string {
  if (!value || value.includes('\0') || /[\r\n]/.test(value) || value.length > 4096) throw new Error('Invalid configured SSH argument.');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
export function sshArguments(target: ExecutionTarget): string[] {
  const host = target.sshHost;
  if (!host || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,250}$/.test(host)) throw new Error('SSH requires a preconfigured host alias, not a URL or shell expression.');
  const port = target.sshPort;
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid configured SSH port.');
  const argv = ['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2'];
  if (port !== undefined) argv.push('-p', String(port));
  const remote = [target.remoteNode ?? 'node',target.remoteRunner ?? '/opt/yed1z/dist/runner.mjs','--config',target.remoteConfig ?? '/etc/yed1z/node.json','--target',target.id].map(quoteRemote).join(' ');
  argv.push('--',host,remote);return argv;
}
/** A one-shot SSH runner; stdin remains open solely for correlated approval replies. */
export async function executeRemote(request: ExecutionRequest): Promise<ExecutionResult> {
  request.signal.throwIfAborted(); const args=sshArguments(request.target);
  return await new Promise((resolve,reject)=>{
    const child=spawn('ssh',args,{shell:false,env:cleanEnvironment(),detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let buffer='', stderr='', settled=false, done:ExecutionResult|undefined, stopping=false,spawned=false;
    const pending=new Set<string>();
    const uncertain=(error:unknown)=>spawned&&['prepare','write','command','deploy'].includes(request.operation.kind)?new RemoteExecutionUncertainError(error instanceof Error?error.message:'Remote execution outcome unknown.'):error;
    const stop=()=>{if(stopping)return;stopping=true;const pid=child.pid;if(pid&&process.platform!=='win32'){try{process.kill(-pid,'SIGTERM');}catch{}const timer=setTimeout(()=>{try{process.kill(-pid,'SIGKILL');}catch{}},500);timer.unref();}else child.kill('SIGKILL');};
    const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();stop();reject(uncertain(error));};
    const onAbort=()=>fail(new Error('Remote execution interrupted. Side effects may have occurred; verify before retrying.'));
    const timer=setTimeout(()=>fail(new Error('Remote runner deadline exceeded. Inspect the workspace before retrying.')),1_800_000);
    const cleanup=()=>{clearTimeout(timer);request.signal.removeEventListener('abort',onAbort);};
    const frame=async(line:string)=>{
      if(!line.trim()||settled)return;
      if(line.length>MAX_FRAME)throw new Error('Remote protocol frame exceeds limit.');
      const data:unknown=JSON.parse(line);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid remote protocol frame.');
      const value=data as Record<string,unknown>;
      if(value.type==='approval'){
        if(typeof value.id!=='string'||value.id.length>200||pending.has(value.id)||pending.size>8)throw new Error('Invalid remote approval correlation.');
        const approval=value.approval as ExecutionApproval;
        if(!approval||!['write','command','deployment'].includes(approval.kind)||typeof approval.detail!=='string'||approval.detail.length>1_200_000||approval.targetId!==request.target.id||approval.workspace!==(request.workspace??'.'))throw new Error('Invalid remote approval request.');
        pending.add(value.id);let allowed=false;
        try{allowed=await request.approve(approval)===true&&!request.signal.aborted;}finally{pending.delete(value.id);}
        if(!settled)child.stdin.write(JSON.stringify({type:'approval',id:value.id,approved:allowed})+'\n');
      }else if(value.type==='event'){
        const event=value.event as {type:'execution';targetId:string;kind:string;message:string};
        if(event&&event.targetId===request.target.id&&typeof event.message==='string')request.onEvent?.(event);
      }else if(value.type==='result'){
        const result=value.result as ExecutionResult;if(!result||typeof result.ok!=='boolean'||typeof result.output!=='string'||!Array.isArray(result.evidence))throw new Error('Invalid remote execution result.');
        done=result;child.stdin.end();
      }else if(value.type==='error')throw new Error(typeof value.error==='string'?value.error.slice(0,1000):'Remote execution failed.');
      else throw new Error('Unexpected remote protocol message.');
    };
    child.stdout.on('data',(chunk:Buffer)=>{
      buffer+=chunk.toString('utf8');if(buffer.length>MAX_FRAME){fail(new Error('Remote protocol frame exceeds limit.'));return;}
      let index:number;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);void frame(line).catch(fail);}
    });
    child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString('utf8')).slice(-3000);});
    child.stdin.on('error',()=>{});child.on('spawn',()=>{spawned=true;});child.on('error',fail);
    child.on('close',code=>{if(settled)return;settled=true;cleanup();if(done&&code===0)resolve(done);else reject(uncertain(new Error(`SSH runner exited ${code ?? 'without status'}${stderr?': '+stderr:''}. Verify target state before retrying.`)));});
    request.signal.addEventListener('abort',onAbort,{once:true});
    child.stdin.write(JSON.stringify({type:'start',workspace:request.workspace??'.',operation:request.operation})+'\n');
    if(request.signal.aborted)onAbort();
  });
}
