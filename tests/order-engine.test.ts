import { beforeEach, describe, expect, it } from 'vitest';
import { OrderEngine } from '../src/order-engine.js';
import { DEMO_RESTAURANT_ID, MemoryStore } from '../src/store.js';

describe('OrderEngine', () => {
  let store: MemoryStore;
  let engine: OrderEngine;
  beforeEach(async () => {
    store = new MemoryStore();
    await store.saveCall({ callId: 'call-1', restaurantId: DEMO_RESTAURANT_ID, from: 'sip:+41999999999@example.test' });
    engine = new OrderEngine(store, DEMO_RESTAURANT_ID, 'call-1', '+41999999999');
  });
  it('reads the real menu', async () => { expect(await engine.execute('get_menu', {})).toHaveLength(5); });
  it('adds items and modifiers and computes backend prices', async () => {
    const result: any = await engine.execute('add_item', { item_id: 'item-3', quantity: 2, modifier_ids: ['mod-1'], priceCents: 1 });
    expect(result.totalCents).toBe(3800);
    expect(result.items[0].unitPriceCents).toBe(1900);
  });
  it('rejects invalid modifiers', async () => {
    await expect(engine.execute('add_item', { item_id: 'item-1', quantity: 1, modifier_ids: ['fake'] })).rejects.toThrow('Modificatore non disponibile');
  });
  it('requires summary and explicit confirmation, then confirms idempotently', async () => {
    await engine.execute('add_item', { item_id: 'item-1', quantity: 1, modifier_ids: ['mod-4'] });
    await engine.execute('set_fulfillment', { type: 'pickup' });
    await engine.execute('set_customer_name', { name: 'Stefano' });
    await expect(engine.execute('confirm_order', { confirmed: true })).rejects.toThrow('riepilogo');
    const summary: any = await engine.execute('get_order_summary', {});
    expect(summary.totalCents).toBe(1400);
    const first: any = await engine.execute('confirm_order', { confirmed: true });
    const second: any = await engine.execute('confirm_order', { confirmed: true });
    expect(second.confirmedOrderId).toBe(first.orderNumber ? store.orders[0]?.id : undefined);
    expect(store.orders).toHaveLength(1);
  });
});
