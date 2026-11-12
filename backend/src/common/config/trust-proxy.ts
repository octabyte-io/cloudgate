import { z } from 'zod';

/**
 * `TRUST_PROXY`, read twice: as Express's `trust proxy` setting, and as the
 * CIDR list better-auth needs before it will believe a forwarded chain.
 *
 * Two readers, one key, because they are two halves of one decision — *which
 * hops in front of Nest may name the caller*. Two keys was the alternative and
 * it is worse: they can be set inconsistently, and what an inconsistent pair
 * produces is a `session.ip_address` that is silently the proxy's rather than
 * the person's. An audit column that lies is more dangerous than one that is
 * blank, which is the whole reason this is a configured key and not a
 * hardcoded `true`.
 *
 * Why both readers are needed, and neither alone is enough:
 *
 * - Express decides what `req.ip` means. With nothing trusted it is the socket
 *   peer, which cannot be forged; `AuthController.toWebRequest` hands that to
 *   better-auth as `x-forwarded-for` when the caller sent none.
 * - better-auth decides whether a chain the caller *did* send is believed.
 *   `@better-auth/core` `dist/utils/ip.mjs:188` discards any `x-forwarded-for`
 *   with more than one entry unless `trustedProxies` covers the hops
 *   (`:175-187` strips from the right to the first untrusted one). So a
 *   two-hop deployment records nothing until this list is populated — and a
 *   single-entry header from an untrusted caller is believed until it is.
 *
 * **`trustedProxyRanges` is also the gate `toWebRequest` branches on.**
 * There used to be a third export, `trustsAnyProxy`, answering "does
 * configuration name any hop at all" — and it answered *yes* to a hop count,
 * which is the one form of the key that cannot name a peer. On `TRUST_PROXY=1`
 * with nothing actually in front, the caller's own single-entry header was
 * therefore preserved and believed: the trust-proxy hole, reached through a count instead
 * of an unset key. Folded away rather than fixed in place, because two
 * overlapping answers to "is a proxy trusted" is how they drift — the address
 * list *is* the answer, and an empty one means no peer can be checked.
 */

/**
 * `proxy-addr`'s own alias table (`index.js:40-44`), mirrored because the
 * module does not export it.
 *
 * Not a convenience: `loopback` and `uniquelocal` are the two values a
 * self-hosted operator actually writes, and better-auth's `trustedProxies`
 * takes literal IPs and CIDRs only. Without the expansion, `TRUST_PROXY=loopback`
 * would fix `req.ip` and leave the forwarded chain discarded — the half-working
 * state that reads as "the fix did not land".
 */
const PROXY_ADDR_ALIASES: Record<string, readonly string[]> = {
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  loopback: ['127.0.0.1/8', '::1/128'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/** A hop count — Express's third form, alongside an alias and an address. */
const HOP_COUNT = /^\d+$/;

const isAddressOrRange = (value: string): boolean =>
  z.ipv4().safeParse(value).success ||
  z.ipv6().safeParse(value).success ||
  z.cidrv4().safeParse(value).success ||
  z.cidrv6().safeParse(value).success;

/** What a TRUST_PROXY entry may be, in the words the operator gets back. */
export const TRUST_PROXY_REQUIREMENT =
  'each entry must be an IP address, a CIDR range, a hop count, or one of ' +
  'loopback, linklocal, uniquelocal — and a hop count must be the only entry';

/** The entries of a TRUST_PROXY value, trimmed and lower-cased, blanks dropped. */
function entriesOf(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether every entry is one Express would accept, checked at boot.
 *
 * Refused here rather than at someone's first sign-in, the way TRUSTED_ORIGINS
 * is: a typo'd `TRUST_PROXY` is silently *no* trust, and no-trust looks exactly
 * like a working install right up until the audit column turns out to hold the
 * load balancer's address on every row.
 */
export const isTrustProxyValue = (value: string): boolean => {
  const entries = entriesOf(value);
  if (entries.length === 0) return false;
  // A count names a position, so a *list* of them names nothing: Express hands
  // anything that is not a lone number to `proxy-addr`, which reads the counts
  // as addresses in 0.0.0.0/8 (`ipaddr.js` long form) and matches no caller
  // that can exist. Refused here rather than left to trust nothing quietly,
  // which is this function's stated reason for existing — and deliberately
  // distinct from the single-count case, which is meaningful, in use, and
  // still accepted (`hopCountWarning` weighs exactly that and declines).
  if (entries.length > 1 && entries.every((entry) => HOP_COUNT.test(entry))) {
    return false;
  }
  return entries.every(
    (entry) =>
      HOP_COUNT.test(entry) ||
      entry in PROXY_ADDR_ALIASES ||
      isAddressOrRange(entry),
  );
};

/**
 * The value for `app.set('trust proxy', …)`, or `false` when the key is unset.
 *
 * `false` is Express's own default and the shipped arrangement — deliberately
 * returned rather than skipped, so the caller states the safe case out loud
 * instead of inferring it from an absent call.
 *
 * A hop count has to arrive as a `number`: Express branches on `typeof val ===
 * 'number'` and hands anything else to `proxy-addr.compile`, which reads `'2'`
 * as an address list and refuses it.
 */
export function expressTrustProxy(
  value: string | undefined,
): string | number | false {
  if (!value?.trim()) return false;
  const entries = entriesOf(value);
  if (entries.length === 1 && HOP_COUNT.test(entries[0])) {
    return Number(entries[0]);
  }
  // Counts are dropped for the reason `trustedProxyRanges` drops them, and for
  // one more: Express splits this string itself
  // (`express/lib/utils.js:207-213`) and `ipaddr.js` reads a bare integer as
  // IPv4 long form, so `1` reaches `proxy-addr` as `0.0.0.1/32` — an address
  // matcher no request can satisfy, and one that made Express's list differ
  // from the list `AuthModule` hands better-auth. Both readers now see the same
  // entries, which is the whole claim of this file's docblock.
  const addresses = entries.filter((entry) => !HOP_COUNT.test(entry));
  // Unreachable from a validated env — `isTrustProxyValue` refuses an all-count
  // list — and kept for the reason `OWNER_REFUSALS.GONE` is kept in
  // `auth.service.ts`: the alternative is a fall-through that silently compiles
  // nonsense into a trust decision.
  if (addresses.length === 0) return false;
  return addresses.join(', ');
}

/**
 * `expressTrustProxy` *and the `app.set` that makes it mean anything* — one
 * call, so a process that boots Nest cannot have the first without the second
 * (H-28).
 *
 * The three lines this replaces lived only in `main.ts`, and `createTestApp`
 * did not have them. Every e2e therefore ran with Express trusting nothing
 * while `AuthModule` handed better-auth the full declared list off the same
 * key — the two halves `trustedProxyRanges`'s docblock above calls "two halves
 * of one decision", disagreeing in the only place anybody checks either of
 * them. `test/auth/session-address.e2e-spec.ts` is the sharpest case: it
 * declares `loopback,10.0.0.0/8` and its whole subject is that this topology is
 * configured correctly, on an app where it was not configured at all.
 *
 * Since H-07, `AuthController`'s untrusted-peer warning asks Express's own
 * compiled matcher, so the gap reaches product code and not just the fixture:
 * with no `trust proxy` set there is no matcher to ask, and `declaredProxy`
 * takes its "unanswerable, so silent" branch on every e2e request. The branch
 * an e2e exercised was not the branch a deployment runs.
 *
 * **A shared function rather than a second `app.set` copied into the harness.**
 * A copy is what drifted here in the first place, and the drift was invisible
 * because both sides looked right on their own — the same argument
 * `trustedProxyRanges` makes for one key with two readers, one level up. The
 * app is typed structurally rather than as `NestExpressApplication` so this
 * file keeps depending on nothing but its own parsing; `set` is the whole of
 * what is used.
 *
 * `announce` rather than a `Logger`: `main.ts` says this through nestjs-pino
 * with a `Bootstrap` context, and a test app has no logger to say it to.
 * Returns what it applied, so a caller can assert on the decision rather than
 * re-deriving it.
 */
export function applyTrustProxy(
  app: { set(setting: string, value: string | number): unknown },
  value: string | undefined,
  announce: (message: string) => void = () => undefined,
): string | number | false {
  const trustProxy = expressTrustProxy(value);
  // `false` is Express's default, so setting it would be a no-op — and saying
  // "Trusting proxies: false" at boot names a trust that was not granted.
  if (trustProxy === false) return false;
  app.set('trust proxy', trustProxy);
  announce(`Trusting proxies: ${String(trustProxy)}`);
  return trustProxy;
}

/**
 * The same key as the IP-and-CIDR list better-auth's `advanced.ipAddress`
 * takes, and the same list `AuthController.toWebRequest`
 * branches on.
 *
 * A hop count is dropped rather than translated, because it cannot be: "one hop
 * away" names a position in the chain and `trustedProxies` names addresses. An
 * operator who needs the forwarded address recorded has to give the proxy's
 * range instead of a count, which `TRUST_PROXY_REQUIREMENT` and the deploy
 * template both say.
 *
 * **Empty means no peer can be checked, which is what makes it the gate.** With
 * no address named there is no way to ask whether the hop that actually reached
 * Nest is the declared proxy, so `toWebRequest` replaces the chain with the
 * socket peer rather than passing on a claim nothing can verify. Unset,
 * blank and `0` land here, unchanged from 0eaa47d — and so does a hop-count-only
 * value, which is the case the trusted-proxy fix closed.
 */
export function trustedProxyRanges(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return entriesOf(value)
    .filter((entry) => !HOP_COUNT.test(entry))
    .flatMap((entry) => [...(PROXY_ADDR_ALIASES[entry] ?? [entry])]);
}

/**
 * Whether the key trusts hops by *count alone* — the one form that is accepted,
 * changes what Express reports, and still names no address.
 *
 * Decidable from configuration, which is why `AuthController` says it once at
 * boot rather than once per peer: a count leaves `trustedProxyRanges` empty, so
 * every `/api/auth` request records the hop it arrived from, and behind a real
 * proxy that is the proxy on every request — collapsing better-auth's sign-in
 * throttle onto one key for the whole install. The remedy is a range, and the
 * warning exists to name it.
 *
 * Zero is not that case and must not warn: `TRUST_PROXY=0` is what an operator
 * writes to say *nothing is in front of me* (0eaa47d), and on such an install
 * the recorded address is the client's and the throttle is already per-client.
 * A count mixed with a range is not it either — that has a peer set, so the
 * chain is peer-checked and the client's own address survives.
 */
export function trustsHopCountOnly(value: string | undefined): boolean {
  const entries = entriesOf(value ?? '');
  return (
    entries.every((entry) => HOP_COUNT.test(entry)) &&
    entries.some((entry) => Number(entry) > 0)
  );
}
