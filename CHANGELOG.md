# Changelog

## 0.4.0 · 17 novembre 2026

### Base della modifica

La base è il tuo archivio installato e modificato
`StrixHaloCluGateway-feature-distributed-control-room.zip`, registrato nel commit
`eb9f7f9e4bd96d252aad7c809fc94ec74fae06a0`. Il confronto visivo e infrastrutturale
usa anche `StrixHaloCluGateway-main_2.zip`. Non è stata sostituita la tua base con
una copia precedente del progetto.

Conservati: vista ospite, API di monitor, intento del collegamento Antigravity
dalla UI, modello di dati 0.3 e identità dell'estensione `funboy.haloforge`.

### Esperienza d'uso

- Tema HUD comune a conversazioni, infrastruttura, squadra, memoria e connessioni,
  coerente con palette e geometrie della dashboard storica.
- Flusso di attività animato da eventi reali; contesto, inferenza, strumenti ed
  evidenze distinguibili. FX disattivabile e reduced motion rispettato.
- Modalità Auto: saluti/stato del servizio immediati e attribuiti, domande in chat,
  richieste operative in missione senza concedere automaticamente permessi.
- Picker con disponibilità, code, cooldown e alternative autorizzate. Aggiornamenti
  live senza ricreare form, perdere focus, scroll o ricerca.
- Collegamento in un'operazione: preset, endpoint precompilati dove noti,
  rilevamento limitato, credenziali, discovery e scelta del modello.
- Cronologia lunga mostrata progressivamente; streaming raggruppato per frame.
- Correzioni di accessibilità e layout stretto: sidebar inattiva fuori dal tab
  order, nomi accessibili dei pulsanti iconici, pannello squadra confinato al
  viewport, ritorno ospite dal login, protezione da risposte tardive del wizard.

### Connessioni e catalogo

- Servizio `Connections`, tipi condivisi e API `options`, `detect`, `connect`.
- Retry idempotenti senza duplicare account/provider; credenziali correggibili
  sullo stesso account. Il rifiuto del provider non disconnette il portale.
- Codex: profili privati per account, login ufficiale, discovery automatica dopo
  conferma, stato occupato distinguibile da login mancante.
- Antigravity: verifica ACP reale; rimossi il catalogo inventato e il falso esito
  di login. CLI mancante, login necessario e protocollo non compatibile hanno
  azioni distinte. Mantiene i limiti di profilo unico e ruolo sviluppatore.
- Ollama: arricchimento limitato dei metadati con `/api/show`, senza generazione
  o caricamento. Capacità e contesto restano ignoti quando non dichiarati.
- Standby distinto da autenticazione/readiness riuscite; ammesso solo dove esiste
  un'attivazione configurata. Un 401/403 non diventa un successo da cache.
- Una discovery completa disabilita le route assenti preservandone gli ID per la
  cronologia; un riavvio non le rende nuovamente disponibili. Le dichiarazioni
  esplicite dell'operatore restano distinguibili dai metadati del provider.
- Modifica delle associazioni hardware sui provider UI propri e inattivi;
  configurazioni da file protette, variazioni durante lease/code/run rifiutate.
- Il bridge VSCode richiede i segreti nel processo host anche per la nuova API.

### Routing e tempi

- Prenotazione atomica di un candidato fra modello scelto e alternative esplicite.
- Vincoli dell'intero provider e di tutti i nodi preservati anche con override
  della route; semaforo per account oltre ai gruppi hardware.
- Quote, accesso, capacità e topologia ricontrollati dopo l'attesa.
- Priorità interattiva con limite ai sorpassi, code cancellabili e con scadenza.
- Probe opzionali dell'engine, indipendenti dalla GPU%; carico esterno distinto
  dai conteggi del coordinator e dalle metriche delle risposte.
- Snapshot di disponibilità ogni due secondi, senza nuovi campioni hardware finti
  né eventi di heartbeat nella cronologia dell'agente.
- Chat con una completion, retrieval vettoriale opzionale limitato a 600 ms e
  contesto FTS disponibile se il modello embedding è occupato.
- Quote/prestazioni mancanti rimangono ignote; nessun cambio account dopo un
  errore di streaming o una chiamata a tool eseguita.
- Interruzioni dopo testo parziale o effetto mutativo conservate come checkpoint:
  il ciclo di riparazione non ripete silenziosamente un comando completato.

### Monitor e rilascio

- Dashboard pubblica preservata, con rimozione di dati privati, URL, indirizzi,
  identità account e dettagli/errori dei sensori. Disattivabile da configurazione.
- Budget SSE ospite separato da quello per account autenticato.
- Template corretto: Qwen del sorgente allegato usa Strix 01; DeepSeek distribuito
  prenota entrambi. È un riferimento da verificare contro l'installazione reale.
- Versioni coordinate di server, CLI, manifest npm e VSIX. Pacchetto completo con
  bundle, test, documentazione e handoff di collaudo/migrazione.

### Stato di verifica

Risultati esatti e log in [`docs/VERIFICA.md`](docs/VERIFICA.md) e
[`docs/VALIDATION.txt`](docs/VALIDATION.txt). Nessun collaudo dei tuoi account,
sensori o engine di produzione è sostituito dai test locali. La revisione grafica
in browser/VSCode reale resta da eseguire: il browser non era avviabile/autorizzato
nell'ambiente di sviluppo. Nessun servizio del cluster è stato fermato o modificato.

## 0.3.0 · 16 novembre 2026

- Sostituito il coordinator Python con un unico runtime TypeScript.
- Separati nodi, risorse di inferenza, account/model route, target di esecuzione e destinazioni di rilascio.
- Introdotti scheduler atomico, missioni persistenti, DAG, controllo per task e ciclo review/verifica/riparazione/rilascio.
- Aggiunti workspace locali/SSH con runner stateless, gestione esiti incerti, ricette e lease anche su directory sovrapposte.
- Ripensata l'interfaccia come Control Room condivisa da web e VS Code.
- Aggiunti allegati, memoria revisionata, ricerca testuale/vettoriale, contesto ispezionabile e report di consegna.
- Implementata telemetria TypeScript, comprese interfacce e contatori di rete; fallback legacy marcati non verificati.
- Conservati adapter ufficiali Codex/Antigravity e provider HTTP, con limiti espliciti di account/sandbox.
- Introdotti ruoli, cifratura dei segreti e import idempotente dello storico 0.2.
- Nessun aggiornamento della produzione o rimozione di servizi è stato eseguito durante la preparazione.
