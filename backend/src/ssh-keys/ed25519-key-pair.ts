import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** An ed25519 pair as OpenSSH writes it: an `authorized_keys` line and a private key block. */
export type Ed25519KeyPair = { publicKey: string; privateKey: string };

/**
 * A new ed25519 pair, the one way Cloudgate makes one: an SSH key's
 * "Generate" path and a Stack VM key both come through here.
 *
 * Not ssh2's `utils.generateKeyPairSync('ed25519')`: ssh2 1.17 strips every
 * leading zero byte off the 32-byte public key as if it were a bignum, so
 * about one pair in 256 came out with a 31-byte key in both halves, a public
 * line `parseKey` refuses ("Malformed OpenSSH public key") and a private key
 * it refuses too. `node:crypto` makes the key; {@link ed25519KeyPairOf} frames
 * it. The pair has no passphrase: nothing stores one (`keyPairIssues`).
 */
export function generateEd25519KeyPair(comment = ''): Ed25519KeyPair {
  return ed25519KeyPairOf(generateKeyPairSync('ed25519').privateKey, comment);
}

/**
 * An ed25519 private key in OpenSSH's framing: the public line
 * (RFC 8709: `string "ssh-ed25519"`, `string` the 32-byte key) and the
 * unencrypted `openssh-key-v1` block (OpenSSH's PROTOCOL.key), with the
 * comment in both. Every key field keeps its fixed width, leading zeros and
 * all.
 */
export function ed25519KeyPairOf(
  privateKey: KeyObject,
  comment = '',
): Ed25519KeyPair {
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d as string, 'base64url');
  const raw = Buffer.from(
    createPublicKey(privateKey).export({ format: 'jwk' }).x as string,
    'base64url',
  );
  if (seed.length !== 32 || raw.length !== 32) {
    throw new Error('Not an ed25519 private key');
  }

  const name = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([sshString(name), sshString(raw)]);
  const commentBin = Buffer.from(comment);

  const checkInt = randomBytes(4);
  const unpadded = Buffer.concat([
    checkInt,
    checkInt,
    sshString(name),
    sshString(raw),
    sshString(Buffer.concat([seed, raw])),
    sshString(commentBin),
  ]);
  // Padded with 1, 2, 3, … to the cipher block size, 8 for "none".
  const padding = Buffer.from(
    Array.from({ length: (8 - (unpadded.length % 8)) % 8 }, (_, i) => i + 1),
  );
  const nkeys = Buffer.alloc(4);
  nkeys.writeUInt32BE(1);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    nkeys,
    sshString(blob),
    sshString(Buffer.concat([unpadded, padding])),
  ]);

  const lines = body.toString('base64').match(/.{1,70}/g) ?? [];
  return {
    publicKey: `ssh-ed25519 ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`,
    privateKey: [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      ...lines,
      '-----END OPENSSH PRIVATE KEY-----',
      '',
    ].join('\n'),
  };
}

/** SSH's `string`: a uint32 length, then the bytes (RFC 4251 §5). */
function sshString(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
