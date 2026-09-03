# Pizzer-IA

Pizzer-IA è un centralinista telefonico AI per pizzerie. Il numero telefonico viene inoltrato via SIP direttamente a OpenAI Realtime; il backend controlla il menu, esegue i tool dell'assistente, calcola i prezzi, salva gli ordini in PostgreSQL e serve la dashboard amministrativa.

## Architettura

```text
sipcall DID → OpenAI Realtime SIP (audio) → webhook + sideband WebSocket
                                              ↓
                              Pizzer-IA / Fastify / PostgreSQL
                                              ↓
                                      dashboard admin
```

Non esiste un bridge audio applicativo: OpenAI termina direttamente SIP e media. Il canale WebSocket server-side gestisce esclusivamente eventi, tool e logica privata. La fonte di verità per prodotti, modificatori e prezzi è PostgreSQL; il modello non può impostare il totale.

## Sviluppo locale

Requisiti: Node.js 22+, npm e PostgreSQL 15+.

```bash
npm install
cp .env.example .env
npm run dev
```

Le migrazioni e il seed demo vengono applicati automaticamente all'avvio. La dashboard è su `http://localhost:3000/`, protetta con HTTP Basic Auth (utente `admin`). La probe pubblica è `GET /health`.

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
| `OPENAI_REALTIME_MODEL` | no | Default `gpt-realtime-2.1-mini` |
| `OPENAI_VOICE` | no | Default `marin` |
| `RESTAURANT_DID` | no | DID documentale/configurativo |
| `HUMAN_TRANSFER_URI` | no | Destinazione SIP/tel per trasferimento umano |

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

1. Il trunk sipcall inoltra il DID a `sip:OPENAI_PROJECT_ID@sip-eu.api.openai.com;transport=tls`.
2. OpenAI invia `realtime.call.incoming` a `POST /webhooks/openai`.
3. Il backend verifica la firma sul raw body e registra l'evento in modo idempotente.
4. Il backend associa il DID alla pizzeria, salva la chiamata e accetta `POST /v1/realtime/calls/{call_id}/accept`.
5. Il backend apre `wss://api.openai.com/v1/realtime?call_id={call_id}` e risponde ai function call.
6. `confirm_order` ricalcola il totale e scrive ordine e righe in una transazione.

Non si registra audio. Il caller ID viene usato solo come recapito operativo e non viene stampato per intero nei log.

## API

- `GET /health` — stato servizio/database, pubblico
- `POST /webhooks/openai` — webhook firmato OpenAI, pubblico
- `GET /api/orders` — elenco ordini, autenticato
- `PATCH /api/orders/:id/status` — avanzamento ordine, autenticato
- `GET /api/menu` — menu e modificatori, autenticato
- `PATCH /api/menu/:id` — nome, prezzo e disponibilità, autenticato

## Struttura

- `src/app.ts` — HTTP, autenticazione, API e webhook
- `src/realtime.ts` — accettazione SIP, prompt, tool schema e sideband
- `src/order-engine.ts` — macchina di stato e calcolo prezzi server-side
- `src/postgres-store.ts` — persistenza PostgreSQL
- `migrations/` — schema e menu demo
- `public/` — dashboard responsive
- `tests/` — test HTTP, firma webhook, idempotenza e motore ordini

## Troubleshooting

- `/health` 503: verificare `DATABASE_URL`, rete e stato addon.
- Webhook 401: verificare che `OPENAI_WEBHOOK_SECRET` appartenga al webhook dello stesso progetto.
- Chiamata non arriva: verificare Project ID nella SIP URI, TLS/5061 e configurazione di inoltro sipcall.
- Chiamata arriva ma non parla: controllare API key, disponibilità del modello e log dell'accept endpoint.
- Tool fallisce: verificare che menu/modificatori siano attivi e che gli ID provengano dai risultati del backend.
