import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Callback, CallUsage, DraftOrder, IncomingCall, LiveLogEvent, MenuItem, Modifier, MonthlyUsage, NewLiveLogEvent, OrderStatus, OrderView, ServiceSettings, TelephonyHeartbeat, TelephonyStatus } from './types.js';
import type { MenuItemPatch, ServiceSettingsPatch, Store } from './store.js';
import { menuSearchTerms } from './menu-search.js';

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
    // "Finito per oggi" vale quanto un prodotto disattivato, ma si azzera da solo domani.
    if (!includeInactive) where += ' AND mi.active AND (mi.sold_out_until IS NULL OR mi.sold_out_until < CURRENT_DATE)';
    const terms = query ? menuSearchTerms(query) : [];
    if (terms.length) {
      values.push(terms.map((term) => `%${term}%`));
      where += ` AND (mi.name ILIKE ANY($${values.length}::text[]) OR COALESCE(mi.description,'') ILIKE ANY($${values.length}::text[])`
        + ` OR COALESCE(mi.category,'') ILIKE ANY($${values.length}::text[]))`;
    }
    const result = await this.pool.query(`
      SELECT mi.id, mi.restaurant_id, mi.name, mi.description, mi.category, mi.allergens, mi.price_cents, mi.active, mi.sold_out_until,
        COALESCE(jsonb_agg(jsonb_build_object('id', mm.id, 'name', mm.name, 'priceCents', mm.price_cents, 'active', mm.active, 'kind', mm.kind)
          ORDER BY mm.kind DESC, mm.name) FILTER (WHERE mm.id IS NOT NULL AND mm.active), '[]'::jsonb) modifiers
      FROM menu_items mi
      LEFT JOIN menu_modifiers mm
        ON mm.menu_item_id = mi.id
        OR (mm.menu_item_id IS NULL AND mm.restaurant_id = mi.restaurant_id)
      WHERE ${where} GROUP BY mi.id ORDER BY mi.category NULLS LAST, mi.name`, values);
    return result.rows.map(mapMenuItem);
  }
  async getServiceSettings(restaurantId: string) {
    const settings = await this.pool.query(`SELECT timezone, prep_minutes, delivery_extra_minutes, busy_extra_minutes, busy_mode, accepts_delivery
      FROM restaurants WHERE id=$1`, [restaurantId]);
    const hours = await this.pool.query('SELECT weekday, opens::text, closes::text FROM restaurant_hours WHERE restaurant_id=$1 ORDER BY weekday, opens', [restaurantId]);
    const row = settings.rows[0] ?? {};
    return {
      timezone: row.timezone ?? 'Europe/Zurich',
      prepMinutes: row.prep_minutes ?? 20,
      deliveryExtraMinutes: row.delivery_extra_minutes ?? 15,
      busyExtraMinutes: row.busy_extra_minutes ?? 15,
      busyMode: row.busy_mode ?? false,
      acceptsDelivery: row.accepts_delivery ?? true,
      hours: hours.rows.map((slot) => ({ weekday: slot.weekday, opens: String(slot.opens).slice(0, 5), closes: String(slot.closes).slice(0, 5) }))
    } as ServiceSettings;
  }
  async updateServiceSettings(restaurantId: string, patch: ServiceSettingsPatch) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE restaurants SET
        timezone=COALESCE($2,timezone), prep_minutes=COALESCE($3,prep_minutes), delivery_extra_minutes=COALESCE($4,delivery_extra_minutes),
        busy_extra_minutes=COALESCE($5,busy_extra_minutes), busy_mode=COALESCE($6,busy_mode), accepts_delivery=COALESCE($7,accepts_delivery)
        WHERE id=$1`,
        [restaurantId, patch.timezone ?? null, patch.prepMinutes ?? null, patch.deliveryExtraMinutes ?? null,
          patch.busyExtraMinutes ?? null, patch.busyMode ?? null, patch.acceptsDelivery ?? null]);
      if (patch.hours) {
        await client.query('DELETE FROM restaurant_hours WHERE restaurant_id=$1', [restaurantId]);
        for (const slot of patch.hours) {
          await client.query('INSERT INTO restaurant_hours (id,restaurant_id,weekday,opens,closes) VALUES ($1,$2,$3,$4,$5)',
            [randomUUID(), restaurantId, slot.weekday, slot.opens, slot.closes]);
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.getServiceSettings(restaurantId);
  }
  async addCallback(restaurantId: string, input: { callId?: string; phone?: string; reason: string }) {
    const result = await this.pool.query(`INSERT INTO callbacks (id,restaurant_id,call_id,phone,reason) VALUES ($1,$2,$3,$4,$5)
      RETURNING id,call_id,phone,reason,created_at,handled_at`,
      [randomUUID(), restaurantId, input.callId ?? null, input.phone ?? null, input.reason]);
    return mapCallback(result.rows[0]);
  }
  async listCallbacks(restaurantId: string) {
    const result = await this.pool.query(`SELECT id,call_id,phone,reason,created_at,handled_at FROM callbacks
      WHERE restaurant_id=$1 AND created_at > now() - interval '7 days' ORDER BY handled_at NULLS FIRST, created_at DESC LIMIT 50`, [restaurantId]);
    return result.rows.map(mapCallback);
  }
  async resolveCallback(restaurantId: string, id: string) {
    const result = await this.pool.query('UPDATE callbacks SET handled_at=now() WHERE restaurant_id=$1 AND id=$2 AND handled_at IS NULL', [restaurantId, id]);
    return Boolean(result.rowCount);
  }
  async markOrderNotified(orderId: string) {
    await this.pool.query('UPDATE orders SET notified_at=now() WHERE id=$1', [orderId]);
  }
  async updateMenuItem(restaurantId: string, itemId: string, patch: MenuItemPatch) {
    const result = await this.pool.query(`UPDATE menu_items SET
      name = COALESCE($3, name), price_cents = COALESCE($4, price_cents), active = COALESCE($5, active),
      category = CASE WHEN $6::boolean THEN $7 ELSE category END,
      allergens = COALESCE($8::text[], allergens),
      sold_out_until = CASE WHEN $9::boolean THEN $10::date ELSE sold_out_until END
      WHERE restaurant_id = $1 AND id = $2 RETURNING id`,
      [restaurantId, itemId, patch.name ?? null, patch.priceCents ?? null, patch.active ?? null,
        patch.category !== undefined, patch.category ?? null,
        patch.allergens ?? null,
        patch.soldOutUntil !== undefined, patch.soldOutUntil ?? null]);
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
  async createOrder(draft: DraftOrder, menu: MenuItem[], totalCents: number, readyAt?: Date) {
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
        (id,order_number,restaurant_id,call_id,customer_name,customer_phone,fulfillment,delivery_address,total_cents,status,ready_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CONFIRMED',$10)`,
        [id, orderNumber, draft.restaurantId, draft.callId, draft.customerName, draft.callerPhone ?? null, draft.fulfillment, draft.deliveryAddress ?? null, totalCents, readyAt ?? null]);
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
  async addLogEvent(restaurantId: string, event: NewLiveLogEvent) {
    const result = await this.pool.query(`INSERT INTO live_log_events (restaurant_id,occurred_at,source,level,category,message,call_id)
      VALUES ($1,COALESCE($2::timestamptz,now()),$3,$4,$5,$6,$7)
      RETURNING id::text,restaurant_id,occurred_at,source,level,category,message,call_id`,
      [restaurantId, event.timestamp ?? null, event.source, event.level, event.category, event.message, event.callId ?? null]);
    await this.pool.query(`DELETE FROM live_log_events WHERE restaurant_id=$1 AND
      (occurred_at < now() - interval '24 hours' OR id NOT IN (SELECT id FROM live_log_events WHERE restaurant_id=$1 ORDER BY id DESC LIMIT 1000))`, [restaurantId]);
    return mapLogEvent(result.rows[0]);
  }
  async listLogEvents(restaurantId: string, limit = 200) {
    const result = await this.pool.query(`SELECT id::text,restaurant_id,occurred_at,source,level,category,message,call_id
      FROM live_log_events WHERE restaurant_id=$1 ORDER BY id DESC LIMIT $2`, [restaurantId, Math.min(500, Math.max(1, limit))]);
    return result.rows.reverse().map(mapLogEvent);
  }
  async getTestModeUntil(restaurantId: string) {
    const result = await this.pool.query('SELECT test_mode_until FROM telephony_status WHERE restaurant_id=$1', [restaurantId]);
    const value = result.rows[0]?.test_mode_until as Date | undefined;
    return value && value.getTime() > Date.now() ? value.toISOString() : undefined;
  }
  async setTestModeUntil(restaurantId: string, until?: string) {
    await this.pool.query(`INSERT INTO telephony_status (restaurant_id,test_mode_until) VALUES ($1,$2)
      ON CONFLICT (restaurant_id) DO UPDATE SET test_mode_until=EXCLUDED.test_mode_until,updated_at=now()`, [restaurantId, until ?? null]);
  }
}

function mapMenuItem(row: any): MenuItem {
  return { id: row.id, restaurantId: row.restaurant_id, name: row.name, description: row.description ?? undefined,
    category: row.category ?? undefined, allergens: row.allergens ?? [], priceCents: row.price_cents, active: row.active,
    soldOutUntil: row.sold_out_until ? new Date(row.sold_out_until).toISOString().slice(0, 10) : undefined,
    modifiers: row.modifiers as Modifier[] };
}

function mapCallback(row: any): Callback {
  return { id: row.id, callId: row.call_id ?? undefined, phone: row.phone ?? undefined, reason: row.reason,
    createdAt: row.created_at.toISOString(), handledAt: row.handled_at ? row.handled_at.toISOString() : undefined };
}

function mapLogEvent(row: any): LiveLogEvent {
  return { id: row.id, restaurantId: row.restaurant_id, timestamp: row.occurred_at.toISOString(), source: row.source,
    level: row.level, category: row.category, message: row.message, callId: row.call_id ?? undefined };
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
        totalCents: row.total_cents, status: row.status, createdAt: row.created_at.toISOString(),
        readyAt: row.ready_at ? row.ready_at.toISOString() : undefined,
        notifiedAt: row.notified_at ? row.notified_at.toISOString() : undefined, items: [] };
      result.set(row.id, order);
    }
    if (row.line_id) order.items.push({ name: row.item_name, quantity: row.quantity, unitPriceCents: row.unit_price_cents, modifiers: row.modifiers, lineTotalCents: row.line_total_cents });
  }
  return [...result.values()];
}
