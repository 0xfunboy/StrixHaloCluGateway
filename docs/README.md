# Documentazione di yed1z

La [dashboard hardware](https://yed1z.ai/) mostra il cluster della macchina di riferimento. La [Control Room](https://yed1z.ai/control) apre lo spazio di lavoro. Questo indice riguarda il coordinator TypeScript **1.0.0-rc.1**, il client Web, l’estensione VS Code e i componenti di nodo.

| Se stai cercando… | Parti da qui |
|---|---|
| Una presentazione del prodotto, un caso reale e i benchmark | [README del prodotto](../README.md) |
| I passaggi da fare davanti all’interfaccia | [Manuale della Control Room](GUIDA-PRODOTTO.md) |
| Un endpoint, i campi accettati, il permesso o l’errore previsto | [Riferimento HTTP per funzione](RIFERIMENTO-FUNZIONI.md) |
| Un comando da terminale, un’opzione del servizio o il protocollo di nodo | [Riferimento CLI, nodi e VS Code](RIFERIMENTO-CLI.md) |
| I risultati del collaudo e le verifiche da completare con i titolari degli account | [Handoff 1.0 RC1](CONSEGNA-1.0-RC1.md) |

## Indice delle funzioni

### Monitor e accesso

| Funzione | Cosa spiega la guida |
|---|---|
| [Home, Control Room e Fleet](GUIDA-PRODOTTO.md#ingressi) | Come scegliere l’ingresso, passare da monitor a progetto e usare i vecchi collegamenti alle missioni. |
| [HUD hardware](GUIDA-PRODOTTO.md#hud) | Topologia, nodi, sensori, motore attivo, TTFT, prefill, decode, statistiche e controlli manuali. Le velocità nominali e le etichette della topologia storica sono riferimenti di configurazione. |
| [Sessione, utente e ruoli](GUIDA-PRODOTTO.md#accesso) | Differenze tra ospite, lettore, membro, operatore e amministratore. Chi può vedere un progetto, eseguire strumenti o gestire le connessioni. |
| [Aspetto e sessione HTTP](RIFERIMENTO-FUNZIONI.md#dashboard-sessione-e-preferenze) | Login e logout, cookie, origine ammessa, lettura dello stato iniziale, tema, movimento ed eventi. |

### Progetti, modelli e account

| Funzione | Cosa spiega la guida |
|---|---|
| [Creazione e impostazioni del progetto](GUIDA-PRODOTTO.md#progetto) | Obiettivo, workspace, modello per ruolo, encoder, verifiche e destinazione di rilascio. |
| [Wizard di collegamento](GUIDA-PRODOTTO.md#connessioni) | Scelta del preset, URL del servizio, verifica dell’accesso, scoperta del catalogo e diagnosi di un modello in standby. |
| [Login Codex](GUIDA-PRODOTTO.md#login-codex) | Avvio del login ufficiale, identità del profilo, conferma e rinnovo del catalogo. |
| [Login Antigravity](GUIDA-PRODOTTO.md#login-antigravity) | Consenso Google, consegna del codice alla richiesta attiva, attesa o annullamento e successiva scoperta ACP. |
| [Account privati, deleghe e pool](GUIDA-PRODOTTO.md#account) | Concessione e revoca, più identità per provider e condivisione esplicita dei domini di quota. |
| [Selezione, alternative e coda](GUIDA-PRODOTTO.md#routing) | Scelta per un turno o per il progetto, rotta fissa o automatica, quote sconosciute e contesa fra modelli. |
| [Capacità degli adapter](ADAPTERS.md) | Completamento, streaming, uso, strumenti, embedding, login nativo e limiti del protocollo. |
| [Regole del router](ROUTING.md) | Come vengono prenotate insieme le risorse, quando è ammesso un fallback e come un probe segnala carico esterno. |

### Conversazioni, harness e consegna

| Funzione | Cosa spiega la guida |
|---|---|
| [Chat, cronologia e rami](GUIDA-PRODOTTO.md#chat) | Invio in Auto, Chat o Missione, scelta del modello, allegati, esportazione e ripresa dal turno scelto. |
| [Autonomia e permessi](GUIDA-PRODOTTO.md#autonomia) | Cosa concedi agli agenti, limiti del lavoro e quando una proposta richiede l’intervento dell’operatore. |
| [Controllo della squadra](GUIDA-PRODOTTO.md#squadra) | Lettura del piano, dipendenze, task, istruzioni durante il lavoro, pausa e cambio rotta. |
| [Percorso e prove](GUIDA-PRODOTTO.md#percorso) | Navigazione dal grafo al task, confronto fra eventi passati e live, tentativi, effetti incerti ed evidenze. |
| [Esecuzione e worktree](EXECUTION.md) | Dove vengono letti e scritti i file, quali ricette si possono invocare, come si applicano approvazioni e verifiche. |
| [Consegne e rilasci](GUIDA-PRODOTTO.md#consegne) | Apertura del rapporto, importanza del digest, promozione del candidato, health check, rollback e recupero. |

### Knowledge, risorse e misurazione

| Funzione | Cosa spiega la guida |
|---|---|
| [Allegati e memorie](GUIDA-PRODOTTO.md#conoscenza) | Caricare testo, proporre una memoria, distinguere ambito privato e di progetto, approvare, rettificare e ritirare. |
| [Ricerca e citazioni](KNOWLEDGE-MEMORILLA.md) | Come domanda e permessi determinano il corpus, come si combinano lessico e vettori e come riaprire la fonte citata. |
| [Encoder locale](ENCODER-LOCALE.md) | Modello CPU, dimensione dei vettori, installazione riproducibile, indicizzazione incrementale e ricerca multilingue. |
| [Dashboard cluster e risorse](GUIDA-PRODOTTO.md#infrastruttura) | Leggere la topologia e distinguere una connessione configurata, la misura di un sensore e uno slot prenotato. |
| [Consumi](GUIDA-PRODOTTO.md#consumi) | Leggere l’uso per account e rotta, distinguere turno di chat, chiamata di missione, traffico API e archivio importato. |
| [Prestazioni e condizioni di misura](../README.md#prestazioni-misurate) | TTFT su Strix e CUDA, avvio dei modelli, coda reale fra utenti e percentili sotto carico controllato. |

## Integrazione e amministrazione

| Operazione | Riferimento |
|---|---|
| Configurare VS Code, Remote SSH e SecretStorage, inviare la selezione corrente, aprire il portale | [Manuale dell’editor](GUIDA-PRODOTTO.md#vscode) · [Comandi disponibili](RIFERIMENTO-CLI.md#comandi-di-vs-code) |
| Inizializzare il coordinator, aggiungere utenti, eseguire una sonda, importare gli archivi o creare un backup SQLite | [Eseguibili e comandi](RIFERIMENTO-CLI.md#eseguibili-e-comandi) |
| Configurare ascolto, origine pubblica, nodi, gruppi di risorse, target, provider, identità e ricette | [Configurazione del coordinator](RIFERIMENTO-CLI.md#configurazione-del-coordinator) · [Esempio del cluster](../examples/strix-cluster.json) |
| Esporre l’inferenza di un’altra macchina e distinguere credenziali del bridge e del motore | [Adapter di nodo con esempio SSH](NODO-INFERENZA.md) · [Endpoint del bridge](RIFERIMENTO-CLI.md#bridge-di-inferenza) |
| Eseguire operazioni sul filesystem e comandi registrati su un target locale o SSH | [Runner](RIFERIMENTO-CLI.md#runner-di-esecuzione) · [Configurazione di un nodo](../examples/node-runner.json) |
| Configurare test, deploy applicativo e rollback sul target effettivo | [Esecuzione e rilascio](EXECUTION.md) · [Ricetta di esempio](../examples/deployment-recipe.json) |
| Verificare catalogo e generazione con la CLI, analizzare quota esaurita o motore irraggiungibile | [Diagnosi per l’utente](GUIDA-PRODOTTO.md#diagnosi) · [Diagnosi da terminale](RIFERIMENTO-CLI.md#verifica-e-diagnosi) |
| Ricostruire i bundle e il VSIX, ripetere i test o controllare una consegna | [Comandi di sviluppo](../README.md#esercizio-dati-e-licenza) · [Consegna e collaudo](CONSEGNA-1.0-RC1.md) |

## Indice delle API

Il riferimento specifica metodo, percorso, ruolo, effetto e risultato di ogni operazione. La guida API estesa include gli esempi di payload e la semantica degli eventi. [Riferimento completo](RIFERIMENTO-FUNZIONI.md) · [Contratti ed esempi](API.md)

- [Accesso, proprietà e convenzioni delle richieste](RIFERIMENTO-FUNZIONI.md#convenzioni-di-accesso)
- [Dashboard e sessione](RIFERIMENTO-FUNZIONI.md#dashboard-sessione-e-preferenze)
- [Progetti, conversazioni, messaggi e rami](RIFERIMENTO-FUNZIONI.md#progetti-e-conversazioni)
- [Missioni, task, eventi, approvazioni e azioni su worktree](RIFERIMENTO-FUNZIONI.md#controllo-di-missioni-task-e-approvazioni)
- [Collegamenti, login, deleghe, modelli e catalogo](RIFERIMENTO-FUNZIONI.md#connessioni-account-e-catalogo)
- [Documenti, memoria e fonti citabili](RIFERIMENTO-FUNZIONI.md#documenti-memorie-e-citazioni)
- [Uso, switch motore e gestione utenti](RIFERIMENTO-FUNZIONI.md#misure-switch-e-utenti)
- [Catalogo OpenAI-compatible, Chat Completions, Responses e alias](RIFERIMENTO-FUNZIONI.md#inferenza-compatibile-openai-e-alias)
- [Errori, stati transitori e recupero](RIFERIMENTO-FUNZIONI.md#errori-e-recupero)

## Architettura, evoluzione e collaudi precedenti

Il [piano di prodotto](PIANO-PRODOTTO-1.0.md) collega le richieste ai criteri di accettazione. La [matrice P1–P9](CONSEGNA-1.0-RC1.md#stato-delle-prove-del-piano) documenta quali passaggi sono stati verificati sui provider, quali su fixture e quali richiedono ancora un consenso o una ricetta di destinazione.

I documenti seguenti descrivono le rispettive versioni storiche. Sono utili per ricostruire una scelta o migrare un archivio proveniente da quella versione.

| Documento | Contenuto |
|---|---|
| [Architettura 0.4](ARCHITETTURA.md) e [UX 0.4](UX.md) | Stato del coordinator, topologia distribuita, progetto e interfacce prima della RC. |
| [Migrazioni precedenti](MIGRATION.md) | Schemi dei vecchi gateway e attribuzione degli archivi di conversazione. Per migrare chiavi e contatori del gateway storico alla RC usa il comando [import-gateway](RIFERIMENTO-CLI.md#eseguibili-e-comandi). |
| [Handoff 0.4](../HANDOFF.md), [verifica 0.4](VERIFICA.md) e [output della validazione](VALIDATION.txt) | Prove riproducibili e limiti della precedente distribuzione. |
| [Audit delle lacune](GAP_AUDIT.md) e [changelog](../CHANGELOG.md) | Evidenze di partenza e successione degli interventi. |
