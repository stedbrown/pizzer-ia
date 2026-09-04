import { buildApp } from './app.js';
import { createPool, migrate } from './db.js';
import { PostgresStore } from './postgres-store.js';
import { DEMO_RESTAURANT_ID } from './store.js';
import { safeLogEvent } from './live-logs.js';

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = required('DATABASE_URL');
const adminPassword = required('ADMIN_PASSWORD');
const pool = createPool(databaseUrl);
await migrate(pool);
const store = new PostgresStore(pool);
const app = buildApp({
  store, adminPassword,
  webhookSecret: process.env.OPENAI_WEBHOOK_SECRET,
  apiKey: process.env.OPENAI_API_KEY,
  realtimeModel: process.env.OPENAI_REALTIME_MODEL,
  voice: process.env.OPENAI_VOICE,
  greeting: process.env.OPENAI_GREETING,
  largeOrderThreshold: optionalInt('LARGE_ORDER_THRESHOLD'),
  turnDetection: process.env.OPENAI_TURN_DETECTION,
  vadEagerness: process.env.OPENAI_VAD_EAGERNESS,
  heartbeatSecret: process.env.HEARTBEAT_SECRET
});

const shutdown = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ port, host: '0.0.0.0' });
await store.addLogEvent(DEMO_RESTAURANT_ID, safeLogEvent({ source: 'BACKEND', level: 'INFO', message: 'Backend ready' }));
await store.addLogEvent(DEMO_RESTAURANT_ID, safeLogEvent({ source: 'DB', level: 'INFO', message: 'PostgreSQL connected' }));

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalInt(name: string) {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}
