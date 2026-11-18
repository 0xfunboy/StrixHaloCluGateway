import { assert, id, object, str } from './util.ts';
import type { InferenceResult } from './adapters/types.ts';

function content(value: unknown) {
    if (typeof value === 'string') return value;
    assert(Array.isArray(value),400,'RESPONSES','Contenuto Responses non valido.');
    return value.map(item => {
        const part=object(item);
        assert(['input_text','output_text','text'].includes(String(part.type)),400,'RESPONSES','Il modello richiede contenuti testuali.');
        return str(part.text,'Testo',100000,true);
    }).join('');
}

export function fromResponses(input: Record<string, unknown>) {
    assert(!input.previous_response_id && input.store !== true,400,'RESPONSES','Invia i messaggi necessari in input e usa store=false.');
    const items=typeof input.input==='string' ? [{role:'user',content:input.input}] : input.input;
    assert(Array.isArray(items) && items.length <= 200,400,'RESPONSES','Input Responses non valido.');
    const messages: Record<string, unknown>[]=[];
    if (input.instructions) messages.push({role:'system',content:str(input.instructions,'Istruzioni',100000)});
    for (const raw of items) {
        const item=object(raw);
        if (item.type === 'function_call_output') messages.push({role:'tool',tool_call_id:item.call_id,content:content(item.output)});
        else if (item.type === 'function_call') messages.push({role:'assistant',content:null,tool_calls:[{id:item.call_id,function:{name:item.namespace ? str(item.namespace,'Namespace')+'__'+str(item.name,'Strumento') : item.name,arguments:item.arguments}}]});
        else if (item.type === 'reasoning' && !item.role) continue;
        else {
            assert(['developer','system','user','assistant'].includes(String(item.role)),400,'RESPONSES','Tipo di input non supportato.');
            messages.push({role:item.role === 'developer' ? 'system' : item.role,content:content(item.content)});
        }
    }
    const tools=input.tools ?? [];
    assert(Array.isArray(tools) && tools.length<=128,400,'TOOLS','Elenco strumenti non valido.');
    const functions: Array<Record<string,unknown>> = [];
    const names = new Map<string,{name:string; namespace?:string}>();
    function add(raw: unknown, namespace?: string) {
        const tool=object(raw);
        const name=str(tool.name,'Nome strumento',200);
        if(tool.type==='namespace' && !namespace) {
            assert(Array.isArray(tool.tools) && tool.tools.length<=64,400,'TOOLS','Namespace strumenti non valido.');
            for (const child of tool.tools) add(child,name);
            return;
        }
        assert(tool.type==='function',400,'TOOLS','Tipo di strumento non supportato dal motore.');
        const wire=namespace ? namespace+'__'+name : name;
        assert(!names.has(wire) && functions.length<128,400,'TOOLS','Strumento duplicato o limite superato.');
        names.set(wire,{name,namespace});
        functions.push({type:'function',function:{name:wire,description:tool.description,parameters:tool.parameters ?? {type:'object',properties:{}}}});
    }
    for(const tool of tools) add(tool);
    return { ...input, messages, tools:functions, max_completion_tokens:input.max_output_tokens, names };

}

type Writer=(event: Record<string,unknown>)=>void;

export class ResponsesOutput {
    readonly responseId=id('resp');
    readonly messageId=id('msg');
    readonly created=Math.floor(Date.now()/1000);
    started=false;
    textStarted=false;
    sequence=0;
    streamed='';
    readonly model: string;
    readonly write: Writer;
    names?: Map<string,{name:string; namespace?:string}>;
    constructor(model: string, write: Writer) { this.model = model; this.write = write; }
    event(type:string,data:Record<string,unknown>) { this.write({type,...data,sequence_number:this.sequence++}); }
    private envelope(status:string,output:unknown[]=[]) {
        return {id:this.responseId,object:'response',created_at:this.created,status,model:this.model,output,error:null};
    }
    private start() {
        if (this.started) return;
        this.started=true;
        this.event('response.created',{response:this.envelope('in_progress')});
        this.event('response.in_progress',{response:this.envelope('in_progress')});
    }
    text(delta:string) {
        if (!delta) return;
        this.start();
        if (!this.textStarted) {
            this.textStarted=true;
            this.event('response.output_item.added',{output_index:0,item:{id:this.messageId,type:'message',status:'in_progress',role:'assistant',content:[]}});
            this.event('response.content_part.added',{output_index:0,item_id:this.messageId,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
        }
        this.streamed+=delta;
        this.event('response.output_text.delta',{output_index:0,item_id:this.messageId,content_index:0,delta});
    }
    fail(message:string) {
        this.event('response.failed',{response:{...this.envelope('failed'),error:{code:'upstream_error',message}}});
    }
    finish(result:InferenceResult,stream:boolean) {
        if(stream) this.start();
        const output:unknown[]=[];
        if(result.text) {
            const part={type:'output_text',text:result.text,annotations:[]};
            const item={id:this.messageId,type:'message',role:'assistant',status:'completed',content:[part]};
            output.push(item);
            if(stream) {
                if(result.text.startsWith(this.streamed)) this.text(result.text.slice(this.streamed.length));
                const fields={output_index:0,item_id:this.messageId,content_index:0};
                this.event('response.output_text.done',{...fields,text:result.text});
                this.event('response.content_part.done',{...fields,part});
                this.event('response.output_item.done',{output_index:0,item});
            }
        }
        for(const call of result.toolCalls) {
            const item={id:id('fc'),type:'function_call',status:'completed',call_id:call.id,...(this.names?.get(call.name) ?? {name:call.name}),arguments:call.arguments};
            const output_index=output.length; output.push(item);
            if(stream) {
                this.event('response.output_item.added',{output_index,item:{...item,status:'in_progress',arguments:''}});
                this.event('response.function_call_arguments.delta',{output_index,item_id:item.id,delta:call.arguments});
                this.event('response.function_call_arguments.done',{output_index,item_id:item.id,arguments:call.arguments});
                this.event('response.output_item.done',{output_index,item});
            }
        }
        const limited=result.finishReason==='length' || result.finishReason==='max_tokens';
        const response={...this.envelope(limited?'incomplete':'completed',output),incomplete_details:limited?{reason:'max_output_tokens'}:null,
            usage:result.usage ? {input_tokens:result.usage.inputTokens,input_tokens_details:{cached_tokens:result.usage.cachedInputTokens ?? 0},output_tokens:result.usage.outputTokens,total_tokens:result.usage.inputTokens+result.usage.outputTokens} : null};
        if(stream) this.event(limited?'response.incomplete':'response.completed',{response});
        return response;
    }
}
