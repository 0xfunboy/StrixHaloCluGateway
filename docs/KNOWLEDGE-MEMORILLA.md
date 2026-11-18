# Memoria di progetto e recupero delle fonti

Memorilla separa la scrittura e la lettura della memoria. Un encoder produce rappresentazioni riutilizzabili dei documenti. Per ogni domanda, slot appresi aggregano le rappresentazioni della collezione e il decoder riceve i vettori risultanti nel proprio spazio di input. I risultati pubblicati riguardano modelli e checkpoint specifici. [Paper, sezioni 2.1–2.6](https://arxiv.org/html/2610.21375v1#S2) · [Progetto Stanford](https://memory.stanford.edu/)

La versione studiata è il commit upstream `6864db7afe2d3d55ec41824bed147504d970dc9d`. Il codice upstream è Apache-2.0. I dati, i checkpoint e le valutazioni appartengono alla distribuzione di ricerca. Gateway usa un’implementazione originale TypeScript e SQLite. Il suo compilatore consegna brani verificabili ai normali connettori testuali. [Implementazione upstream](https://github.com/snap-stanford/memorilla/blob/6864db7afe2d3d55ec41824bed147504d970dc9d/memorilla/memory.py) · [Licenza](https://github.com/snap-stanford/memorilla/blob/6864db7afe2d3d55ec41824bed147504d970dc9d/LICENSE)

## Come viene generato il contesto

1. La ricerca costruisce prima il corpus autorizzato del progetto. Comprende gli allegati dell’utente, le sue memorie approvate e le memorie pubblicate e approvate nel progetto. Le statistiche lessicali e l’aggregazione operano su quel corpus.
2. Il sistema usa la domanda completa e, per domande con più clausole, fino a due sotto-domande in un’unica richiesta all’encoder configurato. Ogni slot calcola online una media pesata dei vettori compatibili con softmax numericamente stabile. La rilettura misura la pertinenza alla domanda, l’allineamento ai vettori aggregati e il peso di ogni passaggio in ciascuno slot.
3. Il lettore combina punteggio lessicale e segnali vettoriali, privilegia copertura di termini e fonti distinte e può includere un passaggio collegato da una relazione di provenienza esplicita. L’output include massimo due passaggi per fonte e rientra nel budget configurato di caratteri. Gli indici delle citazioni riguardano i caratteri UTF-16 del testo originale. [Lettore](../src/knowledge-reader.ts)
4. Query e indicizzazione usano lo scheduler del coordinator. L’encoder viene contattato per una ricerca soltanto quando esistono vettori nello scope. Un encoder assente, incompatibile o temporaneamente indisponibile lascia disponibili i risultati lessicali. L’interfaccia mostra modalità, stato dell’encoder e budget.
5. Le missioni e le chat dirette usano gli stessi estratti della ricerca. Il rapporto di contesto collega i passaggi alla revisione e agli hash della fonte e dell’estratto. Il compilatore conserva l’ultimo turno integrale quando rientra nel budget. Gli allegati scelti esplicitamente e fino a tre brief approvati entrano nel normale calcolo del contesto. Metodi e decisioni vengono richiamati in funzione della domanda. [Compilatore](../src/context.ts)

## Pubblicazione, aggiornamento e ritiro

- Si può proporre una memoria da un proprio allegato, conversazione, run o altra memoria del progetto. La scheda mostra il testo che verrà approvato. Le conversazioni e gli allegati originali conservano la propria visibilità.
- La pubblicazione condivisa richiede un autore autorizzato e lo stato approvato. L’aggiornamento del contenuto approvato e condiviso richiede una revisione del testo. L’apertura di una fonte citata verifica l’accesso corrente e la versione.
- Il ritiro rimuove i passaggi correnti e i rispettivi vettori. L’eliminazione rimuove anche le revisioni della memoria dal database in uso. I rapporti già salvati conservano il riferimento alla fonte che era disponibile al momento della run. Alla riapertura il coordinator applica l’autorizzazione corrente.
- L’indice conserva vettori separati per encoder. L’aggiornamento ordinario riutilizza i passaggi invariati. La ricostruzione esplicita sostituisce i vettori della rotta selezionata, per esempio dopo un cambio di dimensione dell’encoder. I vettori della 0.4 restano leggibili. [Archivio e accessi](../src/knowledge.ts)

## API

| Endpoint | Esito |
|---|---|
| `POST /api/projects/:id/knowledge/search` | Cerca `query`, con `limit` facoltativo da 1 a 24 e `maxChars` da 128 a 12000. Restituisce estratti, citazioni, segnali e rapporto di ricerca. Per i lettori la ricerca è lessicale. |
| `GET /api/projects/:id/knowledge/sources/:sourceId` | Restituisce la fonte corrente autorizzata. `revision` e `hash` permettono di chiedere la versione citata. Una fonte ritirata o inaccessibile restituisce 404. Un riferimento a una versione superata restituisce 409. |
| `POST /api/projects/:id/reindex` | Aggiorna i vettori dei passaggi propri autorizzati. `?force=1` ricostruisce anche i vettori già presenti per l’encoder selezionato. L’esito distingue calcolati, riutilizzati e saltati. |
| `POST /api/memories/search` | Mantiene il formato di ricerca delle memorie dei client precedenti. |

## Verifiche e limiti

La ricerca esamina fino a 8192 passaggi del corpus autorizzato. Il rapporto indica quando il limite di lettura o di restituzione è stato raggiunto. Il budget garantisce un massimo testuale anche per i provider che accettano soltanto messaggi. La latenza dipende dal numero di passaggi e dalla dimensione dell’encoder scelto.

I test confrontano la media online con il calcolo softmax in batch a logit elevati. Verificano il recupero di due indizi separati, la stabilità degli estratti, il riuso dei vettori, il fallback lessicale, il ritiro durante la ricerca e durante l’indicizzazione, e gli accessi HTTP per proprietari, membri e lettori. La qualità del recupero su progetti reali e con encoder diversi richiede una valutazione sul corpus di destinazione. [Test del lettore e dell’API](../tests/knowledge.test.ts)
