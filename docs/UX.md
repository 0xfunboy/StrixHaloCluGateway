# yed1z Control Room: esperienza d’uso

## Il centro del prodotto è il progetto

L’interfaccia riunisce l’obiettivo dell’utente, l’orchestratore primario, la squadra e le risorse distribuite. Un progetto conserva conversazioni, route dei diversi ruoli, documenti, metodi approvati, contesto, evidenze e destinazione di esecuzione. Web e VS Code utilizzano lo stesso contratto API e gli stessi dati sul coordinator.

La macchina che fornisce inferenza non viene confusa con quella che esegue i tool. Una route può occupare entrambi gli Strix, mentre un task modifica un workspace autorizzato sul coordinator o su un target SSH. GemRouter resta un provider di inferenza: i suoi modelli sono selezionabili insieme agli altri.

## Schermata principale

La struttura della Control room contiene quattro aree:

1. **Navigazione personale.** Progetto attivo, conversazioni dell’utente e viste secondarie. Le bozze restano separate per progetto e conversazione in memoria della vista, senza scrivere credenziali nel browser.
2. **Panoramica sempre visibile.** Nodi configurati, stato della telemetria, GPU, temperatura e potenza quando misurati, numero di attività e decisioni in attesa. Da qui si apre anche l’elenco delle missioni dei diversi progetti.
3. **Orchestratore.** Conversazione, allegati, modello/account e modalità. Il cambio di route conserva la cronologia. Durante una missione il composer invia nuove istruzioni e allegati alla missione aperta; la ripianificazione passa da una pausa esplicita per non ripetere effetti già eseguiti.
4. **Squadra.** Mappa SVG delle dipendenze effettive, attività, modello assegnato, stato, dipendenze, budget e iterazioni. Selezionando un agente si vedono output, eventi, contesto ed evidenze. Un task in coda o in pausa può cambiare modello e account.

Il grafo deriva dagli ID di dipendenza dei task: attività indipendenti occupano lo stesso livello, le frecce collegano solo dipendenze dichiarate. I nodi del grafo sono selezionabili anche con tastiera.

I task Ricercatore e Sviluppatore espongono pausa, ripresa, annullamento e istruzioni dedicate. Fermare un agente lascia proseguire i rami indipendenti; le dipendenze restano in attesa. Orchestratore, revisore e fasi di verifica/rilascio usano i controlli della missione. Le verifiche e il release controller sono identificati come esecuzioni deterministiche, non come chiamate a un modello.

## Viste secondarie

| Vista | Contenuto | Azioni principali |
| --- | --- | --- |
| Infrastruttura | Nodi, RAM/VRAM, CPU/GPU, tempi di osservazione, pool condivisi, collegamenti configurati, route e macchine | Aggiornare telemetria; espandere interfacce e contatori di rete |
| Conoscenza | Metodi, decisioni, brief, documenti e relativa provenienza | Creare una proposta, approvare, aggiornare una revisione, dimenticare, cercare, reindicizzare |
| Modelli e account | Provider, account distinti, modelli scoperti e quote osservate | Collegare un account, trovare modelli, accedere a Codex, dichiarare capacità verificate |
| Consegne e rilasci | Missioni, risultati, evidenze di test/revisione/deploy | Esaminare la consegna, tornare alla missione, autorizzare una ricetta di rilascio |

I grafici GPU usano esclusivamente campioni ricevuti nella sessione della vista. Il grafico compare dopo almeno due misure e riporta questa provenienza; non è presentato come archivio storico del cluster. RX e TX di rete vengono mostrati solo quando il backend ha ricavato una velocità da più contatori. Velocità nominale del link, traffico osservato e durata della richiesta di telemetria sono etichettati separatamente.

## Primo utilizzo

Un nuovo utente entra con una chiave personale predisposta dall’amministratore. Crea un progetto dando un nome e scegliendo l’orchestratore. Le impostazioni avanzate raccolgono ruoli della squadra, embedding, workspace, verifiche e rilascio.

L’aggiunta di un provider HTTP segue il flusso **servizio → indirizzo/chiave → Verifica e trova modelli**. L’account rimane riconoscibile e la scoperta riempie il catalogo. Una creazione parzialmente riuscita riusa gli ID già ottenuti quando si riprova la scoperta; il modulo non crea automaticamente un secondo account.

I provider e i target definiti dall’operatore vengono mantenuti come risorse configurate. L’interfaccia non interpreta una directory o una porta come prova che un servizio sia duplicato.

Antigravity è assegnabile allo Sviluppatore. Il ruolo di orchestratore e quelli di sola lettura usano altri adapter perché il bridge Antigravity non dichiara una modalità sola lettura verificata. Una missione senza workspace o verifiche eseguibili apre le impostazioni del progetto prima dell’invio: la bozza dell’utente viene conservata.

## Autonomia e ruoli

L’amministratore configura utenti e infrastruttura. Gli operatori autorizzati possono eseguire missioni e rilasci. I membri usano chat HTTP, conversazioni e conoscenza autorizzata; il ruolo di sola lettura non espone azioni di modifica abilitate. Il server verifica comunque ogni richiesta: i controlli grafici sono una spiegazione delle capacità, non il confine di sicurezza.

Il composer permette di impostare le autorizzazioni della prossima missione, il numero massimo di agenti paralleli e il limite di iterazioni. Scritture e ricette non già autorizzate richiedono una decisione puntuale. La capacità dei nodi e i lock del workspace possono ridurre il parallelismo effettivo.

Una quota sconosciuta resta tale. Un 429 mantiene la bozza e non invia il task a un altro account. Un cambio di provider è una scelta dell’utente e non implica la migrazione dello stato interno di una CLI nativa.

## Memoria e contesto comprensibili

Una memoria mostra stato, visibilità, revisione e fonti. Le proposte del revisore richiedono approvazione prima di entrare nel contesto. Il comando **Dimentica** elimina la voce e il suo indice; la conversazione sorgente è un oggetto separato.

Il dettaglio del contesto spiega quante risorse sono state stimate, quanto spazio è riservato all’output e quali fonti sono incluse o escluse. Una stima di token viene descritta come stima. Non viene trasformata in una misura della KV cache o della memoria GPU.

HTML, immagini e istruzioni contenuti in documenti o output non vengono eseguiti dal renderer. I link ammettono solo HTTP/HTTPS senza credenziali incorporate. La scelta di aprire un sito rimane dell’utente.

## Browser e VS Code

Il browser usa una sessione HttpOnly. La chiave viene svuotata dal modulo di login immediatamente dopo l’invio e non viene conservata nel localStorage.

La webview di VS Code non riceve la chiave del gateway. Le richieste passano al bridge dell’extension host, che verifica il workspace trust. L’aggiunta di una API key apre un input nativo password. Allegare una selezione e salvare un’esportazione utilizzano i dialoghi nativi di VS Code.

Lo streaming usa eventi correlati a messaggi, run e task. Gli offset dei messaggi impediscono di duplicare testo già contenuto in uno snapshot. Il risultato finale dell’agente rimane separato dall’anteprima parziale ricevuta durante lo streaming.

## Layout e accessibilità

Il layout desktop usa sidebar, orchestratore e squadra. Sotto 1020 px la squadra diventa un pannello richiamabile; sotto 720 px la navigazione diventa un pannello laterale. La panoramica dei nodi resta scorribile senza comprimere i valori in colonne illeggibili.

Sono presenti nomi accessibili per i controlli, focus visibile, navigazione del grafo da tastiera, link di salto al composer, stati di errore testuali e rispetto di `prefers-reduced-motion`. Il colore non è l’unico indicatore di stato. I colori di testo secondario sono stati verificati numericamente sullo sfondo principale; il colore meno evidente delle variabili di tema supera 5:1 sul pannello.

## Verifica e limiti

I test DOM attraversano i flussi di selezione, messaggistica, steering, memoria, allegati, ruoli, approvazioni e rilascio. Test separati collegano la stessa interfaccia al server HTTP reale, con cookie, SSE, SQLite e un upstream di discovery locale. Questi controlli verificano interazioni e contratti, non la qualità delle risposte di modelli reali.

La verifica visiva con Chromium non è stata possibile nell’ambiente di sviluppo: il processo ha terminato l’avvio con `socket() failed: Operation not permitted`. Non sono state prodotte schermate di validazione né dichiarata parità visiva con Codex/Copilot. Prima della distribuzione occorre controllare rendering e ridimensionamento in un browser reale e nella webview di VS Code collegati al proprio gateway.
