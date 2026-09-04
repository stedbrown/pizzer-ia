import { describe, expect, it } from 'vitest';
import { buildRealtimeSession, centralistInstructions, realtimeTools } from '../src/realtime.js';

describe('Realtime voice agent', () => {
  it('keeps every existing order tool available', () => {
    expect(realtimeTools.map((tool) => tool.name)).toEqual([
      'get_menu', 'search_menu', 'start_order', 'add_item', 'remove_item', 'update_item',
      'set_customer_name', 'set_fulfillment', 'set_delivery_address', 'calculate_total',
      'get_order_summary', 'confirm_order', 'transfer_to_human'
    ]);
  });

  it('uses a natural short greeting and strong conversational rules', () => {
    const prompt = centralistInstructions('Pizzeria Test', '+41910000000');
    expect(prompt).toContain('Sei l\'addetto telefonico di Pizzeria Test');
    expect(prompt).toContain('Pizzeria, buongiorno! Mi dica.');
    expect(prompt).toContain('normalmente UNA domanda alla volta');
    expect(prompt).toContain('Chiedi soltanto ciò che manca');
    expect(prompt).toContain('NON elencare spontaneamente tutto il menu');
    expect(prompt).toContain('NON riepilogare dopo ogni aggiunta o correzione');
    expect(prompt).toContain('non calcolare prezzi mentalmente');
    expect(prompt).toContain('confirm_order soltanto dopo un sì inequivocabile');
    expect(prompt).toContain('caller ID è già disponibile al backend: non chiederlo');
    expect(prompt).not.toContain('Sono l\'assistente virtuale');
  });

  it('supports configurable greeting and large-order fallback', () => {
    const prompt = centralistInstructions('Pizzeria Test', undefined, { greeting: 'Pizzeria, buonasera! Cosa le preparo?', largeOrderThreshold: 12 });
    expect(prompt).toContain('Pizzeria, buonasera! Cosa le preparo?');
    expect(prompt).toContain('raggiunge 12 articoli');
    expect(prompt).toContain('usa transfer_to_human');
  });

  it('keeps model, voice and barge-in settings configurable without changing VAD timing', () => {
    const session = buildRealtimeSession({ restaurantName: 'Pizzeria Test', model: 'gpt-realtime-2.1', voice: 'marin' });
    expect(session.model).toBe('gpt-realtime-2.1');
    expect(session.audio.output.voice).toBe('marin');
    expect(session.audio.input.turn_detection).toEqual({ type: 'server_vad', create_response: true, interrupt_response: true, silence_duration_ms: 550 });
    expect(session.parallel_tool_calls).toBe(false);
    expect(session.audio.input).not.toHaveProperty('transcription');
  });

  it('enables user transcription only for the time-limited test mode', () => {
    const session = buildRealtimeSession({ restaurantName: 'Pizzeria Test', model: 'gpt-realtime-2.1-mini', voice: 'marin', testMode: true });
    expect(session.audio.input).toMatchObject({ transcription: { model: 'gpt-live-transcribe', languages: ['it'], delay: 'low' } });
  });
});
