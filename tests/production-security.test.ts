import assert from 'node:assert/strict';
import { test } from 'node:test';
import process from 'node:process';

process.env.NODE_ENV = 'production';
process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';

const { validateDeliveryUrl } = await import('../src/utils/webhook-url.js');

test('production refuses private webhook addresses even when the development override is set', async () => {
  await assert.rejects(
    validateDeliveryUrl('http://127.0.0.1:8080/hook'),
    /non-public network address/,
  );
  await assert.rejects(
    validateDeliveryUrl('http://[::ffff:127.0.0.1]:8080/hook'),
    /non-public network address/,
  );
});

test('webhook URLs cannot include credentials or non-HTTP schemes', async () => {
  await assert.rejects(
    validateDeliveryUrl('https://user:password@example.com/hook'),
    /without embedded credentials/,
  );
  await assert.rejects(validateDeliveryUrl('file:///etc/passwd'));
});

test('a public IP literal passes outbound address validation without a DNS lookup', async () => {
  const target = await validateDeliveryUrl('https://8.8.8.8/hook');
  assert.equal(target.address, '8.8.8.8');
  assert.equal(target.family, 4);
});
