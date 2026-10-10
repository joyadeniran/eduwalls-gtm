import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from './config.js';

const PREFIX = 'enc:v1:';

function key(): Buffer {
  return createHash('sha256').update(env.appSecret).digest();
}

export function secretsEncrypted(): boolean {
  return Boolean(env.appSecret);
}

/** AES-256-GCM. Without APP_SECRET the value is stored as given. */
export function encryptSecret(plain: string): string {
  if (!env.appSecret) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  if (!env.appSecret) throw new Error('A stored secret is encrypted but APP_SECRET is not set');
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Constant-time compare, so a password check cannot be timed. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** One-way hash for a dashboard password changed in the app. Never reversible. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 32);
  return `scrypt:v1:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [scheme, version, saltB64, hashB64] = stored.split(':');
  if (scheme !== 'scrypt' || version !== 'v1' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(plain, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * Derived from the active credential, so changing the password invalidates
 * every existing session cookie.
 */
export function sessionToken(credential: string): string {
  return createHash('sha256').update(`${credential}:${env.appSecret || 'autogtm'}`).digest('hex');
}
