import { validateEnv } from '../../src/common/config/env.schema';
import {
  applyTrustProxy,
  expressTrustProxy,
  trustedProxyRanges,
} from '../../src/common/config/trust-proxy';

/**
 * `TRUST_PROXY`, the one key that decides whether a recorded address can be
 * chosen by the caller.
 *
 * Two readers of one value: Express, which decides what `req.ip` means, and
 * better-auth, which decides whether a forwarded chain is believed. They are
 * split across `main.ts` and `AuthModule` and can only be wrong together, which
 * is why the derivation is one file and this spec asks it directly.
 *
 * The value it protects is an audit value — `session.ip_address` and the `ip` on
 * the login entry — so the default mattering more than the feature is the point
 * of most of what follows.
 */

const validEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/cloudgate',
  APP_ENCRYPTION_SECRET: 'a-long-enough-secret-value-123456',
  BETTER_AUTH_SECRET: 'another-long-enough-secret-value-42',
};

describe('expressTrustProxy', () => {
  /**
   * The safe default, stated rather than inferred: with nothing trusted `req.ip`
   * is the socket peer, so no header a caller sends can become the address their
   * session records.
   */
  it('trusts nothing when the key is unset', () => {
    expect(expressTrustProxy(undefined)).toBe(false);
  });

  it('trusts nothing when the key is present but blank', () => {
    expect(expressTrustProxy('')).toBe(false);
    expect(expressTrustProxy('   ')).toBe(false);
  });

  /**
   * Express branches on `typeof val === 'number'` and hands anything else to
   * `proxy-addr.compile`, which reads `'2'` as an address list and refuses it —
   * so a hop count that stayed a string would abort the boot it was meant to
   * configure.
   */
  it('hands a hop count over as a number, not a string', () => {
    expect(expressTrustProxy('2')).toBe(2);
  });

  it('passes an alias through as Express writes it', () => {
    expect(expressTrustProxy('loopback')).toBe('loopback');
  });

  it('normalises a list to the comma-space form proxy-addr parses', () => {
    expect(expressTrustProxy(' 10.0.0.0/8 , 192.168.1.5 ')).toBe(
      '10.0.0.0/8, 192.168.1.5',
    );
  });

  /**
   * A list of counts is refused at boot (see the env block below), so this is
   * the belt to that braces: Express splits a string value itself
   * (`express/lib/utils.js:207-213`) and `ipaddr.js` reads a bare integer as
   * IPv4 long form, so `'1, 2'` used to compile to `0.0.0.1/32` and
   * `0.0.0.2/32` — matchers in `0.0.0.0/8`, which is "this network" and is
   * never a source address on the wire. The install trusted nothing, by
   * accident rather than by decision.
   */
  it('trusts nothing when every entry is a hop count', () => {
    expect(expressTrustProxy('1,2')).toBe(false);
    expect(expressTrustProxy('0,1')).toBe(false);
  });

  /**
   * The invariant this file's docblock claims and did not hold: one key, two
   * readers, the same entries. A count left in the string reached `proxy-addr`
   * as `0.0.0.1/32` while `trustedProxyRanges` dropped it, so Express and
   * better-auth were already deciding "which hops may name the caller" from
   * different lists — on a value the requirement string calls valid.
   *
   * Pinned against `trustedProxyRanges` rather than against a literal on
   * purpose: a literal would go on passing if both readers drifted together.
   */
  it('hands Express the same entries better-auth is given, dropping the count', () => {
    expect(expressTrustProxy('1,10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(expressTrustProxy('1,10.0.0.0/8')).toBe(
      trustedProxyRanges('1,10.0.0.0/8').join(', '),
    );
  });
});

describe('trustedProxyRanges', () => {
  it('names no proxy when the key is unset or blank', () => {
    expect(trustedProxyRanges(undefined)).toEqual([]);
    expect(trustedProxyRanges('')).toEqual([]);
  });

  /**
   * The half that would otherwise be missed: better-auth's `trustedProxies`
   * takes literal addresses, so `loopback` — one of the two values a self-hosted
   * operator actually writes — has to be expanded into `proxy-addr`'s own ranges
   * or the forwarded chain stays discarded while `req.ip` looks fixed.
   */
  it('expands the aliases proxy-addr defines into their ranges', () => {
    expect(trustedProxyRanges('loopback')).toEqual(['127.0.0.1/8', '::1/128']);
    expect(trustedProxyRanges('uniquelocal')).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      'fc00::/7',
    ]);
  });

  it('keeps an address or range exactly as it was given', () => {
    expect(trustedProxyRanges('10.0.0.0/8,192.168.1.5')).toEqual([
      '10.0.0.0/8',
      '192.168.1.5',
    ]);
  });

  it('mixes an alias and a range in one list', () => {
    expect(trustedProxyRanges('loopback,172.18.0.0/16')).toEqual([
      '127.0.0.1/8',
      '::1/128',
      '172.18.0.0/16',
    ]);
  });

  /**
   * A hop count names a position in the chain and `trustedProxies` names
   * addresses, so there is nothing to translate. Dropped rather than guessed at:
   * a wrong range here is a believed hop, which is the failure this key exists
   * to prevent.
   */
  it('drops a hop count, which names a position rather than an address', () => {
    expect(trustedProxyRanges('1')).toEqual([]);
  });
});

/**
 * The list read as the gate `AuthController.toWebRequest` branches on:
 * empty means no address is named, so the hop a request arrived from cannot be
 * checked against anything and a chain the caller sent gets replaced with the
 * socket peer.
 *
 * This block used to ask `trustsAnyProxy` — a separate predicate for "is
 * anything in front trusted", which answered *yes* to a hop count and so left
 * a `TRUST_PROXY=1` install preserving and believing the caller's own header.
 * The predicate is gone rather than corrected: the address list is the answer,
 * and two overlapping answers to one question drift.
 */
describe('trustedProxyRanges as the gate on an incoming chain', () => {
  /**
   * Had no test at all until a review, which is how the `'0'` case below
   * survived.
   */
  it('names nothing when the key is unset', () => {
    expect(trustedProxyRanges(undefined)).toEqual([]);
    expect(trustedProxyRanges('')).toEqual([]);
  });

  it.each(['loopback', 'uniquelocal', '10.0.0.0/8'])(
    'names an address when the key says %s',
    (value) => {
      expect(trustedProxyRanges(value).length).toBeGreaterThan(0);
    },
  );

  /**
   * The case the trusted-proxy fix closed. A hop count is a value
   * `isTrustProxyValue` accepts and `expressTrustProxy` honours, so
   * `TRUST_PROXY=1` used to read as "a proxy is trusted" — while the address list
   * stayed empty, leaving better-auth to believe any single-entry
   * `x-forwarded-for`. No second ingress and no operator error were needed to reach it.
   */
  it.each(['1', '2'])(
    'names no address for the hop count %s, which cannot be checked against a peer',
    (value) => {
      expect(trustedProxyRanges(value)).toEqual([]);
    },
  );

  /**
   * `TRUST_PROXY=0` is a hop count meaning *trust nothing*, and
   * `isTrustProxyValue` accepts it — so it is a value an operator writes to say
   * "nothing is in front of me" out loud.
   *
   * The gate used to be `expressTrustProxy(v) !== false`, and a hop count
   * arrives as a **number**, so `0 !== false` was `true`: Express trusted zero
   * hops, `trustedProxyRanges` dropped the count, and `toWebRequest` took the
   * preserve branch — leaving better-auth to believe any single-entry
   * `x-forwarded-for` a caller sent. That is the spoofable `session.ip_address`
   * and the bypassable sign-in rate limiter, on the one setting whose whole
   * meaning is that neither should be possible.
   */
  it('trusts nothing when the hop count is zero', () => {
    expect(expressTrustProxy('0')).toBe(0);
    expect(trustedProxyRanges('0')).toEqual([]);
  });

  /**
   * A count alongside a range still has a peer set, so the chain is appended to
   * rather than replaced — the count is ignored for this purpose exactly as it
   * is ignored for better-auth's list.
   */
  it('names the range when a hop count is mixed with one', () => {
    expect(trustedProxyRanges('1,10.0.0.0/8')).toEqual(['10.0.0.0/8']);
  });
});

describe('env validation of TRUST_PROXY', () => {
  it('accepts an env that names no proxy at all', () => {
    expect(validateEnv(validEnv).TRUST_PROXY).toBeUndefined();
  });

  /**
   * `deploy/env/cloudgate-backend.example` ships `TRUST_PROXY=` the way it ships
   * `TRUSTED_ORIGINS=`, and systemd passes a bare key through as an empty string
   * rather than omitting it. Refusing that would abort boot on the shipped file.
   */
  it('accepts the blank value the deploy template ships', () => {
    expect(validateEnv({ ...validEnv, TRUST_PROXY: '' }).TRUST_PROXY).toBe('');
  });

  it.each(['loopback', 'uniquelocal', 'linklocal', '1', '10.0.0.0/8', '::1'])(
    'accepts %s',
    (value) => {
      expect(validateEnv({ ...validEnv, TRUST_PROXY: value })).toBeDefined();
    },
  );

  /**
   * Refused at boot rather than at somebody's first sign-in: a typo here is
   * silently *no* trust, and no trust looks exactly like a working install right
   * up until the audit column turns out to hold the load balancer's address on
   * every row.
   *
   * `1,2`, `0,0` and `0,1` are the same refusal reached by a value that reads
   * as deliberate: a *list* of counts has no meaning in either reader —
   * a count names a position and there is only one chain — so it named nothing
   * and trusted nothing while `TRUST_PROXY` looked set. `1` stays in the
   * accepting list two blocks up, and the pair is the decision: a single count
   * is meaningful and in use, a list of them is not.
   */
  it.each([
    'yes',
    'true',
    '10.0.0.0/8,nonsense',
    '10.0.0.256',
    '1,2',
    '0,0',
    '0,1',
  ])('refuses %s at boot, naming the key', (value) => {
    expect(() => validateEnv({ ...validEnv, TRUST_PROXY: value })).toThrow(
      /TRUST_PROXY/,
    );
  });
});

/**
 * The half of this key nothing used to check: that somebody actually hands the
 * parsed value to Express (H-28).
 *
 * `expressTrustProxy` above is a pure function and was fully tested as one, and
 * that is exactly why the gap lasted — the value it returned was correct in
 * `main.ts` and correct in `createTestApp`, and only one of the two ever called
 * `app.set` with it. Both now call this, so the question "is Express trusting
 * what the key says" has one answer for every process that boots Nest, and
 * `test/auth/session-address.e2e-spec.ts` asks it of a real request.
 */
describe('applyTrustProxy', () => {
  /** The `set` calls an app received, in order. */
  function spyApp(): { calls: Array<[string, string | number]> } & {
    set(setting: string, value: string | number): void;
  } {
    const calls: Array<[string, string | number]> = [];
    return {
      calls,
      set: (setting, value) => void calls.push([setting, value]),
    };
  }

  it('hands Express the addresses the key names', () => {
    const app = spyApp();
    const announced: string[] = [];

    expect(
      applyTrustProxy(app, 'loopback,10.0.0.0/8', (m) => announced.push(m)),
    ).toBe('loopback, 10.0.0.0/8');

    expect(app.calls).toEqual([['trust proxy', 'loopback, 10.0.0.0/8']]);
    expect(announced).toEqual(['Trusting proxies: loopback, 10.0.0.0/8']);
  });

  /**
   * A count is Express's third form and has to arrive as a `number`, which is
   * `expressTrustProxy`'s rule and is only observable through this function —
   * `proxy-addr.compile` refuses the string `'2'` as an address list.
   */
  it('hands Express a hop count as the number Express branches on', () => {
    const app = spyApp();

    expect(applyTrustProxy(app, '2')).toBe(2);
    expect(app.calls).toEqual([['trust proxy', 2]]);
  });

  /**
   * Nothing is set and nothing is said, which is the shipped case. The `set`
   * matters more than the line: `app.set('trust proxy', false)` is Express's own
   * default and so would be harmless, but the announcement would name a trust
   * that was not granted — an operator reading "Trusting proxies: false" at boot
   * has been told the opposite of nothing.
   */
  it.each([undefined, '', '  '])(
    'sets nothing and says nothing for %p',
    (value) => {
      const app = spyApp();
      const announced: string[] = [];

      applyTrustProxy(app, value, (m) => announced.push(m));

      expect(announced).toEqual([]);
      expect(app.calls).toEqual([]);
    },
  );

  /**
   * `TRUST_PROXY=0` is not the unset case and is not treated as one, which is
   * `main.ts`'s behaviour carried across verbatim rather than tidied on the way.
   *
   * `expressTrustProxy('0')` is the number `0`, not `false`, and the block above
   * records why that distinction is load-bearing: `0 !== false` is what made an
   * earlier gate read a zero hop count as "a proxy is trusted". Express is told
   * zero hops explicitly and the boot line says so — the operator wrote the key
   * on purpose, and seeing it echoed is how they learn it was read.
   */
  it('tells Express about a zero hop count, and says so', () => {
    const app = spyApp();
    const announced: string[] = [];

    expect(applyTrustProxy(app, '0', (m) => announced.push(m))).toBe(0);

    expect(app.calls).toEqual([['trust proxy', 0]]);
    expect(announced).toEqual(['Trusting proxies: 0']);
  });
});
