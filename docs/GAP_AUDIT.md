# Gap audit: dalla 0.2 a yed1z Control Room 0.3

> Documento storico della base 0.3. Le correzioni della 0.4 sui sorgenti installati
> sono in [`../CHANGELOG.md`](../CHANGELOG.md), [`UX.md`](UX.md),
> [`CONNECTIONS.md`](CONNECTIONS.md) e [`ROUTING.md`](ROUTING.md).
> Il piano di collaudo corrente e le priorità successive sono in
> [`../HANDOFF.md`](../HANDOFF.md).

## Obiettivo e criterio di valutazione

L'obiettivo richiesto è un prodotto in cui l'utente dialoga con il proprio
orchestratore, vede la squadra e l'infrastruttura distribuita, conserva il
contesto del progetto e può arrivare a un rilascio verificato. Il confronto
seguente valuta questo obiettivo rispetto ai sorgenti della 0.2 e della 0.3.

**La 0.2 aveva unificato l'accesso, ma non possedeva ancora il ciclo completo
del lavoro distribuito.** Aveva chat persistenti, provider, account, metriche,
worker dell'harness e un client VS Code comune. Rimanevano separati il modello
del progetto, la squadra, le risorse fisiche, la conoscenza recuperabile e la
consegna controllata.

La 0.3 introduce queste responsabilità nel coordinator. Non certifica però
l'installazione esistente e non elimina la necessità di configurare e collaudare
i nodi, le ricette e l'interfaccia sul sistema reale.

## Matrice delle capacità

| Area | Situazione nella 0.2 | Implementato nella 0.3 | Limite o lavoro restante |
| --- | --- | --- | --- |
| **Linguaggio e struttura** | Gateway Python con worker e client TypeScript. | Core, server, adapter, runner, web e VS Code in TypeScript; contratti condivisi. | Engine GPU esterni mantengono i loro linguaggi. Non vengono riscritti nell'harness. |
| **Singolo servizio del prodotto** | Un ingresso comune, con worker per richiesta. | Un coordinator per API, dati, memoria, squadre e monitor; runner locale/SSH su richiesta. | Engine, controller GPU e tunnel restano infrastruttura necessaria. Non esiste un solo processo per tutto l'impianto. |
| **Topologia multi-macchina** | Routing del gateway legato ai target già noti. | Nodi, collegamenti, provider, account, route, gruppi di risorse e target di esecuzione distinti. | Inventario e mappatura fisica da verificare live; indirizzi Strix storici discordanti. |
| **Modello distribuito sui due Strix** | Arbitraggio specifico del gateway. | Prenotazione atomica di tutti i gruppi necessari a una route. | Non controlla richieste o script che bypassano il coordinator. Serve una sola autorità di model switching. |
| **Concorrenza tra modelli** | Possibilità di scegliere target diversi, senza un modello generale delle risorse della squadra. | Coda comune, capacità per gruppo, cancellazione delle attese; embedding e facade API condividono le prenotazioni. | Capacità configurata, senza stima automatica della VRAM o ottimizzazione del costo di caricamento. |
| **GemRouter** | Collegabile come endpoint compatibile. | Provider di inferenza ordinario e selezionabile, con modello/account e risorse dichiarate. | Rotazione e quote interne rimangono in GemRouter; non vengono ricostruite o duplicate. |
| **Orchestratore primario** | Conversazione e ciclo del singolo worker. | Missione persistente con piano, delega, dipendenze, review, verifiche, correzioni e rilascio. | Il ciclo è limitato da tempo, chiamate e iterazioni; non garantisce qualsiasi obiettivo senza configurazione o prerequisiti. |
| **Squadra multimodello** | Adattatori e selezione dei modelli; coordinamento limitato. | Route per orchestratore, ricercatore, sviluppatore e revisore; assegnazioni visibili per task. Modello/account cambiabili in coda o in pausa. | Un task attivo deve prima fermarsi; il nuovo tentativo ricompila il contesto. Non trasferisce a caldo il processo o lo stato interno del modello. |
| **Controllo degli agenti** | Stato principalmente del turno corrente. | Grafo, risultati, eventi, contesto ed evidenze; pausa, ripresa, annullamento e nuove istruzioni per missione e singoli ricercatori/sviluppatori. Dipendenti in attesa, letture indipendenti possono proseguire. | Annullare un ramo mette la missione in pausa dopo le attività già avviate. Nessuna revisione retroattiva automatica dei task conclusi o esposizione del ragionamento privato. |
| **Scritture concorrenti** | Confini del workspace e approvazioni del worker. | Lease sull'intera missione, inclusi workspace sovrapposti; sviluppatori serializzati nello stesso checkout. | Nessun worktree Git per task e nessuna integrazione automatica di branch paralleli. |
| **Tool su macchine remote** | Workspace del worker sul server. | Target locali o SSH, runner stateless, ricette definite sul nodo e protocollo di approvazione. | SSH e target reali non collaudati sul vostro cluster in questa consegna; nessun provisioning automatico delle identità OS. |
| **Creazione del workspace** | Directory server da predisporre. | Preparazione di una sottodirectory validata della radice operatore già esistente, anche via runner. | La radice deve essere creata e autorizzata dall'operatore; non viene usata automaticamente tutta la home. |
| **Utenti e progetti** | Conversazioni separate per identità del gateway. | Utenti con ruoli, progetti con membri, conversazioni e allegati personali, memoria condivisa esplicita. | Nessun SSO/OIDC/SAML o isolamento OS automatico fra tenant. |
| **Esecuzione non fidata** | Controlli dei tool e sandbox delegato alle CLI. | Missioni e CLI riservate a operatori fidati; member limitati a chat HTTP e conoscenza. Ricette sensibili riservate ai controller. | Un test o script con lo stesso UID può accedere ai file dell'account. Per utenti non fidati occorrono UID/container/VM isolati. |
| **Memoria dei metodi** | Cronologia e contesto del worker, senza un archivio completo di metodi recuperabili. | Metodi, decisioni e brief versionati; candidati dalla review, approvazione, scope e provenienza. | Nessun fine-tuning dei pesi o apprendimento autonomo non supervisionato. La qualità dei metodi va valutata sul lavoro reale. |
| **Allegati e ricerca** | Importazione di conversazioni e contesto testuale. | Allegati testuali/Markdown con hash e ACL; FTS5 e ricerca vettoriale opzionale con embeddings reali. | Niente OCR o pipeline PDF/immagini/binary. Indice vettoriale locale lineare, senza ANN dedicato. |
| **Ottimizzazione del contesto** | Preparazione della storia del worker e dei backend. | Compilatore con budget, priorità, fonti, esclusioni e riserva della richiesta corrente. | Token stimati, non tokenizer specifici. Nessuna integrazione Ratel o percentuale di risparmio dimostrata. |
| **Dashboard a colpo d'occhio** | Chat centrale con monitor secondario e pannello Live. | Control Room con stato dei nodi, dialogo e squadra; vista infrastruttura con topologia, risorse e modelli. | Resa visiva in browser e VS Code non collaudata in questa sessione. Non è dimostrata la parità con l'interfaccia Codex/Copilot. |
| **Telemetria hardware** | Normalizzazione del gateway; alcune sonde originali producevano fallback fissi. | Sonda TypeScript locale/SSH, timestamp per nodo, qualità e stato espliciti; payload legacy non promossi a misure verificate. | Installazione delle sonde e confronto con sensori reali da eseguire. Nessuna serie storica hardware persistente completa. |
| **Metriche per risposta** | Misure già correlate al turno. | Misure correlate a invocazioni e risposte, consumo distinto per task/missione, origine del dato. | Engine e provider devono esporre i dati. TTFT non è puro prefill; contesto non è memoria GPU; dati mancanti restano sconosciuti. |
| **Account e quote** | Più connessioni e quote osservate, con limiti dei provider. | Registro server, segreti cifrati, selezione modello/account e conservazione della stessa chat. | Nessuna rotazione automatica di azioni eseguite, nessun saldo inventato, nessuna contabilità monetaria completa. |
| **Codex** | App-server, login guidato e cursori di sessione nel worker 0.2. | App-server ufficiale, profili isolati, login guidato, serializzazione e quote osservate. | La 0.3 ricompila il contesto canonico e non persiste/riusa ancora il cursore nativo fra task. Nessuna equivalenza garantita fra stato interno e chat comune. |
| **Antigravity** | CLI ACP con login esistente e limiti già dichiarati. | Adapter ufficiale ACP per task di scrittura di operatori fidati, su target locale. | OAuth guidato, quota numerica, multi-account isolato e sola lettura verificata assenti. Non usare come planner/revisore read-only. |
| **Release in produzione** | Nessun controller completo di consegna. | Review registrata, test reali, grant di rilascio, ricette, health e rollback osservato. | Ricette dell'ambiente da configurare; non esiste un deploy universale. Un health HTTP dal nodo non sostituisce tutti i test utente e CDN/DNS. |
| **Crash e ripresa** | Checkpoint e conservazione di turni interrotti. | Stato missione durevole, task interrotti al riavvio, approvazioni scadute e gestione degli esiti remoti incerti. | Non è un motore exactly-once. Nessun replay automatico di side effect incerti; riconciliazione necessaria. |
| **API unificate** | API legacy del gateway e API del portale. | API prodotto comune a web/VS Code; facade `/v1/models` e `/v1/chat/completions` con scheduler condiviso. | La facade è testuale e non implementa tutte le API OpenAI. Tool e missioni usano il contratto dell'harness. |
| **Migrazione** | Importatori JSON HaloForge/HaloClu/Kirei nella 0.2. | Importazione della cronologia dal database 0.2 per proprietario, ripetibile e senza sovrascritture. | I vecchi export JSON non sono importati direttamente dalla 0.3. Credenziali, sessioni native e dati assenti dalla sorgente non sono ricostruiti. |
| **Disponibilità del servizio** | Un processo gateway principale. | Singolo coordinator, SQLite WAL e lock dello stato. | Nessuna alta disponibilità o failover del coordinator. Il recupero indica l'interruzione invece di riprendere alla cieca. |
| **Fusione dei quattro harness** | Proposta iniziale di prendere il meglio da OpenCode, DSH, Pi e Goose. | Nuovo coordinamento yed1z con adapter TypeScript riutilizzati da HaloForge. | Non è una fusione completa dei quattro codebase e non ne eredita automaticamente plugin, protocolli, LSP o ogni funzionalità. |

## Che cosa dimostrano i test

Le verifiche locali esercitano trasporti HTTP e RPC fixture, filesystem, processi,
SQLite e un'applicazione HTTP reale. La suite del control plane attraversa
pianificazione, modifica di un file, review, test eseguibile, attesa del rilascio,
pubblicazione di prova e controllo di salute. Un secondo scenario osserva il
rollback quando il controllo fallisce; un terzo impedisce il rilascio quando
il modello approva un prodotto che non supera il test.

Vengono inoltre controllati separazione degli utenti, cancellazione delle memorie
e dei vettori, concorrenza dei due Strix come risorse logiche, contesa degli
embedding, autenticazione, CSRF, quote, cambio account, riavvio e assenza di replay.
Il conteggio consolidato e i comandi di verifica appartengono al rapporto di
validazione della release, evitando numeri divergenti tra documenti.

Questi test non dimostrano:

- che gli indirizzi, le porte e i processi dell'installazione corrente siano
  quelli dello snapshot;
- che i modelli reali abbiano sufficiente qualità, supporto tool e contesto
  per ogni ruolo;
- che account reali, versioni locali delle CLI e quote commerciali funzionino
  come nelle fixture;
- che il cluster regga il carico desiderato o mantenga determinate prestazioni;
- che il prodotto sia stato pubblicato o che un vecchio servizio sia stato rimosso;
- che la resa grafica sia stata verificata su un browser reale o sull'editor.

## Cosa serve per la consegna operativa sulla vostra infrastruttura

### 1. Stabilire una mappa certa

Occorre associare a ogni nodo identità verificata, indirizzi raggiungibili,
alias SSH, ruolo, endpoint engine e controller di attivazione. Il punto è
conoscere le dipendenze: un listener in più può appartenere allo stesso processo,
un node agent può servire al lifecycle e un vecchio portale può avere client
ancora attivi.

L'inventario deve produrre una configurazione coerente di nodi, collegamenti,
gruppi di risorse e target. Le descrizioni tratte dai repository sono una base
per il controllo, non un'osservazione live sostitutiva.

### 2. Dare al coordinator l'autorità giusta

L'harness deve essere l'unico punto attraverso cui passano i task che intende
schedulare. Le commutazioni degli engine devono rispettare un'unica autorità:
non è sufficiente aggiungere un lock nuovo se un vecchio script continua a
terminare il processo del modello.

Il workspace di progetto e le ricette devono avere permessi coerenti. L'account
che gestisce lo stato degli utenti non deve diventare un ambiente di esecuzione
per codice di utenti non fidati. Una UI con permessi granulari non risolve da
sola l'isolamento del sistema operativo.

### 3. Collaudare i percorsi utente essenziali

Il collaudo dovrebbe attraversare gli stessi casi richiesti dal prodotto:
accedere con due utenti, ritrovare le proprie chat da web e VS Code, caricare
un documento, approvare un metodo, cambiare modello/account, assegnare ruoli,
osservare nodi e code, interrompere una missione, correggere un task e verificare
un rilascio con rollback.

La verifica visiva deve considerare il monitor completo da browser e il pannello
più stretto di VS Code. Ogni valore mancante o non recente deve essere leggibile;
le decisioni sul progetto non devono richiedere di conoscere nomi di endpoint,
chiavi o dettagli di protocollo.

### 4. Collegare una produzione concreta

Per il primo progetto reale servono ricette di test, build, pubblicazione,
health e rollback riferite a quell'applicazione. I controlli devono definire
che cosa significa «funzionante» per il prodotto: disponibilità del processo,
API, migrazioni, autenticazione, percorsi utente e dipendenze rilevanti.

La ricetta deve poter produrre evidenze e riconciliare un esito interrotto.
Un deploy accettato dal sistema non dimostra automaticamente che ogni funzione
del prodotto finale sia corretta. Il contratto di consegna va espresso attraverso
verifiche osservabili, non lasciato alla sola valutazione linguistica dell'agente.

## Evoluzione del prodotto dopo la 0.3

Le seguenti capacità sono direzioni di progetto, **non funzionalità già presenti**.
L'ordine deriva dai limiti emersi nell'implementazione e dall'esperienza richiesta.

| Passo | Problema che risolve | Criterio di completamento |
| --- | --- | --- |
| Isolamento dei target | Aprire l'esecuzione a utenti meno fidati senza esporre stato e credenziali del coordinator. | Processo di progetto incapace di leggere lo stato di un altro utente; test di confine OS e pulizia del workspace. |
| Worktree e integrazione | Far sviluppare più agenti in parallelo sullo stesso repository. | Branch/task isolati, diff revisionabili, merge serializzato, conflitti espliciti e test sul risultato integrato. |
| Revisione del grafo concluso | Correggere risultati già accettati dopo aver completato task dipendenti. | Invalidazione esplicita di evidenze e dipendenze, nuovo piano revisionabile e riconciliazione degli effetti già prodotti; i controlli sui task attivi sono già presenti. |
| Sessioni native persistenti | Conservare stato e cache dei runtime dove il protocollo lo permette. | Cursori per account/runtime, invalidazione su cambio login o workspace e recupero verificato dopo interruzione. |
| Contesto più preciso | Ridurre sprechi e troncamenti sui modelli effettivamente usati. | Tokenizer appropriati, valutazioni di retrieval e benchmark riproducibili di qualità, latenza e consumo. |
| Osservabilità storica | Analizzare carico, errori e prestazioni oltre la sessione corrente. | Conservazione e retention dichiarate, metriche temporali per nodo e correlazione verificabile con le richieste. |
| Ricette di rilascio più ricche | Coprire applicazioni con migrazioni, più servizi e verifiche esterne. | Manifest degli artefatti, controlli prima/dopo, operazioni idempotenti e rollback o recovery specifici. |
| Identità enterprise | Gestire team più grandi e accesso centralizzato. | SSO, lifecycle utenti, audit e policy di progetto coerenti con il livello di isolamento effettivo. |
| Alta disponibilità | Ridurre il punto singolo di interruzione del coordinator. | Code e lease durevoli, fencing, riconciliazione e test di failover; non due processi attivi sullo stesso SQLite. |

Il criterio per decidere le evoluzioni resta l'utilità per l'utente: poter
delegare un obiettivo, capire che cosa sta succedendo, intervenire senza perdere
il lavoro e accettare una consegna sostenuta da evidenze. Aggiungere pannelli,
provider o nomi di agenti senza questi collegamenti non completa il prodotto.

## Sorgenti dell'audit

- Sorgenti locali di yed1z Unified 0.2: gateway Python, portale, worker e client
  VS Code della consegna precedente.
- [`ARCHITETTURA.md`](ARCHITETTURA.md): modello e confini della 0.3.
- [`ADAPTERS.md`](ADAPTERS.md): protocolli, lifecycle, fonti primarie e limiti delle sonde legacy.
- [`EXECUTION.md`](EXECUTION.md): target, lease, tool, ricette, SSH e confini OS.
- [`MIGRATION.md`](MIGRATION.md): importazione della cronologia e passaggio dei servizi.
- [`tests/control-plane.test.ts`](../tests/control-plane.test.ts): verifica integrata delle proprietà principali.

Nella sessione di consegna non sono stati modificati il tunnel, i servizi
di produzione o i repository remoti. Lo stato implementato nel pacchetto e lo
stato operativo dell'impianto devono rimanere distinguibili fino al collaudo.
