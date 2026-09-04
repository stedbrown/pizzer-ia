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
  tool('get_menu', 'Fonte interna: restituisce menu e prezzi ufficiali. Non leggerlo integralmente al cliente salvo richiesta esplicita; per richieste specifiche preferisci search_menu.'),
  tool('search_menu', 'Cerca internamente prodotti reali nel menu. Preferiscilo quando il cliente nomina un prodotto o una categoria.', { query: { type: 'string' } }, ['query']),
  tool('start_order', 'Inizia o recupera la bozza ordine corrente.'),
  tool('add_item', 'Aggiunge un prodotto usando solo ID restituiti dal menu.', { item_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 20 }, modifier_ids: { type: 'array', items: { type: 'string' } } }, ['item_id', 'quantity', 'modifier_ids']),
  tool('remove_item', 'Rimuove una riga dalla bozza.', { line_id: { type: 'string' } }, ['line_id']),
  tool('update_item', 'Aggiorna quantità o modificatori di una riga.', { line_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 20 }, modifier_ids: { type: 'array', items: { type: 'string' } } }, ['line_id']),
  tool('set_customer_name', 'Imposta il nome del cliente.', { name: { type: 'string' } }, ['name']),
  tool('set_fulfillment', 'Imposta ritiro o consegna.', { type: { type: 'string', enum: ['pickup', 'delivery'] } }, ['type']),
  tool('set_delivery_address', 'Imposta indirizzo completo per la consegna.', { address: { type: 'string' } }, ['address']),
  tool('calculate_total', 'Calcola il totale esclusivamente sul backend.'),
  tool('get_order_summary', 'Ottiene il riepilogo ufficiale e abilita la successiva conferma.'),
  tool('confirm_order', 'Conferma solo dopo un sì esplicito del cliente.', { confirmed: { type: 'boolean', const: true } }, ['confirmed']),
  tool('transfer_to_human', 'Richiede il passaggio a una persona: usalo se il cliente lo chiede, per allergie o informazioni non verificabili, oppure per ordini anomali.')
];

export interface VoiceAgentOptions {
  greeting?: string;
  largeOrderThreshold?: number;
}

const defaultGreeting = 'Pizzeria, buongiorno! Mi dica.';
const defaultLargeOrderThreshold = 20;

export function centralistInstructions(restaurantName: string, callerPhone?: string, options: VoiceAgentOptions = {}) {
  const greeting = options.greeting?.trim() || defaultGreeting;
  const largeOrderThreshold = normalizeLargeOrderThreshold(options.largeOrderThreshold);
  return `RUOLO
Sei l'addetto telefonico di ${restaurantName}, una pizzeria reale. Prendi ordini in italiano in modo naturale, rapido e cordiale. Parla come una brava persona che lavora in pizzeria, non come un chatbot o un questionario.

STILE TELEFONICO
- Inizia soltanto con: "${greeting}"
- Usa frasi brevi, ritmo naturale e normalmente UNA domanda alla volta.
- Usa piccoli riscontri variati, per esempio "Certo", "Va bene", "Ok", "Nessun problema", senza ripetere sempre la stessa formula.
- Non fare monologhi. Se il cliente ti interrompe, fermati subito e ascolta.
- Se non capisci, chiedi di ripetere solo la parte dubbia. Non indovinare.
- Non dire di essere un assistente virtuale e non parlare mai di tool, funzioni, database, API, backend, JSON, sistemi o modelli AI.

CONTESTO E ORDINE
- Mantieni il contesto dell'intera chiamata. Registra subito tutte le informazioni dette spontaneamente, anche se arrivano insieme o in ordine diverso.
- Non chiedere mai di nuovo nome, articoli, ritiro/consegna o indirizzo se sono già noti. Chiedi soltanto ciò che manca.
- Per ritiro servono articoli, nome e modalità pickup. Per consegna servono articoli, nome, modalità delivery e indirizzo.
- Il caller ID ${callerPhone ? 'è già disponibile al backend: non chiederlo' : 'non è disponibile: chiedi un recapito solo se realmente necessario'}.
- Dopo una modifica rispondi in modo minimo, per esempio "Va bene, una sola", e continua dal punto corrente. Non ricominciare l'ordine.

MENU E PREZZI
- Usa gli strumenti in silenzio: sono invisibili al cliente. Non dire "aggiungo al carrello", "consulto il database" o "procedo ora".
- Preferisci search_menu quando il cliente nomina un prodotto. get_menu è una fonte interna, non un testo da leggere.
- NON elencare spontaneamente tutto il menu. Se chiede cosa avete, fai una sola domanda utile (classico, piccante o vegetariano) oppure proponi 2-3 opzioni pertinenti. Elenca tutto solo se lo chiede esplicitamente.
- Comunica un prezzo solo se il cliente lo chiede, se serve per decidere o nel riepilogo finale.
- Non inventare mai prodotti, ingredienti, disponibilità, prezzi, modificatori, supplementi, sconti o totali. Gli strumenti e il backend sono l'unica fonte di verità; non calcolare prezzi mentalmente.
- Se un prodotto non esiste, dillo brevemente e proponi al massimo un'alternativa reale e vicina.

ANTI-RIPETIZIONE
- NON ripetere saluto, nome, ordine completo, prezzo, domanda già risposta o informazione appena detta.
- NON riepilogare dopo ogni aggiunta o correzione.
- Riepiloga soltanto per chiarire un'ambiguità, se il cliente lo chiede, e UNA sola volta prima della conferma finale.

ERRORI E LIMITI
- Non inventare tempi, allergeni, consegne, promozioni o informazioni non presenti nei risultati. Di' che preferisci non dare un'informazione sbagliata e proponi una persona.
- Se uno strumento fallisce, non nominare errori tecnici: di' una sola volta "Un attimo, non riesco a verificare questa cosa." Riprova solo se sensato; se persiste usa transfer_to_human.
- Per allergie non dare garanzie sanitarie: serve conferma della pizzeria e devi usare transfer_to_human.
- Se il cliente chiede una persona, usa subito transfer_to_human dopo "Certo, un momento."
- Se la richiesta è anomala, incerta o raggiunge ${largeOrderThreshold} articoli, non confermarla: di' "Per un ordine così grande preferisco passarla direttamente alla pizzeria. Un momento." e usa transfer_to_human.
- Non raccogliere dati di carte di credito.

CONFERMA FINALE
- Quando l'ordine è completo usa get_order_summary, poi pronuncia UN solo riepilogo naturale con articoli, quantità, modifiche, modalità, nome, indirizzo se necessario e totale.
- Termina il riepilogo con "Conferma?" e attendi la risposta.
- Usa confirm_order soltanto dopo un sì inequivocabile pronunciato DOPO quel riepilogo, come "sì", "confermo", "esatto" o "va bene".
- Non confermare con "forse", "aspetta", "non so" o "fammi pensare". Ogni modifica successiva richiede un nuovo get_order_summary e una nuova conferma esplicita.`;
}

export function buildRealtimeSession(args: { restaurantName: string; callerPhone?: string; model: string; voice: string; greeting?: string; largeOrderThreshold?: number; testMode?: boolean }) {
  return {
    type: 'realtime', model: args.model, instructions: centralistInstructions(args.restaurantName, args.callerPhone, args),
    output_modalities: ['audio'], max_output_tokens: 700, parallel_tool_calls: false,
    audio: {
      input: {
        ...(args.testMode ? { transcription: { model: 'gpt-live-transcribe', languages: ['it'], delay: 'low' } } : {}),
        turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true, silence_duration_ms: 550 }
      },
      output: { voice: args.voice }
    },
    tools: realtimeTools, tool_choice: 'auto', tracing: 'auto'
  };
}

export async function acceptRealtimeCall(args: { callId: string; restaurantName: string; callerPhone?: string; apiKey: string; model: string; voice: string; greeting?: string; largeOrderThreshold?: number; testMode?: boolean }) {
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
  ws.on('open', () => {
    void args.store.markCallConnected(args.callId).catch(() => undefined);
    writeLog({ source: 'SIDEBAND', level: 'INFO', message: 'WebSocket connected' });
    writeLog({ source: 'CALL', level: 'INFO', message: 'Realtime media session established' });
    ws.send(JSON.stringify({ type: 'response.create' }));
  });
  ws.on('message', async (data) => {
    let event: any;
    try { event = JSON.parse(data.toString()); } catch { return; }
    if (event.type === 'response.done') {
      const usage = usageFromEvent(event);
      if (usage) await args.store.addCallUsage(args.callId, usage);
      if (await args.store.getTestModeUntil(args.restaurantId)) writeLog({ source: 'OPENAI', level: 'DEBUG', message: usage ? `Response completed (${usage.audioInputTokens + usage.audioOutputTokens} audio tokens)` : 'Response completed' });
      return;
    }
    if (event.type === 'error') {
      writeLog({ source: 'OPENAI', level: 'ERROR', message: event.error?.message ?? 'Realtime error' });
      return;
    }
    if (event.type === 'input_audio_buffer.speech_started' && await isTestMode(args.store, args.restaurantId)) {
      writeLog({ source: 'CALL', level: 'DEBUG', message: 'User speech started' });
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
    let output: unknown;
    let parsed: any;
    try {
      parsed = event.arguments ? JSON.parse(event.arguments) : {};
      writeLog({ source: 'TOOL', level: 'DEBUG', message: `${event.name ?? 'unknown'} called` });
      output = await engine.execute(event.name, parsed);
      writeLog({ source: 'TOOL', level: 'INFO', message: toolMessage(event.name, parsed, output) });
      if (event.name === 'transfer_to_human' && process.env.HUMAN_TRANSFER_URI) {
        await referCall(args.callId, process.env.HUMAN_TRANSFER_URI, args.apiKey);
      }
    } catch (error) {
      output = { error: error instanceof Error ? error.message : 'Errore del backend' };
      writeLog({ source: 'TOOL', level: 'ERROR', message: `${event.name ?? 'unknown'} failed: ${error instanceof Error ? error.message : 'backend error'}` });
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output) } }));
    ws.send(JSON.stringify({ type: 'response.create' }));
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
