# Pizzer-IA — istruzioni per agenti

## Obiettivo

Mantenere un MVP affidabile che riceva chiamate sipcall direttamente su OpenAI Realtime SIP, raccolga ordini tramite tool backend, li persista in PostgreSQL e li mostri nella dashboard.

## Vincoli architetturali

- Un solo servizio Node.js/TypeScript/Fastify espone API, webhook, sideband e dashboard.
- Un solo PostgreSQL contiene ristoranti, menu, chiamate, ordini ed eventi webhook.
- OpenAI gestisce direttamente audio e SIP. Non introdurre Asterisk, FreeSWITCH, Twilio o 3CX salvo un vincolo tecnico dimostrato.
- Preparare le nuove tabelle con `restaurant_id` quando i dati sono tenant-specifici.

## Regola non negoziabile sui prezzi

L'LLM non calcola e non sceglie mai prezzi o totali. Gli ID di prodotti e modificatori devono esistere e risultare attivi nel database. `calculateDraft` determina prezzi e totale; `confirm_order` li ricalcola immediatamente prima della scrittura. Non aggiungere a `confirm_order` un parametro totale accettato dal modello.

## Flusso Realtime SIP

- Il webhook `realtime.call.incoming` deve essere verificato sul raw body e deduplicato tramite `webhook_events`.
- Associare il SIP `To` al DID del ristorante e conservare il `call_id`.
- Accettare la chiamata tramite `/v1/realtime/calls/{call_id}/accept` con modello, voce, prompt e function tools.
- Aprire il sideband su `wss://api.openai.com/v1/realtime?call_id=...`.
- Su `response.function_call_arguments.done`, validare gli argomenti, eseguire `OrderEngine`, inviare `function_call_output` e poi `response.create`.
- Prima di confermare, `get_order_summary` deve segnare il riepilogo come presentato; ogni mutazione successiva annulla quel flag.

## Sviluppo e test

Eseguire sempre:

```bash
npm run check
```

Per modifiche a pricing o stato ordine aggiungere test che provino input ostili (prezzo inventato, ID inesistente, conferma prematura, doppio webhook). Non sostituire test server-side con soli test UI.

## Database

Le migrazioni sono SQL versionate in `migrations/` e vengono applicate in transazione all'avvio. Non modificare una migrazione già distribuita: aggiungerne una nuova. Conservare importi in centesimi interi.

## Deploy Northflank

- Repository GitHub `stedbrown/pizzer-ia`, branch `main`, Dockerfile root.
- Porta pubblica 3000, health check `GET /health`, auto-deploy da `main`.
- PostgreSQL e tutte le credenziali devono arrivare da secret/env Northflank.
- Dopo ogni push attendere la build, leggere i log in caso di errore e verificare `/health`, dashboard e connettività DB.

## Sicurezza e privacy

- Non committare, stampare, fotografare o riportare in chat chiavi, signing secret, password o connection string.
- Non registrare audio per default e non raccogliere pagamenti o dati carta.
- Evitare numeri telefonici completi nei log.
- Dashboard e API amministrative devono restare protette; health e webhook sono le sole route pubbliche previste.
- Usare confronti timing-safe per credenziali/firme e limiti stretti per body e input.

## Prevenzione regressioni

Confermare che lint, typecheck, test e build passino; che una modifica ordine invalidi il riepilogo; che la conferma sia idempotente; che menu inattivi non siano ordinabili; che un webhook duplicato non venga rielaborato; che `/health` rifletta realmente PostgreSQL.
