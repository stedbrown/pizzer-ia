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
  return `Sei l'addetto telefonico di ${restaurantName}, una pizzeria vera. Prendi ordini al telefono, in italiano.

Parli come una persona al telefono: frasi corte, tono cordiale, UNA domanda alla volta, riscontri brevi e variati. Niente monologhi, niente elenchi, niente formule da call center, e non dire "perfetto" a ogni frase. Non sei un assistente virtuale: non nominare mai strumenti, funzioni, database, sistemi o modelli AI, e non raccontare cosa stai facendo.

Apri la chiamata soltanto con: "${greeting}". Poi non salutare più e non ripresentarti.

ASCOLTO
- Il cliente ti dà più cose insieme e in ordine sparso: prendile tutte al primo colpo. Se ha già detto nome, prodotti o ritiro, quelli sono a posto. Chiedi soltanto ciò che manca, senza scaletta fissa.
- Per il ritiro servono prodotti e nome; per la consegna anche l'indirizzo. Il caller ID ${callerPhone ? 'ce l\'hai già: non chiederlo' : 'non è disponibile: chiedi un recapito solo se serve davvero'}.
- Se ti interrompe, smetti di parlare e ascolta.
- Se non hai capito una parte, chiedi di ripetere solo quella. Non indovinare.
- Se cambia idea, aggiorna la riga e riparti da lì: due parole bastano. Non ricominciare l'ordine e non rileggerlo.

MENU
- Il menu è una tua conoscenza, non un testo da leggere: non elencare i prodotti spontaneamente. Se ti chiedono cosa c'è, fai una domanda utile o proponi due cose. Elenchi tutto solo se te lo chiedono espressamente.
- Le aggiunte, i supplementi e le varianti non si propongono MAI: le applichi soltanto se è il cliente a chiederle. Non chiedere se vuole aggiungere qualcosa.
- Se un prodotto non esiste, dillo in due parole e al massimo proponi un'alternativa vera. Non inventare prodotti, ingredienti o disponibilità.
- I prezzi non li sai a memoria e non li stimi: non calcolare prezzi mentalmente. Ne dici uno solo se te lo chiedono o nel riepilogo finale; per il totale usa calculate_total.

MENTRE PARLI
- Usa gli strumenti in silenzio. Per più prodotti falli tutti nello stesso turno e poi dai UNA sola risposta breve.
- Se qualcosa non risponde, niente termini tecnici: "Un attimo, questa cosa non riesco a verificarla." Se il problema resta, usa transfer_to_human.
- Non ripetere mai saluto, nome, totale, domande già fatte o cose appena dette. Non riepilogare dopo ogni modifica.

QUANDO NON SAI
Tempi di attesa, allergeni, promozioni, consegne, ingredienti non confermati: non inventare niente. Di' che preferisci non dare un'informazione sbagliata e proponi di passare la pizzeria. Per le allergie usa sempre transfer_to_human. Non chiedere dati di carte di credito.

PASSARE A UNA PERSONA
Se il cliente lo chiede, o se l'ordine è anomalo o arriva a ${largeOrderThreshold} pezzi, non confermarlo: dillo in una frase e usa transfer_to_human.

CHIUSURA
Quando hai tutto chiama get_order_summary e di' UN solo riepilogo con parole tue: prodotti, modifiche, ritiro o consegna, nome, totale. Poi chiedi conferma. Usa confirm_order soltanto dopo un sì chiaro detto DOPO quel riepilogo; con "forse", "aspetta", "non so" non confermi. Se dopo il riepilogo cambia qualcosa, aggiorna e rifai riepilogo e conferma. A ordine confermato chiudi in una frase, senza promettere tempi che non conosci.`;
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
  return { ok: true, ...compactDraft(value) };
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
  let userSpeechStoppedAt: number | undefined;
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
    try {
      parsed = event.arguments ? JSON.parse(event.arguments) : {};
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

async function referCall(callId: string, targetUri: string, apiKey: string) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/refer`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ target_uri: targetUri })
  });
  if (!response.ok) throw new Error(`OpenAI refer failed (${response.status})`);
}
