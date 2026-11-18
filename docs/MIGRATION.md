# Migrazione e aggiornamento a yed1z Control Room 0.4

## Aggiornamento dalla tua 0.3 modificata

La release 0.4 parte dall'archivio `StrixHaloCluGateway-feature-distributed-control-room.zip`
fornito dall'utente. Mantiene lo schema di stato della 0.3: i nuovi campi JSON
sono opzionali e le identità di progetti, conversazioni e route restano valide.
Non usare l'importatore 0.2 per questo aggiornamento e non rigenerare lo stato.

La procedura di backup, prova su copia, aggiornamento del servizio e rollback è
in [`../HANDOFF.md`](../HANDOFF.md). Conservare insieme SQLite/WAL, `master.key`,
allegati e directory account native; il solo database non basta a recuperare le
credenziali. Ferma il coordinator prima del backup completo e del cutover. Non
avviare due coordinator contro lo stesso stato o contro gli stessi engine
commutabili. La copia di prova non deve avere accesso al lifecycle di produzione.

`publicDashboard` è `true` per preservare la dashboard ospite che hai aggiunto.
La vista pubblica 0.4 filtra dati privati e connessioni cloud/native. Se il monitor
deve essere privato, imposta `publicDashboard:false` prima di esporlo al dominio.
Il VSIX 0.4 mantiene l'ID `funboy.haloforge` e richiede il coordinator 0.4.

I provider dichiarati nel file sono riconciliati all'avvio: non sostituire la tua
configurazione con il template. Nel template aggiornato Qwen Strix usa solo il
nodo 01, come indicato nel sorgente legacy allegato; verifica il tuo script
`cluster-model` e la distribuzione attuale prima di applicare questa modifica.

## Migrazione storica dalla 0.2 / gateway Python

La 0.3 è un nuovo piano di controllo TypeScript con uno schema dati nuovo. Web,
VS Code e API usano lo stesso coordinator. I processi degli engine restano sulle
macchine che possiedono le risorse GPU; il runner di esecuzione e telemetria è
avviato su richiesta, anche tramite SSH.

Non sostituire alla cieca il file `gateway.py` con un altro entry point. Preparare
la nuova installazione in una directory distinta e conservare il vecchio stato
fino alla verifica del passaggio operativo.

## Che cosa si migra automaticamente

Il comando `import` legge il database **yed1z Unified / Portal 0.2**:
`portal.sqlite3`, tabella `conversations(id, owner, updated_at, active_turn, body)`.

| Dato | Trattamento |
|---|---|
| Titolo e testo visibile dei messaggi | Copiati nel progetto e nell'utente di destinazione selezionati. |
| Date di creazione e aggiornamento | Preservate quando valide. |
| Token e misure della singola risposta | Preservati come dati `legacy-reported`, compresi gli zero autentici. |
| Risposte parziali/interrotte | Conservate con stato errore; nessuna ripresa automatica. |
| Vecchi messaggi system/tool | Conservati come riferimenti testuali esplicitamente etichettati, senza autorità di istruzione o esecuzione. |
| Etichette di modello/account | Conservate come metadati storici del messaggio, senza ricreare credenziali. |
| Provider, API key, cookie e credenziali OAuth | Non importati. |
| Sessioni native, firme/metadati di protocollo, reasoning privato | Non importati. |
| Vecchi ID di route/workspace e turni attivi | Non collegati automaticamente ai nuovi target. |
| Log aggregati esterni alla conversazione | Non trasformati in nuove misure o task. |

Il nuovo modello della conversazione è testuale. Allegati binari, cache KV,
sessioni interne delle CLI e stato di esecuzione non sono trasferibili come una
semplice cronologia. L'importatore non apre percorsi o URL contenuti nei messaggi.

Gli export JSON originari HaloForge/HaloClu/Kirei non sono letti direttamente da
questo comando. Se erano già stati importati nella 0.2, fanno parte del suo
database e vengono trasferiti. Il vecchio esportatore Kirei non includeva tutti
i `seed_messages` delle diramazioni: dati assenti dalla sorgente non possono
essere ricostruiti durante la migrazione.

## Preparazione dello stato

1. Conservare un backup coerente del vecchio stato. Per SQLite con WAL, usare il
   backup SQLite oppure copiare l'intera directory a gateway fermo. La sola copia
   del file principale mentre il vecchio processo scrive può perdere dati ancora
   presenti nel WAL.
2. Installare la 0.3 in una directory nuova, con Node 24 nella versione supportata
   dal manifest. Se il pacchetto include `dist/`, non occorre compilare prima
   dell'avvio. Per lavorare sui sorgenti usare `npm ci` e `npm run build`.
3. Eseguire l'inizializzazione con una directory di stato nuova:

   ```bash
   node dist/cli.mjs init --name funboy --state ./state
   ```

4. Configurare il progetto di destinazione e i suoi accessi. Gli ID `usr_...` e
   `prj_...` sono restituiti dall'API autenticata `/api/bootstrap`; l'ID utente è
   stampato anche alla creazione. L'importazione richiede entrambi esplicitamente.
5. Fermare il nuovo coordinator prima di usare la CLI sul suo stato. Il lock
   impedisce a un'altra istanza di modificare la stessa directory durante il lavoro.

Il vecchio database viene aperto con `readOnly:true`, `query_only=ON` e senza
estensioni, sotto una transazione di lettura coerente. La sorgente non viene
modificata né checkpointata. La migrazione scrive soltanto nel nuovo stato.

## Selezione esplicita dell'utente precedente

Il campo `owner` della 0.2 è un identificatore di 32 caratteri esadecimali, non
necessariamente il nome mostrato nell'interfaccia. Per un utente con etichetta
configurata, la 0.2 usava i primi 32 caratteri di
`SHA256("named:" + etichetta)`.

`--legacy-user funboy` applica la stessa regola. Si può passare direttamente
l'identificatore esadecimale quando lo si conosce. Il risultato riporta
`resolvedOwner`, così la selezione è verificabile. Per un vecchio utente senza
etichetta bisogna usare il suo ID effettivo: il migratore non legge né ricava la
vecchia chiave API.

```bash
node dist/cli.mjs import \
  --state ./state \
  --database /percorso/backup/portal.sqlite3 \
  --legacy-user funboy \
  --user usr_ID_DESTINAZIONE \
  --project prj_ID_DESTINAZIONE
```

I segnaposto `usr_ID_DESTINAZIONE` e `prj_ID_DESTINAZIONE` vanno sostituiti con gli
ID reali. La selezione della sorgente è `WHERE owner = ?`: non vengono importate
automaticamente le conversazioni degli altri utenti. Anche l'accesso dell'utente
di destinazione al progetto viene verificato.

L'output contiene `imported`, `skipped`, `warnings` e `resolvedOwner`. Nessun
risultato per il selettore scelto produce un avviso e zero importazioni, non un
ripiego sull'intero database.

## Ripetibilità e conservazione dei dati

Gli ID importati dipendono da identità legacy, ID conversazione, proprietario e
progetto di destinazione. Non dipendono dal nome o dal percorso del backup. Una
ricevuta viene salvata nella stessa transazione della conversazione.

- Ripetere il comando sullo stesso snapshot non duplica i thread.
- Spostare o rinominare il backup non duplica i thread.
- Le modifiche fatte nella nuova conversazione non vengono sovrascritte.
- Una conversazione già importata e poi eliminata non viene ricreata dal comando.
- Una sorgente cambiata dopo l'importazione produce un avviso: non viene fusa
  automaticamente con il lavoro più recente nella destinazione.
- I record malformati, vuoti o oltre i limiti vengono saltati con conteggi
  espliciti. La sorgente rimane disponibile per una gestione mirata.

La lettura ammette fino a 512 conversazioni per proprietario, 4096 messaggi per
conversazione, record da 12 MiB e messaggi testuali da 4 MiB. Il comando non tronca
silenziosamente un record e non considera l'importazione un test di inferenza.

## Mappare l'infrastruttura senza perdere la distribuzione

Ricreare le connessioni nel nuovo registro mantenendo separati:

1. i nodi fisici Strix 01, Strix 02 e `aireward-llm`;
2. gli endpoint di inferenza e i relativi account;
3. i gruppi di memoria/GPU condivisi;
4. i target di esecuzione dei progetti;
5. le ricette di attivazione, verifica e rilascio.

Il modello distribuito sui due Strix deve prenotare entrambi i gruppi interessati.
La 3090 può procedere indipendentemente se non condivide risorse. GemRouter va
configurato come un altro provider di inferenza, senza spostare nel coordinator
la sua logica interna di quote.

Le porte ricavate dal gateway originale sono 18231/18562 per gli engine Strix e
8080/8085 per gli engine CUDA su `192.168.178.47`. Sono riferimenti da verificare
sull'installazione, non risultati di un controllo live. Gli indirizzi LAN storici
degli Strix contengono discrepanze: utilizzare alias verificati, senza assumere
un'associazione `.67`/`.77`.

Installare il bundle runner sui target che devono fornire esecuzione o telemetria
verificata, con identità SSH e configurazione locale appropriate. Non serve una
nuova porta pubblica. Gli engine e l'eventuale controller GPU già necessario al
caricamento dei modelli restano componenti dell'infrastruttura.

Per un team non fidato non usare lo stesso UID del coordinator per eseguire codice
generato: scegliere utenti Unix/container separati, senza accesso allo stato e
alle credenziali del coordinator. Le verifiche sui percorsi dei tool non sono
un sandbox di sistema operativo. I dettagli sono in `EXECUTION.md`.

## Passaggio del servizio e confine API

Provare inizialmente la 0.3 su un indirizzo/porta distinto e una directory di stato
distinta. Verificare almeno accesso dei diversi utenti, importazione, cambio
modello/account, telemetria per nodo, task remoti, approvazioni e un rilascio di
prova con health check e rollback su un ambiente non produttivo.

Per il passaggio finale:

1. Drenare chat e task del vecchio gateway, conservare il backup finale e le
   configurazioni del servizio/tunnel.
2. Individuare il processo che possiede realmente la porta di ingresso. Nel vecchio
   gateway 8081 e 18561 erano due listener dello stesso processo: non sono da soli
   prova di servizi duplicati.
3. Trasferire l'ingresso al nuovo coordinator e verificare web, VS Code e client API.
   Configurare l'origine pubblica e i cookie sicuri per il dominio HTTPS.
4. Lasciare un solo proprietario delle commutazioni engine. Il vecchio gateway e
   uno script esterno non devono continuare a spegnere modelli durante task della
   nuova installazione.
5. Dismettere un vecchio frontend soltanto dopo aver verificato che nessun client,
   job o API dipenda ancora da quel servizio. Non eliminare engine, node agent o
   tunnel soltanto perché espongono una porta.

La nuova UI e il VSIX 0.3 usano `/api/...`; la precedente estensione 0.2 usava un
contratto diverso e va aggiornata insieme al coordinator. Gli ID modello della
facade `/v1/models` rappresentano route modello/account: aggiornare i client per
selezionare la route corretta e verificare i parametri supportati in `API.md`.
Il nuovo servizio non presume che chiavi, cookie o ID del vecchio gateway siano
validi anche nella nuova installazione.

## Rollback operativo

Conservare la directory del vecchio codice, il suo stato e la configurazione
dell'ingresso. Se il passaggio non supera le verifiche, drenare e fermare il nuovo
coordinator e ripristinare l'ingresso precedente. Non far puntare il vecchio
processo Python al database `control.sqlite` della 0.3.

Le nuove conversazioni create dopo il passaggio appartengono al nuovo schema:
il rollback dell'ingresso non effettua una migrazione inversa. Conservare quindi
anche il nuovo stato. Un backup completo della 0.3 comprende database, master key,
account, allegati e configurazione; il comando `backup` della CLI copia il
database, mentre gli altri elementi devono essere conservati separatamente.

La consegna non ha fermato servizi, modificato tunnel o eseguito questo passaggio
su `yed1z.ai`. L'inventario live e la verifica sul cluster restano operazioni
necessarie prima della dismissione delle vecchie istanze.
