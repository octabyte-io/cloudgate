import {
  encryptValue,
  decryptValue,
  isEncrypted,
} from '../../src/common/encryption/encryption';

const TEST_SECRET = 'test-encryption-secret';

// Produced by an independent reference implementation of the spec
// (HMAC-SHA256(secret, 'cloudgate:db-encryption:v1') key,
// enc:v1: + base64(iv(12) || authTag(16) || ciphertext)) — not by the
// code under test.
const KNOWN_CIPHERTEXT =
  'enc:v1:AAECAwQFBgcICQoLgHxdz2HSICD9qk4rS2NydtuByzwwCR/NiT/hf0WiqOVjtIzd';
const KNOWN_PLAINTEXT = 'my-database-password';

describe('encryption', () => {
  beforeAll(() => {
    process.env.APP_ENCRYPTION_SECRET = TEST_SECRET;
  });

  it('round-trips a value back to the original', () => {
    const plaintext = 'postgres://user:s3cret@host:5432/db';
    expect(decryptValue(encryptValue(plaintext))).toBe(plaintext);
  });

  it('produces ciphertext different from the plaintext', () => {
    const plaintext = 'a-secret-token';
    const ciphertext = encryptValue(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext).not.toContain(plaintext);
    expect(isEncrypted(ciphertext)).toBe(true);
  });

  it('decrypts a known-good ciphertext from the reference implementation', () => {
    expect(decryptValue(KNOWN_CIPHERTEXT)).toBe(KNOWN_PLAINTEXT);
  });

  it('throws a clear error when the ciphertext cannot be decrypted', () => {
    const tampered =
      'enc:v1:' + Buffer.from(Buffer.alloc(12 + 16 + 8, 7)).toString('base64');
    expect(() => decryptValue(tampered)).toThrow(/decrypt/i);
  });
});
