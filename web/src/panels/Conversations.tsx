import { useState } from 'react';
import type { Conversation, ConversationTurn } from '../../../src/types';
import { api } from '../api';
import { clockSeconds, latencyTone, maskPhones, plural, seconds } from '../format';
import { useAsync } from '../hooks';
import { useLiveReload } from '../live';
import { AsyncView, Chip, SectionHeading, Toggle, type Tone } from '../ui';

const OUTCOME: Record<Conversation['outcome'], Tone> = {
  confermato: 'good', trasferita: 'warn', 'in corso': 'live', chiusa: 'neutral'
};
const SPEAKER: Partial<Record<ConversationTurn['role'], string>> = { customer: 'Cliente', agent: 'Pizzeria' };

function Turn({ turn }: { turn: ConversationTurn }) {
  const technical = turn.role === 'tool' || turn.role === 'system';
  return (
    <div className={`turn ${turn.role}${turn.bargeIn ? ' barge' : ''}${technical ? ' technical' : ''}`}>
      <span className="turn-at">+{Math.round(turn.offsetMs / 1000)}s</span>
      <div className="turn-body">
        {technical ? null : <span className="turn-who">{SPEAKER[turn.role]}</span>}
        <span className="turn-text">{maskPhones(turn.text)}</span>
        {turn.latencyMs !== undefined
          ? <span className={`lat ${latencyTone(turn.latencyMs)}`} title="Attesa prima di rispondere">{seconds(turn.latencyMs)}</span>
          : null}
      </div>
    </div>
  );
}

function Call({ call, defaultOpen }: { call: Conversation; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { metrics } = call;
  return (
    <article className={`conversation${open ? ' open' : ''}`}>
      <button className="conversation-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="conv-time">{clockSeconds(call.startedAt)}</span>
        <Chip tone={OUTCOME[call.outcome]}>{call.outcome}</Chip>
        <span className="conv-headline">{call.headline ?? ''}</span>
        <span className="conv-metrics">
          <Chip>{call.durationSeconds}s</Chip>
          <Chip>{plural(metrics.customerTurns + metrics.agentTurns, 'battuta', 'battute')}</Chip>
          {metrics.avgResponseMs !== undefined
            ? <Chip tone={latencyTone(metrics.avgResponseMs) === 'slow' ? 'bad' : latencyTone(metrics.avgResponseMs) === 'ok' ? 'warn' : 'good'}>
                risposta {seconds(metrics.avgResponseMs)}
              </Chip>
            : null}
          {metrics.bargeIns ? <Chip tone="warn">{plural(metrics.bargeIns, 'interruzione', 'interruzioni')}</Chip> : null}
        </span>
      </button>
      {open ? <div className="turns">{call.turns.map((turn, index) => <Turn key={index} turn={turn} />)}</div> : null}
    </article>
  );
}

export function ConversationsPanel() {
  const state = useAsync<Conversation[]>(() => api.conversations(), { pollMs: 60_000 });
  useLiveReload(state.reload, (event) => Boolean(event.callId) && ['USER', 'AGENT', 'TOOL', 'ORDER', 'CALL'].includes(event.source));
  const [technical, setTechnical] = useState(false);
  return (
    <>
      <SectionHeading eyebrow="QUALITÀ CONVERSAZIONALE" title="Telefonate">
        <Toggle checked={technical} onChange={setTechnical} label="Mostra dettagli tecnici" />
      </SectionHeading>
      <div className={`conversation-list${technical ? ' with-technical' : ''}`}>
        <AsyncView
          state={state}
          empty={{
            title: 'Nessuna telefonata registrata',
            hint: 'Le trascrizioni esistono solo per le chiamate fatte in Modalità test.',
            when: (calls) => calls.length === 0
          }}
        >
          {(calls) => <>{calls.map((call, index) => <Call key={call.callId} call={call} defaultOpen={index === 0} />)}</>}
        </AsyncView>
      </div>
      <p className="note">Ricostruite dagli eventi già registrati · numeri mascherati · conservate al massimo 24 ore</p>
    </>
  );
}
