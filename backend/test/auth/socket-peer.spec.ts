import {
  SOCKET_PEER_HEADER,
  socketPeerFallback,
} from '../../src/auth/socket-peer';

/**
 * The fallback that keeps `session.ip_address` from going blank on a
 * configuration that looks correct.
 *
 * better-auth resolves the address from the forwarded chain, and with a
 * non-empty `trustedProxies` its walk returns only an entry it did not step
 * past — so a caller arriving *from* the declared proxy with no chain of its
 * own resolves to nothing at all. That is the Sessions screen's dash, a blank
 * `ip` on the login entry in the audit trail, and better-auth's sign-in
 * throttle collapsed onto the literal key `no-trusted-ip`, all at once.
 *
 * **Fill-if-empty is the whole rule**, and every assertion below is about one
 * of its two sides: an address better-auth resolved is never touched, so there
 * is one writer per request and nothing for the two to drift about.
 */

/** A request as `session.create.before` sees it — headers and nothing else. */
function requestWith(headers: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(headers) };
}

const FROM_THE_SOCKET = requestWith({ [SOCKET_PEER_HEADER]: '127.0.0.1' });

describe('socketPeerFallback', () => {
  /**
   * The case that must stay untouched: a real proxy's chain, an untrusted
   * peer's ignored claim and the shipped no-proxy-declared branch all reach
   * here with an address already resolved, and overwriting any of them would be
   * exactly the hand-written column `toWebRequest`'s docblock rejects.
   */
  it('leaves an address better-auth resolved alone', () => {
    expect(socketPeerFallback('203.0.113.7', FROM_THE_SOCKET)).toBeUndefined();
  });

  /**
   * `''` is what `createSession` stores — `getIp(headers) || ""` — so it is the
   * value this function actually meets in production; `null` and `undefined`
   * are the same answer one layer up, before the column's default is applied.
   */
  it.each([
    ['the empty string createSession stores', ''],
    ['null', null],
    ['undefined', undefined],
  ])('fills the peer in when better-auth resolved %s', (_label, resolved) => {
    expect(socketPeerFallback(resolved, FROM_THE_SOCKET)).toBe('127.0.0.1');
  });

  it('trims the header before answering with it', () => {
    expect(
      socketPeerFallback(
        '',
        requestWith({ [SOCKET_PEER_HEADER]: ' 10.0.0.9 ' }),
      ),
    ).toBe('10.0.0.9');
  });

  /**
   * `toWebRequest` omits the header entirely when there is no socket — Nest's
   * own testing harness and a few upgrade paths arrive that way — so absence
   * has to mean "leave it blank" rather than produce a string nobody can act
   * on.
   */
  it('answers nothing when the header is absent', () => {
    expect(socketPeerFallback('', requestWith({}))).toBeUndefined();
  });

  it('answers nothing when the header is blank', () => {
    expect(
      socketPeerFallback('', requestWith({ [SOCKET_PEER_HEADER]: '   ' })),
    ).toBeUndefined();
  });

  /**
   * A session created with no HTTP request behind it at all — better-auth's
   * `context.request` is optional, and a session minted from an internal call
   * has none.
   */
  it('answers nothing when there is no request', () => {
    expect(socketPeerFallback('', undefined)).toBeUndefined();
  });
});
