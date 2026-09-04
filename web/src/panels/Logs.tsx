import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveLogEvent } from '../../../src/types';
import { api } from '../api';
import { clockSeconds, maskPhones } from '../format';
import { Badge, SectionHeading } from '../ui';

const FILTERS = [
  ['all', 'Tutto'], ['errors', 'Errori'], ['telephony', 'Telefonia'],
  ['openai', 'OpenAI'], ['tool', 'Tool'], ['backend', 'Backend'], ['database', 'Database']
] as const;
const CATEGORY: Record<string, string> = {
  telephony: 'TELEPHONY', openai: 'OPENAI', backend: 'BACKEND', tool: 'TOOL', database: 'DATABASE'
};

export function LogsPanel() {
  const [events, setEvents] = useState<LiveLogEvent[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [testUntil, setTestUntil] = useState<string>();
  const [remaining, setRemaining] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.logs().then((rows) => { if (alive) setEvents(rows); }).catch(() => undefined);
    api.testMode().then((state) => { if (alive) setTestUntil(state.expiresAt ?? undefined); }).catch(() => undefined);
    const stream = new EventSource('/api/live-logs/stream');
    stream.addEventListener('open', () => setStreaming(true));
    stream.addEventListener('error', () => setStreaming(false));
    stream.addEventListener('log', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as LiveLogEvent;
        setEvents((current) => current.some((item) => item.id === parsed.id) ? current : [...current, parsed].slice(-500));
      } catch { /* riga malformata: si ignora */ }
    });
    return () => { alive = false; stream.close(); };
  }, []);

  useEffect(() => {
    const tick = () => setRemaining(testUntil ? Math.max(0, Date.parse(testUntil) - Date.now()) : 0);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [testUntil]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return [...events]
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .filter((event) => {
        if (needle && !`${event.source} ${event.message}`.toLowerCase().includes(needle)) return false;
        if (filter === 'all') return true;
        if (filter === 'errors') return event.level === 'ERROR';
        return CATEGORY[filter] === event.category;
      });
  }, [events, filter, search]);

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [visible.length]);

  const toggleTest = async () => {
    const state = await api.setTestMode(!remaining);
    setTestUntil(state.expiresAt ?? undefined);
  };

  let lastCall: string | undefined;
  return (
    <>
      <SectionHeading eyebrow="DIAGNOSTICA LIVE" title="Percorso chiamate">
        <div className="test-mode">
          <Badge tone={streaming ? 'live' : 'warn'}>{streaming ? 'Live' : 'Riconnessione…'}</Badge>
          <button className={remaining ? 'danger' : 'secondary'} onClick={toggleTest}>
            {remaining ? 'Disabilita modalità test' : 'Abilita modalità test'}
          </button>
          <small>{remaining ? `Registra ancora per ${Math.ceil(remaining / 60_000)} min` : 'Trascrizioni non registrate'}</small>
        </div>
      </SectionHeading>

      <div className="log-toolbar">
        <div className="filters">
          {FILTERS.map(([value, label]) => (
            <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <input type="search" placeholder="Cerca nel log…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Cerca nel log" />
      </div>

      <div className="log-list" ref={listRef}>
        {visible.length ? visible.map((event) => {
          const divider = event.callId && event.callId !== lastCall
            ? <div key={`d-${event.id}`} className="log-divider"><span>{maskPhones(event.callId)}</span></div>
            : null;
          lastCall = event.callId ?? lastCall;
          return (
            <div key={event.id}>
              {divider}
              <div className={`log-row level-${event.level.toLowerCase()}`}>
                <time>{clockSeconds(event.timestamp)}</time>
                <b className={`source cat-${event.category.toLowerCase()}`}>{event.source}</b>
                <span className="log-message">{maskPhones(event.message)}</span>
              </div>
            </div>
          );
        }) : <div className="log-empty">Nessun evento per questo filtro.</div>}
      </div>
      <p className="note">Eventi strutturati recenti · numeri telefonici mascherati · nessun secret visualizzato</p>
    </>
  );
}
