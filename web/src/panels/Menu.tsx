import { useState } from 'react';
import type { MenuItem } from '../../../src/types';
import { api } from '../api';
import { useAsync } from '../hooks';
import { AsyncView, Badge, SectionHeading } from '../ui';

const todayIso = () => new Date().toISOString().slice(0, 10);
const soldOut = (item: MenuItem) => Boolean(item.soldOutUntil && item.soldOutUntil >= todayIso());

function Row({ item, onSaved }: { item: MenuItem; onSaved: () => void }) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState((item.priceCents / 100).toFixed(2));
  const [category, setCategory] = useState(item.category ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = name !== item.name || price !== (item.priceCents / 100).toFixed(2) || category !== (item.category ?? '');

  const patch = async (change: Record<string, unknown>) => {
    setBusy(true);
    try { await api.patchMenuItem(item.id, change); onSaved(); } finally { setBusy(false); }
  };

  return (
    <div className={`menu-row${item.active ? '' : ' off'}${soldOut(item) ? ' sold-out' : ''}`}>
      <input className="name" value={name} onChange={(event) => setName(event.target.value)} aria-label="Nome prodotto" />
      <input className="category" value={category} placeholder="categoria" onChange={(event) => setCategory(event.target.value)} aria-label="Categoria" />
      <label className="price">CHF <input type="number" min={0} step={0.5} value={price} onChange={(event) => setPrice(event.target.value)} aria-label="Prezzo" /></label>
      <div className="menu-flags">
        {item.allergens.length ? <span className="allergens" title="Allergeni a menu">{item.allergens.join(' · ')}</span> : null}
        {soldOut(item) ? <Badge tone="warn">finito oggi</Badge> : null}
        {item.active ? null : <Badge tone="neutral">fuori menu</Badge>}
      </div>
      <div className="menu-actions">
        <button className="link" disabled={busy}
          onClick={() => patch({ soldOutUntil: soldOut(item) ? null : todayIso() })}>
          {soldOut(item) ? 'Rimetti in menu' : 'Finito per oggi'}
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
  return (
    <>
      <SectionHeading eyebrow="LISTINO" title="Menu della pizzeria">
        <p className="hint">I prezzi restano decisi dal backend: l'agente non può inventarli né scontarli.</p>
      </SectionHeading>
      <AsyncView state={state} empty={{ title: 'Menu vuoto', when: (items) => items.length === 0 }}>
        {(items) => {
          const groups = [...new Set(items.map((item) => item.category ?? 'senza categoria'))];
          return (
            <>
              {groups.map((group) => (
                <section key={group} className="block">
                  <h3>{group}</h3>
                  <div className="menu-list">
                    {items.filter((item) => (item.category ?? 'senza categoria') === group)
                      .map((item) => <Row key={item.id} item={item} onSaved={state.reload} />)}
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
