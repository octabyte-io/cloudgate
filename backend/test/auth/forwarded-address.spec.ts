import type { Request as ExpressRequest } from 'express';
import { toWebRequest } from '../../src/auth/auth.controller';
import { SOCKET_PEER_HEADER } from '../../src/auth/socket-peer';
import { trustedProxyRanges } from '../../src/common/config/trust-proxy';

/**
 * `toWebRequest` — the one function that decides what address a session records
 * and now the one that decides whether a forwarded chain is
 * believed at all.
 *
 * better-auth reads the client address out of `x-forwarded-for` and nothing
 * else; there is no socket behind the Web `Request` it is handed. So a caller
 * that sends no forwarded header stored an empty `session.ip_address` on every
 * session, and Settings → Account → Sessions rendered a dash in every row —
 * with three `curl/8.5.0` rows, the address is the only thing that tells them
 * apart.
 *
 * A unit spec rather than an e2e because the e2e cannot see all of it: `getIp`
 * falls back to `127.0.0.1` whenever `NODE_ENV` is `test` or `development`,
 * which is the same value a loopback socket peer produces, so the broken and the
 * fixed app agree there. **The peer rule is not expressible e2e at all**:
 * supertest always connects from loopback, so a request from outside a declared
 * range cannot be produced over a real socket. The rules that matter are only
 * visible here.
 */

/** The minimum of an Express request that `toWebRequest` reads. */
function expressRequest(
  overrides: {
    /** `req.socket.remoteAddress` — the address that cannot be forged. */
    peer?: string;
    /**
     * `req.ip`, which Express derives from the chain once `trust proxy` is set.
     * Defaults to the peer, which is what Express answers whenever the peer is
     * not a declared proxy — the case most of these describe.
     */
    ip?: string;
    headers?: Record<string, string | string[]>;
    method?: string;
    body?: unknown;
  } = {},
): ExpressRequest {
  return {
    protocol: 'http',
    originalUrl: '/api/auth/sign-in/email',
    method: overrides.method ?? 'POST',
    ip: overrides.ip ?? overrides.peer,
    socket: 'peer' in overrides ? { remoteAddress: overrides.peer } : undefined,
    headers: { host: 'console.cloudgate.test', ...(overrides.headers ?? {}) },
    body: overrides.body ?? { email: 'grace@example.com', password: 'hunter2' },
    get: (name: string) =>
      name === 'host' ? 'console.cloudgate.test' : undefined,
  } as unknown as ExpressRequest;
}

/**
 * `TRUST_PROXY` names the proxy's range — the deployment behind Traefik, nginx
 * or a load balancer. Spelled as the derivation rather than a literal so the
 * spec is pinned to the value the controller actually passes.
 */
const DECLARED_RANGE = trustedProxyRanges('10.0.0.0/8');
/** `TRUST_PROXY` is unset — the shipped single-host default. */
const NOTHING_DECLARED = trustedProxyRanges(undefined);

describe('toWebRequest', () => {
  it('forwards the caller address when the request carries no forwarded header', () => {
    const web = toWebRequest(
      expressRequest({ peer: '203.0.113.42' }),
      NOTHING_DECLARED,
    );

    expect(web.headers.get('x-forwarded-for')).toBe('203.0.113.42');
  });

  /**
   * Not dead code: there is no socket on a request that never had one, which is
   * how Nest's own testing harness and a few upgrade paths arrive. Setting the
   * header to the string `"undefined"` would be an address better-auth stores
   * and nobody can act on.
   */
  it('adds no forwarded header when the request has no socket', () => {
    const web = toWebRequest(expressRequest({}), NOTHING_DECLARED);

    expect(web.headers.has('x-forwarded-for')).toBe(false);
  });

  it('carries the parsed body and the method through unchanged', () => {
    const web = toWebRequest(
      expressRequest({ peer: '203.0.113.42', body: { email: 'grace@x.test' } }),
      NOTHING_DECLARED,
    );

    expect(web.method).toBe('POST');
    expect(web.url).toBe(
      'http://console.cloudgate.test/api/auth/sign-in/email',
    );
  });

  /**
   * **Both directions, deliberately in one place.** Each is only correct because
   * the other exists, and either one read alone looks like a rule with a
   * redundant condition — which is exactly how one of them gets "simplified"
   * away.
   *
   * The rule is: a forwarded chain is worth something only when configuration
   * names an address that the hop it arrived from can be checked against. There
   * is no case where the two branches conflict, because the address fix's acceptance
   * criterion is about a chain *a real proxy set*, and the replacing branch only
   * runs when configuration names no such proxy.
   */
  describe('an incoming forwarded chain, trusted and not', () => {
    /**
     * A proxy's chain names the client; the socket peer names whichever hop
     * reached Nest. Overwriting would record the proxy as the person signing in
     * — and would leave `trustedProxies` nothing to strip, which is the only way
     * the client can be found in a chain.
     */
    it('arrives intact with the peer appended when a range is declared', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '10.0.0.8',
          ip: '203.0.113.42',
          headers: { 'x-forwarded-for': '203.0.113.42, 10.0.0.7' },
        }),
        DECLARED_RANGE,
      );

      expect(web.headers.get('x-forwarded-for')).toBe(
        '203.0.113.42, 10.0.0.7, 10.0.0.8',
      );
    });

    /**
     * The trusted-proxy fix's acceptance criterion 2, and the reason the peer is *appended*
     * rather than substituted: better-auth's walk
     * (`@better-auth/core` `dist/utils/ip.mjs:179-186`) steps past the peer
     * because the peer is inside the declared range, and lands on the client the
     * proxy named.
     */
    it('keeps the client a declared proxy named', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '10.0.0.9',
          ip: '203.0.113.7',
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
        DECLARED_RANGE,
      );

      expect(web.headers.get('x-forwarded-for')).toBe('203.0.113.7, 10.0.0.9');
    });

    /**
     * The trusted-proxy fix's acceptance criterion 1, and the whole point of the
     * append. The declared range is `10.0.0.0/8` and this request arrived straight from
     * `198.51.100.9` — a path around the proxy. better-auth's walk starts at the
     * rightmost entry, finds the peer outside the range, and stops there: the
     * claim is ignored and the address nobody can forge is what gets recorded.
     *
     * No second matcher is compiled here to reach that answer, which is why this
     * asserts the header rather than a decision — the decision is better-auth's,
     * over the same list.
     */
    it('is not believed when the peer is outside the declared range', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '198.51.100.9',
          headers: { 'x-forwarded-for': '1.2.3.4' },
        }),
        DECLARED_RANGE,
      );

      const chain = web.headers.get('x-forwarded-for');
      expect(chain).toBe('1.2.3.4, 198.51.100.9');
      expect(chain?.split(', ').at(-1)).toBe('198.51.100.9');
    });

    /**
     * Node reports an IPv4 client on a dual-stack listener this way, and the
     * mapped form is not a string any operator writes in `TRUST_PROXY` — nor the
     * one better-auth records, since `normalizeIP` unwraps it. Appending it raw
     * would make the audit column and this file's own warnings disagree about
     * the same machine.
     */
    it('appends an IPv4-mapped peer in its dotted form', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '::ffff:198.51.100.9',
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
        DECLARED_RANGE,
      );

      expect(web.headers.get('x-forwarded-for')).toBe(
        '203.0.113.7, 198.51.100.9',
      );
    });

    /**
     * The append branch needs a socket to append. With none there is nothing
     * truthful to add, so the chain is passed on as it arrived — the pre-fix
     * behaviour, and not a hole: this branch only runs on a deployment that
     * named a proxy address in the first place.
     */
    it('passes a chain on untouched when a range is declared and there is no socket', () => {
      const web = toWebRequest(
        expressRequest({ headers: { 'x-forwarded-for': '203.0.113.7' } }),
        DECLARED_RANGE,
      );

      expect(web.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    });

    /**
     * The shipped default, and the case that was spoofable: better-auth believes
     * a single-entry header, so any caller could stamp their own address onto
     * their session and onto the login entry in the audit trail. With no address
     * declared there is no real proxy by configuration *and* no peer check to
     * perform, so the claim is discarded and the socket peer — which cannot be
     * forged — takes its place.
     */
    it('is replaced by the socket peer when nothing is declared', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '203.0.113.42',
          headers: { 'x-forwarded-for': '1.2.3.4' },
        }),
        NOTHING_DECLARED,
      );

      expect(web.headers.get('x-forwarded-for')).toBe('203.0.113.42');
    });

    it('is replaced whether the claim is one address or a whole chain', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '203.0.113.42',
          headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12' },
        }),
        NOTHING_DECLARED,
      );

      expect(web.headers.get('x-forwarded-for')).toBe('203.0.113.42');
    });

    it('replaces with an IPv4-mapped peer in its dotted form too', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '::ffff:203.0.113.42',
          headers: { 'x-forwarded-for': '1.2.3.4' },
        }),
        NOTHING_DECLARED,
      );

      expect(web.headers.get('x-forwarded-for')).toBe('203.0.113.42');
    });

    /**
     * The gap the `delete` closes on its own. With nothing declared *and* no
     * socket there is no truthful answer, so the claim is dropped rather than
     * passed on — better-auth then records nothing, and blank beats a lie.
     */
    it('is dropped, not passed on, when nothing is declared and there is no socket', () => {
      const web = toWebRequest(
        expressRequest({ headers: { 'x-forwarded-for': '1.2.3.4' } }),
        NOTHING_DECLARED,
      );

      expect(web.headers.has('x-forwarded-for')).toBe(false);
    });

    /**
     * A hop count names a position and the peer set is unnamed, so there is
     * nothing to check the peer against — the replacing branch is the honest
     * answer, and it is strictly safer than believing the claim. Written as
     * `trustedProxyRanges('2')` rather than `[]` because the branch this pins is
     * the derivation, not the literal: the hole was that a *different*
     * predicate said `'2'` meant "a proxy is trusted".
     */
    it('replaces the chain when TRUST_PROXY is a hop count on its own', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '198.51.100.9',
          headers: { 'x-forwarded-for': '1.2.3.4' },
        }),
        trustedProxyRanges('2'),
      );

      expect(web.headers.get('x-forwarded-for')).toBe('198.51.100.9');
    });

    /**
     * 0eaa47d's regression guard at the seam it protects: `TRUST_PROXY=0` is the
     * value an operator writes to say "nothing is in front of me", and it must
     * keep meaning exactly that.
     */
    it('replaces the chain when TRUST_PROXY is zero hops', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '203.0.113.42',
          headers: { 'x-forwarded-for': '1.2.3.4' },
        }),
        trustedProxyRanges('0'),
      );

      expect(web.headers.get('x-forwarded-for')).toBe('203.0.113.42');
    });

    /**
     * A count mixed with a range has a peer set, so it appends and the count is
     * ignored for this purpose — exactly as `trustedProxyRanges` already ignores
     * it for better-auth's list.
     */
    it('appends when a hop count is mixed with a range', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '10.0.0.9',
          ip: '203.0.113.7',
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
        trustedProxyRanges('1,10.0.0.0/8'),
      );

      expect(web.headers.get('x-forwarded-for')).toBe('203.0.113.7, 10.0.0.9');
    });

    /**
     * The topology the bundled proxy creates, written as the values that ship
     * rather than as generic ones, because that is the thing that regressed: the console
     * forwards the browser in `x-forwarded-for` and reaches the backend over
     * loopback, so the peer is `127.0.0.1` and `TRUST_PROXY=loopback` is what
     * lets better-auth's walk step past it and land on the person.
     *
     * A forged claim never enters the chain either: whatever the browser sent
     * the console *replaced*, so the leftmost entry here is the console's
     * statement about a socket, not a caller's about themselves.
     */
    it('keeps the browser leftmost on the shipped console topology', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '127.0.0.1',
          ip: '203.0.113.7',
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
        trustedProxyRanges('loopback'),
      );

      expect(web.headers.get('x-forwarded-for')).toBe('203.0.113.7, 127.0.0.1');
    });
  });

  /**
   * The address better-auth structurally cannot resolve, carried out of band.
   *
   * With a non-empty `trustedProxies` its walk (`ip.mjs:178-186`) returns only
   * an entry it did not step past, and it steps past exactly the declared ones
   * — so a caller arriving *from* the declared proxy with no chain of its own
   * resolves to `null` and the session, the login entry and the limiter key all
   * go blank. This header is the fallback `auth.config.ts`'s
   * `session.create.before` hook reads, and it is set in both branches because
   * the case it answers is about how better-auth *reads* the chain rather than
   * about which chain was written.
   */
  describe('the socket peer header', () => {
    it('states the peer whether or not a proxy is declared', () => {
      const declared = toWebRequest(
        expressRequest({ peer: '10.0.0.9' }),
        DECLARED_RANGE,
      );
      const undeclared = toWebRequest(
        expressRequest({ peer: '203.0.113.42' }),
        NOTHING_DECLARED,
      );

      expect(declared.headers.get(SOCKET_PEER_HEADER)).toBe('10.0.0.9');
      expect(undeclared.headers.get(SOCKET_PEER_HEADER)).toBe('203.0.113.42');
    });

    /**
     * The same normalization the chain gets, and for the same reason: the
     * mapped form is not what better-auth records, what `TRUST_PROXY` names, or
     * what the boot warning prints, so writing it here would make the fallback
     * address and the resolved one disagree about the same machine.
     */
    it('states an IPv4-mapped peer in its dotted form', () => {
      const web = toWebRequest(
        expressRequest({ peer: '::ffff:198.51.100.9' }),
        DECLARED_RANGE,
      );

      expect(web.headers.get(SOCKET_PEER_HEADER)).toBe('198.51.100.9');
    });

    /**
     * Absent rather than `"undefined"`: absence is the signal
     * `socketPeerFallback` reads to leave better-auth's answer alone, and a
     * literal `"undefined"` is an address better-auth would store and nobody
     * could act on.
     */
    it('states no peer when the request has no socket', () => {
      const web = toWebRequest(expressRequest({}), DECLARED_RANGE);

      expect(web.headers.has(SOCKET_PEER_HEADER)).toBe(false);
    });

    /**
     * The security-relevant one. The header is Cloudgate's statement about a
     * socket, so an inbound copy is a caller choosing the address their own
     * audit row records — and unlike `x-forwarded-for` there is no branch where
     * a caller's copy is worth anything. Deleted before it is set, which is
     * what makes the `set` the only way one can arrive.
     */
    it('drops a socket-peer header the caller sent', () => {
      const web = toWebRequest(
        expressRequest({
          peer: '10.0.0.9',
          headers: { [SOCKET_PEER_HEADER]: '1.2.3.4' },
        }),
        DECLARED_RANGE,
      );

      expect(web.headers.get(SOCKET_PEER_HEADER)).toBe('10.0.0.9');
    });

    it('drops a socket-peer header the caller sent when there is no socket', () => {
      const web = toWebRequest(
        expressRequest({ headers: { [SOCKET_PEER_HEADER]: '1.2.3.4' } }),
        DECLARED_RANGE,
      );

      expect(web.headers.has(SOCKET_PEER_HEADER)).toBe(false);
    });
  });
});
