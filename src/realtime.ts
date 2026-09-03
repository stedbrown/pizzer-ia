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
  tool('get_menu', 'Restituisce il menu attivo e i prezzi ufficiali dal backend.'),
  tool('search_menu', 'Cerca prodotti reali nel menu.', { query: { type: 'string' } }, ['query']),
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
  tool('transfer_to_human', 'Trasferisce a una persona quando richiesto o per allergie importanti.')
];

export function centralistInstructions(restaurantName: string, callerPhone?: string) {
  return `Sei l'assistente virtuale AI di ${restaurantName}. Parla in italiano naturale, cortese, veloce e non prolisso.
Presentati subito: "Pizzeria, buongiorno! Sono l'assistente virtuale. Cosa desidera ordinare?"
Ti occupi esclusivamente di ordini. Non inventare mai piatti, ingredienti, disponibilità, prezzi, supplementi o sconti: usa sempre i tool e considera i risultati del backend unica fonte di verità.
Usa get_menu o search_menu, poi start_order e i tool di modifica. Chiedi ritiro o consegna. Per ritiro raccogli il nome; per consegna raccogli nome e indirizzo. Il caller ID ${callerPhone ? 'è già disponibile al backend' : 'non è disponibile'}.
Prima della conferma usa get_order_summary, leggi prodotti, quantità, modifiche, modalità, indirizzo se necessario e totale, poi chiedi esattamente "Conferma l'ordine?". Usa confirm_order soltanto dopo un sì inequivocabile pronunciato dopo il riepilogo.
Se viene richiesta una persona usa transfer_to_human. Per allergie non dare garanzie sanitarie: spiega che serve conferma della pizzeria e prova a trasferire. Non raccogliere carte di credito.`;
}

export async function acceptRealtimeCall(args: { callId: string; restaurantName: string; callerPhone?: string; apiKey: string; model: string; voice: string }) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(args.callId)}/accept`, {
    method: 'POST', headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'realtime', model: args.model, instructions: centralistInstructions(args.restaurantName, args.callerPhone),
      output_modalities: ['audio'], max_output_tokens: 700, parallel_tool_calls: false,
      audio: {
        input: { turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true, silence_duration_ms: 550 } },
        output: { voice: args.voice }
      },
      tools: realtimeTools, tool_choice: 'auto', tracing: 'auto'
    })
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
    if (event.type === 'input_audio_buffer.speech_started' && await args.store.getTestModeUntil(args.restaurantId)) {
      writeLog({ source: 'CALL', level: 'DEBUG', message: 'Caller speech started' });
      return;
    }
    if (event.type !== 'response.function_call_arguments.done') return;
    let output: unknown;
    let parsed: any;
    try {
      parsed = event.arguments ? JSON.parse(event.arguments) : {};
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

async function referCall(callId: string, targetUri: string, apiKey: string) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/refer`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ target_uri: targetUri })
  });
  if (!response.ok) throw new Error(`OpenAI refer failed (${response.status})`);
}
