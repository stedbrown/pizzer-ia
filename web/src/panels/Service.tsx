import { useEffect, useState } from 'react';
import type { Callback, OpeningSlot, ServiceSettings } from '../../../src/types';
import { api, type ServiceView } from '../api';
import { clock, WEEKDAYS } from '../format';
import { useAsync } from '../hooks';
import { useLiveReload } from '../live';
import { AsyncView, Badge, Field, SectionHeading, Toggle } from '../ui';

function HoursEditor({ hours, onChange }: { hours: OpeningSlot[]; onChange: (hours: OpeningSlot[]) => void }) {
  const byDay = (weekday: number) => hours.filter((slot) => slot.weekday === weekday);
  const replace = (weekday: number, slots: OpeningSlot[]) =>
    onChange([...hours.filter((slot) => slot.weekday !== weekday), ...slots].sort((a, b) => a.weekday - b.weekday || a.opens.localeCompare(b.opens)));
  return (
    <div className="hours">
      {WEEKDAYS.map((name, weekday) => {
        const slots = byDay(weekday);
        return (
          <div key={weekday} className={`hours-row${slots.length ? '' : ' closed'}`}>
            <span className="hours-day">{name}</span>
            <div className="hours-slots">
              {slots.length ? slots.map((slot, index) => (
                <span key={index} className="slot">
                  <input type="time" value={slot.opens} aria-label={`Apertura ${name}`}
                    onChange={(event) => replace(weekday, slots.map((s, i) => i === index ? { ...s, opens: event.target.value } : s))} />
                  <em>→</em>
                  <input type="time" value={slot.closes} aria-label={`Chiusura ${name}`}
                    onChange={(event) => replace(weekday, slots.map((s, i) => i === index ? { ...s, closes: event.target.value } : s))} />
                  <button className="link" onClick={() => replace(weekday, slots.filter((_, i) => i !== index))} aria-label={`Rimuovi fascia ${name}`}>✕</button>
                </span>
              )) : <span className="closed-label">Chiuso</span>}
              <button className="link" onClick={() => replace(weekday, [...slots, { weekday, opens: '17:00', closes: '22:30' }])}>+ fascia</button>
            </div>
          </div>
        );
      })}
      <p className="hint">Una fascia che chiude prima di quando apre supera la mezzanotte: 18:00 → 00:30 è una serata sola.</p>
    </div>
  );
}

function Callbacks({ onCount }: { onCount: (count: number) => void }) {
  const state = useAsync<Callback[]>(() => api.callbacks(), { pollMs: 60_000 });
  useLiveReload(state.reload, (event) => event.source === 'TOOL' && event.message.startsWith('request_callback')
    || event.source === 'DB' && event.message === 'Richiamo segnato come completato');
  const open = (state.data ?? []).filter((callback) => !callback.handledAt);
  useEffect(() => onCount(open.length), [open.length, onCount]);
  if (!state.data?.length) return null;
  return (
    <section className="block">
      <h3>Da richiamare {open.length ? <span className="count urgent">{open.length}</span> : null}</h3>
      <div className="stack tight">
        {state.data.map((callback) => (
          <div key={callback.id} className={`callback${callback.handledAt ? ' done' : ''}`}>
            <time>{clock(callback.createdAt)}</time>
            <strong>{callback.phone ?? 'numero non lasciato'}</strong>
            <span className="reason">{callback.reason}</span>
            {callback.handledAt
              ? <Badge tone="neutral">richiamato</Badge>
              : <button className="primary small" onClick={async () => { await api.resolveCallback(callback.id); state.reload(); }}>Fatto</button>}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ServicePanel({ onCallbacks }: { onCallbacks: (count: number) => void }) {
  const state = useAsync<ServiceView>(() => api.service());
  useLiveReload(state.reload, (event) => event.source === 'BACKEND' && event.message === 'Impostazioni di servizio aggiornate');
  const [draft, setDraft] = useState<ServiceSettings>();
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (state.data) setDraft(state.data.settings); }, [state.data]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try { await api.patchService(draft); state.reload(); } finally { setSaving(false); }
  };

  return (
    <AsyncView state={state}>
      {(view) => {
        const settings = draft ?? view.settings;
        const needsActivation = !view.settings.configured;
        const dirty = needsActivation || JSON.stringify(settings) !== JSON.stringify(view.settings);
        const patch = (change: Partial<ServiceSettings>) => setDraft({ ...settings, ...change });
        return (
          <>
            <SectionHeading eyebrow="SERVIZIO" title="Orari e tempi">
              <div className="now">
                <Badge tone={!view.status.configured ? 'warn' : view.status.open ? 'good' : 'bad'}>
                  {!view.status.configured ? 'Da confermare' : view.status.open ? 'Aperto adesso' : 'Chiuso adesso'}
                </Badge>
                <small>
                  Ora locale {view.status.localTime}
                  {view.status.configured && view.status.open && view.status.closesAt ? ` · si chiude alle ${view.status.closesAt}` : ''}
                  {view.status.configured && !view.status.open && view.status.opensAt ? ` · si riapre ${view.status.opensAt}` : ''}
                </small>
              </div>
            </SectionHeading>

            <div className="split">
              <section className="block">
                <h3>Tempi comunicati al cliente</h3>
                <div className="grid-fields">
                  <Field label="Preparazione" hint="minuti per il ritiro">
                    <input type="number" min={1} max={180} value={settings.prepMinutes}
                      onChange={(event) => patch({ prepMinutes: Number(event.target.value) })} />
                  </Field>
                  <Field label="Consegna" hint="minuti in più sul ritiro">
                    <input type="number" min={0} max={120} value={settings.deliveryExtraMinutes}
                      onChange={(event) => patch({ deliveryExtraMinutes: Number(event.target.value) })} />
                  </Field>
                  <Field label="Serata piena" hint="minuti in più quando è attiva">
                    <input type="number" min={0} max={120} value={settings.busyExtraMinutes}
                      onChange={(event) => patch({ busyExtraMinutes: Number(event.target.value) })} />
                  </Field>
                </div>
                <div className="switches">
                  <Toggle checked={settings.busyMode} onChange={(busyMode) => patch({ busyMode })}
                    label={`Serata piena — l'agente allunga i tempi (ora ${view.status.pickupMinutes} min ritiro)`} />
                  <Toggle checked={settings.acceptsDelivery} onChange={(acceptsDelivery) => patch({ acceptsDelivery })}
                    label="Accettiamo consegne a domicilio" />
                </div>
              </section>

              <section className="block">
                <h3>Orari di apertura</h3>
                <HoursEditor hours={settings.hours} onChange={(hours) => patch({ hours })} />
              </section>
            </div>

            {dirty ? (
              <div className="save-bar">
                <span>{needsActivation
                  ? 'Controlli questi valori: finché non li conferma, l’agente non comunica orari o tempi e non conferma ordini.'
                  : 'Modifiche non salvate — l’agente usa ancora i valori precedenti.'}</span>
                <div className="save-actions">
                  <button className="link ghost" onClick={() => setDraft(view.settings)} disabled={saving}>Annulla</button>
                  <button className="primary" disabled={saving} onClick={save}>{saving ? 'Salvo…' : needsActivation ? 'Conferma e attiva' : 'Salva impostazioni'}</button>
                </div>
              </div>
            ) : null}

            <Callbacks onCount={onCallbacks} />

            <section className="block">
              <h3>Conferma al cliente</h3>
              <p className="hint">
                {view.smsConfigured
                  ? 'Attiva: a ordine confermato parte un messaggio con numero, riepilogo, totale e ora di pronto.'
                  : 'Non configurata: il cliente riattacca senza niente di scritto. Imposta SMS_WEBHOOK_URL per attivarla.'}
              </p>
              <p className="hint">
                {view.humanTransfer
                  ? 'Trasferimento a una persona configurato.'
                  : 'Nessun numero per il trasferimento: l\'agente offre di far richiamare invece di lasciare il cliente in silenzio.'}
              </p>
            </section>
          </>
        );
      }}
    </AsyncView>
  );
}
