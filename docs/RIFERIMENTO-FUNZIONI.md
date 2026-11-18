# Riferimento delle interfacce HTTP

Usa questo indice per scegliere il metodo, il percorso, l’identità e i dati di una richiesta. Gli ID fra parentesi graffe provengono dal bootstrap o dalla risposta di creazione. L’origine del servizio condiviso è `https://yed1z.ai`. Il servizio di inferenza eventualmente installato su un altro nodo ha un proprio indirizzo e una propria credenziale.

- [Dashboard, sessione e preferenze](#dashboard-sessione-e-preferenze)
- [Progetti e conversazioni](#progetti-e-conversazioni)
- [Controllo di missioni, task e approvazioni](#controllo-di-missioni-task-e-approvazioni)
- [Connessioni, account e catalogo](#connessioni-account-e-catalogo)
- [Documenti, memorie e citazioni](#documenti-memorie-e-citazioni)
- [Misure, switch e utenti](#misure-switch-e-utenti)
- [Inferenza compatibile OpenAI e alias](#inferenza-compatibile-openai-e-alias)
- [Errori e recupero](#errori-e-recupero)
- [CLI, configurazione, nodi e comandi VS Code](RIFERIMENTO-CLI.md)

## Convenzioni di accesso

Le chiamate da un client usano `Authorization: Bearer <chiave personale del Gateway>`. Le chiavi dei provider risiedono nei rispettivi account sul coordinator. Il browser può usare il cookie HTTP-only `yed1z_session` dopo il login. Le modifiche con cookie richiedono un’origine ammessa dal coordinator. Invia i corpi come oggetti JSON con `Content-Type: application/json`. Il limite del corpo è 7 MiB e alcune operazioni applicano limiti più piccoli. Gli esiti JSON hanno `Cache-Control: no-store`. La risposta 202 conferma la presa in carico. L’esito arriva negli eventi. Un client evita di inserire credenziali nella query, che viene rifiutata.

| Identità | Accesso operativo |
|---|---|
| Ospite | Monitor, bootstrap ed eventi pubblici se `publicDashboard` è abilitato. Il bootstrap pubblico contiene una proiezione del cluster. |
| `viewer` | Letture autorizzate, ricerca testuale di progetto e modifica del proprio aspetto. |
| `member` | Può creare un progetto, usare le proprie conversazioni e memorie, collegare un account HTTP personale sui provider accessibili e inviare inferenza sulle rotte concesse. |
| `operator` | Può inoltre collegare provider, gestire modelli e account propri, avviare missioni e runtime nativi, configurare l’esecuzione autorizzata e comandare i motori. |
| `admin` | Può anche amministrare utenti e impostazioni dei progetti. Oggetti con controllo di proprietà come conversazioni, account e run restano legati al titolare. |

I metodi di lettura di una lista di progetti, conversazioni, modelli, approvazioni, memorie o allegati della UI passano da `GET /api/bootstrap`. Il dettaglio di una conversazione, i risultati della Knowledge e la storia di un run hanno anche rotte dedicate. Tipi pubblici ed esempi completi sono disponibili nel monorepo. [Contratti](../src/contracts.ts) · [Esempi JSON e SSE](API.md)

## Dashboard, sessione e preferenze

| Metodo e percorso | Dati, risultato e accesso |
|---|---|
| `GET /`, `GET /index.html`, `GET /cockpit/classic` | Caricano l’HUD hardware storico con chassis, indicatori e telemetria. Le risorse grafiche storiche usano `/static/`. Le pagine supportano anche HEAD. |
| `GET /control`, `GET /control/`, `GET /control/index.html` | Aprono la Control Room di progetto. Il frammento del link a una missione può contenere `project`, `conversation`, `run` e `view=journey`. |
| `GET /cockpit` | Apre Fleet monitor. Il server serve JS, CSS e icona dalla lista di asset `/assets/`. Anche Control Room, Fleet e relativi asset supportano HEAD. |
| `GET /health`, `GET /api/health` | Stato HTTP del coordinator, `ok`, `status`, versione e prima etichetta motore osservata oppure `null`. Accesso pubblico. |
| `GET /api/dashboard` | Proiezione per il monitor con infrastruttura, misure, stato motori e contatori della facciata. Richiede un utente se il monitor pubblico è disabilitato. |
| `GET /api/telemetry` | Formato per i client storici. Include motore attivo, velocità, richieste in volo, misure a monte, aggregati giornalieri (ultimi 30 giorni) e fino a 15 sessioni API del richiedente. Per l’ospite le sessioni personali sono vuote. |
| `POST /api/login`, `POST /api/auth/verify` | Corpo con `token`. Accetta anche `key` o l’alias storico `admin_key`. Restituisce `{ok,user}` e cookie di sessione per 12 ore. Le chiavi errate ripetute attivano la limitazione per indirizzo. |
| `POST /api/logout` | Chiude la sessione corrente e fa scadere il cookie. La chiave personale continua a essere la credenziale usata per un successivo login. |
| `GET /api/bootstrap` | Stato iniziale autorizzato. Il client vi trova utente, progetti, conversazioni, run, prove, connessioni, disponibilità delle rotte, target e telemetria ammessi. |
| `GET /api/events` | Stream SSE personale o pubblico. Ripresa con `?after=ID` oppure `Last-Event-ID`. Fino a 500 eventi arretrati, segnale `replayTruncated` per rileggere il bootstrap, heartbeat ogni 15 s. Limite di 8 stream per utente e 128 complessivi per gli ospiti. |
| `GET /api/me/appearance` | Preferenze del titolare, oggetto vuoto alla prima visita. |
| `PATCH /api/me/appearance` | Accetta una o entrambe le proprietà `theme` (`system`, `light`, `dark`) e `motion` (`on`, `off`). Unisce i campi indicati e restituisce l’oggetto aggiornato, anche per un lettore autenticato. |

## Progetti e conversazioni

| Metodo e percorso | Dati, risultato e accesso |
|---|---|
| `POST /api/projects` | `name`, eventuali `description`, `routes` e `routing`. Crea un progetto del richiedente e restituisce 201. Se configurata e accessibile, assegna una rotta embedding iniziale. Limite di 100 progetti propri. |
| `PATCH /api/projects/{id}` | Titolare o admin. Aggiorna nome, descrizione, rotte per `primary`, `coder`, `reviewer`, `researcher`, `embedding` e strategia di routing. Per le rotte un valore vuoto cancella l’associazione. Impostare `memberIds`, `targetId`, `workspace`, `workspaceIsolation`, `verifyRecipeIds` o `deploymentRecipeId` richiede inoltre un operatore. Il workspace è relativo al target. Un run aperto impedisce il cambio di configurazione. |
| `POST /api/conversations` | `projectId`, opzionali `title` e `routeId`. Crea la conversazione personale nel progetto accessibile. Restituisce 201 con il suo ID. |
| `GET /api/conversations/{id}` | Restituisce la conversazione propria, inclusi messaggi, rotte attribuite e metriche disponibili. |
| `DELETE /api/conversations/{id}` | Elimina la conversazione propria. Un run ancora aperto restituisce 409. |
| `POST /api/conversations/{id}/branch` | `messageId` ed eventuale `title`. Crea un ramo personale con i messaggi fino al turno indicato incluso e un riferimento al padre. Un turno ancora in streaming impedisce la copia. |
| `POST /api/conversations/{id}/messages` | `text`, eventualmente `mode` (`auto`, `chat`, `mission`), `routeId`, `routing`, fino a 12 `attachmentIds`, `permissions` (`write`, `commands`, `deploy`), `maxIterations` e `maxParallel` da 1 a 6, `parentRunId` e `workspaceIsolation`. Restituisce 202 con il run. Le domande di stato riconosciute possono ottenere una risposta del servizio senza inferenza. Le missioni e le CLI native richiedono un operatore fidato. |

In `routing`, `strategy: "pinned"` mantiene il modello richiesto. Con `"auto"` si possono indicare fino a 32 `fallbackRouteIds` autorizzati e `maxWaitMs` da 0 a 120000. Il selettore considera stato dell’account, capacità richieste, carico recente e gruppi hardware. Le quote sconosciute restano tali. [Routing, priorità e attesa](ROUTING.md)

## Controllo di missioni, task e approvazioni

Tutti i controlli identificano un run o un task del richiedente. Un’azione disponibile dipende anche dalla fase della missione. Le procedure di riconciliazione, promozione e rilascio sono riservate a operatori fidati.

| Metodo e percorso | Dati, risultato e accesso |
|---|---|
| `GET /api/runs/{id}/events` | Registro durevole JSON, ordinato per ID, fino a 200 eventi. Passa `?after=ID` e continua con `nextCursor` fino a `null`. Serve per ricostruire il grafo anche dopo lo scollegamento. |
| `POST /api/runs/{id}/pause` | Richiede la pausa del run, conservando task ed evidenze. |
| `POST /api/runs/{id}/resume` | Riprende un run ammesso dalla macchina a stati. Può richiedere prima la riconciliazione di un effetto incerto. |
| `POST /api/runs/{id}/cancel` | Richiede la cancellazione e conserva il registro di ciò che è già avvenuto. |
| `POST /api/runs/{id}/steer` | `text` e fino a 12 `attachmentIds` personali nello stesso progetto. Registra istruzioni per la squadra e richiede una pausa per riallineare il lavoro. |
| `POST /api/runs/{id}/reconcile` | `operationId`, `outcome` (`applied`, `not_applied`, `rolled_back`) e `note` con prova osservata. Registra come trattare l’effetto incerto. Per le operazioni Git si ripete l’azione sullo stesso candidato e si riconcilia il riferimento effettivo. |
| `POST /api/runs/{id}/promote` | Richiede `verificationDigest`, SHA-256 della verifica. Crea il ramo al commit candidato nel worktree verificato e registra il riferimento. |
| `POST /api/runs/{id}/cleanup` | Pulisce un worktree ammesso dopo avere controllato stato e modifiche residue. |
| `POST /api/runs/{id}/release` | Avvia il rilascio verificato e restituisce 202. Accetta `verificationDigest` facoltativo. Controlla lo stato, il target, la ricetta e la revisione prima di seguire verifica, approvazione, deploy e health check. |
| `POST /api/tasks/{id}/route` | `routeId`. Assegna una rotta autorizzata al task nello stato previsto. Il registro permette di distinguere scelta iniziale e tentativi successivi. |
| `POST /api/tasks/{id}/pause` | Corpo `{}`. Mette in pausa un ricercatore o coder in missione attiva. Le dipendenze determinano quali altri task possono proseguire. |
| `POST /api/tasks/{id}/resume` | Corpo `{}`. Riprende l’agente precedentemente sospeso. |
| `POST /api/tasks/{id}/steer` | `text`. Aggiunge istruzioni al singolo agente controllabile. |
| `POST /api/tasks/{id}/cancel` | Corpo `{}`. Annulla il ramo dell’agente controllabile. |
| `POST /api/approvals/{id}` | `approved: true` oppure `false`. Registra la decisione del proprietario sulla richiesta pendente correlata all’operazione. |

Per il deploy il runner valuta dalla macchina di esecuzione lo stato HTTP atteso, l’eventuale testo e i tentativi configurati. Nel registro si distinguono verifica, effetto, esito health e risultato del rollback. [Esecuzione e rilascio](EXECUTION.md)

## Connessioni, account e catalogo

Un provider rappresenta il protocollo e l’indirizzo. Un account rappresenta una credenziale o un profilo. Una rotta associa modello e account, con capacità e risorse proprie. Gli endpoint restituiscono ID distinti per queste tre entità.

| Metodo e percorso | Dati, risultato e accesso |
|---|---|
| `GET /api/connections/options` | Preset e connessioni visibili per il wizard. I membri trovano i provider HTTP utilizzabili. I preset di creazione sono per operatori. Il lettore non configura account. |
| `POST /api/connections/detect` | Corpo `{}`, operatore. Sonda indirizzi previsti sul coordinator e provider configurati, restituisce candidati e stato. |
| `POST /api/connections` | Crea, riutilizza o aggiorna una connessione. Campi principali `preset`, `providerId`, `accountId`, `label`, `accountLabel`, `baseUrl`, `secret`, `shared`, `quotaDomain`, `requestId`, `nodeIds`, `resourceGroupIds`, `modelIds`. Il risultato riporta account, catalogo, avvisi e prossimo passo. Preset Codex, Antigravity, OpenAI, Gemini, Ollama, LM Studio, GemRouter e personalizzato. Il membro collega credenziali proprie su provider HTTP già autorizzati. L’operatore proprietario può associare un dominio di quota e cambiare risorse. |
| `POST /api/providers` | Operatore. `label`, `kind`, eventuali `baseUrl`, `nodeIds`, `resourceGroupIds`, `tag`. Crea il provider (201). Tipi di trasporto e configurazione nel riferimento CLI. |
| `POST /api/accounts` | `providerId`, `label`, eventuali `secret` e `shared`. Crea l’account (201). La condivisione e le identità native sono soggette ai controlli dell’operatore. |
| `GET /api/accounts/{id}/delegates` | Operatore titolare. Restituisce `eligible`, `userIds`, `shared`. I candidati dipendono dal team e dal tipo di provider. |
| `PUT /api/accounts/{id}/delegates` | Operatore titolare. Sostituisce la lista con `userIds` (fino a 128) e `shared` booleano. Per CLI native occorrono operatori nominativi e `shared: false`. La revoca aggiorna le viste interessate. |
| `POST /api/accounts/{id}/discover` | Titolare. Rilegge modelli e osservazioni di quota con le credenziali dell’account, fino a 45 s. Restituisce rotte, stato e avvisi, compreso standby se rilevato. |
| `GET /api/accounts/{id}/login` | Restituisce lo stato del login nativo del profilo personale. |
| `POST /api/accounts/{id}/login` | Operatore titolare. Avvia il login ufficiale del profilo e restituisce 202. Segui URL e operazione, quindi osserva lo stato o gli eventi `account.login`. |
| `POST /api/accounts/{id}/login/respond` | Per un login che attende input, invia `operationId` e `code` al processo dell’operazione corrente (202). È il percorso utilizzato per completare il consenso Google richiesto da Antigravity. |
| `DELETE /api/accounts/{id}/login` | Annulla il tentativo di login in corso del profilo e restituisce lo stato. |
| `POST /api/models` | Operatore titolare. `providerId`, `accountId`, `model`, eventuali `label`, `contextWindow`, `capabilities`. Crea una rotta manuale (201). Un duplicato per lo stesso account restituisce 409. |
| `PATCH /api/models/{id}` | Operatore titolare. Modifica etichetta, finestra di contesto, capacità (`chat`, `tools`, `vision`, `embedding`), gruppi di risorse e stato `enabled`. Una dichiarazione esplicita delle capacità viene conservata. |
| `DELETE /api/models/{id}` | Archivia la rotta e la disabilita. Le evidenze storiche mantengono l’ID. `PATCH` con `enabled: true` la riattiva. |

La guida alle connessioni descrive le interazioni con il runtime ufficiale e i casi con più profili sullo stesso host. [Configurazione dei provider](CONNECTIONS.md) · [Adapter e protocolli](ADAPTERS.md)

## Documenti, memorie e citazioni

| Metodo e percorso | Dati, risultato e accesso |
|---|---|
| `POST /api/artifacts` | `projectId`, `name`, `content` testuale. Salva il documento personale nel progetto con digest, restituisce i metadati (201) e può accodare l’indicizzazione locale. |
| `GET /api/artifacts/{id}` | Restituisce metadati e contenuto dell’allegato autorizzato. |
| `GET /api/artifacts/{id}/download` | Scarica lo stesso contenuto come testo UTF-8 con nome file normalizzato. |
| `DELETE /api/artifacts/{id}` | Elimina l’allegato proprio. La presenza di run personali aperti impedisce la rimozione. |
| `POST /api/memories` | `projectId`, `title`, `content`, `kind` (`method`, `decision`, `brief`, `document`), eventuali `scope` (`private`, `project`) e fino a 32 `sourceIds` personali nel progetto. Crea una candidata a revisione 1. |
| `PATCH /api/memories/{id}` | Aggiorna testo, titolo, scope o stato della propria memoria, crea la revisione e aggiorna l’indice. Per pubblicare nel progetto occorre l’autorità del responsabile. Una memoria approvata e visibile può entrare nel contesto. |
| `DELETE /api/memories/{id}` | Dimentica la memoria propria, elimina le sue revisioni e l’indice relativo. Una citazione salvata nei rapporti resta un riferimento storico sottoposto ai permessi correnti. |
| `POST /api/memories/search` | `projectId`, `query`. Contratto storico per cercare memorie visibili, una riga per memoria con punteggio, metodo e citazione. Per i lettori usare la ricerca di progetto qui sotto. |
| `POST /api/projects/{id}/knowledge/search` | `query`, eventuali `limit` (1–24, default 8) e `maxChars` (128–12000, default 6400). Restituisce passaggi, citazioni e rapporto di ricerca. Per i lettori la modalità è lessicale. Gli altri clienti possono usare il lettore ibrido quando dispone di vettori compatibili. |
| `GET /api/projects/{id}/knowledge/sources/{sourceId}` | Riapre la versione consultabile della fonte. Con `?revision=N&hash=SHA256` verifica la citazione. Accesso revocato o fonte assente dà 404, versione superata 409. |
| `POST /api/projects/{id}/reindex` | Aggiorna i vettori autorizzati usando la rotta embedding del progetto. Restituisce contatori di indicizzazione e riuso. `?force=1` ricostruisce anche i vettori correnti. Un progetto privo di rotta restituisce 409. |

La nota tecnica spiega come l’encoder locale, il recupero lessicale e la costruzione del contesto elaborano soltanto il corpus accessibile al richiedente. [Knowledge e metodo di lettura](KNOWLEDGE-MEMORILLA.md) · [Encoder locale](ENCODER-LOCALE.md)

## Misure, switch e utenti

| Metodo e percorso | Dati, risultato e accesso |
|---|---|
| `GET /api/usage` | Per l’utente corrente, aggrega richieste alla facciata (`gateway`), turni di conversazione (`conversationTurns`), chiamate nelle missioni (`missionCalls`) e storico importato (`legacy`). Ogni giro di un task può produrre una chiamata. Gli aggregati hanno perimetri diversi. Un valore nullo indica assenza di misura. |
| `POST /api/telemetry/refresh` | Utente abilitato alle modifiche. Esegue il refresh dei sensori configurati e restituisce `{telemetry}`. |
| `POST /api/switch` | Operatore. Indica `providerId` oppure `target` e `model`, per esempio `{"target":"strix","model":"qwen"}`. `aireward` è un alias di `cuda`. `action:"stop"` o `model:"stop"` richiede una ricetta di arresto configurata. L’operazione acquisisce le risorse della rotta e restituisce `ok`, `providerId`, `model`, `stopped`. |
| `GET /api/users` | Admin. Elenca gli utenti locali con ID e ruolo. |
| `POST /api/users` | Admin. Invia `name` e `role`. Crea l’utente, genera la sua chiave e la restituisce nella risposta 201. |

## Inferenza compatibile OpenAI e alias

Queste rotte richiedono sempre un header Bearer. Una rotta nativa Codex o Antigravity si invoca nelle conversazioni del progetto. I protocolli OpenAI-compatible, OpenAI Responses, Gemini e Ollama passano attraverso i rispettivi adapter.

| Metodo e percorso | Richiesta e risposta |
|---|---|
| `GET /v1/models` | Elenca le rotte abilitate per il titolare. Ogni elemento include `id` della rotta, `name`, `underlying_model`, `owned_by`, `aliases`, eventuale `context_length` ed `endpoints`. Per generare scegliere una rotta con capacità chat e, se richiesti, strumenti. |
| `POST /v1/chat/completions` | `model`, `messages`, eventuali `tools` di tipo function, `stream`, `max_completion_tokens` (alias `max_tokens`) e opzioni yed1z `routing`. Restituisce un oggetto completion o chunk SSE. I messaggi accettano i ruoli system, user, assistant e tool, inclusi risultati correlati con `tool_call_id`. |
| `POST /v1/responses` | `model`, `input` stringa o lista di messaggi testuali, eventuali `instructions`, `max_output_tokens`, function tool e namespace. Supporta `function_call`, `function_call_output`, risposta singola e streaming SSE. Per proseguire si ritrasmettono gli elementi necessari in `input`. Usare `store:false` e omettere `previous_response_id`. |

`X-Yed1z-Route` identifica l’account/rotta effettivamente scelto, `X-Yed1z-Queue-Ms` misura l’attesa. La facciata sceglie il modello richiesto per ID di rotta, alias o nome a monte univoco. La strategia predefinita è pinned. Per Auto elencare esplicitamente le alternative ammesse. Un HTTP 429 osservato prima della trasmissione di contenuto può permettere una nuova selezione. Il server conserva separatamente i contatori di uso ufficiali e le misure disponibili.

| Provider del template | Alias storici quando il provider ha un solo modello locale/cluster e non specifica alias propri |
|---|---|
| `strix-qwen` | `qwen38-uncensored-gufo`, `qwen`, `qwen38`, `qwen3.8`, `qwen-38b`, `qwen38-uncensored` |
| `strix-deepseek` | `ds41-abliterated-q2-imatrix`, `deepseek`, `deepseek-v4.1`, `deepseek-v4.1-flash`, `ds41`, `ds4.1` |
| `cuda-qwen` | `qwen38-strata-100tps`, `qwen-strata`, `strata-qwen`, `qwen38-strata`, `qwen3.8-flash-next-iq3_s`, `qwen-100tps`, `qwen-rtx3090` |
| `cuda-deepseek` | `ds41-strata-cuda`, `ds41-strata`, `strata-ds41`, `deepseek-strata`, `deepseek-v4.1-flash-ist-das-2.00bpw`, `deepseek-rtx3090`, `kirei-strata-cuda3090`, `kirei-strata` |
| `cuda-glm` | `glm-5.3-flash`, `glm53-flash`, `glm-5.3`, `glm5.3`, `glm`, `glm5`, `maya-glm`, `glm-rtx3090` |

La configurazione può dichiarare `providers[].models[].aliases`. Due account accessibili che risolvono lo stesso alias o nome rendono la selezione ambigua. Scegli l’ID `mdl_…` del catalogo per fissare anche l’identità. [Risoluzione degli alias](../src/model-aliases.ts) · [Formato Responses implementato](../src/responses-facade.ts)

## Errori e recupero

| Esito | Interpretazione e azione per il client |
|---|---|
| 400 / 415 | Controllare JSON, Content-Type, campi consentiti e tipo di modello o tool. Per `AMBIGUOUS_MODEL` usare l’ID di rotta. Il client può leggere `code` oltre al messaggio `error`. |
| 401 / 403 | Rinnovare la sessione Gateway se scaduta. Verificare ruolo, appartenenza e origine. Un errore di login del provider riguarda invece il relativo account. |
| 404 | L’endpoint, la rotta o l’oggetto richiesto è assente o non accessibile a quell’identità. |
| 409 | Leggere il codice specifico. Per un progetto o documento impegnato attendere la chiusura del run. Per un digest cambiato ripetere la verifica. Per un effetto incerto aprire la riconciliazione. |
| 413 | Ridurre il corpo, gli allegati, il contesto o il numero di elementi. |
| 429 / 503 | Possono riferirsi a quota, carico, coda o upstream. Leggere `Retry-After` quando disponibile, lo stato della rotta e la finestra di attesa. Distinguere un ritardo del provider dallo stato del coordinator su `/health`. |

Le prove e le misure reali di questa versione sono raccolte nel rapporto di consegna. [Rapporto sul cluster](CONSEGNA-1.0-RC1.md) · [Implementazione delle rotte](../src/server.ts)
