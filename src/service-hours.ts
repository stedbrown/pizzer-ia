import type { OpeningSlot, ServiceSettings, ServiceStatus } from './types.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Ora locale della pizzeria, non del server: Northflank gira in UTC. */
export function localNow(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = Math.max(0, DAYS.indexOf(value('weekday')));
  const hour = Number(value('hour')) % 24;
  const minute = Number(value('minute'));
  return {
    weekday,
    minutes: hour * 60 + minute,
    time: `${pad(hour)}:${pad(minute)}`,
    date: `${value('year')}-${value('month')}-${value('day')}`
  };
}

export function isValidTimeZone(value: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}

export function isValidClock(value: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function dateInTimeZone(timezone: string, now = new Date()) {
  return localNow(timezone, now).date;
}

function pad(value: number) { return String(value).padStart(2, '0'); }
function toMinutes(time: string) {
  const [hour = '0', minute = '0'] = time.split(':');
  return Number(hour) * 60 + Number(minute);
}
function shortTime(time: string) { return time.slice(0, 5); }

/** Una fascia con chiusura non successiva all'apertura scavalca la mezzanotte. */
function coversOnOpeningDay(slot: OpeningSlot, minutes: number) {
  const opens = toMinutes(slot.opens);
  const closes = toMinutes(slot.closes);
  return closes > opens ? minutes >= opens && minutes < closes : minutes >= opens;
}

function coversAfterMidnight(slot: OpeningSlot, minutes: number) {
  const opens = toMinutes(slot.opens);
  const closes = toMinutes(slot.closes);
  return closes <= opens && minutes < closes;
}

export function serviceStatus(settings: ServiceSettings, now = new Date()): ServiceStatus {
  const { weekday, minutes, time, date } = localNow(settings.timezone, now);
  const yesterday = (weekday + 6) % 7;
  const todayHours = settings.hours.filter((slot) => slot.weekday === weekday)
    .map((slot) => ({ ...slot, opens: shortTime(slot.opens), closes: shortTime(slot.closes) }))
    .sort((a, b) => toMinutes(a.opens) - toMinutes(b.opens));
  // Una serata iniziata ieri e finita dopo mezzanotte conta ancora come aperto.
  const openSlot = todayHours.find((slot) => coversOnOpeningDay(slot, minutes))
    ?? settings.hours.filter((slot) => slot.weekday === yesterday)
      .map((slot) => ({ ...slot, opens: shortTime(slot.opens), closes: shortTime(slot.closes) }))
      .find((slot) => coversAfterMidnight(slot, minutes));
  const busy = settings.busyMode ? settings.busyExtraMinutes : 0;
  const pickupMinutes = settings.prepMinutes + busy;
  return {
    configured: settings.configured,
    open: Boolean(openSlot),
    busyMode: settings.busyMode,
    acceptsDelivery: settings.acceptsDelivery,
    localTime: time,
    businessDate: date,
    todayHours,
    ...(openSlot ? { closesAt: openSlot.closes } : {}),
    ...(!openSlot && nextOpening(settings, weekday, minutes) ? { opensAt: nextOpening(settings, weekday, minutes) } : {}),
    pickupMinutes,
    ...(settings.acceptsDelivery ? { deliveryMinutes: pickupMinutes + settings.deliveryExtraMinutes } : {})
  };
}

function nextOpening(settings: ServiceSettings, weekday: number, minutes: number) {
  for (let ahead = 0; ahead < 8; ahead += 1) {
    const day = (weekday + ahead) % 7;
    const slots = settings.hours.filter((slot) => slot.weekday === day)
      .map((slot) => shortTime(slot.opens))
      .filter((opens) => ahead > 0 || toMinutes(opens) > minutes)
      .sort((a, b) => toMinutes(a) - toMinutes(b));
    if (slots[0]) return ahead === 0 ? slots[0] : `${DAY_NAMES[day]} ${slots[0]}`;
  }
  return undefined;
}

const DAY_NAMES = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

/** Ora di pronto stimata, arrotondata a 5 minuti come la direbbe una persona. */
export function readyAt(status: ServiceStatus, fulfillment: 'pickup' | 'delivery', now = new Date()) {
  const minutes = fulfillment === 'delivery' ? status.deliveryMinutes ?? status.pickupMinutes : status.pickupMinutes;
  const target = new Date(now.getTime() + minutes * 60_000);
  target.setSeconds(0, 0);
  target.setMinutes(Math.ceil(target.getMinutes() / 5) * 5);
  return target;
}

/** Riga di contesto iniettata nel prompt: nessun round trip in più durante la chiamata. */
export function serviceBriefing(status: ServiceStatus, restaurantName: string) {
  if (!status.configured) {
    return `Le impostazioni operative di ${restaurantName} non sono ancora state confermate. Non dichiarare orari, disponibilità o tempi e non confermare ordini: proponi un richiamo con request_callback.`;
  }
  const hours = status.todayHours.length
    ? status.todayHours.map((slot) => `${slot.opens}-${slot.closes}`).join(' e ')
    : 'oggi chiuso';
  const lines = [
    `Sono le ${status.localTime}. Oggi ${restaurantName} ${status.todayHours.length ? `è aperta ${hours}` : 'è chiusa'}.`
  ];
  if (status.open) {
    lines.push(`Adesso siete aperti e si chiude alle ${status.closesAt}.`);
    lines.push(`Se chiedono i tempi: circa ${status.pickupMinutes} minuti per il ritiro${status.deliveryMinutes ? `, circa ${status.deliveryMinutes} per la consegna` : ''}. Sono stime della pizzeria, puoi dirle.`);
    if (!status.acceptsDelivery) lines.push('Le consegne non sono attive: si può solo ritirare.');
    if (status.busyMode) lines.push('È una serata piena: i tempi sono già più lunghi del solito, non prometterne di più corti.');
  } else {
    lines.push(`Adesso siete CHIUSI${status.opensAt ? `: si riapre ${status.opensAt.includes(':') && status.opensAt.length <= 5 ? `alle ${status.opensAt}` : status.opensAt}` : ''}.`);
    lines.push('Non prendere ordini: dillo con gentilezza, di\' quando riaprite e saluta. Se insistono o è urgente, offri di far richiamare con request_callback.');
  }
  return lines.join(' ');
}
