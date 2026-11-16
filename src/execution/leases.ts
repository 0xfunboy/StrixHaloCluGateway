import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ExecutionTarget } from './types.ts';
interface Lease { machine:string; workspace:string; }
interface Waiter extends Lease { resolve:(release:()=>void)=>void; reject:(reason:unknown)=>void; signal:AbortSignal; onAbort:()=>void; }
const active=new Set<Lease>(),waiters:Waiter[]=[];
const overlaps=(a:Lease,b:Lease)=>a.machine===b.machine&&(a.workspace===b.workspace||a.workspace.startsWith(b.workspace+path.sep)||b.workspace.startsWith(a.workspace+path.sep));
const available=(lease:Lease)=>![...active].some(other=>overlaps(lease,other));
function releaseFor(lease:Lease):()=>void{let released=false;return()=>{if(released)return;released=true;active.delete(lease);pump();};}
function pump():void{
  for(let i=0;i<waiters.length;){const waiter=waiters[i];if(waiter.signal.aborted){waiters.splice(i,1);waiter.signal.removeEventListener('abort',waiter.onAbort);waiter.reject(waiter.signal.reason);continue;}if(!available(waiter)){i++;continue;}waiters.splice(i,1);waiter.signal.removeEventListener('abort',waiter.onAbort);active.add(waiter);waiter.resolve(releaseFor(waiter));}
}
/** Lease one writer per overlapping workspace for an entire mission. Local paths
 * are canonicalized; remote aliases referring to one node must share nodeId. */
export async function acquireWorkspace(target:ExecutionTarget,workspace='.',signal:AbortSignal):Promise<()=>void>{
  signal.throwIfAborted();const root=path.resolve(target.workspaceRoot),resolved=path.resolve(root,workspace);
  if(resolved!==root&&!resolved.startsWith(root+path.sep))throw new Error('Workspace is outside the configured execution root.');
  const lease:Lease={machine:target.kind==='local'?'local':`ssh:${target.nodeId}`,workspace:target.kind==='local'?await realpath(resolved):resolved};signal.throwIfAborted();
  if(available(lease)){active.add(lease);return releaseFor(lease);}
  return await new Promise((resolve,reject)=>{const waiter:Waiter={...lease,resolve,reject,signal,onAbort:()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(signal.reason??new Error('Workspace lease cancelled.'));}};waiters.push(waiter);signal.addEventListener('abort',waiter.onAbort,{once:true});if(signal.aborted)waiter.onAbort();});
}
