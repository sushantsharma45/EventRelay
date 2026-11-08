import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const emails = [
  'phase2-' + crypto.randomUUID() + '@example.test',
  'phase2-' + crypto.randomUUID() + '@example.test',
];
let server: Server;
let origin: string;
let accounts: Array<{ token: string; user: { id: string }; organization: { id: string } }> = [];

async function call(path: string, options: { method?: string; body?: unknown; token?: string; organizationId?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = 'Bearer ' + options.token;
  if (options.organizationId) headers['x-organization-id'] = options.organizationId;
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
  for (const email of emails) {
    await pool.query(
      'DELETE FROM organizations o USING memberships m, users u WHERE m.organization_id = o.id AND m.user_id = u.id AND u.email = $1',
      [email],
    );
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test('registration creates an owner and login returns a usable access token', async () => {
  const first = await call('/v1/auth/register', {
    method: 'POST', body: { name: 'Phase Two', email: emails[0], password: 'Local-test-password-123' },
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.data.organization.role, 'owner');
  accounts.push(first.data);

  const login = await call('/v1/auth/login', {
    method: 'POST', body: { email: emails[0]!.toUpperCase(), password: 'Local-test-password-123' },
  });
  assert.equal(login.response.status, 200);

  const me = await call('/v1/auth/me', { token: login.data.token });
  assert.equal(me.response.status, 200);
  assert.equal(me.data.user.id, first.data.user.id);

  const createdOrganization = await call('/v1/organizations', {
    method: 'POST',
    token: login.data.token,
    body: { name: 'Second workspace' },
  });
  assert.equal(createdOrganization.response.status, 201);
  assert.equal(createdOrganization.data.organization.role, 'owner');

  const organizations = await call('/v1/organizations', { token: login.data.token });
  assert.equal(organizations.data.data.length, 2);
});

test('organization membership is tenant-scoped', async () => {
  const first = accounts[0];
  assert.ok(first);
  const second = await call('/v1/auth/register', {
    method: 'POST', body: { name: 'Other Tenant', email: emails[1], password: 'Local-test-password-123' },
  });
  assert.equal(second.response.status, 201);
  accounts.push(second.data);

  const denied = await call('/v1/organizations/' + first.organization.id + '/members', { token: second.data.token });
  assert.equal(denied.response.status, 404);

  const members = await call('/v1/organizations/' + first.organization.id + '/members', { token: first.token });
  assert.equal(members.response.status, 200);
  assert.equal(members.data.data[0].role, 'owner');

  const added = await call('/v1/organizations/' + first.organization.id + '/members', {
    method: 'POST',
    token: first.token,
    body: { email: emails[1], role: 'developer' },
  });
  assert.equal(added.response.status, 201);
  assert.equal(added.data.member.id, second.data.user.id);

  const promoted = await call('/v1/organizations/' + first.organization.id + '/members/' + second.data.user.id, {
    method: 'PATCH',
    token: first.token,
    body: { role: 'admin' },
  });
  assert.equal(promoted.response.status, 200);
  assert.equal(promoted.data.member.role, 'admin');

  const adminCannotGrantAdmin = await call('/v1/organizations/' + first.organization.id + '/members', {
    method: 'POST',
    token: second.data.token,
    body: { email: emails[0], role: 'admin' },
  });
  assert.equal(adminCannotGrantAdmin.response.status, 403);

  const changedRole = await call('/v1/organizations/' + first.organization.id + '/members/' + second.data.user.id, {
    method: 'PATCH',
    token: first.token,
    body: { role: 'viewer' },
  });
  assert.equal(changedRole.response.status, 200);
  assert.equal(changedRole.data.member.role, 'viewer');

  const viewerDenied = await call('/v1/organizations/' + first.organization.id + '/members/' + first.user.id, {
    method: 'PATCH',
    token: second.data.token,
    body: { role: 'developer' },
  });
  assert.equal(viewerDenied.response.status, 403);

  const duplicateMember = await call('/v1/organizations/' + first.organization.id + '/members', {
    method: 'POST',
    token: first.token,
    body: { email: emails[1], role: 'developer' },
  });
  assert.equal(duplicateMember.response.status, 409);
});

test('invalid passwords and duplicate registration are rejected', async () => {
  const invalid = await call('/v1/auth/register', {
    method: 'POST', body: { name: 'Bad', email: emails[0], password: 'short' },
  });
  assert.equal(invalid.response.status, 400);
  const duplicate = await call('/v1/auth/register', {
    method: 'POST', body: { name: 'Duplicate', email: emails[0], password: 'Local-test-password-123' },
  });
  assert.equal(duplicate.response.status, 409);
});
