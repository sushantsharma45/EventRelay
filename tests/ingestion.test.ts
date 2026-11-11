import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const email = 'phase4-' + crypto.randomUUID() + '@example.test';
let server: Server;
let origin: string;
let apiSecret = '';
let environmentId = '';
let projectId = '';
let apiKeyId = '';
let userId = '';

async function call(path: string, options: { method?: string; body?: unknown; key?: string; token?: string; idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key) headers.authorization = 'Bearer ' + options.key;
  if (options.token) headers.authorization = 'Bearer ' + options.token;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  const response = await fetch(origin + path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  return { response, data: response.status === 204 ? null : await response.json() };
}

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test listener');
  origin = 'http://127.0.0.1:' + address.port;
});

after(async () => {
  if (userId) {
    await pool.query(
      'DELETE FROM organizations o USING memberships m WHERE m.organization_id = o.id AND m.user_id = $1',
      [userId],
    );
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test('event ingestion validates requests and atomically writes one event and outbox message', async () => {
  const registration = await call('/v1/auth/register', {
    method: 'POST',
    body: { name: 'Phase Four', email, password: 'Local-test-password-123' },
  });

  assert.equal(registration.response.status, 201);
  userId = registration.data.user.id;
  const token = registration.data.token;
  const organizationId = registration.data.organization.id;

  const project = await call('/v1/organizations/' + organizationId + '/projects', {
    method: 'POST', token, body: { name: 'Ingestion test' },
  });
  projectId = project.data.project.id;

  const environment = await call('/v1/organizations/' + organizationId + '/projects/' + projectId + '/environments', {
    method: 'POST', token, body: { name: 'Test' },
  });
  environmentId = environment.data.environment.id;

  const key = await call('/v1/organizations/' + organizationId + '/projects/' + projectId + '/environments/' + environmentId + '/api-keys', {
    method: 'POST', token, body: { label: 'Ingestion test key' },
  });

  apiSecret = key.data.apiKey.secret;
  apiKeyId = key.data.apiKey.id;

  const idempotencyKey = crypto.randomUUID();
  const body = { eventType: 'invoice.paid', payload: { amount: 1250, customer: { id: 'cus_1', name: 'A' } }, metadata: { source: 'test' } };
  const accepted = await call('/v1/events', { method: 'POST', key: apiSecret, idempotencyKey, body });
  assert.equal(accepted.response.status, 202);

  const duplicate = await call('/v1/events', {
    method: 'POST', key: apiSecret, idempotencyKey,
    body: { eventType: 'invoice.paid', payload: { customer: { name: 'A', id: 'cus_1' }, amount: 1250 }, metadata: { source: 'test' } },
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.event.id, accepted.data.event.id);

  const conflict = await call('/v1/events', {
    method: 'POST', key: apiSecret, idempotencyKey,
    body: { eventType: 'invoice.paid', payload: { amount: 999 }, metadata: { source: 'test' } },
  });
  assert.equal(conflict.response.status, 409);

  const missingKey = await call('/v1/events', { method: 'POST', key: apiSecret, body });
  assert.equal(missingKey.response.status, 400);

  const invalidEvent = await call('/v1/events', {
    method: 'POST', key: apiSecret, idempotencyKey: crypto.randomUUID(),
    body: { eventType: 'invalid event name', payload: [] },
  });
  assert.equal(invalidEvent.response.status, 400);

  const invalidApiKey = await call('/v1/events', { method: 'POST', key: 'er_live_invalid', idempotencyKey: crypto.randomUUID(), body });
  assert.equal(invalidApiKey.response.status, 401);

  const stored = await pool.query<{ events: string; outbox: string }>(
    `SELECT (SELECT count(*) FROM events WHERE environment_id = $1)::text AS events,
       (SELECT count(*) FROM outbox_messages WHERE event_id IN (SELECT id FROM events WHERE environment_id = $1))::text AS outbox`,
    [environmentId],
  );
  assert.equal(stored.rows[0]?.events, '1');
  assert.equal(stored.rows[0]?.outbox, '1');

  const revoked = await call('/v1/organizations/' + organizationId + '/projects/' + projectId + '/environments/' + environmentId + '/api-keys/' + apiKeyId, {
    method: 'DELETE', token,
  });
  assert.equal(revoked.response.status, 204);
  
  const revokedKeyAttempt = await call('/v1/events', { method: 'POST', key: apiSecret, idempotencyKey: crypto.randomUUID(), body });
  assert.equal(revokedKeyAttempt.response.status, 401);
});