import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../config/env.js';

function isPublicAddress(address: string) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    const first = parts[0] ?? 0;
    const second = parts[1] ?? 0;
    if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
    if (first === 100 && second >= 64 && second <= 127) return false;
    if (first === 169 && second === 254) return false;
    if (first === 172 && second >= 16 && second <= 31) return false;
    if (first === 192 && second === 168) return false;
    return true;
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return isPublicAddress(normalized.slice(7));
  }
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff')
  );
}

export async function validateDeliveryUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Webhook URL must use HTTP or HTTPS without embedded credentials.');
  }

  if (env.NODE_ENV !== 'production' && env.ALLOW_PRIVATE_WEBHOOKS) {
    return url;
  }

  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Webhook URL resolves to a non-public network address.');
  }
  return url;
}