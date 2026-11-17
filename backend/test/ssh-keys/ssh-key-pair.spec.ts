import { generateKeyPairSync } from 'node:crypto';
import { utils as sshUtils } from 'ssh2';
import { createSshKeySchema } from '../../src/ssh-keys/dto/ssh-key.dto';
import { generateEd25519KeyPair } from '../../src/ssh-keys/ed25519-key-pair';

/**
 * "Paste one I have" stored anything as a key. `hello this is not a key`
 * over `garbage-private-half`, and a real public half over a private half that
 * reads `not really`, both came back "Key … added." — and the second surfaced a
 * screen later as `Cannot parse privateKey: Malformed OpenSSH private key` on a
 * Server's reachability check, with advice about addresses and
 * `authorized_keys`. These drive the create body's schema, which is what the
 * global pipe refuses a `POST /ssh-keys` with, and read back the field each
 * refusal names.
 */

// Through the helper production uses: ssh2's own ed25519 generator writes a
// pair its parser refuses about one time in 256, which reddened this file.
const toHalves = ({ publicKey, privateKey }: Record<string, string>) => ({
  public: publicKey,
  private: privateKey,
});
const ed25519 = toHalves(generateEd25519KeyPair('a'));
const otherEd25519 = toHalves(generateEd25519KeyPair('b'));
const rsa = sshUtils.generateKeyPairSync('rsa', { bits: 2048, comment: 'c' });

/** Issues as `path: message`, so a failure shows which field was blamed. */
const issuesOf = (body: Record<string, unknown>) => {
  const parsed = createSshKeySchema.safeParse({ name: 'k', ...body });
  return parsed.success
    ? []
    : parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
};

const pathsOf = (body: Record<string, unknown>) =>
  issuesOf(body).map((i) => i.path);

describe('createSshKeySchema — a pasted keypair', () => {
  describe('is accepted', () => {
    it('for an ed25519 pair', () => {
      expect(
        issuesOf({ publicKey: ed25519.public, privateKey: ed25519.private }),
      ).toEqual([]);
    });

    it('for an RSA pair', () => {
      expect(
        issuesOf({ publicKey: rsa.public, privateKey: rsa.private }),
      ).toEqual([]);
    });

    it('for an RSA private half in PEM, the format ssh-keygen wrote before 7.8', () => {
      const pem = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      });
      const parsed = sshUtils.parseKey(pem.privateKey);
      if (parsed instanceof Error) throw parsed;
      const publicLine = `ssh-rsa ${parsed.getPublicSSH().toString('base64')} pem`;

      expect(
        issuesOf({ publicKey: publicLine, privateKey: pem.privateKey }),
      ).toEqual([]);
    });

    it('with the whitespace a paste carries around each half', () => {
      expect(
        issuesOf({
          publicKey: `  ${ed25519.public}\n`,
          privateKey: `\n${ed25519.private}\n\n`,
        }),
      ).toEqual([]);
    });

    it('and generating one still needs neither half', () => {
      expect(issuesOf({ type: 'ed25519' })).toEqual([]);
    });
  });

  describe('is refused on the field that is wrong', () => {
    it('when the public half is not a key', () => {
      expect(
        issuesOf({
          publicKey: 'hello this is not a key',
          privateKey: ed25519.private,
        }),
      ).toEqual([
        {
          path: 'publicKey',
          message:
            'This is not an SSH public key. Paste the one line that starts ssh-ed25519 or ssh-rsa',
        },
      ]);
    });

    it('when the public half is well-formed text over a blob that is not a key', () => {
      expect(
        pathsOf({
          publicKey:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyForTests test',
          privateKey: ed25519.private,
        }),
      ).toEqual(['publicKey']);
    });

    it('when the public half spans more than one line', () => {
      expect(
        pathsOf({
          publicKey: `${ed25519.public}\n${otherEd25519.public}`,
          privateKey: ed25519.private,
        }),
      ).toEqual(['publicKey']);
    });

    it('when the private half was pasted into the public field', () => {
      expect(
        issuesOf({ publicKey: ed25519.private, privateKey: ed25519.private }),
      ).toEqual([
        {
          path: 'publicKey',
          message:
            'This is a private key. The public key is the one line that starts ssh-ed25519 or ssh-rsa',
        },
      ]);
    });

    it('when the private half is not a key', () => {
      expect(
        issuesOf({
          publicKey: ed25519.public,
          privateKey: 'garbage-private-half',
        }),
      ).toEqual([
        {
          path: 'privateKey',
          message:
            'This is not a private key Cloudgate can read (Unsupported key format)',
        },
      ]);
    });

    it('when the private half has the OpenSSH armour around nothing', () => {
      expect(
        issuesOf({
          publicKey: ed25519.public,
          privateKey:
            '-----BEGIN OPENSSH PRIVATE KEY-----\nnot really\n-----END OPENSSH PRIVATE KEY-----',
        }),
      ).toEqual([
        {
          path: 'privateKey',
          message:
            'This is not a private key Cloudgate can read (Malformed OpenSSH private key)',
        },
      ]);
    });

    it('when the private half is the public one', () => {
      expect(
        issuesOf({ publicKey: ed25519.public, privateKey: ed25519.public }),
      ).toEqual([
        {
          path: 'privateKey',
          message:
            'This is a public key. The private key is the block that starts -----BEGIN',
        },
      ]);
    });

    it('when the private half is protected by a passphrase', () => {
      // `ssh-keygen -t ed25519 -N hunter2`, written once: Cloudgate never makes
      // a protected key, and ssh2's generator is not sound for ed25519.
      const locked = {
        public:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPS+XayhvhVByv8NDnEAz4G8OUkBdDGQx5fo99M4G6G9 locked',
        private: [
          '-----BEGIN OPENSSH PRIVATE KEY-----',
          'b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABAVz499Ub',
          'J1F7sANR2iGNBjAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIPS+XayhvhVByv8N',
          'DnEAz4G8OUkBdDGQx5fo99M4G6G9AAAAkD+MyOvB2N9JC7v7Yow4xQsD/P4YoeTE388qbQ',
          'eU2N+WqkcjzN8GOSocWzzlePLITFKBYEmyJOJms0SZzrLGksLynBdSB0db2QuBrZW4/gG4',
          'UoC2QtLDhmmjaPaKY5LTKhElboAH2C8FbPzewiMXJz+aSA0kVMTxdS7B2rkcQjMmqVAR+Q',
          'Jgj2grK6PNLOyVUw==',
          '-----END OPENSSH PRIVATE KEY-----',
          '',
        ].join('\n'),
      };

      expect(
        issuesOf({ publicKey: locked.public, privateKey: locked.private }),
      ).toEqual([
        {
          path: 'privateKey',
          message:
            'This private key is protected by a passphrase, which Cloudgate cannot enter when it dials a Server. Remove it (ssh-keygen -p -N "" -f <file>) and paste the key again',
        },
      ]);
    });

    it('when both halves are keys but not of one pair', () => {
      expect(
        issuesOf({
          publicKey: otherEd25519.public,
          privateKey: ed25519.private,
        }),
      ).toEqual([
        {
          path: 'privateKey',
          message: 'This private key does not belong to that public key',
        },
      ]);
    });

    it('when both halves are keys of different types', () => {
      expect(
        pathsOf({ publicKey: rsa.public, privateKey: ed25519.private }),
      ).toEqual(['privateKey']);
    });

    it('with both fields blamed when neither half is a key', () => {
      expect(
        pathsOf({
          publicKey: 'hello this is not a key',
          privateKey: 'garbage-private-half',
        }),
      ).toEqual(['publicKey', 'privateKey']);
    });
  });

  // `SshKeysService.create` reads `publicKey && privateKey`, so a body with one
  // half used to generate a fresh pair and discard the paste without a word.
  describe('is refused when only one half is sent', () => {
    it('naming the missing public half', () => {
      expect(issuesOf({ privateKey: ed25519.private })).toEqual([
        {
          path: 'publicKey',
          message:
            'A pasted key needs both halves. Send neither to have Cloudgate generate a pair',
        },
      ]);
    });

    it('naming the missing private half', () => {
      expect(pathsOf({ publicKey: ed25519.public })).toEqual(['privateKey']);
    });
  });
});
