/**
 * The socket peer, stated on a header of Cloudgate's own, for the one case
 * better-auth structurally cannot answer.
 *
 * With a non-empty `advanced.ipAddress.trustedProxies`, `getIPFromHeader`
 * (`@better-auth/core` `dist/utils/ip.mjs:178-186`) returns only an entry it
 * did not step past, and it steps past exactly the declared ones — so a request
 * arriving *from* a declared proxy with no forwarded chain resolves to `null`
 * and `createSession` stores `""`. No chain shape fixes that: `[P]`, `[P, P]`,
 * `[T, P]` and `[P, T]` all reach `:186`, and a second entry in
 * `ipAddressHeaders` is walked with the same trusted list (`:205-211`).
 *
 * So the address is carried out of band and used as a fallback, never as the
 * answer. The header is deleted before it is set, exactly as `toWebRequest`
 * deletes `x-forwarded-for` in its replacing branch: it is Cloudgate's
 * statement about a socket and must not be something a caller can put in a
 * request. Absent when there is no socket at all, which is the signal
 * {@link socketPeerFallback} reads — `"undefined"` is an address better-auth
 * would store and nobody could act on.
 *
 * A module of its own rather than a second export from `auth.controller.ts`,
 * because `auth.config.ts` needs both halves and the controller already imports
 * the config: a shared constant in either of those two files is a cycle.
 */
export const SOCKET_PEER_HEADER = 'x-cloudgate-socket-peer';

/**
 * The address to write into a new session's `ip_address`, or `undefined` to
 * leave better-auth's answer alone.
 *
 * Fill-if-empty on purpose. Every case better-auth can resolve — a real proxy's
 * chain, an untrusted peer's ignored claim, the shipped no-proxy-declared
 * branch — is untouched, so there is one value and one writer per request and
 * nothing to drift.
 */
export function socketPeerFallback(
  ipAddress: string | null | undefined,
  request: { headers: Headers } | undefined,
): string | undefined {
  if (ipAddress) return undefined;
  const peer = request?.headers.get(SOCKET_PEER_HEADER)?.trim();
  return peer || undefined;
}
