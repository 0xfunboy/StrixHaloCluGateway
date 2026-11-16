# Changelog

## 0.3.0 · 16 novembre 2026

- Sostituito il coordinator Python con un unico runtime TypeScript.
- Separati nodi, risorse di inferenza, account/model route, target di esecuzione e destinazioni di rilascio.
- Introdotti scheduler atomico, missioni persistenti, DAG, controllo per task e ciclo review/verifica/riparazione/rilascio.
- Aggiunti workspace locali/SSH con runner stateless, gestione esiti incerti, ricette e lease anche su directory sovrapposte.
- Ripensata l'interfaccia come Control Room condivisa da web e VS Code.
- Aggiunti allegati, memoria revisionata, ricerca testuale/vettoriale, contesto ispezionabile e report di consegna.
- Implementata telemetria TypeScript, comprese interfacce e contatori di rete; fallback legacy marcati non verificati.
- Conservati adapter ufficiali Codex/Antigravity e provider HTTP, con limiti espliciti di account/sandbox.
- Introdotti ruoli, cifratura dei segreti e import idempotente dello storico 0.2.
- Nessun aggiornamento della produzione o rimozione di servizi è stato eseguito durante la preparazione.
