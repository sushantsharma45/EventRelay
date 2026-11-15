import { createServer } from 'node:http';
import { logger } from '../logger.js';
import { registry } from './metrics.js';

export function createMetricsServer() {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health/live') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found.');
      return;
    }

    try {
      const metrics = await registry.metrics();
      response.writeHead(200, {
        'Content-Type': registry.contentType,
        'Cache-Control': 'no-store',
      });
      response.end(metrics);
    } catch (error) {
      logger.error({ err: error }, 'Metrics scrape failed');
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Metrics are unavailable.');
    }
  });
}
