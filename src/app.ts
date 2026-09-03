import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { Store } from './store.js';
import { DEMO_RESTAURANT_ID } from './store.js';
import type { OrderStatus } from './types.js';
import { verifyOpenAIWebhook } from './webhook-signature.js';
import { acceptRealtimeCall, connectSideband } from './realtime.js';

export interface AppOptions {
  store: Store;
  adminPassword: string;
  webhookSecret?: string;
  apiKey?: string;
  realtimeModel?: string;
  voice?: string;
  heartbeatSecret?: string;
  publicDir?: string;
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 1_000_000 });
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.register(fastifyStatic, { root: options.publicDir ?? join(process.cwd(), 'public'), decorateReply: true });

  const auth = async (request: FastifyRequest, reply: FastifyReply) => {
    const expected = `admin:${options.adminPassword}`;
    const header = request.headers.authorization;
    let supplied: string;
    try { supplied = header?.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : ''; } catch { supplied = ''; }
    const left = createHash('sha256').update(supplied).digest();
    const right = createHash('sha256').update(expected).digest();
    if (!timingSafeEqual(left, right)) return reply.header('WWW-Authenticate', 'Basic realm="Pizzer-IA"').code(401).send({ error: 'Autenticazione richiesta' });
  };
  const heartbeatAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const supplied = String(request.headers['x-heartbeat-token'] ?? '');
    const expected = options.heartbeatSecret ?? '';
    const left = createHash('sha256').update(supplied).digest();
    const right = createHash('sha256').update(expected).digest();
    if (!expected || !timingSafeEqual(left, right)) return reply.code(401).send({ error: 'Token heartbeat non valido' });
  };

  app.get('/health', async (_request, reply) => {
    try { await options.store.health(); return { status: 'ok', database: 'connected' }; }
    catch { return reply.code(503).send({ status: 'error', database: 'unavailable' }); }
  });
  app.get('/', { preHandler: auth }, (_request, reply) => reply.sendFile('index.html'));
  app.get('/app.js', { preHandler: auth }, (_request, reply) => reply.sendFile('app.js'));
  app.get('/styles.css', { preHandler: auth }, (_request, reply) => reply.sendFile('styles.css'));

  app.get('/api/orders', { preHandler: auth }, async () => options.store.listOrders(DEMO_RESTAURANT_ID));
  app.patch('/api/orders/:id/status', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ status: z.enum(['NEW','CONFIRMED','PREPARING','READY','COMPLETED','CANCELLED']) }).parse(jsonBody(request));
    const updated = await options.store.setOrderStatus(DEMO_RESTAURANT_ID, params.id, body.status as OrderStatus);
    return updated ? { ok: true } : reply.code(404).send({ error: 'Ordine non trovato' });
  });
  app.get('/api/menu', { preHandler: auth }, async () => options.store.getMenu(DEMO_RESTAURANT_ID, undefined, true));
  app.patch('/api/menu/:id', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), priceCents: z.number().int().min(0).max(100000).optional(), active: z.boolean().optional() }).parse(jsonBody(request));
    const item = await options.store.updateMenuItem(DEMO_RESTAURANT_ID, params.id, body);
    return item ?? reply.code(404).send({ error: 'Prodotto non trovato' });
  });
  app.post('/api/telephony/heartbeat', { preHandler: heartbeatAuth }, async (request) => {
    const body = z.object({
      asteriskOnline: z.boolean(),
      sipRegistration: z.enum(['registered', 'unregistered', 'unknown']),
      version: z.string().trim().max(80).optional(),
      checkedAt: z.string().datetime()
    }).parse(jsonBody(request));
    await options.store.updateTelephonyStatus(DEMO_RESTAURANT_ID, body);
    return { ok: true };
  });
  app.get('/api/telephony/status', { preHandler: auth }, async () => {
    const status = await options.store.getTelephonyStatus(DEMO_RESTAURANT_ID);
    const stale = Date.now() - Date.parse(status.checkedAt) > 180_000;
    let databaseOnline = true;
    try { await options.store.health(); } catch { databaseOnline = false; }
    return {
      provider: 'sipcall', plan: 'Classic', number: '091 210 20 49',
      asteriskOnline: stale ? null : status.asteriskOnline,
      sipRegistration: stale ? 'unknown' : status.sipRegistration,
      version: status.version, checkedAt: status.checkedAt, heartbeatStale: stale,
      inboundStatus: status.inboundStatus, audioStatus: status.audioStatus,
      openaiRealtime: options.apiKey && options.webhookSecret ? 'ready' : status.openaiRealtime,
      backendOnline: true, databaseOnline
    };
  });
  app.get('/api/usage/monthly', { preHandler: auth }, async () => ({
    ...(await options.store.getMonthlyUsage(DEMO_RESTAURANT_ID)),
    sipcallMonthlyChfCents: 380,
    sipcallPriceSource: 'CURRENT',
    infrastructureCost: null,
    totalCost: null,
    openaiCostCurrency: 'USD'
  }));

  app.post('/webhooks/openai', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body ?? {}));
    if (!options.webhookSecret || !verifyOpenAIWebhook(raw, request.headers, options.webhookSecret)) return reply.code(401).send({ error: 'Firma webhook non valida' });
    let event: any;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'JSON non valido' }); }
    const eventId = request.headers['webhook-id'] as string || event.id;
    if (!eventId || !event.type) return reply.code(400).send({ error: 'Evento non valido' });
    if (!(await options.store.claimWebhook(eventId, event.type, event))) return { ok: true, duplicate: true };
    if (event.type !== 'realtime.call.incoming') return { ok: true, ignored: true };
    try {
      if (!options.apiKey) throw new Error('OpenAI API key non configurata');
      const headers = Array.isArray(event.data?.sip_headers) ? event.data.sip_headers : [];
      const from = sipHeader(headers, 'From');
      const to = sipHeader(headers, 'To');
      const restaurant = await options.store.restaurantForDid(to);
      if (!restaurant) return reply.code(404).send({ error: 'DID non associato' });
      const callId = z.string().min(1).parse(event.data?.call_id);
      await options.store.saveCall({ callId, from, to, restaurantId: restaurant.id });
      await acceptRealtimeCall({ callId, restaurantName: restaurant.name, callerPhone: from, apiKey: options.apiKey, model: options.realtimeModel ?? 'gpt-realtime-2.1-mini', voice: options.voice ?? 'marin' });
      connectSideband({ callId, restaurantId: restaurant.id, callerPhone: from, apiKey: options.apiKey, store: options.store });
      return { ok: true };
    } catch (error) {
      await options.store.releaseWebhook(eventId);
      request.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'incoming call setup failed');
      return reply.code(502).send({ error: 'Impossibile inizializzare la chiamata' });
    }
  });
  return app;
}

function jsonBody(request: FastifyRequest) {
  if (Buffer.isBuffer(request.body)) return JSON.parse(request.body.toString('utf8'));
  return request.body;
}

function sipHeader(headers: Array<{ name?: string; value?: string }>, name: string) {
  return headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value;
}
