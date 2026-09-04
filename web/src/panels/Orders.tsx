import { useState } from 'react';
import type { OrderStatus, OrderView } from '../../../src/types';
import { api } from '../api';
import { clock, money, plural, since } from '../format';
import { AsyncView, Badge, Empty, Stat, type Tone } from '../ui';
import type { AsyncState } from '../hooks';

const LABEL: Record<OrderStatus, string> = {
  NEW: 'Nuovo', CONFIRMED: 'Confermato', PREPARING: 'In preparazione',
  READY: 'Pronto', COMPLETED: 'Completato', CANCELLED: 'Annullato'
};
const RANK: Partial<Record<OrderStatus, number>> = { NEW: 0, CONFIRMED: 1, PREPARING: 2, READY: 3 };
const TONE: Partial<Record<OrderStatus, Tone>> = { NEW: 'bad', CONFIRMED: 'bad', PREPARING: 'warn', READY: 'good' };
// Il flusso in pizzeria è lineare: un bottone per il passo successivo, il resto è correzione.
const NEXT: Partial<Record<OrderStatus, { status: OrderStatus; label: string }>> = {
  NEW: { status: 'PREPARING', label: 'Inizia a preparare' },
  CONFIRMED: { status: 'PREPARING', label: 'Inizia a preparare' },
  PREPARING: { status: 'READY', label: 'Segna pronto' },
  READY: { status: 'COMPLETED', label: 'Consegnato' }
};
const LATE_AFTER_MS = 20 * 60_000;
const dateKey = (value: Date | string, timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(value));

function OrderCard({ order, onChange }: { order: OrderView; onChange: (id: string, status: OrderStatus) => void }) {
  const [open, setOpen] = useState(false);
  const next = NEXT[order.status];
  const late = order.status in RANK && order.status !== 'READY' && Date.now() - Date.parse(order.createdAt) > LATE_AFTER_MS;
  return (
    <article className={`order status-${order.status.toLowerCase()}${late ? ' late' : ''}`}>
      <div className="order-head">
        <Badge tone={TONE[order.status]}>{LABEL[order.status]}</Badge>
        <h3>{order.customerName}</h3>
        <span className="tag">{order.fulfillment === 'pickup' ? 'Ritiro' : 'Consegna'}</span>
        {order.readyAt ? <span className="tag ready-at">per le {clock(order.readyAt)}</span> : null}
        {order.notifiedAt ? <span className="tag sent" title="Conferma inviata al cliente">SMS</span> : null}
        <span className="order-when">
          <time>{clock(order.createdAt)}</time>
          <small>{since(order.createdAt)}</small>
        </span>
        <strong className="order-total">{money(order.totalCents)}</strong>
      </div>

      <ul className="order-items">
        {order.items.map((item, index) => (
          <li key={index}>
            <b>{item.quantity}×</b> {item.name}
            {item.modifiers.length ? <span className="mods">{item.modifiers.map((m) => m.name).join(', ')}</span> : null}
          </li>
        ))}
      </ul>
      {order.deliveryAddress ? <p className="order-address">{order.deliveryAddress}</p> : null}

      <div className="order-actions">
        {next ? <button className="primary" onClick={() => onChange(order.id, next.status)}>{next.label}</button> : null}
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>Altro stato</button>
        {open ? (
          <select value={order.status} onChange={(event) => onChange(order.id, event.target.value as OrderStatus)} aria-label={`Stato ${order.orderNumber}`}>
            {(Object.keys(LABEL) as OrderStatus[]).map((status) => <option key={status} value={status}>{LABEL[status]}</option>)}
          </select>
        ) : null}
        <span className="order-number">{order.orderNumber}</span>
      </div>
    </article>
  );
}

export function OrdersPanel({ state, timezone = 'Europe/Zurich' }: { state: AsyncState<OrderView[]>; timezone?: string }) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  const change = async (id: string, status: OrderStatus) => {
    await api.setOrderStatus(id, status);
    state.reload();
  };
  return (
    <AsyncView state={state}>
      {(orders) => {
        const todayOrders = orders.filter((order) => dateKey(order.createdAt, timezone) === dateKey(new Date(), timezone));
        const active = orders.filter((order) => order.status in RANK)
          .sort((a, b) => (RANK[a.status]! - RANK[b.status]!) || (Date.parse(a.createdAt) - Date.parse(b.createdAt)));
        const archived = orders.filter((order) => !(order.status in RANK))
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const revenue = todayOrders.filter((order) => order.status !== 'CANCELLED').reduce((sum, order) => sum + order.totalCents, 0);
        return (
          <>
            <div className="stats">
              <Stat label="Da preparare" value={orders.filter((o) => ['NEW', 'CONFIRMED', 'PREPARING'].includes(o.status)).length} />
              <Stat label="Pronti al ritiro" value={orders.filter((o) => o.status === 'READY').length} />
              <Stat label="Completati oggi" value={todayOrders.filter((o) => o.status === 'COMPLETED').length} />
              <Stat label="Incasso di oggi" value={money(revenue)} hint={plural(todayOrders.length, 'ordine', 'ordini')} />
            </div>

            {active.length
              ? <div className="stack">{active.map((order) => <OrderCard key={order.id} order={order} onChange={change} />)}</div>
              : <Empty title="Nessun ordine in lavorazione" hint="Il prossimo ordine telefonico apparirà qui da solo." />}

            {archived.length ? (
              <section className="archive">
                <button className="link archive-toggle" onClick={() => setArchiveOpen(!archiveOpen)} aria-expanded={archiveOpen}>
                  {archiveOpen ? '▾' : '▸'} Completati e annullati <span className="count">{archived.length}</span>
                </button>
                {archiveOpen ? <div className="stack">{archived.map((order) => <OrderCard key={order.id} order={order} onChange={change} />)}</div> : null}
              </section>
            ) : null}
          </>
        );
      }}
    </AsyncView>
  );
}
