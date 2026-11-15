import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { createMetricsServer } from './observability/metrics-server.js';

try {
  await pool.query('SELECT 1');
} catch (error) {
  logger.fatal({ err: error }, 'PostgreSQL is unavailable; API startup aborted');
  process.exit(1);
}

const metricsServer = createMetricsServer();
metricsServer.listen(env.API_METRICS_PORT, env.METRICS_HOST, () =>
  logger.info({ host: env.METRICS_HOST, port: env.API_METRICS_PORT }, 'API metrics listener started'),
);

const server = createApp().listen(env.PORT, () =>
  logger.info({ port: env.PORT }, 'EventRelay API listening'),
);

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');
  metricsServer.close();
  server.close(async (error) => {
    if (error) {
      logger.error({ err: error }, 'HTTP server shutdown failed');
      process.exitCode = 1;
    }
    await pool.end();
  });
  setTimeout(() => {
    logger.error('Shutdown timed out');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
