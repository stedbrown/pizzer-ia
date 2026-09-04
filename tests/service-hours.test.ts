import { describe, expect, it } from 'vitest';
import { readyAt, serviceBriefing, serviceStatus } from '../src/service-hours.js';
import { demoServiceSettings, orderable } from '../src/store.js';
import type { MenuItem, ServiceSettings } from '../src/types.js';

const settings = (patch: Partial<ServiceSettings> = {}): ServiceSettings => ({ ...demoServiceSettings(), ...patch });
// Europe/Zurich è UTC+2 a settembre: 18:00 locali sono le 16:00 UTC.
const at = (iso: string) => new Date(iso);

describe('Orari di servizio', () => {
  it('sa se la pizzeria è aperta nell\'ora locale, non in quella del server', () => {
    const open = serviceStatus(settings(), at('2026-09-04T16:00:00Z'));   // venerdì 18:00 a Lugano
    expect(open).toMatchObject({ open: true, localTime: '18:00', closesAt: '22:30' });
    const closed = serviceStatus(settings(), at('2026-09-04T06:00:00Z')); // venerdì 08:00
    expect(closed.open).toBe(false);
    expect(closed.opensAt).toBe('17:00');
  });

  it('dice quando si riapre se oggi è chiuso', () => {
    const monday = serviceStatus(settings(), at('2026-09-07T16:00:00Z'));  // lunedì, giorno di chiusura
    expect(monday).toMatchObject({ open: false, todayHours: [] });
    expect(monday.opensAt).toBe('martedì 17:00');
  });

  it('resta aperta dopo la mezzanotte quando la fascia la supera', () => {
    const late = settings({ hours: [{ weekday: 5, opens: '18:00', closes: '00:30' }] });
    expect(serviceStatus(late, at('2026-09-04T22:00:00Z')).open).toBe(true);   // venerdì 00:00 locali
    expect(serviceStatus(late, at('2026-09-04T23:00:00Z')).open).toBe(false);  // 01:00, ormai chiuso
  });

  it('allunga i tempi nelle serate piene e li azzera per la consegna se non è attiva', () => {
    expect(serviceStatus(settings(), at('2026-09-04T16:00:00Z'))).toMatchObject({ pickupMinutes: 20, deliveryMinutes: 35 });
    expect(serviceStatus(settings({ busyMode: true }), at('2026-09-04T16:00:00Z'))).toMatchObject({ pickupMinutes: 35, deliveryMinutes: 50 });
    const noDelivery = serviceStatus(settings({ acceptsDelivery: false }), at('2026-09-04T16:00:00Z'));
    expect(noDelivery.deliveryMinutes).toBeUndefined();
  });

  it('stima l\'ora di pronto arrotondata come la direbbe una persona', () => {
    const status = serviceStatus(settings(), at('2026-09-04T16:00:00Z'));
    expect(readyAt(status, 'pickup', at('2026-09-04T16:02:00Z')).toISOString()).toBe('2026-09-04T16:25:00.000Z');
    expect(readyAt(status, 'delivery', at('2026-09-04T16:02:00Z')).toISOString()).toBe('2026-09-04T16:40:00.000Z');
  });

  it('scrive un briefing che l\'agente può leggere senza inventare', () => {
    const open = serviceBriefing(serviceStatus(settings(), at('2026-09-04T16:00:00Z')), 'Pizzeria Test');
    expect(open).toContain('Sono le 18:00');
    expect(open).toContain('si chiude alle 22:30');
    expect(open).toContain('circa 20 minuti per il ritiro');
    const closed = serviceBriefing(serviceStatus(settings(), at('2026-09-04T06:00:00Z')), 'Pizzeria Test');
    expect(closed).toContain('CHIUSI');
    expect(closed).toContain('Non prendere ordini');
  });
});

describe('Finito per oggi', () => {
  const item = (patch: Partial<MenuItem>): MenuItem =>
    ({ id: 'i', restaurantId: 'r', name: 'Diavola', priceCents: 1700, active: true, allergens: [], modifiers: [], ...patch });

  it('toglie dal menu un prodotto esaurito e lo rimette il giorno dopo', () => {
    expect(orderable(item({}), '2026-09-04')).toBe(true);
    expect(orderable(item({ soldOutUntil: '2026-09-04' }), '2026-09-04')).toBe(false);
    expect(orderable(item({ soldOutUntil: '2026-09-04' }), '2026-09-05')).toBe(true);
    expect(orderable(item({ active: false }), '2026-09-04')).toBe(false);
  });
});
