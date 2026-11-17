# Rapporto di verifica della release 0.3

## Esito dei controlli locali

**`npm run check` è terminato con exit code 0: 125 test passati, nessun test
fallito o saltato, controllo TypeScript strict e build completati.** Sono passati
anche lo smoke test dei bundle isolati e il packaging VSIX.

Il risultato riguarda codice e ambienti locali di prova. Non certifica una
distribuzione su `yed1z.ai`, l'inferenza sulle macchine dell'utente o il login
ai suoi account reali.

```bash
npm run check
npm run smoke
npm run package:vsix
```

`check` esegue `typecheck`, `test` e `build` in sequenza. Il progetto richiede
Node `>=24.15.0 <25`. La build genera `dist/server.mjs`, `dist/cli.mjs`,
`dist/runner.mjs`, asset web condivisi e `vscode/dist/extension.cjs`.

| Area | Test passati | File della suite |
| --- | ---: | --- |
| Adapter HTTP, lifecycle e runtime native | 29 | `adapters-http.test.ts`, `adapters-lifecycle.test.ts`, `adapters-native.test.ts` |
| Migrazione della cronologia 0.2 | 8 | `migration.test.ts` |
| Executor, workspace, runner e rilascio | 19 | `execution.test.ts` |
| VS Code: trasporto e host | 11 | `vscode-client.test.ts`, `vscode-host.test.ts` |
| Control plane e missioni | 20 | `control-plane.test.ts` |
| Controlli del singolo task | 7 | `task-control.test.ts` |
| Facade, quote e catalogo | 5 | `facade.test.ts` |
| UI, bridge e percorsi HTTP del portale | 26 | `web.acceptance.test.ts`, `web.http.test.ts` |
| **Totale** | **125** | [`tests/`](../tests/) |

Smoke test e packaging sono verifiche aggiuntive, non test contati nuovamente
nelle 125 unità della tabella.

## Verifiche con HTTP, processi e SQLite reali

### Server, autenticazione e inferenza

Il server del prodotto viene avviato su porte locali. Le richieste HTTP
verificano login, cookie, Bearer, origine delle mutazioni, proprietà degli
oggetti, ruoli, file statici e SSE. La membership di progetto non espone
conversazioni/eventi privati; viewer/member sono esclusi dai percorsi esecutivi
riservati. Credenziali in URL e segreti nei payload della webview sono rifiutati.

Upstream HTTP di prova ricevono realmente le richieste degli adapter e
restituiscono stream, misure ed errori controllati. I test controllano parsing,
formato richieste, cancellazione, quote/uso osservati, dati mancanti e gestione
di `429`/`Retry-After`. Gli errori di discovery del provider non vengono confusi
con la perdita della sessione yed1z.

La facade inoltra un giro completo di function tools: definizione, chiamata
assistant e risultato `tool`, senza eseguire la funzione sul coordinator. Due
account dello stesso modello non sono scelti implicitamente quando il nome è
ambiguo. Lo switch esplicito dopo una quota esaurita conserva la conversazione.

### Stato persistente, memoria e migrazione

I database SQLite temporanei vengono scritti e riaperti. Sono verificati
recupero dei run interrotti, scadenza delle approvazioni e assenza di replay
dei side effect. Il lock rifiuta un secondo coordinator sullo stesso stato.
I test verificano hashing delle chiavi, cifratura dei segreti, ACL e integrità
degli allegati e deduplicazione senza cancellare i dati di altri utenti.

Memorie candidate, approvate e condivise sono create e interrogate realmente.
La ricerca lessicale/vettoriale mantiene le ACL; dimenticare una memoria
rimuove testo, revisioni e vettori. Un endpoint HTTP controllato produce
embeddings usati dal percorso reale di indicizzazione, condividendo le risorse
di inferenza. Il compilatore del contesto mantiene la richiesta corrente e
documenta esclusioni e stime, senza attribuire autorità ai documenti recuperati.

La migrazione legge un database 0.2 in sola lettura, anche con dati committati
nel WAL. Verifica selezione del proprietario, idempotenza, provenienza,
conservazione di testo/date/metriche ed esclusione di segreti/sessioni native.
Record invalidi non autorizzano importazioni di altri utenti. Sorgenti mutate
non sovrascrivono silenziosamente conversazioni già importate.

### Executor e ciclo di consegna

L'executor crea/modifica file temporanei, controlla hash prima della scrittura
e rifiuta traversal, symlink, hardlink e ricette vietate. `prepare` crea una
sottodirectory sotto una radice autorizzata esistente; non crea una radice
operatore mancante. Le lease serializzano workspace uguali o sovrapposti e
rilasciano le attese annullate.

Le ricette avviano processi Node reali con argv distinti, senza valutazione da
shell. Sono verificati exit code falliti, timeout, cancellazione, environment
filtrato e blocco di deploy/rollback/ricette controller dal tool generico.
Un processo runner separato legge stdin, usa la configurazione del nodo e
correla le approvazioni. Sono verificati costruzione e quoting del comando SSH,
alias, controllo host key e opzioni non interattive; non è una sessione SSH
aperta sul cluster dell'utente.

Le missioni end-to-end usano un modello HTTP di prova con piano, tool calls e
review controllati. Il prodotto scrive realmente file, esegue un test, attende
il grant e avvia una ricetta di deploy. Un server HTTP locale fornisce l'health
check. Il caso negativo esegue il rollback configurato e conserva lo stato
fallito. Una review linguistica positiva non può superare un test fallito.

Questi test provano transizioni e confini con effetti osservabili. Non misurano
la capacità di un LLM commerciale di completare qualunque progetto senza
interventi.

### Squadra, UI ed estensione

I test per task verificano pausa selettiva, prosecuzione del ricercatore
indipendente, attesa del coder dipendente, cambio route solo in coda/pausa e
ripresa senza azzerare il budget. Annullare un task non crea un sostituto
automatico. L'incertezza remote/native prevale sulla pausa; la cancellazione
globale libera attese, lease e risorse.

La UI è eseguita in un DOM di prova: selettore modello/account, cronologia,
steer durante una missione, allegati, approvazione memorie, controlli task,
evidenze di rilascio, eventi e Markdown inerte. Due percorsi UI attraversano
il vero server HTTP/SSE/SQLite: login e progetto; connessione GemRouter con
discovery da un upstream locale.

I test VS Code caricano il bundle host con API `vscode` simulate e usano server
HTTP reali per il trasporto. Verificano SecretStorage, Trust, correlazione e
cancellazione, selezioni, prompt nativo della chiave e salvataggio solo nella
destinazione del dialogo. Non equivalgono all'uso in una finestra VS Code reale.

## Verifica dei bundle e del pacchetto VSIX

**`npm run smoke`: PASS.** [`scripts/smoke.ts`](../scripts/smoke.ts) copia
esclusivamente `dist` in una directory temporanea, senza sorgenti o
`node_modules`, e avvia gli entry point attraverso un symlink di release.
Sono stati verificati:

- setup con CLI compilata e nuova chiave;
- secondo `init` che preserva chiave e dati;
- avvio del server compilato, pagina HTTP, header CSP e asset JavaScript;
- health pubblico, `401` anonimo e login cookie valido;
- creazione di un progetto attraverso API con directory workspace reale;
- arresto `SIGTERM` completato con exit code 0.

Lo smoke non carica moduli sorgente o provider esterni e non usa lo stato
dell'utente. Verifica il bundle distribuibile; non sostituisce il collaudo
dell'archivio finale dopo estrazione.

**`npm run package:vsix`: PASS.** Packaging con `vsce 4.1.0`:

| Campo | Esito |
| --- | --- |
| Artefatto | `artifacts/yed1z-control-room-0.3.0.vsix` |
| Identità estensione | `funboy.haloforge` |
| Versione | `0.3.0` |
| Contenuto dichiarato dal packager | 11 file |
| Dimensione dichiarata dal packager | 56,39 KB |

Sul VSIX sono stati verificati anche integrità ZIP/CRC, identità, versione e
uguaglianza byte per byte dei quattro asset web e di `extension.cjs` con i file
compilati. L'installazione e il collaudo visuale in VS Code non sono stati
eseguiti.

Per l'integrità dei file della consegna fare riferimento a `SHA256SUMS.txt`
esterno all'archivio e al bundle Git fornito. Questo documento non duplica hash
che dipendono dal confezionamento finale.

## Verifiche non eseguite e limiti

| Ambito | Limite |
| --- | --- |
| Cluster Strix e CUDA | Nessuna connessione operativa alle macchine dell'utente, inferenza GPU o model switching reale. Indirizzi, porte, alias e privilegi richiedono inventario live. |
| API e quote commerciali | Nessun consumo di account reali; quote e rate limit sono risposte di prova, non saldi di abbonamenti. |
| OAuth e runtime installati | Protocolli native verificati con processi fixture, senza login live né collaudo dei profili personali Codex/Antigravity. |
| Produzione | Nessun deploy su `yed1z.ai`, modifica dei tunnel, spegnimento di servizi esistenti o rollback dell'applicazione reale. |
| Resa grafica | Chromium non ha completato l'avvio nell'ambiente: `socket() failed: Operation not permitted`. Nessun collaudo visuale in browser reale o VS Code e nessuna schermata di validazione. |
| Prestazioni e qualità | Nessun benchmark prolungato di carico, precisione RAG, qualità dei modelli, tokenizer specifici o risparmio economico dimostrato. |
| Isolamento OS e disponibilità | ACL applicative non equivalgono a isolamento di processi dello stesso UID, segregazione automatica di tenant o failover del coordinator. |

Il fallimento dell'avvio Chromium è un limite dell'ambiente di verifica: non
prova né correttezza né errore del layout. Prima di dichiarare parità con Codex
o Copilot occorre provare rendering, interazioni e ridimensionamento in browser
e webview reali. Vedere [`UX.md`](UX.md).

Il collaudo sulla rete effettiva e il passaggio in produzione restano distinti
dalla consegna del codice. Capacità, limiti residui e criteri per l'evoluzione
sono descritti in [`GAP_AUDIT.md`](GAP_AUDIT.md).
