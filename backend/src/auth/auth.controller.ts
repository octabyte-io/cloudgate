import { All, Controller, Inject, Logger, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response } from 'express';
import {
  trustedProxyRanges,
  trustsHopCountOnly,
} from '../common/config/trust-proxy';
import type { Auth } from './auth.config';
import { AUTH } from './auth.constants';
import { Public } from './decorators/public.decorator';
import { SOCKET_PEER_HEADER } from './socket-peer';
import { SsoDialScope } from './sso-dial-scope';

/**
 * Mounts better-auth's fetch handler under /api/auth/*. Nest's JSON body
 * parser has already consumed the stream by the time a controller runs, so
 * the web Request is rebuilt from the parsed body (all better-auth endpoints
 * with a body speak JSON).
 */
// Kept out of the OpenAPI document. This is one catch-all, so it reflects
// as a single `/api/auth/{splat}` path across eight verbs, with no body and no
// response on any of them — eight operations that state nothing true about
// better-auth's actual surface, which a client generator would faithfully turn
// into eight unusable methods. better-auth describes its own endpoints; this
// document describes Cloudgate's.
@ApiExcludeController()
// **`@Public()` here gives away every account-level rule Cloudgate has, and it
// has to (H-27).** It is not an opt-out for one route: it covers the
// `@All('*splat')` below, which is the whole of better-auth's surface. Sign-in
// and sign-up must be reachable with no credential, and `/get-session` *is* how
// a caller finds out whether they have one, so the decorator is load-bearing
// and does not come off.
//
// What comes off with it is `AuthGuard` → `AuthService.validateRequest` →
// `resolveCaller`, which is where every rule about the *account* behind a
// credential lives. A request to `/api/auth/*` reaches better-auth's handler
// having passed none of them. The ban fix shipped it into `resolveCaller` and
// read as complete for that reason: four readers refused a banned credential
// and nobody counted the passthrough. H-08 is what that cost — a banned
// operator with a fully rendered console — and it was found by driving a live
// box, not by anything in this tree.
//
// **The compensating control is `refuseBannedSession`, `auth.config.ts`'s
// top-level `hooks.after`.** That is the only thing standing between this
// decorator and the next account-level condition — disabled, deleted,
// organization removed, credentials rotated. Any such rule has to be added in
// *both* places, or in one both reach: `banInForce` in `ban.ts` is the shape
// that already works, with `resolveCaller` and the hook as its two callers and
// no second copy of the predicate.
//
// **Rejected: a second named seam** — an `accountRefusal(row)` both call, so a
// third surface cannot appear without one. Three reasons, and the third is why
// this is a test rather than a refactor. There is exactly one account-level
// condition today, so the seam would be a wrapper with one implementation and a
// second name for `banInForce` — §2.4's "derive, never re-declare" pointing the
// other way. The two callers cannot share more than the predicate anyway: one
// returns a typed `CredentialRejection` the Nest guard renders, the other
// throws better-auth's `APIError`, and `banned-session-read.e2e-spec.ts`'s
// "403, not a 500" case exists because that difference is load-bearing. And a
// seam does not enforce arrival: nothing stops the next rule being written as
// one more `if` inside `resolveCaller`, which is the shape H-08 already took —
// the predicate was named and had four readers, and the surface it was missing
// from was not one of them. What catches that is a test that measures this
// surface against itself —
// `test/auth/auth-surface-account-cover.e2e-spec.ts` enumerates better-auth's
// own route table and fails when a route answers a banned cookie the same way
// it answers a live one.
@Public()
@Controller('api/auth')
export class AuthController {
  /**
   * The addresses in front of this instance that are trusted to name the caller
   * (narrowed to the declared proxies). Read once at construction rather than per request:
   * it comes from TRUST_PROXY, which `main.ts` has already handed to Express as
   * `trust proxy` before the first request arrives, and a value that changed
   * between requests would mean the two disagreed.
   *
   * The same list better-auth is given as `advanced.ipAddress.trustedProxies`
   * (`auth.module.ts`), deliberately: the peer check `toWebRequest` performs is
   * better-auth's own walk over this list, so the two halves cannot drift.
   */
  private readonly trustedProxies: readonly string[];

  private readonly logger = new Logger(AuthController.name);

  /**
   * Says once, per peer, that a forwarded header arrived from somewhere the
   * declared proxy is not. Held on the instance because "once" is a fact
   * about this process, not about a request.
   */
  private readonly reportUntrustedPeer: (peer: string) => void;

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    config: ConfigService,
    private readonly ssoDials: SsoDialScope,
  ) {
    const declared = config.get<string>('TRUST_PROXY');
    this.trustedProxies = trustedProxyRanges(declared);
    this.reportUntrustedPeer = untrustedPeerReporter(
      this.trustedProxies,
      (message) => this.logger.warn(message),
    );
    // Said here rather than in `main.ts` beside `Trusting proxies: …`, and said
    // at boot rather than per request, for the two halves of one reason: it is
    // decidable from configuration alone — no peer is needed to know the limiter
    // key has collapsed — and the consequence is better-auth's, which is what
    // this controller mounts and what the docblock below already explains. The
    // constructor runs once per process, so this is one line per boot.
    if (trustsHopCountOnly(declared)) {
      this.logger.warn(hopCountWarning(declared ?? ''));
    }
  }

  @All('*splat')
  async handle(
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ): Promise<void> {
    // A Hosted customer's SSO routes run with the plugin's own fetches
    // guarded, since the plugin takes no fetch of ours (ADR-0076).
    const webResponse = await this.ssoDials.run(
      { path: req.path, body: req.body as unknown },
      () =>
        this.auth.handler(
          toWebRequest(req, this.trustedProxies, this.reportUntrustedPeer),
        ),
    );

    res.status(webResponse.status);
    webResponse.headers.forEach((value, key) => {
      if (key === 'set-cookie' || key === 'content-length') return;
      res.setHeader(key, value);
    });
    const cookies = webResponse.headers.getSetCookie();
    if (cookies.length > 0) {
      res.setHeader('set-cookie', cookies);
    }
    res.send(await webResponse.text());
  }
}

/**
 * Rebuilds the Web `Request` better-auth's handler expects out of the Express
 * one Nest has already parsed.
 *
 * **It also decides what address a session records.** better-auth resolves the
 * client address from a *header* and only from a header: `@better-auth/core`'s
 * `getIp` walks `advanced.ipAddress.ipAddressHeaders` (default
 * `["x-forwarded-for"]`) and has no socket to fall back to, because a Web
 * `Request` does not carry one — and `createSession` stores
 * `getIp(headers) || ""`. So every session created by a caller that sends no
 * forwarded header stored no address at all: `curl` straight at the backend, and
 * a browser whose hop does not add one. Settings → Account → Sessions could then
 * only ever render its dash, which is the one column that tells three
 * `curl/8.5.0` rows apart when somebody is auditing for a session they do not
 * recognise. `AuthController`'s catch-all is the only route that creates a
 * session, so this function is the whole choke point.
 *
 * **The value Cloudgate contributes is the socket peer, in both branches.**
 * It used to be `req.ip`, and `req.ip` is whatever Express's own
 * `trust proxy` setting has already decided the client is — which, once a proxy
 * is trusted, is derived from the very header this function is deciding whether
 * to believe. `req.socket.remoteAddress` is the one address in the request that
 * a caller cannot choose. Its IPv4-mapped form is normalized first
 * (`::ffff:198.51.100.9` → `198.51.100.9`), because Node hands that back on a
 * dual-stack socket and it is the string better-auth's `ipToBytes` has to parse.
 *
 * **`trustedProxies` decides whether an incoming chain is worth anything, and it
 * is the security-relevant half.**
 *
 * - TRUST_PROXY names at least one address (a range, an IP, or an alias): the
 *   caller's chain is left in place and the socket peer is **appended as the
 *   rightmost entry**. A real proxy's chain names the client while the peer
 *   names whichever hop reached Nest, so overwriting would record the proxy as
 *   the person signing in. Appending is what turns
 *   `advanced.ipAddress.trustedProxies` into a peer check: its walk
 *   (`@better-auth/core` `dist/utils/ip.mjs:179-186`) strips from the right to
 *   the first untrusted hop, so it steps *past* the peer when the peer is a
 *   declared proxy and finds the client, and stops *at* the peer when it is not
 *   — a claim from outside the declared range is ignored, and the unforgeable
 *   address is recorded instead. No second address matcher is compiled here on
 *   purpose: one matcher, fed the one list, cannot drift from itself.
 *
 *   **The one case that walk cannot answer is a declared proxy that named
 *   nobody.** A caller arriving *from* the declared address with no
 *   chain of its own — a health checker, a sidecar, a browser on the far end of
 *   the SSH tunnel `docs/deploy.md` §3 recommends — leaves a chain whose only
 *   entry is trusted, so the walk steps past it, runs out and returns `null`:
 *   the session, the login entry in the audit trail and better-auth's limiter
 *   key all go blank on a configuration that looks correct. No chain shape
 *   fixes it, since the walk only ever returns an entry it did not step past.
 *   The peer is therefore carried out of band on {@link SOCKET_PEER_HEADER} and
 *   filled in by `auth.config.ts`'s `session.create.before` hook when
 *   better-auth resolved nothing. That is not a way to assert an address into
 *   the chain: the header is deleted before it is set, so a caller's copy never
 *   survives, and it is read only when the answer would otherwise be empty.
 * - TRUST_PROXY names no address at all — unset, blank, `0`, or a hop count on
 *   its own: the chain is **replaced** by the socket peer, and dropped entirely
 *   if there is no socket. With no address named there is no real proxy *by
 *   configuration* and no peer to check against, so a chain a caller sends is
 *   unverifiable by definition — and better-auth believes a single-entry header
 *   (`ip.mjs:188-191`), which let any caller stamp their own address onto their
 *   session and onto the login entry in the audit trail. An audit column that
 *   lies is worse than one that is blank, and this is the shipped configuration,
 *   so it is where it mattered most.
 *
 * The two rules do not conflict, and the reason is worth keeping: the
 * trust-proxy rule's acceptance criterion is that a chain *a real proxy set* survives, and the
 * replacing branch only runs when configuration names no such proxy.
 *
 * **Do not append unconditionally.** With no trusted address, appending to a
 * caller's header hands `getIPFromHeader` two entries and no trusted proxy, so
 * it returns null (`ip.mjs:188`) — the audit column *and* the limiter key both
 * go blank, and any caller could force that by sending any header at all. That
 * is why the branch with no named address replaces rather than appends.
 *
 * **A failed peer check is not a refusal.** No 400, no 403, nothing: the header
 * is ignored, the peer is recorded, the request proceeds. A mixed ingress is an
 * operator fault, and this function governs the whole of `/api/auth/*` — a
 * rejection here would take sign-in down for everybody on a misconfiguration,
 * which is how a security fix gets reverted instead of adopted. Telling the
 * operator is the warning's job, not this one's — `reportUntrustedPeer` is where that
 * happens, and it is a callback rather than a `logger` call because "once per
 * peer" is state this function must not own: it is rebuilt on every request and
 * would forget on every request.
 *
 * **The audit column is not the only thing this decides.** better-auth keys its
 * own rate limiter on the same `getIp`
 * (`dist/api/rate-limiter/index.mjs:281,287`), and that limiter is on by default
 * in production — `enabled: options.rateLimit?.enabled ?? isProduction`
 * (`dist/context/create-context.mjs:171`), and this config sets no top-level
 * `rateLimit`. Its default rules are 3 requests per 10s on `/sign-in`,
 * `/sign-up`, `/change-password` and `/change-email`, and 3 per 60s on
 * `/request-password-reset`. All of them were keyed on a header the caller
 * controlled, so rotating `x-forwarded-for` bought an unlimited number of
 * sign-in attempts. Replacing the header is what puts the throttle back on the
 * socket. Do not "simplify" the branch away on the grounds that a blank address
 * column is cosmetic.
 *
 * Rejected: writing `session.ip_address` from Cloudgate code. That is the trust-proxy rule's
 * explicit non-goal and the mirror of the argument `UsersService.revokeSession`
 * already records for revocation — the column is better-auth's, and a
 * hand-written value drifts from what better-auth thinks the session is.
 *
 * That rule still stands, and the socket-peer fill is its one bounded exception rather than a
 * repeal: the value written is not one Cloudgate *derives* — it is the socket
 * peer `ip.mjs:184` would itself have returned had the operator not declared
 * that very address — and it is written only where better-auth resolved
 * nothing at all, so the two can never disagree about a session either of them
 * could name.
 *
 * Exported for `test/auth/forwarded-address.spec.ts`, not for reuse: these are
 * four lines with a security consequence, and an e2e cannot see half of them
 * (better-auth answers `127.0.0.1` from `getIp`'s dev/test fallback, which is
 * the same value a loopback socket peer produces). The peer rule added later is
 * doubly invisible there: supertest always connects from loopback, so an
 * untrusted peer cannot be produced over a real socket at all.
 */
export function toWebRequest(
  req: ExpressRequest,
  trustedProxies: readonly string[],
  reportUntrustedPeer: (peer: string) => void = () => undefined,
): Request {
  const url = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === 'content-length') continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const peer = socketPeer(req);
  // What the socket was, said once, outside the chain. Deleted first
  // whatever the branch below decides — this is Cloudgate's own statement and
  // an inbound copy is a caller choosing their own audit row. Already
  // normalized by `socketPeer`, so this is the same dotted string the chain
  // carries and the untrusted-peer warning names.
  headers.delete(SOCKET_PEER_HEADER);
  if (peer) headers.set(SOCKET_PEER_HEADER, peer);
  if (trustedProxies.length === 0) {
    // Not a no-op on a request that carries no such header: it is what makes the
    // `set` below the only way one can arrive.
    headers.delete('x-forwarded-for');
    if (peer) headers.set('x-forwarded-for', peer);
  } else if (peer) {
    // The peer goes on the right, where better-auth's walk starts. Left in place
    // untouched when there is no socket at all — Nest's own testing harness and
    // a few upgrade paths arrive that way, and a chain with nothing appended is
    // the earlier behaviour rather than a new hole: the deployment still has to
    // have named an address for this branch to run.
    const claimed = headers.get('x-forwarded-for');
    // A chain arrived from a peer that is not one of the declared
    // proxies, so better-auth's walk stops at that peer and the claim is about
    // to be ignored. The question is put to Express's *own* compiled matcher,
    // which keeps the promise the trusted-proxy list makes one line above — no second address
    // matcher is compiled in Cloudgate — and does it better than the test that
    // used to stand here.
    //
    // That test was `normalizeAddress(req.ip) === peer`: Express did not step
    // past this peer, therefore the peer is untrusted. It does mean that, and
    // it means one other thing, which is what H-07 found on the *shipped*
    // topology. A declared proxy whose chain names only itself leaves Express
    // nothing to step *to*, so `req.ip` is the peer again — and at
    // `TRUST_PROXY=loopback` a request from the box through the console
    // (`x-forwarded-for: 127.0.0.1` from `127.0.0.1`) earned a warning saying
    // `127.0.0.1` is outside `127.0.0.1/8` and inviting the operator to close
    // the path around their own console. The old comment priced that at "one
    // line per boot on an unusual proxy"; here it is the ordinary one — a
    // health check or monitoring probe on the box, and the SSH tunnel
    // `docs/deploy.md` §3 recommends, which the socket-peer note above names as a case
    // to support. A warning that names a path with nothing on the other end of
    // it is worse than silence: it is the shipped configuration accusing itself.
    if (claimed !== null && !declaredProxy(req, peer)) {
      reportUntrustedPeer(peer);
    }
    headers.set('x-forwarded-for', claimed ? `${claimed}, ${peer}` : peer);
  }

  const hasBody =
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    req.body !== undefined &&
    (typeof req.body !== 'object' ||
      Object.keys(req.body as object).length > 0);

  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? JSON.stringify(req.body) : undefined,
  });
}

/**
 * The address the connection was actually made from, in the form the rest of
 * this file talks about addresses in.
 *
 * `undefined` when there is no socket — Nest's own testing harness arrives that
 * way, and so do a few upgrade paths, which is why every caller guards rather
 * than stringifying whatever it finds: `"undefined"` is an address better-auth
 * would happily store and nobody could act on.
 *
 * Node reports an IPv4 client on a dual-stack listener as `::ffff:198.51.100.9`.
 * better-auth's own `normalizeIP` unwraps that form, so this is not what makes
 * the peer *match* a range — it is what makes the address this function appends,
 * the address better-auth records, and the address the warning names all be
 * the same string. `::ffff:` with no dot is left alone: that is the hex form,
 * which no operator writes in TRUST_PROXY either.
 */
function socketPeer(req: ExpressRequest): string | undefined {
  return normalizeAddress(req.socket?.remoteAddress);
}

/**
 * Whether Express counts this peer as one of the proxies TRUST_PROXY declares
 * (corrected by H-07).
 *
 * `trust proxy fn` is the predicate Express compiled from the very value
 * `main.ts` handed it (`express/lib/application.js:370-371`), and it is what
 * `req.ip` and `req.ips` are already derived from. Asking it is what lets the
 * warning name a genuinely untrusted peer while Cloudgate still compiles no
 * address matcher of its own — the promise `toWebRequest`'s docblock makes, and
 * the reason `req.ip === peer` was reached for in the first place. Hop `0`
 * because the peer is the hop that reached Nest, which is where `proxy-addr`'s
 * own walk starts (`proxy-addr/index.js` `alladdrs`).
 *
 * Rejected: `req.ips.length === 0`. It asks the same compiled matcher and would
 * answer correctly at every call site here, but it answers about the *chain* —
 * an empty list is also what "nothing was forwarded" looks like — so the
 * condition would be right only because of the `claimed !== null` test standing
 * beside it, and would go quietly wrong the day that test moved.
 *
 * **`true` when there is no matcher to ask**, which is a request that Express
 * did not build: Nest's own testing harness, and the same upgrade paths that
 * arrive with no socket. An unanswerable question is not evidence of a second
 * ingress, and warning on it would be H-07 again in another shape — a line
 * stating as fact something it never checked.
 */
function declaredProxy(req: ExpressRequest, peer: string): boolean {
  const trusts = (req.app as ExpressRequest['app'] | undefined)?.get(
    'trust proxy fn',
  ) as ((address: string, hop: number) => boolean) | undefined;
  if (typeof trusts !== 'function') return true;
  return trusts(peer, 0);
}

/** `socketPeer`'s unwrapping of Node's IPv4-mapped form. */
function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  return address.startsWith('::ffff:') && address.includes('.')
    ? address.slice('::ffff:'.length)
    : address;
}

/**
 * How many distinct peers get a warning before this instance goes quiet.
 *
 * **The bound is the point, not a tuning knob.** The peer is an address a
 * stranger chooses by connecting, so a set keyed on it grows with the traffic
 * anyone cares to send — an unbounded one is a memory leak with a remote
 * trigger, on the very path a misconfigured install is already being probed on.
 * A handful of distinct peers is what a real second ingress looks like; a
 * thousand is a scan, and the second line of a scan tells the operator nothing
 * the first did not.
 */
export const UNTRUSTED_PEER_WARNINGS = 32;

/**
 * The warning a mixed ingress earns, said once for each peer it comes from.
 *
 * `TRUST_PROXY` is checked for syntax at boot and never for *fit*: a range can
 * name a proxy that nothing goes through, or a proxy that can be walked around,
 * and both run indefinitely without a word. The proxy rule made the backend safe in that
 * state — the forwarded header is ignored — but silent, and silent is
 * indistinguishable from working, so the operator never learns a path around
 * their proxy exists.
 *
 * **Once per peer, not once per request, and at WARN.** Per request this would
 * be one line per sign-in attempt on a misconfigured install, which is how a
 * real signal gets filtered out. Nothing here is a request failure — the request
 * succeeded, and the proxy rule settled that it must — so it is an observation about
 * configuration and must not be at a level that wakes anybody.
 *
 * Rejected: echoing the `x-forwarded-for` value into the line. It is the one
 * part of this a caller writes, and a log line is not the place to render a
 * stranger's string — the peer says where to look, the claim adds nothing an
 * operator can act on.
 *
 * Exported for `test/auth/untrusted-peer-warning.spec.ts`.
 */
export function untrustedPeerReporter(
  declared: readonly string[],
  warn: (message: string) => void,
): (peer: string) => void {
  const seen = new Set<string>();
  return (peer: string): void => {
    if (seen.has(peer) || seen.size >= UNTRUSTED_PEER_WARNINGS) return;
    seen.add(peer);
    warn(
      `TRUST_PROXY declares ${declared.join(', ')}, but a request carrying ` +
        `x-forwarded-for arrived directly from ${peer}, which is outside it. ` +
        `The forwarded header was ignored and the socket peer recorded ` +
        `instead. Something is reaching this backend without passing through ` +
        `the declared proxy: add its address to TRUST_PROXY if it is a proxy ` +
        `of yours, or close the path around the one you declared.`,
    );
  };
}

/**
 * The boot-time line a hop count earns, and the remedy is the whole
 * reason it exists.
 *
 * A count names a position rather than an address, so the proxy rule puts it in the
 * replacing branch: every `/api/auth` request records the hop it arrived from,
 * which behind a real proxy is the proxy, on every request. better-auth keys its
 * rate limiter on that same resolved address, so the throttle stops being
 * per-client and becomes one budget for the whole install — shared by every user
 * at once, and exhaustible from outside by anyone willing to spend a third of a
 * request per second on `/sign-in`.
 *
 * That cost was accepted deliberately rather than fixed in code: resolving the
 * count through Express's own arithmetic is spoof-resistant only if a proxy
 * really is in front, which configuration cannot verify, and refusing the value
 * at boot takes working installs down on upgrade. **So the wording promises
 * neither.** It says what is true now and what the operator can do about it
 * today; it must not announce that hop counts will stop being accepted, because
 * that was weighed and not committed to.
 */
function hopCountWarning(declared: string): string {
  return (
    `TRUST_PROXY is a hop count (${declared}), which names a position in the ` +
    `forwarded chain rather than an address, so no hop can be checked and ` +
    `every /api/auth request records the address it arrived from — behind a ` +
    `proxy, the proxy's, on every request. better-auth keys its sign-in rate ` +
    `limiter on that same address, so its throttle on /sign-in, /sign-up and ` +
    `/change-password is shared by every user at once instead of applied per ` +
    `client. Give the proxy's address or range instead of a count ` +
    `(TRUST_PROXY=10.0.0.0/8), which restores per-client limiting and records ` +
    `the client rather than the hop.`
  );
}
