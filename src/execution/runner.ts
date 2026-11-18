import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { executeLocal } from './local.ts';
import type { ExecutionTarget, Operation, ExecutionApproval } from './types.ts';

/** Stateless node entry point. No listening socket, no provider credentials, no model calls. */
export async function startRunner(argv=process.argv.slice(2)):Promise<void>{
  const configIndex=argv.indexOf('--config'),targetIndex=argv.indexOf('--target');
  if(configIndex<0||targetIndex<0||!argv[configIndex+1]||!argv[targetIndex+1])throw new Error('Runner requires --config and --target.');
  const raw=await readFile(argv[configIndex+1],'utf8');if(Buffer.byteLength(raw)>1_000_000)throw new Error('Node configuration exceeds limit.');
  const config=JSON.parse(raw) as {targets?:ExecutionTarget[]};
  const configured=config.targets?.find(target=>target.id===argv[targetIndex+1]);
  if(!configured)throw new Error('Execution target not present in the node configuration.');
  const target:ExecutionTarget={...configured,kind:'local'};
  const controller=new AbortController();let started=false,finished=false;
  const pending=new Map<string,(allowed:boolean)=>void>();
  const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
  const send=(frame:unknown)=>process.stdout.write(JSON.stringify(frame)+'\n');
  const cancel=()=>{controller.abort(new Error('Control-plane connection closed.'));for(const resolve of pending.values())resolve(false);pending.clear();};
  process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
  rl.on('close',()=>{if(!finished)cancel();});
  await new Promise<void>((resolve,reject)=>{
    rl.on('line',(line:string)=>{
      if(finished)return;
      if(Buffer.byteLength(line)>2_000_000){cancel();reject(new Error('Runner frame exceeds limit.'));return;}
      let frame:Record<string,unknown>;try{const value:unknown=JSON.parse(line);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid runner frame.');frame=value as Record<string,unknown>;}catch(error){cancel();reject(error);return;}
      if(frame.type==='approval'&&typeof frame.id==='string'){pending.get(frame.id)?.(frame.approved===true);return;}
      if(frame.type!=='start'||started){cancel();reject(new Error('Expected exactly one start frame.'));return;}
      started=true;
      if(typeof frame.workspace!=='string'||!frame.operation||typeof frame.operation!=='object'){cancel();reject(new Error('Invalid execution request.'));return;}
      const approve=(approval:ExecutionApproval):Promise<boolean>=>new Promise(approvalResolve=>{
        const id=randomUUID();const cleanup=(allowed:boolean)=>{clearTimeout(timer);pending.delete(id);controller.signal.removeEventListener('abort',abort);approvalResolve(allowed&&!controller.signal.aborted);};
        const abort=()=>cleanup(false),timer=setTimeout(()=>cleanup(false),300_000);pending.set(id,cleanup);controller.signal.addEventListener('abort',abort,{once:true});send({type:'approval',id,approval});
      });
      void executeLocal({target,workspace:frame.workspace,operation:frame.operation as Operation,signal:controller.signal,approve,onEvent:event=>send({type:'event',event})}).then(result=>{
        finished=true;send({type:'result',result});rl.close();process.stdin.pause();resolve();
      }).catch(error=>{finished=true;rl.close();process.stdin.pause();reject(error);});
    });
  });
}
