import { encryptCredentials, decryptCredentials } from './cloudCredentialsCrypto';

describe('cloudCredentialsCrypto', () => {
  const originalKey = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = 'tTnxJZKfh9PzStmvGeZsmbmqYfuYxPbI+5LofngNc5Q=';
  });

  afterEach(() => {
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = originalKey;
  });

  it('round-trips a credentials payload', () => {
    const payload = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'super-secret-value' };
    const serialized = encryptCredentials(payload);

    expect(serialized).not.toContain('super-secret-value');
    expect(decryptCredentials(serialized)).toEqual(payload);
  });

  it('produces a different ciphertext each time (fresh IV)', () => {
    const payload = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'super-secret-value' };

    expect(encryptCredentials(payload)).not.toBe(encryptCredentials(payload));
  });

  it('throws if the ciphertext has been tampered with', () => {
    const serialized = encryptCredentials({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'value' });
    const [iv, authTag, ciphertext] = serialized.split('.');
    const tamperedByte = Buffer.from(ciphertext, 'base64');
    tamperedByte[0] ^= 0xff;
    const tampered = [iv, authTag, tamperedByte.toString('base64')].join('.');

    expect(() => decryptCredentials(tampered)).toThrow();
  });

  it('throws if the encryption key is missing', () => {
    delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;

    expect(() => encryptCredentials({ a: 1 })).toThrow('CLOUD_CREDENTIALS_ENCRYPTION_KEY is not set.');
  });
});
