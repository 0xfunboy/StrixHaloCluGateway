# Handoff · yed1z Control Room 0.4.0

**Data:** 17 novembre 2026 · **Destinatario:** funboy / team yed1z.

## 1. Che cosa viene consegnato

Un aggiornamento del monorepo TypeScript che hai installato, con backend,
interfaccia web e plug-in VSCode coerenti. Il codice parte dall'archivio della
tua branch modificata e usa la dashboard originale come riferimento di stile
e topologia. La release comprende sorgenti, test, bundle pronti in `dist/`, VSIX,
documentazione tecnica e una storia Git esportabile.

L'obiettivo è ridurre i passaggi tra intenzione dell'utente e lavoro utile:
collegare un provider, scegliere modello/account, fare una domanda o avviare una
squadra, capire cosa sta aspettando e vedere risultati verificabili. La gestione
fisica resta distribuita: Strix 01, Strix 02, CUDA e provider esterni sono risorse
distinte, con inferenza separata dal target su cui si scrive o si esegue il codice.

**Stato operativo:** build e verifiche automatiche locali riportate in
`docs/VERIFICA.md` e `docs/VALIDATION.txt`. Non sono stati raggiunti i vostri
server, usati gli account commerciali, modificati servizi o pubblicato il nuovo
portale. Questa consegna permette il collaudo sul cluster; non certifica una
produzione che non è stata osservata.

**Verifica grafica residua:** Chromium nell'ambiente di sviluppo termina con
`socket() failed: Operation not permitted`. Il browser cloud ha rifiutato la
preview locale per policy; il blocco non è stato aggirato. I test DOM/HTTP sono
passati secondo il report, ma nessuno screenshot o collaudo grafico reale viene
dichiarato. Il gate visivo della sezione 7 deve essere eseguito su browser/VSCode.

## 2. Base, differenze e compatibilità

| Input | Ruolo | SHA-256 |
|---|---|---|
| `StrixHaloCluGateway-feature-distributed-control-room.zip` | Base installata e modificata dall'utente | `66ecba83071d170cdca6164547e2c3fa64aaaec94c00da1c55496350f424c34e` |
| `StrixHaloCluGateway-main_2.zip` | Dashboard storica e riferimenti di infrastruttura | `6438ba73ba10f1604147a832a27e35e9b97fd9366dcf30d98db314811e755578` |

Il commit iniziale della copia ricevuta è
`eb9f7f9e4bd96d252aad7c809fc94ec74fae06a0`. La patch inclusa nella confezione
documenta le modifiche rispetto a quella base. Il bundle Git consente di
ricostruire la branch senza dipendere da un push remoto.

Sono conservati la dashboard ospite, gli endpoint di monitor, il servizio
coordinator e le identità di account, modelli, progetti e conversazioni. Il VSIX
mantiene `funboy.haloforge`. Web e VSCode devono essere aggiornati insieme al
coordinator 0.4; il VSIX da solo non aggiorna il servizio.

Lo stato 0.3 mantiene le stesse tabelle; i nuovi campi JSON sono opzionali.
Non è richiesta una conversione distruttiva. I modelli rimossi da una discovery
completa vengono disabilitati e conservati per la cronologia, non eliminati.
Il rollback deve comunque usare il backup coerente precedente al cutover.

Non sostituire il tuo `config.json` con l'esempio: conserva IP, alias SSH,
percorsi, ricette e provider effettivi. La nuova configurazione opzionale è:

- `publicDashboard`: `true` per preservare il monitor pubblico; `false` per
  richiedere autenticazione anche al monitor.
- `providers[].maxConcurrent`: concorrenza del singolo account HTTP, da 1 a 16;
  default 4. Le CLI rimangono seriali per account. Non è la capacità della GPU.
- `providers[].loadProbe`: probe esplicito e facoltativo del carico dell'engine.
  Esempi e semantica sono in `docs/ROUTING.md`. Non è abilitato alla cieca sul
  template del cluster.
- `project.routing`: strategia `auto` o `pinned`, insieme di alternative
  autorizzate e attesa massima opzionale. Non vengono selezionati provider extra
  semplicemente perché sono visibili nel catalogo.

## 3. Problemi corretti e comportamento atteso

### Collegare modelli

Il nuovo wizard esegue un solo percorso `connessione → verifica → scelta del
modello`. Le impostazioni di topologia e gli ID manuali restano nelle opzioni
avanzate. Una richiesta ripetuta conserva provider/account e permette di
correggere la credenziale senza duplicati.

| Provider | Percorso reale | Limite da conoscere |
|---|---|---|
| Codex | Preset, CLI ufficiale disponibile al servizio, login ufficiale, discovery automatica, selezione modello/account. | Ogni account ha il proprio `CODEX_HOME`. La presenza della CLI nel terminale interattivo non prova che sia nel PATH di systemd. |
| Antigravity | Preset, verifica ACP della CLI, istruzione di login ufficiale quando necessaria, assegnazione allo sviluppatore. | Un solo profilo fidato sul servizio. Sola lettura, più profili isolati e quota numerica non sono verificati. Non è un sostituto generico del provider chat/planner. |
| API OpenAI/Gemini/compatibile | Preset, chiave se richiesta, endpoint se non noto, catalogo e selezione. | Un catalogo accessibile non prova generazione o tool calling. Un rifiuto upstream non deve disconnettere yed1z. |
| Ollama/LM Studio | Preset, endpoint, rilevamento sui runtime locali noti o endpoint configurati. | `localhost` è la macchina del coordinator. Per la 3090 occorre il suo indirizzo raggiungibile, non il localhost del browser. |
| GemRouter | Provider di inferenza selezionabile con il proprio endpoint e account. | Non è il coordinator o un secondo sistema di memoria. I limiti osservabili dipendono da ciò che l'endpoint espone. |

Antigravity non restituisce più ID Gemini inventati né un falso login riuscito.
Un endpoint in errore non viene promosso a pronto usando una lista in cache.
Lo standby resta possibile solo per motori con un'attivazione configurata.

Le capacità restano `unknown` quando non dichiarate. Ollama può arricchire fino
a 20 modelli con `/api/show`, quattro richieste parallele da un secondo ciascuna,
senza generare o caricare modelli. Il massimo architetturale del contesto non è
spacciato per il contesto realmente configurato in esecuzione.

Una modifica dell'associazione hardware è accettata soltanto per un provider UI
proprio e inattivo, da operator/admin. I campi omessi conservano la configurazione;
gli array vuoti espliciti la rimuovono. Un provider da file richiede di modificare
il file. Lease, code o run che usano il provider impediscono cambi di topologia
durante il lavoro. Le credenziali non vengono modificate se la guardia rifiuta
l'operazione.

### Rispondere subito alle domande semplici

**Auto** è il percorso iniziale. `come stai?`, un saluto o alcune richieste di
stato ristrette hanno una risposta del coordinator, indicata come **servizio**.
Non avviano planner, modello, embeddings, strumenti o task; funzionano anche se
gli engine sono spenti. Non si inventano token, TTFT o parole di un modello.

Una domanda ordinaria usa una sola completion di chat, senza workspace, squadra
o verifiche di un progetto. Il retrieval vettoriale opzionale ha un budget di
600 ms; se non è disponibile si usa il contesto testuale. Il timeout complessivo
della chat è 120 secondi, quello della chiamata HTTP 90 secondi e l'attesa delle
risorse 8 secondi per default. Questi sono limiti, non una promessa sul TTFT di
un motore lento o su un modello ancora da caricare.

Una richiesta operativa esplicita può diventare missione. La modalità scelta
manualmente prevale sulla classificazione del lavoro. I permessi di scrittura,
comando e rilascio restano espliciti. Un saluto durante una missione non deve
metterla in pausa; un'istruzione che la modifica usa invece lo steering previsto.

### Occupazione, alternative e quote

Il modello selezionato è una route modello/account. Il router considera
autorizzazione, capacità, contesto, cooldown, tutti i gruppi hardware del provider
e un semaforo dell'account. Le risorse vengono prenotate insieme, evitando che
una richiesta Dual Strix trattenga il primo nodo mentre aspetta il secondo.

In Auto può essere scelta un'alternativa esplicitamente inclusa nel pool, prima
di iniziare la richiesta. Con `pinned` si aspetta il modello scelto entro la
scadenza. Dopo l'inizio di un task, i successivi giri di strumenti restano sul
modello scelto. Un 429 o una risposta parziale non innesca una rotazione nascosta.
I default di un progetto condiviso vengono filtrati sui modelli accessibili
all'utente effettivo; non concedono accesso a un account privato altrui.

La UI distingue i conteggi del coordinator da quelli osservati nell'engine:
**non vanno sommati**, perché una stessa richiesta può essere presente in entrambi.
GPU al 90% non significa necessariamente slot pieni, e GPU allo 0% non prova
che un'operazione sia sicura. I probe sono la fonte opzionale per il carico esterno.

Un campione di carico non è un lock condiviso con programmi esterni. Per garantire
che nessuno spenga un modello in uso, tutte le richieste e commutazioni devono
passare da un unico controller di ammissione. Tenere due gateway con autorità di
switch sugli stessi nodi rimane un conflitto operativo.

### Effetti, interruzioni e recupero

Il test di regressione esegue davvero un comando che aggiunge una riga a un file;
la completion seguente fallisce e il comando deve risultare eseguito **una sola
volta**, anche con tre cicli di riparazione disponibili.

La 0.4 conserva testo parziale ed evidenze. `INFERENCE_INTERRUPTED` interrompe il
run quando il modello cade dopo un output o un effetto mutativo; non riapre un
ciclo automatico che ripeta il comando. Prima di una ripresa esplicita si deve
leggere lo stato del workspace. Questo non equivale a una garanzia universale di
esecuzione esattamente una volta di processi esterni non idempotenti.

## 4. Aggiornamento dell'installazione

### Prima del cutover

1. Identificare unità systemd attiva, directory di release, directory di stato,
   file di configurazione, utente Unix e PATH del servizio. L'unità di esempio è
   `systemd/yed1z-command.service`; usare i nomi effettivamente installati.
2. Finire o mettere in pausa le missioni e osservare che non rimangano azioni
   esterne in corso. Fermare il coordinator prima del backup completo.
3. Salvare **insieme** database, WAL/SHM se presenti, `master.key`, allegati,
   directory degli account native e configurazione. Conservare inoltre unità,
   environment file e configurazione del tunnel. Non mettere queste copie nel Git.
4. Estrarre la nuova release in una directory distinta, senza sovrascrivere quella
   precedente. Verificare gli hash della confezione e conservare il rollback.
5. Per provare lo stato, lavorare su una **copia** con porta e origine di staging.
   Rimuovere dalla configurazione di prova le attivazioni/deploy verso produzione
   oppure puntarle a risorse isolate. Due coordinator non devono controllare gli
   stessi engine commutabili, nemmeno se usano database diversi.
6. Confrontare la configurazione effettiva con le nuove opzioni. Il template è un
   riferimento, non la configurazione accertata del cluster.

Il runtime dei bundle richiede Node **24.15+ della linea 24**; questa consegna è
verificata con **24.22.1**. I bundle non richiedono `npm install` per avviarsi.

Per una prima installazione isolata, dalla radice estratta:

```bash
node dist/cli.mjs init --name funboy --workspace /percorso/workspace-di-prova --state /percorso/stato-di-prova
```

La radice workspace deve esistere. Adattare la configurazione di prova e avviare:

```bash
YED1Z_STATE_DIR=/percorso/stato-di-prova node dist/server.mjs
```

Per aggiornare la 0.3 esistente **non creare una nuova identità o rigenerare
`master.key`**. Puntare la nuova release alla copia coerente dello stato e usare
la stessa chiave yed1z. Il setup ripetuto preserva lo stato, ma non sostituisce
il backup e il controllo della configurazione.

### Riferimenti della topologia allegata

| Percorso | Associazione prevista nel template | Verifica necessaria |
|---|---|---|
| DeepSeek Strix, porta 18231 | `strix01-memory` + `strix02-memory` | Entrambi i nodi fanno parte del runtime effettivo; script di attivazione e model ID corretti. |
| Qwen Strix, porta 18562 | Solo `strix01-memory` | Il sorgente originale allegato indica esecuzione sul nodo 01; verificare che `cluster-model qwen` non tocchi comunque il nodo 02. |
| Qwen CUDA, porta 8080 | `cuda3090-memory` | Raggiungibilità da coordinator e corrispondenza tra modello attivo e `/models`. |
| DeepSeek CUDA, porta 8085 | Lo stesso `cuda3090-memory` | Esclusività con Qwen; lifecycle 8090 verificato contro il node-agent installato. |
| GemRouter | Endpoint/account configurato | Modelli e limiti reali; nessuna associazione fittizia alla memoria dei nodi locali. |

Gli indirizzi e le porte provengono dagli archivi, non da una scansione live.
Se il comando di cambio modello usa più nodi di quelli dell'inferenza, includere
nelle risorse **anche quelli che il comando modifica**. La corretta esclusività
dipende dalla reale superficie degli effetti, non solo dalla destinazione HTTP.

### Cutover e rollback

Dopo i gate delle sezioni 6 e 7, fermare il vecchio coordinator, verificare che
non restino runtime/azioni di missioni in corso e aggiornare il riferimento della
unità alla nuova release. Avviare un solo servizio e verificare health, login,
conversazione conservata e una richiesta di prova. Poi aggiornare il VSIX:

```bash
code --install-extension artifacts/yed1z-control-room-0.4.0.vsix
```

Il servizio e l'extension host devono usare la stessa origine. In Remote SSH,
`localhost` è l'host remoto dell'estensione. Sul dominio HTTPS conservare
`publicOrigin` e `secureCookies:true`; per una prova HTTP locale usare origine e
cookie coerenti con quell'ambiente.

Se il canary fallisce: fermare il nuovo coordinator, conservare separatamente
il suo stato/log per diagnosi, ripristinare release e backup coerente precedenti,
poi riavviare un solo servizio. Il rollback dell'harness **non annulla** comandi
o deploy già eseguiti nei progetti: verificarli e usare le rispettive ricette.
Non rimuovere engine, tunnel o servizi vecchi solo perché sembrano duplicati;
accertare prima quale ruolo svolgono e migrare i loro client.

## 5. Verifiche automatiche ripetibili

Per ricostruire dai sorgenti su una macchina di sviluppo:

```bash
npm ci
npm run check
npm run smoke
npm run package:vsix
```

`check` esegue controllo TypeScript, suite completa e build. `smoke` avvia i bundle
isolati senza sorgenti o `node_modules`, passa attraverso un symlink di release,
verifica setup ripetuto, pagina/CSP/asset, monitor ospite, autorizzazione, login,
creazione workspace e arresto pulito. Il packaging produce il VSIX con versione
letta dal manifest.

Le suite usano server HTTP, streaming, processi child, filesystem e SQLite reali
di prova. Le risposte dei modelli e i protocolli CLI nei test sono fixture
controllate. Non misurano qualità del modello, throughput GPU, successo OAuth
reale, compatibilità di qualsiasi versione futura delle CLI o resa grafica.

Gli esiti esatti dell'ultima esecuzione sono in `docs/VERIFICA.md`; il log integrale
è in `docs/VALIDATION.txt`. Non sommare i test dei controlli parziali a quelli della
suite completa: rappresenterebbe due volte la stessa verifica.

## 6. Collaudo sul cluster: criteri di accettazione

Tutti i casi di questa tabella sono **da eseguire nell'installazione reale**.
Registrare versione dell'engine/CLI, configurazione pertinente, run ID, esito e
osservazioni. Non inserire credenziali nei report.

| ID | Prova | Esito richiesto |
|---|---|---|
| C01 | Login con lo stesso utente dopo aggiornamento | Progetti, conversazioni, allegati, memorie e route precedenti presenti; chiavi recuperabili e nessun account duplicato. |
| C02 | `come stai?` con modelli spenti, poi durante una missione | Risposta di servizio immediata, nessuna chiamata provider, nessun task nuovo; missione ancora attiva e invariata. Separare tempo server e latenza browser/rete. |
| C03 | Domanda esplicativa in Auto, poi richiesta operativa in Chat | Una sola completion, nessun planner/coder/test/deploy. Un obiettivo in Missione segue invece il ciclo configurato. |
| C04 | Modello embedding occupato durante una domanda | La chat prosegue con contesto testuale dopo il budget breve; le fonti effettivamente incluse sono visibili. Nessuna coda embedding indefinita. |
| C05 | DeepSeek Dual Strix occupato; pool con una route CUDA libera | Scelta dell'alternativa ammessa, attributi della risposta sul modello realmente usato, stessa conversazione e risorse Strix rispettate. |
| C06 | Stesso scenario con `pinned` o pool vuoto | Nessun invio a CUDA/cloud; attesa limitata e motivo leggibile. Le risorse sono rilasciate dopo timeout/cancel. |
| C07 | Due modelli sulla 3090 richiesti simultaneamente da web e API | Una sola attivazione/generazione sul gruppo esclusivo; nessuno switch che tronchi l'altro lavoro. Anche embeddings condividono il controllo. |
| C08 | Carico esterno reale tramite client di prova | Il probe mostra attivi/coda distinti dal coordinator e impedisce la commutazione. Un probe assente/scaduto/configurato male non inventa disponibilità. |
| C09 | Completion propria finita, seguito immediato da un tool round | Una lettura busy raccolta durante la propria inferenza viene riconciliata con una nuova osservazione; il task non si blocca da solo. Se un client esterno è ancora attivo, resta il vincolo. |
| C10 | Quota/429 su un account; altro account incluso nel pool | Cooldown e ragione osservabili. Una nuova ammissione può usare l'alternativa; nessun reinvio automatico dopo streaming o tool già eseguito. |
| C11 | API key errata, poi corretta nello stesso wizard | Errore del provider e passo successivo chiari; sessione del portale valida; stesso provider/account; chiave assente dal DOM/log. |
| C12 | Codex con due account | Due home private, login separati, cataloghi effettivi e isolamento verificato. Il task di uno non deve usare l'identità dell'altro. |
| C13 | Antigravity non autenticato, poi autenticato come utente del servizio | Stato reale, comando di login ufficiale, nessun modello inventato. Utilizzo come sviluppatore nel target locale fidato e autorizzazioni osservate. |
| C14 | Nuovo endpoint GemRouter e Qwen via Ollama/compatibile | Il wizard consente selezione del modello corretto; endpoint della macchina corretta; tool calling provato con un task minimo, contesto/quote ignoti quando non esposti. |
| C15 | Cambia catalogo A→B e ripeti discovery | A disabilitato, B disponibile, cronologia di A leggibile; riavvio non resuscita A. Un errore temporaneo della discovery non cancella il catalogo noto. |
| C16 | Modifica associazione hardware in idle, poi durante una richiesta API | Aggiornamento in idle verificato su provider UI proprio; rifiuto durante lease/coda/run; provider da file rifiuta override incoerente. |
| C17 | Due utenti con progetto condiviso | Conversazioni/evidenze private separate; memorie di progetto condivise solo dopo approvazione/pubblicazione; nessuna route privata altrui usata come fallback. |
| C18 | Monitor anonimo e almeno nove finestre pubbliche | Dati pubblici aggiornati, nessun endpoint/IP/account/chat privato; niente limite erroneo di otto finestre totali. Impostare anche i limiti del reverse proxy per l'esposizione pubblica. |
| C19 | Provider interrotto dopo comando mutativo riuscito | Un solo effetto, evidenza conservata e run interrotto; nessun ciclo di riparazione automatico che ripeta il comando. |
| C20 | Pause, steer, cancel e ripresa di singoli agenti | Stati coerenti; agenti indipendenti proseguono, dipendenze attendono; niente doppia esecuzione o lease lasciato occupato. |
| C21 | Progetto canary con test/build/deploy/health/rollback veri | Rilascio concesso solo dopo verifiche del controller; health negativo produce l'esito di rollback configurato. Nessun successo derivato soltanto dal testo del modello. |
| C22 | Arresto/riavvio durante una missione di prova | Run ricostruito come interrotto, evidenze conservate, nessun ripristino automatico di un processo remoto dall'esito incerto. |

### Configurare i probe senza introdurre un blocco permanente

Usare endpoint esatti e leggeri. `llama-slots` legge gli slot reali; `json` richiede
`activeRequests`, `queuedRequests` opzionale e `capacity` opzionale. La telemetria
GPU o un endpoint che restituisce percentuali non soddisfa questo contratto.

Se il motore viene spento quando si passa a un altro modello, il suo `/slots`
diventa irraggiungibile. Un probe autorevole associato a quell'endpoint impedirà
intenzionalmente nuove ammissioni finché non torna verificabile. Per questo caso
serve il **controller persistente del nodo**, capace di dichiarare il carico del
motore e lo stato di standby, oppure un'integrazione del ciclo di vita dedicata.
Non puntare tutti i provider commutabili a server che possono essere spenti senza
avere progettato questa semantica.

La 0.4 non aggiunge intestazioni di autenticazione ai probe; gli endpoint devono
essere raggiungibili nel perimetro previsto. Non esporre slot con prompt o dati
sensibili al pubblico. Il parser conserva solo contatori, non contenuti dei job.

## 7. Gate grafico e di esperienza d'uso

Verificare il prodotto con dati e credenziali di prova reali, confrontandolo con
la dashboard storica sullo stesso monitor. Il controllo DOM non misura tagli,
contrasto percepito, leggibilità del font, scorrimento o fluidità.

| Scenario | Accettazione |
|---|---|
| Desktop 1366×768 e 1920×1080 | Chat e dashboard sembrano parti dello stesso prodotto; nodi/squadra visibili senza occupare tutto lo spazio del dialogo. Nessun contenuto essenziale tagliato. |
| VSCode a 320 e 480 px; editor chiaro/scuro | Composer, selettore, connessioni e pannello squadra utilizzabili; nessuno scroll orizzontale dell'intera pagina. |
| Browser mobile 390 px e zoom 200% | Controlli principali raggiungibili, modali contenute e testo leggibile. |
| Solo tastiera | Ordine Tab coerente; sidebar nascosta fuori dal focus; Escape chiude i dialog appropriati e restituisce il focus. |
| Ospite → Accedi → Annulla | Ritorno al monitor pubblico e aggiornamenti live ripresi. Una sessione privata scaduta non espone lo stato precedente. |
| Wizard lento/errore/doppio click/chiusura | Nessun duplicato, preset non modificabile durante submit, risposta tardiva ignorata dopo chiusura, dati conservati per il retry. |
| Picker aperto durante `routing.updated` | Aggiornamento dello stato senza perdere ricerca, focus, selezione o posizione di scroll. |
| Conversazione lunga con streaming | Scorrimento stabile, cronologia recuperabile progressivamente, input sempre utilizzabile. |
| Agenti paralleli, coda, tool, verifica e interruzione | Animazioni corrispondenti agli eventi; una coda non simula generazione e un task fermo non continua a pulsare come attivo. |
| FX disattivati e reduced motion | Nessun movimento indispensabile alla comprensione; tutti gli stati leggibili anche senza animazioni. |

Salvare screenshot di desktop, VSCode stretto, wizard e missione occupata, oltre
a una breve registrazione degli stati. Segnalare viewport, browser, zoom e dati
del caso. Il risultato estetico va accettato guardando il rendering reale.

## 8. Implementazioni future, ordinate per impatto

| Priorità | Lavoro | Perché serve / criterio di completamento |
|---|---|---|
| P0 operativo | Unica autorità di ammissione e switching sui nodi | Inventario di tutti i client e servizi che possono avviare/spegnere engine; rimozione dei percorsi concorrenti soltanto dopo migrazione. Nessuna commutazione può ignorare un lease del controller. |
| P0 operativo | Collaudo di questa release e gate visuale | Casi C01–C22 e sezione 7 completati, difetti corretti, canary e rollback provati prima del dominio principale. |
| P1 | Node adapter con ammissione e lease verificabili | Endpoint persistente per carico/stato/generazione del motore e lock applicato sul nodo, non semplice campione. Conflitti tra richieste locali/esterne riprodotti e risolti senza spegnimenti concorrenti. |
| P1 | Antigravity: integrazione login e profili verificati | Usare solo funzionalità ufficialmente supportate della CLI; provare isolamento, rinnovo, permessi e discovery per ogni versione prima di esporre multiaccount o ruoli read-only. |
| P1 | Workspace Git isolati per task e integrazione guidata | Worktree per agente, diff e conflitti visibili, merge condizionato a test; consentire scritture parallele senza modificare lo stesso checkout. |
| P1 | Isolamento dei processi per utenti non fidati | UID/container o VM distinti, mount e rete limitati, segreti fuori dal workspace; test di isolamento prima di consentire missioni a member esterni. Le ricette da sole non sono un sandbox. |
| P1 | Gestione completa del ciclo credenziali | Revoca, rotazione, account disabilitabile, audit e procedure di recupero; nessun segreto nel webview e invalidazione verificata sulle richieste successive. |
| P2 | Stima tempi e politica di affinità del modello | Misurare caricamento e servizio per modello; favorire engine già caldi senza saltare priorità, budget o pool autorizzato. Confronto con baseline di latenza e numero di switch. |
| P2 | Metriche storiche e quote verificate | Retention di serie hardware e tempi per run, fonti e dati mancanti espliciti; dashboard senza sommare richieste duplicate e senza inventare prefill. |
| P2 | Continuità delle sessioni native | Persistenza dei cursori ufficiali con relazione a utente, progetto, account e modello; invalidazione sicura quando cambiano identità o contesto, senza esportare credenziali. |
| P2 | Conoscenza più ampia e memoria spiegabile | Parser documenti con provenienza, aggiornamento/de-duplicazione, rimozione verificata, valutazione del retrieval; proposte di metodo ancora approvabili. Nessun apprendimento automatico dei pesi implicito. |
| P3 | Alta disponibilità e ripristino coordinato | Lease persistenti con fencing token, coda durevole e controller unico per effetto; failover provato senza doppio deploy/comando. Avviare due copie dell'attuale servizio non fornisce HA. |

## 9. Mappa dei file per chi prosegue

| Area | File principali |
|---|---|
| Intento e latenza chat | `src/intent.ts`, `src/orchestrator.ts`, `tests/interaction.test.ts` |
| Collegamenti e metadata | `src/connections.ts`, `src/connection-types.ts`, `src/catalog.ts`, `src/adapters/antigravity-inspect.ts`, `src/adapters/ollama-info.ts` |
| Risorse e routing | `src/scheduler.ts`, `src/routing.ts`, `src/inference-load.ts`, `src/request-policy.ts` |
| Guest/API/eventi | `src/public-dashboard.ts`, `src/server.ts`, `docs/API.md` |
| UI comune | `web/app.ts`, `web/activity.ts`, `web/connections.ts`, `web/style.css` |
| VSCode | `vscode/src/extension.ts`, `vscode/src/client.ts`, `tests/vscode-host.test.ts` |
| Esecuzione e produzione | `src/execution/`, `docs/EXECUTION.md`, ricette in `examples/` |
| Configurazione e deploy del servizio | `src/config.ts`, `examples/strix-cluster.json`, `systemd/yed1z-command.service` |

Consultare `AGENTS.md` prima di cambiare i confini: un solo linguaggio applicativo,
identità e provenienza preservate, nessuna metrica inventata, ruoli applicati dal
coordinator, inferenza distinta dal target, nessun replay di effetti incerti.

La licenza principale resta **0xfunboy Non-Commercial v1.1**; i moduli vendor
mantengono le eccezioni MIT e la provenienza già presenti. La release non è una
fusione dei quattro repository di harness citati nella discussione iniziale.

Per ricostruire un checkout Git dalla confezione, senza un repository remoto:

```bash
git clone repository.bundle yed1z-checkout
```

Il file `RELEASE.json` della confezione identifica commit/tag, base e verifiche;
`SHA256SUMS.txt` registra gli hash dei file distribuiti. `changes-from-upload.patch`
consente di esaminare le differenze dalla copia ricevuta. Questi materiali non
contengono lo stato operativo o le credenziali della tua installazione.
