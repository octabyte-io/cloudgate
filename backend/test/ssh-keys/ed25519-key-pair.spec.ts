import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { utils as sshUtils } from 'ssh2';
import type { ParsedKey } from 'ssh2';

import {
  ed25519KeyPairOf,
  generateEd25519KeyPair,
} from '../../src/ssh-keys/ed25519-key-pair';
import { keyPairIssues } from '../../src/ssh-keys/ssh-key-pair';

/**
 * ssh2 1.17's `generateKeyPairSync('ed25519')` strips every leading zero byte
 * off the 32-byte public key, as if it were a bignum, so about one pair in 256
 * (a public key whose first byte is 0x00) came out with a 31-byte key in both
 * halves: a public line `parseKey` refuses ("Malformed OpenSSH public key") and
 * a private key it refuses too. A Server handed that line could never be
 * reached, and Cloudgate's own `keyPairIssues` refused the pair.
 *
 * The expectations here come from outside the helper: ssh2's parser, a
 * signature the private half makes and the public half verifies, and
 * `node:crypto`'s own reading of the same key.
 */

function keyOf(material: string): ParsedKey {
  const parsed = sshUtils.parseKey(material);
  if (parsed instanceof Error) throw parsed;
  return Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed;
}

/** The 32-byte public key `node:crypto` derives from a private key. */
function rawPublicKey(privateKey: ReturnType<typeof createPrivateKey>): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return Buffer.from(jwk.x as string, 'base64url');
}

/** An ed25519 private key from its 32-byte seed (RFC 8410 PKCS#8 framing). */
function privateKeyFromSeed(seedHex: string) {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(seedHex, 'hex'),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** `string "ssh-ed25519"` then `string <32 bytes>`, as RFC 8709 frames it. */
function expectedBlob(raw: Buffer): Buffer {
  const name = Buffer.from('ssh-ed25519');
  const blob = Buffer.alloc(4 + name.length + 4 + raw.length);
  blob.writeUInt32BE(name.length, 0);
  name.copy(blob, 4);
  blob.writeUInt32BE(raw.length, 4 + name.length);
  raw.copy(blob, 8 + name.length);
  return blob;
}

describe('generateEd25519KeyPair', () => {
  // 2000 pairs miss a 1-in-256 defect with probability (255/256)^2000 ≈ 0.04%.
  it('writes a pair both halves of which parse, every time', () => {
    const malformed: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const { publicKey, privateKey } = generateEd25519KeyPair('cloudgate');
      const pub = sshUtils.parseKey(publicKey);
      const priv = sshUtils.parseKey(privateKey);
      if (
        pub instanceof Error ||
        priv instanceof Error ||
        !keyOf(publicKey)
          .getPublicSSH()
          .equals(keyOf(privateKey).getPublicSSH())
      ) {
        malformed.push(publicKey);
      }
    }

    expect(malformed).toEqual([]);
  });

  it('ends the public line in the comment it is given', () => {
    const { publicKey } = generateEd25519KeyPair('cloudgate-stack-vm-x');

    expect(publicKey).toMatch(/^ssh-ed25519 \S+ cloudgate-stack-vm-x$/);
    expect(generateEd25519KeyPair().publicKey).toMatch(/^ssh-ed25519 \S+$/);
  });

  it('makes a private half that signs what its public half verifies', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const data = Buffer.from('a Server checking a signature');
    const signature = keyOf(privateKey).sign(data);

    expect(keyOf(publicKey).verify(data, signature)).toBe(true);
    expect(keyPairIssues(publicKey, privateKey)).toEqual([]);
  });
});

describe('ed25519KeyPairOf', () => {
  // This seed's public key starts 0x0000 — the shape ssh2 truncated.
  const seed =
    '0000000000000000000000000000000000000000000000000000000000000024';

  it('keeps the leading zero bytes of the public key in both halves', () => {
    const key = privateKeyFromSeed(seed);
    const raw = rawPublicKey(key);
    expect(raw.subarray(0, 2)).toEqual(Buffer.from([0, 0]));

    const { publicKey, privateKey } = ed25519KeyPairOf(key, 'zeroes');

    expect(publicKey).toBe(
      `ssh-ed25519 ${expectedBlob(raw).toString('base64')} zeroes`,
    );
    expect(keyOf(privateKey).getPublicSSH()).toEqual(expectedBlob(raw));
    expect(keyPairIssues(publicKey, privateKey)).toEqual([]);
  });

  it('writes the private half as the same key node:crypto holds', () => {
    const key = privateKeyFromSeed(seed);
    const { privateKey } = ed25519KeyPairOf(key);
    const data = Buffer.from('signed twice');

    expect(keyOf(privateKey).sign(data)).toEqual(sign(null, data, key));
  });
});
