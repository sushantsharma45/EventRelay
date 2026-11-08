import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { logger } from '../logger.js';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const client = await pool.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [73190421]);
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');

  const files = (await fs.readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();

  for (const file of files) {
    const version = file.slice(0, file.indexOf('_'));
    const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (existing.rowCount) continue;

    const sql = await fs.readFile(path.join(directory, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      logger.info({ version, file }, 'Database migration applied');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [73190421]);
  } finally {
    client.release();
    await pool.end();
  }
}
