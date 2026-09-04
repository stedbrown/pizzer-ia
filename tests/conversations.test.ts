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
});
