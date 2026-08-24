import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  const raw = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('CLOUD_CREDENTIALS_ENCRYPTION_KEY is not set.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('CLOUD_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

// Serializes to "base64(iv).base64(authTag).base64(ciphertext)" so the whole
// thing fits in one text column. Never call this with anything that isn't
// meant to end up server-side only — the result decrypts back to the raw
// secret with just the env-var key.
export function encryptCredentials(payload: object): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptCredentials<T>(serialized: string): T {
  const parts = serialized.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted credentials payload.');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
