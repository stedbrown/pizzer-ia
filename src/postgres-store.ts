import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CallUsage, DraftOrder, IncomingCall, MenuItem, Modifier, MonthlyUsage, OrderStatus, OrderView, TelephonyHeartbeat, TelephonyStatus } from './types.js';
import type { Store } from './store.js';

export class PostgresStore implements Store {
  constructor(private pool: pg.Pool) {}

  async health() { await this.pool.query('SELECT 1'); return true; }
  async restaurantForDid(did?: string) {
    const normalized = did?.match(/\+\d{7,15}/)?.[0];
    const result = normalized
      ? await this.pool.query('SELECT id, name FROM restaurants WHERE active AND did_e164 = $1 LIMIT 1', [normalized])
      : await this.pool.query('SELECT id, name FROM restaurants WHERE active ORDER BY created_at LIMIT 1');
    return result.rows[0] as { id: string; name: string } | undefined;
  }
  async getMenu(restaurantId: string, query?: string, includeInactive = false) {
    const values: unknown[] = [restaurantId];
    let where = 'mi.restaurant_id = $1';
    if (!includeInactive) where += ' AND mi.active';
    if (query) { values.push(`%${query}%`); where += ` AND mi.name ILIKE $${values.length}`; }
    const result = await this.pool.query(`
      SELECT mi.id, mi.restaurant_id, mi.name, mi.description, mi.price_cents, mi.active,
        COALESCE(jsonb_agg(jsonb_build_object('id', mm.id, 'name', mm.name, 'priceCents', mm.price_cents, 'active', mm.active)
          ORDER BY mm.name) FILTER (WHERE mm.id IS NOT NULL), '[]'::jsonb) modifiers
      FROM menu_items mi LEFT JOIN menu_modifiers mm ON mm.menu_item_id = mi.id
      WHERE ${where} GROUP BY mi.id ORDER BY mi.name`, values);
    return result.rows.map(mapMenuItem);
  }
  async updateMenuItem(restaurantId: string, itemId: string, patch: { name?: string; priceCents?: number; active?: boolean }) {
    const result = await this.pool.query(`UPDATE menu_items SET
      name = COALESCE($3, name), price_cents = COALESCE($4, price_cents), active = COALESCE($5, active)
      WHERE restaurant_id = $1 AND id = $2 RETURNING id`, [restaurantId, itemId, patch.name ?? null, patch.priceCents ?? null, patch.active ?? null]);
    if (!result.rowCount) return undefined;
    return (await this.getMenu(restaurantId, undefined, true)).find((x) => x.id === itemId);
  }
  async saveCall(call: IncomingCall) {
    await this.pool.query(`INSERT INTO calls (openai_call_id, restaurant_id, from_uri, to_uri, started_at)
      VALUES ($1,$2,$3,$4,now()) ON CONFLICT (openai_call_id) DO UPDATE SET from_uri=EXCLUDED.from_uri,to_uri=EXCLUDED.to_uri,updated_at=now()`,
      [call.callId, call.restaurantId, call.from ?? null, call.to ?? null]);
  }
  async markCallConnected(callId: string) {
    await this.pool.query("UPDATE calls SET status='CONNECTED',started_at=COALESCE(started_at,now()),updated_at=now() WHERE openai_call_id=$1", [callId]);
    await this.pool.query("UPDATE telephony_status SET openai_realtime='connected',updated_at=now() WHERE restaurant_id=(SELECT restaurant_id FROM calls WHERE openai_call_id=$1)", [callId]);
  }
  async addCallUsage(callId: string, usage: CallUsage) {
    await this.pool.query(`UPDATE calls SET audio_input_tokens=audio_input_tokens+$2,audio_output_tokens=audio_output_tokens+$3,
      text_input_tokens=text_input_tokens+$4,text_output_tokens=text_output_tokens+$5,openai_cost_usd_micros=openai_cost_usd_micros+$6,updated_at=now()
      WHERE openai_call_id=$1`, [callId, usage.audioInputTokens, usage.audioOutputTokens, usage.textInputTokens, usage.textOutputTokens, usage.openaiCostUsdMicros]);
  }
  async finishCall(callId: string) {
    await this.pool.query(`UPDATE calls SET status='ENDED',ended_at=COALESCE(ended_at,now()),
      duration_seconds=GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,now())-COALESCE(started_at,created_at)))::integer),updated_at=now()
      WHERE openai_call_id=$1`, [callId]);
    await this.pool.query("UPDATE telephony_status SET openai_realtime='ready',updated_at=now() WHERE restaurant_id=(SELECT restaurant_id FROM calls WHERE openai_call_id=$1)", [callId]);
  }
  async getDraft(callId: string) {
    const result = await this.pool.query('SELECT draft_state FROM calls WHERE openai_call_id=$1', [callId]);
    return result.rows[0]?.draft_state as DraftOrder | undefined;
  }
  async saveDraft(draft: DraftOrder) {
    await this.pool.query('UPDATE calls SET draft_state=$2::jsonb, updated_at=now() WHERE openai_call_id=$1', [draft.callId, JSON.stringify(draft)]);
  }
  async createOrder(draft: DraftOrder, menu: MenuItem[], totalCents: number) {
    if (draft.confirmedOrderId) {
      const existing = await this.getOrder(draft.restaurantId, draft.confirmedOrderId);
      if (existing) return existing;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT o.id FROM orders o WHERE o.call_id=$1 LIMIT 1', [draft.callId]);
      if (existing.rowCount) {
        await client.query('COMMIT');
        return (await this.getOrder(draft.restaurantId, existing.rows[0].id))!;
      }
      const id = randomUUID();
      const orderNumber = `PZ-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${id.slice(0, 4).toUpperCase()}`;
      await client.query(`INSERT INTO orders
        (id,order_number,restaurant_id,call_id,customer_name,customer_phone,fulfillment,delivery_address,total_cents,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CONFIRMED')`,
        [id, orderNumber, draft.restaurantId, draft.callId, draft.customerName, draft.callerPhone ?? null, draft.fulfillment, draft.deliveryAddress ?? null, totalCents]);
      for (const line of draft.lines) {
        const item = menu.find((x) => x.id === line.itemId)!;
        const modifiers = line.modifierIds.map((modifierId) => item.modifiers.find((m) => m.id === modifierId)!);
        const unitPriceCents = item.priceCents + modifiers.reduce((sum, m) => sum + m.priceCents, 0);
        await client.query(`INSERT INTO order_items
          (id,order_id,menu_item_id,item_name,quantity,unit_price_cents,modifiers,line_total_cents)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [randomUUID(), id, item.id, item.name, line.quantity, unitPriceCents, JSON.stringify(modifiers), unitPriceCents * line.quantity]);
      }
      await client.query('COMMIT');
      return (await this.getOrder(draft.restaurantId, id))!;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async listOrders(restaurantId: string) {
    const result = await this.pool.query(orderQuery('o.restaurant_id=$1'), [restaurantId]);
    return groupOrders(result.rows);
  }
  private async getOrder(restaurantId: string, orderId: string) {
    const result = await this.pool.query(orderQuery('o.restaurant_id=$1 AND o.id=$2'), [restaurantId, orderId]);
    return groupOrders(result.rows)[0];
  }
  async setOrderStatus(restaurantId: string, orderId: string, status: OrderStatus) {
    const result = await this.pool.query('UPDATE orders SET status=$3,updated_at=now() WHERE restaurant_id=$1 AND id=$2', [restaurantId, orderId, status]);
    return Boolean(result.rowCount);
  }
  async claimWebhook(id: string, type: string, payload: unknown) {
    const result = await this.pool.query('INSERT INTO webhook_events (id,event_type,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [id, type, JSON.stringify(payload)]);
    return Boolean(result.rowCount);
  }
  async releaseWebhook(id: string) { await this.pool.query('DELETE FROM webhook_events WHERE id=$1', [id]); }
  async getTelephonyStatus(restaurantId: string) {
    const result = await this.pool.query(`SELECT asterisk_online,sip_registration,asterisk_version,checked_at,inbound_status,audio_status,openai_realtime
      FROM telephony_status WHERE restaurant_id=$1`, [restaurantId]);
    const row = result.rows[0];
    return { asteriskOnline: row?.asterisk_online ?? false, sipRegistration: row?.sip_registration ?? 'unknown', version: row?.asterisk_version ?? undefined,
      checkedAt: (row?.checked_at ?? new Date(0)).toISOString(), inboundStatus: row?.inbound_status ?? 'waiting', audioStatus: row?.audio_status ?? 'waiting',
      openaiRealtime: row?.openai_realtime ?? 'waiting' } as TelephonyStatus;
  }
  async updateTelephonyStatus(restaurantId: string, heartbeat: TelephonyHeartbeat) {
    await this.pool.query(`INSERT INTO telephony_status (restaurant_id,asterisk_online,sip_registration,asterisk_version,checked_at)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (restaurant_id) DO UPDATE SET asterisk_online=EXCLUDED.asterisk_online,
      sip_registration=EXCLUDED.sip_registration,asterisk_version=EXCLUDED.asterisk_version,checked_at=EXCLUDED.checked_at,updated_at=now()`,
      [restaurantId, heartbeat.asteriskOnline, heartbeat.sipRegistration, heartbeat.version ?? null, heartbeat.checkedAt]);
  }
  async getMonthlyUsage(restaurantId: string) {
    const result = await this.pool.query(`SELECT
      COUNT(DISTINCT c.openai_call_id)::integer calls,COALESCE(SUM(c.duration_seconds),0)::integer duration_seconds,
      COALESCE(SUM(c.audio_input_tokens),0)::bigint audio_input_tokens,COALESCE(SUM(c.audio_output_tokens),0)::bigint audio_output_tokens,
      COALESCE(SUM(c.text_input_tokens),0)::bigint text_input_tokens,COALESCE(SUM(c.text_output_tokens),0)::bigint text_output_tokens,
      COALESCE(SUM(c.openai_cost_usd_micros),0)::bigint openai_cost_usd_micros,
      (SELECT COUNT(*)::integer FROM orders o WHERE o.restaurant_id=$1 AND o.created_at>=date_trunc('month',now())) orders,
      (SELECT COALESCE(SUM(o.total_cents),0)::bigint FROM orders o WHERE o.restaurant_id=$1 AND o.status<>'CANCELLED' AND o.created_at>=date_trunc('month',now())) order_value_cents
      FROM calls c WHERE c.restaurant_id=$1 AND c.created_at>=date_trunc('month',now())`, [restaurantId]);
    const row = result.rows[0];
    const calls = Number(row.calls);
    const tokenTotal = Number(row.audio_input_tokens)+Number(row.audio_output_tokens)+Number(row.text_input_tokens)+Number(row.text_output_tokens);
    return { calls, durationSeconds:Number(row.duration_seconds),orders:Number(row.orders),orderValueCents:Number(row.order_value_cents),
      audioInputTokens:Number(row.audio_input_tokens),audioOutputTokens:Number(row.audio_output_tokens),textInputTokens:Number(row.text_input_tokens),textOutputTokens:Number(row.text_output_tokens),
      openaiCostUsdMicros:Number(row.openai_cost_usd_micros),usageSource:calls>0&&tokenTotal===0?'N/D':'REAL' } as MonthlyUsage;
  }
}

function mapMenuItem(row: any): MenuItem {
  return { id: row.id, restaurantId: row.restaurant_id, name: row.name, description: row.description ?? undefined, priceCents: row.price_cents, active: row.active, modifiers: row.modifiers as Modifier[] };
}

function orderQuery(where: string) {
  return `SELECT o.*, oi.id line_id,oi.item_name,oi.quantity,oi.unit_price_cents,oi.modifiers,oi.line_total_cents
    FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE ${where} ORDER BY o.created_at DESC, oi.item_name`;
}

function groupOrders(rows: any[]): OrderView[] {
  const result = new Map<string, OrderView>();
  for (const row of rows) {
    let order = result.get(row.id);
    if (!order) {
      order = { id: row.id, orderNumber: row.order_number, restaurantId: row.restaurant_id, customerName: row.customer_name,
        customerPhone: row.customer_phone ?? undefined, fulfillment: row.fulfillment, deliveryAddress: row.delivery_address ?? undefined,
        totalCents: row.total_cents, status: row.status, createdAt: row.created_at.toISOString(), items: [] };
      result.set(row.id, order);
    }
    if (row.line_id) order.items.push({ name: row.item_name, quantity: row.quantity, unitPriceCents: row.unit_price_cents, modifiers: row.modifiers, lineTotalCents: row.line_total_cents });
  }
  return [...result.values()];
}
