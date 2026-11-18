# Esecuzione distribuita e client VS Code

## Inferenza ed esecuzione sono risorse distinte

Un modello su uno Strix può scrivere e verificare codice su un workspace della
macchina CUDA, e un modello fornito da GemRouter può operare su un workspace del
coordinator. Il provider scelto non determina la macchina su cui vengono eseguiti
i tool. Il progetto seleziona un `targetId` e un `workspace` relativo; il target è
configurato dall'operatore. Il browser non sceglie host SSH, percorsi assoluti,
eseguibili o argomenti di comando.

Il control plane mantiene una **lease di scrittura per l'intera missione**.
Workspace coincidenti o sovrapposti, compresi padre e sottodirectory, condividono
la stessa esclusione. I progetti disgiunti possono procedere in parallelo. I
percorsi locali sono canonicalizzati; due alias SSH dello stesso nodo devono
avere lo stesso `nodeId` nella configurazione. L'orchestratore deve usare questa
lease anche per i backend CLI nativi che possono scrivere.

Le missioni serializzano le scritture nello stesso checkout. Un controllo di
versione esterno e altre sessioni SSH possono comunque modificare i file; i tool
di scrittura rilevano cambiamenti intervenuti rispetto al contenuto letto.

Su un target locale con un checkout Git principale, imposta
`workspaceIsolation: "git-worktree"` nel progetto o nel singolo run per lavorare
in un checkout separato e detached. La base è il commit iniziale di `HEAD`.
Le modifiche non committate del checkout operatore restano lì. Il worktree viene
registrato in `.git/yed1z-worktrees/` e gli sviluppatori dello stesso run lo
usano in serie.

Il run conserva commit candidato, riferimento Git della revisione, file
modificati e allegato con il diff. L'harness verifica il commit candidato prima
di mostrare il digest. L'operatore approva il digest per creare un nuovo branch
`yed1z/<run>-<commit>`. La promozione verifica in una sola transazione che la
base sia ancora quella registrata e che il nuovo riferimento sia libero.
Il checkout e il branch dell'operatore restano disponibili per il lavoro
corrente. Il merge del branch promosso segue le procedure del repository.

Un rilascio del worktree richiede la promozione. A run concluso l'operatore può
chiedere la pulizia del checkout promosso. Git rifiuta la rimozione se trova
modifiche o file aggiuntivi, compresi gli ignorati. Il riferimento del candidato
e il branch promosso preservano la consegna dopo la pulizia.

## Target locali e SSH

L'esecuzione locale usa API filesystem e `spawn` con `shell: false`.
L'esecuzione SSH usa un runner TypeScript compilato, avviato **una sola volta per
operazione**, che comunica con JSON delimitato da newline attraverso stdin/stdout.
Non apre una porta e non richiede un nuovo demone residente. Il solo servizio
di coordinamento rimane il control plane; i motori di inferenza continuano ad
avere il proprio processo necessario a servire i modelli.

SSH usa `BatchMode=yes`, `StrictHostKeyChecking=yes`, un timeout di connessione e
keepalive. La chiave host deve essere già verificata e presente in `known_hosts`
dell'account del servizio. L'identità SSH è quella dell'account di servizio, non
un valore mandato dal modello. `remoteNode`, `remoteRunner`, `remoteConfig` e
l'identificativo del target sono quotati come argomenti del comando remoto.
L'alias SSH è validato e non può contenere opzioni o espressioni di shell.

Esempio **da adattare ai percorsi reali**, per un target sul secondo Strix:

```json
{
  "id": "evo02-exec",
  "nodeId": "strix-02",
  "kind": "ssh",
  "sshHost": "02-evo-x3-tb",
  "workspaceRoot": "/home/funboy/workspaces",
  "remoteNode": "/usr/bin/node",
  "remoteRunner": "/opt/yed1z/dist/runner.mjs",
  "remoteConfig": "/etc/yed1z/node.json",
  "commands": [
    {"id":"test","label":"Test progetto","argv":["npm","test"],"verification":true,"timeoutMs":120000},
    {"id":"build","label":"Build progetto","argv":["npm","run","build"],"verification":true,"timeoutMs":120000}
  ],
  "deployments": []
}
```

Il bundle `dist/runner.mjs` e Node 24 devono essere disponibili sul nodo di
esecuzione. `/etc/yed1z/node.json` contiene `{ "targets": [ ... ] }` con il target
autorizzato, lo stesso ID, workspace e ricette. Il runner carica questa
configurazione sul nodo: il messaggio ricevuto dal control plane non può
sostituirla. Non installare il runner sulle macchine che forniscono soltanto
inferenza se non devono anche eseguire tool.

Il protocollo gestisce richieste di approvazione correlate. Il control plane
mostra la proposta e restituisce soltanto l'esito; il processo remoto attende
prima di procedere. Le risposte scadono dopo cinque minuti. La chiusura del
canale interrompe il runner e il gruppo di processi locale; una connessione
SSH persa può lasciare un esito remoto incerto e non autorizza il replay
automatico di una modifica.

`{kind:"telemetry"}` esegue una lettura locale della telemetria tramite lo stesso
runner. Non richiede approvazioni di scrittura e non avvia un servizio aggiuntivo.

## Tool e policy

I tool disponibili sono:

| Tool | Comportamento |
| --- | --- |
| `list_files` | Elenco limitato a 500 file e profondità limitata; esclude dipendenze, percorsi protetti e symlink. |
| `read_file` | Testo fino a 500 KB, intervallo di righe e SHA-256 del contenuto completo. |
| `search_files` | Ricerca letterale con massimo 100 risultati nella scansione limitata. |
| `write_file` | Contenuto completo proposto, hash obbligatorio per file esistenti, controllo prima e dopo la decisione. |
| `run_command` | Solo `recipeId` configurato; nessuna shell o argv scelti dal modello. |

I ruoli di sola lettura ricevono soltanto i primi tre tool. I percorsi assoluti,
`..`, i symlink, i file di credenziali e la scrittura su hard link vengono
rifiutati. Le sottodirectory `cwd` delle ricette devono rimanere nel workspace
del progetto, non in un altro workspace dello stesso target.

Le ricette citate nei passaggi o nel rollback di un deploy sono escluse dal
catalogo `run_command` e rifiutate anche se il modello ne indovina l'ID. Lo
stesso vale per le ricette con `controllerOnly: true`, per esempio l'attivazione
di un motore. Soltanto i controller interni invocano direttamente queste azioni.

La callback `approve` applica i permessi già concessi alla missione o presenta
una richiesta specifica. Il motore non decide da solo di autorizzarsi. Una
verifica (`kind:"verify"`) esegue soltanto ricette che l'operatore ha marcato
`verification: true`: è l'autorizzazione preventiva a quel controllo configurato,
non una valutazione automatica dell'innocuità di uno script.

L'ambiente dei processi contiene una lista limitata di variabili di sistema:
le chiavi API presenti nell'ambiente del control plane non vengono ereditate.
Output, durata e risposta vengono limitati. L'evidenza registra exit code,
timeout, interruzione, hash dell'output e tempi. Un comando scaduto o interrotto
non può risultare riuscito.

Questi confini **non sono un sandbox del sistema operativo**. Una ricetta
autorizzata, un test del repository o una CLI nativa possono operare con i
permessi dell'account di servizio. Per progetti non fidati occorrono un account
dedicato e isolamento del sistema operativo, per esempio container o VM.
La configurazione del nodo e l'account SSH sono confini operativi essenziali.

## Rilascio: verifiche, approvazione ed evidenza

Il deploy non è un tool disponibile al modello. L'orchestratore richiede un
rilascio tramite una ricetta configurata e il relativo controllo di ruolo.
L'executor esegue nuovamente le verifiche della ricetta e confronta la revisione
del workspace e la ricetta installata sul runner con i digest registrati.
L'autorizzazione conserva attore, digesto, workspace, passaggi, health e rollback.
Se la revisione cambia, la consegna torna alla verifica. Il digest del workspace
copre commit e file di progetto, escludendo credenziali, dipendenze e directory
di build protette dagli strumenti del workspace.

Una ricetta di deploy contiene:

```json
{
  "id": "staging",
  "label": "Pubblica staging",
  "verify": ["test", "build"],
  "steps": ["publish-staging"],
  "health": {
    "url": "https://staging.example.invalid/health",
    "expectedStatus": 200,
    "expectedText": "healthy",
    "attempts": 3,
    "timeoutMs": 5000
  },
  "rollback": ["rollback-staging"]
}
```

I nomi in `steps` e `rollback` devono esistere nelle ricette comando del target.
L'indirizzo sopra è un segnaposto e non viene configurato automaticamente.
La verifica HTTP avviene dal nodo di esecuzione, con redirect vietati e risposta
limitata. Non dimostra da sola che tutti i percorsi pubblici, DNS, CDN o flussi
utente siano funzionanti: le verifiche della ricetta devono coprire gli aspetti
richiesti dal progetto.

Se un passaggio o la salute falliscono, il rollback dichiarato e approvato viene
eseguito con un proprio tempo massimo di cleanup. L'esito conserva `ok: false`
anche se il rollback riesce. La UI può distinguere rilascio fallito, rollback
riuscito e rollback fallito. Nessuna frase del modello può sostituire gli esiti
di processi e controlli osservati.

## Client VS Code

L'estensione conserva l'ID `funboy.haloforge` e usa la stessa interfaccia web
del control plane. La chiave personale è in `SecretStorage`, indicizzata per
origine del gateway. Tutte le API passano attraverso l'extension host:
il webview non riceve la chiave, non ha accesso di rete ed è limitato alle
risorse locali dell'estensione da CSP.

Il collegamento viene salvato solo dopo un accesso riuscito a `/api/bootstrap`.
Le richieste non seguono redirect. La configurazione di una chiave provider
usa una finestra password nativa quando il webview invia `requestSecret: true`.
Lo streaming SSE mantiene il cursore degli eventi e si riconnette; cambiare
gateway o chiudere la vista cancella i trasporti attivi.

Un workspace VS Code non attendibile può leggere cronologia e monitor, ma non
avviare missioni, inviare allegati o compiere mutazioni. Il comando
**Aggiungi selezione al contesto** trasferisce soltanto la selezione esplicita;
la UI la associa al progetto come allegato tramite la normale API.

Con Remote SSH, `localhost` è relativo all'extension host remoto. Il workspace
di esecuzione resta quello configurato nel progetto sul server, non viene
dedotto automaticamente dalla cartella aperta nell'editor. I backend Codex e
Antigravity nativi eseguiti sul coordinator possono usare soltanto target locali;
per tool su target SSH si usano i modelli HTTP con l'executor remoto.

## Verifiche e stato

I test locali esercitano filesystem reale, conflitti di hash, rifiuti, symlink,
hard link, ricette reali, timeout, cancellazione, lease sovrapposte, protocollo
runner, endpoint HTTP di salute e rollback. Il client VS Code è verificato sul
bundle effettivo con un host simulato e server HTTP reali: credenziali, trust,
CSP, trasporto, selezione e configurazione.

La sessione di sviluppo non dispone di un collegamento funzionante ai nodi
del cluster. Non sono stati verificati SSH reali, deploy di produzione né il
rendering dentro una finestra VS Code. Questi controlli operativi vanno eseguiti
sui target configurati prima della migrazione del servizio attivo.
