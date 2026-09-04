# Pizzer-IA

Pizzer-IA è un centralinista telefonico AI per pizzerie. sipcall consegna la chiamata ad Asterisk in WSL2, che la inoltra via SIP a OpenAI Realtime; il backend controlla menu e tool, calcola i prezzi, salva gli ordini in PostgreSQL e serve la dashboard.

## Stato attuale

- MVP single-tenant pubblicato su Northflank con PostgreSQL e dashboard amministrativa.
- Asterisk 22 e sipcall sono attivi in Ubuntu/WSL; la registrazione SIP è monitorata ogni circa 25 secondi.
- WSL viene mantenuto attivo senza finestre tramite l'attività Windows `Pizzer-IA WSL Keepalive`; systemd gestisce Asterisk e `pizzer-ia-heartbeat` con riavvio automatico.
- La dashboard mostra `Ordini`, `Menu`, `Telefonia` e `Live Logs`; gli eventi arrivano tramite SSE e vengono conservati per massimo 24 ore/1.000 righe.
- La modalità test abilita diagnostica SIP strutturata per massimo 15 minuti e si disattiva automaticamente.
- Health check, database, heartbeat, SSE e modalità test sono verificati. La chiamata reale sipcall → Asterisk → OpenAI Realtime è stata collaudata con risposta vocale e RTP; resta il collaudo completo di acquisizione e conferma ordine.

Dashboard di produzione: <https://p01--pizzer-ia-app--wbkbwwjx9sbm.code.run/>

## Architettura

```text
sipcall Classic → Asterisk/WSL2 → OpenAI Realtime SIP
                                      ↕ webhook + sideband WebSocket
                               Fastify / PostgreSQL
                                      ↓
                               dashboard admin
```

Asterisk è il gateway/B2BUA telefonico; il servizio Node non trasporta audio. Il sideband WebSocket gestisce eventi, tool e logica privata. PostgreSQL resta la fonte di verità per prodotti, modificatori e prezzi; il modello non può impostare il totale.

## Sviluppo locale

Requisiti: Node.js 22+, npm e PostgreSQL 15+.

```bash
npm install
cp .env.example .env
npm run dev
```

Le migrazioni e il seed demo vengono applicati automaticamente all'avvio. La dashboard è su `http://localhost:3000/`, protetta con HTTP Basic Auth (utente `admin`). La probe pubblica è `GET /health`.

La dashboard è un'app React compilata da Vite: `npm run build` produce `dist/web`, che Fastify serve dietro autenticazione. Per lavorarci con ricarica a caldo si usa `npm run dev` in un terminale e `npm run dev:web` nell'altro, che inoltra `/api` al backend locale. Senza `dist/web` la rotta `/` risponde 503 e le API restano funzionanti.

## Comandi

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```

## Variabili d'ambiente

| Variabile | Obbligatoria | Uso |
|---|---:|---|
| `PORT` | no | Porta HTTP, default 3000 |
| `DATABASE_URL` | sì | Connessione PostgreSQL |
| `ADMIN_PASSWORD` | sì | Password dashboard, conservata solo nei secret |
| `OPENAI_API_KEY` | per chiamate | Chiave del progetto OpenAI |
| `OPENAI_PROJECT_ID` | per SIP | Project ID usato nella SIP URI |
| `OPENAI_WEBHOOK_SECRET` | per webhook | Signing secret del webhook OpenAI |
| `OPENAI_REALTIME_MODEL` | no | Modello Realtime; default `gpt-realtime-2.1`, usare `gpt-realtime-2.1-mini` per la variante rapida ed economica |
| `OPENAI_VOICE` | no | Default `marin` |
| `OPENAI_TURN_DETECTION` | no | `server_vad` (default collaudato) oppure `semantic_vad` per l'A/B sulle pause |
| `OPENAI_VAD_EAGERNESS` | no | Solo con `semantic_vad`: `low`, `medium` (default), `high` |
| `OPENAI_GREETING` | no | Saluto iniziale breve, default `Pizzeria, buongiorno! Mi dica.` |
| `LARGE_ORDER_THRESHOLD` | no | Da questa quantità l'AI propone il passaggio umano; default e massimo operativo `20` |
| `AUTO_HANGUP_SECONDS` | no | Pausa fra il saluto e la chiusura automatica; default `3`, `0` disattiva |
| `HEARTBEAT_SECRET` | per monitoraggio | Token dedicato Asterisk → backend |
| `RESTAURANT_DID` | no | DID documentale/configurativo |
| `HUMAN_TRANSFER_URI` | no | Destinazione SIP/tel per trasferimento umano. Senza, l'agente offre di far richiamare invece di promettere un passaggio che non avverrebbe |
| `SMS_WEBHOOK_URL` | no | Endpoint che inoltra la conferma al cliente; riceve `POST {to, text}`. Senza, nessun SMS viene inviato |
| `SMS_WEBHOOK_TOKEN` | no | Bearer token per quell'endpoint |

Usare `.env.example` soltanto come schema. Non inserire secret nel repository o nei log.

## Docker e deploy Northflank

Il `Dockerfile` multi-stage produce un singolo servizio applicativo su porta 3000. In Northflank:

1. creare un addon PostgreSQL nel progetto;
2. collegare `DATABASE_URL` al secret/connection string dell'addon;
3. creare un Combined Service dal repository, branch `main`, Dockerfile alla root;
4. esporre la porta HTTP 3000 e configurare la probe `GET /health`;
5. impostare i restanti secret e abilitare auto-deploy da `main`.

L'applicazione applica in ordine i file `migrations/*.sql`, registrandoli in `_migrations`. Ogni file viene eseguito una sola volta in transazione.

## Flusso OpenAI Realtime SIP

1. sipcall inoltra il DID ad Asterisk; Asterisk inoltra a `sip:OPENAI_PROJECT_ID@sip.api.openai.com;transport=tls` (oppure `sip-eu.api.openai.com` per un progetto con residenza dati europea).
2. OpenAI invia `realtime.call.incoming` a `POST /webhooks/openai`.
3. Il backend verifica la firma sul raw body e registra l'evento in modo idempotente.
4. Il backend associa il DID alla pizzeria, salva la chiamata e accetta `POST /v1/realtime/calls/{call_id}/accept`.
5. Il backend apre `wss://api.openai.com/v1/realtime?call_id={call_id}` e risponde ai function call.
6. `confirm_order` ricalcola il totale e scrive ordine e righe in una transazione.

Non si registra audio. Il caller ID viene usato solo come recapito operativo e non viene stampato per intero nei log.

### Modello e qualità conversazionale

Il modello si sceglie in un solo punto tramite `OPENAI_REALTIME_MODEL` (default in `src/realtime.ts`), quindi l'A/B test non richiede modifiche al codice:

- `gpt-realtime-2.1`: default attuale, il migliore per instruction following, tool use e gestione delle interruzioni;
- `gpt-realtime-2.1-mini`: baseline rapida ed economica, pienamente supportata;
- `gpt-realtime-1.5`: indicato dal catalogo OpenAI come modello voice di riferimento; documentato ma non selezionato automaticamente. Non è un modello reasoning, quindi `parallel_tool_calls` viene disattivato in automatico.

Una risposta parlata per turno: il backend consegna tutti i `function_call_output` di un turno e invia un solo `response.create`, quando nessuna response è attiva e il cliente non sta parlando (`ResponseScheduler`). Prima ogni singolo tool generava un turno vocale a sé, ed era la causa principale dell'effetto questionario.

Gli output dei tool vengono ridotti prima di tornare al modello (`toolOutputForModel`): le mutazioni dell'ordine restituiscono righe, `line_id` e campi già noti, ma **non** prezzi né totale. Il totale arriva solo da `calculate_total` e `get_order_summary`. Il calcolo resta interamente nel backend: qui si filtra soltanto.

Il VAD resta `server_vad` con `silence_duration_ms: 550` e `interrupt_response: true`, valori già collaudati sulla linea reale. Per provare il turn detection semantico, che attende più a lungo quando il cliente sta ancora pensando, basta `OPENAI_TURN_DETECTION=semantic_vad` (timeout massimi indicativi: `low` 8s, `medium` 4s, `high` 2s). Nessun altro parametro audio è stato toccato.

Checklist manuale per una chiamata in Modalità test:

- A — «Due Diavole e una Margherita senza mozzarella»: niente menu recitato, chiede solo i dati mancanti.
- B — «Due Diavole» / «No aspetta, una sola»: aggiorna senza ricominciare né riepilogare tutto.
- C — «Una pizza kebab»: non inventa il prodotto e propone al massimo un'alternativa reale.
- D — «Non so cosa prendere»: fa una domanda utile o propone 2-3 opzioni, non l'intero menu.
- E — interrompere l'AI a metà frase: l'audio si ferma e l'AI ascolta la correzione.
- F — «Ciao come va? Senti, volevo prendere un paio di pizze»: risponde naturalmente, non come un parser.
- G — «Mille Diavole»: non conferma e chiama `transfer_to_human`.
- H — «Voglio parlare con una persona»: risponde brevemente e chiama `transfer_to_human`.

## API

- `GET /health` — stato servizio/database, pubblico
- `POST /webhooks/openai` — webhook firmato OpenAI, pubblico
- `POST /api/telephony/heartbeat` — heartbeat Asterisk con token dedicato
- `POST /api/telephony/events` — batch di eventi telefonici strutturati con lo stesso token
- `GET /api/telephony/status` — stato telefonia, autenticato
- `GET /api/usage/monthly` — utilizzo/costi mensili, autenticato
- `GET /api/conversations` — telefonate ricostruite come dialogo, autenticato
- `GET /api/live-logs` — eventi recenti redatti, autenticato
- `GET /api/live-logs/stream` — stream SSE dei nuovi eventi, autenticato
- `GET|POST /api/test-mode` — stato/attivazione diagnostica per massimo 15 minuti
- `GET /api/orders` — elenco ordini, autenticato
- `PATCH /api/orders/:id/status` — avanzamento ordine, autenticato
- `GET /api/menu` — menu e modificatori, autenticato
- `PATCH /api/menu/:id` — nome, prezzo, categoria, allergeni, disponibilità e finito-per-oggi, autenticato
- `GET|PATCH /api/service` — orari, tempi di attesa, serata piena e consegne, autenticato
- `GET /api/callbacks` — richiami da fare, autenticato
- `POST /api/callbacks/:id/resolve` — segna un richiamo come fatto, autenticato

## Struttura

- `src/app.ts` — HTTP, autenticazione, API e webhook
- `src/realtime.ts` — accettazione SIP, prompt, tool schema e sideband
- `src/order-engine.ts` — macchina di stato e calcolo prezzi server-side
- `src/service-hours.ts` — orari, tempi di attesa e briefing iniettato nel prompt
- `src/conversations.ts` — telefonate ricostruite dagli eventi già registrati
- `src/notify.ts` — conferma scritta al cliente tramite webhook generico
- `src/postgres-store.ts` — persistenza PostgreSQL
- `migrations/` — schema, menu demo e impostazioni di servizio
- `web/` — dashboard React + Vite, bundle in `dist/web`
- `src/live-logs.ts` — classificazione e redaction centralizzata
- `telephony/asterisk/` — template e heartbeat, mai applicati automaticamente
- `tests/` — test HTTP, firma webhook, idempotenza, orari e motore ordini

## Troubleshooting

- `/health` 503: verificare `DATABASE_URL`, rete e stato addon.
- Webhook 401: verificare che `OPENAI_WEBHOOK_SECRET` appartenga al webhook dello stesso progetto.
- Chiamata non arriva: seguire in ordine Hello World, Echo e poi OpenAI; verificare registrazione sipcall, Project ID, TLS/5061, codec e RTP.
- Chiamata arriva ma non parla: controllare API key, disponibilità del modello e log dell'accept endpoint.
- Tool fallisce: verificare che menu/modificatori siano attivi e che gli ID provengano dai risultati del backend.

## Orari, tempi e disponibilità

Gli orari di apertura, il tempo di preparazione, il supplemento per la consegna e la modalità "serata piena" vivono nel database e si modificano dalla tab `Servizio`. All'accettazione della chiamata il backend calcola lo stato del servizio e lo inietta nel prompt come poche righe di contesto: l'agente sa se siete aperti e quanti minuti servono senza chiamare uno strumento, quindi rispondere a "quanto ci vuole?" non costa latenza. Fuori orario non prende ordini, dice quando riaprite e propone un richiamo.

Le fasce orarie sono più di una al giorno per coprire la pausa fra pranzo e cena; una fascia che chiude prima di quando apre supera la mezzanotte (`18:00 → 00:30`). Il fuso è quello del ristorante, non del server: Northflank gira in UTC.

A ordine confermato il backend calcola l'ora di pronto dalle impostazioni, la salva sull'ordine e la passa all'agente in `readyTime`. Il modello non stima mai i tempi da solo.

Nel menu, "finito per oggi" toglie un prodotto all'agente immediatamente e lo rimette da solo il giorno successivo, senza che nessuno debba ricordarsene.

## Chiusura della chiamata

A ordine confermato o chiamata trasferita l'agente saluta e chiama `end_call`. La chiusura non parte subito: il backend attende che l'agente abbia finito di parlare, aspetta `AUTO_HANGUP_SECONDS` e solo allora chiama `POST /v1/realtime/calls/{id}/hangup`. Se il cliente riprende a parlare in quella finestra la chiusura viene annullata e serve un nuovo `end_call`. Prima della conferma `end_call` viene rifiutato dal backend, così una chiamata in corso non può essere chiusa per errore.

## Conversazioni

La tab `Conversazioni` ricostruisce ogni telefonata come dialogo leggibile. Ogni riga porta il tempo trascorso dall'inizio della chiamata, e ogni risposta dell'agente mostra quanto ha fatto attendere il cliente: verde sotto il secondo, ambra fino a due, rosso oltre. L'intestazione riassume esito, durata, numero di battute, attesa media e interruzioni, così si giudica una chiamata senza aprirla. I dettagli tecnici — tool e stato dell'ordine — restano nascosti dietro un interruttore per non competere con le battute. È una vista sugli eventi già registrati (`src/conversations.ts`): nessuna tabella nuova, nessuna raccolta dati aggiuntiva, stessa redaction e stessa retention dei Live Logs.

Le trascrizioni esistono soltanto per le chiamate fatte in Modalità test: fuori da quella finestra non vengono richieste a OpenAI né salvate, quindi una chiamata normale compare senza battute. Il rumore tecnico — SIP, RTP, heartbeat, marker di inizio e fine parlato — resta nei Live Logs e non entra nel dialogo. In Modalità test vengono registrati anche il barge-in e il tempo di risposta dopo la fine del parlato del cliente, utili per valutare la fluidità.

## Live Logs

La dashboard integra uno stream SSE di eventi strutturati provenienti da Asterisk, SIP, heartbeat, webhook, sideband, tool, OrderEngine, PostgreSQL e backend. PostgreSQL conserva al massimo gli ultimi 1.000 eventi per ristorante e non oltre 24 ore. Secret, header di autorizzazione, connection string e numeri telefonici vengono redatti prima della scrittura e nuovamente prima della risposta UI.

La modalità test scade automaticamente dopo 15 minuti. In tale finestra abilita anche la trascrizione diagnostica dell'utente e registra in Live Logs, con redaction e limite di conservazione, inizio/fine parlato e trascrizioni USER/OPENAI; fuori dalla modalità test le trascrizioni non vengono richieste né salvate. Il collector outbound abilita temporaneamente solo il logger PJSIP, estrae REGISTER/INVITE/100/180/200/ACK/BYE dal journal e lo spegne alla scadenza o al riavvio. RTP viene rappresentato con sommari periodici, senza debug per-pacchetto e senza nuove porte inbound.
