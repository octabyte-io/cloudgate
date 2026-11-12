import type * as Crypto from 'node:crypto';

// `require`, not `import * as`: the namespace an import builds under
// `esModuleInterop` is a copy, and replacing `scrypt` on a copy would leave
// the module better-auth calls untouched.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('node:crypto') as typeof Crypto;

/**
 * Makes better-auth's password hash cheap inside the Docker lanes.
 *
 * better-auth hashes every password with `node:crypto`'s `scrypt` at
 * `N = 16384, r = 16` (`@better-auth/utils/password.node`), about 85 ms of a
 * libuv thread each. Every e2e sign-up hashes once and every sign-in hashes
 * again, so an auth-heavy suite spent a fifth to a third of its run there:
 * `rbac.e2e-spec.ts` made 120 calls (10.3 s) and `settings.e2e-spec.ts` 106
 * (9.4 s), measured 2026-11-12. That cost is the point in production and buys
 * a test nothing.
 *
 * So this file, listed in `jest-preset.js`'s `setupFiles`, replaces `scrypt`
 * in each test file's worker with one that lowers that exact cost to `N = 16`
 * and passes every other call through untouched. Hashing and verifying both go
 * through it, so a stored hash still verifies, the stored format
 * (`salt:key`, 64-byte key) is unchanged, and a wrong password still fails.
 * No fixture holds a precomputed hash, which is what would break.
 *
 * Only the call better-auth makes is matched (`N` of 16384 and `r` of 16), so a
 * test that drives `scrypt` itself at other parameters gets the real one. The
 * unit lane is not on the preset and keeps the real cost.
 */
const PRODUCTION_COST = { N: 16384, r: 16 };
const TEST_COST = { N: 16, maxmem: 32 * 1024 * 1024 };

type ScryptOptions = Crypto.ScryptOptions & { N?: number };

const marker = Symbol.for('cloudgate.test.cheapScrypt');
const real = crypto.scrypt as typeof Crypto.scrypt & { [marker]?: true };

if (!real[marker]) {
  const cheap = function (
    this: unknown,
    password: Crypto.BinaryLike,
    salt: Crypto.BinaryLike,
    keylen: number,
    options: ScryptOptions | ((...args: unknown[]) => void),
    callback?: (...args: unknown[]) => void,
  ) {
    if (
      typeof options === 'object' &&
      options !== null &&
      options.N === PRODUCTION_COST.N &&
      options.r === PRODUCTION_COST.r
    ) {
      options = { ...options, ...TEST_COST };
    }
    (real as (...args: unknown[]) => void).call(
      this,
      password,
      salt,
      keylen,
      options,
      callback,
    );
  } as typeof Crypto.scrypt & { [marker]?: true };
  cheap[marker] = true;
  (crypto as { scrypt: typeof Crypto.scrypt }).scrypt = cheap;
}
