// Passwords hashed with scrypt; node:crypto is needed for scrypt, timing-safe comparison and SHA-256.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { HttpError } from './validate.js';

export function hashPassword(password, salt = randomBytes(16)) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(`${salt.toString('hex')}:${key.toString('hex')}`)));
  });
}

export async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const candidate = await hashPassword(password, Buffer.from(saltHex, 'hex'));
  return timingSafeEqual(Buffer.from(candidate.split(':')[1], 'hex'), Buffer.from(keyHex, 'hex'));
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

export function newPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new HttpError(400, 'Пароль має бути не коротшим за 8 символів');
  }
  return value;
}
