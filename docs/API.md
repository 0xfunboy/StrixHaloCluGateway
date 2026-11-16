# API di yed1z Control Room 0.3

Web e VS Code usano la stessa API del coordinator. I tipi pubblici sono in
[`src/contracts.ts`](../src/contracts.ts); il comportamento HTTP è in
[`src/server.ts`](../src/server.ts). Le API di prodotto `/api/` e la facade
di inferenza `/v1/` hanno finalità distinte.

## Convenzioni, autenticazione e ruoli

I body sono oggetti JSON con `Content-Type: application/json`, entro 7 MiB;
ogni endpoint applica ulteriori limiti. Gli ID sono opachi. Gli errori prima
dell'apertura di uno stream sono `{error,code}` con stato HTTP coerente. `202`
significa attività accettata, non completamento o successo.

| Accesso | Contratto |
| --- | --- |
| Browser | `POST /api/login {token}` → `{user}` e cookie `yed1z_session`, HttpOnly, SameSite=Strict, durata 12 ore. `Secure` dipende dalla configurazione HTTPS. |
| Client nativo | Header `Authorization: Bearer <chiave-personale-yed1z>`. Non è la chiave del provider del modello. |
| Logout | `POST /api/logout` → `{ok:true}`, revoca la sessione cookie corrente; non revoca una chiave Bearer. |
| Stato pubblico | `GET /api/health` → `{ok,version}`, senza informazioni di infrastruttura. |

Le mutazioni con cookie richiedono `Origin` uguale a `publicOrigin` o, se non
configurato, all'origine HTTP del servizio. Anche il login controlla l'origine
quando inviata dal client. Le credenziali nelle query URL sono rifiutate.
Le API `/v1/` richiedono sempre Bearer.

| Ruolo | Capacità |
| --- | --- |
| `viewer` | Letture GET autorizzate, bootstrap ed eventi. Nessuna inferenza o mutazione. |
| `member` | Propri progetti e conversazioni, chat HTTP, conoscenza autorizzata e account HTTP privati sui provider disponibili. |
| `operator` | Capacità member più configurazione autorizzata, missioni, CLI native, controlli per task e rilasci. È un operatore fidato. |
| `admin` | Capacità operator e amministrazione utenti/progetti. I controlli di proprietario degli oggetti privati rimangono validi. |

La membership di un progetto non rende leggibili le conversazioni degli altri.
Missioni e runtime Codex/Antigravity richiedono operator/admin: l'esecuzione
di script di progetto non costituisce isolamento OS fra utenti. Il confine
è descritto in [`EXECUTION.md`](EXECUTION.md).

## Bootstrap ed eventi

`GET /api/bootstrap` → `Bootstrap`: progetti autorizzati, proprie conversazioni
e missioni, account propri/condivisi, modelli accessibili, memorie visibili,
propri allegati/evidenze, nodi, collegamenti, telemetria, capacità occupate e
sommari dei target. Run ed evidenze sono limitati rispettivamente a 200 e
1.000 elementi nel bootstrap. I sommari target non espongono workspace root,
host SSH, argv o configurazioni del runner; `commands` elenca le ricette
`verification:true`.

`GET /api/events?after=N` apre SSE; accetta anche `Last-Event-ID`, con precedenza
di `after`. Il cursore è un intero non negativo; massimo otto stream per utente.

```text
id: 42
data: {"id":42,"runId":"run_...","type":"run.updated","createdAt":"...","data":{"status":"executing"}}

```

Il payload è `RunEvent` senza `ownerId`, filtrato sul proprietario autenticato.
Gli eventi durevoli hanno ID positivo. Testo in streaming, telemetria e login
possono essere effimeri con `id:0`, senza campo SSE `id`: non azzerare il cursore
durevole. Il replay è limitato a 500 eventi; raggiunto il limite, un evento
`state.changed` con `data.replayTruncated:true` richiede di rileggere lo stato.
Sono presenti heartbeat ogni 15 secondi.

La UI usa `message.delta`, `task.delta`, `task.updated`, `run.updated`,
`approval.created`, `evidence.created`, `account.login`, `telemetry`,
`state.changed`. Ricaricare bootstrap/conversazione ai cambiamenti rilevanti,
raggruppando gli aggiornamenti: i delta non sostituiscono lo stato persistito.

## Progetti e workspace

| Endpoint | Contratto |
| --- | --- |
| `POST /api/projects` | `{name,description?,memberIds?,routes?,targetId?,workspace?,verifyRecipeIds?,deploymentRecipeId?}` → `201 Project`. |
| `PATCH /api/projects/:id` | Stessi campi modificabili → `200 Project`; proprietario del progetto o admin. |
| `POST /api/projects/:id/reindex` | `{}` → `{indexed,skipped}`; utente non viewer autorizzato, route embedding configurata. |

`routes` accetta `primary`, `researcher`, `coder`, `reviewer`, `embedding`, ciascuno
con ID route accessibile; `""` rimuove l'assegnazione. Modificare `memberIds`,
target, workspace e ricette richiede inoltre operator/admin. Un member può
creare un progetto per chat senza campi esecutivi. Massimo 100 progetti posseduti
per utente.

`targetId` sceglie un target operatore preconfigurato. `workspace` è relativo
alla sua radice; vuoto o `.` indicano la radice stessa. Percorsi assoluti,
traversal e accessi tramite symlink controllati dal runner sono rifiutati.

Alla creazione con target, e al PATCH di target/workspace, il server esegue
**`prepare`**: verifica la radice operatore già esistente e crea la sottodirectory
eventualmente mancante. La richiesta esplicita dell'operatore autorizza questa
preparazione, senza una seconda approvazione in chat. La radice non è creata
automaticamente. L'operazione usa l'executor locale/SSH, ha limite 30 secondi e
deve riuscire prima del salvataggio del progetto.

Le verifiche devono essere ricette del target con `verification:true`; il deploy
deve riferirsi a una sua ricetta dichiarata. **Qualsiasi PATCH del progetto è
bloccato mentre contiene run non terminali**, inclusi paused, interrupted e
awaiting_release. Gli stati terminali sono `succeeded`, `failed`, `cancelled`.

## Conversazioni e avvio del lavoro

| Endpoint | Contratto |
| --- | --- |
| `POST /api/conversations` | `{projectId,title?,routeId?}` → `201 Conversation`, privata del richiedente; massimo 250 per utente. |
| `GET /api/conversations/:id` | `Conversation`, solo proprietario. |
| `DELETE /api/conversations/:id` | `{ok:true}`, solo proprietario; bloccato se la conversazione ha run non terminali. |
| `POST /api/conversations/:id/messages` | Body seguente → `202 Run`, solo proprietario autorizzato. |

```json
{
  "text": "Implementa e verifica la modifica richiesta",
  "routeId": "mdl_...",
  "mode": "mission",
  "attachmentIds": ["art_..."],
  "permissions": {"write": true, "commands": true, "deploy": false},
  "maxIterations": 3,
  "maxParallel": 3
}
```

`mode` è `chat` o `mission`; `text` è limitato a 100.000 caratteri. Gli allegati
sono al massimo 12, dello stesso proprietario e progetto. `maxIterations` e
`maxParallel` sono interi da 1 a 6, default 3. Le autorizzazioni omesse sono
false. `write`/`commands` possono preautorizzare i tool previsti; `deploy` è il
grant esplicito per la ricetta di rilascio della missione, mantenendo i gate
di verifica del controller.

La chat HTTP non esegue tool. Le missioni richiedono operator/admin, target e
almeno una ricetta di verifica eseguibile. Anche le CLI native fuori dalle
missioni richiedono operator/admin e mantengono i limiti dell'adapter:
Antigravity non è disponibile per ruoli di sola lettura. Una richiesta
accettata può poi fallire nel controllo delle capacità; la causa appare nel run.

Una conversazione ammette un solo run non terminale. Il coordinator limita le
attività attive a quattro per utente e 32 totali. Il budget iniziale è 48
chiamate modello e 64.000 token output; non è il saldo commerciale del provider.

## Controlli del run

I controlli operano sui run del proprietario. Un member può controllare la
propria chat HTTP; le missioni sono riservate agli operatori fidati.

| Endpoint POST | Body | Effetto |
| --- | --- | --- |
| `/api/runs/:id/pause` | `{}` | Richiede l'interruzione e porta il run in pausa quando termina l'attività corrente. |
| `/api/runs/:id/resume` | `{}` | Solo `paused`/`interrupted`, senza attività ancora in corso e con budget residuo; ricostruisce il lavoro dalle evidenze. |
| `/api/runs/:id/cancel` | `{}` | Annulla un run non terminale, interrompendone l'attività se presente. |
| `/api/runs/:id/steer` | `{text,attachmentIds?}` | Persiste l'istruzione nella conversazione e nell'obiettivo, e richiede la pausa. Serve poi una ripresa esplicita. |
| `/api/runs/:id/release` | `{}` | Operator/admin, run `awaiting_release`, verifiche superate, nessun task attivo; concede il rilascio → `202 Run`. |

Gli altri controlli restituiscono `200 Run`. La risposta a pause/cancel può
precedere lo stato finale: osservare gli eventi. Lo steer accetta massimo
12.000 caratteri e 12 allegati propri dello stesso progetto; funziona anche
durante l'attesa di rilascio senza creare una missione in conflitto.

La ripresa non reinvia lo stesso RPC né ripete automaticamente un deploy.
Esiti `REMOTE_UNCERTAIN`/`NATIVE_UNCERTAIN` mantengono il run `interrupted` e
richiedono di verificare lo stato effettivo. Un run fallito non è riprendibile
con questo endpoint: avviare un nuovo obiettivo considerando le evidenze.

## Controlli del singolo agente

Pause, resume, cancel e steer richiedono **operator/admin, proprietà del run e
missione attiva**. Si applicano ai ruoli `researcher`/`coder` in coda, attivi o
in pausa. Orchestratore, revisione, test e rilascio usano i controlli del run.

| Endpoint POST | Body | Comportamento |
| --- | --- | --- |
| `/api/tasks/:id/pause` | `{}` | Interrompe il solo sottocontroller del task, oppure blocca quello in coda. Stato confermato: `status:'blocked',control:'paused'`. |
| `/api/tasks/:id/resume` | `{}` | Task effettivamente fermo e in pausa; incrementa `attempt` e lo rimette in coda nello stesso grafo. |
| `/api/tasks/:id/cancel` | `{}` | Annulla il task; dopo il completamento delle altre attività del batch, mette la missione in pausa senza rigenerare il ramo. |
| `/api/tasks/:id/steer` | `{text}` | Massimo 12.000 caratteri; in coda è immediato, se attivo richiede la sua pausa e una ripresa esplicita. |
| `/api/tasks/:id/route` | `{routeId}` | Proprietario non viewer, route accessibile, task in coda o in pausa; cambia modello/account per il prossimo tentativo. |

Tutti restituiscono `200 Run`. I ricercatori indipendenti possono proseguire;
i dipendenti aspettano. La ripresa conserva il budget e ricompila contesto ed
evidenze, richiedendo l'ispezione dei file attuali prima di scrivere. Non congela
un processo né conserva il suo stack. L'incertezza remota prevale sulla pausa
selettiva e interrompe la missione; non si risolve con il solo resume del task.
Per cambiare route a un task attivo occorre attendere la conferma della pausa.
I task già conclusi non sono modificabili.

## Approvazioni

`POST /api/approvals/:id {approved:boolean}` → `Approval`, solo proprietario,
approvazione pending non scaduta e attività ancora in attesa. Le attese scadono
dopo dieci minuti e si interrompono insieme al task. Non si possono riutilizzare
approvazioni di un processo precedente.

Il grant di rilascio non elimina controlli di ruolo, ricetta, test e salute.
Le ricette controller di attivazione/deploy/rollback sono escluse dal tool
generico di comando dei modelli.

## Provider, account e modelli

| Endpoint | Contratto |
| --- | --- |
| `POST /api/providers` | Operator/admin. `{label,kind,baseUrl?,tag?,nodeIds?,resourceGroupIds?}` → `201 Provider`. |
| `POST /api/accounts` | `{providerId,label,secret?,shared?}` → `201 Account`; privato su provider disponibile, condivisione solo operator/admin. |
| `POST /api/accounts/:id/discover` | Proprietario; `{}` → `{models,account,warnings}`, limite 45 secondi. Native solo operator/admin. |
| `POST /api/accounts/:id/login` | Proprietario, operazione native solo operator/admin; `{}` → `202 {operationId}`, esito attraverso `account.login`. |
| `PATCH /api/models/:id` | Operator/admin e proprietario dell'account; `{label?,contextWindow?,capabilities?,resourceGroupIds?}` → `ModelRoute`. |

Provider HTTP: `openai-compatible`, `openai-responses`, `ollama`, `gemini`.
Codex può essere aggiunto con comando ufficiale fisso. Antigravity richiede
configurazione operatore con profilo dedicato e non è creabile da questo
endpoint. Comandi CLI, argv ed environment arbitrari non sono campi della UI.
`tag` è `gemrouter`, `cluster`, `cloud` o `local`; GemRouter è un provider
`openai-compatible` con relativo tag.

Gli account native non sono condivisibili. Codex isola il profilo per account;
Antigravity ammette un solo account nel servizio. Creazione, discovery, login
ed esecuzione native escludono i member anche in presenza di record legacy.
Il login asincrono può terminare con un evento di errore dopo il `202`.

Il login guidato Codex inoltra URL/codice ufficiali effimeri; Antigravity usa una
CLI già autenticata, senza OAuth guidato qui. Il catalogo restituisce `hasSecret`,
mai il segreto. Un errore di autenticazione del provider durante discovery
diventa `502 UPSTREAM`, distinto dal `401` di login yed1z; un limite di quota
osservato diventa `429 QUOTA` e aggiorna il cooldown.

Capacità modificabili: `chat`, `tools`, `embedding`, `vision`; `contextWindow`
da 4.096 a 2.000.000. Dichiarare una capacità non prova il comportamento reale
del modello. Quote ignote rimangono ignote; lo switch di account è esplicito
e non ripete automaticamente il lavoro.

## Allegati, memoria, telemetria e utenti

| Endpoint | Contratto |
| --- | --- |
| `POST /api/artifacts` | `{projectId,name,content}` → `201 Artifact`; UTF-8/Markdown, massimo 1 MiB; nessun parser PDF/OCR o upload binario. |
| `GET /api/artifacts/:id` | Metadati più `content`, solo proprietario autorizzato. |
| `GET /api/artifacts/:id/download` | Allegato `text/plain`, stessi controlli. |
| `DELETE /api/artifacts/:id` | `{ok:true}`; bloccato finché l'utente ha qualunque run non terminale. |
| `POST /api/memories` | `{projectId,title,content,kind,scope?,sourceIds?}` → `201 Memory` candidata. |
| `PATCH /api/memories/:id` | Proprietario; `{title?,content?,scope?,status?}` → nuova revisione di `Memory`. |
| `DELETE /api/memories/:id` | Proprietario; elimina memoria, revisioni, chunk, indice e vettori, non conversazioni o documenti sorgente. |
| `POST /api/memories/search` | `{projectId,query}` → `{results:[{memory,score,method}]}`, fra memorie approvate visibili. |
| `POST /api/telemetry/refresh` | `{}` → `{telemetry}`, sonde preconfigurate, nessun host fornito dal client; utente non viewer. |
| `GET /api/users` | Admin; `{users}`. |
| `POST /api/users` | Admin; `{name,role}` → `201 {user,token}`, nuova chiave mostrata una volta. |

La memoria usa `kind:method|decision|brief|document`, scope `private|project` e
stato `candidate|approved|retired`. Default: candidato privato. Solo le approvate
entrano nel retrieval. Pubblicare nel progetto richiede il suo proprietario o
operator/admin, mantenendo la proprietà della memoria. Le fonti dichiarate
devono essere propri allegati, memorie o run dello stesso progetto.

La ricerca usa FTS5 e, se configurati/indicizzati, embeddings reali; il reindex
condivide lo scheduler di inferenza. La telemetria distingue qualità misurata,
legacy non verificata e sconosciuta. Questi POST richiedono utente non viewer.

## Facade di inferenza `/v1/`

La facade condivide account, quote, attivazioni e prenotazioni del prodotto.
Non crea conversazioni, missioni, memorie o workspace e non esegue tool. Non è
l'intera API OpenAI.

`GET /v1/models` restituisce `object:'list'` con ID di **route specifiche
dell'account**, `name`, `owned_by`, `underlying_model`, eventuale `context_length`.
Usare l'ID per scegliere la quota. Il nome sottostante è accettato solo se non
ambiguo; altrimenti `400 AMBIGUOUS_MODEL`. Le route native possono comparire nel
catalogo, ma completions le rifiuta con `409 CAPABILITY`.

`POST /v1/chat/completions` accetta:

- `model`: ID route o nome sottostante non ambiguo;
- `messages`: massimo 200, ruoli `system`, `user`, `assistant`, `tool`;
- `content`: testo o `null`, massimo 100.000 caratteri per messaggio;
- `tool_call_id` nei risultati `tool` e `tool_calls` nei messaggi `assistant`;
- `tools`: massimo 32 definizioni `type:'function'` con `function.name`,
  `description` opzionale e oggetto `parameters`;
- `stream:true` per SSE;
- `max_completion_tokens` o `max_tokens`: 128–32.000, con precedenza del primo.

Messaggi e definizioni serializzati sono limitati a 500.000 caratteri. Occorrono
route HTTP, account disponibile e ruolo non viewer. Il timeout massimo è dieci
minuti; disconnessione e fine richiesta rilasciano la prenotazione.

```json
{
  "model": "mdl_...",
  "messages": [{"role":"user","content":"Qual è lo stato del progetto?"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "project_status",
      "description": "Legge lo stato nel client chiamante",
      "parameters": {"type":"object","properties":{}}
    }
  }],
  "stream": true
}
```

La facade inoltra le definizioni e restituisce le chiamate del modello.
**Il client esterno autorizza ed esegue le proprie funzioni**, poi può reinviare
assistant/tool per il turno successivo. Nessuna funzione è collegata
implicitamente all'executor yed1z.

La risposta JSON contiene `object:'chat.completion'`, `model` con ID route,
`choices`, eventuali `tool_calls`, `finish_reason`, `usage` se osservato. Lo
stream invia testo in `delta.content`, chiamate complete al termine in
`delta.tool_calls` con indici, chunk finale con finish reason/uso e `[DONE]`.
Non promette streaming incrementale degli argomenti delle funzioni.

Gli errori upstream conservano uno stato valido e, quando disponibile,
`Retry-After`, aggiornando il cooldown. Se lo stream è già iniziato, l'errore
è `{error:{message,type:'upstream_error',code}}`, seguito da `[DONE]`: lo stato
HTTP già inviato non può cambiare.

`tool_choice`, `parallel_tool_calls`, `temperature`, `response_format` e altri
parametri non sono interpretati/inoltrati. Non sono implementati contenuti
multimodali né `/v1/responses`, `/v1/embeddings` o gestione file OpenAI.
Tool interni e missioni usano le API di prodotto.

## Bridge webview VS Code

La UI usa `acquireVsCodeApi()` una volta. Trasporto e segreti restano nell'host;
il webview non chiama i provider. La chiave yed1z è in SecretStorage per origine.

| Messaggio UI → host | Risposta/comportamento |
| --- | --- |
| `{type:'api',id,method,path,body?}` | `{type:'api.result',id,ok,status,data}`, solo percorsi relativi `/api/`. |
| `{type:'cancel-api',id}` | Cancella l'HTTP correlato, non un run già accettato; per quello serve il relativo endpoint. |
| `{type:'subscribe',after?}` / `{type:'unsubscribe'}` | `{type:'event',event}`, riconnessione dal cursore durevole. |
| `{type:'configure'}` | Dialoghi host URL/chiave; `{type:'configured'}` dopo verifica del gateway. |
| `{type:'attachSelection'}` | `{type:'selection',name,content}`, selezione esplicita dell'editor. |
| `{type:'saveFile',name,content}` | Dialogo nativo e `{type:'savedFile',ok,error?}`, massimo 16 MB. |
| `{type:'open-portal'}` | Apre il gateway configurato. |
| `{type:'openAuth',url}` | Solo URL HTTPS senza credenziali sui domini OpenAI consentiti. |

Workspace Trust precede mutazioni e selezioni; letture e logout restano
possibili. Il body webview di creazione account può usare `requestSecret:true`:
l'host chiede la chiave in un input password, rimuove il flag e invia `secret`
solo al server. Il flag appartiene al bridge, non all'API pubblica.

Limiti host: 120 secondi per HTTP, 16 richieste concorrenti. HTTPS obbligatorio
per gateway pubblici, HTTP ammesso su destinazioni locali/private, redirect
rifiutati. In Remote SSH, localhost è risolto dall'extension host remoto.

Non esistono RPC pubblici per shell, host o percorsi assoluti arbitrari, né per
leggere i segreti del coordinator.
