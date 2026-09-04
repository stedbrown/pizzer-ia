import { useState } from 'react';
import type { OrderView } from '../../src/types';
import { api, type ServiceView, type TelephonyView } from './api';
import { today } from './format';
import { useAsync } from './hooks';
import { LiveProvider, useLive, useLiveReload } from './live';
import { OrdersPanel } from './panels/Orders';
import { ConversationsPanel } from './panels/Conversations';
import { LogsPanel } from './panels/Logs';
import { MenuPanel } from './panels/Menu';
import { ServicePanel } from './panels/Service';
import { TelephonyPanel } from './panels/Telephony';

type TabId = 'orders' | 'conversations' | 'logs' | 'service' | 'menu' | 'telephony';

export function App() {
  return <LiveProvider><Dashboard /></LiveProvider>;
}

function Dashboard() {
  const [tab, setTab] = useState<TabId>('orders');
  const [callbacks, setCallbacks] = useState(0);
  const orders = useAsync<OrderView[]>(() => api.orders(), { pollMs: 60_000 });
  const telephony = useAsync<TelephonyView>(() => api.telephony(), { pollMs: 60_000 });
  const service = useAsync<ServiceView>(() => api.service(), { pollMs: 60_000 });
  const live = useLive();
  useLiveReload(orders.reload, (event) => event.source === 'ORDER' || event.source === 'DB');
  useLiveReload(telephony.reload, (event) => ['ASTERISK', 'SIPCALL', 'HEARTBEAT', 'CALL', 'OPENAI'].includes(event.source));
  useLiveReload(service.reload, (event) => event.source === 'BACKEND' && event.message === 'Impostazioni di servizio aggiornate');

  const active = orders.data?.filter((order) => !['COMPLETED', 'CANCELLED'].includes(order.status)).length ?? 0;
  const healthy = telephony.data
    ? telephony.data.heartbeatState === 'current' && telephony.data.asteriskOnline === true && telephony.data.sipRegistration === 'registered'
    : undefined;
  const statusLabel = !telephony.data ? 'Stato in verifica'
    : telephony.data.heartbeatState === 'stale' ? 'Heartbeat non aggiornato'
      : telephony.data.heartbeatState === 'unknown' ? 'Stato da verificare'
        : healthy ? 'Centralino collegato' : 'Problema telefonia';

  const tabs: Array<[TabId, string, number?]> = [
    ['orders', 'Ordini', active],
    ['conversations', 'Conversazioni'],
    ['logs', 'Live Logs'],
    ['service', 'Servizio', callbacks],
    ['menu', 'Menu'],
    ['telephony', 'Telefonia']
  ];

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#orders">
          <span className="brand-mark">P</span>
          <span><strong>PIZZER-IA</strong><small>{today()}</small></span>
        </a>
        <nav className="tabs" aria-label="Sezioni">
          {tabs.map(([id, label, count]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
              {count ? <span className="count">{count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span className={`status ${healthy === undefined ? 'unknown' : healthy ? 'ok' : 'ko'}`}><i />{statusLabel}</span>
          <button className="icon" title="Aggiorna" aria-label="Aggiorna"
            onClick={() => { orders.reload(); telephony.reload(); service.reload(); }}>↻</button>
        </div>
      </header>

      <main>
        <section className="dashboard-intro">
          <div><p className="eyebrow">CONSOLE OPERATIVA</p><h1>Buon servizio.</h1><p>Ordini, conversazioni e telefonia aggiornati mentre la chiamata è in corso.</p></div>
          <span className={`stream-state ${live.connected ? 'connected' : ''}`}><i />{live.connected ? 'Aggiornamenti live' : 'Riconnessione live…'}</span>
        </section>
        {tab === 'orders' ? <OrdersPanel state={orders} timezone={service.data?.settings.timezone} /> : null}
        {tab === 'conversations' ? <ConversationsPanel /> : null}
        {tab === 'logs' ? <LogsPanel /> : null}
        {tab === 'service' ? <ServicePanel onCallbacks={setCallbacks} /> : null}
        {tab === 'menu' ? <MenuPanel /> : null}
        {tab === 'telephony' ? <TelephonyPanel /> : null}
      </main>
    </>
  );
}
