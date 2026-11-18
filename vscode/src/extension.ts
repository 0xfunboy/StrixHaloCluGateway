import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { GatewayClient, apiPath, boundedJson, consumeEvents, gatewayUrl } from './client.ts';

const keyName=(endpoint:string)=>'yed1z.gateway.'+createHash('sha256').update(endpoint).digest('hex');
export class CommandView implements vscode.WebviewViewProvider,vscode.Disposable{
  private view?:vscode.WebviewView;
  private requests=new Map<string,AbortController>();
  private stream?:AbortController;
  private configurePromise?:Promise<void>;
  private readonly context:vscode.ExtensionContext;
  constructor(context:vscode.ExtensionContext){this.context=context;}
  private endpoint(){return this.context.globalState.get<string>('yed1z.endpoint','http://127.0.0.1:8081');}
  private post(message:unknown){return this.view?.webview.postMessage(message);}
  private postHost(){
    const workspace = vscode.workspace.workspaceFolders?.map(folder => folder.name).join(', ');
    const host = vscode.env.remoteName ? `Host remoto (${vscode.env.remoteName})` : 'Host locale';
    return this.post({type:'host-context',endpoint:this.endpoint(),host,workspace});
  }
  async resolveWebviewView(view:vscode.WebviewView){
    this.view=view;const assets=vscode.Uri.joinPath(this.context.extensionUri,'web');
    view.webview.options={enableScripts:true,localResourceRoots:[assets]};
    const raw=Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(assets,'index.html'))).toString('utf8');
    const nonce=randomBytes(18).toString('base64');
    const csp=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data:; font-src ${view.webview.cspSource}; style-src ${view.webview.cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; form-action 'none'; base-uri 'none';">`;
    view.webview.html=raw.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,'').replace(/<head(?:\s[^>]*)?>/i,match=>match+csp)
      .replace(/(href|src)="(?:\/|\.\/)?(?:assets\/|web\/)?(app\.js|style\.css|favicon\.svg)"/g,(_all,attribute:string,file:string)=>`${attribute}="${view.webview.asWebviewUri(vscode.Uri.joinPath(assets,file))}"`)
      .replace(/<script\b/g,`<script nonce="${nonce}"`);
    const subscription=view.webview.onDidReceiveMessage(raw=>{void this.message(raw);});
    view.onDidDispose(()=>{subscription.dispose();this.abortAll();if(this.view===view)this.view=undefined;});
  }
  private abortAll(){for(const controller of this.requests.values())controller.abort();this.requests.clear();this.stream?.abort();this.stream=undefined;}
  private async client(){const endpoint=this.endpoint(),token=await this.context.secrets.get(keyName(endpoint));if(!token)throw new Error('Collega il gateway con URL e chiave.');return new GatewayClient(endpoint,token);}
  private async message(raw:unknown):Promise<void>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return;const message=raw as Record<string,unknown>;
    if(message.type==='configure'){await this.configure();return;}
    if(message.type==='host-context'){await this.postHost();return;}
    if(message.type==='open-portal'){await this.openPortal();return;}
    if(message.type==='openCockpit'){await vscode.env.openExternal(vscode.Uri.parse(`${gatewayUrl(this.endpoint())}/cockpit`));return;}
    if(message.type==='copyText'&&typeof message.text==='string'&&message.text.length<=2000){await vscode.env.clipboard.writeText(message.text);return;}
    if (message.type === 'openDiff' && typeof message.text === 'string' && Buffer.byteLength(message.text) <= 2_000_000) {
      const document = await vscode.workspace.openTextDocument({ language: 'diff', content: message.text });
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }
    if(message.type==='attachSelection'){await this.addSelection();return;}
    if(message.type==='saveFile'){
      try{
        if(typeof message.name!=='string'||typeof message.content!=='string'||Buffer.byteLength(message.content)>16_000_000)throw new Error('File da esportare non valido o troppo grande.');
        const name=path.basename(message.name.replace(/\\/g,'/')).replace(/[\x00-\x1f\x7f]/g,'').slice(0,180);
        if(!name||name==='.'||name==='..')throw new Error('Nome del file non valido.');
        const destination=await vscode.window.showSaveDialog({title:'Salva esportazione yed1z',defaultUri:vscode.Uri.file(name)});
        if(!destination){await this.post({type:'savedFile',ok:false,error:'Esportazione annullata.'});return;}
        await vscode.workspace.fs.writeFile(destination,Buffer.from(message.content,'utf8'));
        await this.post({type:'savedFile',ok:true});
      }catch(error){await this.post({type:'savedFile',ok:false,error:error instanceof Error?error.message:'Esportazione non riuscita.'});}return;
    }
    if(message.type==='unsubscribe'){this.stream?.abort();this.stream=undefined;return;}
    if(message.type==='subscribe'){void this.subscribe(typeof message.after==='number'?message.after:0);return;}
    if(message.type==='cancel-api'&&typeof message.id==='string'){this.requests.get(message.id)?.abort();return;}
    if(message.type==='openAuth'&&typeof message.url==='string'){
      try{const url=new URL(message.url);if(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&['auth.openai.com','auth0.openai.com','chatgpt.com','accounts.google.com'].includes(url.hostname))await vscode.env.openExternal(vscode.Uri.parse(url.href));}catch{}return;
    }
    if(message.type!=='api'||typeof message.id!=='string'||message.id.length>120||this.requests.has(message.id))return;
    const id=message.id,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120_000);this.requests.set(id,controller);
    try{
      if(this.requests.size>16)throw new Error('Troppe richieste contemporanee.');
      const path=apiPath(message.path),method=typeof message.method==='string'?message.method:'GET';
      const personalAppearance=method==='PATCH'&&path==='/api/me/appearance';
      if(method!=='GET'&&!vscode.workspace.isTrusted&&path!=='/api/logout'&&!personalAppearance)throw new Error('Rendi attendibile il workspace prima di inviare attività o file al gateway.');
      let body=message.body;
      if(method==='POST'&&['/api/accounts','/api/connections'].includes(path)&&body&&typeof body==='object'&&!Array.isArray(body)){
        const account={...body as Record<string,unknown>};
        if(account.requestSecret===true){const secret=await vscode.window.showInputBox({title:'yed1z · Chiave del provider',prompt:'La chiave viene inviata al gateway e non entra nel webview.',password:true,ignoreFocusOut:true});if(!secret)throw new Error('Inserimento della chiave annullato.');account.secret=secret;}
        delete account.requestSecret;body=account;
      }
      if (method === 'POST' && /^\/api\/accounts\/[a-zA-Z0-9_-]+\/login\/respond$/.test(path) && body && typeof body === 'object' && !Array.isArray(body)) {
        const response = { ...body as Record<string, unknown> };
        if (response.requestCode === true) {
          const code = await vscode.window.showInputBox({ title: 'yed1z · Risposta di autorizzazione', prompt: 'Incolla il codice o URL restituito dal provider dopo il login.', password: true, ignoreFocusOut: true, validateInput: value => value.trim().length > 4096 ? 'Risposta troppo lunga.' : null });
          if (!code?.trim()) throw new Error('Inserimento del codice annullato.');
          response.code = code.trim();
        }
        delete response.requestCode;
        body = response;
      }
      const response=await(await this.client()).request(method,path,body,controller.signal);
      let data:unknown;try{data=await boundedJson(response);}catch{data={error:`Il gateway ha risposto HTTP ${response.status}.`,code:'invalid_response'};}
      await this.post({type:'api.result',id,ok:response.ok,status:response.status,data});
    }catch(error){await this.post({type:'api.result',id,ok:false,status:controller.signal.aborted?499:502,data:{error:controller.signal.aborted?'Richiesta interrotta.':error instanceof Error?error.message:'Gateway non raggiungibile.',code:'host_error'}});}
    finally{clearTimeout(timer);this.requests.delete(id);}
  }
  private async subscribe(after:number):Promise<void>{
    this.stream?.abort();const controller=new AbortController();this.stream=controller;
    let cursor=Number.isSafeInteger(after)&&after>=0?after:0;
    while(!controller.signal.aborted&&this.view){
      try{
        const response=await(await this.client()).request('GET',`/api/events?after=${cursor}`,undefined,controller.signal);
        if(!response.ok)throw new Error(`Streaming HTTP ${response.status}.`);
        await this.post({type:'connection',connected:true});
        await consumeEvents(response,event=>{if(Number.isSafeInteger(event.id)&&Number(event.id)>cursor)cursor=Number(event.id);void this.post({type:'event',event});},controller.signal);
      }catch(error){if(!controller.signal.aborted)await this.post({type:'connection',connected:false,message:error instanceof Error?error.message:'Connessione interrotta.'});}
      if(controller.signal.aborted)break;
      await new Promise<void>(resolve=>{const timer=setTimeout(done,2500);function done(){controller.signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);done();}controller.signal.addEventListener('abort',abort,{once:true});});
    }
  }
  async configure(){if(this.configurePromise)return this.configurePromise;this.configurePromise=this.doConfigure();try{await this.configurePromise;}finally{this.configurePromise=undefined;}}
  private async doConfigure(){
    const saved = this.context.globalState.get<string[]>('yed1z.endpoints', []);
    let value: string | undefined;
    if (saved.length && typeof vscode.window.showQuickPick === 'function') {
      const choices = saved.map(endpoint => ({ label: endpoint, description: endpoint === this.endpoint() ? 'Gateway in uso' : 'Gateway salvato', endpoint }));
      const pick = await vscode.window.showQuickPick([...choices, { label: 'Aggiungi un gateway', description: '', endpoint: '' }], { title: 'yed1z · Gateway dell’editor' });
      if (!pick) return;
      value = pick.endpoint || undefined;
    }
    if (!value) value=await vscode.window.showInputBox({title:'yed1z · Collega Control Room',value:this.endpoint(),prompt:'Indirizzo del portale yed1z. In Remote SSH, localhost indica l’host remoto dell’estensione.',ignoreFocusOut:true,validateInput:value=>{try{gatewayUrl(value);return null;}catch(error){return(error as Error).message;}}});
    if(!value)return;const endpoint=gatewayUrl(value),previous=await this.context.secrets.get(keyName(endpoint));
    const entered=await vscode.window.showInputBox({title:'yed1z · Chiave personale',password:true,ignoreFocusOut:true,prompt:previous?'Lascia vuoto per conservare la chiave salvata.':'La chiave resta in VS Code SecretStorage.'});
    if(entered===undefined)return;const token=entered||previous;if(!token)return;
    try{
      const response=await new GatewayClient(endpoint,token).request('GET','/api/bootstrap',undefined,AbortSignal.timeout(15_000));if(!response.ok)throw new Error(`Connessione HTTP ${response.status}. Verifica URL e chiave.`);await boundedJson(response);
      this.abortAll();await this.context.secrets.store(keyName(endpoint),token);await this.context.globalState.update('yed1z.endpoint',endpoint);
      await this.context.globalState.update('yed1z.endpoints',[endpoint,...saved.filter(item => item !== endpoint)].slice(0, 25));
      await this.postHost();await this.post({type:'configured'});
      void vscode.window.showInformationMessage('yed1z collegato: progetti, conversazioni e squadre sono condivisi con il portale.');
    }catch(error){void vscode.window.showErrorMessage(error instanceof Error?error.message:'Gateway non raggiungibile.');}
  }
  async addSelection(){
    if(!vscode.workspace.isTrusted){void vscode.window.showErrorMessage('Rendi attendibile il workspace prima di trasferire una selezione.');return;}
    const editor=vscode.window.activeTextEditor;if(!editor||editor.selection.isEmpty)return;
    const content=editor.document.getText(editor.selection);if(Buffer.byteLength(content)>1_000_000){void vscode.window.showErrorMessage('La selezione supera 1 MB.');return;}
    await vscode.commands.executeCommand('haloforge.chat.focus');await this.post({type:'selection',name:vscode.workspace.asRelativePath(editor.document.uri),content});
  }
  async openPortal(){await vscode.env.openExternal(vscode.Uri.parse(this.endpoint()));}
  dispose(){this.abortAll();}
}
export function activate(context:vscode.ExtensionContext){
  const view=new CommandView(context);context.subscriptions.push(view,vscode.window.registerWebviewViewProvider('haloforge.chat',view,{webviewOptions:{retainContextWhenHidden:true}}),
    vscode.commands.registerCommand('haloforge.open',()=>vscode.commands.executeCommand('haloforge.chat.focus')),
    vscode.commands.registerCommand('yed1z.configure',()=>view.configure()),vscode.commands.registerCommand('haloforge.addSelection',()=>view.addSelection()),vscode.commands.registerCommand('yed1z.openPortal',()=>view.openPortal()));
}
export function deactivate(){}
