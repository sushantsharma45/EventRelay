import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { after, test } from 'node:test';
import type { Server } from 'node:http';
import process from 'node:process';

process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');
const { encryptSecret } = await import('../src/utils/resource-secrets.js');
const { processDelivery, processEvent } = await import('../src/worker/delivery-handler.js');
const email = 'phase5-' + crypto.randomUUID() + '@example.test';
let api: Server;
let receiver: Server;
let origin: string;
let receivedBody = '';
let receivedSignature = '';
let receivedTimestamp = '';
let receivedCount = 0;
const responseStatuses = new Map([['/retry', 503], ['/bad', 400]]);
let userId = '';

async function call(path: string, options: { method?: string; body?: unknown; token?: string; key?: string; idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = 'Bearer ' + options.token;
  if (options.key) headers.authorization = 'Bearer ' + options.key;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  const response = await fetch(origin + path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  return { response, data: response.status === 204 ? null : await response.json() };
}

receiver = (await import('node:http')).createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  receivedBody = Buffer.concat(chunks).toString('utf8');
  receivedSignature = req.headers['x-eventrelay-signature'] as string;
  receivedTimestamp = req.headers['x-eventrelay-timestamp'] as string;
  receivedCount += 1;
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  res.writeHead(responseStatuses.get(path) ?? 204).end();
});

receiver.listen(0, '127.0.0.1');
await once(receiver, 'listening');

const receiverAddress = receiver.address();
if (!receiverAddress || typeof receiverAddress === 'string') throw new Error('Expected webhook listener address');
api = createApp().listen(0);
await once(api, 'listening');
const apiAddress = api.address();
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Expected API listener address');
origin = 'http://127.0.0.1:' + apiAddress.port;

after(async () => {
  if (userId) {
    await pool.query(
      `DELETE FROM outbox_messages
       WHERE topic = 'delivery.replay'
         AND payload->>'eventId' IN (
           SELECT ev.id::text
           FROM events ev
           JOIN environments env ON env.id = ev.environment_id
           JOIN projects p ON p.id = env.project_id
           JOIN memberships m ON m.organization_id = p.organization_id
           WHERE m.user_id = $1
         )`,
      [userId],
    );
    await pool.query(
      'DELETE FROM organizations o USING memberships m WHERE m.organization_id = o.id AND m.user_id = $1',
      [userId],
    );
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
  }
  await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test('worker sends a signed webhook and records the successful attempt', async () => {
  const registration = await call('/v1/auth/register', {
    method: 'POST',
    body: { name: 'Phase Five', email, password: 'Local-test-password-123' },
  });

  assert.equal(registration.response.status, 201);
  userId = registration.data.user.id;
  const token = registration.data.token;
  const organizationId = registration.data.organization.id;

  const project = await call('/v1/organizations/' + organizationId + '/projects', {
    method: 'POST', token, body: { name: 'Delivery project' },
  });
  const projectId = project.data.project.id;

  const environment = await call('/v1/organizations/' + organizationId + '/projects/' + projectId + '/environments', {
    method: 'POST', token, body: { name: 'Local' },
  });
  const environmentId = environment.data.environment.id;

  const key = await call('/v1/organizations/' + organizationId + '/projects/' + projectId + '/environments/' + environmentId + '/api-keys', {
    method: 'POST', token, body: { label: 'Delivery key' },
  });

  const endpoint = await call('/v1/organizations/' + organizationId + '/projects/' + projectId + '/environments/' + environmentId + '/endpoints', {
    method: 'POST', token,
    body: {
      url: 'http://127.0.0.1:' + (receiverAddress as import('node:net').AddressInfo).port + '/webhook',
      eventTypes: ['order.created'],
    },
  });

  assert.equal(endpoint.response.status, 201);
  const signingSecret = endpoint.data.endpoint.signingSecret;
  const accepted = await call('/v1/events', {
    method: 'POST', key: key.data.apiKey.secret, idempotencyKey: crypto.randomUUID(),
    body: { eventType: 'order.created', payload: { orderId: 'ord_123' } },
  });
  assert.equal(accepted.response.status, 202);

  await processEvent(accepted.data.event.id);

  const signature = receivedSignature.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
  assert.ok(signature);
  assert.ok(Math.abs(Date.now() / 1000 - Number(receivedTimestamp)) < 30);
  const expected = crypto.createHmac('sha256', signingSecret)
    .update(receivedTimestamp + '.' + receivedBody)
    .digest('hex');
  assert.equal(signature[2], expected);
  assert.equal(JSON.parse(receivedBody).id, accepted.data.event.id);

  const saved = await pool.query<{ state: string; attempt_count: number; response_status: number }>(
    `SELECT d.state, d.attempt_count, a.response_status
     FROM deliveries d JOIN delivery_attempts a ON a.delivery_id = d.id
     WHERE d.event_id = $1`,
    [accepted.data.event.id],
  );

  assert.equal(saved.rows[0]?.state, 'succeeded');
  assert.equal(saved.rows[0]?.attempt_count, 1);
  assert.equal(saved.rows[0]?.response_status, 204);

  await processEvent(accepted.data.event.id);
  assert.equal(receivedCount, 1);

  const base = '/v1/organizations/' + organizationId + '/projects/' + projectId + '/environments/' + environmentId;
  const retryEndpoint = await call(base + '/endpoints', {
    method: 'POST', token,
    body: { url: 'http://127.0.0.1:' + (receiverAddress as import('node:net').AddressInfo).port + '/retry', eventTypes: ['retry.test'] },
  });
  const retryEvent = await call('/v1/events', {
    method: 'POST', key: key.data.apiKey.secret, idempotencyKey: crypto.randomUUID(),
    body: { eventType: 'retry.test', payload: { retry: true } },
  });
  await processEvent(retryEvent.data.event.id);
  const retryDelivery = await pool.query<{ id: string; state: string; attempt_count: number }>(
    'SELECT id, state, attempt_count FROM deliveries WHERE event_id = $1',
    [retryEvent.data.event.id],
  );
  assert.equal(retryDelivery.rows[0]?.state, 'retrying');
  assert.equal(retryDelivery.rows[0]?.attempt_count, 1);

  await pool.query('UPDATE deliveries SET next_attempt_at = now() WHERE id = $1', [retryDelivery.rows[0]?.id]);
  responseStatuses.delete('/retry');
  await processDelivery(retryDelivery.rows[0]!.id);
  const successfulRetry = await pool.query<{ state: string; attempt_count: number }>(
    'SELECT state, attempt_count FROM deliveries WHERE id = $1',
    [retryDelivery.rows[0]!.id],
  );
  assert.equal(successfulRetry.rows[0]?.state, 'succeeded');
  assert.equal(successfulRetry.rows[0]?.attempt_count, 2);

  const attempts = await call('/v1/organizations/' + organizationId + '/deliveries/' + retryDelivery.rows[0]!.id + '/attempts', { token });
  assert.equal(attempts.response.status, 200);
  assert.equal(attempts.data.data.length, 2);

  const badEndpoint = await call(base + '/endpoints', {
    method: 'POST', token,
    body: { url: 'http://127.0.0.1:' + (receiverAddress as import('node:net').AddressInfo).port + '/bad', eventTypes: ['bad.test'] },
  });
  const badEvent = await call('/v1/events', {
    method: 'POST', key: key.data.apiKey.secret, idempotencyKey: crypto.randomUUID(),
    body: { eventType: 'bad.test', payload: { retry: false } },
  });
  await processEvent(badEvent.data.event.id);
  const deadLetter = await pool.query<{ id: string; state: string; attempt_count: number }>(
    'SELECT id, state, attempt_count FROM deliveries WHERE event_id = $1',
    [badEvent.data.event.id],
  );
  assert.equal(deadLetter.rows[0]?.state, 'dead_lettered');
  assert.equal(deadLetter.rows[0]?.attempt_count, 1);

  const deadLetters = await call('/v1/organizations/' + organizationId + '/deliveries?state=dead_lettered', { token });
  assert.equal(deadLetters.response.status, 200);
  assert.equal(deadLetters.data.data.some((delivery: { id: string }) => delivery.id === deadLetter.rows[0]!.id), true);

  const replay = await call('/v1/organizations/' + organizationId + '/deliveries/' + deadLetter.rows[0]!.id + '/replay', {
    method: 'POST', token,
  });
  assert.equal(replay.response.status, 202);
  const duplicateReplay = await call('/v1/organizations/' + organizationId + '/deliveries/' + deadLetter.rows[0]!.id + '/replay', {
    method: 'POST', token,
  });
  assert.equal(duplicateReplay.response.status, 409);
  const replayOutbox = await pool.query<{ topic: string }>(
    'SELECT topic FROM outbox_messages WHERE payload->>\'deliveryId\' = $1',
    [replay.data.deliveryId],
  );
  assert.equal(replayOutbox.rows[0]?.topic, 'delivery.replay');
});
