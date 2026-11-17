# API di yed1z Control Room 0.4

Web e VS Code usano la stessa API del coordinator. I tipi pubblici sono in
[`src/contracts.ts`](../src/contracts.ts); il comportamento HTTP è in
[`src/server.ts`](../src/server.ts). Le API di prodotto `/api/` e la facade
di inferenza `/v1/` hanno finalità distinte.
I contratti di collegamento, routing e carico dei motori sono definiti anche in
[`connection-types.ts`](../src/connection-types.ts),
[`routing-types.ts`](../src/routing-types.ts) e
[`load-types.ts`](../src/load-types.ts), riesportati dai contratti condivisi.

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
| Monitor pubblico | Con `publicDashboard:true`, `GET /api/bootstrap`, `/api/events`, `/api/dashboard` e `/api/telemetry` sono accessibili senza credenziali con dati pubblici limitati, descritti sotto. |

Le mutazioni con cookie richiedono `Origin` uguale a `publicOrigin` o, se non
configurato, all'origine HTTP del servizio. Anche il login controlla l'origine
quando inviata dal client. Le credenziali nelle query URL sono rifiutate.
Le API `/v1/` richiedono sempre Bearer.

`publicDashboard` è `true` nella configurazione predefinita. Impostarlo a `false`
richiede autenticazione anche per il monitor; `/api/health` resta pubblico.
Su bootstrap ed eventi, una chiave o sessione presente ma invalida produce
`401 UNAUTHORIZED`: il server non la degrada a ospite. L'ospite non può accedere
alle altre risorse private o avviare inferenza.

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

Il bootstrap autenticato include inoltre `routeAvailability` e `providerLoads`
per gli account accessibili. I provider pubblicati non contengono `command`,
`args` o `env`; un account espone `hasSecret`, mai la credenziale.

### Contratto del monitor ospite

Senza credenziali e con monitor pubblico abilitato, il bootstrap contiene
`user.id:'guest'`, `role:'viewer'`. Progetti, conversazioni, account, run,
approvazioni, memorie, allegati, evidenze e target sono liste vuote. Sono visibili:

- nodi con ID, etichetta, tipo e capacità, senza host o configurazione delle sonde;
- collegamenti con estremi, etichetta e stato, senza indirizzo;
- gruppi di risorse e occupazione aggregata del coordinator;
- telemetria senza `error` o `details`;
- provider definiti nel file di configurazione, non nativi, associati a nodi o
  con tag `local`/`cluster`, senza URL e con proprietario rappresentato da `public`;
- modelli abilitati di questi provider, soltanto se associati ad account
  condivisi; il loro `accountId` è rappresentato da `public`.

Il bootstrap ospite ha `routeAvailability:[]` e non espone `providerLoads`.
`GET /api/dashboard` restituisce una vista ridotta della stessa infrastruttura;
lo storico aggregato dei token non è disponibile e viene rappresentato da
`stats.totals.total_tokens:null`, `stats.source:'unavailable'`.
`GET /api/telemetry` restituisce `{telemetry}` con la stessa rimozione di errori e
dettagli sensibili. Questi due endpoint conservano il payload ridotto anche
quando l'autenticazione è obbligatoria.

### Stream SSE

`GET /api/events?after=N` apre SSE; accetta anche `Last-Event-ID`, con precedenza
di `after`. Il cursore è un intero non negativo. Il limite è **otto stream per
utente autenticato** e **128 stream complessivi per tutti gli ospiti**, non 128
per IP. Il superamento restituisce `429 STREAMS` prima di aprire lo stream.

```text
id: 42
data: {"id":42,"runId":"run_...","type":"run.updated","createdAt":"...","data":{"status":"executing"}}

```

Il payload è `RunEvent` senza `ownerId`, filtrato sul proprietario autenticato.
Gli eventi durevoli hanno ID positivo. Testo in streaming, telemetria, routing e login
possono essere effimeri con `id:0`, senza campo SSE `id`: non azzerare il cursore
durevole. Il replay è limitato a 500 eventi; raggiunto il limite, un evento
`state.changed` con `data.replayTruncated:true` richiede di rileggere lo stato.
Sono presenti heartbeat ogni 15 secondi.

Gli heartbeat a 15 secondi sono commenti SSE di mantenimento della connessione.
Separatamente, `routing.updated` viene emesso ogni **due secondi**, con `id:0`,
usando lo stato corrente di scheduler e sonde. Non crea un nuovo campione di
telemetria, non è persistito nella timeline e non va interpretato come progresso
di un agente. Per l'utente autenticato, `data` contiene
`{resourceUsage,routeAvailability,providerLoads}` filtrato per accesso. Per
l'ospite contiene soltanto `{resourceUsage}`.

`telemetry` segue il refresh configurato delle sonde (`telemetryIntervalMs`,
default 10 secondi). Agli autenticati invia telemetria, occupazione,
disponibilità e carico dei provider accessibili; all'ospite soltanto telemetria
pubblica e occupazione aggregata. L'ospite non riceve gli eventi privati degli
utenti, compresi delta, istruzioni e codici di login.

La UI usa `message.delta`, `task.delta`, `task.updated`, `run.updated`,
`approval.created`, `evidence.created`, `account.login`, `telemetry`,
`state.changed`. Ricaricare bootstrap/conversazione ai cambiamenti rilevanti,
raggruppando gli aggiornamenti: i delta non sostituiscono lo stato persistito.

Gli eventi 0.4 rendono osservabili le fasi senza richiedere percentuali simulate:

| Evento | Dati e significato |
| --- | --- |
| `request.classified` | `{mode,requestedMode,intent}`; scelta del percorso chat/missione. |
| `service.reply` | `{intent}`; risposta deterministica, senza chiamare un modello. |
| `context.started` | Avvio della ricerca del contesto per il task. |
| `context.warning` | `{error}`; per esempio, ricerca vettoriale non disponibile e ripiego lessicale. |
| `context.ready` | `{includedSources,estimatedTokens,contextMs}`; contesto compilato, token stimati. |
| `route.queued` | `{queuedAt,waitedMs,position,candidateIds,busyResourceIds}`; attesa effettiva sulle risorse condivise dalle alternative. La posizione non è una stima del tempo residuo. |
| `route.selected` | Decisione registrata nel task: `{requestedRouteId,chosenRouteId,switched,waitMs,reason}` quando viene effettuata la selezione iniziale; le prenotazioni successive mantengono la route scelta. |
| `inference.started` | `{routeId}` e, nel percorso HTTP, `queueMs`/`loadMs`. |
| `inference.completed` | Nel percorso HTTP, `{routeId,durationMs}` quando viene ricevuto il risultato. |
| `routing.updated` | Snapshot effimero di disponibilità; contratto distinto dalla telemetria hardware. |

`message.delta` contiene `{messageId,delta,offset}`; usare l'offset per non
duplicare frammenti già compresi in uno snapshot. `task.delta` contiene `delta`
e può includere l'offset del runtime. Le metriche della risposta possono
includere `queueMs`, `contextMs`, `loadMs`, token, TTFT e prefill secondo quanto
effettivamente osservato. Un campo assente resta sconosciuto; i token stimati del
contesto non sono misure di memoria GPU.

## Progetti e workspace

| Endpoint | Contratto |
| --- | --- |
| `POST /api/projects` | `{name,description?,memberIds?,routes?,routing?,targetId?,workspace?,verifyRecipeIds?,deploymentRecipeId?}` → `201 Project`. |
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

## Disponibilità e preferenze di routing

Il progetto può conservare `routing`. Il body di un messaggio può fornire una
preferenza per quella richiesta; in sua assenza si usano le preferenze del
progetto, filtrando le route non accessibili al chiamante.

```json
{
  "strategy": "auto",
  "fallbackRouteIds": ["mdl_account_alternativo"],
  "maxWaitMs": 8000
}
```

`strategy` accetta `auto` o `pinned`. Il default è `auto` con una lista vuota:
non autorizza l'uso di tutti i modelli disponibili. `auto` può selezionare
soltanto la route richiesta e le alternative esplicitamente indicate, fino a
32 ID; `pinned` attende esclusivamente la route richiesta. Le alternative
esplicite non accessibili producono errore. Ruolo del task, capacità, contesto,
permessi native, stato account, quote e risorse restano controllati dal router.

`maxWaitMs` è un intero da 0 a 120.000. Se non configurato, l'attesa massima di
prenotazione è 8 secondi per chat e 30 secondi per gli altri ruoli; zero richiede
disponibilità immediata. Il tempo trascorso è osservato, non una previsione.
Scaduta l'attesa, il risultato è `QUEUE_TIMEOUT`; una scelta diversa è possibile
prima dell'inferenza, senza spostare silenziosamente una risposta già iniziata.

Ogni elemento di `Bootstrap.routeAvailability` comprende:

| Campo | Significato |
| --- | --- |
| `routeId`, `status` | `available`, `busy`, `cooldown`, `disabled`, `unavailable` o `unknown`. |
| `activeCount`, `queueCount` | Prenotazioni e richieste in coda osservate dal coordinator. |
| `externalActiveRequests`, `externalQueuedRequests` | Contatori opzionali del motore; possono includere richieste avviate dal coordinator e non vanno sommati ai precedenti. |
| `resourceGroupIds`, `busyResourceIds`, `busyResourceLabels` | Risorse della route e risorse occupate osservate. |
| `oldestWaitMs`, `cooldownUntil` | Attesa già trascorsa e termine del cooldown, quando noti. |
| `reason`, `observedAt`, `source` | Motivo, istante e fonte: `coordinator`, `provider` o `configuration`. |

`available` secondo il coordinator non costituisce un test di salute del
provider. Le percentuali GPU non provano da sole che un motore sia libero o
occupato. Le sonde di carico, quando definite nel file operatore, possono
contribuire con occupazione effettiva del motore; una sonda configurata con dato
ignoto o scaduto non viene trattata come disponibilità verificata.

`providerLoads` contiene osservazioni `source:'engine'`, `providerId`,
`kind:'llama-slots'|'json'`, `status:'available'|'busy'|'unknown'|'stale'`, motivo,
istanti e contatori opzionali `activeRequests`, `queuedRequests`, `capacity`.
Non contiene URL delle sonde, prompt o parametri grezzi degli slot. Gli endpoint
delle sonde sono configurazione operatore, non campi accettati dal messaggio.

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
  "mode": "auto",
  "routing": {"strategy": "auto", "fallbackRouteIds": []},
  "attachmentIds": ["art_..."],
  "permissions": {"write": true, "commands": true, "deploy": false},
  "maxIterations": 3,
  "maxParallel": 3
}
```

`mode` è `auto`, `chat` o `mission`, con default **`auto`**; `text` è limitato a
100.000 caratteri. Gli allegati
sono al massimo 12, dello stesso proprietario e progetto. `maxIterations` e
`maxParallel` sono interi da 1 a 6, default 3. Le autorizzazioni omesse sono
false. `write`/`commands` possono preautorizzare i tool previsti; `deploy` è il
grant esplicito per la ricetta di rilascio della missione, mantenendo i gate
di verifica del controller.

Auto usa il classificatore deterministico condiviso in
[`intent.ts`](../src/intent.ts): le normali domande vanno in chat; le direttive
esplicite di modifica/esecuzione possono aprire una missione. `mission` forza
quel percorso; `chat` mantiene il percorso conversazione. La scelta del
percorso non concede alcun permesso di scrittura o rilascio.

Saluti brevi, ringraziamenti, presenza, aiuto e forme riconosciute di richiesta
stato/modelli, senza allegati, usano una risposta deterministica del servizio.
Anche con `mode:'chat'` possono usare questo percorso; `mode:'mission'` lo
esclude. Non è un classificatore semantico generale: una domanda diversa viene
inoltrata alla chat del modello.

Una risposta del servizio non richiede un modello disponibile, non prenota
inferenza o workspace e può essere aggiunta alla stessa conversazione mentre
una missione resta aperta, senza metterla in pausa. L'endpoint restituisce
comunque `202 Run`, già `succeeded`, e persiste la risposta con
`ChatMessage.source:'service'`, senza route o metriche inventate. Le risposte
chat del modello hanno `source:'model'`; il campo rimane opzionale per messaggi
storici e altri risultati. Il run conserva `requestedMode`, il `mode` risolto e
`intent:'conversation'|'work'|'service'`.

`routeId` è facoltativo nel body: per l'inferenza viene cercato anche nella
conversazione e nel progetto. Se non esiste una route, una domanda che richiede
inferenza riceve `409 MODEL_REQUIRED`; il percorso servizio resta utilizzabile.

La chat HTTP non esegue tool. Le missioni richiedono operator/admin, target e
almeno una ricetta di verifica eseguibile. Anche le CLI native fuori dalle
missioni richiedono operator/admin e mantengono i limiti dell'adapter:
Antigravity non è disponibile per ruoli di sola lettura. Una richiesta
accettata può poi fallire nel controllo delle capacità; la causa appare nel run.

Una conversazione ammette un solo run non terminale che richiede inferenza;
l'eccezione è la risposta del servizio descritta sopra. Il coordinator limita le
attività attive a quattro per utente e 32 totali, senza consumare questi slot per
le risposte immediate del servizio.

| Percorso | Budget e timeout |
| --- | --- |
| Chat | Una chiamata modello, fino a 4.096 token output; limite complessivo 120 secondi. La chiamata HTTP upstream ha timeout 90 secondi. La chat non acquisisce il lock esclusivo del workspace. |
| Missione | Budget iniziale 48 chiamate modello e 64.000 token output; limite complessivo 60 minuti. |
| Risposta del servizio | Zero chiamate modello consumate; risposta calcolata dal coordinator e salvata subito. |

Questi sono limiti di esecuzione del prodotto, non il saldo commerciale del
provider. I limiti del modello e il budget residuo possono ridurre ulteriormente
l'output.

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

`INFERENCE_INTERRUPTED` interrompe il run quando si verifica un errore dopo
output parziale o dopo un tool che ha modificato il workspace. Output ed
evidenze sono conservati; il controller non ripete automaticamente la chiamata
né passa a un altro account per ricominciare lo stesso lavoro. Prima di una
ripresa esplicita occorre considerare l'esito già prodotto e il budget residuo.
Una chat che ha consumato la propria unica chiamata non ottiene nuovo budget
premendo resume.

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

### Percorso guidato di collegamento

Il client 0.4 usa un'unica operazione recuperabile per creare o riutilizzare
provider/account, verificare l'accesso e scoprire i modelli. I dettagli dei
runtime, degli stati e del collaudo sono in
[`CONNECTIONS.md`](CONNECTIONS.md).

| Endpoint | Contratto |
| --- | --- |
| `GET /api/connections/options` | `{presets,configured,detectionScope}`; utente non viewer. I preset per nuovi provider sono disponibili agli operator/admin; i member vedono connessioni HTTP già disponibili. |
| `POST /api/connections/detect` | `{}` → `{candidates,scope}`; operator/admin. Verifica Ollama/LM Studio sul loopback del coordinator e gli endpoint configurati visibili, senza scansione LAN o avvio di modelli. Timeout complessivo 8 secondi. |
| `POST /api/connections` | `ConnectionInput` → `200 ConnectionResult`; utente non viewer, con ulteriori controlli di ruolo/proprietà. Timeout della verifica 15 secondi. |

Esempio di collegamento di un servizio locale, raggiungibile dal coordinator:

```json
{
  "preset": "ollama",
  "baseUrl": "http://01-evo-x3:11434",
  "accountLabel": "Principale",
  "requestId": "identita-stabile-del-tentativo"
}
```

I preset sono `codex`, `antigravity`, `openai`, `gemini`, `ollama`, `lmstudio`,
`gemrouter`, `custom`. Il body può contenere anche `providerId`, `accountId`,
`label`, `secret`, `shared`, `nodeIds`, `resourceGroupIds`, `modelIds`. Gli alias
`openai-compatible` e `openai-responses` corrispondono a `custom` e `openai`.
Comandi, argv, environment e indirizzi delle sonde non sono accettati.

OpenAI, Gemini, Ollama e LM Studio hanno URL predefiniti; per un servizio su
un'altra macchina fornire il suo indirizzo. Codex/Antigravity usano la CLI sul
coordinator e non accettano una chiave API come sostituto del login ufficiale.
Un member può collegare il proprio account HTTP a un provider disponibile;
creare un nuovo endpoint, usare native o condividere account richiede
operator/admin.

La risposta contiene sempre `provider`, `account`, `models`, `status`,
`message`, `warnings` e `reused:{provider,account}` una volta registrato il
collegamento. Può contenere `nextAction:{kind,label,accountId?,command?,docsUrl?}`:

| Stato | Significato |
| --- | --- |
| `ready` | Discovery completata; i modelli restituiti sono quelli osservati. |
| `standby` | Motore configurato con attivazione su richiesta; la disponibilità attuale non è stata osservata. |
| `login-required` | Serve il login ufficiale; `nextAction.kind:'login'` identifica il percorso guidato disponibile. |
| `setup-required` | Runtime o configurazione da completare; per esempio, istruzioni ufficiali del profilo Antigravity. |
| `unverified` | ID modello dichiarati manualmente quando la discovery non è disponibile; non è un esito di inferenza verificato. |
| `unavailable` | Verifica non riuscita; il collegamento registrato rimane recuperabile tramite retry. |

Questi esiti recuperabili possono essere HTTP 200. Payload non valido, permessi
insufficienti, conflitti o limiti del servizio conservano gli errori HTTP
appropriati. Non interpretare il solo 200 come `status:'ready'`.

`requestId` conserva l'identità dell'iscrizione per utente e impedisce di creare
duplicati durante retry. Ripetere la richiesta verifica nuovamente il
collegamento; non equivale a un cache hit della precedente discovery.
`accountId` permette di correggere il segreto dello stesso account. Cambiare
l'URL di un provider già registrato è rifiutato con `ENDPOINT_CHANGED`: iniziare
un nuovo collegamento. Per un secondo account usare un nome distinto; il nome
predefinito `Principale` può riutilizzare il proprio account esistente.

Omettere `nodeIds`/`resourceGroupIds` conserva le assegnazioni esistenti; `[]`
è una rimozione esplicita. Un operatore proprietario può aggiornare questi
campi per un provider creato dalla UI solo quando non ha richieste/run aperti;
altrimenti riceve `TOPOLOGY_BUSY`. Le assegnazioni di provider definiti nel file
di configurazione non sono modificabili da questo percorso
(`CONFIGURED_PROVIDER`). `modelIds` è una dichiarazione manuale per endpoint
senza catalogo, fino a 32 ID; non è accettato per le CLI native.

Ogni candidato del rilevamento contiene
`{preset,label,baseUrl,providerId?,modelCount,status,message}`. Qui `status` è
`available`, `standby` o `unavailable`: è il risultato della verifica del
catalogo, distinto dalla disponibilità di una route nello scheduler.

### Endpoint di catalogo e gestione account

Restano disponibili gli endpoint separati, anche se il wizard usa il percorso
guidato precedente:

| Endpoint | Contratto |
| --- | --- |
| `POST /api/providers` | Operator/admin. `{label,kind,baseUrl?,tag?,nodeIds?,resourceGroupIds?}` → `201 Provider`. |
| `POST /api/accounts` | `{providerId,label,secret?,shared?}` → `201 Account`; privato su provider disponibile, condivisione solo operator/admin. |
| `POST /api/accounts/:id/discover` | Proprietario; `{}` → `{models,account,warnings}`, limite 45 secondi. Native solo operator/admin. |
| `POST /api/accounts/:id/login` | Proprietario, operazione native solo operator/admin; `{}` → `202 {operationId}`, esito attraverso `account.login`. |
| `PATCH /api/models/:id` | Operator/admin e proprietario dell'account; `{label?,contextWindow?,capabilities?,resourceGroupIds?}` → `ModelRoute`. |

Provider HTTP: `openai-compatible`, `openai-responses`, `ollama`, `gemini`.
Codex e Antigravity sono entrambi creabili dall'operatore, anche da
`POST /api/providers`, con comando ufficiale fisso rispettivamente `codex` e
`agy`. Il runtime deve essere installato e disponibile al processo coordinator;
creare il record non installa la CLI e non completa l'autenticazione.
Comandi CLI, argv ed environment arbitrari non sono campi della UI.
`tag` è `gemrouter`, `cluster`, `cloud` o `local`; GemRouter è un provider
`openai-compatible` con relativo tag.

Gli account native non sono condivisibili. Codex isola il profilo per account;
Antigravity ammette un solo account nel servizio. Creazione, discovery, login
ed esecuzione native escludono i member anche in presenza di record legacy.
Il login asincrono può terminare con un evento di errore dopo il `202`.

Il login guidato Codex inoltra URL/codice ufficiali effimeri; Antigravity usa una
CLI autenticata tramite `agy acp --login` con lo stesso utente Unix del
coordinator, seguito da una nuova verifica; non offre OAuth guidato nel webview.
La discovery Antigravity legge i modelli effettivamente esposti da ACP. Se il
runtime non espone una scelta, la route `current` significa **modello corrente
della CLI**, non un nome Gemini dedotto. Rimane utilizzabile per il ruolo
sviluppatore, non per orchestratore/revisore in sola lettura.

`account.login` contiene `operationId`, `accountId` e `status`. `pending` può
contenere URL/codice temporanei; `complete` viene emesso soltanto dopo discovery
riuscita e contiene `discovered:true`, `models`, `warnings`. Un errore produce
`status:'error'` con `message`. Il client non deve avviare una seconda discovery
al ricevimento di `complete`.

Il catalogo restituisce `hasSecret`, mai il segreto. Nell'endpoint separato
`/api/accounts/:id/discover`, un errore di autenticazione del provider
diventa `502 UPSTREAM`, distinto dal `401` di login yed1z; un limite di quota
osservato diventa `429 QUOTA` e aggiorna il cooldown.

Capacità modificabili: `chat`, `tools`, `embedding`, `vision`; `contextWindow`
da 4.096 a 2.000.000. Dichiarare una capacità non prova il comportamento reale
del modello. Quote ignote rimangono ignote; lo switch di account è esplicito
o limitato alle alternative di routing autorizzate, e non ripete automaticamente
il lavoro già iniziato. `capabilitySource:'provider'|'operator'|'unknown'`
indica la provenienza delle capacità; un catalogo che espone solo ID non prova
tool calling o ampiezza del contesto.

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
possibili. Il body webview di `POST /api/connections` e `POST /api/accounts`
può usare `requestSecret:true`:
l'host chiede la chiave in un input password, rimuove il flag e invia `secret`
solo al server. Il flag appartiene al bridge, non all'API pubblica.

Limiti host: 120 secondi per HTTP, 16 richieste concorrenti. HTTPS obbligatorio
per gateway pubblici, HTTP ammesso su destinazioni locali/private, redirect
rifiutati. In Remote SSH, localhost è risolto dall'extension host remoto.

Non esistono RPC pubblici per shell, host o percorsi assoluti arbitrari, né per
leggere i segreti del coordinator.
