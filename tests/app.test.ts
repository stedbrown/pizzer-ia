import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

describe('HTTP application', () => {
  let app: ReturnType<typeof buildApp>;
  let store: MemoryStore;
  const auth = { authorization: `Basic ${Buffer.from('admin:test-password').toString('base64')}` };
  beforeEach(() => { store = new MemoryStore(); app = buildApp({ store, adminPassword: 'test-password', webhookSecret: 'whsec_dGVzdC1zZWNyZXQ=' }); });
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
});
