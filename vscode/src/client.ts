export interface StreamEvent { id?: number; type: string; [key: string]: unknown; }
export function gatewayUrl(raw:string):string{
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||(url.pathname!=='/'&&url.pathname!==''))throw new Error('Indica solo l’origine del gateway, senza credenziali o percorsi.');
  if(url.protocol==='http:'&&!/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+)$/.test(url.hostname)&&!url.hostname.endsWith('.local'))throw new Error('Per un gateway pubblico è richiesto HTTPS.');
  return url.origin;
}
export function apiPath(raw:unknown):string{
  if(typeof raw!=='string'||raw.length>1800||!raw.startsWith('/api/')||/[\\%#\s]/.test(raw)||raw.split(/[/?]/).some(part=>part==='.'||part==='..'))throw new Error('Percorso API non consentito.');
  const url=new URL(raw,'https://yed1z.invalid');
  if(url.origin!=='https://yed1z.invalid'||!/^\/api\/[a-zA-Z0-9_\/-]+$/.test(url.pathname))throw new Error('Percorso API non consentito.');
  if (url.search) {
    const fields = [...url.searchParams.keys()];
    const eventPath = url.pathname === '/api/events' || /^\/api\/runs\/[a-zA-Z0-9_-]+\/events$/.test(url.pathname);
    const eventCursor = eventPath && fields.length === 1 && fields[0] === 'after' && /^\d{1,15}$/.test(url.searchParams.get('after') ?? '');
    const sourcePath = /^\/api\/projects\/[a-zA-Z0-9_-]+\/knowledge\/sources\/[a-zA-Z0-9_-]+$/.test(url.pathname);
    const sourceHash = sourcePath && /^[a-f0-9]{64}$/i.test(url.searchParams.get('hash') ?? '') && url.searchParams.getAll('hash').length === 1
      && (fields.length === 1 || fields.length === 2 && /^\d{1,10}$/.test(url.searchParams.get('revision') ?? ''));
    if (!eventCursor && !sourceHash) throw new Error('Parametri API non consentiti.');
  }
  return url.pathname+url.search;
}
export async function boundedJson(response:Response):Promise<unknown>{
  if(!response.body)return null;
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>16_000_000)throw new Error('Risposta del gateway troppo grande.');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
  finally{await reader.cancel().catch(()=>{});}
}
export async function consumeEvents(response:Response,onEvent:(event:StreamEvent)=>void,signal:AbortSignal):Promise<void>{
  if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Streaming del gateway non disponibile.');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',data:string[]=[],size=0;
  const dispatch=()=>{if(data.length){const parsed:unknown=JSON.parse(data.join('\n'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Evento non valido.');onEvent(parsed as StreamEvent);}data=[];size=0;};
  const line=(value:string)=>{if(!value)dispatch();else if(value.startsWith('data:')){const text=value.slice(5).replace(/^ /,'');size+=text.length;if(size>2_000_000)throw new Error('Evento troppo grande.');data.push(text);}};
  const abort=()=>{void reader.cancel();};signal.addEventListener('abort',abort,{once:true});
  try{while(true){signal.throwIfAborted();const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});if(buffer.length>2_000_000)throw new Error('Evento troppo grande.');let boundary:number;while((boundary=buffer.indexOf('\n'))>=0){line(buffer.slice(0,boundary).replace(/\r$/,''));buffer=buffer.slice(boundary+1);}}buffer+=decoder.decode();if(buffer)line(buffer);if(data.length)dispatch();signal.throwIfAborted();}
  finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
}
export class GatewayClient{
  readonly endpoint:string;private readonly token:string;
  constructor(endpoint:string,token:string){this.endpoint=gatewayUrl(endpoint);this.token=token;}
  async request(method:string,path:string,body:unknown,signal:AbortSignal):Promise<Response>{
    const target = apiPath(path);
    const delegateUpdate = method === 'PUT' && /^\/api\/accounts\/[a-zA-Z0-9_-]+\/delegates$/.test(target);
    if(!delegateUpdate&&!['GET','POST','PATCH','DELETE'].includes(method))throw new Error('Metodo API non consentito.');
    const text=method==='GET'?undefined:JSON.stringify(body??{});if(text&&Buffer.byteLength(text)>3_000_000)throw new Error('Richiesta troppo grande.');
    return await fetch(this.endpoint+target,{method,signal,redirect:'error',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json','X-Client-App':'yed1z-vscode'},...(text===undefined?{}:{body:text})});
  }
}
