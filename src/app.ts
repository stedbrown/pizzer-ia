import { createHash, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { Store } from './store.js';
import { DEMO_RESTAURANT_ID } from './store.js';
import type { NewLiveLogEvent, OrderStatus } from './types.js';
import { verifyOpenAIWebhook } from './webhook-signature.js';
import { acceptRealtimeCall, connectSideband, DEFAULT_REALTIME_MODEL, DEFAULT_VOICE } from './realtime.js';
import { publicLogEvent, safeLogEvent } from './live-logs.js';

export interface AppOptions {
  store: Store;
  adminPassword: string;
  webhookSecret?: string;
  apiKey?: string;
  realtimeModel?: string;
  voice?: string;
  greeting?: string;
  largeOrderThreshold?: number;
  turnDetection?: string;
  vadEagerness?: string;
  heartbeatSecret?: string;
  publicDir?: string;
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 1_000_000 });
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.register(fastifyStatic, { root: options.publicDir ?? join(process.cwd(), 'public'), decorateReply: true });
  const liveClients = new Map<ServerResponse, NodeJS.Timeout>();
  app.addHook('onClose', async () => {
    for (const [client, timer] of liveClients) {
      clearInterval(timer);
      client.end();
    }
    liveClients.clear();
  });
  const emitLog = async (input: Omit<NewLiveLogEvent, 'category'> & { category?: NewLiveLogEvent['category'] }) => {
    const saved = publicLogEvent(await options.store.addLogEvent(DEMO_RESTAURANT_ID, safeLogEvent(input)));
    const payload = `id: ${saved.id}\nevent: log\ndata: ${JSON.stringify(saved)}\n\n`;
    for (const client of liveClients.keys()) {
      try { client.write(payload); } catch { const timer = liveClients.get(client); if (timer) clearInterval(timer); liveClients.delete(client); }
    }
    return saved;
  };

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
    const before = await options.store.getTelephonyStatus(DEMO_RESTAURANT_ID);
    await options.store.updateTelephonyStatus(DEMO_RESTAURANT_ID, body);
    const testModeExpiresAt = await options.store.getTestModeUntil(DEMO_RESTAURANT_ID);
    if (before.asteriskOnline !== body.asteriskOnline) await emitLog({ source: 'ASTERISK', level: body.asteriskOnline ? 'INFO' : 'ERROR', message: body.asteriskOnline ? 'Service online' : 'Service unavailable' });
    if (before.sipRegistration !== body.sipRegistration) await emitLog({ source: 'SIPCALL', level: body.sipRegistration === 'registered' ? 'INFO' : 'WARN', message: body.sipRegistration === 'registered' ? 'Registered' : `Registration ${body.sipRegistration}` });
    if (testModeExpiresAt) await emitLog({ source: 'HEARTBEAT', level: 'DEBUG', message: 'Status received in test mode' });
    return { ok: true, testMode: Boolean(testModeExpiresAt), testModeExpiresAt: testModeExpiresAt ?? null };
  });
  app.post('/api/telephony/events', { preHandler: heartbeatAuth }, async (request) => {
    const events = z.array(z.object({
      source: z.enum(['ASTERISK','SIPCALL','SIP','CALL','RTP','HEARTBEAT']),
      level: z.enum(['DEBUG','INFO','WARN','ERROR']),
      message: z.string().trim().min(1).max(1000),
      callId: z.string().trim().max(128).optional(),
      timestamp: z.string().datetime().optional()
    })).min(1).max(50).parse(jsonBody(request));
    for (const event of events) await emitLog(event);
    return { ok: true, accepted: events.length };
  });
  app.get('/api/telephony/status', { preHandler: auth }, async () => {
    const status = await options.store.getTelephonyStatus(DEMO_RESTAURANT_ID);
    const checkedAtMs = Date.parse(status.checkedAt);
    const neverReceived = !Number.isFinite(checkedAtMs) || checkedAtMs <= 0;
    const stale = !neverReceived && Date.now() - checkedAtMs > 90_000;
    const heartbeatState = neverReceived ? 'unknown' : stale ? 'stale' : 'current';
    let databaseOnline = true;
    try { await options.store.health(); } catch { databaseOnline = false; }
    return {
      provider: 'sipcall', plan: 'Classic', number: '091 210 20 49',
      asteriskOnline: stale ? null : status.asteriskOnline,
      sipRegistration: stale ? 'unknown' : status.sipRegistration,
      version: status.version, checkedAt: neverReceived ? null : status.checkedAt, heartbeatState,
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
  app.get('/api/live-logs', { preHandler: auth }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    return (await options.store.listLogEvents(DEMO_RESTAURANT_ID, query.limit)).map(publicLogEvent);
  });
  app.get('/api/live-logs/stream', { preHandler: auth }, async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write('retry: 3000\n\n');
    const timer = setInterval(() => { try { reply.raw.write(': keepalive\n\n'); } catch { clearInterval(timer); liveClients.delete(reply.raw); } }, 15_000);
    liveClients.set(reply.raw, timer);
    request.raw.on('close', () => { clearInterval(timer); liveClients.delete(reply.raw); });
  });
  app.get('/api/test-mode', { preHandler: auth }, async () => {
    const expiresAt = await options.store.getTestModeUntil(DEMO_RESTAURANT_ID);
    return { enabled: Boolean(expiresAt), expiresAt: expiresAt ?? null };
  });
  app.post('/api/test-mode', { preHandler: auth }, async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(jsonBody(request));
    const expiresAt = enabled ? new Date(Date.now() + 15 * 60_000).toISOString() : undefined;
    await options.store.setTestModeUntil(DEMO_RESTAURANT_ID, expiresAt);
    await emitLog({ source: 'BACKEND', level: 'INFO', message: enabled ? 'Test mode enabled for 15 minutes' : 'Test mode disabled' });
    return { enabled, expiresAt: expiresAt ?? null };
  });

  app.post('/webhooks/openai', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body ?? {}));
    if (!options.webhookSecret || !verifyOpenAIWebhook(raw, request.headers, options.webhookSecret)) return reply.code(401).send({ error: 'Firma webhook non valida' });
    let event: any;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'JSON non valido' }); }
    const eventId = request.headers['webhook-id'] as string || event.id;
    if (!eventId || !event.type) return reply.code(400).send({ error: 'Evento non valido' });
    if (!(await options.store.claimWebhook(eventId, event.type, event))) {
      await emitLog({ source: 'WEBHOOK', level: 'DEBUG', message: 'Duplicate event ignored' });
      return { ok: true, duplicate: true };
    }
    if (event.type !== 'realtime.call.incoming') {
      await emitLog({ source: 'WEBHOOK', level: 'DEBUG', message: `Event ignored: ${event.type}` });
      return { ok: true, ignored: true };
    }
    let currentCallId: string | undefined;
    try {
      if (!options.apiKey) throw new Error('OpenAI API key non configurata');
      const headers = Array.isArray(event.data?.sip_headers) ? event.data.sip_headers : [];
      const from = sipHeader(headers, 'From');
      const to = sipHeader(headers, 'To');
      const callId = z.string().min(1).parse(event.data?.call_id);
      currentCallId = callId;
      await emitLog({ source: 'WEBHOOK', level: 'INFO', message: 'Incoming Realtime call received', callId });
      await emitLog({ source: 'SIP', level: 'INFO', message: 'Incoming INVITE', callId });
      const restaurant = await options.store.restaurantForDid(to);
      if (!restaurant) {
        await emitLog({ source: 'BACKEND', level: 'ERROR', message: 'DID not associated', callId });
        return reply.code(404).send({ error: 'DID non associato' });
      }
      await options.store.saveCall({ callId, from, to, restaurantId: restaurant.id });
      await emitLog({ source: 'DB', level: 'INFO', message: 'Call record created', callId });
      const testMode = Boolean(await options.store.getTestModeUntil(restaurant.id));
      await acceptRealtimeCall({
        callId, restaurantName: restaurant.name, callerPhone: from, apiKey: options.apiKey,
        model: options.realtimeModel ?? DEFAULT_REALTIME_MODEL, voice: options.voice ?? DEFAULT_VOICE,
        greeting: options.greeting, largeOrderThreshold: options.largeOrderThreshold,
        turnDetection: options.turnDetection, vadEagerness: options.vadEagerness, testMode
      });
      await emitLog({ source: 'OPENAI', level: 'INFO', message: 'Realtime call accepted', callId });
      connectSideband({ callId, restaurantId: restaurant.id, callerPhone: from, apiKey: options.apiKey, store: options.store, log: emitLog });
      return { ok: true };
    } catch (error) {
      await options.store.releaseWebhook(eventId);
      await emitLog({ source: 'BACKEND', level: 'ERROR', message: error instanceof Error ? error.message : 'Incoming call setup failed', callId: currentCallId });
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
