import { randomUUID } from 'node:crypto';
import type { CallUsage, DraftOrder, IncomingCall, LiveLogEvent, MenuItem, MonthlyUsage, NewLiveLogEvent, OrderStatus, OrderView, TelephonyHeartbeat, TelephonyStatus } from './types.js';
import { matchesMenuQuery } from './menu-search.js';

export interface Store {
  health(): Promise<boolean>;
  restaurantForDid(did?: string): Promise<{ id: string; name: string } | undefined>;
  getMenu(restaurantId: string, query?: string, includeInactive?: boolean): Promise<MenuItem[]>;
  updateMenuItem(restaurantId: string, itemId: string, patch: { name?: string; priceCents?: number; active?: boolean }): Promise<MenuItem | undefined>;
  saveCall(call: IncomingCall): Promise<void>;
  markCallConnected(callId: string): Promise<void>;
  addCallUsage(callId: string, usage: CallUsage): Promise<void>;
  finishCall(callId: string): Promise<void>;
  getDraft(callId: string): Promise<DraftOrder | undefined>;
  saveDraft(draft: DraftOrder): Promise<void>;
  createOrder(draft: DraftOrder, menu: MenuItem[], totalCents: number): Promise<OrderView>;
  listOrders(restaurantId: string): Promise<OrderView[]>;
  setOrderStatus(restaurantId: string, orderId: string, status: OrderStatus): Promise<boolean>;
  claimWebhook(id: string, type: string, payload: unknown): Promise<boolean>;
  releaseWebhook(id: string): Promise<void>;
  getTelephonyStatus(restaurantId: string): Promise<TelephonyStatus>;
  updateTelephonyStatus(restaurantId: string, heartbeat: TelephonyHeartbeat): Promise<void>;
  getMonthlyUsage(restaurantId: string): Promise<MonthlyUsage>;
  addLogEvent(restaurantId: string, event: NewLiveLogEvent): Promise<LiveLogEvent>;
  listLogEvents(restaurantId: string, limit?: number): Promise<LiveLogEvent[]>;
  getTestModeUntil(restaurantId: string): Promise<string | undefined>;
  setTestModeUntil(restaurantId: string, until?: string): Promise<void>;
}

export const DEMO_RESTAURANT_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_DID = '+41912102049';

const prices: Array<[string, number]> = [
  ['Margherita', 1400], ['Prosciutto', 1600], ['Diavola', 1700],
  ['Quattro Formaggi', 1800], ['Prosciutto e Funghi', 1800]
];
const modifierSeed: Array<[string, number]> = [
  ['mozzarella extra', 200], ['prosciutto extra', 300], ['funghi extra', 200], ['senza mozzarella', 0]
];

export function demoMenu(): MenuItem[] {
  const modifiers = modifierSeed.map(([name, priceCents], i) => ({ id: `mod-${i + 1}`, name, priceCents, active: true }));
  return prices.map(([name, priceCents], i) => ({
    id: `item-${i + 1}`, restaurantId: DEMO_RESTAURANT_ID, name, priceCents, active: true,
    modifiers: modifiers.map((m) => ({ ...m }))
  }));
}

export class MemoryStore implements Store {
  menu = demoMenu();
  drafts = new Map<string, DraftOrder>();
  orders: OrderView[] = [];
  webhooks = new Set<string>();
  calls = new Map<string, IncomingCall>();
  telephony: TelephonyStatus = { asteriskOnline: false, sipRegistration: 'unknown', checkedAt: new Date(0).toISOString(), inboundStatus: 'waiting', audioStatus: 'waiting', openaiRealtime: 'waiting' };
  usage: CallUsage = { audioInputTokens: 0, audioOutputTokens: 0, textInputTokens: 0, textOutputTokens: 0, openaiCostUsdMicros: 0 };
  liveLogs: LiveLogEvent[] = [];
  testModeUntil?: string;
  private nextLogId = 1;

  async health() { return true; }
  async restaurantForDid(did?: string) { return !did || did.includes(DEMO_DID) ? { id: DEMO_RESTAURANT_ID, name: 'Pizzer-IA Demo' } : undefined; }
  async getMenu(restaurantId: string, query?: string, includeInactive = false) {
    return this.menu.filter((item) => item.restaurantId === restaurantId && (includeInactive || item.active) && (!query || matchesMenuQuery(item, query)));
  }
  async updateMenuItem(restaurantId: string, itemId: string, patch: { name?: string; priceCents?: number; active?: boolean }) {
    const item = this.menu.find((x) => x.restaurantId === restaurantId && x.id === itemId);
    if (!item) return undefined;
    Object.assign(item, patch);
    return item;
  }
  async saveCall(call: IncomingCall) { this.calls.set(call.callId, call); }
  async markCallConnected() { this.telephony.openaiRealtime = 'connected'; }
  async addCallUsage(_callId: string, usage: CallUsage) { for (const key of Object.keys(usage) as Array<keyof CallUsage>) this.usage[key] += usage[key]; }
  async finishCall() { if (this.telephony.openaiRealtime === 'connected') this.telephony.openaiRealtime = 'ready'; }
  async getDraft(callId: string) { return this.drafts.get(callId); }
  async saveDraft(draft: DraftOrder) { this.drafts.set(draft.callId, structuredClone(draft)); }
  async createOrder(draft: DraftOrder, menu: MenuItem[], totalCents: number) {
    if (draft.confirmedOrderId) {
      const existing = this.orders.find((o) => o.id === draft.confirmedOrderId);
      if (existing) return existing;
    }
    const id = randomUUID();
    const order: OrderView = {
      id, orderNumber: `PZ-${String(this.orders.length + 1).padStart(4, '0')}`,
      restaurantId: draft.restaurantId, customerName: draft.customerName!, customerPhone: draft.callerPhone,
      fulfillment: draft.fulfillment!, deliveryAddress: draft.deliveryAddress, totalCents, status: 'CONFIRMED',
      createdAt: new Date().toISOString(),
      items: draft.lines.map((line) => {
        const item = menu.find((x) => x.id === line.itemId)!;
        const modifiers = line.modifierIds.map((id) => item.modifiers.find((m) => m.id === id)!);
        const unitPriceCents = item.priceCents + modifiers.reduce((sum, m) => sum + m.priceCents, 0);
        return { name: item.name, quantity: line.quantity, unitPriceCents, modifiers, lineTotalCents: unitPriceCents * line.quantity };
      })
    };
    this.orders.unshift(order);
    return order;
  }
  async listOrders(restaurantId: string) { return this.orders.filter((x) => x.restaurantId === restaurantId); }
  async setOrderStatus(restaurantId: string, orderId: string, status: OrderStatus) {
    const order = this.orders.find((x) => x.restaurantId === restaurantId && x.id === orderId);
    if (!order) return false;
    order.status = status;
    return true;
  }
  async claimWebhook(id: string) {
    if (this.webhooks.has(id)) return false;
    this.webhooks.add(id);
    return true;
  }
  async releaseWebhook(id: string) { this.webhooks.delete(id); }
  async getTelephonyStatus() { return structuredClone(this.telephony); }
  async updateTelephonyStatus(_restaurantId: string, heartbeat: TelephonyHeartbeat) { Object.assign(this.telephony, heartbeat); }
  async getMonthlyUsage(): Promise<MonthlyUsage> {
    return { calls: this.calls.size, durationSeconds: 0, orders: this.orders.length, orderValueCents: this.orders.reduce((sum, order) => sum + order.totalCents, 0), ...this.usage,
      usageSource: this.calls.size && !Object.values(this.usage).some(Boolean) ? 'N/D' : 'REAL' };
  }
  async addLogEvent(restaurantId: string, event: NewLiveLogEvent) {
    const saved: LiveLogEvent = { ...event, id: String(this.nextLogId++), restaurantId, timestamp: event.timestamp ?? new Date().toISOString() };
    this.liveLogs.push(saved);
    this.liveLogs = this.liveLogs.slice(-1000);
    return structuredClone(saved);
  }
  async listLogEvents(restaurantId: string, limit = 200) { return structuredClone(this.liveLogs.filter((event) => event.restaurantId === restaurantId).slice(-limit)); }
  async getTestModeUntil() {
    if (!this.testModeUntil || Date.parse(this.testModeUntil) <= Date.now()) {
      this.testModeUntil = undefined;
      return undefined;
    }
    return this.testModeUntil;
  }
  async setTestModeUntil(_restaurantId: string, until?: string) { this.testModeUntil = until; }
}
