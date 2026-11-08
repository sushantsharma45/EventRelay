import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  application_name: 'eventrelay-api',
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Unexpected idle PostgreSQL client error');
});
