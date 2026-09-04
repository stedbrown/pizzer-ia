import { api, type TelephonyView, type UsageView } from '../api';
import { money } from '../format';
import { useAsync } from '../hooks';
import { AsyncView, Badge, SectionHeading, type Tone } from '../ui';

const state = (ok: boolean | null | undefined, yes: string, no: string) =>
  ok === true ? <Badge tone="good">{yes}</Badge>
    : ok === false ? <Badge tone="bad">{no}</Badge>
      : <Badge tone="neutral">N/D</Badge>;

function Row({ label, children, tone }: { label: string; children: React.ReactNode; tone?: Tone }) {
  return (
    <article className={`info${tone ? ` ${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{children}</strong>
    </article>
  );
}

export function TelephonyPanel() {
  const telephony = useAsync<TelephonyView>(() => api.telephony(), { pollMs: 30_000 });
  const usage = useAsync<UsageView>(() => api.usage());
  return (
    <>
      <SectionHeading eyebrow="INFRASTRUTTURA" title="Telefonia e costi">
        <p className="hint">
          {telephony.data?.checkedAt
            ? `Ultimo controllo: ${new Intl.DateTimeFormat('it-CH', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(telephony.data.checkedAt))}`
            : 'Nessun heartbeat ricevuto'}
        </p>
      </SectionHeading>

      <AsyncView state={telephony}>
        {(status) => {
          const stale = status.heartbeatState !== 'current';
          const unavailable = <Badge tone={status.heartbeatState === 'stale' ? 'warn' : 'neutral'}>{status.heartbeatState === 'stale' ? 'Non aggiornato' : 'N/D'}</Badge>;
          return (
            <div className="info-grid">
              <Row label="Numero"><>{status.number}<small>{status.provider} {status.plan}</small></></Row>
              <Row label="Asterisk">{stale ? unavailable : state(status.asteriskOnline, 'Online', 'Offline')}</Row>
              <Row label="Registrazione SIP">{stale ? unavailable : state(status.sipRegistration === 'registered', 'Registrata', 'Non registrata')}</Row>
              <Row label="OpenAI Realtime">{state(status.openaiRealtime === 'ready' || status.openaiRealtime === 'connected', 'Configurato', 'In attesa')}</Row>
              <Row label="Voice agent"><>{status.realtimeModel}<small>voce {status.voice} · {status.turnDetection}</small></></Row>
              <Row label="Trasferimento umano">{state(status.humanTransfer, 'Configurato', 'Non configurato')}</Row>
              <Row label="Backend">{state(status.backendOnline, 'Online', 'Offline')}</Row>
              <Row label="PostgreSQL">{state(status.databaseOnline, 'Connesso', 'Non connesso')}</Row>
            </div>
          );
        }}
      </AsyncView>

      <AsyncView state={usage}>
        {(month) => (
          <div className="info-grid">
            <Row label="Chiamate del mese">{month.calls}</Row>
            <Row label="Durata totale">{Math.floor(month.durationSeconds / 60)} min {month.durationSeconds % 60} s</Row>
            <Row label="Ordini presi">{month.orders}</Row>
            <Row label="Valore ordini">{money(month.orderValueCents)}</Row>
            <Row label="OpenAI Realtime">
              <>{month.usageSource === 'N/D'
                ? 'N/D'
                : new Intl.NumberFormat('it-CH', { style: 'currency', currency: 'USD', minimumFractionDigits: 4 }).format(month.openaiCostUsdMicros / 1_000_000)}
              <small>{month.usageSource}</small></>
            </Row>
            <Row label="sipcall Classic"><>{money(month.sipcallMonthlyChfCents)}<small>canone mensile</small></></Row>
          </div>
        )}
      </AsyncView>
      <p className="note">Il totale complessivo non è calcolato: mancano cambio USD/CHF e costo infrastruttura.</p>
    </>
  );
}
