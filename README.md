# yed1z Control Room · 0.3.0

Un centro di controllo per progetti, conversazioni, conoscenza, squadre di agenti e
infrastruttura distribuita. **Un coordinator TypeScript, la stessa applicazione in
web e VS Code, più macchine per inferenza ed esecuzione.**

Questa release sostituisce l'architettura Python + worker TypeScript della 0.2 con
un'applicazione TypeScript. Le infrastrutture esterne continuano a essere adattate:
engine sui due Strix, engine CUDA sulla 3090, GemRouter e provider cloud. Non serve
spostare tutti i modelli sul coordinator.

**Stato della consegna:** implementazione e pacchetti verificati con HTTP, RPC,
filesystem, SQLite e flussi UI di prova. Nessuna installazione su `yed1z.ai`, nessun
servizio di produzione fermato, nessuna connessione SSH al cluster riuscita in
questa sessione. Il rendering nella finestra reale del browser/VS Code resta da
collaudare: Chromium nell'ambiente di verifica è bloccato dal sistema.

## Il prodotto

L'utente apre un progetto, parla all'orchestratore e vede contemporaneamente:

- conversazioni e allegati del proprio account;
- modello/account selezionato e quote effettivamente osservate;
- stato dei nodi Strix 01, Strix 02 e CUDA, GPU/CPU/memoria e interfacce di rete;
- agenti, dipendenze, avanzamento, file coinvolti e risultati degli strumenti;
- contesto utilizzato da ogni agente, fonti incluse e fonti escluse per budget;
- verifiche e rilascio, con evidenze separate dalla risposta del modello.

La vista principale ha tre aree: progetti e cronologia a sinistra, orchestratore al
centro, squadra a destra. La panoramica dei nodi rimane visibile. Infrastruttura,
Conoscenza, Connessioni e Consegne aprono il dettaglio senza riempire la chat di
configurazioni.

## Cosa è implementato

| Area | Funzionamento |
|---|---|
| Inferenza | OpenAI compatibile, GemRouter, Ollama, Responses e Gemini; discovery dei modelli e più account. |
| OAuth ufficiale | Codex tramite app-server e device code, con `CODEX_HOME` privato per account. Antigravity tramite profilo CLI ufficiale configurato dall'operatore. |
| Risorse | Prenotazione atomica di tutti i nodi necessari. Una route Dual Strix occupa entrambi; CUDA ha il proprio gruppo. |
| Lifecycle | Readiness sul motore effettivo e attivazione tramite ricette Strix o node-agent CUDA; risorsa trattenuta fino a fine richiesta. |
| Esecuzione | Target locale o SSH indipendente dal modello. Runner TypeScript stateless, nessun ulteriore server pubblico. |
| Missioni | Piano con dipendenze, agenti di lettura paralleli, scritture serializzate nello stesso workspace, review, verifiche e riparazione entro budget. |
| Controllo agenti | Pausa, ripresa, annullamento e istruzioni per ricercatori/sviluppatori. Cambio modello/account in coda o pausa. |
| Rilascio | Ricette operatore, nuove verifiche, autorizzazione, health check e rollback configurato. |
| Conoscenza | Allegati testuali, memorie private o di progetto, revisioni e provenienza; ricerca FTS5 e vettoriale con embeddings reali opzionali. |
| Interfacce | Web e VS Code condividono applicazione, API e stato. Nessun database di chat indipendente nel plug-in. |
| Persistenza | SQLite/WAL, chiavi di accesso hashate, segreti API cifrati, checkpoint, eventi e approvazioni persistenti. |
| Migrazione | Import idempotente delle conversazioni 0.2, senza toccare il database originale o importare credenziali. |

## Avvio rapido

### Requisiti

- Linux per il coordinator e i runner di questa release.
- **Node 24.15+ della linea 24**, verificato con **24.22.1**.
- Un endpoint di inferenza oppure una CLI ufficiale configurata separatamente.
- Per SSH: host alias e chiavi già configurati, host key nota, Node e runner sul nodo.

I bundle sono inclusi in `dist/`. **Per usare la release non occorre installare
dipendenze npm o compilare i sorgenti.** Le dipendenze di sviluppo servono soltanto
a modificare, verificare o ricostruire il progetto.

Da questa cartella:

```bash
node dist/cli.mjs init --name funboy --workspace /percorso/dei/progetti
node dist/server.mjs
```

La directory `/percorso/dei/progetti` deve esistere e la porta 8081 deve essere
libera. Sul coordinator che ospita il gateway precedente usa prima una porta
diversa in `state/config.json`, come descritto nella migrazione. Il setup stampa
la chiave una sola volta. Apri `http://127.0.0.1:8081`, inserisci la chiave, quindi:

1. **Connessioni → Aggiungi connessione**: scegli il preset e usa **Verifica e trova modelli**.
2. **Progetto → Impostazioni**: seleziona il modello primario e, se desiderato,
   modelli diversi per sviluppatore, ricercatore e revisore.
3. Per una chat basta la connessione. Per una missione configura target/workspace
   e almeno una ricetta di verifica reale.
4. Scrivi l'obiettivo, scegli Chat o Missione e i permessi concessi per quella missione.

Un nuovo progetto può creare la propria sottodirectory nella radice configurata.
La creazione è confinata alla radice del target e non sostituisce file esistenti.
Usa radici dedicate ai progetti; conserva lo stato del coordinator al di fuori dei
workspace su cui gli agenti lavorano.

### Collegare VS Code

```bash
code --install-extension yed1z-control-room-0.3.0.vsix
```

Apri **yed1z Control Room** e scegli **Collega il gateway**. Inserisci lo stesso URL
e la chiave. Il token resta nel SecretStorage dell'extension host. L'identificativo
`funboy.haloforge` è conservato per aggiornare la precedente estensione.

Con Remote SSH, `localhost` fa riferimento all'ambiente dell'extension host.
L'azione sull'editor **Aggiungi selezione al contesto** allega il testo selezionato
al progetto scelto; non espone automaticamente tutto il disco locale.

## Adattamento al cluster

`examples/strix-cluster.json` descrive la topologia ricavata dai sorgenti forniti:

| Risorsa | Riferimento documentato | Trattamento |
|---|---|---|
| Coordinator | `01-EVO-X3` | Coordinator, inferenza, eventuale esecuzione locale. |
| Secondo Strix | `02-evo-x3-tb`, collegamento documentato `10.55.0.2` | Nodo distinto, spesso parte della stessa route distribuita. |
| CUDA | `aireward-llm`, `192.168.178.47` | Engine Qwen su 8080 e DeepSeek su 8085, lifecycle 8090. |
| Strix engine | 18231 DeepSeek, 18562 Qwen | Endpoint sul coordinator, riservando entrambi gli Strix. |
| GemRouter | URL da impostare dall'operatore | Un ulteriore provider di inferenza selezionabile nei modelli. |

Sono **riferimenti di configurazione**, non risultati di una scansione live. Gli
IP LAN storici `.67`/`.77` degli Strix erano contraddittori e non vengono scelti
arbitrariamente. L'alias SSH CUDA e la porta SSH devono essere risolti nella
configurazione SSH reale. Gli ID del modello e le capacità nell'esempio sono
dichiarazioni dell'operatore da confermare contro il motore prima del cutover.

Il template include percorsi espliciti per il runner, radici workspace dedicate e
ricette per `cluster-model`. Adattalo ai percorsi effettivi. Per i nodi remoti copia
`dist/runner.mjs` e una configurazione locale basata su
`examples/node-runner.json`: il target deve avere **lo stesso ID** del coordinator,
ma `kind: "local"` sul nodo che lo esegue.

```bash
node dist/cli.mjs init --name funboy --config examples/strix-cluster.json
```

Il template usa `publicOrigin: https://yed1z.ai` e cookie sicuri: è destinato al
dominio HTTPS dietro tunnel, non a un test browser su HTTP locale. Per la prima
prova locale usa il setup rapido senza questo template.

### Un solo servizio di controllo

`systemd/yed1z-command.service` è l'unità del coordinator. Gli engine di inferenza,
il tunnel e gli eventuali controller del nodo sono infrastruttura esterna. Il
runner SSH viene avviato soltanto per un'operazione e termina dopo la risposta.

Il vecchio gateway Python non è una dipendenza del nuovo servizio. La modalità
CUDA può adattare il node-agent esistente per il lifecycle, mentre la telemetria
moderna usa il runner TypeScript. Il formato legacy che contiene fallback fissi
rimane marcato `legacy-unverified` e non viene presentato come misurazione.

## Come funziona una missione

1. L'orchestratore costruisce il contesto e produce un piano strutturato con dipendenze.
2. Lo scheduler prenota le risorse di inferenza e il workspace. Le letture
   indipendenti procedono in parallelo; chi modifica lo stesso checkout lavora in serie.
3. I task raccolgono evidenze dagli strumenti, con hash dei file, timeout e controlli di autorizzazione.
4. Il revisore esamina il risultato. Le ricette di verifica eseguono realmente test/build configurati.
5. Un errore di review o verifica può aprire un nuovo ciclo di correzione, entro il budget.
6. Una verifica superata produce un report Markdown scaricabile. Se esiste una
   ricetta di rilascio, la missione arriva al relativo gate.
7. Il controller di rilascio ripete le verifiche sotto lease, esegue la ricetta e
   osserva il health check. Se fallisce, esegue il rollback previsto e conserva l'esito.

Il sistema distingue **risposta completata**, **consegna nel workspace** e
**rilascio con health check positivo**. Il risultato del modello non può da solo
portare lo stato a "distribuito". Il health check attesta la condizione configurata
dalla rete della macchina di esecuzione, non tutte le possibili reti o funzionalità.

`examples/deployment-recipe.json` è uno schema operatore: i programmi
`my-app-deploy` e `my-app-rollback` devono essere implementati per il prodotto
effettivo. Non sono script di deploy già installati sui tuoi server.

### Pause, interruzioni e quote

- Un agente in pausa libera la chiamata di inferenza; gli agenti indipendenti
  possono terminare, le sue dipendenze attendono.
- Riprendere un agente ricompone il contesto, include le evidenze precedenti e
  richiede di controllare lo stato dei file. Non ripete lo stesso RPC.
- Annullare un ramo mette in pausa la missione dopo le attività già avviate.
- Dopo un crash o un esito remoto incerto, la missione richiede una ripresa esplicita.
- Un 429 non avvia rotazioni o replay nascosti. Puoi scegliere un altro account
  mantenendo la stessa conversazione.
- Default: 3 cicli di correzione, 3 agenti di lettura paralleli, 48 chiamate esterne
  dell'harness, budget output e deadline di 60 minuti. Le CLI native gestiscono
  internamente ulteriori chiamate: il limite dei turni esterni non è una misura
  completa delle loro richieste interne o del costo.

## Memoria e contesto

I dati vengono separati per funzione:

- **Conversazione:** cronologia canonica privata dell'utente, indipendente dal provider.
- **Allegati:** file UTF-8/Markdown conservati con hash e proprietario, fino a 1 MiB
  ciascuno e 64 MiB per utente in questa release.
- **Memorie:** metodi, decisioni, brief e documenti con stato candidato/approvato/ritirato,
  revisioni, fonti e visibilità privata o di progetto.
- **Indice:** FTS5 e, quando configurato, vettori realmente restituiti dal provider
  embedding. La ricerca combina ranking testuale e similarità coseno.
- **Contesto del task:** istruzioni, obiettivo, cronologia recente, metodi approvati,
  allegati selezionati e risultati delle dipendenze, entro un budget visibile.

Le proposte di metodo raccolte dopo una missione verificata restano candidate.
L'utente le approva prima del riuso. Pubblicarle al progetto è una decisione
esplicita. Eliminare una memoria elimina anche revisioni e vettori. Questo è un
sistema di memoria e recupero del contesto, non un addestramento dei pesi del modello.

La stima del contesto usa bytes UTF-8 e margine; non viene presentata come il
tokenizer esatto. Token, TTFT e velocità sotto le risposte riportano la fonte. Il
TTFT del gateway include attesa/rete; non equivale al solo prefill. La memoria GPU
non è la finestra di contesto. Il traffico di rete viene calcolato soltanto fra
due campioni reali compatibili, conservando lo zero e distinguendo l'ignoto.

## Utenti e confini di esecuzione

| Ruolo | Permessi di questa release |
|---|---|
| Admin | Configurazione, creazione utenti, connessioni, progetti ed esecuzione fidata. |
| Operator | Connessioni e target autorizzati, missioni, CLI e rilascio. |
| Member | Chat HTTP, conversazioni, allegati e memoria nei progetti accessibili. |
| Viewer | Consultazione dei dati autorizzati. |

Le conversazioni e i task rimangono del proprietario anche in un progetto condiviso.
Non è una chat collaborativa simultanea con altri utenti che possono controllare
silenziosamente i tuoi agenti. Le memorie di progetto sono il canale di condivisione
esplicito.

Le chiavi API sono cifrate AES-256-GCM con `master.key` separata; il database e la
directory sono privati. Le chiavi di accesso sono hashate. Web usa cookie HttpOnly,
SameSite e controllo Origin; VS Code usa SecretStorage e un bridge senza token nel
webview.

**I tool di file e le ricette non sono un sandbox OS.** Un programma del progetto
eseguito con lo stesso utente Unix può avere i privilegi di quell'utente. Gli
operatori di questa release devono essere fidati. Per offrire esecuzione a utenti
esterni servono target con UID/container e mount realmente isolati, da collaudare
separatamente; assegnare una directory diversa nel form non garantisce quell'isolamento.

## API e sviluppo

- `/api/*`: progetti, conversazioni, missioni, agenti, conoscenza, account,
  telemetria, evidenze ed eventi SSE con replay persistente.
- `/v1/models`: ID univoci di modello/account.
- `/v1/chat/completions`: inferenza compatibile, streaming, usage e function tool
  forwarding. Non esegue autonomamente i tool forniti dal chiamante.

Un nome sottostante presente in più account è ambiguo: usare la route restituita
dal catalogo. Anche le richieste API attraversano le stesse prenotazioni hardware,
attivazioni e quote. La facade non ricostruisce tutta l'API legacy del vecchio HUD.

```bash
npm ci
npm run check
npm run smoke
npm run package:vsix
```

Il codice applicativo, i tool, i test e gli script sono TypeScript. HTML, CSS,
SQL incorporato e JSON descrivono interfaccia, schema e configurazione. I file JS
in `dist/` sono bundle generati. Il runtime non richiede framework o servizi di
database/vector aggiuntivi.

## Documentazione e limiti residui

- [Architettura completa](docs/ARCHITETTURA.md)
- [Audit delle lacune 0.2 → 0.3 e confini della release](docs/GAP_AUDIT.md)
- [Esperienza utente e verifiche dell'interfaccia](docs/UX.md)
- [API](docs/API.md)
- [Adapter e fonti](docs/ADAPTERS.md)
- [Esecuzione, SSH e rilascio](docs/EXECUTION.md)
- [Migrazione e rollback](docs/MIGRATION.md)
- [Verifica della consegna](docs/VERIFICA.md)

I principali limiti residui sono il collaudo sul cluster reale, il collaudo grafico
in browser/VS Code, worktree Git e merge paralleli, isolamento automatico dei
processi per utenti non fidati e alta disponibilità del coordinator. Le sessioni
native vengono ricreate dal contesto canonico: i cursori nativi non sono ancora
persistiti nell'orchestratore 0.3. La telemetria hardware è live con campioni della
sessione UI, non un archivio storico TSDB. L'integrazione Antigravity non dichiara
isolamento multiaccount o quote numeriche verificabili.

Non è una fusione del codice completo di OpenCode, Pi, Goose e DSH. Il progetto
ricostruisce il prodotto attorno alla tua infrastruttura e riusa gli adapter
TypeScript MIT di HaloForge con la loro provenienza. La licenza principale resta
quella **0xfunboy Non-Commercial v1.1**, con le eccezioni MIT documentate nei moduli
vendor; non viene presentato tutto il repository come MIT.
