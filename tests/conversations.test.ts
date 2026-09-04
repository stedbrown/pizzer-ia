import { describe, expect, it } from 'vitest';
import { buildConversations } from '../src/conversations.js';
import type { LiveLogEvent, LogLevel, LogSource } from '../src/types.js';

const missing = (): never => { throw new Error('nessuna conversazione ricostruita'); };
let sequence = 0;
const event = (source: LogSource, message: string, callId?: string, level: LogLevel = 'INFO'): LiveLogEvent => ({
  id: String(++sequence), restaurantId: 'restaurant-demo', source, level, category: 'OPENAI', message, callId,
  timestamp: new Date(Date.UTC(2026, 8, 4, 10, 32, sequence)).toISOString()
});

describe('Conversation log', () => {
  it('rebuilds a readable dialogue from the events already stored', () => {
    const [conversation = missing()] = buildConversations([
      event('USER', '"due diavole e una margherita senza mozzarella"', 'call-1', 'DEBUG'),
      event('TOOL', 'add_item Diavola x2', 'call-1'),
      event('AGENT', '"Certo. Ritiro o consegna?"', 'call-1', 'DEBUG'),
      event('CALL', 'Call ended', 'call-1')
    ]);
    expect(conversation.callId).toBe('call-1');
    expect(conversation.outcome).toBe('chiusa');
    expect(conversation.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ['customer', '"due diavole e una margherita senza mozzarella"'],
      ['tool', 'add_item Diavola x2'],
      ['agent', '"Certo. Ritiro o consegna?"'],
      ['system', 'Call ended']
    ]);
  });

  it('leaves the technical noise in the live logs', () => {
    const [conversation = missing()] = buildConversations([
      event('USER', '"pronto"', 'call-1', 'DEBUG'),
      event('SIP', 'Incoming INVITE', 'call-1'),
      event('RTP', 'Stream summary', 'call-1'),
      event('HEARTBEAT', 'Status received', 'call-1'),
      event('CALL', 'User speech started', 'call-1', 'DEBUG'),
      event('CALL', 'Barge-in: risposta interrotta dal cliente', 'call-1')
    ]);
    expect(conversation.turns.map((turn) => turn.text)).toEqual(['"pronto"', 'Barge-in: risposta interrotta dal cliente']);
  });

  it('separates the calls and reports the outcome of each', () => {
    const conversations = buildConversations([
      event('USER', '"una diavola"', 'call-1', 'DEBUG'),
      event('TOOL', 'confirm_order A-12 → CHF 17.00', 'call-1'),
      event('USER', '"mi passa una persona"', 'call-2', 'DEBUG'),
      event('TOOL', 'transfer_to_human completed', 'call-2'),
      event('USER', '"buonasera"', 'call-3', 'DEBUG')
    ]);
    expect(conversations.map((conversation) => [conversation.callId, conversation.outcome])).toEqual([
      ['call-3', 'in corso'], ['call-2', 'trasferita'], ['call-1', 'confermato']
    ]);
  });

  it('ignores events that belong to no call', () => {
    expect(buildConversations([event('BACKEND', 'Backend ready'), event('AGENT', '"ciao"')])).toEqual([]);
  });

  it('moves the response delay onto the reply it measures', () => {
    const [conversation = missing()] = buildConversations([
      event('USER', '"due diavole"', 'call-1', 'DEBUG'),
      event('CALL', 'Risposta iniziata dopo 2280 ms', 'call-1'),
      event('AGENT', '"Certo. Ritiro o consegna?"', 'call-1', 'DEBUG')
    ]);
    // La misura era una riga a sé: come tale è rumore, accanto alla frase è una diagnosi.
    expect(conversation.turns).toHaveLength(2);
    expect(conversation.turns[1]).toMatchObject({ role: 'agent', latencyMs: 2280 });
    expect(conversation.metrics).toMatchObject({ customerTurns: 1, agentTurns: 1, avgResponseMs: 2280, slowestResponseMs: 2280 });
  });

  it('counts the quality signals of the call', () => {
    const [conversation = missing()] = buildConversations([
      event('USER', '"una margherita"', 'call-1', 'DEBUG'),
      event('CALL', 'Risposta iniziata dopo 600 ms', 'call-1'),
      event('AGENT', '"Va bene."', 'call-1', 'DEBUG'),
      event('CALL', 'Barge-in: risposta interrotta dal cliente', 'call-1'),
      event('CALL', 'Risposta iniziata dopo 1400 ms', 'call-1'),
      event('AGENT', '"Mi dica."', 'call-1', 'DEBUG'),
      event('TOOL', 'confirm_order PZ-0007 → CHF 14.00', 'call-1')
    ]);
    expect(conversation.metrics).toMatchObject({ agentTurns: 2, toolCalls: 1, bargeIns: 1, avgResponseMs: 1000, slowestResponseMs: 1400 });
    expect(conversation.headline).toBe('PZ-0007 · CHF 14.00');
    expect(conversation.turns.find((turn) => turn.bargeIn)).toBeDefined();
  });

  it('times every turn from the start of the call', () => {
    const [conversation = missing()] = buildConversations([
      event('USER', '"pronto"', 'call-1', 'DEBUG'),
      event('AGENT', '"Mi dica."', 'call-1', 'DEBUG')
    ]);
    expect(conversation.turns.map((turn) => turn.offsetMs)).toEqual([0, 1000]);
  });
});
