import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyOpenAIWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secret: string, now = Date.now()) {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatureHeader = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signatureHeader || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const secretValue = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let key: Buffer;
  try { key = Buffer.from(secretValue, 'base64'); } catch { return false; }
  if (!key.length) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();
  const signatures = signatureHeader.split(/\s+/).flatMap((part) => {
    const value = part.startsWith('v1,') ? part.slice(3) : part.startsWith('v1=') ? part.slice(3) : '';
    try { return value ? [Buffer.from(value, 'base64')] : []; } catch { return []; }
  });
  return signatures.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected));
}

function header(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
