# Encoder locale per Knowledge

Il coordinator può usare un processo CPU separato per calcolare gli embedding di Knowledge. L’installazione di riferimento usa `http://127.0.0.1:18462/v1`, una connessione `openai-compatible` e il modello `paraphrase-multilingual-MiniLM-L12-v2` con capacità `embedding`. Il servizio è facoltativo. Per usare un altro encoder, cambia la rotta del progetto e ricostruisci l’indice per quella rotta.

## Origine e installazione di riferimento

- Modello multilingue Sentence Transformers `paraphrase-multilingual-MiniLM-L12-v2`, Apache-2.0, revisione `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`. [Scheda e file del modello](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/e8f8c211226b894fcb81acc59f3b34ba3efd5f42)
- Conversione GGUF Q8_0 di RecMind, Apache-2.0, revisione `39bf6f1b606622bbf08c2bbc76392089e24625ee`, peso `132440544` byte, SHA-256 `cabbea5495487e0aa6ff2efcb17cc8b9c507b9b907e020b934a056282bafa956`. [File GGUF](https://huggingface.co/RecMind/paraphrase-multilingual-MiniLM-L12-v2-GGUF/blob/39bf6f1b606622bbf08c2bbc76392089e24625ee/paraphrase-multilingual-MiniLM-L12-v2-q8_0.gguf)
- Il runtime installato riusa il build locale di `llama-server` derivato da llama.cpp, `0.3.0-dev`, build 1, snapshot locale `ba5354d46ca63e8225c28e1331f0f7651723ad05`, GNU `15.2.0` per Linux x86-64. Il suo albero sorgente riporta la licenza MIT. Il commit è quello dello snapshot locale e potrebbe non essere disponibile nell’upstream. [Sorgenti e licenza di llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE)

Binari e pesi risiedono in `~/.local/share/yed1z-local-encoder` e sono indipendenti da Gateway. Sul coordinator di riferimento il servizio utente `yed1z-local-encoder.service` è abilitato, ascolta esclusivamente su IPv4 loopback e usa un solo slot CPU. Nessuna chiave viene passata al servizio. L’unità imposta due thread, `MemoryHigh=780M`, `MemoryMax=950M` e `CPUQuota=180%`. Nella configurazione Gateway usa al massimo una richiesta per account e assegna l’encoder a un gruppo di risorse CPU indipendente se definisci un gruppo.

## Riprodurre o spostare il servizio

Scarica la stessa revisione GGUF sul nuovo host e verifica l’hash prima di avviare il server.

```bash
install -d -m 700 "$HOME/.local/share/yed1z-local-encoder/runtime"
cd "$HOME/.local/share/yed1z-local-encoder"
umask 077
curl --fail --location --retry 2 --output paraphrase-multilingual-MiniLM-L12-v2-q8_0.gguf \
  'https://huggingface.co/RecMind/paraphrase-multilingual-MiniLM-L12-v2-GGUF/resolve/39bf6f1b606622bbf08c2bbc76392089e24625ee/paraphrase-multilingual-MiniLM-L12-v2-q8_0.gguf'
printf '%s  %s\n' cabbea5495487e0aa6ff2efcb17cc8b9c507b9b907e020b934a056282bafa956 paraphrase-multilingual-MiniLM-L12-v2-q8_0.gguf | sha256sum --check
```

Usa un build CPU di `llama-server` compatibile con l’architettura del nuovo host o compila una revisione upstream esplicita. Per riprodurre esattamente il runtime di riferimento su un host compatibile conserva anche le librerie condivise e la licenza del suo build. Per un nuovo build verifica gli embedding sullo stesso corpus di riferimento prima della sostituzione. [Istruzioni di build llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) · [Opzioni del server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

Salva questa unità in `~/.config/systemd/user/yed1z-local-encoder.service` con il binario in `runtime/llama-server` e le sue eventuali librerie nella stessa directory.

```ini
[Unit]
Description=yed1z local multilingual embedding encoder

[Service]
Type=simple
WorkingDirectory=%h/.local/share/yed1z-local-encoder
ExecStart=/usr/bin/env -i LD_LIBRARY_PATH=%h/.local/share/yed1z-local-encoder/runtime %h/.local/share/yed1z-local-encoder/runtime/llama-server -m %h/.local/share/yed1z-local-encoder/paraphrase-multilingual-MiniLM-L12-v2-q8_0.gguf --alias paraphrase-multilingual-MiniLM-L12-v2 --embedding --pooling mean --host 127.0.0.1 --port 18462 --device none --n-gpu-layers 0 --threads 2 --threads-batch 2 --threads-http 2 --ctx-size 512 --batch-size 512 --ubatch-size 512 --parallel 1 --no-webui --log-disable
Restart=on-failure
RestartSec=2s
MemoryHigh=780M
MemoryMax=950M
CPUQuota=180%
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now yed1z-local-encoder.service
curl --fail http://127.0.0.1:18462/v1/models
curl --fail http://127.0.0.1:18462/v1/embeddings \
  -H 'Content-Type: application/json' \
  --data '{"model":"paraphrase-multilingual-MiniLM-L12-v2","input":["procedura di rilascio","release procedure"],"encoding_format":"float"}'
```

Aggiungi il provider ai `providers` della configurazione Gateway, assegna il modello embedding al progetto e usa **Knowledge → Indicizza**. Un esempio di provider per l’installazione sul coordinator è il seguente.

```json
{
  "id": "local-encoder",
  "kind": "openai-compatible",
  "label": "Encoder locale CPU",
  "baseUrl": "http://127.0.0.1:18462/v1",
  "enabled": true,
  "nodeIds": [],
  "resourceGroupIds": [],
  "maxConcurrent": 1,
  "maxEmbeddingChars": 120,
  "models": [{
    "model": "paraphrase-multilingual-MiniLM-L12-v2",
    "label": "MiniLM multilingue",
    "contextWindow": 512,
    "capabilities": ["embedding"]
  }]
}
```

`maxEmbeddingChars` è facoltativo. Con il valore `120`, Gateway partiziona i passaggi più lunghi in segmenti di al massimo 120 unità UTF-16 evitando di dividere le coppie surrogate. Combina i vettori reali dei segmenti pesandoli per lunghezza. Conserva testo, citazioni e offset dei passaggi originali. La soglia è specifica del tokenizer e del contesto dell’encoder locale. Se cambi modello o soglia, usa una nuova rotta oppure forza la reindicizzazione.

Se sposti il servizio su un host diverso dal coordinator, mantieni l’ascolto locale e usa il [tunnel SSH del nodo di inferenza](NODO-INFERENZA.md).

Per fermare il processo usa `systemctl --user stop yed1z-local-encoder.service`. Il restart avviene con `systemctl --user start yed1z-local-encoder.service` oppure automaticamente in caso di errore del processo. Finché l’encoder è fermo, le ricerche usano le evidenze lessicali disponibili. I vettori già indicizzati restano nel database di Gateway.

## Risultati osservati sul coordinator

- Tre input hanno prodotto tre vettori finiti da 384 componenti in circa 30 ms. Il coseno tra italiano e inglese semanticamente correlati era `0,548`, contro `0,044` per il testo fuori tema. Un lotto di 16 passaggi italiani di circa 1.800 caratteri ha richiesto `1,22 s`.
- In un database temporaneo di Gateway una query inglese ha restituito per prima la procedura di rilascio in italiano con citazione, hash e offset della fonte. La seconda indicizzazione della stessa revisione ha riutilizzato i tre vettori senza un’altra chiamata per quei passaggi.
- Il modello e il build occupano circa `201 MiB` su disco. Dopo il riavvio, il cgroup misurava circa `159 MiB` di RAM, l’unico listener era `127.0.0.1:18462` e la differenza massima per lo stesso vettore era inferiore a `1e-6`.
- Il server limita ogni input a 512 token. Una richiesta diretta con un passaggio CJK di 1.800 caratteri ha restituito HTTP 500. Con `maxEmbeddingChars: 120` lo stesso passaggio, insieme a una query breve, ha prodotto due vettori finiti da 384 componenti. Il contatore del server ha totalizzato 1.044 token sui segmenti. Se un altro encoder rifiuta un input, l’errore di reindicizzazione è visibile e la ricerca lessicale resta disponibile.
