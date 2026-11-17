# Verifica della release 0.4.0

**17 novembre 2026 · Node 24.22.1 · Linux.**

## Esito conclusivo

| Gate eseguito | Esito |
|---|---|
| `npm run check` | **PASS**: TypeScript strict, **205/205 test**, build di server, CLI, runner, web e VSCode. |
| `npm run smoke` | **PASS**: avvio dei soli bundle in directory isolata senza sorgenti o dipendenze npm. |
| `npm run package:vsix` | **PASS**: VSIX 0.4.0 creato, identità `funboy.haloforge` conservata. |
| Documentazione | Esempi JSON leggibili, blocchi di codice bilanciati, link locali risolti. |
| Rendering browser/VSCode | **DA ESEGUIRE** nell'installazione reale: browser non disponibile per il collaudo grafico in questo ambiente. |
| Cluster, account e produzione | **DA ESEGUIRE**: nessun accesso ai nodi o ai provider commerciali dell'utente in questa sessione. |

La suite completa registra **205 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**.
La durata riportata dal test runner locale è circa 9,86 secondi; è il tempo delle
fixture, non una misura di velocità dei modelli. I log finali completi sono in
[VALIDATION.txt](VALIDATION.txt). Smoke e packaging non sono conteggiati come
altri test. I sottoinsiemi eseguiti durante lo sviluppo non sono sommati di nuovo.

## Copertura della suite completa

| Area | Test passati | Suite |
|---|---:|---|
| Adapter HTTP, lifecycle e CLI native | 29 | `adapters-http`, `adapters-lifecycle`, `adapters-native` |
| Collegamenti guidati, credenziali e topologia | 24 | `connections` |
| Scheduler, selezione, carico engine e policy di routing | 31 | `routing`, `inference-load`, `request-policy` |
| Auto, latenza, continuità, interruzioni e guest SSE | 11 | `interaction` |
| Server, autorizzazione e missioni | 20 | `control-plane` |
| Controlli del singolo agente | 7 | `task-control` |
| Workspace, esecuzione, runner e rilascio | 19 | `execution` |
| Migrazione dello storico | 8 | `migration` |
| Facade API, quote e riconciliazione catalogo | 6 | `facade` |
| Client/host VSCode | 12 | `vscode-client`, `vscode-host` |
| UX DOM e interfaccia attraverso HTTP/SSE/SQLite | 38 | `web.acceptance`, `web.http` |
| **Totale** | **205** | `tests/*.test.ts` |

Il conteggio dei controlli del singolo agente comprende i casi generati dalla
suite. Il risultato è quello osservato dal test runner, non il semplice numero
di dichiarazioni `test()` nei sorgenti.

## Regressioni materiali verificate

**Domande semplici.** `come stai?` senza modelli e senza target restituisce un run
di servizio completato, zero task e zero chiamate di inferenza. Il test richiede
la risposta HTTP locale entro 1,5 secondi. Durante una missione il saluto e la
richiesta di stato non la mettono in pausa. Una domanda esplicativa in Auto usa
una completion e non esegue planner, strumenti o verifiche. Una coda del modello
embedding termina entro il budget breve della chat e conserva il contesto FTS.

**Routing.** I test prenotano gruppi condivisi e verificano alternativa consentita,
modello pinned con scadenza, cancellazione, limiti account e priorità. Il router
ricontrolla autorizzazione, quota e topologia dopo l'attesa. Server HTTP di prova
coprono zero contro ignoto, letture malformate/scadute, saturazione sulle risorse
condivise e i limiti di quattro probe contemporanei e uno per provider.

**Carico dopo la propria inferenza.** Una lettura iniziata durante la propria
richiesta non blocca il giro successivo come presunto lavoro esterno persistente:
dopo il rilascio serve una nuova osservazione. Una vecchia risposta HTTP arrivata
tardi non supera la barriera. Attività esterna ancora presente rimane bloccante;
un errore non viene convertito in zero richieste.

**Nessun replay degli effetti.** Un comando reale appende una riga a un file e il
provider fallisce nella completion successiva. Con tre cicli di riparazione
disponibili, il file contiene comunque una sola riga: nessuna ripetizione o
rotazione provider. Anche l'output parziale di una chat in errore resta salvato,
senza una seconda completion. Questo non promette exactly-once per qualsiasi
programma esterno non idempotente.

**Catalogo.** Una discovery riuscita A→B disabilita A, mantiene il suo ID e impedisce
che il seed al riavvio lo riabiliti. Il ritorno di A riusa lo stesso ID. Un errore
temporaneo non equivale alla rimozione. Le dichiarazioni esplicite dell'operatore
restano distinguibili dai metadati del provider.

**Connessioni.** Il wizard usa API reali di provider/account/discovery nelle fixture,
comprese credenziali rifiutate, retry e richieste simultanee. L'errore upstream
non disconnette yed1z. Le modifiche hardware richiedono proprietà/ruolo, sono
atomiche e vengono bloccate da lease, code e run pertinenti, anche da API senza
run. Il provider da file non viene sovrascritto. I campi nascosti/non modificati
sono omessi e le risposte tardive non alterano un dialog chiuso.

**Utenti e guest.** Il guest non riceve progetti, chat, chiavi, endpoint, indirizzi
o identità account. Nove stream anonimi non condividono il limite di otto di un
account autenticato. Gli snapshot pubblici e privati hanno superfici distinte;
i semafori interni degli account non compaiono negli ID delle risorse pubblicate.

**Bundle.** Lo smoke copia solo `dist/` in una directory isolata e avvia CLI/server
attraverso un symlink. Verifica setup iniziale e ripetuto, asset/CSP, monitor
ospite, rifiuto delle mutazioni anonime, login, workspace reale e arresto pulito.
Non importa moduli dai sorgenti e non usa il `node_modules` del repo.

**VSCode.** I test dell'host coprono trasporto, SecretStorage, Workspace Trust e
raccolta dei segreti per `/api/connections`: il valore non è restituito al
webview. Il pacchetto usa lo stesso bundle web del portale; il confronto dei
file distribuiti è registrato nel log di validazione.

## Limiti del risultato

- La resa grafica non è stata osservata in un browser funzionante. Chromium
  termina con `socket() failed: Operation not permitted`; la preview locale del
  browser cloud è stata negata dalla policy. Nessun workaround o screenshot
  sostitutivo è presentato come collaudo.
- Le 38 verifiche UI controllano DOM, interazioni, bridge e flussi HTTP. Non
  dimostrano leggibilità, allineamenti, fluidità o funzionamento dell'app VSCode
  reale su ogni viewport.
- I provider HTTP/CLI dei test sono fixture controllate. Login commerciali,
  capacità dei modelli reali, quote, throughput, switching e sensori devono essere
  provati sui sistemi dell'utente.
- Un probe non impedisce a un client esterno di iniziare lavoro subito dopo il
  campione. Per escludere conflitti serve un unico controller delle risorse.
- Nessun servizio pubblicato, gateway eliminato, account ruotato o tunnel
  modificato. Il piano di collaudo operativo è in [HANDOFF.md](../HANDOFF.md).
