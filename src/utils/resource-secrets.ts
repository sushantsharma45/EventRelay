import crypto from 'node:crypto';
import { env } from '../config/env.js';

const encryptionKey = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
if (encryptionKey.length !== 32) {
  throw new Error('DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
}

export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export function generateApiKey() {
  const secret = 'er_live_' + crypto.randomBytes(32).toString('base64url');
  return {
    secret,
    prefix: secret.slice(0, 16),
    hash: crypto.createHash('sha256').update(secret).digest('hex'),
  };
}

export function decryptSecret(value: string) {
  const [encodedIv, encodedTag, encodedData] = value.split('.');
  if (!encodedIv || !encodedTag || !encodedData) {
    throw new Error('Stored signing secret has an invalid format.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(encodedIv, 'base64url'),
  );
  
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedData, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}