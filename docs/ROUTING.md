# Routing, code e carico dei motori

Questa guida descrive il comportamento della versione 0.4: un coordinator
sceglie e prenota un modello accessibile all'utente, tenendo conto di account,
quote osservate, risorse delle macchine e, quando configurati, contatori di
carico del motore. Web e VS Code usano lo stesso servizio e la stessa
cronologia. Il routing non sposta la conversazione fra archivi diversi.

La disponibilità è una condizione osservata, non una promessa che l'inferenza
riuscirà. I controlli vengono ripetuti dopo la prenotazione e prima dell'uso
della connessione. Le regole sono implementate in
[`routing.ts`](../src/routing.ts), [`scheduler.ts`](../src/scheduler.ts) e
[`inference-load.ts`](../src/inference-load.ts).

## 1. Scegliere un modello e autorizzare le alternative

Ogni route identifica una combinazione di **modello, provider e account**.
Due account dello stesso provider sono quindi scelte distinte, anche quando
espongono lo stesso modello. Usare gli ID restituiti dal catalogo: il nome
pubblico del modello non sostituisce l'ID della route.

| Strategia | Comportamento |
| --- | --- |
| `pinned` | Usa soltanto il modello/account selezionato. Se le sue risorse interne sono occupate, attende entro il limite configurato. Non usa le alternative. |
| `auto` | Considera la route selezionata e le sole alternative autorizzate. Preferisce capacità disponibili, poi disponibilità non ancora verificata, poi risorse occupate. A parità di stato mantiene l'ordine delle scelte. |

`auto` non significa cercare un provider qualsiasi: un modello cloud o un
secondo account deve essere incluso esplicitamente in `fallbackRouteIds`.
Questo elenco autorizza l'invio del contesto a quelle connessioni. Per un
progetto che deve restare sulle macchine locali, includere soltanto route
locali. Le alternative possono essere salvate nel progetto o inviate con il
messaggio. La politica della richiesta prevale e viene conservata nel run.
Per ereditare la politica del progetto, omettere `routing` nel messaggio;
per modificarla, inviare esplicitamente strategia ed elenco desiderati.

Esempio del body di `POST /api/conversations/:id/messages`; gli ID seguenti
sono segnaposto da sostituire con quelli ottenuti da `/api/bootstrap`:

```json
{
  "text": "Spiegami la struttura del progetto",
  "routeId": "mdl_dual_strix_account_a",
  "mode": "chat",
  "routing": {
    "strategy": "auto",
    "fallbackRouteIds": ["mdl_cuda_account_a", "mdl_api_account_b"],
    "maxWaitMs": 8000
  }
}
```

Per salvare la stessa politica, usare il campo `routing` di
`POST /api/projects` o `PATCH /api/projects/:id`. Sono consentite al massimo
32 alternative, con rimozione dei duplicati. La validazione rifiuta gli ID non
accessibili all'utente; il router ricontrolla l'accesso quando deve usarli.
Senza override, il run eredita la politica del progetto; in assenza anche di
questa, usa `auto` senza alternative. Un elenco vuoto lascia come unica
candidata la route selezionata.

La facade `POST /v1/chat/completions` usa invece la route richiesta in modalità
`pinned`, con attesa massima interna di 8 secondi. Non eredita una politica di
fallback da un progetto.

### Controlli prima della scelta

Il router applica questi vincoli a ogni candidata:

- **Accesso:** account proprio o esplicitamente condiviso; la membership del
  progetto non apre gli account privati degli altri utenti.
- **Configurazione:** route e provider abilitati, gruppi di risorse esistenti,
  connessione senza errore di accesso registrato.
- **Quota:** un `cooldownUntil` futuro rende l'account temporaneamente
  ineleggibile. La scadenza consente un nuovo tentativo; non certifica che il
  provider abbia ripristinato la quota.
- **Capacità e contesto:** requisiti espliciti compatibili e finestra sufficiente
  per il controllo preliminare. L'orchestratore compila poi il contesto sul
  modello effettivamente scelto e applica il relativo budget.
- **Runtime nativi:** ruolo operator/admin e workspace locale autorizzato.
  Antigravity è riservato ai task coder; non è un'alternativa per chat o attività
  di sola lettura. I dettagli sono in [ADAPTERS.md](ADAPTERS.md).
- **Carico autorevole:** se esiste un probe configurato, il dato deve essere
  recente e compatibile con l'uso delle risorse. La sezione 5 descrive i casi
  di occupazione esterna e lettura non disponibile.

Un catalogo OpenAI compatibile può restituire soltanto gli ID dei modelli. Una
route con capacità sconosciute può essere provata in chat, mantenendo lo stato
`unknown`; il catalogo non viene arricchito con capacità inventate. Un modello
dichiarato soltanto embedding non è eleggibile per chat. I requisiti espliciti
`embedding` e `tools` restano vincolanti. Nelle missioni HTTP un coder richiede
una route con capacità `tools`. Pianificazione, ricerca e revisione possono
usare route testuali e ricevono il contesto disponibile. Ricevono strumenti in
sola lettura quando la route dichiara `tools`. I runtime nativi usano i propri
strumenti e le autorizzazioni configurate.

Le quote sono osservazioni del provider o del runtime ufficiale. Richieste
residue, percentuali e finestre restano assenti quando non disponibili. Un
429 può registrare `Retry-After`; un limite senza scadenza utilizzabile imposta
un cooldown prudenziale di 60 secondi. Non è una misura della quota residua.
Il budget locale del run è separato dal saldo commerciale dell'account.

In `auto`, un HTTP 429 esplicito alla prima chiamata del task, prima di testo,
tool o effetti precedenti, permette fino a due selezioni alternative HTTP nello
stesso task. L'account che ha restituito il 429 viene escluso dalla selezione e
il contesto viene ricomposto per il modello scelto. La richiesta consuma il
budget di chiamate e i tentativi restano nel registro. I task `pinned` e quelli
con runtime nativo richiedono un intervento esplicito.

## 2. Dual Strix, CUDA e account: prenotazione atomica

I vincoli della route si aggiungono a quelli del provider. Dichiarare meno
risorse su una route non può rimuovere un nodo necessario al suo provider.
Sono inclusi anche i gruppi associati ai nodi dichiarati.

Nella topologia di [strix-cluster.json](../examples/strix-cluster.json):

| Destinazione di inferenza | Gruppi esclusivi da ottenere insieme |
| --- | --- |
| DeepSeek o Qwen distribuito sui due Strix | `strix01-memory` e `strix02-memory` |
| DeepSeek o Qwen su RTX 3090 | `cuda3090-memory` |
| API/GemRouter senza risorse locali dichiarate | Nessun gruppo hardware locale; rimane il limite dell'account |

I gruppi che governano caricamento e commutazione hanno `capacity: 1`.
Una richiesta Dual Strix ottiene entrambi i gruppi insieme oppure resta in
coda senza trattenerne uno. Una richiesta con alternative occupa una sola
posizione di coda e prenota una sola scelta: non acquisisce contemporaneamente
Strix, CUDA e API per decidere dopo.

Ogni route richiede inoltre un semaforo `account:<id>`:

| Connessione | Concorrenza massima per account |
| --- | --- |
| HTTP | `provider.maxConcurrent`, valore da 1 a 16; default 4 |
| Codex / Antigravity | Sempre 1, anche se il provider dichiara un valore maggiore |

Il limite dell'account è condiviso fra i suoi modelli. Due account distinti
possono avere slot propri, ma non superano una risorsa hardware condivisa a
capacità 1. Aumentare `maxConcurrent` non autorizza due commutazioni sulla
stessa GPU. Gli ID interni dei semafori degli account non compaiono nello
snapshot della flotta né negli elenchi hardware di `routeAvailability`.
Restano disponibili i conteggi e una descrizione leggibile della concorrenza
dell'account autorizzato.

La prenotazione viene conservata durante attivazione e inferenza. Per HTTP
viene rilasciata al termine della risposta del modello, anche quando segue
l'esecuzione di tool; il giro di inferenza successivo richiede una nuova
prenotazione. Una sessione nativa mantiene la prenotazione per il proprio
turno. I vincoli del workspace sono distinti dai vincoli del motore.

Se quota, accesso o configurazione cambiano durante la coda, il router li
ricontrolla prima di fornire la connessione. Un cambiamento della topologia
richiede una nuova prenotazione completa: il vecchio insieme di risorse non
viene considerato sufficiente.

## 3. Priorità, attese e cancellazione

| Attività | Priorità | Attesa interna predefinita |
| --- | --- | --- |
| Chat | `interactive` | 8 secondi |
| Task di missione | `normal` | 30 secondi |
| Embedding | `background` | 5 secondi; nella ricerca per chat interviene anche il limite complessivo di 600 ms |

`routing.maxWaitMs` è un intero fra 0 e 120.000 nelle API di prodotto.
`0` significa prenotazione immediata oppure errore, senza attesa in coda.
Il limite riguarda una prenotazione, inclusa l'eventuale riconciliazione del
carico descritta nella sezione 5: non include il tempo successivo di caricamento,
generazione, tool o verifica e non è una promessa sul tempo totale di risposta.
I successivi giri del task possono richiedere nuove prenotazioni. Con
`maxWaitMs: 0`, se occorre una nuova lettura autorevole non c'è tempo per
eseguirla: scegliere un'alternativa già eleggibile o concedere un budget positivo.

La priorità interattiva non interrompe una generazione in corso. Agisce sulla
coda: una richiesta più vecchia viene protetta dopo tre sorpassi di richieste
con altra priorità sulle risorse sovrapposte. La protezione appartiene a quella
richiesta, anche quando un altro gruppo è occupato. Le attività su risorse
indipendenti possono continuare; quelle in background non sono escluse
indefinitamente da un flusso di nuove chat.

Il timeout produce `QUEUE_TIMEOUT`; cancellazione e timeout rimuovono la
richiesta, il timer e i listener. Non rimangono prenotazioni parziali. Il
rilascio è idempotente. La posizione mostrata riguarda le richieste con
risorse sovrapposte e può cambiare con priorità e alternative: non è una stima
del tempo rimanente.

I saluti riconosciuti, come **«come stai?»**, e le richieste riconosciute di
stato del servizio ricevono una risposta del coordinator senza inferenza,
anche senza modelli collegati. Le normali domande esplicative usano il percorso
chat senza pianificatore, squadra o tool. Se la ricerca vettoriale di una chat
non termina entro 600 ms, resta utilizzabile il contesto della ricerca testuale
FTS. Questi comportamenti evitano attese inutili; non rendono immediata una
generazione su un modello già impegnato.

## 4. Quando una scelta può cambiare

Le alternative sono valutate **prima della prima inferenza di ciascun task**.
Una missione può quindi assegnare task diversi a route diverse, entro la
politica autorizzata. Il task registra `requestedRouteId`, `chosenRouteId`,
`switched`, `waitMs` e `reason`; il messaggio conserva la route effettivamente
usata. La cronologia canonica resta nello stesso archivio.

**Dopo un round con tool, il task riacquisisce la stessa route in modalità
`pinned`.** Non cambia provider fra un tool call e la continuazione che ne
consuma il risultato. Questo conserva coerenza dei metadati e del contesto
specifici del provider. Se quella route non è più utilizzabile, il task può
fermarsi anche quando esiste un'alternativa autorizzata per un nuovo task.

Non è implementata una migrazione trasparente a metà stream. Dopo output
parziale o operazioni mutative sul workspace, un errore non provoca la
ripetizione automatica della richiesta su un altro modello: output ed evidenze
sono conservati e il run può passare a `interrupted` con
`INFERENCE_INTERRUPTED`. Prima di riprendere, verificare ciò che è già avvenuto.
Le condizioni incerte delle CLI o del runner remoto mantengono i propri
blocchi. Una nuova scelta di modello non equivale ad annullare gli effetti
precedenti.

## 5. Rilevare il carico esterno con un probe esplicito

I lease del coordinator vedono le richieste passate dal coordinator. Un
client diretto dell'engine, una vecchia UI o un altro servizio possono invece
occupare il motore senza creare un lease locale. Per osservare questo caso,
l'operatore può aggiungere `loadProbe` a un provider nel file di configurazione.
La UI e i messaggi di chat non possono configurare un URL di probe.

Il probe esegue un GET in sola lettura verso l'URL esatto: nessuna scansione
della LAN e nessuna deduzione di capacità dalla percentuale GPU. Parte una
lettura all'avvio; il monitor tenta aggiornamenti ogni 2 secondi, con al massimo
quattro letture contemporanee, comprese quelle richieste per la riconciliazione.
Per ciascun provider c'è una sola lettura in volo. I cicli sovrapposti vengono
accorpati. Su molti
endpoint lenti, il tempo fra due campioni può superare 2 secondi: la freschezza
viene comunque verificata al momento della scelta.

### Probe JSON di un controller persistente

Il seguente oggetto è un **frammento da inserire in un provider**. L'indirizzo
è illustrativo: non afferma che questo endpoint esista sul cluster.

```json
{
  "loadProbe": {
    "kind": "json",
    "url": "http://127.0.0.1:8099/load/strix",
    "capacity": 1,
    "timeoutMs": 1500,
    "maxAgeMs": 6000
  }
}
```

Contratto della risposta JSON:

```json
{
  "activeRequests": 0,
  "queuedRequests": 0,
  "capacity": 1
}
```

`activeRequests` è obbligatorio; gli altri due campi sono opzionali. I valori
devono essere interi non negativi; i contatori sono limitati a 1.000.000 e la
capacità riportata a 1.024. Lo zero osservato viene mantenuto. Campo assente,
errore HTTP, timeout o schema non valido non diventano zero.

Una risposta `activeRequests: 1` su una risorsa esclusiva impedisce di usarla
o commutarla, anche se il motore dichiara più slot. Su risorse non esclusive,
`activeRequests >= capacity` oppure `queuedRequests > 0` determina occupazione.
Attività positiva senza capacità nota resta `unknown`; l'assenza di attività
con capacità non dichiarata può risultare disponibile. Una capacità riportata
pari a zero non offre slot. La capacità operatore può restringere quella
riportata, mai aumentarla.

### Probe `llama-slots`

Per un server che espone realmente il contratto `/slots` di llama.cpp:

```json
{
  "loadProbe": {
    "kind": "llama-slots",
    "url": "http://127.0.0.1:8080/slots",
    "timeoutMs": 1500,
    "maxAgeMs": 6000
  }
}
```

Esempio minimo di risposta accettata:

```json
[
  { "id": 0, "is_processing": false },
  { "id": 1, "is_processing": true }
]
```

Il monitor conta gli `is_processing: true` e ricava la capacità dal numero
di slot. `is_processing` deve essere booleano; eventuali ID devono essere
numerici e distinti. Parametri di generazione, prompt e altri dati degli slot
non sono conservati né trasmessi al frontend. Il contratto di riferimento è
la [documentazione ufficiale del server llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
Compatibilità OpenAI o disponibilità di `/v1/models` non implicano disponibilità
di `/slots`; va verificato sull'engine installato.

### Vincoli di configurazione e freschezza

| Parametro | Default | Intervallo / comportamento |
| --- | --- | --- |
| `timeoutMs` | 1500 | Da 50 a 10.000 ms |
| `maxAgeMs` | 6000 | Da 100 a 60.000 ms; scaduto il campione, stato `stale` |
| `capacity` operatore | Assente | Da 1 a 1024, limite conservativo opzionale |
| URL | Obbligatorio | HTTP/HTTPS, senza credenziali incorporate, query o fragment |
| Corpo della risposta | — | Massimo 512 KiB |

I probe non inviano chiavi di inferenza, cookie o header di autenticazione
personalizzati. Un endpoint che richiede autenticazione e risponde 401 non è
compatibile con il probe anonimo configurato: viene mostrato come non
verificabile. Usare un endpoint di sola lettura predisposto dall'operatore
nel perimetro di rete appropriato; il monitor non modifica l'autenticazione
dell'engine. I redirect non vengono seguiti.

**Un probe configurato è un requisito autorevole.** Se manca un campione,
fallisce una lettura o il dato è scaduto, la route diventa `unavailable` con
`LOAD_UNAVAILABLE`. Se il probe segnala occupazione, diventa `busy` con
`EXTERNAL_BUSY`. Quando non rimane un'alternativa eleggibile, entrambi i casi
terminano rapidamente: il router non aspetta una coda esterna che non governa.
La modalità `pinned` non aspetta indefinitamente che il probe torni libero.

Il vincolo si estende agli altri provider che condividono quei gruppi hardware.
Per esempio, un DeepSeek attivo sui due Strix impedisce la commutazione verso
Qwen sugli stessi gruppi. Anche un probe autorevole scaduto su quelle risorse
impedisce una commutazione non verificabile. Il carico viene ricontrollato dopo
il grant del lease locale.

### Riconciliazione dopo un nostro turno

I contatori del probe comprendono tutte le richieste del motore, anche quelle
di questo coordinator: non identificano il proprietario di ciascuna richiesta.
Un campione occupato raccolto durante una nostra generazione non dimostra che
esista ancora una richiesta esterna dopo il suo completamento.

Per questo, al rilascio il monitor segna una barriera per i probe del provider
e delle risorse condivise. Prima della successiva ammissione richiede un
campione **iniziato dopo il rilascio**. Un vecchio GET che termina più tardi
non supera la barriera: viene attesa la sua conclusione e viene effettuata una
nuova lettura. L'ordine usa contatori interni, senza affidarsi alla precisione
in millisecondi dell'orologio. Una lettura periodica già iniziata dopo il
rilascio può soddisfare il requisito senza un GET duplicato.

Il round successivo pinned riparte quando la nuova lettura conferma capacità
disponibile. Se il motore segnala ancora attività incompatibile, resta
`EXTERNAL_BUSY`; dati non verificabili o esaurimento del budget di riconciliazione
restano `LOAD_UNAVAILABLE`. Timeout e cancellazione non lasciano lease trattenuti.
Non viene sottratto alcun utilizzo presunto dai contatori e non viene ripetuta
l'inferenza. In modalità auto, un'alternativa autorizzata già eleggibile può
essere scelta subito senza attendere il probe dell'altra route. Senza probe
configurati, il rilascio non introduce richieste HTTP di carico.

**Per engine che vengono spenti durante lo switch, preferire un controller
persistente che esponga l'occupazione dell'intero gruppo.** Un probe puntato
alla porta del modello spento non può attestare risorse libere e può quindi
bloccare l'attivazione. Gli esempi del repository non abilitano probe su porte
che non sono state verificate nell'impianto.

Rimane una finestra fra lettura e uso: un client esterno potrebbe iniziare
subito dopo il campione. Il probe osserva, ma non crea un lock condiviso con
quel client. Per la produzione serve un unico punto di ammissione e di
commutazione, oppure un controller che faccia rispettare la stessa esclusione
anche agli altri ingressi. Non avviare più coordinator indipendenti sugli
stessi engine aspettandosi lease distribuiti: questi lease appartengono al
singolo processo coordinator.

## 6. Leggere gli stati nella UI e negli eventi

`GET /api/bootstrap` fornisce `routeAvailability` e `providerLoads` filtrati
per l'utente. L'evento SSE **`routing.updated` ogni 2 secondi** aggiorna
`resourceUsage`, `routeAvailability` e `providerLoads` anche quando non cambia
la telemetria hardware. È uno snapshot effimero con `id: 0`, non una nuova
voce durevole della cronologia. Non azzerare il cursore degli eventi durevoli;
dopo una riconnessione rileggere il bootstrap. L'heartbeat non certifica un
nuovo campione di ogni probe: controllare anche i timestamp dell'osservazione.
Il visitatore del dashboard pubblico riceve soltanto `resourceUsage` in questo
evento, senza disponibilità degli account o contatori privati dei provider.

| `routeAvailability.status` | Significato operativo | Azione utile |
| --- | --- | --- |
| `available` | Nessun vincolo noto impedisce la prenotazione; account già verificato. Non è una prova che il modello sia caricato ora. | Inviare; readiness e inferenza restano controlli successivi. |
| `busy` | Gruppo/account pieno, richieste interne precedenti, oppure carico autorevole del motore. | Leggere `source` e `reason`: coda interna limitata oppure alternativa autorizzata per occupazione esterna. |
| `cooldown` | Ripristino quota atteso fino a `cooldownUntil`. | Attendere o autorizzare un altro account/modello. |
| `disabled` | Route o provider disabilitati. | Abilitare intenzionalmente la connessione o scegliere altro. |
| `unavailable` | Requisito non soddisfatto: accesso registrato in errore, risorsa mancante, capacità/contesto incompatibili o probe autorevole non verificabile. | Risolvere la causa indicata o usare un'alternativa eleggibile. |
| `unknown` | Accesso o capacità del modello non ancora verificati, senza un vincolo noto che impedisca il tentativo. | La chat può tentare quella route; non presentarla come verificata. |

**`unknown` della route e `unknown` del probe hanno effetti diversi.** Un
modello appena scoperto può essere provato in chat; un probe autorevole
configurato ma sconosciuto rende la route `unavailable`. `stale` appartiene
alle osservazioni `providerLoads`, non all'elenco di stati della route.

`source` distingue `coordinator`, `provider` e `configuration`. I campi
`externalActiveRequests` / `externalQueuedRequests` riportano contatori esterni
solo se osservati. `activeCount` è il massimo utilizzo interno dei gruppi
necessari alla route, incluso l'account; non è una somma di GPU né un conteggio
esatto delle richieste di quel solo modello. `queueCount` conta richieste
interne sovrapposte, anche quando hanno alternative. `oldestWaitMs` è tempo
già trascorso, non una previsione.

Gli eventi `route.queued` espongono posizione, attesa trascorsa, candidate e
risorse occupate del task. `route.selected` e `task.routing` spiegano quale
modello/account sia stato scelto e perché. Nei messaggi accettati con HTTP 202,
un successivo `QUEUE_TIMEOUT`, `EXTERNAL_BUSY`, `LOAD_UNAVAILABLE` o `QUOTA`
compare nello stato e negli eventi del run: il 202 iniziale non certifica
l'avvio dell'inferenza. Nella chiamata diretta, gli stessi errori possono
arrivare rispettivamente come HTTP 503 o, per quota, 429.

## 7. Collaudo su Dual Strix, RTX 3090 e API

Eseguire il collaudo con workspace e prompt di prova, usando gli ID reali
restituiti dal catalogo. Verificare prima la corrispondenza fra gruppi,
indirizzi, modello atteso e controller di attivazione. Gli indirizzi presenti
nell'esempio sono configurazione da convalidare, non discovery dell'impianto.
Usare una connessione API già autorizzata a ricevere il contesto di prova.

| Prova | Procedura | Esito da osservare |
| --- | --- | --- |
| Risposta di servizio | Senza modelli collegati, inviare «come stai?» in modalità auto. Ripetere mentre una missione è attiva. | Risposta terminale del servizio, zero chiamate modello; la missione non viene messa in pausa o cancellata. |
| Dual Strix atomico | Avviare una generazione che occupi entrambi gli Strix. In un'altra conversazione richiedere un secondo modello Dual Strix con `pinned` e attesa breve. | Entrambi i gruppi risultano occupati; la seconda richiesta non avvia lo switch e termina al limite senza lease residui. |
| Alternativa CUDA | Mantenere gli Strix occupati. Inviare una chat `auto` con CUDA come unica alternativa e CUDA libera. | Risposta via CUDA; `chosenRouteId` e route del messaggio corrispondono; storia precedente presente nel contesto. |
| Alternativa API | Occupare Strix e CUDA. Ripetere autorizzando anche una route API libera. Ripetere poi senza autorizzarla. | Prima prova via API; seconda in coda/errore entro il budget, senza chiamata al provider escluso. |
| Account condiviso fra modelli | Impostare `maxConcurrent: 1` su un provider HTTP di prova e usare due suoi modelli con lo stesso account. | Una sola inferenza alla volta. Un secondo account non aggira gruppi hardware esclusivi. |
| Traffico esterno | Con probe verificato, inviare direttamente al motore una richiesta lunga; chiedere poi un'altra route sulle stesse risorse. | Dopo il campione, stato `busy` con `source: provider`; nessuno switch. Auto può usare una candidata su risorse indipendenti. |
| Probe non verificabile | In ambiente di prova, interrompere l'accesso al probe o restituire uno schema errato. Per `stale`, sospendere i campioni oltre `maxAgeMs`. | `providerLoads` mostra `unknown`/`stale`; route `unavailable`, errore `LOAD_UNAVAILABLE`, nessuna commutazione. |
| Ritorno al libero | Ripristinare un campione valido con zero richieste e capacità positiva. | I timestamp avanzano; il vincolo esterno scompare. Eventuali lease interni continuano comunque a bloccare. |
| Cancellazione e priorità | Accodare embedding e chat su una risorsa occupata, poi liberarla; annullare una richiesta ancora in coda. | Le chat ottengono priorità limitata, la richiesta più vecchia viene protetta, quella annullata non parte e non trattiene slot. |
| Round successivo dopo un nostro turno | Far campionare il probe mentre una nostra inferenza è attiva. Terminare l'inferenza e avviare subito un secondo round pinned, prima del poll periodico. Ripetere mantenendo attivo anche un client esterno. | Nel primo caso parte una nuova lettura e il round procede sullo stesso modello; nel secondo resta `EXTERNAL_BUSY`. Nessuna sottrazione presunta dai contatori. |
| Errore dopo effetti | In un workspace sacrificabile, far eseguire un append una sola volta e interrompere la successiva inferenza. Provare anche una risposta interrotta dopo testo parziale. | Output/evidenze conservati; nessun append ripetuto, nessun fallback a metà stream, richiesta di controllo prima della ripresa. |

Controllare gli eventi di routing insieme ai contatori effettivi del controller
e ai log di attivazione. Per l'esclusione esterna, una UI che mostra `busy`
non basta: verificare che nessun comando di stop/switch sia stato eseguito.
Prima di rimuovere i vecchi ingressi, censire i client che possono accedere
direttamente agli engine e farli passare dallo stesso punto di ammissione.

La suite riproducibile è:

```sh
node --test tests/routing.test.ts tests/inference-load.test.ts tests/interaction.test.ts
```

Comprende 40 casi su atomicità, code, fairness, ACL, quote, carico esterno,
riconciliazione dopo rilascio, chat rapida, cronologia, FTS e interruzioni dopo
output/effetti. Usa server HTTP
reali su loopback, SQLite e filesystem di prova. Non sostituisce il collaudo
con GPU, account reali, CLI installate e rete dell'impianto. Il gate completo
del repository resta `npm run check`.

## Riferimenti di implementazione

- [Politica delle richieste](../src/request-policy.ts) e [tipi di routing](../src/routing-types.ts).
- [Scelta e ricontrollo delle route](../src/routing.ts), [scheduler atomico](../src/scheduler.ts).
- [Schema dei probe](../src/load-types.ts), [lettura e freschezza](../src/inference-load.ts).
- [Integrazione dei task](../src/orchestrator.ts), [API ed eventi](../src/server.ts).
- [Test routing](../tests/routing.test.ts), [test carico](../tests/inference-load.test.ts), [test interazione](../tests/interaction.test.ts).
- [Connessioni](CONNECTIONS.md), [adapter e runtime](ADAPTERS.md), [confine di esecuzione](EXECUTION.md).
