import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * The HTTPS listener's default certificate: self-signed, **made by Cloudgate
 * and imported into ACM** (the AWS spec, "The Environment network"). A listener
 * needs a certificate before any Domain has its own, and no browser is meant
 * to trust this one — it answers only a request no Domain's rule takes.
 *
 * Made here rather than by OpenTofu's `hashicorp/tls` provider because each
 * checkout pins exactly one OpenTofu and one AWS provider (the AWS spec, "What
 * runs where"): a second provider would be a second download, mirror entry
 * and lock-file block for one throwaway certificate.
 *
 * The network's definition takes it as two variables, which a run passes
 * through the environment (`TF_VAR_…`) like every other secret, and ignores
 * later changes to them: a new one is made for every run, and only the first
 * is ever imported.
 */
export interface DefaultCertificate {
  readonly certificatePem: string;
  /** PKCS #1, the form ACM's import reads. */
  readonly privateKeyPem: string;
}

/** A name under `.invalid` (RFC 2606): no real host can ever match it. */
export const DEFAULT_CERTIFICATE_HOST = 'cloudgate.invalid';

/** About ten years: the certificate is never meant to be trusted, nor renewed. */
const VALID_YEARS = 10;

const OID = {
  commonName: '2.5.4.3',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extendedKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

export function makeDefaultCertificate(
  now: Date = new Date(),
): DefaultCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALID_YEARS);

  const algorithm = sequence(oid(OID.sha256WithRsa), NULL);
  const name = sequence(
    set(sequence(oid(OID.commonName), utf8(DEFAULT_CERTIFICATE_HOST))),
  );
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serialNumber()),
    algorithm,
    name,
    sequence(time(now), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence()),
        // digitalSignature and keyEncipherment: bits 0 and 2.
        extension(OID.keyUsage, true, bitString(Buffer.from([0b1010_0000]), 5)),
        extension(OID.extendedKeyUsage, false, sequence(oid(OID.serverAuth))),
        extension(
          OID.subjectAltName,
          false,
          sequence(tlv(0x82, Buffer.from(DEFAULT_CERTIFICATE_HOST, 'ascii'))),
        ),
      ),
    ),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, algorithm, bitString(signature, 0));

  return {
    certificatePem: pem('CERTIFICATE', certificate),
    privateKeyPem: privateKey
      .export({ type: 'pkcs1', format: 'pem' })
      .toString(),
  };
}

// A minimal DER writer: exactly the shapes one X.509 v3 certificate needs.

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length;
  let header: Buffer;
  if (length < 0x80) {
    header = Buffer.from([tag, length]);
  } else {
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
    header = Buffer.from([tag, 0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([header, content]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function explicit(tagNumber: number, content: Buffer): Buffer {
  return tlv(0xa0 | tagNumber, content);
}

const NULL = Buffer.from([0x05, 0x00]);

/** A non-negative INTEGER from big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  return tlv(
    0x02,
    trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed,
  );
}

function bitString(bytes: Buffer, unusedBits: number): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

function utf8(text: string): Buffer {
  return tlv(0x0c, Buffer.from(text, 'utf8'));
}

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) {
      groups.unshift(0x80 | (value & 0x7f));
    }
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    oid(id),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    tlv(0x04, value),
  );
}

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(date: Date): Buffer {
  const iso = date.toISOString(); // 2026-10-17T12:00:00.000Z
  const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(digits.slice(2), 'ascii'))
    : tlv(0x18, Buffer.from(digits, 'ascii'));
}

/** Positive and unpredictable, at most 20 bytes (RFC 5280 §4.1.2.2). */
function serialNumber(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  bytes[0] |= 0x01;
  return bytes;
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * The variables the network's definition reads its default certificate from,
 * made by `makeDefaultCertificate` and passed by the run as `TF_VAR_<name>`:
 * through the environment, never written into the definition's file.
 */
export const DEFAULT_CERTIFICATE_VARIABLES = {
  certificate: 'default_certificate_body',
  privateKey: 'default_certificate_private_key',
} as const;
