import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRealtimeSession, buildTurnDetection, CallCloser, centralistInstructions, DEFAULT_REALTIME_MODEL, DEFAULT_VOICE,
  orderStateMessage, realtimeTools, ResponseScheduler, supportsParallelToolCalls, toolOutputForModel
} from '../src/realtime.js';

const draftResult = {
  items: [
    { lineId: 'line-1', itemId: 'item-1', name: 'Diavola', quantity: 2, modifiers: [], unitPriceCents: 1700, lineTotalCents: 3400 },
    { lineId: 'line-2', itemId: 'item-2', name: 'Margherita', quantity: 1, modifiers: [{ id: 'mod-1', name: 'senza mozzarella', priceCents: 0 }], unitPriceCents: 1400, lineTotalCents: 1400 }
  ],
  totalCents: 4800, currency: 'CHF' as const,
  customerName: 'Stefano', phone: '***9999', fulfillment: 'pickup' as const, deliveryAddress: undefined, confirmedOrderId: undefined
};

describe('Realtime voice agent', () => {
  it('keeps every existing order tool available', () => {
    expect(realtimeTools.map((tool) => tool.name)).toEqual([
      'get_menu', 'search_menu', 'start_order', 'add_item', 'remove_item', 'update_item',
      'set_customer_name', 'set_fulfillment', 'set_delivery_address', 'calculate_total',
      'get_order_summary', 'confirm_order', 'transfer_to_human', 'end_call'
    ]);
  });

  it('tells the agent to greet before hanging up', () => {
    const prompt = centralistInstructions('Pizzeria Test');
    expect(prompt).toContain('prima il saluto, poi end_call');
    expect(prompt).toContain('mai mentre il cliente sta ancora parlando');
  });

  it('uses a natural short greeting and strong conversational rules', () => {
    const prompt = centralistInstructions('Pizzeria Test', '+41910000000');
    expect(prompt).toContain('Sei l\'addetto telefonico di Pizzeria Test');
    expect(prompt).toContain('Pizzeria, buongiorno! Mi dica.');
    expect(prompt).toContain('UNA domanda alla volta');
    expect(prompt).toContain('Chiedi soltanto ciò che manca');
    expect(prompt).toContain('non elencare i prodotti spontaneamente');
    expect(prompt).toContain('Non riepilogare dopo ogni modifica');
    expect(prompt).toContain('non calcolare prezzi mentalmente');
    expect(prompt).toContain('confirm_order soltanto dopo un sì chiaro');
    expect(prompt).toContain('Il caller ID ce l\'hai già: non chiederlo');
    expect(prompt).not.toContain('Sono l\'assistente virtuale');
  });

  it('covers the manual call scenarios without scripted lines the agent can parrot', () => {
    const prompt = centralistInstructions('Pizzeria Test');
    expect(prompt).toContain('Chiedi soltanto ciò che manca');                            // A e F: niente questionario
    expect(prompt).toContain('Se cambia idea, aggiorna la riga');                         // B
    expect(prompt).toContain('Non inventare prodotti');                                   // C
    expect(prompt).toContain('fai una domanda utile o proponi due cose');                 // D
    expect(prompt).toContain('Se ti interrompe, smetti di parlare e ascolta');            // E
    expect(prompt).toContain('usa transfer_to_human');                                    // G e H
    expect(prompt).toContain('non è disponibile: chiedi un recapito solo se serve davvero');
    expect(prompt).not.toMatch(/Cliente: ".*" → Tu:/);
    expect(prompt.split('\n').length).toBeLessThan(45);   // guardia anti-bloat: era 70 righe e le ignorava
  });

  it('never proposes add-ons on its own', () => {
    expect(centralistInstructions('Pizzeria Test')).toContain('non si propongono MAI');
  });

  it('fixes what the first real call got wrong', () => {
    const prompt = centralistInstructions('Pizzeria Test');
    expect(prompt).toContain('Dai sempre del LEI');                                   // register misto tu/lei
    expect(prompt).toContain('MAI ANNUNCIARE QUELLO CHE STAI PER FARE');              // "preparo il riepilogo..."
    expect(prompt).toContain('Non dedurre e non dare per scontato niente');           // set_fulfillment inventato
    expect(prompt).toContain('Ritiro o consegna lo chiedi quando ha finito');         // domanda troppo presto
    expect(prompt).toContain('nome di battesimo');                                    // "Stefano Vananti"
  });

  it('supports configurable greeting and large-order fallback', () => {
    const prompt = centralistInstructions('Pizzeria Test', undefined, { greeting: 'Pizzeria, buonasera! Cosa le preparo?', largeOrderThreshold: 12 });
    expect(prompt).toContain('Pizzeria, buonasera! Cosa le preparo?');
    expect(prompt).toContain('arriva a 12 pezzi');                                        // G: ordine assurdo
    expect(prompt).toContain('usa transfer_to_human');
  });

  it('defaults to the full realtime model and keeps mini selectable', () => {
    expect(DEFAULT_REALTIME_MODEL).toBe('gpt-realtime-2.1');
    expect(DEFAULT_VOICE).toBe('marin');
    expect(buildRealtimeSession({ restaurantName: 'Pizzeria Test', model: 'gpt-realtime-2.1-mini', voice: 'cedar' }))
      .toMatchObject({ model: 'gpt-realtime-2.1-mini', parallel_tool_calls: true, audio: { output: { voice: 'cedar' } } });
    expect(supportsParallelToolCalls('gpt-realtime-1.5')).toBe(false);
    expect(buildRealtimeSession({ restaurantName: 'Pizzeria Test', model: 'gpt-realtime-1.5', voice: 'marin' }).parallel_tool_calls).toBe(false);
  });

  it('keeps the proven server_vad barge-in settings by default', () => {
    const session = buildRealtimeSession({ restaurantName: 'Pizzeria Test', model: DEFAULT_REALTIME_MODEL, voice: 'marin' });
    expect(session.audio.input.turn_detection).toEqual({ type: 'server_vad', create_response: true, interrupt_response: true, silence_duration_ms: 550 });
    expect(session.audio.input).not.toHaveProperty('transcription');
  });

  it('can switch to semantic turn detection for the A/B test', () => {
    expect(buildTurnDetection({ turnDetection: 'semantic_vad' })).toEqual({ type: 'semantic_vad', create_response: true, interrupt_response: true, eagerness: 'medium' });
    expect(buildTurnDetection({ turnDetection: 'semantic_vad', vadEagerness: 'low' })).toMatchObject({ eagerness: 'low' });
    expect(buildTurnDetection({ turnDetection: 'semantic_vad', vadEagerness: 'nonsense' })).toMatchObject({ eagerness: 'medium' });
    expect(buildTurnDetection({ turnDetection: 'boh' })).toMatchObject({ type: 'server_vad' });
  });

  it('enables user transcription only for the time-limited test mode', () => {
    const session = buildRealtimeSession({ restaurantName: 'Pizzeria Test', model: 'gpt-realtime-2.1-mini', voice: 'marin', testMode: true });
    expect(session.audio.input).toMatchObject({ transcription: { model: 'gpt-live-transcribe', languages: ['it'], delay: 'low' } });
  });
});

describe('Tool output shaping', () => {
  it('answers an order change with what is still missing, not with the order', () => {
    const output: any = toolOutputForModel('add_item', { ...draftResult, fulfillment: undefined });
    expect(output).toEqual({ ok: true, missing: ['ritiro o consegna'] });
    expect(JSON.stringify(output)).not.toContain('Margherita');
    expect(JSON.stringify(output)).not.toContain('4800');
  });

  it('lists every field the agent still has to ask for', () => {
    expect(toolOutputForModel('set_customer_name', { items: [], customerName: 'Stefano' }))
      .toEqual({ ok: true, missing: ['prodotti', 'ritiro o consegna'] });
    expect(toolOutputForModel('set_fulfillment', { ...draftResult, fulfillment: 'delivery', deliveryAddress: undefined }))
      .toEqual({ ok: true, missing: ['indirizzo'] });
    expect(toolOutputForModel('set_delivery_address', { ...draftResult, fulfillment: 'delivery', deliveryAddress: 'Via Test 1' }))
      .toEqual({ ok: true, missing: [] });
  });

  it('puts no spoken instructions inside tool results', () => {
    // Il modello legge ad alta voce il testo che riceve: nei risultati non deve finire prosa.
    for (const name of ['add_item', 'get_order_summary', 'calculate_total', 'confirm_order', 'transfer_to_human', 'search_menu', 'get_menu']) {
      const payload = JSON.stringify(toolOutputForModel(name, name.endsWith('_menu') ? [] : draftResult));
      expect(payload).not.toMatch(/hint|instruction/i);
    }
  });

  it('hands back the line ids only when the agent rereads the draft', () => {
    const output: any = toolOutputForModel('start_order', draftResult);
    expect(output).not.toHaveProperty('hint');
    expect(output.lines).toEqual([
      { line_id: 'line-1', name: 'Diavola', quantity: 2 },
      { line_id: 'line-2', name: 'Margherita', quantity: 1, modifiers: ['senza mozzarella'] }
    ]);
    expect(output.customerName).toBe('Stefano');
    expect(output.fulfillment).toBe('pickup');
    expect(output.deliveryAddress).toBeNull();
  });

  it('exposes the total only where the customer is meant to hear it', () => {
    expect(toolOutputForModel('calculate_total', draftResult)).toMatchObject({ totalCents: 4800, currency: 'CHF' });
    const summary: any = toolOutputForModel('get_order_summary', { ...draftResult, instruction: 'Leggi questo riepilogo al cliente e chiedi: Conferma l\'ordine?' });
    expect(summary.totalCents).toBe(4800);
    expect(summary).not.toHaveProperty('instruction');
  });

  it('hides the add-ons while browsing and reveals them only on a targeted search', () => {
    const item = { id: 'item-1', name: 'Diavola', priceCents: 1700, description: 'piccante', active: true, restaurantId: 'r', modifiers: [{ id: 'mod-1', name: 'senza mozzarella', priceCents: 0, active: true }] };
    const browsed: any = toolOutputForModel('get_menu', [item]);
    expect(browsed.items[0]).toEqual({ id: 'item-1', name: 'Diavola', priceCents: 1700, description: 'piccante' });
    const searched: any = toolOutputForModel('search_menu', [item]);
    expect(searched.items[0].modifiers).toEqual([{ id: 'mod-1', name: 'senza mozzarella' }]);
  });

  it('keeps confirmation and transfer results intact', () => {
    expect(toolOutputForModel('confirm_order', { orderNumber: 'A-12', totalCents: 4800, status: 'CONFIRMED' }))
      .toMatchObject({ orderNumber: 'A-12', totalCents: 4800, status: 'CONFIRMED' });
    expect(toolOutputForModel('transfer_to_human', { available: true, message: 'Trasferimento in corso' }))
      .toEqual({ available: true, message: 'Trasferimento in corso' });
    expect(toolOutputForModel('add_item', { error: 'Articolo non disponibile: item-9' })).toEqual({ error: 'Articolo non disponibile: item-9' });
  });

  it('summarises the order state for the live logs without personal data', () => {
    expect(orderStateMessage(draftResult)).toBe('Order state: 2 righe · 3 pezzi · pickup · nome ok');
    expect(orderStateMessage({ available: true })).toBeUndefined();
  });
});

describe('CallCloser', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const closerWith = (graceMs = 3000) => { const hangup = vi.fn(); return { hangup, closer: new CallCloser(hangup, graceMs) }; };

  it('never hangs up before the order is concluded', () => {
    const { hangup, closer } = closerWith();
    expect(closer.request()).toBe(false);
    closer.responseFinished();
    vi.advanceTimersByTime(10_000);
    expect(hangup).not.toHaveBeenCalled();
  });

  it('waits for the goodbye to finish, then closes', () => {
    const { hangup, closer } = closerWith();
    closer.allow();
    expect(closer.request()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(hangup).not.toHaveBeenCalled();   // sta ancora salutando
    closer.responseFinished();
    vi.advanceTimersByTime(2_999);
    expect(hangup).not.toHaveBeenCalled();   // pausa di cortesia
    vi.advanceTimersByTime(1);
    expect(hangup).toHaveBeenCalledTimes(1);
  });

  it('stays on the line if the customer speaks again', () => {
    const { hangup, closer } = closerWith();
    closer.allow();
    closer.request();
    closer.responseFinished();
    vi.advanceTimersByTime(1_000);
    closer.userSpeechStarted();
    vi.advanceTimersByTime(30_000);
    expect(hangup).not.toHaveBeenCalled();
    closer.responseFinished();
    vi.advanceTimersByTime(30_000);
    expect(hangup).not.toHaveBeenCalled();   // serve un nuovo end_call
  });

  it('can be switched off entirely', () => {
    const { hangup, closer } = closerWith(0);
    closer.allow();
    expect(closer.request()).toBe(false);
    closer.responseFinished();
    vi.advanceTimersByTime(30_000);
    expect(hangup).not.toHaveBeenCalled();
  });

  it('drops a pending close when the call is torn down', () => {
    const { hangup, closer } = closerWith();
    closer.allow();
    closer.request();
    closer.responseFinished();
    closer.cancel();
    vi.advanceTimersByTime(30_000);
    expect(hangup).not.toHaveBeenCalled();
  });
});

describe('ResponseScheduler', () => {
  it('does not make the agent speak again after the closing tool', () => {
    const send = vi.fn();
    const scheduler = new ResponseScheduler(send);
    scheduler.responseCreated();
    scheduler.toolStarted();
    scheduler.toolFinished(false);
    scheduler.responseFinished();
    expect(send).not.toHaveBeenCalled();
  });

  it('speaks once after several tools in the same turn', () => {
    const send = vi.fn();
    const scheduler = new ResponseScheduler(send);
    scheduler.responseCreated();
    scheduler.toolStarted();
    scheduler.toolStarted();
    scheduler.toolFinished();
    scheduler.toolFinished();
    expect(send).not.toHaveBeenCalled();      // la response con le function call è ancora attiva
    scheduler.responseFinished();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('answers immediately when no response is running', () => {
    const send = vi.fn();
    const scheduler = new ResponseScheduler(send);
    scheduler.toolStarted();
    scheduler.toolFinished();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stays silent while the caller is speaking and lets the VAD answer', () => {
    const send = vi.fn();
    const scheduler = new ResponseScheduler(send);
    scheduler.responseCreated();
    scheduler.toolStarted();
    scheduler.userSpeechStarted();
    scheduler.toolFinished();
    scheduler.responseFinished();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not queue a second turn once a response already started', () => {
    const send = vi.fn();
    const scheduler = new ResponseScheduler(send);
    scheduler.toolStarted();
    scheduler.toolFinished();
    scheduler.responseCreated();
    scheduler.responseFinished();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
