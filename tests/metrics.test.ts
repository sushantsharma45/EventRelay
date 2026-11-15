import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createMetricsServer } from '../src/observability/metrics-server.js';

let appServer: Server;
let metricsServer: Server;
let appOrigin: string;
let metricsOrigin: string;

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test listener');
  return 'http://127.0.0.1:' + address.port;
}

before(async () => {
  appServer = createApp().listen(0, '127.0.0.1');
  metricsServer = createMetricsServer();
  [appOrigin, metricsOrigin] = await Promise.all([
    new Promise<string>((resolve, reject) => {
      appServer.once('error', reject);
      appServer.once('listening', () => {
        const address = appServer.address();
        if (!address || typeof address === 'string') return reject(new Error('Expected TCP test listener'));
        resolve('http://127.0.0.1:' + address.port);
      });
    }),
    listen(metricsServer),
  ]);
});

after(async () => {
  await Promise.all([appServer, metricsServer].map((server) =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  ));
  await pool.end();
});

test('metrics listener exposes request and worker metrics without publishing them on the API port', async () => {
  const health = await fetch(appOrigin + '/health');
  assert.equal(health.status, 200);

  const publicMetrics = await fetch(appOrigin + '/metrics');
  assert.equal(publicMetrics.status, 404);

  const metrics = await fetch(metricsOrigin + '/metrics');
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get('content-type') ?? '', /text\/plain/);
  const body = await metrics.text();
  assert.match(body, /eventrelay_http_requests_total/);
  assert.match(body, /eventrelay_http_request_duration_seconds/);
  assert.match(body, /eventrelay_worker_jobs_total/);
  assert.match(body, /route="\/health\/"/);
});

test('metrics listener has a lightweight liveness endpoint and rejects unknown paths', async () => {
  const health = await fetch(metricsOrigin + '/health/live');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const unknown = await fetch(metricsOrigin + '/private');
  assert.equal(unknown.status, 404);
});
