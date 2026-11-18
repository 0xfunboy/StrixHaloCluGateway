import { spawn } from 'node:child_process';
import type { AdapterConnection } from './types.ts';
import { runtimeEnvironment } from './vendor/environment.ts';
import { AppError } from '../util.ts';

export interface LoginPrompt {
    verificationUrl: string;
    userCode?: string;
    respond?: (value: string) => void;
}

export async function googleLogin(connection: AdapterConnection, cwd: string, signal: AbortSignal, onPrompt: (value: LoginPrompt)=>void) {
    signal.throwIfAborted();
    await new Promise<void>((resolve,reject)=>{
        const child=spawn(connection.command ?? 'agy',[...(connection.args ?? ['acp','--sandbox','--disable-telemetry']),'--login'],{
            cwd,env:runtimeEnvironment(connection.env),stdio:['pipe','pipe','pipe'],windowsHide:true
        });
        let pending='', announced=false, submitted=false;
        const abort=()=>{child.kill('SIGKILL');};
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted) abort();
        const fail=(message:string)=>{child.kill('SIGKILL');reject(new AppError(409,'GOOGLE_AUTH',message));};
        const consume=(chunk:Buffer)=>{
            if(announced) return;
            pending+=chunk.toString();
            if(pending.length>65536){fail('La CLI Google non ha fornito un indirizzo di accesso valido.');return;}
            const link=pending.match(/(https:\/\/accounts\.google\.com\/[^\s\x1b]+)(?=[\s\x1b])/);
            if(!link) return;
            let url: URL;
            try{url=new URL(link[1]);}catch{return;}
            if(url.origin!=='https://accounts.google.com' || url.username || url.password || url.searchParams.get('response_type')!=='code') return;
            announced=true; pending='';
            const respond=(input:string)=>{
                if(submitted || signal.aborted || !child.stdin.writable) throw new AppError(409,'LOGIN_STATE','La richiesta di login è scaduta.');
                let code=input.trim();
                if(/^https?:\/\//.test(code)) {
                    let returned: URL, expected: URL;
                    try { returned=new URL(code); expected=new URL(url.searchParams.get('redirect_uri') ?? ''); }
                    catch { throw new AppError(400,'LOGIN_CODE','URL di ritorno non valido.'); }
                    if(returned.origin!==expected.origin || returned.pathname!==expected.pathname || (url.searchParams.has('state') && returned.searchParams.get('state')!==url.searchParams.get('state')))
                        throw new AppError(400,'LOGIN_CODE','Usa la pagina di ritorno della richiesta Google aperta.');
                    code=returned.searchParams.get('code') ?? '';
                }
                if (!/^[A-Za-z0-9_.~+%/=-]{4,4096}$/.test(code)) throw new AppError(400,'LOGIN_CODE','Codice di autorizzazione non valido.');
                submitted=true;
                child.stdin.end(code+'\n');
            };
            onPrompt({verificationUrl:url.href,respond});
        };
        child.stdout.on('data',consume); child.stderr.on('data',consume);
        child.stdin.on('error',()=>{ /* A child can close stdin while an operator cancels. */ });
        child.once('error',()=>{signal.removeEventListener('abort',abort);reject(new AppError(409,'GOOGLE_AUTH','Impossibile avviare il login ufficiale di Antigravity.'));});
        child.once('close',status=>{
            signal.removeEventListener('abort',abort);
            if(signal.aborted) reject(signal.reason);
            else if(status===0 && submitted) resolve();
            else reject(new AppError(409,'GOOGLE_AUTH','La CLI Google non ha confermato il login. Riapri la verifica per questo account.'));
        });
    });
}
