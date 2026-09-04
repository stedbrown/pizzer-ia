import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LiveLogEvent } from '../../src/types';
import { api } from './api';

interface LiveState {
  events: LiveLogEvent[];
  connected: boolean;
  latest?: LiveLogEvent;
}

const LiveContext = createContext<LiveState>({ events: [], connected: false });

function mergeEvents(current: LiveLogEvent[], incoming: LiveLogEvent[]) {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-500);
}

/** Una sola connessione SSE alimenta tutte le tab e resta aperta anche cambiando sezione. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<LiveLogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<LiveLogEvent>();

  useEffect(() => {
    let alive = true;
    api.logs().then((rows) => { if (alive) setEvents((current) => mergeEvents(current, rows)); }).catch(() => undefined);
    const stream = new EventSource('/api/live-logs/stream');
    stream.addEventListener('open', () => setConnected(true));
    stream.addEventListener('error', () => setConnected(false));
    stream.addEventListener('log', (raw) => {
      try {
        const event = JSON.parse((raw as MessageEvent).data) as LiveLogEvent;
        setEvents((current) => mergeEvents(current, [event]));
        setLatest(event);
      } catch { /* evento incompleto: EventSource si riconnette e il fetch iniziale resta disponibile */ }
    });
    return () => { alive = false; stream.close(); };
  }, []);

  const value = useMemo(() => ({ events, connected, latest }), [events, connected, latest]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() { return useContext(LiveContext); }

/** Ricarica la risorsa interessata una volta per raffica di eventi, senza polling al secondo. */
export function useLiveReload(reload: () => void, matches: (event: LiveLogEvent) => boolean, delayMs = 150) {
  const { latest } = useLive();
  const reloadRef = useRef(reload);
  const matchesRef = useRef(matches);
  reloadRef.current = reload;
  matchesRef.current = matches;
  useEffect(() => {
    if (!latest || !matchesRef.current(latest)) return;
    const timer = setTimeout(() => reloadRef.current(), delayMs);
    return () => clearTimeout(timer);
  }, [latest?.id, delayMs]);
}
