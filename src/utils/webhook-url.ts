import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { env } from '../config/env.js';

export interface ValidatedDeliveryUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

function isPublicAddress(address: string) {
  if (net.isIPv4(address)) {
    const [first = 0, second = 0, third = 0] = address.split('.').map(Number);
    if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
    if (first === 100 && second >= 64 && second <= 127) return false;
    if (first === 169 && second === 254) return false;
    if (first === 172 && second >= 16 && second <= 31) return false;
    if (first === 192 && (second === 0 || second === 168)) return false;
    if (first === 192 && second === 88 && third === 99) return false;
    if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) return false;
    if (first === 203 && second === 0 && third === 113) return false;
    return true;
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return false;
  if (!net.isIPv6(normalized)) return false;
  const firstGroup = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return firstGroup >= 0x2000 && firstGroup <= 0x3fff && !normalized.startsWith('2001:db8:');
}

function normalizeHostname(hostname: string) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

export async function validateDeliveryUrl(value: string): Promise<ValidatedDeliveryUrl> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Webhook URL must use HTTP or HTTPS without embedded credentials.');
  }

  const hostname = normalizeHostname(url.hostname);
  const addresses: Array<{ address: string; family: number }> = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('Webhook hostname did not resolve to an IP address.');

  const privateAllowed = env.NODE_ENV !== 'production' && env.ALLOW_PRIVATE_WEBHOOKS;
  if (!privateAllowed && addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Webhook URL resolves to a non-public network address.');
  }

  const selected = addresses[0];
  if (!selected || ![4, 6].includes(selected.family)) {
    throw new Error('Webhook hostname resolved to an unsupported address.');
  }

  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export async function sendWebhookRequest(
  target: ValidatedDeliveryUrl,
  headers: Record<string, string>,
  body: string,
) {
  const transport = target.url.protocol === 'https:' ? https : http;
  return new Promise<{ statusCode: number; responseBody: string }>((resolve, reject) => {
    const request = transport.request(target.url, {
      method: 'POST',
      headers,
      lookup: (_hostname, _options, callback) => {
        callback(null, target.address, target.family);
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (responseBody.length < 16000) {
          responseBody += chunk.slice(0, 16000 - responseBody.length);
        }
      });
      response.on('end', () => {
        resolve({ statusCode: response.statusCode ?? 0, responseBody });
      });
      response.on('error', reject);
    });

    request.setTimeout(10000, () => request.destroy(new Error('Webhook request timed out.')));
    request.on('error', reject);
    request.end(body);
  });
}
