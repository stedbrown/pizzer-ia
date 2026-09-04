import type { Conversation, ConversationMetrics, ConversationTurn, LiveLogEvent } from './types.js';

const roleBySource: Partial<Record<LiveLogEvent['source'], ConversationTurn['role']>> = {
  USER: 'customer', AGENT: 'agent', TOOL: 'tool', ORDER: 'system', CALL: 'system'
};

const LATENCY = /^Risposta iniziata dopo (\d+) ms$/;
const BARGE_IN = /^Barge-in/;
const CONFIRMED = /^confirm_order (\S+) → (.+)$/;
const ACTIVE_CALL_WINDOW_MS = 10 * 60 * 1000;

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
export function buildConversations(events: LiveLogEvent[], now = new Date()): Conversation[] {
  const byCall = new Map<string, LiveLogEvent[]>();
  for (const event of events.filter((candidate) => Boolean(candidate.callId))) {
    const bucket = byCall.get(event.callId!) ?? [];
    bucket.push(event);
    byCall.set(event.callId!, bucket);
  }
  const conversations = [...byCall.entries()].filter(([, bucket]) => bucket.some(conversational)).map(([callId, bucket]) => {
    const ordered = [...bucket].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const startedAt = ordered[0]!.timestamp;
    const endedAt = ordered[ordered.length - 1]!.timestamp;
    const turns = buildTurns(ordered.filter(conversational), Date.parse(startedAt));
    return {
      callId, startedAt, endedAt,
      durationSeconds: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)),
      outcome: outcomeOf(ordered, now.getTime()),
      headline: headlineOf(ordered),
      metrics: metricsOf(turns),
      turns
    };
  });
  return conversations.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/**
 * La misura di latenza viene registrata come riga a sé, ma serve accanto alla frase
 * a cui si riferisce: si attacca alla risposta successiva invece di restare rumore.
 */
function buildTurns(ordered: LiveLogEvent[], startMs: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let pendingLatencyMs: number | undefined;
  for (const event of ordered) {
    const latency = event.source === 'CALL' ? LATENCY.exec(event.message) : null;
    if (latency) { pendingLatencyMs = Number(latency[1]); continue; }
    const turn: ConversationTurn = {
      at: event.timestamp,
      offsetMs: Math.max(0, Date.parse(event.timestamp) - startMs),
      role: roleBySource[event.source]!,
      text: event.message
    };
    if (turn.role === 'agent' && pendingLatencyMs !== undefined) {
      turn.latencyMs = pendingLatencyMs;
      pendingLatencyMs = undefined;
    }
    if (event.source === 'CALL' && BARGE_IN.test(event.message)) turn.bargeIn = true;
    turns.push(turn);
  }
  return turns;
}

function metricsOf(turns: ConversationTurn[]): ConversationMetrics {
  const latencies = turns.map((turn) => turn.latencyMs).filter((value): value is number => typeof value === 'number');
  return {
    customerTurns: turns.filter((turn) => turn.role === 'customer').length,
    agentTurns: turns.filter((turn) => turn.role === 'agent').length,
    toolCalls: turns.filter((turn) => turn.role === 'tool').length,
    bargeIns: turns.filter((turn) => turn.bargeIn).length,
    ...(latencies.length ? {
      avgResponseMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      slowestResponseMs: Math.max(...latencies)
    } : {})
  };
}

function headlineOf(ordered: LiveLogEvent[]) {
  for (const event of ordered) {
    if (event.source !== 'TOOL') continue;
    const confirmed = CONFIRMED.exec(event.message);
    if (confirmed) return `${confirmed[1]} · ${confirmed[2]}`;
  }
  return undefined;
}

function outcomeOf(ordered: LiveLogEvent[], nowMs: number): Conversation['outcome'] {
  const tools = ordered.filter((event) => event.source === 'TOOL').map((event) => event.message);
  if (tools.some((message) => message.startsWith('confirm_order'))) return 'confermato';
  if (tools.some((message) => message === 'transfer_to_human transferred')) return 'trasferita';
  if (ordered.some((event) => event.source === 'CALL' && event.message === 'Call ended')) return 'chiusa';
  const lastActivityMs = Date.parse(ordered[ordered.length - 1]!.timestamp);
  return nowMs - lastActivityMs > ACTIVE_CALL_WINDOW_MS ? 'interrotta' : 'in corso';
}
