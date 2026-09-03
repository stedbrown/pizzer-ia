import type { LogCategory, LiveLogEvent, NewLiveLogEvent } from './types.js';

const categoryBySource: Record<NewLiveLogEvent['source'], LogCategory> = {
  ASTERISK: 'TELEPHONY', SIPCALL: 'TELEPHONY', SIP: 'TELEPHONY', CALL: 'TELEPHONY', RTP: 'TELEPHONY', HEARTBEAT: 'TELEPHONY',
  OPENAI: 'OPENAI', WEBHOOK: 'OPENAI', SIDEBAND: 'OPENAI', TOOL: 'TOOL', ORDER: 'BACKEND', DB: 'DATABASE', BACKEND: 'BACKEND'
};

export function safeLogEvent(event: Omit<NewLiveLogEvent, 'category'> & { category?: LogCategory }): NewLiveLogEvent {
  return {
    source: event.source,
    level: event.level,
    category: event.category ?? categoryBySource[event.source],
    message: redact(String(event.message)).slice(0, 500),
    callId: event.callId ? redact(String(event.callId)).slice(0, 128) : undefined,
    timestamp: validTimestamp(event.timestamp) ? event.timestamp : undefined
  };
}

export function redact(input: string) {
  return input
    .replace(/\b(Authorization|Proxy-Authorization)\s*:\s*(?:Bearer\s+)?\S+/gi, '$1: [REDACTED]')
    .replace(/\b(OPENAI_API_KEY|SIP_PASSWORD|OPENAI_WEBHOOK_SECRET|HEARTBEAT_SECRET|DATABASE_URL|PGPASSWORD|PASSWORD|SECRET)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|whsec)-?[A-Za-z0-9_=-]{12,}/gi, '[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[REDACTED]')
    .replace(/\+?\d(?:[\s().-]*\d){6,}/g, (phone) => {
      if ((phone.match(/\./g)?.length ?? 0) >= 3) return phone;
      const digits = phone.replace(/\D/g, '');
      return digits.length > 4 ? `***${digits.slice(-4)}` : '***';
    });
}

export function publicLogEvent(event: LiveLogEvent): LiveLogEvent {
  return { ...event, message: redact(event.message), callId: event.callId ? redact(event.callId) : undefined };
}

function validTimestamp(value?: string): value is string {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && Math.abs(Date.now() - time) < 5 * 60_000;
}
