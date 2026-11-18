# Rendere un motore disponibile al coordinator

Sul nodo di inferenza installa Node 24 e copia il singolo bundle `dist/node-bridge.mjs`. Il motore può ascoltare solo sul loopback del nodo. Per un motore compatibile OpenAI l’adapter espone catalogo, chat, Responses ed embedding se supportati a monte. In modalità Ollama inoltra tags, show, chat ed embed. L’adapter inoltra lo stream, le interruzioni e le intestazioni di quota supportate. La chiave del nodo e l’eventuale chiave del motore sono distinte.

Carica nella sessione del servizio una chiave privata di almeno 24 caratteri attraverso il normale archivio segreti del nodo. Il nome della variabile è `YED1Z_NODE_TOKEN`. Una chiave già richiesta dal motore viene letta da `YED1Z_ENGINE_TOKEN`.

```bash
YED1Z_NODE_KIND=openai \
YED1Z_NODE_UPSTREAM=http://127.0.0.1:8080/v1 \
YED1Z_NODE_BIND=127.0.0.1 YED1Z_NODE_PORT=8181 \
node dist/node-bridge.mjs
```

Per un coordinator su un’altra macchina puoi usare il tunnel SSH già autorizzato. Questo esempio apre la porta 18181 sul coordinator verso l’adapter in ascolto sull’altro nodo.

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18181:127.0.0.1:8181 ALIAS_DEL_NODO
```

Nel progetto apri **Connessioni → API compatibile OpenAI** e inserisci `http://127.0.0.1:18181/v1` e la chiave del nodo. Seleziona il nodo fisico e i gruppi di risorse condivisi dal motore. Per Ollama imposta `YED1Z_NODE_KIND=ollama`, usa la base del demone e seleziona il preset Ollama senza il suffisso `/v1`. Per rendere il servizio raggiungibile su una rete privata con TLS puoi scegliere l’interfaccia di ascolto e terminare TLS sul proxy amministrato da te.

```bash
node dist/cli.mjs probe --kind openai-compatible --url http://127.0.0.1:18181/v1 --key-env YED1Z_NODE_TOKEN --generate
```

`GET /health` segnala che l’adapter risponde. `GET /telemetry` campiona il nodo sulla stessa macchina. Entrambi richiedono la chiave del nodo. La prova di inferenza richiede catalogo e generazione sulla rotta. La macchina che esegue i comandi della missione si seleziona separatamente nel progetto.

Per registrare i sensori di un bridge nella dashboard, indica nella configurazione di quel nodo `telemetry.kind = "node-agent"`, `telemetry.url` con il percorso `/telemetry` e `telemetry.secretEnv` con il nome della variabile del servizio che contiene la chiave del bridge. L’interfaccia pubblica espone soltanto le misure consentite.
