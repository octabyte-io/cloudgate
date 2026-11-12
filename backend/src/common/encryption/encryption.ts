import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

const ENCRYPTION_PREFIX = 'enc:v1:';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Cached per secret so tests can swap APP_ENCRYPTION_SECRET between runs.
let cachedKey: { secret: string; key: Buffer } | undefined;

const getKey = (): Buffer => {
  const secret = process.env.APP_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      'APP_ENCRYPTION_SECRET is not set; cannot encrypt or decrypt values.',
    );
  }
  if (cachedKey?.secret !== secret) {
    cachedKey = {
      secret,
      key: createHmac('sha256', secret)
        .update('cloudgate:db-encryption:v1')
        .digest(),
    };
  }
  return cachedKey.key;
};

export const isEncrypted = (value: string): boolean =>
  value.startsWith(ENCRYPTION_PREFIX);

export const encryptValue = (value: string): string => {
  if (!value || isEncrypted(value)) {
    return value;
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  return `${ENCRYPTION_PREFIX}${payload.toString('base64')}`;
};

export const decryptValue = (value: string): string => {
  if (!value || !isEncrypted(value)) {
    return value;
  }
  const payload = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), 'base64');
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      'Failed to decrypt a stored secret. This usually means APP_ENCRYPTION_SECRET changed after the value was encrypted.',
    );
  }
};
