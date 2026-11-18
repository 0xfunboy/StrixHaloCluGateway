# Riferimento operativo di CLI, nodi e VS Code

Il coordinator conserva identità, dati, progetti e approvazioni. Il bridge rende raggiungibile il motore di inferenza di una macchina. Il runner opera sui file e sulle ricette del target di esecuzione. È possibile usare tre macchine differenti per queste tre funzioni. I comandi seguenti partono dalla radice del monorepo o della distribuzione estratta e richiedono Node 24.15 o successivo della serie 24.

- [Eseguibili e comandi](#eseguibili-e-comandi)
- [Configurazione del coordinator](#configurazione-del-coordinator)
- [Provider, capacità e quote](#provider-capacità-e-quote)
- [Bridge di inferenza](#bridge-di-inferenza)
- [Runner di esecuzione](#runner-di-esecuzione)
- [Comandi di VS Code](#comandi-di-vs-code)
- [Verifica e diagnosi](#verifica-e-diagnosi)

## Eseguibili e comandi

| Comando | Ingresso, effetto e risultato |
|---|---|
| `node dist/cli.mjs help` | Elenca i comandi, le opzioni principali e l’avvio del servizio. È anche il comando predefinito. |
| `node dist/cli.mjs init` | `--state DIR`, `--name NOME`, opzionali `--config FILE` e `--workspace DIR`. Al primo avvio crea configurazione, DB, chiave di cifratura, admin, account da configurazione e progetto iniziale. Se si indica il workspace, la directory deve esistere. A configurazione già presente rilegge il file esistente. Alla creazione dell’admin mostra la sua chiave una volta. Una seconda inizializzazione conserva il titolare e le sue credenziali. |
| `node dist/server.mjs` | Avvia il coordinator dalla configurazione di stato. Il servizio ascolta sul bind e sulla porta configurati, acquisisce il lock di stato, espone HTTP e aggiorna le sonde. `npm start` esegue lo stesso bundle. |
| `node dist/cli.mjs user-add` | `--state DIR --name NOME --role RUOLO`. Genera un utente locale e stampa ID e chiave personale. I ruoli ammessi sono admin, operator, member, viewer. Il default è member. A coordinator acceso gli amministratori possono usare l’API utenti. |
| `node dist/cli.mjs backup` | `--state DIR --out FILE`. Scrive un backup SQLite su un percorso nuovo. Conservare con il DB una copia coerente di `master.key`, `accounts/`, `artifacts/` e `config.json` per poter ripristinare l’istanza completa. |
| `node dist/cli.mjs import` | `--state DIR --database FILE --legacy-user NOME --user ID --project ID`. Importa lo storico del singolo utente da un database Portal/Unified supportato nell’identità e nel progetto indicati e riporta l’esito JSON. |
| `node dist/cli.mjs import-gateway` | `--state DIR`. Legge un export chiavi con `--keys FILE --owners FILE` e/o uno storico statistiche con `--stats FILE --usage-owner ID`. Il primo passaggio presenta il riepilogo. Aggiungere `--apply` per scrivere dopo il controllo delle proprietà. Richiede uno stato già inizializzato. Le importazioni ripetute riconoscono i dati già attribuiti. |
| `node dist/cli.mjs probe` | `--kind gemrouter\|openai-compatible\|openai-responses\|gemini\|ollama --url BASE`, opzionali `--key-env NOME`, `--generate`, `--model ID`. Interroga il catalogo usando la libreria degli adapter. Con generazione invia un prompt breve e riporta modello, testo ricevuto, corrispondenza esatta con «OK», chunk, uso dichiarato, TTFT, durata e motivo di chiusura quando osservati. |
| `node dist/node-bridge.mjs` | Avvia il proxy di inferenza e telemetria configurato tramite ambiente. |
| `node dist/runner.mjs --config FILE --target ID` | Seleziona la definizione locale del target e attende una richiesta JSON su stdin. Normalmente viene lanciato dal coordinator tramite SSH per una sola operazione. |

Le operazioni CLI che aprono il database usano il lock esclusivo dello stato. Sul servizio in esercizio si pianifica uno stop oppure si lavora su una copia coerente. La CLI `probe` parla direttamente al provider e funziona anche durante l’esecuzione del coordinator. L’help è disponibile senza accedere al database. [Migrazione](MIGRATION.md) · [Backup e collaudo della release](CONSEGNA-1.0-RC1.md)

Su una macchina libera, questi comandi creano una nuova installazione.

```bash
mkdir -p "$HOME/progetti-yed1z"
export YED1Z_STATE_DIR="$HOME/.local/share/yed1z-demo"
node dist/cli.mjs init --name operatore --workspace "$HOME/progetti-yed1z"
node dist/server.mjs
```

L’admin di questa installazione usa la chiave mostrata da `init`. Il monitor apre su `http://127.0.0.1:8081/` e il lavoro di progetto su `http://127.0.0.1:8081/control`. Su una macchina con un coordinator già attivo, per un’istanza indipendente indicare una directory di stato distinta e una porta libera nel suo `config.json`.

## Configurazione del coordinator

| Impostazione | Significato |
|---|---|
| `YED1Z_STATE_DIR` | Directory operativa, default `state` relativo alla directory corrente. L’opzione CLI `--state` ha precedenza. |
| `YED1Z_CONFIG` | Percorso del file del servizio. Di default `config.json` nella directory di stato. |
| `YED1Z_WEB_DIR` | Directory degli asset del prodotto, default `dist/web`. Il server trova l’HUD storico nella directory sorella `dist/classic`. Conservare la struttura della distribuzione. |
| `bind`, `port` | Default `127.0.0.1` e 8081. La porta 0 consente un listener effimero durante i test. |
| `publicOrigin`, `secureCookies` | L’origine del reverse proxy pubblico, completa di schema e priva di path applicativo. Con TLS si può attivare l’attributo Secure del cookie. Il server controlla l’origine delle mutazioni autenticate con cookie. |
| `publicDashboard` | Default `true`. Permette agli ospiti di leggere la proiezione pubblica di infrastruttura, misure ed eventi. Su `false` i dati della dashboard richiedono autenticazione. |
| `telemetryIntervalMs` | Campionamento periodico del coordinator. Default 10000, intervallo ammesso da 1000 a 300000 ms. La UI distingue misura, lettura storica non verificata e valore assente. |
| `nodes`, `links` | Il nodo ha ID, etichetta, tipo, capacità e opzionalmente host e telemetria. `links` registra collegamenti e stato configurato, osservato o sconosciuto. Il collegamento in mappa descrive la topologia. |
| `nodes[].telemetry` | Sorgenti `native`, `node-agent`, `gateway`. In base alla sorgente si indicano `targetId`, URL e/o nome di variabile per la credenziale. Un bridge yed1z usa tipo `node-agent` e percorso `/telemetry`. |
| `resourceGroups` | Ogni gruppo associa ID, nodi e `capacity` (1–64). L’assegnazione di una rotta acquisisce congiuntamente i gruppi espliciti e quelli implicati dai nodi. I motori commutabili richiedono gruppi esclusivi con capacità 1. |
| `targets` | Macchine di esecuzione abilitate dall’operatore. Per ogni target servono ID, `nodeId`, tipo local/ssh, `workspaceRoot` assoluto e ricette. Un progetto sceglie la sottodirectory relativa e può scegliere `git-worktree` per isolare il lavoro Git locale. |
| `providers` | Elenco dei provider iniziali e delle rotte da configurare. Il wizard consente di aggiungere connessioni nel catalogo operativo. |
| `defaultEmbeddingProviderId` | Se disponibile per l’utente, imposta una rotta embedding per i nuovi progetti. L’auto-indicizzazione di documenti/memorie approvate richiede il provider locale di default su loopback e la relativa rotta del progetto. |
| `demo` | Flag esposto nel bootstrap per identificare l’installazione dimostrativa. |

Il template di cluster comprende nodi Strix, RTX, risorse, provider, attivazioni, sonde e riferimenti alle ricette. Gli ID di nodo e gruppo devono essere coerenti su provider, sonde e target. [Template di cluster](../examples/strix-cluster.json) · [Validazione della configurazione](../src/config.ts)

## Provider, capacità e quote

| Campo o gruppo | Uso operativo |
|---|---|
| `kind`, `baseUrl`, `tag` | I tipi sono `openai-compatible`, `openai-responses`, `gemini`, `ollama`, `codex`, `antigravity`. Per GemRouter si usa il protocollo OpenAI-compatible con tag `gemrouter`. Gli altri tag sono `cluster`, `local` e `cloud`. |
| `secretEnv`, `sharedAccount` | Nel seed di configurazione indicano il nome della variabile con la chiave e la visibilità dell’account iniziale. Gli account aggiunti da UI usano lo store del coordinator e le regole di condivisione del titolare. |
| `command`, `args`, `env` | Configurazione operativa dei runtime nativi. Il coordinator isola i nuovi profili per account. Il titolare completa il consenso previsto da ciascun runtime. |
| `models[]` | Ogni elemento associa `model` a un’etichetta, eventuali alias, finestra e capacità. Le interfacce dichiarate comprendono chat, strumenti, embedding e visione. Una generazione reale e una discovery sono verifiche distinte. |
| `nodeIds`, `resourceGroupIds`, `maxConcurrent` | Specificano la topologia fisica e il parallelismo del provider. `maxConcurrent` esplicito ammette 1–16. Nel routing automatico e nelle rotte fisse valgono anche i limiti dei gruppi hardware. |
| `loadProbe` | Sonda `llama-slots` o `json` con URL ed eventuali `capacity`, `timeoutMs`, `maxAgeMs`. Conserva contatori e tempi di osservazione. Gli stati disponibili sono `available`, `busy`, `unknown`, `stale`. |
| `activation` | Configura una ricetta su un target oppure `switchUrl` e body. `modelsUrl` e `expectedModel` verificano il motore richiesto dopo l’avvio. Può specificare timeout e `stop.url` con `stop.healthUrl`. |
| `maxEmbeddingChars` | Limite di segmento per il provider embedding, fra 32 e 4096. Il progetto su questa installazione usa 120 per il modello MiniLM. L’indice conserva testo e citazioni dei passaggi originali. |

Le finestre di quota derivano dalle osservazioni recenti del provider, dal runtime o da una risposta di rate limit. Un dominio di quota configurato esplicitamente collega account equivalenti dello stesso proprietario. Ogni alternativa deve essere autorizzata per l’identità che fa la richiesta. [Routing](ROUTING.md) · [Connessioni e credenziali](CONNECTIONS.md) · [Configurazione dell’encoder locale](ENCODER-LOCALE.md)

## Bridge di inferenza

Il processo `node-bridge.mjs` ascolta sul nodo che può raggiungere l’engine. Il coordinator lo registra come provider, direttamente o attraverso un tunnel SSH. Il bridge verifica la propria credenziale per ogni endpoint, compresi health e sensori. I segreti sono distinti sui due lati.

| Variabile | Valore ed effetto |
|---|---|
| `YED1Z_NODE_BIND`, `YED1Z_NODE_PORT` | Default `127.0.0.1` e 8181. |
| `YED1Z_NODE_KIND` | `openai` (default) oppure `ollama`, in base al protocollo dell’engine a monte. |
| `YED1Z_NODE_UPSTREAM` | URL base del motore, default `http://127.0.0.1:8080/v1`. Supporta HTTP/HTTPS, senza credenziali, query o frammento nell’URL. |
| `YED1Z_NODE_TOKEN` | Segreto di almeno 24 caratteri atteso nell’header Bearer delle richieste provenienti dal coordinator. |
| `YED1Z_ENGINE_TOKEN` | Credenziale opzionale verso l’engine. Il bridge la imposta sulle richieste a monte. |

| Metodo e percorso sul **bridge** | Funzione |
|---|---|
| `GET /health` | Verifica il processo del bridge e comunica il protocollo configurato. Per verificare il modello occorre interrogare il catalogo e generare una risposta. |
| `GET /telemetry` | Legge i sensori locali disponibili sul nodo. |
| `GET /v1/models` | Protocollo openai. Inoltra la lista modelli dell’engine. |
| `POST /v1/chat/completions` | Protocollo openai. Inoltra messaggi e stream. |
| `POST /v1/embeddings` | Protocollo openai. Inoltra la richiesta di vettori a un engine che supporta embedding. |
| `POST /v1/responses` | Protocollo openai. Inoltra il formato Responses se implementato dall’upstream. |
| `GET /api/tags` | Protocollo ollama. Elenca i modelli installati. |
| `POST /api/show` | Protocollo ollama. Chiede i metadati per il modello. |
| `POST /api/chat` | Protocollo ollama. Inoltra il turno al motore. |
| `POST /api/embed` | Protocollo ollama. Inoltra le richieste di embedding. |

L’upstream riceve il path autorizzato e il JSON della richiesta. Il limite del corpo è 7 MiB. La chiusura del client annulla il lavoro di inoltro. Il timeout complessivo è 10 minuti. Per il client, 401 indica accesso al bridge negato, 404 un endpoint fuori elenco, 502 un problema di comunicazione con l’engine. Gli status restituiti dall’engine vengono inoltrati. [Installazione del nodo e tunnel SSH](NODO-INFERENZA.md) · [Codice del bridge](../src/node-bridge.ts)

## Runner di esecuzione

La configurazione del target sul coordinator indica `sshHost`, eventuale `sshPort`, `remoteNode`, `remoteRunner` e `remoteConfig`. Sul nodo, il file indicato da `--config` deve contenere il target con lo stesso ID di `--target`, il suo `workspaceRoot` e le ricette effettivamente autorizzate su quella macchina. Il runner usa un protocollo JSON a righe su stdin/stdout. Per ogni avvio accetta un solo frame `start`. Riconosce solo decisioni di approvazione correlate e gestisce la chiusura del collegamento. [Esempio di configurazione del runner](../examples/node-runner.json)

| Operazione del runner | Risultato |
|---|---|
| `prepare` | Prepara e valida il workspace autorizzato del progetto. |
| `snapshot` | Identifica la revisione osservata tramite digest ed eventuale commit Git. |
| `list`, `read`, `search` | Elencano file ammessi, leggono un intervallo di righe o cercano testo letterale nell’area autorizzata. La lettura produce anche l’hash utilizzabile per una modifica successiva. |
| `write` | Modifica un file testuale del workspace con controlli su path e revisione attesa. L’operazione produce evidenze e passa dal controllo di autorizzazione. |
| `command` | Esegue l’argv di una ricetta già configurata identificata dal suo ID. La definizione può specificare directory relativa e timeout. |
| `verify` | Esegue una ricetta di verifica registrata e raccoglie stato, exit code, output limitato e hash. |
| `deploy` | Usa la ricetta con passi `verify`, `steps`, health e rollback facoltativo. Collega l’approvazione ai digest. Registra esito health e rollback sul target. |
| `telemetry` | Legge le misure native disponibili dalla macchina del target. |

Gli strumenti offerti a un agente in sola lettura sono `list_files`, `read_file` e `search_files`. I ruoli abilitati alla modifica possono ottenere `write_file` e `run_command` secondo permessi e ricette configurate. Le ricette `controllerOnly` e quelle di deploy/rollback sono riservate ai controller. Se il canale cade dopo un possibile effetto, controllare le evidenze e riconciliare il tentativo prima di riprendere. [Policy strumenti e controlli Git](EXECUTION.md) · [Esempio di deploy con health check](../examples/deployment-recipe.json)

## Comandi di VS Code

L’estensione `funboy.haloforge` è installabile da VSIX. Con Remote SSH l’extension host viene eseguito sul sistema remoto. Il suo `127.0.0.1` indica quella macchina. Il token è conservato nel SecretStorage del relativo host, associato all’origine.

| Titolo nel menu comandi | ID | Azione |
|---|---|---|
| yed1z: Collega il gateway | `yed1z.configure` | Chiede l’origine del coordinator (es. `https://yed1z.ai`) e la chiave personale tramite input nativo. Il client valida la connessione e mantiene il token fuori dalla webview. |
| yed1z: Apri Control Room | `haloforge.open` | Porta il focus sulla vista `haloforge.chat` nella barra attività. Il pannello usa il medesimo backend del browser. |
| yed1z: Aggiungi selezione al contesto | `haloforge.addSelection` | In un workspace attendibile allega al progetto il testo selezionato nell’editor. Disponibile anche dal menu contestuale con una selezione attiva. |
| yed1z: Apri portale nel browser | `yed1z.openPortal` | Apre la Control Room su `/control` nell’origine configurata. |

L’host media richieste REST ed eventi. In workspace con trust limitato consente monitor e cronologia, oltre alla preferenza personale di aspetto. Le mutazioni operative e i trasferimenti dall’editor richiedono workspace attendibile. Per le origini pubbliche il client richiede HTTPS. [Manifesto dei comandi](../vscode/package.json) · [Comunicazione host e webview](API.md#bridge-webview-vs-code)

## Verifica e diagnosi

| Comando | Cosa verifica o produce |
|---|---|
| `npm ci` | Installa le dipendenze di sviluppo dalle versioni dichiarate nel lockfile. I bundle già compilati si eseguono direttamente con Node. |
| `npm run typecheck` | Verifica staticamente i tipi TypeScript. |
| `npm test` | Esegue la suite Node dei file `tests/*.test.ts`. |
| `npm run build` | Costruisce coordinator, CLI, runner, bridge, client Web, asset del cockpit e client VS Code. |
| `npm run check` | Esegue in ordine controllo tipi, suite e build. |
| `npm run smoke` | Verifica gli entrypoint distribuiti con stato temporaneo, avvio, login, autorizzazioni, workspace, pagine e arresto. Usare dopo la build. |
| `npm run package:vsix` | Crea l’estensione installabile in `artifacts/` con la versione del manifesto. Usare dopo la build. |
| `node scripts/canary-codex-local.ts` | Impostare `YED1Z_CANARY_UPSTREAM`, `YED1Z_CANARY_MODEL`, ed eventualmente `YED1Z_ENGINE_TOKEN`. Con un engine che supporta function calling e la CLI Codex disponibile, verifica un turno reale Responses e la lettura di un file di prova. |

Per distinguere un guasto di rete, di autenticazione o di modello, partire dall’health del coordinator, poi leggere il catalogo autorizzato, verificare la rotta e generare una risposta breve. Per un nodo remoto ripetere gli stessi controlli contro il bridge con la sua credenziale. La risposta del catalogo verifica la discovery. La generazione con contenuto verifica anche l’inferenza. [Metodi HTTP del coordinator](RIFERIMENTO-FUNZIONI.md) · [Risultati misurati sul cluster](CONSEGNA-1.0-RC1.md)
