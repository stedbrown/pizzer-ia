import { beforeEach, describe, expect, it } from 'vitest';
import { OrderEngine } from '../src/order-engine.js';
import { DEMO_RESTAURANT_ID, MemoryStore } from '../src/store.js';

describe('OrderEngine', () => {
  let store: MemoryStore;
  let engine: OrderEngine;
  beforeEach(async () => {
    store = new MemoryStore();
    store.settings.hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '00:00', closes: '23:59' }));
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
  it('serializes simultaneous mutations without losing an item', async () => {
    await Promise.all([
      engine.execute('add_item', { item_id: 'item-1', quantity: 1, modifier_ids: [] }),
      engine.execute('add_item', { item_id: 'item-3', quantity: 1, modifier_ids: [] })
    ]);
    expect((await store.getDraft('call-1'))?.lines.map((line) => line.itemId)).toEqual(['item-1', 'item-3']);
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

  it('refuses confirmation outside opening hours', async () => {
    await engine.execute('add_item', { item_id: 'item-1', quantity: 1, modifier_ids: [] });
    await engine.execute('set_fulfillment', { type: 'pickup' });
    await engine.execute('set_customer_name', { name: 'Stefano' });
    await engine.execute('get_order_summary', {});
    store.settings.hours = [];
    await expect(engine.execute('confirm_order', { confirmed: true })).rejects.toThrow('chiusa');
    expect(store.orders).toHaveLength(0);
  });

  it('refuses delivery when the pizzeria disabled it', async () => {
    await engine.execute('add_item', { item_id: 'item-1', quantity: 1, modifier_ids: [] });
    await engine.execute('set_fulfillment', { type: 'delivery' });
    await engine.execute('set_delivery_address', { address: 'Via Test 1, Lugano' });
    await engine.execute('set_customer_name', { name: 'Stefano' });
    await engine.execute('get_order_summary', {});
    store.settings.acceptsDelivery = false;
    await expect(engine.execute('confirm_order', { confirmed: true })).rejects.toThrow('consegne non sono attive');
  });

  it('refuses unverified service defaults', async () => {
    await engine.execute('add_item', { item_id: 'item-1', quantity: 1, modifier_ids: [] });
    await engine.execute('set_fulfillment', { type: 'pickup' });
    await engine.execute('set_customer_name', { name: 'Stefano' });
    await engine.execute('get_order_summary', {});
    store.settings.configured = false;
    await expect(engine.execute('confirm_order', { confirmed: true })).rejects.toThrow('non ancora confermate');
  });
});
