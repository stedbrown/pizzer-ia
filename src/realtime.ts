import WebSocket from 'ws';
import type { Store } from './store.js';
import { OrderEngine } from './order-engine.js';
import { orderConfirmationText, sendSms, smsConfigured } from './notify.js';
import type { CallUsage, NewLiveLogEvent } from './types.js';

type LogInput = Omit<NewLiveLogEvent, 'category'> & { category?: NewLiveLogEvent['category'] };

const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function', name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false }
});

export const realtimeTools = [
  tool('get_menu', 'Conoscenza interna: menu e prezzi ufficiali. Non è un testo da leggere al cliente; per un prodotto citato usa search_menu.'),
  tool('search_menu', 'Cerca internamente prodotti reali nel menu. Preferiscilo quando il cliente nomina un prodotto o una categoria.', { query: { type: 'string' } }, ['query']),
  tool('start_order', 'Rilegge la bozza corrente con i line_id delle righe. Non serve a inizio chiamata: usalo solo prima di modificare o rimuovere una riga.'),
  tool('add_item', 'Aggiunge un prodotto usando solo ID restituiti dal menu. Puoi chiamarlo più volte nello stesso turno per più prodotti, poi rispondi una sola volta.', { item_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 20 }, modifier_ids: { type: 'array', items: { type: 'string' } } }, ['item_id', 'quantity', 'modifier_ids']),
  tool('remove_item', 'Rimuove una riga dalla bozza usando il line_id.', { line_id: { type: 'string' } }, ['line_id']),
  tool('update_item', 'Aggiorna quantità o modificatori di una riga esistente. Usalo quando il cliente cambia idea, invece di ricominciare.', { line_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 20 }, modifier_ids: { type: 'array', items: { type: 'string' } } }, ['line_id']),
  tool('set_customer_name', 'Imposta il nome del cliente.', { name: { type: 'string' } }, ['name']),
  tool('set_fulfillment', 'Imposta ritiro o consegna.', { type: { type: 'string', enum: ['pickup', 'delivery'] } }, ['type']),
  tool('set_delivery_address', 'Imposta indirizzo completo per la consegna.', { address: { type: 'string' } }, ['address']),
  tool('calculate_total', 'Totale ufficiale calcolato dal backend. Chiamalo quando il cliente chiede quanto viene.'),
  tool('get_order_summary', 'Riepilogo ufficiale con totale; abilita la conferma successiva. Usalo una sola volta, subito prima della conferma finale.'),
  tool('confirm_order', 'Conferma solo dopo un sì esplicito del cliente, pronunciato dopo il riepilogo.', { confirmed: { type: 'boolean', const: true } }, ['confirmed']),
  tool('transfer_to_human', 'Passa la chiamata a una persona: se il cliente lo chiede, per allergie o informazioni non verificabili, oppure per ordini anomali.'),
  tool('request_callback', 'Registra la richiesta di essere richiamati dalla pizzeria. Usalo quando non è possibile passare una persona subito.', { phone: { type: 'string' }, reason: { type: 'string' } }, ['reason']),
  tool('end_call', 'Chiude la telefonata. Usalo solo dopo aver salutato e solo a ordine confermato, richiamo registrato o chiamata passata a una persona.')
];

export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1';
export const DEFAULT_VOICE = 'marin';
const defaultGreeting = 'Pizzeria, buongiorno! Mi dica.';
const defaultLargeOrderThreshold = 20;

export interface VoiceAgentOptions {
  greeting?: string;
  largeOrderThreshold?: number;
  /** Orari, stato aperto/chiuso e tempi di attesa, calcolati dal backend all'inizio della chiamata. */
  briefing?: string;
  humanTransferAvailable?: boolean;
}

export function centralistInstructions(restaurantName: string, callerPhone?: string, options: VoiceAgentOptions = {}) {
  const greeting = options.greeting?.trim() || defaultGreeting;
  const largeOrderThreshold = normalizeLargeOrderThreshold(options.largeOrderThreshold);
  const briefing = options.briefing?.trim();
  const transfer = options.humanTransferAvailable
    ? 'usa transfer_to_human e passa la chiamata'
    : 'in questo momento non puoi passare nessuno: dillo con semplicità, offri di farlo richiamare, chiedi il numero se non ce l\'hai e registra la richiesta con request_callback';
  const escalate = options.humanTransferAvailable ? 'usa transfer_to_human' : 'offri di farlo richiamare e usa request_callback';
  return `Sei l'addetto telefonico di ${restaurantName}, una pizzeria vera. Prendi ordini al telefono, in italiano.

Parli come una persona al telefono: frasi corte, tono cordiale, UNA domanda alla volta, riscontri brevi e variati. Niente monologhi, niente elenchi, niente formule da call center, e non dire "perfetto" a ogni frase. Non sei un assistente virtuale: non nominare mai strumenti, funzioni, database, sistemi o modelli AI.
Dai sempre del LEI, dall'inizio alla fine. Mai passare al tu.

Apri la chiamata soltanto con: "${greeting}". Poi non salutare più e non ripresentarti.
${briefing ? `\nOGGI\n${briefing}\n` : ''}

MAI ANNUNCIARE QUELLO CHE STAI PER FARE
Non dire mai "la segno", "preparo il riepilogo", "lo segno come confermato", "adesso controllo", "procedo", "un attimo che sistemo". Non descrivere il tuo lavoro: fallo e basta, poi parla una volta sola col risultato. Il riepilogo lo dici direttamente, non lo annunci.

ASCOLTO
- Il cliente ti dà più cose insieme e in ordine sparso: prendile tutte al primo colpo. Se ha già detto nome, prodotti o ritiro, quelli sono a posto. Chiedi soltanto ciò che manca, senza scaletta fissa.
- Registra solo quello che il cliente ha detto davvero. Non dedurre e non dare per scontato niente: se non sei sicuro di ritiro, consegna, nome o quantità, chiedi. Meglio una domanda in più che un dato inventato.
- Prima lascialo ordinare. Ritiro o consegna lo chiedi quando ha finito con i prodotti, non all'inizio.
- Per il ritiro servono prodotti e nome; per la consegna anche l'indirizzo. Chiamalo per nome di battesimo, non con nome e cognome. Il caller ID ${callerPhone ? 'ce l\'hai già: non chiederlo' : 'non è disponibile: chiedi un recapito solo se serve davvero'}.
- Se ti interrompe, smetti di parlare e ascolta.
- Se non hai capito una parte, chiedi di ripetere solo quella. Non indovinare.
- Se cambia idea, aggiorna la riga e riparti da lì: due parole bastano. Non ricominciare l'ordine e non rileggerlo.

MENU
- Il menu è una tua conoscenza, non un testo da leggere: non elencare i prodotti spontaneamente. Se ti chiedono cosa c'è, fai una domanda utile o proponi due cose. Elenchi tutto solo se te lo chiedono espressamente.
- Le aggiunte, i supplementi e le varianti non si propongono MAI: le applichi soltanto se è il cliente a chiederle. Non chiedere se vuole aggiungere qualcosa.
- Se un prodotto non esiste, dillo in due parole e al massimo proponi un'alternativa vera. Non inventare prodotti, ingredienti o disponibilità.
- I prezzi non li sai a memoria e non li stimi: non calcolare prezzi mentalmente. Ne dici uno solo se te lo chiedono o nel riepilogo finale; per il totale usa calculate_total.

MENTRE PARLI
- Usa gli strumenti in silenzio, senza dire niente prima. Per più prodotti falli tutti nello stesso turno e poi dai UNA sola risposta breve.
- Dopo aver segnato qualcosa non ripetere l'ordine: basta un riscontro di due parole e la domanda successiva, se ne serve una.
- Se qualcosa non risponde, niente termini tecnici: "Un attimo, questa cosa non riesco a verificarla." Se il problema resta, ${escalate}.
- Non ripetere mai saluto, nome, totale, domande già fatte o cose appena dette. Non riepilogare dopo ogni modifica.

QUANDO NON SAI
I tempi di attesa e gli orari te li ho scritti sopra: quelli puoi dirli. Tutto il resto che non hai — promozioni, ingredienti non confermati, zone di consegna — non inventarlo: di' che preferisci non dare un'informazione sbagliata. Sugli allergeni puoi riferire quello che risulta a menu, ma se il cliente parla di un'allergia non dare garanzie: serve la pizzeria. Non chiedere dati di carte di credito.

PASSARE A UNA PERSONA
Se il cliente lo chiede, o se l'ordine è anomalo o arriva a ${largeOrderThreshold} pezzi, non confermarlo: ${transfer}.

CHIUSURA
Quando hai tutto chiama get_order_summary e di' subito UN solo riepilogo con parole tue: prodotti, modifiche, ritiro o consegna, nome, totale. Dillo come lo direbbe una persona — "una Margherita e due Diavole", non "Margherita, una" — e poi chiedi conferma. Usa confirm_order soltanto dopo un sì chiaro detto DOPO quel riepilogo; con "forse", "aspetta", "non so" non confermi. Se dopo il riepilogo cambia qualcosa, aggiorna e rifai riepilogo e conferma. A ordine confermato di' l'ora indicata da confirm_order in readyTime — quella è la stima della pizzeria, non inventarne altre — e chiudi in una frase.
Poi saluta normalmente e chiudi la telefonata con end_call: prima il saluto, poi end_call, mai mentre il cliente sta ancora parlando. Se dopo il saluto dice altro, riprendi la conversazione e chiuderai più tardi.`;
}

export interface TurnDetectionOptions {
  turnDetection?: string;
  vadEagerness?: string;
}

/** server_vad resta il default collaudato; semantic_vad è opt-in per l'A/B su barge-in e pause di riflessione. */
export function buildTurnDetection(options: TurnDetectionOptions = {}) {
  const mode = options.turnDetection?.trim().toLowerCase();
  if (mode === 'semantic_vad' || mode === 'semantic') {
    const eagerness = ['low', 'medium', 'high', 'auto'].includes(String(options.vadEagerness).toLowerCase())
      ? String(options.vadEagerness).toLowerCase() : 'medium';
    return { type: 'semantic_vad', create_response: true, interrupt_response: true, eagerness };
  }
  return { type: 'server_vad', create_response: true, interrupt_response: true, silence_duration_ms: 550 };
}

/** parallel_tool_calls è supportato dai modelli reasoning della famiglia gpt-realtime-2. */
export function supportsParallelToolCalls(model: string) {
  return /^gpt-realtime-2/i.test(model);
}

export function buildRealtimeSession(args: { restaurantName: string; callerPhone?: string; model: string; voice: string; greeting?: string; largeOrderThreshold?: number; briefing?: string; humanTransferAvailable?: boolean; testMode?: boolean } & TurnDetectionOptions) {
  return {
    type: 'realtime', model: args.model, instructions: centralistInstructions(args.restaurantName, args.callerPhone, args),
    output_modalities: ['audio'], max_output_tokens: 700, parallel_tool_calls: supportsParallelToolCalls(args.model),
    audio: {
      input: {
        ...(args.testMode ? { transcription: { model: 'gpt-live-transcribe', languages: ['it'], delay: 'low' } } : {}),
        turn_detection: buildTurnDetection(args)
      },
      output: { voice: args.voice }
    },
    tools: realtimeTools, tool_choice: 'auto', tracing: 'auto'
  };
}

/**
 * Riduce l'output dei tool a ciò che serve al modello per parlare bene.
 * Le mutazioni non restituiscono prezzi né totale: erano la causa del riepilogo ripetuto a ogni modifica.
 * Non si aggiunge testo di servizio: qualunque frase messa qui dentro il modello può leggerla ad alta voce.
 * Il backend resta l'unica fonte di verità: qui non si calcola nulla, si filtra soltanto.
 */
export function toolOutputForModel(name: string, result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  if (name === 'get_menu' || name === 'search_menu') {
    const items = Array.isArray(result) ? result : [];
    // Le varianti arrivano solo sulla ricerca mirata: nell'elenco completo il modello finiva per proporle.
    return { items: items.map((item) => compactMenuItem(item, name === 'search_menu')) };
  }
  const value = result as Record<string, any>;
  if (name === 'confirm_order' || name === 'transfer_to_human') return value;
  if (name === 'get_order_summary' || name === 'calculate_total') {
    return { ...compactDraft(value), totalCents: value.totalCents, currency: value.currency };
  }
  if (!Array.isArray(value.items)) return result;
  // start_order è la lettura dello stato; le mutazioni tornano solo cosa manca ancora,
  // altrimenti il modello si ritrova l'ordine intero in mano e lo recita a ogni modifica.
  if (name === 'start_order') return compactDraft(value);
  return { ok: true, missing: missingFields(value) };
}

function missingFields(value: Record<string, any>) {
  const missing: string[] = [];
  if (!value.items?.length) missing.push('prodotti');
  if (!value.customerName) missing.push('nome');
  if (!value.fulfillment) missing.push('ritiro o consegna');
  if (value.fulfillment === 'delivery' && !value.deliveryAddress) missing.push('indirizzo');
  return missing;
}

function compactMenuItem(item: any, withModifiers: boolean) {
  return {
    id: item?.id, name: item?.name, priceCents: item?.priceCents,
    ...(item?.description ? { description: String(item.description).slice(0, 160) } : {}),
    ...(withModifiers && Array.isArray(item?.modifiers) && item.modifiers.length
      ? { modifiers: item.modifiers.map((modifier: any) => ({ id: modifier?.id, name: modifier?.name })) }
      : {})
  };
}

function compactDraft(value: Record<string, any>) {
  const lines = Array.isArray(value.items) ? value.items.map((item: any) => ({
    line_id: item?.lineId, name: item?.name, quantity: item?.quantity,
    ...(Array.isArray(item?.modifiers) && item.modifiers.length ? { modifiers: item.modifiers.map((modifier: any) => modifier?.name) } : {})
  })) : [];
  return {
    lines,
    customerName: value.customerName ?? null,
    fulfillment: value.fulfillment ?? null,
    deliveryAddress: value.deliveryAddress ?? null,
    ...(value.confirmedOrderId ? { confirmedOrderId: value.confirmedOrderId } : {})
  };
}

/**
 * Una sola risposta parlata per turno.
 * Prima si inviava response.create dopo ogni singolo tool: più tool nello stesso turno
 * producevano più risposte vocali di fila, e una response ancora attiva veniva interrotta.
 */
export class ResponseScheduler {
  private active = false;
  private pending = 0;
  private owed = false;
  private userTurn = false;
  constructor(private readonly send: () => void) {}

  responseCreated() { this.active = true; this.owed = false; this.userTurn = false; }
  responseFinished() { this.active = false; this.flush(); }
  toolStarted() { this.pending += 1; }
  /** expectsAnswer false per i tool che non devono far ripartire l'agente, come la chiusura. */
  toolFinished(expectsAnswer = true) {
    this.pending = Math.max(0, this.pending - 1);
    this.owed = (this.owed || expectsAnswer) && !this.userTurn;
    this.flush();
  }
  /** Il cliente sta parlando: risponderà il VAD, non dobbiamo accodare un turno nostro sopra il suo. */
  userSpeechStarted() { this.owed = false; this.userTurn = true; }

  private flush() {
    if (!this.owed || this.active || this.pending > 0) return;
    this.owed = false;
    this.send();
  }
}

/**
 * Chiude la telefonata senza tagliare la voce: il modello dichiara che la chiamata è finita,
 * la chiusura vera parte solo quando ha smesso di parlare e dopo una pausa di cortesia.
 * Se il cliente riprende a parlare la chiusura salta: ha ancora qualcosa da dire.
 */
export class CallCloser {
  private allowed = false;
  private requested = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly hangup: () => void, private readonly graceMs = 3000) {}

  /** Consentita solo a ordine confermato o chiamata passata a una persona. */
  allow() { this.allowed = true; }
  request() {
    if (!this.allowed || this.graceMs <= 0) return false;
    this.requested = true;
    return true;
  }
  responseFinished() { if (this.requested) this.arm(); }
  userSpeechStarted() { this.requested = false; this.cancel(); }
  cancel() { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }

  private arm() {
    this.cancel();
    this.timer = setTimeout(() => { this.timer = undefined; this.hangup(); }, this.graceMs);
  }
}

export async function acceptRealtimeCall(args: { callId: string; restaurantName: string; callerPhone?: string; apiKey: string; model: string; voice: string; greeting?: string; largeOrderThreshold?: number; briefing?: string; humanTransferAvailable?: boolean; testMode?: boolean } & TurnDetectionOptions) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(args.callId)}/accept`, {
    method: 'POST', headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRealtimeSession(args))
  });
  if (!response.ok) throw new Error(`OpenAI accept failed (${response.status})`);
}

/**
 * La conferma scritta parte in sottofondo: se il provider SMS non è configurato o non risponde,
 * la telefonata non ne risente e la cosa resta scritta nei log.
 */
async function notifyCustomer(
  args: { restaurantId: string; restaurantName?: string; callerPhone?: string; store: Store },
  result: any,
  writeLog: (event: LogInput) => void
) {
  if (!smsConfigured() || !args.callerPhone || !result?.orderId) return;
  try {
    const order = (await args.store.listOrders(args.restaurantId)).find((candidate) => candidate.id === result.orderId);
    if (!order) return;
    const text = orderConfirmationText(order, args.restaurantName ?? 'Pizzeria', result.readyTime);
    if (!(await sendSms(args.callerPhone, text))) return;
    await args.store.markOrderNotified(order.id);
    writeLog({ source: 'BACKEND', level: 'INFO', message: `Conferma SMS inviata per ${order.orderNumber}` });
  } catch (error) {
    writeLog({ source: 'BACKEND', level: 'WARN', message: `Conferma SMS non inviata: ${error instanceof Error ? error.message : 'errore provider'}` });
  }
}

export function connectSideband(args: { callId: string; restaurantId: string; restaurantName?: string; callerPhone?: string; apiKey: string; store: Store; log?: (event: LogInput) => Promise<unknown> }) {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(args.callId)}`, { headers: { Authorization: `Bearer ${args.apiKey}` } });
  const writeLog = (event: LogInput) => { void args.log?.({ ...event, callId: event.callId ?? args.callId }).catch(() => undefined); };
  const engine = new OrderEngine(args.store, args.restaurantId, args.callId, args.callerPhone, args.log);
  const scheduler = new ResponseScheduler(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response.create' }));
  });
  let userSpeechStoppedAt: number | undefined;
  const closer = new CallCloser(() => {
    writeLog({ source: 'CALL', level: 'INFO', message: 'Chiusura chiamata dopo i saluti' });
    void hangupCall(args.callId, args.apiKey).catch(() => writeLog({ source: 'CALL', level: 'WARN', message: 'Chiusura chiamata non riuscita' }));
  }, hangupGraceMs());
  ws.on('open', () => {
    void args.store.markCallConnected(args.callId).catch(() => undefined);
    writeLog({ source: 'SIDEBAND', level: 'INFO', message: 'WebSocket connected' });
    writeLog({ source: 'CALL', level: 'INFO', message: 'Realtime media session established' });
    ws.send(JSON.stringify({ type: 'response.create' }));
  });
  ws.on('message', async (data) => {
    let event: any;
    try { event = JSON.parse(data.toString()); } catch { return; }
    if (event.type === 'response.created') {
      scheduler.responseCreated();
      return;
    }
    if (event.type === 'response.done') {
      scheduler.responseFinished();
      closer.responseFinished();
      const usage = usageFromEvent(event);
      if (usage) await args.store.addCallUsage(args.callId, usage);
      if (await args.store.getTestModeUntil(args.restaurantId)) {
        if (event.response?.status === 'cancelled') writeLog({ source: 'CALL', level: 'INFO', message: 'Barge-in: risposta interrotta dal cliente' });
        writeLog({ source: 'OPENAI', level: 'DEBUG', message: usage ? `Response completed (${usage.audioInputTokens + usage.audioOutputTokens} audio tokens)` : 'Response completed' });
      }
      return;
    }
    if (event.type === 'error') {
      writeLog({ source: 'OPENAI', level: 'ERROR', message: event.error?.message ?? 'Realtime error' });
      return;
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      scheduler.userSpeechStarted();
      closer.userSpeechStarted();
      if (await isTestMode(args.store, args.restaurantId)) writeLog({ source: 'CALL', level: 'DEBUG', message: 'User speech started' });
      return;
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      userSpeechStoppedAt = Date.now();
      if (await isTestMode(args.store, args.restaurantId)) writeLog({ source: 'CALL', level: 'DEBUG', message: 'User speech stopped' });
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed' && await isTestMode(args.store, args.restaurantId)) {
      writeLog({ source: 'USER', level: 'DEBUG', message: quotedTranscript(event.transcript) });
      return;
    }
    if (event.type === 'response.output_audio_transcript.delta' || event.type === 'response.audio_transcript.delta') {
      if (userSpeechStoppedAt && await isTestMode(args.store, args.restaurantId)) {
        writeLog({ source: 'CALL', level: 'INFO', message: `Risposta iniziata dopo ${Date.now() - userSpeechStoppedAt} ms` });
      }
      userSpeechStoppedAt = undefined;
      return;
    }
    if ((event.type === 'response.output_audio_transcript.done' || event.type === 'response.audio_transcript.done') && await isTestMode(args.store, args.restaurantId)) {
      writeLog({ source: 'AGENT', level: 'DEBUG', message: quotedTranscript(event.transcript) });
      return;
    }
    if (event.type !== 'response.function_call_arguments.done') return;
    scheduler.toolStarted();
    let output: unknown;
    let parsed: any;
    let closing = false;
    try {
      parsed = event.arguments ? JSON.parse(event.arguments) : {};
      if (event.name === 'end_call') {
        // Non passa dall'OrderEngine: è controllo della telefonata, non un'operazione sull'ordine.
        closing = closer.request();
        output = { ok: closing };
        writeLog({ source: 'TOOL', level: 'INFO', message: closing ? 'end_call accettato' : 'end_call rifiutato: ordine non concluso' });
      } else if (event.name === 'request_callback') {
        const phone = typeof parsed?.phone === 'string' && parsed.phone.trim() ? parsed.phone.trim() : args.callerPhone;
        const reason = typeof parsed?.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim().slice(0, 200) : 'richiesta dal cliente';
        await args.store.addCallback(args.restaurantId, { callId: args.callId, phone, reason });
        closer.allow();
        output = { ok: true, phoneOnFile: Boolean(phone) };
        writeLog({ source: 'TOOL', level: 'INFO', message: `request_callback registrato: ${reason}` });
      } else {
        const result = await engine.execute(event.name, parsed);
        output = toolOutputForModel(event.name, result);
        writeLog({ source: 'TOOL', level: 'INFO', message: toolMessage(event.name, parsed, result) });
        const state = orderStateMessage(result);
        if (state) writeLog({ source: 'ORDER', level: 'DEBUG', message: state });
        if (event.name === 'confirm_order') {
          closer.allow();
          void notifyCustomer(args, result, writeLog);
        }
        if (event.name === 'transfer_to_human') {
          closer.allow();
          if (process.env.HUMAN_TRANSFER_URI) await referCall(args.callId, process.env.HUMAN_TRANSFER_URI, args.apiKey);
        }
      }
    } catch (error) {
      output = { error: error instanceof Error ? error.message : 'Errore del backend' };
      writeLog({ source: 'TOOL', level: 'ERROR', message: `${event.name ?? 'unknown'} failed: ${error instanceof Error ? error.message : 'backend error'}` });
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output) } }));
    }
    scheduler.toolFinished(!closing);
  });
  ws.on('close', () => {
    closer.cancel();
    void args.store.finishCall(args.callId).catch(() => undefined);
    writeLog({ source: 'CALL', level: 'INFO', message: 'Call ended' });
    writeLog({ source: 'SIDEBAND', level: 'INFO', message: 'WebSocket closed' });
  });
  ws.on('error', () => writeLog({ source: 'SIDEBAND', level: 'ERROR', message: 'WebSocket error' }));
  return ws;
}

function toolMessage(name: string, input: any, output: any) {
  if (name === 'add_item') {
    const item = Array.isArray(output?.items) ? output.items.find((value: any) => value.itemId === input.item_id) : undefined;
    return `add_item ${item?.name ?? input.item_id ?? 'item'} x${input.quantity ?? 1}`;
  }
  if (name === 'search_menu') return `search_menu "${String(input?.query ?? '').slice(0, 60)}" → ${Array.isArray(output) ? output.length : 0} risultati`;
  if (name === 'get_menu') return `get_menu → ${Array.isArray(output) ? output.length : 0} prodotti`;
  if (name === 'update_item') return `update_item x${input?.quantity ?? '?'}`;
  if (name === 'set_customer_name') return `set_customer_name ${String(input?.name ?? '').slice(0, 40)}`;
  if (name === 'set_fulfillment') return `set_fulfillment ${input?.type ?? '?'}`;
  if (name === 'calculate_total' || name === 'get_order_summary') return `${name} → ${formatChf(output?.totalCents)}`;
  if (name === 'confirm_order') return `confirm_order ${output?.orderNumber ?? 'completed'} → ${formatChf(output?.totalCents)}`;
  return `${name} completed`;
}

function formatChf(cents: unknown) {
  return Number.isFinite(Number(cents)) ? `CHF ${(Number(cents) / 100).toFixed(2)}` : 'N/D';
}

/** Stato ordine compatto per i Live Logs: nessun dato personale oltre al nome già presente in dashboard. */
export function orderStateMessage(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !Array.isArray((result as any).items)) return undefined;
  const value = result as Record<string, any>;
  const quantity = value.items.reduce((sum: number, item: any) => sum + (Number(item?.quantity) || 0), 0);
  const parts = [`${value.items.length} righe`, `${quantity} pezzi`];
  if (value.fulfillment) parts.push(value.fulfillment);
  if (value.customerName) parts.push('nome ok');
  if (value.deliveryAddress) parts.push('indirizzo ok');
  return `Order state: ${parts.join(' · ')}`;
}

function usageFromEvent(event: any): CallUsage | undefined {
  const usage = event.response?.usage;
  if (!usage) return undefined;
  const input = usage.input_token_details ?? {};
  const output = usage.output_token_details ?? {};
  const audioInputTokens = finiteInt(input.audio_tokens);
  const audioOutputTokens = finiteInt(output.audio_tokens);
  const textInputTokens = finiteInt(input.text_tokens ?? Math.max(0, finiteInt(usage.input_tokens) - audioInputTokens));
  const textOutputTokens = finiteInt(output.text_tokens ?? Math.max(0, finiteInt(usage.output_tokens) - audioOutputTokens));
  return { audioInputTokens, audioOutputTokens, textInputTokens, textOutputTokens,
    openaiCostUsdMicros: Math.round(audioInputTokens * 10 + audioOutputTokens * 20 + textInputTokens * 0.6 + textOutputTokens * 2.4) };
}

function finiteInt(value: unknown) { return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0; }

function normalizeLargeOrderThreshold(value?: number) {
  return Number.isInteger(value) && Number(value) >= 2 ? Math.min(20, Number(value)) : defaultLargeOrderThreshold;
}

async function isTestMode(store: Store, restaurantId: string) {
  return Boolean(await store.getTestModeUntil(restaurantId));
}

function quotedTranscript(value: unknown) {
  const transcript = typeof value === 'string' ? value.trim() : '';
  return transcript ? `"${transcript.slice(0, 450)}"` : 'Transcript unavailable';
}

/** Pausa di cortesia fra il saluto e la chiusura. AUTO_HANGUP_SECONDS=0 disattiva la chiusura automatica. */
function hangupGraceMs() {
  const configured = Number(process.env.AUTO_HANGUP_SECONDS);
  if (!Number.isFinite(configured) || configured < 0) return 3000;
  return Math.min(15, configured) * 1000;
}

async function hangupCall(callId: string, apiKey: string) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) throw new Error(`OpenAI hangup failed (${response.status})`);
}

async function referCall(callId: string, targetUri: string, apiKey: string) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/refer`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ target_uri: targetUri })
  });
  if (!response.ok) throw new Error(`OpenAI refer failed (${response.status})`);
}
