import type { OrderView } from './types.js';

/**
 * La conferma al cliente esce da un webhook generico invece che da un provider specifico:
 * sipcall, Twilio o qualunque altro si collegano con un piccolo proxy, senza toccare il codice.
 * Senza SMS_WEBHOOK_URL la funzione non fa nulla e non fallisce mai la chiamata.
 */
export function smsConfigured() {
  return Boolean(process.env.SMS_WEBHOOK_URL);
}

export function orderConfirmationText(order: OrderView, restaurantName: string, readyTime?: string) {
  const items = order.items.map((item) => `${item.quantity}x ${item.name}`).join(', ');
  const when = readyTime ? ` ${order.fulfillment === 'delivery' ? 'Consegna' : 'Pronto'} verso le ${readyTime}.` : '';
  const where = order.fulfillment === 'delivery' && order.deliveryAddress ? ` Consegna in ${order.deliveryAddress}.` : '';
  const total = (order.totalCents / 100).toFixed(2);
  return `${restaurantName}: ordine ${order.orderNumber} confermato. ${items}. Totale CHF ${total}.${when}${where}`.slice(0, 320);
}

/** Restituisce true solo se il messaggio è stato accettato dal provider. */
export async function sendSms(to: string, text: string) {
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url || !to) return false;
  const token = process.env.SMS_WEBHOOK_TOKEN;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ to, text })
  });
  if (!response.ok) throw new Error(`SMS provider ${response.status}`);
  return true;
}
