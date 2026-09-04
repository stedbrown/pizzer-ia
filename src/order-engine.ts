import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DraftOrder, MenuItem, NewLiveLogEvent } from './types.js';
import type { Store } from './store.js';
import { readyAt, serviceStatus } from './service-hours.js';

export function formatLocalTime(date: Date, timezone: string) {
  return new Intl.DateTimeFormat('it-CH', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export class OrderError extends Error {}

export function calculateDraft(draft: DraftOrder, menu: MenuItem[]) {
  let totalCents = 0;
  const items = draft.lines.map((line) => {
    const item = menu.find((x) => x.id === line.itemId && x.active);
    if (!item) throw new OrderError(`Articolo non disponibile: ${line.itemId}`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) throw new OrderError('Quantità non valida');
    const modifiers = line.modifierIds.map((id) => {
      const modifier = item.modifiers.find((m) => m.id === id && m.active);
      if (!modifier) throw new OrderError(`Modificatore non disponibile: ${id}`);
      return modifier;
    });
    const unitPriceCents = item.priceCents + modifiers.reduce((sum, m) => sum + m.priceCents, 0);
    const lineTotalCents = unitPriceCents * line.quantity;
    totalCents += lineTotalCents;
    return { lineId: line.id, itemId: item.id, name: item.name, quantity: line.quantity, modifiers: modifiers.map((m) => ({ id: m.id, name: m.name, priceCents: m.priceCents })), unitPriceCents, lineTotalCents };
  });
  return { items, totalCents, currency: 'CHF' as const };
}

export class OrderEngine {
  constructor(private store: Store, private restaurantId: string, private callId: string, private callerPhone?: string,
    private log?: (event: Omit<NewLiveLogEvent, 'category'> & { category?: NewLiveLogEvent['category'] }) => Promise<unknown>) {}

  private writeLog(event: Omit<NewLiveLogEvent, 'category' | 'callId'> & { category?: NewLiveLogEvent['category'] }) {
    void this.log?.({ ...event, callId: this.callId }).catch(() => undefined);
  }

  private async draft() {
    return (await this.store.getDraft(this.callId)) ?? { restaurantId: this.restaurantId, callId: this.callId, callerPhone: this.callerPhone, lines: [] };
  }
  private async mutate(fn: (draft: DraftOrder) => void) {
    const draft = await this.draft();
    if (draft.confirmedOrderId) throw new OrderError('Ordine già confermato');
    fn(draft);
    draft.summaryPresentedAt = undefined;
    await this.store.saveDraft(draft);
    this.writeLog({ source: 'ORDER', level: 'DEBUG', message: 'Draft updated' });
    return this.summary(draft);
  }
  private async summary(input?: DraftOrder) {
    const draft = input ?? await this.draft();
    const menu = await this.store.getMenu(this.restaurantId);
    return { ...calculateDraft(draft, menu), customerName: draft.customerName, phone: draft.callerPhone ? maskPhone(draft.callerPhone) : undefined, fulfillment: draft.fulfillment, deliveryAddress: draft.deliveryAddress, confirmedOrderId: draft.confirmedOrderId };
  }

  async execute(name: string, raw: unknown): Promise<unknown> {
    switch (name) {
      case 'get_menu': return this.store.getMenu(this.restaurantId);
      case 'search_menu': {
        const { query } = z.object({ query: z.string().min(1) }).parse(raw);
        return this.store.getMenu(this.restaurantId, query);
      }
      case 'start_order': {
        const existing = await this.draft();
        await this.store.saveDraft(existing);
        return this.summary(existing);
      }
      case 'add_item': {
        const args = z.object({ item_id: z.string(), quantity: z.number().int().min(1).max(20), modifier_ids: z.array(z.string()).default([]) }).parse(raw);
        return this.mutate((draft) => draft.lines.push({ id: randomUUID(), itemId: args.item_id, quantity: args.quantity, modifierIds: args.modifier_ids }));
      }
      case 'remove_item': {
        const { line_id } = z.object({ line_id: z.string() }).parse(raw);
        return this.mutate((draft) => { const before = draft.lines.length; draft.lines = draft.lines.filter((x) => x.id !== line_id); if (before === draft.lines.length) throw new OrderError('Riga non trovata'); });
      }
      case 'update_item': {
        const args = z.object({ line_id: z.string(), quantity: z.number().int().min(1).max(20).optional(), modifier_ids: z.array(z.string()).optional() }).parse(raw);
        return this.mutate((draft) => { const line = draft.lines.find((x) => x.id === args.line_id); if (!line) throw new OrderError('Riga non trovata'); if (args.quantity) line.quantity = args.quantity; if (args.modifier_ids) line.modifierIds = args.modifier_ids; });
      }
      case 'set_customer_name': {
        const { name: value } = z.object({ name: z.string().trim().min(1).max(120) }).parse(raw);
        return this.mutate((draft) => { draft.customerName = value; });
      }
      case 'set_fulfillment': {
        const { type } = z.object({ type: z.enum(['pickup', 'delivery']) }).parse(raw);
        return this.mutate((draft) => { draft.fulfillment = type; if (type === 'pickup') draft.deliveryAddress = undefined; });
      }
      case 'set_delivery_address': {
        const { address } = z.object({ address: z.string().trim().min(5).max(300) }).parse(raw);
        return this.mutate((draft) => { draft.deliveryAddress = address; });
      }
      case 'calculate_total': return this.summary();
      case 'get_order_summary': {
        const draft = await this.draft();
        const result = await this.summary(draft);
        draft.summaryPresentedAt = new Date().toISOString();
        await this.store.saveDraft(draft);
        this.writeLog({ source: 'ORDER', level: 'INFO', message: 'Order summary presented' });
        return { ...result, instruction: 'Leggi questo riepilogo al cliente e chiedi: Conferma l’ordine?' };
      }
      case 'confirm_order': {
        const { confirmed } = z.object({ confirmed: z.literal(true) }).parse(raw);
        if (!confirmed) throw new OrderError('Conferma esplicita mancante');
        const draft = await this.draft();
        if (draft.confirmedOrderId) return this.summary(draft);
        if (!draft.summaryPresentedAt) throw new OrderError('Prima devi presentare il riepilogo e chiedere conferma');
        if (!draft.lines.length || !draft.customerName || !draft.fulfillment) throw new OrderError('Ordine incompleto');
        if (draft.fulfillment === 'delivery' && !draft.deliveryAddress) throw new OrderError('Indirizzo di consegna mancante');
        const menu = await this.store.getMenu(this.restaurantId);
        const priced = calculateDraft(draft, menu);
        // L'ora di pronto la decide la pizzeria dalle sue impostazioni, non il modello.
        const settings = await this.store.getServiceSettings(this.restaurantId);
        const status = serviceStatus(settings);
        const ready = readyAt(status, draft.fulfillment);
        const order = await this.store.createOrder(draft, menu, priced.totalCents, ready);
        this.writeLog({ source: 'DB', level: 'INFO', message: `Order created: ${order.orderNumber}` });
        draft.confirmedOrderId = order.id;
        await this.store.saveDraft(draft);
        this.writeLog({ source: 'ORDER', level: 'INFO', message: `Order confirmed: ${order.orderNumber}` });
        return { orderId: order.id, orderNumber: order.orderNumber, totalCents: order.totalCents, status: order.status,
          readyTime: formatLocalTime(ready, settings.timezone) };
      }
      case 'transfer_to_human': return { available: Boolean(process.env.HUMAN_TRANSFER_URI), message: process.env.HUMAN_TRANSFER_URI ? 'Trasferimento in corso' : 'Trasferimento umano non configurato' };
      default: throw new OrderError(`Tool sconosciuto: ${name}`);
    }
  }
}

export function maskPhone(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.length > 4 ? `***${digits.slice(-4)}` : '***';
}
