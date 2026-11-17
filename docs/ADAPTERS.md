# Adapter di inferenza, runtime e nodi

Tutti i moduli applicativi di questa release sono TypeScript. Il piano di controllo
non incorpora un engine GPU: coordina endpoint di inferenza e target di esecuzione
che possono trovarsi su macchine differenti.

## Tre identità diverse

- **Nodo:** macchina fisica o risorsa remota, con telemetria e disponibilità.
- **Provider/account:** connessione e identità usate per l'inferenza.
- **Route modello:** selezione di un modello e dei gruppi di risorse che occupa.

Un modello distribuito sui due Strix può avere un solo endpoint HTTP ma occupa
entrambi i nodi. Un modello sulla 3090 usa un altro gruppo. GemRouter è un provider
HTTP compatibile OpenAI: il piano di controllo non ricostruisce la sua rotazione
interna né presume che una chiave corrisponda a una quota Google indipendente.

L'orchestratore possiede le prenotazioni atomiche dei gruppi, il limite di
concorrenza, la coda, i task e la politica di cambio account. Gli adapter non
ritentano automaticamente le richieste e non effettuano failover di un task.

## Contratto inferenza

Moduli: `src/adapters/types.ts`, `inference.ts`, `ollama.ts`.

```ts
discoverModels(connection, secret?, signal?)
complete({ connection, model, secret?, messages, tools?, signal, onText })
embed({ connection, model, secret?, texts, signal })
```

Le credenziali non appartengono al catalogo. Il chiamante le recupera dal registro
server e le passa separatamente all'operazione. Redirect HTTP non seguiti; DNS
validato e fissato alla connessione; destinazioni metadata/link-local/non-unicast
rifiutate; gli indirizzi LAN e loopback restano consentiti per il cluster.

| Tipo | Catalogo | Inferenza | Note |
|---|---|---|---|
| OpenAI compatibile, LM Studio, engine locali, GemRouter | `GET /models` | `POST /chat/completions` | Percorsi relativi al base URL configurato, normalmente `/v1`. |
| OpenAI Responses | `GET /models` | `POST /responses` | Metadati nativi conservati internamente per i successivi scambi con tool. |
| Gemini | `GET /models` con paginazione | `:streamGenerateContent` | Chiave in header, nessuna chiave nell'URL. |
| Ollama | `GET /api/tags` | `POST /api/chat` NDJSON | Contatori tokenizer e durate nativi. |

Il catalogo non inventa capacità. Se il provider non dichiara tool, visione,
embedding o finestra di contesto, questi dati rimangono sconosciuti o devono
essere impostati esplicitamente dall'operatore. L'esistenza di un modello nel
catalogo non dimostra che sia caricato o che il suo template supporti tool.

### Misure

Ogni risultato include l'uso restituito dal provider e le misure della singola
invocazione. `ttftMs` è misurato dal gateway e include attesa/trasporto. Il decode
e il prefill vengono mostrati solo se l'engine li fornisce.

Per Ollama le durate sono convertite da nanosecondi. La documentazione corrente
definisce `prompt_eval_duration` sui token non in cache: il throughput di prefill
è quindi calcolato soltanto quando è presente anche `prompt_eval_cached_count`.
In caso contrario rimane disponibile la durata, senza un tasso ambiguo.

`contextUsed` della singola invocazione deriva da input e output riportati. Non
misura la memoria GPU e non va sommato tra più invocazioni per descrivere una
finestra di contesto. Il piano di controllo aggrega il consumo della missione
separatamente.

### Quote

Gli header rate-limit possono fornire richieste residue e `Retry-After`; HTTP 429
identifica un limite osservato. Non tutti i provider espongono questi campi.
Assenza significa quota sconosciuta. Gli adapter non deducono percentuali da un
numero locale di messaggi e non ruotano credenziali al loro interno.

### Embedding

Ollama usa `POST /api/embed` con `truncate:false`; gli endpoint compatibili OpenAI
usano `POST /embeddings`. Si validano corrispondenza agli input, ordine, dimensione
e valori finiti. Sono vettori prodotti da un modello reale, non hash trasformati
in vettori. Archivio, ACL, versioni, ricerca ibrida e provenienza appartengono al
modulo memoria del piano di controllo. Gemini/CLI non vengono presentati come
adapter embedding supportati in questa release.

## Runtime ufficiali

Modulo: `src/adapters/native.ts`.

```ts
inspectNative({ connection, cwd, signal })
loginNative({ connection, cwd, signal, onAuth })
runNativeAgent({ connection, model, cwd, prompt, readOnly,
  signal, approve, onEvent, resumeId? })
```

**Codex:** app-server ufficiale. Ogni account richiede `CODEX_HOME` assoluto,
privato (0700), appartenente all'utente del servizio e non symlink. Login,
ispezione e turni sullo stesso account sono serializzati. Un'operazione in coda
può essere annullata senza sbloccare prematuramente l'account.

Il device login verifica l'URL HTTPS ufficiale e la conferma del credential store
isolato. Il callback contiene soltanto URL, codice e identificatore temporaneo;
il supervisor lo consegna all'utente proprietario senza scriverlo in cronologia,
log o memoria. Il risultato finale richiede la conferma di un account ChatGPT.
Finestre di quota ufficiali restano separate: non sono un singolo saldo fungibile.

**Antigravity:** ACP della CLI ufficiale `agy acp --sandbox`. La discovery 0.4
esegue realmente initialize/session e usa soltanto il catalogo o il modello
corrente dichiarato dal runtime; non costruisce una lista di nomi Gemini.
Quando il login manca, indica `agy acp --login` da eseguire con l'utente del
servizio e richiede una nuova verifica. La sessione deve
essere autenticata con il flusso ufficiale sul server. Modalità sola lettura,
OAuth guidato, quote numeriche e isolamento multi-account non sono verificati;
non sono dichiarati disponibili. Le operazioni sono serializzate e il piano di
controllo limita la connessione a un profilo dedicato configurato dall'operatore.

Gli adapter delegano il sandbox alla CLI e inoltrano le richieste di approvazione
supportate. Non promettono controllo completo di ogni effetto di MCP o plugin
esterni. Cancellazione, timeout e terminazione dell'albero processi sono gestiti.

La CLI usa il filesystem del processo che la avvia. Il percorso di un target SSH
non diventa automaticamente un percorso locale del coordinator: usare i tool
remoti del piano di controllo con un modello HTTP oppure un runtime esplicitamente
installato e gestito sul target. Evitare mapping impliciti del `cwd`.

I moduli di trasporto e protocollo in `src/adapters/vendor/` derivano dai moduli
TypeScript MIT di HaloForge / yed1z Unified 0.2.0. La licenza e la provenienza sono
incluse in quella directory. Non è stato incorporato codice di OpenCode, Pi,
Goose o DeepSeek Harness.

## Telemetria multi-macchina

`collectLocalTelemetry()` è una sonda TypeScript una tantum, eseguibile dal runner
locale o SSH. Legge CPU e memoria del sistema operativo, sensori Linux sysfs,
GPU NVIDIA tramite `nvidia-smi`, GPU AMD tramite sysfs e spazio disco. Non avvia
un nuovo servizio. Ogni campione ha schema `yed1z.telemetry.v1` e timestamp.
Sensori mancanti rimangono assenti; lo zero autentico viene mantenuto.

`sampleTelemetry()` può leggere un endpoint HTTP configurato; `normalizeTelemetry()`
normalizza i campioni. Stato e freschezza sono per nodo, non un singolo flag globale.

**Limite della sonda legacy:** nello snapshot di `aireward-node-agent.py` sono
presenti fallback numerici fissi quando i sensori falliscono, tra cui CPU 42°C e
GPU 45°C. Un timestamp aggiunto dal gateway certifica la ricezione, non l'origine
del valore. I payload legacy sono quindi classificati `legacy-unverified` e i
valori non verificabili non vengono promossi a misure live. Installare il runner
TypeScript sui nodi per le misure verificate della nuova dashboard.

## Caricamento e commutazione engine

Modulo `src/adapters/lifecycle.ts`:

```ts
isEngineReady({ modelsUrl, expectedModel }, signal)
waitEngineReady(spec, signal, onStatus)
ensureHttpEngine({ modelsUrl, expectedModel, switchUrl, body }, signal, onStatus)
```

Queste funzioni ricevono soltanto configurazione dell'operatore. Il chiamante
deve detenere le prenotazioni di tutti i gruppi di risorse fino al termine della
generazione. La discovery del catalogo non avvia o ferma modelli.

Il controllo iniziale evita di riavviare un modello già pronto. L'attivazione è
richiesta una sola volta, poi il sistema attende l'identificatore esatto del modello
su `/v1/models` dell'engine. Errori di autorizzazione o redirect non provocano una
commutazione. Stato `available` di un catalogo statico non significa modello pronto.

Topologia ricavata dai sorgenti del gateway fornito, da convalidare sull'impianto:

| Risorsa | Attivazione esistente | Readiness diretto |
|---|---|---|
| DeepSeek Strix | ricetta operatore `/home/funboy/.local/bin/cluster-model deepseek` | engine sul coordinator, porta 18231 |
| Qwen Strix | ricetta operatore `/home/funboy/.local/bin/cluster-model qwen` | engine sul nodo 01, porta 18562; associazione del template corretta sui sorgenti allegati, da verificare live |
| Qwen CUDA | `POST http://192.168.178.47:8090/switch`, body `{ "model": "qwen" }` | engine sulla 3090, porta 8080 |
| DeepSeek CUDA | stesso endpoint, body `{ "model": "deepseek" }` | engine sulla 3090, porta 8085 |

Il `/models` del node agent CUDA restituisce una lista statica quando l'engine è
spento: **non va usato come controllo di readiness**. L'ID effettivo restituito
dall'engine va configurato, senza assumere che coincida con l'alias pubblico del
vecchio gateway. Gli indirizzi LAN degli Strix non sono hardcoded: le fonti
storiche contengono associazioni contraddittorie di `.67` e `.77`.

Le prenotazioni del nuovo orchestratore non possono proteggere da uno script
esterno che termina arbitrariamente un engine. Durante il passaggio operativo va
stabilito un solo proprietario delle commutazioni e vanno preservati i lock già
usati dalla ricetta `cluster-model`.

## Fonti primarie e verifica

- [Ollama chat](https://docs.ollama.com/api/chat): conteggi, cache e durate.
- [Ollama embedding](https://docs.ollama.com/api/embed): vettori e troncamento.
- [Ollama catalogo](https://docs.ollama.com/api/tags): modelli disponibili.
- [Gateway originale](https://github.com/0xfunboy/StrixHaloCluGateway): topologia,
  routing e lifecycle confrontati con lo snapshot locale fornito.

I test usano server HTTP reali su loopback e processi RPC fixture. Verificano
discovery, SSE/NDJSON, Responses/Gemini, quote, cache/tempi, embedding, redirect,
cancellazione, sandbox, login ufficiale simulato, isolamento del profilo e
lifecycle. Non costituiscono una verifica con account reali, GPU dell'impianto
o versioni installate delle CLI.
