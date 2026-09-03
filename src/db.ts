import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

export function createPool(connectionString: string) {
  return new Pool({ connectionString, max: 10, ssl: sslConfig(connectionString) });
}

function sslConfig(url: string) {
  const local = /localhost|127\.0\.0\.1/.test(url);
  return local ? undefined : { rejectUnauthorized: false };
}

export async function migrate(pool: pg.Pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const directory = join(process.cwd(), 'migrations');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    const claimed = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [name]);
    if (claimed.rowCount) continue;
    const sql = await readFile(join(directory, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
