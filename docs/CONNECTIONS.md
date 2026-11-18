# Collegare modelli e account

La connessione è un'unica operazione del prodotto. Il frontend non deve più
creare un provider, poi un account e infine richiedere manualmente la discovery.
Il modulo `src/connections.ts` conserva le credenziali, riusa le configurazioni
compatibili e restituisce il passo successivo da mostrare all'utente.

## Percorso ordinario

1. Scegli Codex, Antigravity, OpenAI API, Gemini API, Ollama, LM Studio, GemRouter
   oppure API compatibile OpenAI.
2. Inserisci solo i campi richiesti per quel tipo. Codex e Antigravity non
   richiedono URL o API key nel form. I preset con un endpoint noto lo precompilano.
3. Collega: il server crea o riusa l'account e verifica il catalogo. Le credenziali
   rimangono nel deposito cifrato; la risposta contiene soltanto metadati pubblici.
4. Scegli un modello rilevato oppure completa il login indicato. Il login Codex
   completato avvia automaticamente la discovery.

Le opzioni avanzate includono etichetta dell'account, condivisione, associazione
alle risorse e ID dei modelli per API prive di un catalogo. L'etichetta distingue
due account della stessa connessione. Ripetere `Principale` riusa l'account
personale esistente; un'etichetta differente crea un altro account.
Gli operatori possono indicare un dominio quota quando il provider conferma
che più credenziali condividono un limite. La riserva osservata si applica solo
agli account dello stesso proprietario associati a quel dominio. I nomi dei
domini sono visibili al proprietario.

## Contratto HTTP

I tipi pubblici sono definiti in `src/connection-types.ts` e riesportati dal
contratto principale.

| Endpoint | Funzione |
|---|---|
| `GET /api/connections/options` | Preset e connessioni configurate accessibili all'utente. |
| `POST /api/connections` | Collegamento, correzione credenziale, discovery e risultato recuperabile. |
| `POST /api/connections/detect` | Ricerca limitata ai due server locali predefiniti e agli endpoint già configurati. |
| `POST /api/accounts/:id/login` | Login ufficiale Codex asincrono, con eventi effimeri del proprietario. |
| `GET /api/accounts/:id/login` | Ultimo stato effimero del login. Recupera il codice attivo dopo una riconnessione. |
| `DELETE /api/accounts/:id/login` | Annulla il login in corso di quell'account. |

Esempio di collegamento HTTP:

```json
{
  "preset": "gemrouter",
  "baseUrl": "https://router.example/v1",
  "accountLabel": "Lavoro",
  "requestId": "wizard-unique-id"
}
```

Il campo opzionale `secret` viene trasmesso nel corpo della richiesta HTTPS e
salvato cifrato. Il webview VS Code può richiederlo tramite l'extension host,
senza leggerne il valore nel DOM. Non va inserito nell'URL.

In caso di credenziale errata la risposta conserva `provider.id` e `account.id`:
il form può inviare una nuova chiave con lo stesso `accountId`. Un errore del
provider non diventa un errore di autenticazione della sessione del portale.
Cambiare l'endpoint richiede una nuova operazione, così gli account già collegati
non vengono spostati silenziosamente su un altro server.

`requestId` è limitato all'utente. Due richieste simultanee identiche condividono
la verifica; una ricevuta persistente permette di ritentare dopo un'interruzione
senza duplicare provider e account. Sono mantenute al massimo 200 ricevute per
utente. La ricevuta non contiene credenziali.

## Stati osservabili

| Stato | Significato |
|---|---|
| `ready` | Il catalogo HTTP è stato letto oppure la sessione del runtime nativo è stata confermata. Non equivale a un test di generazione. |
| `standby` | Esistono modelli e una ricetta di attivazione configurati; la readiness del motore non è stata osservata. |
| `login-required` | La CLI è disponibile ma l'accesso non è stato confermato. |
| `setup-required` | La CLI manca dal processo del servizio o non conferma il protocollo richiesto. |
| `unverified` | Gli ID sono stati dichiarati dall'operatore; il catalogo o l'inferenza non sono stati verificati. |
| `unavailable` | Verifica fallita, quota osservata esaurita o account CLI attualmente occupato. |

Un rifiuto HTTP 401/403 non viene trasformato in standby né superato inserendo
manualmente un ID modello. I 429 conservano il cooldown. Se una CLI è occupata da
un task dell'harness, la verifica lo indica subito e conserva lo stato valido
dell'account, anziché attendere in coda per l'intera durata del task.

Per gli endpoint senza `/models`, `modelIds` consente una dichiarazione esplicita.
Le nuove route vengono marcate con provenienza `operator` e sola capacità chat;
non vengono inventati tool calling o dimensione della finestra di contesto.
Una discovery generica che restituisce solo ID mantiene le capacità sconosciute,
salvo una dichiarazione esplicita precedente dell'operatore, che conserva la
propria provenienza `operator`. Una discovery completa riuscita disabilita le
route non più presenti, preservando gli ID per la cronologia; un errore di
discovery non equivale alla rimozione dei modelli. Il riavvio non riabilita una
route marcata assente dal catalogo.

Ollama integra il catalogo `/api/tags` con la lettura dei metadati `/api/show`:
massimo 20 modelli, quattro richieste in parallelo e un secondo per richiesta.
Questo rileva il supporto agli strumenti di un modello Qwen quando Ollama lo
pubblica, senza generare testo, scaricare o attivare modelli. Una sonda fallita o
scaduta conserva il catalogo con metadati sconosciuti; l'annullamento del chiamante
interrompe invece l'intera operazione. La ricerca rapida dei server evita queste
sonde aggiuntive.

Il `context_length` del modello non è una misura dell'allocazione corrente.
L'adapter usa un `num_ctx` positivo esplicitamente riportato nei parametri del
modello, limitandolo al massimo architetturale quando presente; altrimenti lascia
il contesto sconosciuto. Il supporto alle capacità e la dimensione del contesto
non vengono indovinati dal nome del modello.

## Risorse distribuite

Riutilizzare un provider configurato mantiene nodi, gruppi di risorse e lifecycle
originari quando i campi sono omessi. Su un provider creato dalla UI, il suo
proprietario operator/admin può modificare esplicitamente nodi e gruppi mentre
il provider è inattivo; un array vuoto esplicito rimuove quell'associazione.
Il wizard omette i campi nascosti o non modificati. Provider e vincoli ereditati
dai modelli sono aggiornati insieme, preservando gli override espliciti.

Un provider definito nel file rifiuta differenze con `409 CONFIGURED_PROVIDER`:
occorre modificare la configurazione operativa. Lease attivi, richieste in coda
e run che referenziano il provider impediscono variazioni con `409 TOPOLOGY_BUSY`,
anche se l'attività passa dalla facade API e non ha una conversazione associata.
Questi controlli precedono le modifiche ad account e credenziali.

Per nuovi endpoint Ollama/LM Studio, un'associazione univoca a un host o a un
indirizzo di collegamento già configurato consente di ereditare il nodo e i suoi
gruppi. Il loopback indica il coordinator del servizio, non il PC da cui è aperto
il browser. Se l'associazione è ambigua o assente, il risultato lo segnala e
richiede la selezione operativa del nodo. Nessuna associazione hardware viene
dedotta automaticamente per GemRouter o per proxy API generici.

La ricerca locale non esplora sottoreti. Controlla soltanto
`127.0.0.1:11434`, `127.0.0.1:1234/v1` e fino a dieci endpoint HTTP già visibili
nella configurazione. Le richieste sono limitate a quattro in parallelo e a
1,5 secondi ciascuna. Non crea account e non avvia, spegne o carica modelli.

## Codex

Il preset usa la CLI ufficiale installata sul coordinator. Ogni account conserva
un `CODEX_HOME` privato, distinto, con permessi 0700. Il login usa il device flow
di app-server. L'URL e il codice vivono in memoria e sono accessibili solo al
proprietario mentre il login è in corso. Discovery, login e turni confermano la
directory e il deposito credenziali effettivi di app-server. Le finestre di quota
conservano ID del bucket, durata e fonte. I campi di identità osservati dal
runtime non identificano il dominio di fatturazione condiviso tra profili.

Il collegamento verifica prima la disponibilità dell'eseguibile nel processo del
servizio. Una CLI installata nel terminale interattivo ma assente dal PATH di
systemd può quindi richiedere un percorso esplicito nella configurazione operatore.
La UI non può impostare comandi, argomenti o variabili d'ambiente arbitrari.

## Antigravity

Il coordinator verifica il protocollo ACP del runtime ufficiale. Esegue `initialize` e
`session/new` in una directory temporanea vuota, senza inviare un prompt e senza
concedere capacità di filesystem, terminale o tool. Legge soltanto le scelte di
modello effettivamente pubblicate in `configOptions` oppure nel selettore ACP
precedente.

Se il runtime conferma una sessione ma non espone il selettore, viene mostrata la
scelta esplicita **Modello corrente della CLI Antigravity**. L'ID `current` è una
selezione supportata dall'adapter e non il nome inventato di un modello remoto.
Non vengono assegnate finestre di contesto o quote non riportate dal runtime.

Ogni nuovo account ha una directory privata. La CLI usa gli argomenti ufficiali
`--gemini-dir` e `--app-data-dir` con directory XDG private e senza riusare
la sessione keyring del servizio. L'account già associato al profilo storico
mantiene il suo collegamento. **Accedi con Google** avvia la CLI con i parametri del profilo scelto. Apri il collegamento ufficiale, completa il consenso e incolla il codice o l’URL di ritorno nel campo riservato della Control Room. Il coordinator consegna il valore al processo in attesa e richiede una nuova sessione ACP per rilevare i modelli. La guida conserva anche il comando di accesso da terminale.

L'indicazione `ready` richiede una sessione ACP confermata. Le quote Antigravity
restano sconosciute. I profili sono destinati a operatori fidati. Configura i
permessi del runtime ufficiale per i ruoli abilitati. Per accesso via chiave,
usa il preset Gemini API.

Riferimenti ufficiali verificati il 17 novembre 2026:

- [Antigravity CLI ACP](https://antigravity.google/docs/cli/acp)
- [Configurazione, autenticazione e selettori ACP](https://antigravity.google/docs/ide/extensions/acp)
- [Inizializzazione ACP v1](https://agentclientprotocol.com/protocol/v1/initialization)
- [Ollama: metadati e catalogo modelli](https://github.com/ollama/ollama/blob/main/docs/api.md#show-model-information)

## Verifiche e handoff operativo

`tests/connections.test.ts` esercita server HTTP e processi RPC locali reali:
collegamento unico, doppio clic, recupero della credenziale, catalogo mancante,
quote, separazione degli utenti, conservazione dei gruppi, standby, associazione
locale, autenticazione ACP, eseguibile assente, profili Codex isolati e runtime
occupato. La suite verifica anche i metadati Ollama, il limite di concorrenza,
il timeout e l'annullamento propagato dal chiamante. `tests/adapters-native.test.ts`
verifica il device flow Codex e le approvazioni native con fixture di protocollo.
`tests/vscode-host.test.ts` verifica che la chiave raccolta per
`POST /api/connections` raggiunga il gateway senza comparire nel webview. Le
fixture non sono accessi a servizi commerciali reali.

Sul cluster occorre collaudare il PATH del servizio, il device login con ciascun
account Codex, il login Antigravity con l'utente del coordinator, i modelli
effettivamente pubblicati dalle versioni installate e gli endpoint locali da
ogni nodo coinvolto. Per Antigravity va verificato anche il comportamento dei
permessi configurati nel runtime ufficiale.

Per il collaudo multiaccount Antigravity, autenticare due profili in momenti
distinti. Verificare che il secondo richieda accesso finché il suo login resta
incompleto, quindi inviare un prompt innocuo da ciascun account e controllare
i modelli disponibili nelle rispettive sessioni.
