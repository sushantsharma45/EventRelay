import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const email = 'phase3-' + crypto.randomUUID() + '@example.test';
const otherEmail = 'phase3-' + crypto.randomUUID() + '@example.test';
let server: Server;
let origin: string;
let token = '';
let organizationId = '';
let projectId = '';
let environmentId = '';

async function call(path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = 'Bearer ' + options.token;
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
  await pool.query(
    `DELETE FROM organizations o USING memberships m, users u
     WHERE m.organization_id = o.id AND m.user_id = u.id AND u.email = ANY($1::text[])`,
    [[email, otherEmail]],
  );
  await pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [[email, otherEmail]]);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test('projects, environments, API keys, endpoints, and subscriptions are tenant-scoped', async () => {
  const registered = await call('/v1/auth/register', {
    method: 'POST',
    body: { name: 'Phase Three', email, password: 'Local-test-password-123' },
  });
  assert.equal(registered.response.status, 201);
  token = registered.data.token;
  organizationId = registered.data.organization.id;

  const project = await call('/v1/organizations/' + organizationId + '/projects', {
    method: 'POST', token, body: { name: 'Payments' },
  });
  assert.equal(project.response.status, 201);
  projectId = project.data.project.id;

  const environment = await call('/v1/organizations/' + organizationId + '/projects/' + projectId + '/environments', {
    method: 'POST', token, body: { name: 'Production' },
  });
  assert.equal(environment.response.status, 201);
  environmentId = environment.data.environment.id;

  const base = '/v1/organizations/' + organizationId + '/projects/' + projectId + '/environments/' + environmentId;
  const key = await call(base + '/api-keys', { method: 'POST', token, body: { label: 'Backend service' } });
  assert.equal(key.response.status, 201);
  assert.match(key.data.apiKey.secret, /^er_live_/);

  const listedKeys = await call(base + '/api-keys', { token });
  assert.equal(listedKeys.data.data.length, 1);
  assert.equal('secret' in listedKeys.data.data[0], false);

  const endpoint = await call(base + '/endpoints', {
    method: 'POST', token,
    body: { url: 'https://hooks.example.test/events', eventTypes: ['payment.created', 'payment.failed'] },
  });
  assert.equal(endpoint.response.status, 201);
  assert.match(endpoint.data.endpoint.signingSecret, /^whsec_/);

  const updatedSubscriptions = await call(base + '/endpoints/' + endpoint.data.endpoint.id + '/subscriptions', {
    method: 'PUT', token, body: { eventTypes: ['payment.settled'] },
  });
  assert.deepEqual(updatedSubscriptions.data.eventTypes, ['payment.settled']);

  const other = await call('/v1/auth/register', {
    method: 'POST', body: { name: 'Other Org', email: otherEmail, password: 'Local-test-password-123' },
  });
  const denied = await call('/v1/organizations/' + organizationId + '/projects', { token: other.data.token });
  assert.equal(denied.response.status, 404);

  const revoked = await call(base + '/api-keys/' + key.data.apiKey.id, { method: 'DELETE', token });
  assert.equal(revoked.response.status, 204);
});