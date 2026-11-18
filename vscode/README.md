# yed1z Control Room per VS Code

Installa il VSIX 1.0.0-rc.1, poi scegli **yed1z: Collega il gateway** e inserisci l’origine del coordinator e la tua chiave personale. Per il servizio condiviso l’origine è `https://yed1z.ai`.

Apri **Percorso del progetto** per seguire i task della squadra, i rami della conversazione e i risultati di test e build. **Modelli e account** permette di collegare provider, profili e nodi. In **Aspetto** puoi scegliere tema e movimento. Progetti, conversazioni e preferenze sono condivisi con il portale Web. L’identificativo dell’estensione è `funboy.haloforge`.

La chiave del gateway è conservata nel SecretStorage dell'host VS Code. In
Remote SSH, URL localhost e storage dell'estensione sono relativi a quell'host.
I comandi dell'agente vengono eseguiti sul target e workspace del progetto,
non necessariamente sulla macchina che fornisce il modello o sull'editor.

Le nuove attività e i trasferimenti richiedono un workspace attendibile. Dal
menu contestuale dell'editor puoi aggiungere la selezione esplicita al contesto.
Il server applica sempre autenticazione, ruoli, policy e autorizzazioni proprie.

Il webview non espone le credenziali e non effettua connessioni di rete dirette.
Le richieste JSON e SSE passano dall'extension host al solo gateway configurato;
i redirect sono rifiutati. Il token non deve essere inserito nelle impostazioni
del progetto, negli allegati o nelle conversazioni.

Dettagli di architettura ed esecuzione nel documento `docs/EXECUTION.md` del
repository completo.
