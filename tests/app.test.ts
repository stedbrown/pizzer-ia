import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

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
    await store.updateTelephonyStatus('restaurant-demo', { asteriskOnline: true, sipRegistration: 'registered', checkedAt: new Date(Date.now() - 91_000).toISOString() });
    const stale = await app.inject({ method: 'GET', url: '/api/telephony/status', headers: auth });
    expect(stale.json()).toMatchObject({ heartbeatState: 'stale', asteriskOnline: null, sipRegistration: 'unknown' });
  });
  it('reports zero monthly usage without inventing costs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/usage/monthly', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ calls: 0, sipcallMonthlyChfCents: 380, infrastructureCost: null, totalCost: null });
  });
});
