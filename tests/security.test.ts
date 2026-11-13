import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { after, test } from 'node:test';
import process from 'node:process';

process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
process.env.LOG_LEVEL = 'silent';

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');
const { sendWebhookRequest, validateDeliveryUrl } = await import('../src/utils/webhook-url.js');
const api = createApp().listen(0);
await once(api, 'listening');
const address = api.address();

if (!address || typeof address === 'string') {
  throw new Error('Expected API listener address');
}

const origin = 'http://127.0.0.1:' + address.port;
let userId = '';
let organizationId = '';
let email = '';

after(async () => {
  if (organizationId) await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test('registration writes audit history and the API applies its request limit', async () => {
  email = 'phase7-' + crypto.randomUUID() + '@example.test';
  const registration = await fetch(origin + '/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Phase Seven', email, password: 'Local-test-password-123' }),
  });
  assert.equal(registration.status, 201);

  const registered = await registration.json() as {
    token: string;
    user: { id: string };
    organization: { id: string };
  };

  userId = registered.user.id;
  organizationId = registered.organization.id;

  const projectResponse = await fetch(origin + '/v1/organizations/' + organizationId + '/projects', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + registered.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'Audited project' }),
  });
  assert.equal(projectResponse.status, 201);

  const history = await fetch(origin + '/v1/organizations/' + organizationId + '/audit', {
    headers: { authorization: 'Bearer ' + registered.token },
  });
  assert.equal(history.status, 200);

  const audit = await history.json() as { data: Array<{ action: string; actor_id: string | null; resource_type: string }> };
  assert.ok(audit.data.some((entry) => entry.action === 'account.registered' && entry.actor_id === userId));
  assert.ok(audit.data.some((entry) => entry.action === 'post:project' && entry.resource_type === 'project'));

  const statuses: number[] = [];
  for (let index = 0; index < 300; index += 1) {
    const response = await fetch(origin + '/v1/events');
    statuses.push(response.status);
  }

  assert.ok(statuses.includes(404));
  assert.ok(statuses.includes(429));
});

test('webhook requests connect through the validated address', async () => {
  let receiverHost = '';
  const receiver = (await import('node:http')).createServer((req, res) => {
    assert.equal(req.headers.host, receiverHost);
    res.writeHead(204).end();
  });

  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const receiverAddress = receiver.address();

  if (!receiverAddress || typeof receiverAddress === 'string') {
    throw new Error('Expected receiver address');
  }
  
  receiverHost = '127.0.0.1:' + receiverAddress.port;

  try {
    const target = await validateDeliveryUrl('http://127.0.0.1:' + receiverAddress.port + '/hook');
    assert.equal(target.address, '127.0.0.1');
    const response = await sendWebhookRequest(target, { 'content-type': 'application/json' }, '{}');
    assert.equal(response.statusCode, 204);
  } finally {
    await new Promise<void>((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve()));
  }
});
