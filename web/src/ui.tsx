import type { ReactNode } from 'react';

export type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'live';

export function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {children}
    </header>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Chip({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <article className={`card ${className}`.trim()}>{children}</article>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <article className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </article>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="placeholder">
      <p>{title}</p>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function Loading({ label = 'Caricamento…' }: { label?: string }) {
  return <div className="placeholder loading"><p>{label}</p></div>;
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="placeholder error"><p>{message}</p></div>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/** Stato di caricamento, errore e vuoto in un posto solo: le viste restano leggibili. */
export function AsyncView<T>({ state, empty, children }: {
  state: { data?: T; error?: string; loading: boolean };
  empty?: { title: string; hint?: string; when: (data: T) => boolean };
  children: (data: T) => ReactNode;
}) {
  if (state.error) return <ErrorNote message={state.error} />;
  if (!state.data) return state.loading ? <Loading /> : <Empty title="Nessun dato" />;
  if (empty?.when(state.data)) return <Empty title={empty.title} hint={empty.hint} />;
  return <>{children(state.data)}</>;
}
