import { useEffect, useState } from 'react';
import type { MenuItem } from '../../../src/types';
import { api, type ServiceView } from '../api';
import { useAsync } from '../hooks';
import { useLiveReload } from '../live';
import { AsyncView, Badge, SectionHeading } from '../ui';

const fallbackBusinessDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date());
const soldOut = (item: MenuItem, businessDate: string) => Boolean(item.soldOutUntil && item.soldOutUntil >= businessDate);

function Row({ item, businessDate, onSaved }: { item: MenuItem; businessDate: string; onSaved: () => void }) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState((item.priceCents / 100).toFixed(2));
  const [category, setCategory] = useState(item.category ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(item.name);
    setPrice((item.priceCents / 100).toFixed(2));
    setCategory(item.category ?? '');
  }, [item.name, item.priceCents, item.category]);
  const dirty = name !== item.name || price !== (item.priceCents / 100).toFixed(2) || category !== (item.category ?? '');

  const patch = async (change: Record<string, unknown>) => {
    setBusy(true);
    try { await api.patchMenuItem(item.id, change); onSaved(); } finally { setBusy(false); }
  };

  return (
    <div className={`menu-row${item.active ? '' : ' off'}${soldOut(item, businessDate) ? ' sold-out' : ''}`}>
      <input className="name" value={name} onChange={(event) => setName(event.target.value)} aria-label="Nome prodotto" />
      <input className="category" value={category} placeholder="categoria" onChange={(event) => setCategory(event.target.value)} aria-label="Categoria" />
      <label className="price">CHF <input type="number" min={0} step={0.5} value={price} onChange={(event) => setPrice(event.target.value)} aria-label="Prezzo" /></label>
      <div className="menu-flags">
        {item.allergens.length ? <span className="allergens" title="Allergeni a menu">{item.allergens.join(' · ')}</span> : null}
        {soldOut(item, businessDate) ? <Badge tone="warn">finito oggi</Badge> : null}
        {item.active ? null : <Badge tone="neutral">fuori menu</Badge>}
      </div>
      <div className="menu-actions">
        <button className="link" disabled={busy}
          onClick={() => patch({ soldOutUntil: soldOut(item, businessDate) ? null : businessDate })}>
          {soldOut(item, businessDate) ? 'Rimetti in menu' : 'Finito per oggi'}
        </button>
        <button className="link" disabled={busy} onClick={() => patch({ active: !item.active })}>
          {item.active ? 'Togli dal menu' : 'Rimetti'}
        </button>
        <button className="primary small" disabled={!dirty || busy}
          onClick={() => patch({ name, priceCents: Math.round(Number(price) * 100), category: category.trim() || null })}>
          Salva
        </button>
      </div>
    </div>
  );
}

export function MenuPanel() {
  const state = useAsync<MenuItem[]>(() => api.menu());
  const service = useAsync<ServiceView>(() => api.service());
  useLiveReload(state.reload, (event) => event.source === 'DB' && event.message.startsWith('Menu aggiornato:'));
  useLiveReload(service.reload, (event) => event.source === 'BACKEND' && event.message === 'Impostazioni di servizio aggiornate');
  return (
    <>
      <SectionHeading eyebrow="LISTINO" title="Menu della pizzeria">
        <p className="hint">I prezzi restano decisi dal backend: l'agente non può inventarli né scontarli.</p>
      </SectionHeading>
      <AsyncView state={state} empty={{ title: 'Menu vuoto', when: (items) => items.length === 0 }}>
        {(items) => {
          const businessDate = service.data?.status.businessDate ?? fallbackBusinessDate();
          const groups = [...new Set(items.map((item) => item.category ?? 'senza categoria'))];
          return (
            <>
              {groups.map((group) => (
                <section key={group} className="block">
                  <h3>{group}</h3>
                  <div className="menu-list">
                    {items.filter((item) => (item.category ?? 'senza categoria') === group)
                      .map((item) => <Row key={item.id} item={item} businessDate={businessDate} onSaved={state.reload} />)}
                  </div>
                </section>
              ))}
              <p className="note">"Finito per oggi" toglie il prodotto dall'agente subito e lo rimette da solo domani.</p>
            </>
          );
        }}
      </AsyncView>
    </>
  );
}
