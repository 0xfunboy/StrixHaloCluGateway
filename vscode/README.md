# yed1z Control Room per VS Code

Installa il VSIX 0.3 e usa **yed1z: Collega il gateway** per indicare l'origine
del control plane e la tua chiave personale. Il server deve essere alla versione
0.3: il VSIX da solo non aggiorna il portale né i nodi.

La vista condivide progetti, conversazioni, squadra, allegati, memoria e monitor
con il browser. L'identificativo `funboy.haloforge` rimane invariato per aggiornare
le installazioni precedenti. Le conversazioni sono sul server, non nel webview.

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
