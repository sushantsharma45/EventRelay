import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';

let server: Server, origin: string;

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP test listener');
  }
  origin = 'http://127.0.0.1:' + address.port;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('health route reports API status', async () => {
  const response = await fetch(origin + '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'eventrelay-api' });
});

test('unknown paths return a safe JSON error', async () => {
  const response = await fetch(origin + '/missing');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: { code: 'NOT_FOUND', message: 'Route not found.' },
  });
});
