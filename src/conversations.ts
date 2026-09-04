import type { Conversation, ConversationTurn, LiveLogEvent } from './types.js';

const roleBySource: Partial<Record<LiveLogEvent['source'], ConversationTurn['role']>> = {
  USER: 'customer', AGENT: 'agent', TOOL: 'tool', ORDER: 'system', CALL: 'system'
};

/** Gli eventi tecnici restano nei Live Logs: qui entra solo ciò che racconta la telefonata. */
function conversational(event: LiveLogEvent) {
  if (!event.callId || !roleBySource[event.source]) return false;
  return event.source !== 'CALL' || event.level === 'INFO';
}

/**
 * Ricostruisce le telefonate dagli eventi già registrati: nessuna nuova raccolta dati,
 * nessuna nuova tabella, stessa redaction e stessa retention dei Live Logs.
 * Le trascrizioni esistono solo per le chiamate fatte in Modalità test.
 */
export function buildConversations(events: LiveLogEvent[]): Conversation[] {
  const byCall = new Map<string, LiveLogEvent[]>();
  for (const event of events.filter(conversational)) {
    const bucket = byCall.get(event.callId!) ?? [];
    bucket.push(event);
    byCall.set(event.callId!, bucket);
  }
  const conversations = [...byCall.entries()].map(([callId, bucket]) => {
    const ordered = [...bucket].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const startedAt = ordered[0]!.timestamp;
    const endedAt = ordered[ordered.length - 1]!.timestamp;
    return {
      callId, startedAt, endedAt,
      durationSeconds: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)),
      outcome: outcomeOf(ordered),
      turns: ordered.map((event) => ({ at: event.timestamp, role: roleBySource[event.source]!, text: event.message }))
    };
  });
  return conversations.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

function outcomeOf(ordered: LiveLogEvent[]): Conversation['outcome'] {
  const tools = ordered.filter((event) => event.source === 'TOOL').map((event) => event.message);
  if (tools.some((message) => message.startsWith('confirm_order'))) return 'confermato';
  if (tools.some((message) => message.startsWith('transfer_to_human'))) return 'trasferita';
  return ordered.some((event) => event.source === 'CALL' && event.message === 'Call ended') ? 'chiusa' : 'in corso';
}
