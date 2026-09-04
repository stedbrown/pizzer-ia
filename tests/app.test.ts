import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEMO_RESTAURANT_ID, MemoryStore } from '../src/store.js';

describe('HTTP application', () => {
  let app: ReturnType<typeof buildApp>;
  let store: MemoryStore;
  const auth = { authorization: `Basic ${Buffer.from('admin:test-password').toString('base64')}` };
  beforeEach(() => { store = new MemoryStore(); app = buildApp({ store, adminPassword: 'test-password', webhookSecret: 'whsec_dGVzdC1zZWNyZXQ=', heartbeatSecret: 'heartbeat-test' }); });
  afterEach(async () => app.close());
  it('reports health', async () => { const response = await app.inject({ method: 'GET', url: '/health' }); expect(response.statusCode).toBe(200); expect(response.json().database).toBe('connected'); });
  it('protects admin APIs and returns the menu', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/menu' })).statusCode).toBe(401);
    const response = await app.inject({ method: 'GET', url: '/api/menu', headers: auth });
    expect(response.statusCode).toBe(200); expect(response.json()).toHaveLength(5);
  });
  it('updates menu fields', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/api/menu/item-1', headers: auth, payload: { priceCents: 1550, active: false } });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ priceCents: 1550, active: false });
  });
  it('authenticates the telephony heartbeat and reports current status', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/telephony/heartbeat', payload: {} })).statusCode).toBe(401);
    const unknown = await app.inject({ method: 'GET', url: '/api/telephony/status', headers: auth });
    expect(unknown.json()).toMatchObject({ heartbeatState: 'unknown', checkedAt: null });
    const checkedAt = new Date().toISOString();
    const heartbeat = await app.inject({ method: 'POST', url: '/api/telephony/heartbeat', headers: { 'x-heartbeat-token': 'heartbeat-test' }, payload: { asteriskOnline: true, sipRegistration: 'registered', version: 'Asterisk 22.5.2', checkedAt } });
    expect(heartbeat.statusCode).toBe(200);
    const response = await app.inject({ method: 'GET', url: '/api/telephony/status', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: 'sipcall', plan: 'Classic', asteriskOnline: true, sipRegistration: 'registered', heartbeatState: 'current' });
    expect(response.json()).toMatchObject({ realtimeModel: 'gpt-realtime-2.1', voice: 'marin', turnDetection: 'server_vad' });
    await store.updateTelephonyStatus('restaurant-demo', { asteriskOnline: true, sipRegistration: 'registered', checkedAt: new Date(Date.now() - 91_000).toISOString() });
    const stale = await app.inject({ method: 'GET', url: '/api/telephony/status', headers: auth });
    expect(stale.json()).toMatchObject({ heartbeatState: 'stale', asteriskOnline: null, sipRegistration: 'unknown' });
  });
  it('reports zero monthly usage without inventing costs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/usage/monthly', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ calls: 0, sipcallMonthlyChfCents: 380, infrastructureCost: null, totalCost: null });
  });
  it('ingests redacted structured telephony events', async () => {
    const ingest = await app.inject({ method: 'POST', url: '/api/telephony/events', headers: { 'x-heartbeat-token': 'heartbeat-test' }, payload: [{ source: 'SIP', level: 'INFO', message: 'INVITE from +41 91 210 20 49 Authorization: Bearer unsafe-value' }] });
    expect(ingest.statusCode).toBe(200);
    const response = await app.inject({ method: 'GET', url: '/api/live-logs', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ source: 'SIP', category: 'TELEPHONY', message: 'INVITE from ***2049 Authorization: [REDACTED]' });
  });
  it('limits test mode to 15 minutes and exposes it to heartbeat', async () => {
    const enabled = await app.inject({ method: 'POST', url: '/api/test-mode', headers: auth, payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(Date.parse(enabled.json().expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const heartbeat = await app.inject({ method: 'POST', url: '/api/telephony/heartbeat', headers: { 'x-heartbeat-token': 'heartbeat-test' }, payload: { asteriskOnline: true, sipRegistration: 'registered', checkedAt: new Date().toISOString() } });
    expect(heartbeat.json()).toMatchObject({ testMode: true, testModeExpiresAt: enabled.json().expiresAt });
    const disabled = await app.inject({ method: 'POST', url: '/api/test-mode', headers: auth, payload: { enabled: false } });
    expect(disabled.json()).toEqual({ enabled: false, expiresAt: null });

    await store.setTestModeUntil(DEMO_RESTAURANT_ID, new Date(Date.now() - 1).toISOString());
    const expired = await app.inject({ method: 'GET', url: '/api/test-mode', headers: auth });
    expect(expired.json()).toEqual({ enabled: false, expiresAt: null });
  });
  it('streams newly ingested events over SSE', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const stream = await fetch(`${address}/api/live-logs/stream`, { headers: auth, signal: controller.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await app.inject({ method: 'POST', url: '/api/telephony/events', headers: { 'x-heartbeat-token': 'heartbeat-test' }, payload: [{ source: 'ASTERISK', level: 'INFO', message: 'Service online' }] });
    let received = '';
    while (!received.includes('Service online')) received += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(received).toContain('event: log');
    expect(received).toContain('"source":"ASTERISK"');
  });
});
