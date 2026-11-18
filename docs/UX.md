# UX 0.4 — un solo yed1z per dashboard, chat e squadra

## Obiettivo e provenienza

La 0.4 parte dall'archivio installato fornito il 17 novembre 2026, conservando la
modalità ospite e le variazioni applicative dell'utente. Il riferimento visivo è
la dashboard `StrixHaloCluGateway-main_2.zip`, il cui frontend usa un HUD tecnico
con geometria squadrata, reticolo, intestazioni compatte e palette cyan, viola e
verde su fondo blu quasi nero.

Il tema condiviso riprende questi elementi in tutte le viste. Le risposte lunghe
mantengono una tipografia sans leggibile, mentre misure, etichette tecniche,
stati e intestazioni usano il monospace locale. Nessun font o asset richiede
servizi esterni. Il modulo web è lo stesso incluso nel VSIX.

## Struttura del prodotto

- **Chat e squadra:** conversazione centrale, composer, stato del sistema e
  pannello degli agenti con grafo delle dipendenze effettive.
- **Dashboard cluster:** nodi, GPU/CPU/memoria, misure di rete, gruppi di risorse,
  disponibilità delle route e fonti delle osservazioni.
- **Conoscenza:** memorie e documenti, revisioni, fonti e ricerca.
- **Modelli e account:** connessioni, quote osservate, discovery e capacità.
- **Consegne e rilasci:** risultati, evidenze, ricette e autorizzazioni.

La panoramica hardware rimane visibile nella chat. Il pulsante **Collega modello**
è disponibile nella testata: non serve aprire una pagina amministrativa prima di
iniziare. Nella vista ospite la dashboard viene realmente resa visibile; il login
riporta l'utente nel proprio spazio. La UI non costruisce dati privati assenti dal
bootstrap pubblico.

L'ospite può annullare l'accesso e tornare al monitor con il flusso live
ripristinato. Una sessione privata scaduta richiede invece una nuova
autenticazione. Nel layout stretto la navigazione chiusa è `inert`, viene esclusa
dal percorso di tastiera e restituisce il focus al menu quando si chiude.

## Un flusso breve per collegare i modelli

`web/connections.ts` contiene il percorso di collegamento. I preset sono Codex,
Antigravity, OpenAI API, Gemini API, Ollama, LM Studio, GemRouter e un endpoint
compatibile OpenAI. Le connessioni esistenti sono raccolte in una sezione
separata, per aggiungere un account senza ricreare il provider.

Per OpenAI e Gemini l'indirizzo standard è già impostato: il campo richiesto
all'utente è la chiave, quando necessaria. Per Codex e Antigravity non vengono
chiesti URL o API key. Per i provider locali e gli endpoint personalizzati
l'indirizzo resta visibile, con la specifica che deve essere raggiungibile dal
coordinator.

Il nome account è facoltativo. L'azione "Aggiungi account" a un provider esistente
precompila un nuovo nome distinto. Nome della connessione, condivisione,
associazione ai nodi, gruppi di risorse e ID manuali dei modelli rimangono nelle
opzioni avanzate.

Il comando **Rileva servizi locali e configurati** usa la discovery del server:
controlla i candidati autorizzati dal servizio, mostra indirizzo e risultato e
permette di selezionarne uno. Non promette una scansione dell'intera LAN, né che
"localhost" corrisponda al computer che visualizza il browser.

Una richiesta `POST /api/connections` gestisce il collegamento. Il wizard conserva
un `requestId` per tentativo e usa l'account restituito per i retry. Se cambia
l'endpoint, la UI apre un nuovo tentativo invece di ripuntare silenziosamente un
account già creato. La chiave viene rimossa dal campo dopo l'invio; in VS Code la
richiesta passa dal prompt protetto dell'extension host.

I risultati hanno esiti distinti:

- **Pronto / standby:** elenco dei modelli realmente rilevati o registrati come
  standby, con scelta esplicita del modello da usare.
- **Accesso necessario:** Codex avvia il flusso ufficiale; alla conferma il server
  completa la discovery e la UI presenta i modelli di quell'account.
- **Configurazione necessaria:** istruzioni della CLI e collegamento ufficiale,
  con azione di verifica successiva.
- **Non disponibile:** messaggio operativo e retry sullo stesso account.
- **Modelli dichiarati:** ID manuali chiaramente indicati come non verificati.

Antigravity resta assegnabile al ruolo sviluppatore. La scelta "Usa per
sviluppatore" configura quel ruolo nel progetto tramite l'API autorizzata; non
lo imposta come orchestratore o revisore. Un progetto attivo o non modificabile
continua a ricevere i controlli del server.

## Domande, lavoro e risposte immediate

La modalità iniziale per un operatore è **Auto**. Il classificatore condiviso
`src/intent.ts` decide il percorso anche sul server:

- una normale domanda riceve una risposta in chat;
- una richiesta esplicita di modifica o esecuzione può aprire una missione;
- saluti, aiuto e richieste esatte di stato possono ricevere una risposta del
  servizio senza invocare un modello.

La UI etichetta queste ultime **Servizio yed1z · Nessuna inferenza**. Il percorso
è disponibile anche senza un modello configurato e non sospende una missione
aperta. Le altre istruzioni rivolte a una missione in corso continuano a usare
il controllo della missione, con lo stato di pausa/ripresa visibile.

Il composer mostra prima dell'invio il percorso atteso: risposta del servizio,
chat diretta, squadra o istruzione alla missione. La scelta esplicita Chat o
Squadra rimane disponibile. Gli utenti senza ruolo operativo continuano a usare
la modalità chat consentita dal server.

## Occupazione e instradamento comprensibili

Il selettore modelli mostra le osservazioni `routeAvailability`: slot libero,
occupato, quota in attesa, disabilitato, non disponibile o da verificare. Mostra
anche il motivo e il numero di richieste in coda, quando restituiti dal server.
Bootstrap, telemetria e heartbeat `routing.updated` aggiornano il selettore già
aperto, preservando ricerca, scorrimento e focus. L'heartbeat aggiorna soltanto
disponibilità e conteggi: non ricostruisce i form e non entra nella timeline degli
agenti. Le richieste osservate sul motore sono mostrate separatamente da quelle
del coordinator; non vengono sommate perché possono sovrapporsi.

**Slot libero non significa endpoint certamente sano.** La disponibilità deriva
dalle prenotazioni del coordinator o dai probe del provider, secondo la fonte
indicata. La UI non deduce l'occupazione dell'engine dalla percentuale GPU e non
inventa tempi di fine attesa.

La sezione **Se il modello è occupato** permette di scegliere:

1. attesa del modello fissato;
2. uso di un'alternativa autorizzata disponibile.

Le alternative richiedono una selezione esplicita. Non esiste una selezione
implicita di tutti i provider cloud. Le scelte fatte nel picker valgono per le
richieste successive della finestra; le impostazioni del progetto permettono di
salvare il comportamento condiviso. Il dettaglio del task riporta route scelta,
motivo della selezione e attesa misurata.

## Movimento legato agli eventi

`web/activity.ts` rende il medesimo flusso nella chat e nella dashboard:
**Knowledge → orchestratore → inferenza → agenti → evidenze**.

Il componente usa fonti incluse nei report di contesto, memorie e documenti del
progetto, task realmente presenti, route e risultati registrati. Le dipendenze
fra agenti rimangono nel grafo SVG dei task. Il flusso generale rappresenta le
relazioni del prodotto, non una seconda pianificazione inventata.

Le linee di attività si animano durante le fasi osservate. I delta di risposta e
di task producono impulsi sul nodo corrispondente; eventi di contesto, strumenti
ed evidenze illuminano il relativo passaggio. Una richiesta in coda viene
mostrata come attesa, senza simulare generazione di token. Un risultato del
servizio indica che non c'è stata inferenza.

Il pulsante **FX ON/OFF** e `prefers-reduced-motion` disattivano le animazioni. Non
ci sono contatori FPS, percentuali di avanzamento artificiali o tempi di risposta
inventati. Gli elementi del flusso sono pulsanti raggiungibili da tastiera e
aprono la vista pertinente.

## Prestazioni e layout

I delta vengono applicati al modello client subito, mentre il rendering è
raggruppato per frame. Questo evita una ricostruzione completa del DOM per ogni
frammento di token. Gli offset evitano il raddoppio del testo quando bootstrap e
SSE contengono parti già ricevute.

Una conversazione lunga mostra inizialmente gli ultimi 80 messaggi; il comando
"Mostra precedenti" carica gli altri a blocchi. La cronologia canonica e il
contesto lato server restano integri. Il rendering progressivo riguarda soltanto
la presentazione.

Su schermi ampi rimangono visibili navigazione, chat e squadra. Sotto 1020 px il
pannello squadra si apre su richiesta; sotto 720 px la navigazione diventa un
pannello e il flusso nella chat si riduce ai tre passaggi centrali. La dashboard
conserva l'intero flusso in una griglia compatta. Il composer, i pulsanti e le
finestre di collegamento si adattano anche alla larghezza del webview VS Code.

## Verifica e limiti osservati

La suite DOM copre i flussi originali e le regressioni introdotte dalla 0.4:
collegamento atomico, richiesta di segreti al bridge, saluti durante una missione,
assenza di modello, occupazione e alternative esplicite, etichetta delle risposte
del servizio, stato del flusso, animazioni disattivabili, cronologia progressiva e
atterraggio ospite. La suite HTTP attraversa il server reale, cookie, SSE,
SQLite e un upstream HTTP locale per il collegamento GemRouter.

Ultimo collaudo del frontend: **36 casi DOM e 2 casi HTTP/SSE superati**, con
controllo TypeScript strict dei moduli web riuscito. Questi risultati verificano
interazione e integrazione, non la resa grafica del browser o un login sui
provider dell'installazione.

Il browser è stato tentato con Playwright e l'eseguibile installato
`/usr/bin/chromium`. Il processo ha terminato con:

```text
FATAL:chrome/browser/process_singleton_posix.cc
socket() failed: Operation not permitted
```

È stato tentato anche il browser cloud: l'apertura della preview locale
`file://` è stata negata dalla policy, che non consente di aggirare il blocco.
Non sono stati prodotti screenshot e non è dichiarata una revisione visiva
completata. Non va confuso il collaudo DOM con un collaudo di rendering reale.
I risultati finali dell'intero monorepo sono nel rapporto di verifica della
release. Nel collaudo dell'installazione vanno ancora controllati:

- viewport desktop 1600×1000 e 1280×800, browser mobile e webview VS Code;
- navigazione da tastiera, zoom 200%, riduzione del movimento e focus dei dialog;
- connessione a un account Codex reale, profilo Antigravity e API del cluster;
- flusso visuale con due richieste concorrenti e un modello realmente occupato;
- continuità della conversazione quando cambia il provider;
- assenza di richieste esterne per font o risorse decorative.
