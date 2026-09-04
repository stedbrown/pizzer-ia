import WebSocket from 'ws';
import type { Store } from './store.js';
import { OrderEngine } from './order-engine.js';
import type { CallUsage, NewLiveLogEvent } from './types.js';

type LogInput = Omit<NewLiveLogEvent, 'category'> & { category?: NewLiveLogEvent['category'] };

const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function', name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false }
});

export const realtimeTools = [
  tool('get_menu', 'Conoscenza interna: menu e prezzi ufficiali. Non è un testo da leggere al cliente; per un prodotto citato usa search_menu.'),
  tool('search_menu', 'Cerca internamente prodotti reali nel menu. Preferiscilo quando il cliente nomina un prodotto o una categoria.', { query: { type: 'string' } }, ['query']),
  tool('start_order', 'Inizia o recupera la bozza ordine corrente.'),
  tool('add_item', 'Aggiunge un prodotto usando solo ID restituiti dal menu. Puoi chiamarlo più volte nello stesso turno per più prodotti, poi rispondi una sola volta.', { item_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 20 }, modifier_ids: { type: 'array', items: { type: 'string' } } }, ['item_id', 'quantity', 'modifier_ids']),
  tool('remove_item', 'Rimuove una riga dalla bozza usando il line_id.', { line_id: { type: 'string' } }, ['line_id']),
  tool('update_item', 'Aggiorna quantità o modificatori di una riga esistente. Usalo quando il cliente cambia idea, invece di ricominciare.', { line_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 20 }, modifier_ids: { type: 'array', items: { type: 'string' } } }, ['line_id']),
  tool('set_customer_name', 'Imposta il nome del cliente.', { name: { type: 'string' } }, ['name']),
  tool('set_fulfillment', 'Imposta ritiro o consegna.', { type: { type: 'string', enum: ['pickup', 'delivery'] } }, ['type']),
  tool('set_delivery_address', 'Imposta indirizzo completo per la consegna.', { address: { type: 'string' } }, ['address']),
  tool('calculate_total', 'Totale ufficiale calcolato dal backend. Chiamalo quando il cliente chiede quanto viene.'),
  tool('get_order_summary', 'Riepilogo ufficiale con totale; abilita la conferma successiva. Usalo una sola volta, subito prima della conferma finale.'),
  tool('confirm_order', 'Conferma solo dopo un sì esplicito del cliente, pronunciato dopo il riepilogo.', { confirmed: { type: 'boolean', const: true } }, ['confirmed']),
  tool('transfer_to_human', 'Passa la chiamata a una persona: se il cliente lo chiede, per allergie o informazioni non verificabili, oppure per ordini anomali.')
];

export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1';
export const DEFAULT_VOICE = 'marin';
const defaultGreeting = 'Pizzeria, buongiorno! Mi dica.';
const defaultLargeOrderThreshold = 20;

export interface VoiceAgentOptions {
  greeting?: string;
  largeOrderThreshold?: number;
}

export function centralistInstructions(restaurantName: string, callerPhone?: string, options: VoiceAgentOptions = {}) {
  const greeting = options.greeting?.trim() || defaultGreeting;
  const largeOrderThreshold = normalizeLargeOrderThreshold(options.largeOrderThreshold);
  return `RUOLO
Sei l'addetto telefonico di ${restaurantName}, una pizzeria vera. Rispondi tu al telefono e prendi gli ordini. Sei una persona che lavora lì: non dire mai di essere un assistente virtuale e non parlare mai di tool, funzioni, database, API, backend, JSON, sistemi o modelli AI.

COME PARLI
- Italiano parlato, cordiale, informale ma professionale. Frasi corte, da telefonata.
- Una risposta = una o due frasi. Normalmente UNA domanda alla volta.
- Riscontri brevi e variati: "Certo", "Va bene", "Ok", "Nessun problema", "Ci siamo", "Un attimo". Cambia formula: non dire "perfetto" a ogni frase.
- Niente monologhi, niente elenchi recitati, niente formule da call center.
- Se il cliente ti interrompe, smetti subito di parlare e ascolta. Non finire la frase.
- Se non hai capito, chiedi di ripetere solo il pezzo dubbio: "Scusi, l'ultima non l'ho presa bene, me la ripete?". Non indovinare quello che pensi abbia detto.

APERTURA
Apri la chiamata soltanto con: "${greeting}"
Poi non salutare più e non ripresentarti.

COME SUONA
Cliente: "Due Diavole e una Margherita senza mozzarella." → Tu: "Certo. Ritiro o consegna?"
Cliente: "Avete la Diavola?" → Tu: "Sì, ce l'abbiamo."
Cliente: "Quanto viene?" → Tu: "Diciassette franchi."
Cliente: "No aspetta, una Diavola sola." → Tu: "Va bene, una sola."
Cliente: "Ciao, come va? Senti, volevo prendere un paio di pizze." → Tu: "Bene grazie, mi dica pure."
Cliente: "Non so cosa prendere." → Tu: "Le va qualcosa di piccante o preferisce restare sul classico?"
Non dire mai cose come "Ho aggiunto l'articolo al carrello", "Sto consultando il database", "Secondo il menu disponibile", "Le opzioni disponibili sono", "Procederò ora con", "Come assistente virtuale".

ASCOLTO E CONTESTO
- Il cliente ti dà più informazioni insieme e in ordine sparso: prendile tutte al primo colpo. "Ciao, sono Stefano, due Diavole per ritiro" significa che nome, articoli e modalità sono già a posto.
- Non seguire una scaletta fissa e non fare domande di cui conosci già la risposta. Chiedi soltanto ciò che manca.
- Per il ritiro servono articoli e nome. Per la consegna servono articoli, nome e indirizzo.
- Il caller ID ${callerPhone ? 'è già disponibile al backend: non chiederlo' : 'non è disponibile: chiedi un recapito solo se serve davvero'}.
- Se cambia idea, aggiorna la riga con update_item o remove_item e riparti dal punto in cui eravate: "Va bene, una sola." Non ricominciare l'ordine da zero e non mostrare fastidio.

MENU
- Il menu è una tua conoscenza interna, non un testo da leggere. NON elencare spontaneamente tutto il menu.
- Se il cliente nomina un prodotto usa search_menu e rispondi corto: "Sì, ce l'abbiamo" oppure "Quella purtroppo non ce l'abbiamo".
- Se chiede cosa avete, non recitare il listino: fai una domanda utile (piccante, classica, vegetariana) oppure proponi due o tre cose pertinenti. Elenchi tutto solo se te lo chiede esplicitamente.
- Se un prodotto non esiste, dillo in due parole e proponi al massimo un'alternativa reale. Non inventare pizze, ingredienti, supplementi o disponibilità.

PREZZI
- I prezzi li decide la pizzeria, non tu: non calcolare prezzi mentalmente e non stimarli mai.
- Dici un prezzo solo se te lo chiedono, se serve per scegliere o nel riepilogo finale. Per il totale usa calculate_total.

STRUMENTI, INVISIBILI AL CLIENTE
- Usa gli strumenti in silenzio, senza annunciarli e senza raccontare cosa stai facendo.
- Registra subito tutto quello che il cliente ha detto: puoi usare più strumenti nello stesso turno, per esempio tre add_item per tre pizze, e poi dare UNA sola risposta breve.
- Se serve qualche istante di attesa: "Un attimo." Senza abusarne.
- Se uno strumento non risponde, niente termini tecnici: "Un attimo, questa cosa non riesco a verificarla." Se il problema resta, passa la chiamata con transfer_to_human.

NON RIPETERE
- NON ripetere saluto, nome del cliente, totale, una domanda già risposta o un'informazione appena detta.
- NON riepilogare dopo ogni aggiunta o correzione: dopo una modifica bastano due parole.
- Il riepilogo completo si fa UNA volta sola, prima della conferma finale, oppure se il cliente lo chiede.

QUANDO NON SAI
- Tempi di attesa, allergeni, consegne, promozioni, ingredienti non confermati: non inventare niente. Di': "Su questo preferisco non dirle una cosa sbagliata, se vuole la passo in pizzeria." e usa transfer_to_human se accetta.
- Per le allergie non dare garanzie sanitarie: serve la pizzeria, usa transfer_to_human.
- Non chiedere e non accettare dati di carte di credito.

PASSAGGIO A UNA PERSONA
- Se chiede di parlare con qualcuno: "Certo, un momento." e usa subito transfer_to_human.
- Se la richiesta è anomala o arriva a ${largeOrderThreshold} pezzi, non confermarla: "Per un ordine così grande preferisco passarla direttamente alla pizzeria. Un momento." e usa transfer_to_human.

CHIUSURA
- Quando hai tutto chiama get_order_summary e pronuncia UN solo riepilogo scorrevole, come lo direbbe una persona: "Allora, una Diavola e una Margherita senza mozzarella, per ritiro a nome Stefano. Totale trentuno franchi. Conferma?"
- Usa confirm_order soltanto dopo un sì inequivocabile detto DOPO quel riepilogo: "sì", "confermo", "esatto", "va bene".
- Con "forse", "aspetta", "non so", "fammi pensare" non confermare: aspetta.
- Se dopo il riepilogo cambia qualcosa, aggiorna, richiama get_order_summary e chiedi di nuovo conferma.
- A ordine confermato chiudi in una frase breve, senza promettere tempi che non conosci, e non rileggere l'ordine.`;
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

export function buildRealtimeSession(args: { restaurantName: string; callerPhone?: string; model: string; voice: string; greeting?: string; largeOrderThreshold?: number; testMode?: boolean } & TurnDetectionOptions) {
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

const MENU_HINT = 'Conoscenza interna. Non leggere questo elenco al cliente: rispondi in una frase breve e proponi al massimo due o tre cose.';
const DRAFT_HINT = 'Registrato. Dai un riscontro brevissimo e continua: niente riepilogo, niente prezzi, niente totale.';

/**
 * Riduce l'output dei tool a ciò che serve al modello per parlare bene.
 * Le mutazioni non restituiscono prezzi né totale: erano la causa del riepilogo ripetuto a ogni modifica.
 * Il backend resta l'unica fonte di verità: qui non si calcola nulla, si filtra soltanto.
 */
export function toolOutputForModel(name: string, result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  if (name === 'get_menu' || name === 'search_menu') {
    const items = Array.isArray(result) ? result : [];
    return { items: items.map(compactMenuItem), hint: MENU_HINT };
  }
  const value = result as Record<string, any>;
  if (name === 'confirm_order') {
    return { ...value, hint: 'Ordine registrato. Chiudi con una frase breve, senza promettere tempi e senza rileggere l\'ordine.' };
  }
  if (name === 'transfer_to_human') {
    return { ...value, hint: 'Di\' soltanto "Certo, un momento." e smetti di prendere l\'ordine.' };
  }
  if (name === 'get_order_summary') {
    return { ...compactDraft(value), totalCents: value.totalCents, currency: value.currency,
      hint: 'Riepiloga UNA sola volta con parole tue, in modo scorrevole, e chiudi con "Conferma?". Non elencare i prezzi riga per riga.' };
  }
  if (name === 'calculate_total') {
    return { ...compactDraft(value), totalCents: value.totalCents, currency: value.currency,
      hint: 'Comunica solo il totale, in una frase breve.' };
  }
  if (!Array.isArray(value.items)) return result;
  return { ok: true, ...compactDraft(value), hint: DRAFT_HINT };
}

function compactMenuItem(item: any) {
  return {
    id: item?.id, name: item?.name, priceCents: item?.priceCents,
    ...(item?.description ? { description: String(item.description).slice(0, 160) } : {}),
    ...(Array.isArray(item?.modifiers) && item.modifiers.length
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
  toolFinished() { this.pending = Math.max(0, this.pending - 1); this.owed = !this.userTurn; this.flush(); }
  /** Il cliente sta parlando: risponderà il VAD, non dobbiamo accodare un turno nostro sopra il suo. */
  userSpeechStarted() { this.owed = false; this.userTurn = true; }

  private flush() {
    if (!this.owed || this.active || this.pending > 0) return;
    this.owed = false;
    this.send();
  }
}

export async function acceptRealtimeCall(args: { callId: string; restaurantName: string; callerPhone?: string; apiKey: string; model: string; voice: string; greeting?: string; largeOrderThreshold?: number; testMode?: boolean } & TurnDetectionOptions) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(args.callId)}/accept`, {
    method: 'POST', headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRealtimeSession(args))
  });
  if (!response.ok) throw new Error(`OpenAI accept failed (${response.status})`);
}

export function connectSideband(args: { callId: string; restaurantId: string; callerPhone?: string; apiKey: string; store: Store; log?: (event: LogInput) => Promise<unknown> }) {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(args.callId)}`, { headers: { Authorization: `Bearer ${args.apiKey}` } });
  const writeLog = (event: LogInput) => { void args.log?.({ ...event, callId: event.callId ?? args.callId }).catch(() => undefined); };
  const engine = new OrderEngine(args.store, args.restaurantId, args.callId, args.callerPhone, args.log);
  const scheduler = new ResponseScheduler(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response.create' }));
  });
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
      const usage = usageFromEvent(event);
      if (usage) await args.store.addCallUsage(args.callId, usage);
      if (await args.store.getTestModeUntil(args.restaurantId)) writeLog({ source: 'OPENAI', level: 'DEBUG', message: usage ? `Response completed (${usage.audioInputTokens + usage.audioOutputTokens} audio tokens)` : 'Response completed' });
      return;
    }
    if (event.type === 'error') {
      writeLog({ source: 'OPENAI', level: 'ERROR', message: event.error?.message ?? 'Realtime error' });
      return;
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      scheduler.userSpeechStarted();
      if (await isTestMode(args.store, args.restaurantId)) writeLog({ source: 'CALL', level: 'DEBUG', message: 'User speech started' });
      return;
    }
    if (event.type === 'input_audio_buffer.speech_stopped' && await isTestMode(args.store, args.restaurantId)) {
      writeLog({ source: 'CALL', level: 'DEBUG', message: 'User speech stopped' });
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed' && await isTestMode(args.store, args.restaurantId)) {
      writeLog({ source: 'USER', level: 'DEBUG', message: quotedTranscript(event.transcript) });
      return;
    }
    if ((event.type === 'response.output_audio_transcript.done' || event.type === 'response.audio_transcript.done') && await isTestMode(args.store, args.restaurantId)) {
      writeLog({ source: 'OPENAI', level: 'DEBUG', message: quotedTranscript(event.transcript) });
      return;
    }
    if (event.type !== 'response.function_call_arguments.done') return;
    scheduler.toolStarted();
    let output: unknown;
    let parsed: any;
    try {
      parsed = event.arguments ? JSON.parse(event.arguments) : {};
      writeLog({ source: 'TOOL', level: 'DEBUG', message: `${event.name ?? 'unknown'} called` });
      const result = await engine.execute(event.name, parsed);
      output = toolOutputForModel(event.name, result);
      writeLog({ source: 'TOOL', level: 'INFO', message: toolMessage(event.name, parsed, result) });
      const state = orderStateMessage(result);
      if (state) writeLog({ source: 'ORDER', level: 'DEBUG', message: state });
      if (event.name === 'transfer_to_human' && process.env.HUMAN_TRANSFER_URI) {
        await referCall(args.callId, process.env.HUMAN_TRANSFER_URI, args.apiKey);
      }
    } catch (error) {
      output = { error: error instanceof Error ? error.message : 'Errore del backend' };
      writeLog({ source: 'TOOL', level: 'ERROR', message: `${event.name ?? 'unknown'} failed: ${error instanceof Error ? error.message : 'backend error'}` });
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output) } }));
    }
    scheduler.toolFinished();
  });
  ws.on('close', () => {
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
  if (name === 'confirm_order') return `confirm_order ${output?.orderNumber ?? 'completed'}`;
  return `${name} completed`;
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

async function referCall(callId: string, targetUri: string, apiKey: string) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/refer`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ target_uri: targetUri })
  });
  if (!response.ok) throw new Error(`OpenAI refer failed (${response.status})`);
}
