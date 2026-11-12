import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';

const ctx = {
  session: { activeOrganizationId: 'org-1' },
} as unknown as PermissionCtx;

/**
 * `create` reads no rows, so the whole database it needs is one
 * `.values().returning()` that echoes back what it was handed. Echoing rather
 * than returning a fixture is the point: the `publicKey` these tests read is
 * the one that would have been **stored**, not a separately shaped response.
 *
 * Driven from here rather than from `ssh-keys.e2e-spec.ts` because what is
 * under test is the bytes of a generated key, which Postgres has no part in,
 * and because two of the names below (a leading newline, whitespace only) are
 * ones the e2e's HTTP layer would have to be talked into sending.
 */
const makeService = () => {
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: () => Promise.resolve([row]),
      }),
    }),
  } as unknown as DrizzleDB;
  return new SshKeysService(db);
};

/**
 * Everything after the algorithm and the blob — `slice(2)`, not `[2]`, so a
 * comment that wrongly kept a space in it is visible in the failure rather than
 * silently truncated to its first word.
 */
const commentOf = (publicKey: string) =>
  publicKey.split(' ').slice(2).join(' ');

const generate = async (name: string, type?: 'rsa' | 'ed25519') => {
  const created = await makeService().create(ctx, { name, type });
  return created.publicKey;
};

describe('SshKeysService', () => {
  describe('the comment on a generated key', () => {
    it('names the key after the cloudgate marker on an ed25519 keypair', async () => {
      const publicKey = await generate('ui-ed25519', 'ed25519');

      expect(publicKey.startsWith('ssh-ed25519 ')).toBe(true);
      expect(commentOf(publicKey)).toBe('cloudgate:ui-ed25519');
    });

    it('names the key after the cloudgate marker on an RSA keypair', async () => {
      const publicKey = await generate('ui-rsa', 'rsa');

      expect(publicKey.startsWith('ssh-rsa ')).toBe(true);
      expect(commentOf(publicKey)).toBe('cloudgate:ui-rsa');
    });

    it('tells two keys of the same type apart, which the bare marker did not', async () => {
      const first = await generate('deploy-eu', 'ed25519');
      const second = await generate('deploy-us', 'ed25519');

      expect(commentOf(first)).toBe('cloudgate:deploy-eu');
      expect(commentOf(second)).toBe('cloudgate:deploy-us');
    });

    it('keeps the cloudgate marker, so a host can still be grepped for Cloudgate lines', async () => {
      const publicKey = await generate('anything', 'ed25519');

      expect(publicKey.includes('cloudgate')).toBe(true);
    });
  });

  describe('a key name that an authorized_keys line cannot carry', () => {
    it('collapses a newline, so the line cannot forge a second authorized_keys entry', async () => {
      const publicKey = await generate(
        'evil\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeAttackerKey attacker',
        'ed25519',
      );

      // The load-bearing assertion is the line count, not the spelling: the
      // comment is the remainder of the line, so one key must produce exactly
      // one line whatever else the sanitiser does to the name.
      expect(publicKey.split('\n')).toHaveLength(1);
      expect(commentOf(publicKey)).toBe(
        'cloudgate:evil_ssh-ed25519_AAAAC3NzaC1lZDI1NTE5AAAAIFakeAttackerKey_attacker',
      );
    });

    it('collapses a carriage return the same way as a newline', async () => {
      const publicKey = await generate('evil\r\nattacker', 'ed25519');

      expect(publicKey.split(/\r|\n/)).toHaveLength(1);
      expect(commentOf(publicKey)).toBe('cloudgate:evil_attacker');
    });

    it('collapses each run of interior whitespace to one underscore', async () => {
      const publicKey = await generate('  staging   web host\t2  ', 'ed25519');

      // Trimmed at the ends and one `_` per run, so the comment is one word and
      // `staging web` does not become the same comment as `stagingweb`.
      expect(commentOf(publicKey)).toBe('cloudgate:staging_web_host_2');
    });

    it('falls back to the bare marker for a name with nothing a comment can carry', async () => {
      const publicKey = await generate('   ', 'ed25519');

      expect(commentOf(publicKey)).toBe('cloudgate');
    });
  });

  describe('a pasted keypair', () => {
    it("keeps the operator's own comment rather than being re-commented", async () => {
      const publicKey =
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyForTests azeem@laptop';

      const created = await makeService().create(ctx, {
        name: 'pasted',
        publicKey,
        privateKey: 'fake-private-key',
      });

      expect(created.publicKey).toBe(publicKey);
      // Nothing was generated on the way through, so nothing was commented.
      expect(created.publicKey.includes('cloudgate')).toBe(false);
    });
  });
});
