# Manuale d’uso di yed1z Control Room

Versione di riferimento **1.0.0-rc.1**. Per verificare un lavoro parti dal progetto. Per controllare se una macchina è accesa, quanto sta consumando o quale motore è pronto, parti dalla dashboard hardware.

| Voglio… | Dove andare |
|---|---|
| Vedere l’hardware e cambiare motore | [Dashboard storica](#hud) · [Fleet e cluster](#infrastruttura) |
| Collegare un modello e usarlo nel progetto | [Progetti](#progetto) · [Wizard](#connessioni) · [Selettore e routing](#routing) |
| Aggiungere altre identità o dividere le quote | [Codex](#login-codex) · [Antigravity](#login-antigravity) · [Account, deleghe e quote](#account) |
| Conversare, allegare file o provare un’alternativa | [Chat](#chat) · [Rami](#rami) · [Conoscenza](#conoscenza) |
| Affidare una modifica alla squadra | [Autonomia](#autonomia) · [Task e approvazioni](#squadra) · [Percorso visivo](#percorso) |
| Controllare risultato, consumo e rilascio | [Consegne](#consegne) · [Ripresa](#ripresa) · [Consumi](#consumi) |
| Lavorare dall’editor, da un client o con un altro utente | [VS Code](#vscode) · [API](#api) · [Ruoli e accessi](#accesso) |
| Capire perché un’azione è bloccata | [Diagnosi](#diagnosi) |

<a id="ingressi"></a>
## Gli ingressi al servizio

| Indirizzo sul coordinator | Cosa trovi | Come proseguire |
|---|---|---|
| `/` | Dashboard hardware storica, con gli chassis Strix, i quadranti e il pannello di commutazione | **Control Room** apre i progetti su `/control`. |
| `/control` | Conversazioni, squadra, conoscenza, connessioni, consumi e rilasci | Nella navigazione scegli **Dashboard cluster** per passare all’infrastruttura. |
| `/cockpit` | Fleet monitor compatto di nodi, link e motori | **Attiva** o **Arresta** agisce sui motori configurati per quell’operazione. |
| `/cockpit/classic` | Accesso diretto alla stessa dashboard storica presente alla radice | Utile per i segnalibri già salvati e i monitor dedicati. |

<a id="hud"></a>
## Dashboard hardware storica

### Leggere il monitor

Nell’HUD, **Master arbitration** riporta i motori rilevati pronti. La sezione del percorso client–gateway–cluster mostra le richieste in volo e l’ultima misura di velocità o di tempo al primo token. L’animazione centrale reagisce all’attività. Per conoscere il carico usa le misure numeriche e il relativo nodo. L’immagine dell’hardware e le etichette USB4 descrivono la topologia.

L’ispettore consente di alternare la foto del **cluster** e lo schema del **die**. I punti evidenziati identificano i due nodi e il collegamento nella prima vista e i blocchi del chip nella seconda. Sotto ciascun nodo trovi i sensori esposti dalla macchina, fra cui temperatura, utilizzo GPU, potenza, RAM, VRAM e disco. Il monitor interroga la telemetria ogni due secondi. I campioni a zero sono misure valide. Un trattino indica che manca il valore, inclusi i campi per cui il sensore non fornisce alcun dato.

### Cambiare motore

Nel pannello di controllo scegli la famiglia sul gruppo Strix o sul gruppo CUDA. Con i controlli bloccati, **Unlock** apre l’accesso operatore. Inserisci la chiave personale del gateway e controlla il motore richiesto prima di procedere. Il coordinator verifica i permessi e la disponibilità delle risorse, poi esegue la ricetta installata. Attendi la conferma e ricontrolla i motori attivi. L’avvio di un motore può sostituire quello già caricato sullo stesso hardware. Nel Fleet monitor è presente anche **Arresta** quando la ricetta lo supporta.

### Analitiche e aspetto dell’HUD

Il grafico giornaliero riassume i token misurati negli ultimi 30 giorni dalla facciata API. Le righe delle richieste riportano modello, token di input e output, durata e velocità quando disponibili. La tabella delle sessioni presenta fino a 15 richieste recenti della propria identità autenticata. L’aggregato pubblico riguarda la facciata API. Per sommare il lavoro degli agenti di un progetto apri **Consumi**.

Il controllo lingua alterna italiano e inglese nell’HUD storico. Puoi impostare il tema chiaro, scuro o di sistema e attivare gli effetti CRT. In Control Room apri **Aspetto** per impostare tema e movimento anche nell’editor. Per l’utente autenticato le preferenze di aspetto si ritrovano sul coordinator. Con movimento ridotto richiesto dal sistema gli effetti restano disattivati. L’interfaccia del progetto e il wizard sono in italiano.

<a id="accesso"></a>
## Accesso, utenti e ruoli

Apri **Accedi** e inserisci la chiave personale di yed1z. Sul Web il server crea una sessione con cookie. **Esci** chiude la sessione Web. La chiave personale identifica l’utente presso il gateway. Le chiavi dei provider e i consensi Codex o Google si configurano successivamente nella scheda dell’account di inferenza.

| Identità | Operazioni disponibili |
|---|---|
| Ospite | Consulta le informazioni esposte dal monitor pubblico, se abilitato. Per progetti e dati personali effettua l’accesso. |
| Osservatore | Legge le risorse autorizzate e può salvare le proprie preferenze di aspetto. La ricerca Knowledge tramite API è lessicale. |
| Membro | Può creare progetti e conversazioni, usare modelli HTTP accessibili e gestire i propri documenti o memorie. L’esecuzione di missioni e CLI native richiede un operatore. |
| Operatore | Può inoltre configurare l’esecuzione autorizzata, usare i profili nativi consentiti, controllare i motori e avviare missioni. |
| Amministratore | Può gestire utenti, consultare e amministrare i progetti secondo le regole del coordinator. Le conversazioni, le run e i consumi personali mantengono la propria identità. |

In **Modelli e account → Gestisci utenti**, l’amministratore consulta nomi, ruoli e ID. Per aggiungere una persona sceglie nome e ruolo e consegna al titolare la chiave restituita alla creazione. L’ID utente serve per la membership del progetto. La delega di un account di inferenza si gestisce separatamente dal pannello **Accesso** di quell’account.

<a id="progetto"></a>
## Creare e configurare un progetto

1. Apri il pulsante **+** accanto ai progetti. Inserisci un nome. Puoi scegliere subito l’orchestratore primario oppure rimandare al primo messaggio.
2. Nelle impostazioni assegna, se disponibili, i modelli **Sviluppatore**, **Revisore**, **Ricercatore** ed **Embedding memoria**. Le scelte includono l’account. Il modello embedding serve all’indice e alla ricerca.
3. In **Workspace, verifiche e destinazione** scrivi obiettivo e convenzioni. Per una missione l’operatore sceglie un target e un workspace relativo alla radice autorizzata. Seleziona i comandi di verifica disponibili e, per distribuire il risultato, una ricetta di rilascio.
4. Per Git sul target locale puoi scegliere un **checkout separato per missione**. Il progetto può anche lavorare nel workspace condiviso. Valuta quest’ultima scelta se altri processi hanno accesso agli stessi file.
5. Configura le alternative di routing e, quando il ruolo lo consente, i membri del progetto. Salva. Dal selettore laterale puoi passare a un altro progetto. **Progetto** riapre le impostazioni per il responsabile autorizzato.

La macchina che genera testo, quella che ospita il workspace e il target finale del rilascio possono avere funzioni diverse. Un modello che risponde in chat può quindi essere utilizzabile prima che il progetto sia configurato per eseguire test o scrivere file. Se il salvataggio segnala attività aperte, concludi o annulla la missione prima di modificare le impostazioni del progetto.

<a id="connessioni"></a>
## Collegare un modello con il wizard

Apri **Collega modello** nella barra principale oppure **Modelli e account → Collega un account**. Scegli il preset, completa l’accesso e seleziona una delle rotte restituite. Una rotta identifica modello, provider e account. Due account con lo stesso catalogo danno luogo a scelte distinte.

| Preset | Cosa inserire o verificare |
|---|---|
| Codex ufficiale | Profilo CLI sul coordinator, abilitato a usare il runtime ufficiale. Completa il [device login](#login-codex). |
| Antigravity ufficiale | Profilo CLI sul coordinator, consenso Google e risposta al login in corso. Vedi [accesso Antigravity](#login-antigravity). |
| OpenAI API, Gemini API | Verifica l’endpoint proposto e inserisci la chiave del servizio. Sono connessioni API indipendenti dai profili CLI. |
| Ollama, LM Studio | Indica la base raggiungibile dal coordinator. Il rilevamento cerca i servizi locali previsti e gli endpoint già configurati. Per un altro host inserisci il suo indirizzo o quello del bridge. |
| GemRouter | Indica la base OpenAI-compatible dell’istanza e la chiave del profilo. La configurazione collaudata usa il percorso `/v1`. |
| Altro endpoint | Indica l’URL del servizio compatibile e la credenziale richiesta. Un motore privo di catalogo può usare ID modello dichiarati esplicitamente dall’operatore. |

Nelle opzioni avanzate puoi distinguere il nome della connessione e l’etichetta dell’account, associare nodi e gruppi di risorse o specificare ID modello. La ricerca rapida verifica la raggiungibilità del catalogo. Per provare anche la generazione usa un turno di chat con la rotta selezionata oppure il comando di prova del gateway. Se il servizio risponde 401/403, riapri **Verifica account** e correggi la credenziale del profilo esistente. Il progetto e la sessione yed1z rimangono utilizzabili.

**Stati del collegamento.** Un catalogo verificato rende disponibili i modelli rilevati. Un motore in standby richiede l’attivazione prevista. Una CLI può segnalare accesso richiesto oppure installazione/configurazione incompleta. Un ID dichiarato manualmente resta da verificare. Se la discovery conferma che un modello è scomparso, la sua vecchia rotta rimane nella cronologia. Le capacità includono solo quelle riportate dal servizio o dichiarate dall’operatore. [Contratto delle connessioni e stati](CONNECTIONS.md)

<a id="login-codex"></a>
### Login Codex

In **Modelli e account** apri la scheda del tuo profilo Codex e scegli **Accedi a Codex**. Usa il sito ufficiale e il codice temporaneo mostrati nella finestra. Quando il titolare completa il device login, il coordinator interroga il runtime. Controlla il catalogo, le eventuali finestre di quota e il nome del profilo prima di usarlo nel progetto. Per un secondo account scegli **Aggiungi account**, assegna un’etichetta distinta e ripeti il consenso. Un profilo nativo usa un solo turno per volta.

Per una missione Codex serve un workspace sul target locale autorizzato. I tool di lettura, elenco e ricerca esposti dal gateway operano nel checkout assegnato. La lettura verificata nel collaudo è registrata nelle evidenze con percorso e hash del contenuto. Un client Codex configurato per usare un modello locale tramite la facciata Responses segue un percorso diverso, descritto nella [sezione API](#api).

<a id="login-antigravity"></a>
### Login Antigravity

Scegli **Accedi ad Antigravity** dalla scheda del profilo oppure l’azione di login proposta dal wizard. Completa il consenso all’indirizzo Google ufficiale. Quando viene richiesto, riporta il codice o la pagina di ritorno nella finestra del login attivo. La risposta va nel campo dedicato all’operazione. Al termine il coordinator verifica la sessione e richiede i modelli al runtime ACP. Se il consenso scade, annulla quel login e avviane uno nuovo per lo stesso profilo.

I nuovi profili hanno directory distinte. Un profilo storico può apparire come profilo del servizio. Il semplice avvio della pagina Google dimostra la raggiungibilità del flusso di accesso. Per attestare che quello specifico account può servire inferenza occorrono completamento del consenso, discovery autenticata e generazione riuscita. [Prove reali e limiti dei provider](CONSEGNA-1.0-RC1.md)

<a id="account"></a>
## Account, deleghe e quote

In **Modelli e account** puoi cercare una connessione, esaminare i modelli di un account, verificarlo, aggiungere un altro profilo o aprire **Consumi**. Un operatore può aprire un modello e correggere il nome visibile, la finestra di contesto o le capacità dichiarate di conversazione, chiamata di tool, embedding e visione. Usa valori verificati per la specifica versione del motore.

L’azione **Accesso** presenta gli utenti delegabili al proprietario autorizzato. Seleziona le persone autorizzate a usare il profilo. L’operatore vede gli utenti abilitati con cui condivide un progetto, l’amministratore può scegliere fra gli utenti abilitati del coordinator. Per i provider HTTP puoi anche condividere con gli utenti abilitati. Per i profili nativi scegli esplicitamente gli operatori autorizzati. Rimuovi una selezione e salva per revocare l’uso futuro. Per aggiornare una chiave senza creare un altro account modifica la connessione esistente. Usa una diversa etichetta quando vuoi invece un secondo profilo.

Leggi insieme la fonte della quota, la data di osservazione, l’eventuale finestra di ripristino e lo stato. Se due profili dello stesso proprietario dipendono dallo stesso limite, associa il medesimo dominio quota nelle opzioni dell’account. Un limite osservato si propaga tra i profili di quel dominio. Un dato assente resta sconosciuto. Una risposta del provider che segnala congestione può rendere inutilizzabile un modello anche quando il catalogo è raggiungibile.

<a id="routing"></a>
## Scegliere una rotta e autorizzare le alternative

Nel composer apri il selettore del modello. Cerca la rotta per nome, confronta account, disponibilità e capacità, poi sceglila. Lo stesso selettore può essere aperto da un account o dal dettaglio di un agente. Una scelta per la conversazione agisce sui turni successivi. Per cambiare l’orchestratore condiviso del progetto usa l’opzione esplicita per salvarlo come predefinito, se autorizzato.

| Strategia | Decisione del coordinator |
|---|---|
| **Fisso** | Prova la rotta selezionata. Attende le risorse entro il limite previsto, oppure segnala perché la scelta è incompatibile o indisponibile. |
| **Auto** | Considera la preferita e le alternative autorizzate. Valuta accesso, capacità, contesto, quota osservata, carico e disponibilità dei gruppi di risorse. Un motore distribuito riserva insieme tutti i gruppi richiesti. |

In **Se il modello è occupato** scegli **Attendi il modello selezionato** o **Usa un’alternativa autorizzata disponibile**. In **Attesa massima (secondi)** il campo vuoto usa il limite della modalità e zero richiede la disponibilità immediata. La politica del progetto può essere sostituita per la richiesta. Se il contenuto deve restare sul cluster, autorizza esclusivamente rotte locali. Un fallback cloud autorizza l’invio del contesto a quel servizio. Su HTTP una 429 prima dell’emissione di contenuto o di effetti può consentire una nuova selezione fra le alternative. Nel dettaglio del task puoi confrontare la rotta richiesta e quella effettivamente scelta e leggere la motivazione disponibile. [Routing, code e sonde](ROUTING.md)

<a id="chat"></a>
## Chat, contesto e allegati

In **Chat e squadra** scegli una conversazione dalla cronologia oppure usa **+** accanto a **Conversazioni**. La ricerca laterale filtra le tue conversazioni del progetto. Il composer conserva localmente la bozza durante il cambio di conversazione nella stessa sessione. Usa **Invio** per inviare e **Maiusc+Invio** per andare a capo.

| Modalità | Quando usarla | Cosa succede |
|---|---|---|
| **Auto** | Vuoi che il gateway interpreti la richiesta | Un intento di stato riconosciuto ottiene una risposta di servizio. Una domanda ordinaria usa la chat. Una richiesta di lavoro può richiedere la configurazione di una missione. |
| **Chat** | Vuoi discutere o interrogare il modello selezionato | Il turno prosegue nella conversazione. Puoi fare una domanda anche mentre una missione è in corso. |
| **Missione** | Vuoi affidare un obiettivo verificabile alla squadra | Il coordinator controlla configurazione, permessi e rotta. Se manca un prerequisito il composer indica l’azione per completarlo. |
| **Istruzioni alla squadra** | Vuoi correggere la missione aperta | L’indicazione viene associata alla missione. Al momento della ripresa la squadra può ripianificare. |

Una richiesta di stato come «a che punto siamo?» può essere soddisfatta dal servizio con zero chiamate modello. Sotto un turno di inferenza trovi le misure disponibili e l’origine dei dati. **Interrompi risposta** interrompe un turno in corso. Se ci sono operazioni già inviate al runner, controllane l’esito nel Percorso.

Con la **graffetta**, seleziona un allegato del progetto oppure carica un documento di testo o Markdown. Il limite indicato dalla UI è 1 MiB per documento. In VS Code puoi aggiungere la selezione dell’editor. I file scelti compaiono nel composer e possono essere rimossi dalla richiesta successiva. La scheda Conoscenza consente di gestire il documento archiviato. **Contesto** apre il rapporto dell’ultimo task disponibile con fonti, budget ed esclusioni. **Esporta conversazione** salva in JSON la conversazione selezionata.

<a id="rami"></a>
### Creare e riaprire un ramo

Usa il comando di ramo nella conversazione oppure **Crea ramo dalla richiesta** nel Percorso. Scegli l’ultimo messaggio da includere e, se vuoi, assegna un titolo. Il nuovo thread riprende lo storico fino a quel punto. I messaggi successivi si accumulano nel ramo aperto. Gli allegati e il workspace continuano a seguire le regole del progetto. Per cambiare anche l’isolamento dei file scegli il worktree nelle impostazioni della missione.

<a id="autonomia"></a>
## Autonomia e prima missione

Per una prima prova scegli un repository locale autorizzato, una ricetta di test già configurata e un piccolo difetto osservabile. Un obiettivo adatto è «Correggi la normalizzazione delle righe in `index.js`. Conserva le righe vuote e verifica con il test del progetto». Allega la specifica e indica il risultato atteso.

1. In **Progetto** controlla il primario, il coder, il reviewer e almeno una verifica per il lavoro eseguibile. Il coder HTTP deve offrire strumenti compatibili.
2. Dal composer apri **Autonomia della prossima missione**. Scegli i permessi di scrittura, comando e rilascio richiesti, il massimo di agenti paralleli e il limite di iterazioni. La UI permette da 1 a 6 per parallelismo e iterazioni. La capacità effettiva dipende anche dal target, dai nodi, dagli account disponibili e dai budget del run.
3. Per un target locale puoi scegliere il checkout della prossima missione e sovrascrivere il default del progetto. Il checkout Git separato richiede un repository utilizzabile sul target.
4. Invia in modalità **Missione**. Il piano appare nella squadra con attività, dipendenze e modelli assegnati. Osserva i risultati di review e delle verifiche. Se la ricetta di rilascio è prevista, esamina separatamente la revisione e l’approvazione del deploy.

La specifica conservata dal run identifica le decisioni in vigore all’avvio. Il contesto effettivamente consegnato a un particolare modello dipende dalla sua finestra, dal budget, dalla richiesta, dalle dipendenze e dalle fonti accessibili in quel momento.

<a id="squadra"></a>
## Controllare squadra, task e approvazioni

Apri **Squadra** nella vista chat. Nei pannelli stretti puoi aprire e chiudere questa vista per lasciare spazio al composer. Le schede mostrano ruolo, stato, modello e attività da cui il task dipende. Il verificatore identifica le ricette di test configurate e il rilascio identifica una ricetta eseguibile. In fondo trovi le chiamate consumate rispetto al budget e i token di output disponibili nel run.

| Azione | Effetto e verifica |
|---|---|
| Selezionare un task | Le schede di dettaglio mostrano output, eventi e contesto disponibili. Leggi il risultato nel task che lo ha prodotto. |
| Mettere in pausa o annullare | Puoi agire sull’intera missione o su un singolo agente dove il suo stato lo consente. Una pausa selettiva può lasciare avanzare attività indipendenti. Le dipendenze continuano a vincolare quelle successive. |
| **Guida** o **Istruzione** | Usa **Guida** per aggiornare la direzione della squadra e **Istruzione** dal task per indirizzare il singolo agente. Controlla lo stato prima di premere **Riprendi**. |
| **Cambia modello / account** | Scegli una rotta compatibile per il task. Il cambio di una fase registra la decisione nel run. Le fasi di verifica e rilascio dipendono dalle loro ricette. |
| **Approva** o **Nega** | Leggi operazione proposta, motivazione e relativo task. La decisione vale per quella richiesta correlata. In seguito apri l’evidenza che documenta cosa ha eseguito il runner. |

Il coordinator può riprendere il lavoro dai checkpoint e distinguere più tentativi di uno stesso task. Per un effetto dal risultato incerto segui la [procedura di riconciliazione](#ripresa).

<a id="percorso"></a>
## Leggere graficamente il percorso di un progetto

1. Apri **Percorso del progetto**. Cerca una run (un’esecuzione) e selezionala dall’elenco. **Leggi la richiesta e gli allegati** riporta all’obiettivo originale.
2. Nel grafo **Dipendenze e rami**, seleziona un nodo. Le frecce seguono le dipendenze fra task. L’evidenziazione consente di seguire la catena che porta al nodo scelto. Controlla nome del task, stato, modello e tentativi nella vista di dettaglio.
3. Nel **Registro attività** scegli un evento per leggere lo stato ricostruito fino a quella transizione. **Carica altri eventi** amplia la porzione di registro disponibile. **Torna adesso** riporta alla situazione corrente prima di operare sulla missione.
4. Apri un’evidenza collegata. Per una lettura controlla percorso e digest. Per una verifica controlla il comando autorizzato e il risultato del processo. Un task completato e un’operazione eseguita con successo hanno evidenze distinte.
5. Usa **Apri conversazione** per riprendere il dialogo e **Copia collegamento** per riaprire la stessa vista da altro client. L’indirizzo identifica progetto, conversazione e run. Per leggere i dettagli occorre l’identità autorizzata. Un ramo mostra il collegamento con la richiesta di origine.

Per ripercorrere la prova svolta sul cluster, apri la missione con planner Astra, coder Qwen e reviewer Codex riportata nell’handoff. Troverai otto chiamate misurate, una lettura del file nel worktree e le verifiche del candidato. [Missione e risultati del collaudo](CONSEGNA-1.0-RC1.md#missione-finale-con-tre-fonti)

<a id="ripresa"></a>
### Riprendere dopo una disconnessione o un’interruzione

Riapri la conversazione e il registro della run. Una disconnessione del browser può interrompere la visualizzazione dello stream mentre il coordinator continua a lavorare. Un arresto del coordinator o la perdita del runner durante una scrittura può invece lasciare incerto l’effetto sul target.

In **Effetti da verificare**, apri l’operazione e controlla il target effettivo. Per esempio, confronta il digest del file e il contenuto atteso oppure verifica il riferimento Git creato da una promozione. **Registra esito verificato** consente di indicare applicato, non applicato o annullato tramite rollback, con una nota che descrive l’evidenza osservata. Usa poi la ripresa prevista dal run. Promozione e pulizia Git hanno controlli specifici per verificarne l’esito. [Esecuzione, checkpoint e strumenti](EXECUTION.md)

<a id="conoscenza"></a>
## Conoscenza del progetto

### Documenti e allegati

In **Conoscenza → Allegati e documenti**, usa **Carica documenti** per inserire testo o Markdown. La scheda mostra nome, dimensione e tipo. **Apri** consente di leggere il contenuto e **Scarica** di salvarlo. La rimozione di un allegato cancella il suo indice e viene bloccata se il file è in uso. I documenti, le evidenze e le consegne compaiono con tipi distinti.

### Metodi, decisioni, brief e revisioni

In **Metodi e decisioni → Aggiungi conoscenza** scegli tipo, titolo, testo, visibilità e una fonte disponibile, per esempio un allegato o una conversazione. Le nuove voci sono proposte. Controlla il testo, poi usa **Approva per il contesto** per renderle recuperabili. La pubblicazione di una voce condivisa richiede il responsabile del progetto o un ruolo autorizzato. Un documento usato come fonte conserva la propria visibilità anche quando una memoria approvata è condivisa.

**Modifica** salva una revisione. **Ritira dal contesto** esclude la voce dalle ricerche successive. **Dimentica** elimina la memoria, le revisioni e i vettori memorizzati. I rapporti delle vecchie esecuzioni conservano il riferimento storico. Una citazione aperta in seguito viene controllata con le autorizzazioni e la revisione correnti.

### Cercare, citare e aggiornare l’indice

In **Cerca nel contesto**, inserisci una domanda relativa al progetto. Per ciascun risultato leggi l’estratto, la fonte, il metodo e le informazioni di revisione. **Apri fonte citata** verifica la fonte e mostra il passaggio originale. Una fonte ritirata, modificata o divenuta inaccessibile può quindi richiedere una nuova ricerca.

Con un encoder assegnato al progetto e vettori disponibili, il lettore interno combina indizi testuali e vettoriali. Un encoder assente o temporaneamente indisponibile lascia disponibile il recupero lessicale. Con il default locale configurato, il caricamento di un documento o l’approvazione di una memoria avvia l’indicizzazione in background. **Aggiorna indice vettoriale** consente al titolare autorizzato di richiedere un nuovo passaggio sull’indice. Il rapporto distingue i risultati disponibili e il budget testuale. Il collaudo ha incluso il recupero di testo italiano tramite domanda inglese. [Funzionamento del lettore](KNOWLEDGE-MEMORILLA.md) · [Encoder locale](ENCODER-LOCALE.md)

<a id="infrastruttura"></a>
## Dashboard cluster, Fleet e nodi remoti

**Dashboard cluster** mostra i nodi configurati e il campione di telemetria quando disponibile. Per ciascuna macchina leggi stato, utilizzo, temperatura, potenza, memoria e ora dell’osservazione. I piccoli grafici si basano sui campioni disponibili durante la sessione. **Aggiorna telemetria** richiede una nuova osservazione se il ruolo lo consente. Le linee di rete rappresentano collegamenti configurati. Una descrizione come «USB4» identifica il tipo di interconnessione e lascia la misura della banda a una sonda dedicata.

**Risorse condivise e parallelismo** mostra slot occupati e capacità dei gruppi gestiti dal coordinator. Il selettore delle rotte e la tabella di disponibilità riportano anche dati del motore quando sono configurate le relative sonde. Due motori con gruppi indipendenti possono lavorare contemporaneamente. Due richieste per lo stesso gruppo a capacità uno devono dividersi lo slot.

Usa **Fleet monitor** per consultare da un’altra schermata metriche aggregate della facciata, nodi, collegamenti, motori e ultimi campioni. La pagina aggiorna i dati ogni quattro secondi quando è visibile. Un motore può offrire **Attiva** e, se previsto dalla sua ricetta, **Arresta**. Il monitor acquisisce la sessione operatore prima di completare una richiesta protetta.

Per aggiungere un’altra macchina che offre inferenza, pubblica la sua API supportata con il bridge di nodo, direttamente sul collegamento autorizzato oppure tramite il tunnel descritto nella guida. Configura base URL, autenticazione, modello e risorse nel coordinator, verifica il catalogo e prova una generazione. Per eseguire anche strumenti o test su quel nodo occorrono un target di esecuzione e il relativo runner. [Adapter di inferenza per un nodo](NODO-INFERENZA.md) · [Runner e ricette](EXECUTION.md)

<a id="consumi"></a>
## Consumi e prestazioni osservabili

Apri **Consumi** da **Modelli e account** o **Dashboard cluster**. Per la tua identità, il pannello raggruppa i dati per rotta e account. Le colonne indicano richieste, richieste con input misurato e token di input e output riportati.

| Sezione | Unità contata |
|---|---|
| **Gateway API** | Richieste alla facciata di inferenza. |
| **Conversazioni** | Turni di assistente con metriche, deduplicati quando la cronologia viene ramificata. |
| **Chiamate degli agenti nelle missioni** | Ogni invocazione completata con evento registrato. Più giri di uno stesso coder possono produrre più chiamate. Per i runtime nativi l’unità osservata può essere un turno del runtime. |
| **Storico importato** | Totali e giornate attribuiti al proprietario durante la migrazione, con provenienza separata. |

Per capire un’attesa, controlla **coda** per il tempo prima dell’assegnazione, **TTFT** per il primo token e **durata** per l’intera chiamata. Prefill e decode descrivono fasi diverse, quando il motore le espone. Il contesto può essere riportato dal provider oppure stimato. Leggi l’origine indicata accanto al valore. Un trattino segnala un dato assente. I dettagli dei test reali riportano modello, hardware, carico, modalità e limiti di riproducibilità. [Prestazioni e conteggi del collaudo](CONSEGNA-1.0-RC1.md)

<a id="consegne"></a>
## Consegne, Git e rilascio applicativo

In **Consegne e rilasci** seleziona la missione del progetto, poi **Leggi risultato**, **Apri missione** o **Esamina e rilascia** secondo lo stato. Il risultato dell’agente, la prova eseguibile, la promozione Git e la disponibilità dell’applicazione sul target sono registrati in fasi distinte.

- **Verificare il candidato.** Apri l’output della review e i risultati delle ricette di verifica. Nel checkout Git dedicato puoi leggere i file modificati, il diff o il rapporto salvato e il commit verificato quando disponibili.
- **Promuovere in Git.** Nel Percorso, **Promuovi candidato** associa il digest verificato a un ramo gestito. Per integrare quel ramo nel ramo principale del repository si usa il normale flusso Git del progetto.
- **Distribuire l’applicazione.** Nella finestra **Rilascio in produzione** controlla obiettivo, target, ricetta, digest ed evidenze. **Autorizza questo rilascio** invia l’approvazione per quella revisione. Il runner esegue deploy e health check secondo la ricetta. Se il controllo fallisce, consulta il risultato del rollback previsto.
- **Pulire il checkout.** Dopo promozione e chiusura della missione, **Rimuovi checkout temporaneo** verifica lo stato del checkout prima della pulizia. La missione mantiene il rapporto e le evidenze.

Un progetto privo di ricetta di produzione può rendere verificabile la modifica e promuovere il candidato Git. Per distribuire sul target l’operatore deve prima configurare una ricetta compatibile. [Esecuzione e criteri di rilascio](EXECUTION.md)

<a id="vscode"></a>
## Pannello VS Code e Remote SSH

Installa il VSIX distribuito insieme a questa versione del coordinator. In ambiente Remote SSH installalo sul target dell’extension host. Dalla palette scegli **yed1z: Collega il gateway**, inserisci l’origine del coordinator, per esempio `https://yed1z.ai`, e la chiave personale. La chiave viene salvata nel SecretStorage dell’host associata a quell’origine. Un indirizzo loopback punta alla macchina su cui gira l’extension host.

| Comando o funzione | Come usarlo |
|---|---|
| **yed1z: Apri Control Room** | Apre il pannello yed1z nell’Activity Bar. Scegli lo stesso progetto del browser per riprenderne conversazioni, missioni e prove autorizzate. |
| **yed1z: Collega il gateway** | Imposta o cambia origine e credenziale. Per un’origine già nota il dialogo consente di conservare la chiave salvata. |
| **yed1z: Aggiungi selezione al contesto** | Seleziona il testo nell’editor e usa il menu contestuale o la palette. Il pannello riceve quella selezione come allegato. È richiesto un workspace attendibile. |
| **yed1z: Apri portale nel browser** | Apre la Control Room Web del gateway configurato. La sessione Web usa il proprio login. |
| **Evidenze e file** | Apri gli artefatti dal pannello. Le azioni di salvataggio usano il dialogo nativo. Per le modifiche confrontabili, la vista diff dell’editor permette di esaminarle. |

In modalità limitata puoi consultare monitor e cronologia e regolare l’aspetto. Le nuove attività operative e i trasferimenti richiedono un workspace attendibile. In una barra stretta usa il menu per cambiare sezione e **Squadra** per il dettaglio degli agenti. Le finestre supportano tabulazione ed Escape con ritorno al controllo di apertura. [Estensione VS Code](../vscode/README.md)

<a id="api"></a>
## Usare il gateway da altri client

1. Configura il client con la base API del coordinator, per esempio `https://yed1z.ai/v1`, e la chiave personale yed1z nel campo di autenticazione Bearer.
2. Richiedi `GET /v1/models` e scegli una rotta accessibile a quell’identità. Se più account espongono lo stesso nome modello, usa l’ID della rotta per eliminare l’ambiguità.
3. Usa `POST /v1/chat/completions` oppure `POST /v1/responses` secondo il contratto supportato dalla rotta e dal client. Le risposte in streaming permettono di misurare l’arrivo del primo contenuto. Per usare Qwen locale da Codex occorre una rotta compatibile con il protocollo Responses e con gli strumenti richiesti.
4. Per creare un progetto o seguire una missione da un client personalizzato usa le API `/api/`. Gli eventi del coordinator ricostruiscono i passaggi persistiti dopo una riconnessione. Quote, compatibilità e permessi restano verificati sul server. [Riferimento delle API](API.md)

<a id="diagnosi"></a>
## Diagnosi per sintomo

| Sintomo | Verifica concreta |
|---|---|
| Il monitor si apre ma i quadranti mostrano trattini | Verifica lo stato di collegamento e l’ultimo campione del nodo in **Dashboard cluster**. Un identificativo configurato può esistere anche in assenza di un sensore attivo. |
| Non trovo il progetto di un collega | Controlla origine, identità e membership. I thread e i run personali restano legati al titolare. Per rendere riutilizzabile una decisione nel team, pubblica esplicitamente una memoria approvata di progetto. |
| Trovo il modello su un account e non sull’altro | Esegui **Verifica account** su ciascun profilo e controlla login, catalogo e delega. L’abilitazione vale per la combinazione modello/provider/account. |
| Il catalogo è pronto ma la chat fallisce | Prova una generazione breve fissando la rotta. Verifica messaggio del provider, eventuale alta domanda o cooldown, metadati e finestra di contesto. |
| La chat funziona ma **Missione** è bloccata | Controlla ruolo, target, workspace, ricette di verifica e capacità del coder. Apri l’azione indicata dal composer e completa il prerequisito segnalato. |
| Il nodo sembra libero ma il modello resta in coda | Esamina insieme gruppo hardware, account nativo già occupato, motori che condividono la memoria, stato della sonda esterna e alternative consentite. |
| Una memoria approvata non compare | Verifica progetto, identità, visibilità e domanda. Guarda modalità e budget di recupero. Se è configurato l’encoder controllalo e aggiorna l’indice dai comandi del progetto. |
| Dopo una disconnessione un task richiede verifica | Apri il registro degli effetti e controlla sul target ciò che è stato applicato. Registra l’esito con evidenza prima della ripresa. |
| Il test è verde ma manca il rilascio | Controlla che il progetto abbia una ricetta di deploy e che l’approvazione riguardi il digest effettivamente verificato. Poi esamina l’health check del target. |
