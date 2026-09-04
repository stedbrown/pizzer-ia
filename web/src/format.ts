export const money = (cents: number) =>
  new Intl.NumberFormat('it-CH', { style: 'currency', currency: 'CHF' }).format(cents / 100);

export const clock = (iso: string) =>
  new Intl.DateTimeFormat('it-CH', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export const clockSeconds = (iso: string) =>
  new Intl.DateTimeFormat('it-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));

export const today = () =>
  new Intl.DateTimeFormat('it-CH', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

export function since(iso: string) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'adesso';
  if (minutes < 60) return `da ${minutes} min`;
  return `da ${Math.floor(minutes / 60)} h`;
}

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/** Sotto il secondo la telefonata scorre, oltre i due il silenzio si sente. */
export const latencyTone = (ms: number) => (ms < 1000 ? 'fast' : ms < 2000 ? 'ok' : 'slow');

/** I numeri di telefono sono già mascherati dal backend: questa è una seconda rete. */
export const maskPhones = (value: string) =>
  String(value ?? '').replace(/\+?\d(?:[\s().-]*\d){6,}/g, (phone) => {
    if ((phone.match(/\./g) ?? []).length >= 3) return phone;
    const digits = phone.replace(/\D/g, '');
    return digits.length > 4 ? `***${digits.slice(-4)}` : '***';
  });

export const WEEKDAYS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
