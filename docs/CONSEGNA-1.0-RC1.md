# yed1z Control Room 1.0.0-rc.1

Candidato del 18 novembre 2026 per il Gateway di Funboy e Cooper. Il checkout TypeScript di partenza è `d8bf705`. Il Gateway storico si trova nella linea Git separata che termina originariamente in `1af039f`. Il bundle di consegna conserva la storia del codice con i dati operativi privati rimossi.

## Entrare nel progetto

Apri la porta 8081 del coordinator o il dominio abituale e accedi con la tua chiave. **Percorso del progetto** collega la richiesta originale, i rami della conversazione, le dipendenze fra agenti, il registro degli eventi e le prove. Seleziona un nodo per leggere cosa è successo a quel task. Seleziona un evento precedente per leggere il grafo fino a quel punto. Il pulsante di ramo crea una conversazione che conserva i messaggi fino al turno scelto. La chat resta disponibile durante una missione. **Istruzioni alla squadra** indirizza lo steering al lavoro in corso.

Nel composer scegli la rotta per il turno o salva il default di progetto con l’azione dedicata. **Modelli e account** distingue profilo, provider, nodo, catalogo, credenziale e stato del motore. L’HTTP di inferenza e il workspace di esecuzione hanno selezioni separate. **Cluster** mostra le risorse del coordinator, **Fleet monitor** apre la plancia dei motori e **Cockpit Strix** apre l’HUD hardware storico.

## Login, quote e selezione del modello

- **Codex.** Crea o scegli un account, avvia il device login e completa il consenso nell’URL ufficiale. Ogni nuovo profilo usa una directory privata. Il coordinator rilegge identità, modelli e finestre di quota del runtime.
- **Antigravity.** **Accedi con Google** avvia `agy acp --login`. Dopo il consenso inserisci il codice o la pagina di ritorno nel campo del progetto. Il valore viene inviato soltanto al processo di quel login. La successiva sessione ACP determina il catalogo. La guida propone anche il comando di terminale per lo stesso profilo. Con più account completa il consenso di ciascuno. La CLI installata richiede l’autorizzazione Google del titolare per effettuare la prima generazione.
- **GemRouter.** L’istanza configurata usa la base `https://gemr.airewardrop.xyz/v1`. Il segreto viene conservato dal coordinator sul profilo. Il catalogo dipende dall’account. La scoperta e l’inferenza hanno esiti separati.
- **Quote.** In **Auto** scegli le rotte ammesse per il progetto. Il coordinator considera le risorse occupate e confronta quote recenti per account equivalenti. Due profili dello stesso proprietario possono dichiarare lo stesso dominio di quota. Un limite osservato su quel dominio blocca gli altri profili associati. Una 429 HTTP prima di testo o effetti permette di scegliere un’alternativa autorizzata. Il modello fisso conserva la scelta. Per le fonti senza misure il pannello mostra quota sconosciuta.
- **Nodi.** Le connessioni parlano direttamente con l’engine oppure attraverso `dist/node-bridge.mjs`. Il bridge supporta motori OpenAI-compatible e Ollama, autenticazione distinta sui due lati, inoltro dello stream e cancellazione. Le istruzioni riportano anche il collegamento fra due macchine via SSH. [Adapter di nodo](NODO-INFERENZA.md)

## Memoria e prove del lavoro

La Knowledge usa documenti, memorie approvate, revisioni e citazioni del progetto. Dal risultato di ricerca puoi aprire il passaggio originale e verificare revisione e digest. Il lettore interno adatta a TypeScript la memoria condizionata dalla domanda descritta in Memorilla e restituisce prove testuali utilizzabili dalle diverse fonti di inferenza. La nota tecnica documenta i passaggi matematici, il fallback lessicale e le differenze rispetto al decoder addestrato dagli autori. [Implementazione Knowledge](KNOWLEDGE-MEMORILLA.md) · [Sorgente del progetto di ricerca](https://github.com/snap-stanford/memorilla)

Una missione registra la specifica usata, i tentativi degli agenti, gli effetti degli strumenti, file, digest e risultati delle verifiche. Se si interrompe durante una scrittura, la riconciliazione richiede l’esito osservato prima della ripresa. Il progetto può scegliere un worktree Git locale isolato. La promozione crea un riferimento Git al commit verificato. La pulizia esplicita controlla che il worktree sia pulito. La consegna sul target usa la ricetta di deploy del progetto, seguita dal suo health check e dal rollback configurato.

## Collaudo sui servizi reali

| Fonte | Osservazione del 18 novembre |
|---|---|
| Codex nativo | Tre profili ispezionati. Un account autenticato ha restituito quattro modelli, finestre di quota e una risposta reale con uso misurato. Gli altri due richiedevano il login. |
| Antigravity 1.5.10 | Negoziazione ACP e richiesta di autenticazione rilevate dal profilo storico e da uno nuovo. L’API del candidato ha avviato un login ufficiale su `accounts.google.com`, atteso il codice e gestito l’annullamento. Il consenso Google e due sessioni di generazione autenticate restano da provare con i titolari. Il test con due profili indipendenti e catalogo dopo il consenso è passato con una CLI di prova. |
| Strix Qwen | `qwen38-uncensored-gufo` su `:18562` ha risposto `OK`. Dopo il test DeepSeek è stato ripristinato e ha risposto di nuovo, TTFT 1,837 s. |
| Strix DeepSeek | `deepseek-v4.1-flash` su `:18231` ha restituito il catalogo e generato `OK`, TTFT 5,204 s. Il controllo opzionale delle capacità visive ha ricevuto HTTP 404. |
| CUDA Qwen | Avvio tramite agente Strata. Catalogo diretto dopo 27 s, `qwen3.8-flash-next-iq3_s` ha generato `OK`, TTFT 0,911 s. |
| CUDA DeepSeek | Catalogo diretto dopo 24 s. `deepseek-v4.1-flash` ha generato `OK`, TTFT 3,977 s. Verificati arresto, stato `idle` e ritorno delle porte di inferenza allo stato iniziale. |
| Adapter su due macchine | Su `02-evo-x3-tb` e `aireward-llm` è stato avviato il bundle su loopback mediante SSH. Per ciascuno verificati sensori locali, catalogo e stream con risposta `OK` attraverso un tunnel verso Qwen Strix. Le prove CUDA sopra hanno usato l’engine reale della 3090. |
| Qwen dentro Codex | Codex CLI ha usato la facciata `/v1/responses`, ha chiesto un comando di lettura e ha restituito il marker casuale di un file in un workspace isolato. Il percorso comprendeva il bridge e Qwen Strix reale. Il test è ripetibile con `scripts/canary-codex-local.ts`. |
| GemRouter | Con la chiave valida il catalogo ha restituito `gpt-6.2-astra`, `gemini-3.8-flash` e `gemma-4-31b-it`. Astra ha generato `OK` con uso dichiarato dal provider. Durante il primo giro in streaming, Gemini ha segnalato alta domanda e Gemma timeout a monte. Il router non ha dichiarato quote numeriche per questi modelli. |

I tempi rappresentano singole richieste. Un test separato ha usato due utenti simultanei, un engine HTTP controllato con risposta dopo 40 ms e capacità uno. Con quattro richieste concorrenti sono riuscite 32/32, con attesa p50/p95 di 49/139 ms e primo contenuto a 116/187 ms. Con otto concorrenti sono riuscite 64/64, attesa 135/309 ms e primo contenuto 186/358 ms. Il picco reale del team richiede misure di esercizio.

## Installazione, diagnosi e rollback

Per installazione pulita usa Node 24.15 o successivo della serie 24. Il server, CLI e bridge nel bundle funzionano senza installare i pacchetti di sviluppo. Per ricostruire dai sorgenti usa `npm ci`, `npm run check`, `npm run smoke`, `npm run package:vsix`. Per verificare la facciata Responses e uno strumento dal client Codex reale:

```bash
YED1Z_CANARY_UPSTREAM=http://127.0.0.1:18562/v1 \
YED1Z_CANARY_MODEL=qwen38-uncensored-gufo node scripts/canary-codex-local.ts
```

Per provare catalogo e generazione dalla stessa libreria usata dall’harness:

```bash
node dist/cli.mjs probe --kind gemrouter --url https://gemr.airewardrop.xyz/v1 \
  --key-env GEMROUTER_API_KEY --generate --model gemini-3.8-flash
```

Per ripristinare le chiavi storiche usa una mappa privata da nome storico a ID utente già presente. La procedura accetta un export esplicitamente autorizzato, conserva i ruoli e verifica collisioni e proprietà prima di scrivere. Il primo comando di importazione, senza `--apply`, presenta il conteggio. Nel collaudo su backup coerente sono state attribuite tre chiavi a ciascun proprietario, ricontrollate sei credenziali in modo idempotente, importati 20 giorni di dati aggregati privati e verificato il ritorno allo stato precedente.

```bash
node dist/cli.mjs import-gateway --state /percorso/stato \
  --keys /percorso/privato/api_keys.json --owners /percorso/privato/owners.json \
  --stats /percorso/privato/stats.json --usage-owner ID_AMMINISTRATORE
```

Per il rollback del servizio ferma il coordinator, conserva una copia dello stato corrente e ripristina insieme runtime e stato privato coerente dal backup precedente. Verifica `/api/health`, il login di entrambi i proprietari e il catalogo. Un eventuale rollback dopo nuove attività richiede di riconciliare tali attività prima del ripristino. Il backup operativo e le directory dei profili rimangono sulla macchina.

## Encoder locale in esercizio

Il servizio CPU `yed1z-local-encoder.service` espone MiniLM multilingue su `127.0.0.1:18462/v1`. Produce vettori reali di dimensione 384. Per i nuovi progetti il coordinator può assegnare l’encoder attraverso `defaultEmbeddingProviderId`. Per il default locale su loopback avvia l’indicizzazione dopo il caricamento di un documento o l’approvazione di una memoria. I testi lunghi vengono suddivisi prima dell’inferenza in segmenti configurabili, ricomponendo i vettori dei segmenti per lunghezza. Nella prova multilingue su questo impianto una domanda inglese ha recuperato una fonte italiana con revisione, hash e posizione verificabili. [Installazione riproducibile dell’encoder](ENCODER-LOCALE.md)

La facciata ha ricevuto anche richieste senza streaming direttamente dall’istanza GemRouter. Nel secondo giro `gemini-3.8-flash` ha superato la finestra di attesa di 65 s e `gemma-4-31b-it` ha restituito HTTP 503 con indicazione di alta domanda. Il canary di progetto ha poi confermato una risposta reale di Astra via GemRouter nella stessa conversazione di Codex e Qwen.

## Consegna sulla porta 8081

La versione servita è `1.0.0-rc.1`. Il dominio HTTPS e il coordinator hanno risposto con gli stessi byte per la Control Room, i due cockpit, il JS e il CSS. Tutte e sei le chiavi storiche hanno effettuato il login con il rispettivo ruolo. Il catalogo di inferenza ha restituito 24 rotte all’amministratore e 5 all’operatore nella configurazione collaudata. La connessione GemRouter è privata del titolare. [Apri la Control Room](https://yed1z.ai/control) · [Fleet monitor](https://yed1z.ai/cockpit) · [Cockpit storico](https://yed1z.ai/cockpit/classic)

Nel progetto **Collaudo RC1 · inferenza e memoria**, Codex, Astra via GemRouter e Qwen Strix hanno ripreso la stessa conversazione e restituito l’identificativo concordato. La ricerca della memoria approvata ha usato l’encoder locale e ha restituito una citazione. Il progetto conserva anche i tentativi falliti, compreso l’errore MCP `-32603` nella prova di revisione nativa Codex nel worktree. Il reviewer della missione completata è Qwen.

La missione `run_572355bae00d4d91a6acbf635434f78f` mostra il piano di Astra via GemRouter, l’implementazione e la review di Qwen, i comandi `npm test` e `npm run build` e il loro esito. In un worktree dedicato è cambiato solo `index.js`. La promozione via API ha creato un ramo al commit del progetto dimostrativo `297b0b33fd51f50fe0d4a076e1bae68448eaad9b`. Il verificatore e il checkout di partenza hanno conservato il loro contenuto. Il runner installato ha poi verificato due copie di quel commit con approvazione separata. Un controllo health ha restituito 200, l’altro ha restituito 503 e ha attivato il rollback verificato. Il target condiviso del coordinator non ha una ricetta di deploy applicativo configurata. Il rapporto della prova isolata è nel progetto con ID `art_31afb7df78164185b13db6a392500781`. [Apri il percorso della missione](https://yed1z.ai/control#project=prj_a01c8e17110b4677a82f5fa3fb7fd509&conversation=conv_4bbfac2b8beb4c67b41a11184352559b&run=run_572355bae00d4d91a6acbf635434f78f&view=journey)

Nel test concorrente reale due operatori hanno inviato tre richieste sovrapposte via 8081. Strix Qwen ha servito Chat Completions in streaming con coda 0 ms, poi Responses con attesa 844 ms. CUDA Qwen ha servito Chat Completions JSON con coda 1 ms mentre Strix lavorava. Tutte e tre hanno restituito HTTP 200 e il testo atteso. CUDA è tornata inattiva e Strix Qwen è rimasta disponibile. I due nodi remoti hanno runner e bridge con SHA-256 identico ai rispettivi bundle del coordinator.

Il backup coerente prima dell’aggiornamento dalla 0.4 si trova in `/home/funboy/.local/share/yed1z-private-backups/pre-rc1-20261118-025259`. La copia prima dell’ultimo aggiornamento della RC è in `/home/funboy/.local/share/yed1z-private-backups/rc1-final-20261118-034106`. La prova su copia ha ripristinato 0.4.0, login e dati dopo il passaggio alla RC. La 8081 serve la nuova versione. Entrambi i progetti preesistenti hanno ricevuto la rotta embedding dove mancava. La prima indicizzazione ha calcolato due passaggi nel progetto dimostrativo e zero nel progetto vuoto.

Il comando `npm run check` ha superato il controllo TypeScript e tutti i 256 test su Node 24.18.0. Lo smoke ha provato avvio dai bundle, setup ripetuto, autorizzazioni, cookie, asset, workspace e arresto pulito. Il VSIX distribuito ha SHA-256 `5f6295c89f253d96b4b9d6c9b5e29b0709eaa011b8bd5a457e9bca1b3c9e4701`. Il monorepo include `release/RELEASE.json`, i checksum dei file e il bundle Git con le linee 0.4, Gateway storico e release. `HANDOFF.md`, `docs/VERIFICA.md` e `docs/VALIDATION.txt` sono resoconti della versione 0.4. Il presente documento raccoglie le verifiche della RC.

## Stato delle prove del piano

| Prova | Evidenza disponibile | Verifica ancora aperta |
|---|---|---|
| P1 · Continuità | Una chat reale con tre fonti, memoria e file conservati. Qwen dentro Codex con strumento di lettura reale. | Nel turno esplicito sul progetto il provider ha risposto ancora alta domanda. |
| P2 · Connessioni e utenti | Sei login Gateway, account Codex autenticato, consenso Google avviato, errore e correzione della chiave GemRouter. Profili multipli, accessi delegati e rotazione su 429 esercitati in test controllati. | Seconda identità Codex autenticata, due consensi Google e generazioni Antigravity reali. |
| P3 · Controllo della squadra | Planner e developer/reviewer distinti in missione reale. Pausa selettiva, avanzamento degli altri agenti, modifica e ripresa verificati in suite. | Ripetere il controllo concorrente completo con due operatori fra editor e Web. |
| P4 · Routing | Due utenti, tre richieste reali sovrapposte su due motori, prenotazioni, coda e ripristino. Controlli automatici di scadenza sonde e duplicazione degli effetti. | Riprodurre occupazione da client esterno e switch concorrente nelle condizioni di uso abituali. |
| P5 · Chat e misure | Sette turni riconciliati con il registro SQLite. Tre chiamate API per 180 token di input e 88 di output. Due domande di stato hanno risposto in 7 e 5 ms con zero chiamate modello e contatori invariati. | Riconciliazione su ogni provider in condizioni di esercizio. |
| P6 · Prova grafica | Percorso della missione vera, registro e DAG consultabili. Prove grafiche e tastiera riportate più sotto. | Rieseguire lo scenario combinato con fallback, pausa e correzione e misurare l’usabilità con gli utenti del team. |
| P7 · Produzione e recupero | Worktree, prove, promozione e health positivo/negativo con rollback circoscritto al canary. Recupero, riconciliazione e protezione dal replay coperti da test. | Esercitazione sul target applicativo scelto dal team con una sua ricetta di deploy. |
| P8 · Gateway e scala | Rotte, alias, Chat Completions e Responses sotto contesa reale, 96 richieste sintetiche, import dati e accessi. | Test all’intero picco e al doppio del picco osservato in esercizio, con i client storici effettivamente in uso. La porta di riferimento è 8081. |
| P9 · Consegna | Pacchetto autonomo, VSIX, storia Git ripulita, migrazione reale per proprietario e rollback su copia coerente. | Verificare altri export privati legacy quando i proprietari li metteranno a disposizione. |


## Interfaccia e misure

Nel progetto e in VS Code il comando **Aspetto** controlla tema e movimento. Il tema può essere chiaro, scuro oppure seguire il sistema. Le preferenze dell’utente sono memorizzate sul coordinator. Fleet e cockpit storico le ritrovano con la stessa sessione. La preferenza di sistema per il movimento ridotto è rispettata. Il cockpit storico mantiene anche il selettore italiano/inglese. La Control Room e il wizard sono attualmente in italiano.

Il collaudo Firefox ha coperto desktop 1366 px, 1920×1080, browser a 390 px e zoom nativo al 200%. Nel workbench Web ufficiale Microsoft VS Code 1.146 sono state provate barre da 320 e 480 px e il ritorno del focus alla chiusura del wizard da tastiera. L’estensione è stata installata anche sul target Remote SSH. Dopo il collaudo nel workbench è stata aggiornata la sola pagina README contenuta nel VSIX. È stata verificata l’uguaglianza byte per byte degli altri tredici file del pacchetto. La registrazione Firefox mostra il passaggio dal grafo reale di una missione al task e al risultato di `npm test`. Nel pacchetto, `release/evidenze/` raccoglie la registrazione, le viste desktop e strette, il tema chiaro e il confronto con l’HUD originale. Nella schermata storica di confronto la telemetria è vuota, come indicato nella nota allegata.

Il pannello **Consumi** distingue richieste alla facciata, turni di conversazione e singole chiamate degli agenti di missione per account e rotta. Gli eventi di completamento recenti conservano i token dichiarati dal provider. Per i turni nativi la nuova build mostra durata di sessione e uso effettivo quando riportato dal runtime. I turni archiviati conservano le metriche della versione che li ha generati.


## Missione finale con tre fonti

Il planner Astra via GemRouter ha costruito il piano, il coder Qwen su Strix ha modificato `index.js` e il reviewer Codex autenticato ha letto quel file con `yed1z_read_file`. L’evidenza `ev_dd35f514aa90499c99b4590579d482f7` contiene il percorso, il testo letto e il suo SHA-256. Il nuovo adapter espone al runtime Codex lettura, elenco e ricerca nel worktree assegnato anche quando i comandi shell sono disabilitati. Questa missione verifica sul servizio condiviso la correzione dell’errore MCP riportato nel precedente collaudo. Test e build sono passati sul candidato `399fe4f8f0544cf3575ab5ab531afbe73f9d286b`. [Apri piano, task, eventi e prove](https://yed1z.ai/control#project=prj_a01c8e17110b4677a82f5fa3fb7fd509&conversation=conv_45a5e456f0f64da0ade6f5195ab204dd&run=run_77493637591d425593274d3431c4c19c&view=journey)

Il confronto fra gli otto eventi e i consumi per account ha restituito 2 chiamate Astra (15.518 token di input e 469 di output), 5 chiamate Qwen (20.506 e 1.696) e un turno nativo Codex (35.044 e 377). Il dominio pubblico e la 8081 hanno restituito lo stesso JS e CSS. I limiti di quota segnalati dal provider, le attese locali e gli effetti degli strumenti si consultano nel registro della missione.


## Aggiornamento della home hardware · 18 novembre 2026

Dopo la prima consegna della RC, la radice pubblica e `/index.html` sono tornate all’HUD storico con telemetria. L’applicazione di progetto resta su `/control` e Fleet su `/cockpit`. Firefox ha verificato la pagina pubblica, il collegamento nei due sensi e la migrazione dei vecchi segnalibri di progetto. Questa revisione ha superato 257 test, typecheck, build e smoke. Il VSIX del ripristino, installato su Remote SSH, ha SHA-256 `7270f8b2badff3c50e7834689d26509ae449e7aa465bb8824750b3077390bc1f`. Il digest precedente identifica il pacchetto della prima consegna. [Indice delle funzioni](README.md) · [Schermata del monitor pubblico](media/dashboard-hardware.png)
