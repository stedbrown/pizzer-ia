import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import { verifyOpenAIWebhook } from '../src/webhook-signature.js';

const secret = 'whsec_dGVzdC1zZWNyZXQ=';
function headers(body: Buffer, id = 'wh_test') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.`).update(body).digest('base64');
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
}

describe('OpenAI webhook verification', () => {
  it('accepts a valid signature and rejects tampering', () => {
    const body = Buffer.from('{"ok":true}');
    const signed = headers(body);
    expect(verifyOpenAIWebhook(body, signed, secret)).toBe(true);
    expect(verifyOpenAIWebhook(Buffer.from('{"ok":false}'), signed, secret)).toBe(false);
  });
  it('rejects stale signatures', () => {
    const body = Buffer.from('{}');
    const signed = headers(body);
    expect(verifyOpenAIWebhook(body, signed, secret, Date.now() + 301_000)).toBe(false);
  });
});

describe('Webhook endpoint idempotency', () => {
  const store = new MemoryStore();
  const app = buildApp({ store, adminPassword: 'test', webhookSecret: secret });
  afterAll(async () => app.close());
  it('processes an event only once', async () => {
    const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'unhandled.event', data: {} }));
    const signed = headers(body, 'wh_same');
    const first = await app.inject({ method: 'POST', url: '/webhooks/openai', headers: signed, payload: body });
    const second = await app.inject({ method: 'POST', url: '/webhooks/openai', headers: signed, payload: body });
    expect(first.statusCode).toBe(200); expect(first.json().ignored).toBe(true);
    expect(second.statusCode).toBe(200); expect(second.json().duplicate).toBe(true);
  });
  it('rejects unsigned events', async () => { expect((await app.inject({ method: 'POST', url: '/webhooks/openai', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(401); });
});
