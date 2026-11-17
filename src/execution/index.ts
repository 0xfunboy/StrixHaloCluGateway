import { executeLocal } from './local.ts';
import { executeRemote } from './remote.ts';
import type { ExecutionRequest, ExecutionResult, ExecutionTarget, Operation, ToolCall, ToolDefinition } from './types.ts';
export * from './types.ts';
export { acquireWorkspace } from './leases.ts';
export { sshArguments, quoteRemote, RemoteExecutionUncertainError } from './remote.ts';
export { runProcess } from './process.ts';

export async function execute(request:ExecutionRequest):Promise<ExecutionResult>{
  if(!request.target||!['local','ssh'].includes(request.target.kind))throw new Error('Unknown configured execution target.');
  return request.target.kind==='local'?await executeLocal(request):await executeRemote(request);
}
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const string=(description:string)=>({type:'string',description});
export function agentCommandRecipes(target:ExecutionTarget){
  const protectedIds=new Set((target.deployments??[]).flatMap(recipe=>[...recipe.steps,...recipe.rollback??[]]));
  return target.commands.filter(command=>!command.controllerOnly&&!protectedIds.has(command.id));
}
export function toolDefinitions(target:ExecutionTarget,readOnly=false):ToolDefinition[]{
  const tools:ToolDefinition[]=[
    {name:'list_files',description:'List up to 500 safe text workspace paths. Dependencies, symlinks and credential files are excluded.',parameters:schema({directory:string('Relative directory; defaults to .')})},
    {name:'read_file',description:'Read bounded workspace text with its hash and line numbers.',parameters:schema({path:string('Relative file path'),startLine:{type:'integer',minimum:1},endLine:{type:'integer',minimum:1}},['path'])},
    {name:'search_files',description:'Literal text search in a bounded workspace scan, up to 100 matches.',parameters:schema({query:string('Literal text'),directory:string('Relative directory')},['query'])},
  ];
  if(!readOnly){
    tools.push({name:'write_file',description:'Propose a text file change. Approval and stale-hash checks occur before the write.',parameters:schema({path:string('Relative file path'),content:string('Full new text'),expectedSha256:string('Hash from read_file when modifying existing text')},['path','content'])});
    const commands=agentCommandRecipes(target);
    if(commands.length)tools.push({name:'run_command',description:'Run an operator-defined agent command recipe. Infrastructure, deployment and rollback recipes are reserved for their controllers. No arbitrary shell or arguments are accepted.',parameters:schema({recipeId:{type:'string',enum:commands.map(item=>item.id)}},['recipeId'])});
  }
  return tools;
}
export async function executeTool(call:ToolCall,request:Omit<ExecutionRequest,'operation'>,readOnly=false):Promise<ExecutionResult>{
  if(!toolDefinitions(request.target,readOnly).some(tool=>tool.name===call.name))throw new Error('Tool is unavailable in this task role.');
  const raw=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Tool arguments must be an object.');
  const args=raw as Record<string,unknown>,str=(key:string,optional=false):string|undefined=>{const value=args[key];if(optional&&value===undefined)return undefined;if(typeof value!=='string')throw new Error(`Invalid ${key}.`);return value;};
  let operation:Operation;
  switch(call.name){
    case 'list_files':operation={kind:'list',directory:str('directory',true)};break;
    case 'read_file':operation={kind:'read',path:str('path')!,startLine:args.startLine as number|undefined,endLine:args.endLine as number|undefined};break;
    case 'search_files':operation={kind:'search',query:str('query')!,directory:str('directory',true)};break;
    case 'write_file':operation={kind:'write',path:str('path')!,content:str('content')!,expectedSha256:str('expectedSha256',true)};break;
    case 'run_command':{const recipeId=str('recipeId')!;if(!agentCommandRecipes(request.target).some(command=>command.id===recipeId))throw new Error('Command is reserved for an infrastructure or release controller, or is not configured.');operation={kind:'command',recipeId};break;}
    default:throw new Error('Unsupported tool.');
  }
  return await execute({...request,operation});
}
