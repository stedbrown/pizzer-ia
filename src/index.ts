import { buildApp } from './app.js';
import { createPool, migrate } from './db.js';
import { PostgresStore } from './postgres-store.js';

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = required('DATABASE_URL');
const adminPassword = required('ADMIN_PASSWORD');
const pool = createPool(databaseUrl);
await migrate(pool);
const app = buildApp({
  store: new PostgresStore(pool), adminPassword,
  webhookSecret: process.env.OPENAI_WEBHOOK_SECRET,
  apiKey: process.env.OPENAI_API_KEY,
  realtimeModel: process.env.OPENAI_REALTIME_MODEL,
  voice: process.env.OPENAI_VOICE,
  heartbeatSecret: process.env.HEARTBEAT_SECRET
});

const shutdown = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ port, host: '0.0.0.0' });

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
