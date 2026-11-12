import { HttpException } from '@nestjs/common';
import type { Logger } from '@nestjs/common';
import type { CredentialHandle } from '../auth/auth.service';
import { reapedLogNotice } from '../deployments/log-retention';
import { isUnreachableCode } from '../docker-ops/host-reachability';
import type { PermissionCtx } from '../rbac/permission.service';
import type { WsAuthContext } from './ws-auth.guard';
import type { WsClient } from './ws-client';

/**
 * How a socket refuses (ADR-0007, ADR-0008).
 *
 * Every denial on an authorized gateway closes with this one code and this one
 * reason, whatever the caller actually got wrong: not entitled, unknown id,
 * ambiguous resolution. Byte-identical frames are what stop the socket being an
 * enumeration oracle — a caller who can tell "no such deployment" from "not
 * yours" can walk the id space of another organization. The distinction is
 * still recorded, but in the journal, where only an operator sees it.
 *
 * 4000 is deliberately not reused: the validators close with it for a malformed
 * parameter, which is the caller's own bug and safe to be specific about.
 */
export const DENIED_CLOSE_CODE = 4003;
export const DENIED_CLOSE_REASON = 'Not found or not permitted';

/**
 * Whoever a refusal was for.
 *
 * Structural rather than one of the two named types, because a denial can
 * happen either side of the permission context being built: before it exists
 * there is a `WsAuthContext`, after it a `PermissionCtx`, and both answer the
 * only question the journal asks.
 */
export type DenialCaller = {
  user: { id: string };
  session: { activeOrganizationId?: string | null };
};

/**
 * How the journal names the caller. Not sent on the wire, ever.
 *
 * Exported rather than private: `server-access.ts` and
 * `server-terminal.gateway.ts` had each grown a hand-written copy of this
 * interpolation, so `grep 'Refused socket:'` came back in three shapes and one
 * of them — the branch where a serverId did not resolve — came back not at all.
 * One function is what makes the whole journal grep as one thing.
 */
export const callerOf = (caller: DenialCaller): string =>
  `user ${caller.user.id} in organization ${
    caller.session.activeOrganizationId ?? 'none'
  }`;

/**
 * What a refusal can carry for the journal alone: a reason more exact than the
 * message it answers with, which is the one both the wire and an HTTP body
 * see. `findOwnedDeployment` sets it on the 404 for another Organization's
 * Deployment, whose message is the unknown id's on purpose (ADR-0007).
 */
export interface JournalReason {
  journalReason: string;
}

/** The journal's account of a refusal: its {@link JournalReason} when it
 * carries one, else its message. */
export function journalDetailOf(error: unknown): string {
  const { journalReason } = error as Partial<JournalReason>;
  return typeof journalReason === 'string'
    ? journalReason
    : (error as Error).message;
}

/**
 * Refuse the connection, and say why to the journal only.
 *
 * The caller is a parameter rather than something a gateway may remember to
 * interpolate, because a refusal an operator cannot attribute is most of the
 * value of the record gone: the wire frames are deliberately byte-identical
 * across not-entitled, unknown-id and ambiguous-resolution, so this line is the
 * only place the difference — and who hit it — survives (ADR-0008).
 *
 * `realtime/server-access.ts` closes silently with no code for an organization
 * mismatch instead — a defect in its own right, since a
 * codeless close leaves the browser unable to tell a refusal from a dropped
 * connection.
 */
export function denyConnection(
  ws: WsClient,
  logger: Logger,
  caller: DenialCaller,
  detail: string,
): void {
  logger.warn(`Refused socket: ${detail} for ${callerOf(caller)}`);
  ws.close(DENIED_CLOSE_CODE, DENIED_CLOSE_REASON);
}

/**
 * How a socket says the machine was never reached.
 *
 * A 503 does not reach a WebSocket client, so the transport arm
 * `host-reachability.ts` opened one layer up had no spelling here, and both
 * container gateways wrapped `authorizeContainer` in a blanket catch that
 * answered {@link DENIED_CLOSE_REASON}. An unreachable Server's containers were
 * therefore refused with an *authorization* claim about a machine nothing spoke
 * to on the container sockets, exactly as on the container-addressed routes.
 *
 * **This is the carve-out ADR-0008 was amended for, not a hole in its
 * one-close-code rule.** That rule governs the outcome of a resolution that
 * *ran*: not-entitled, unknown container and an ambiguous resolution stay
 * byte-identical on {@link DENIED_CLOSE_CODE}, because a caller who can tell
 * them apart can walk another organization's id space. A transport
 * failure happens before any resolution — no id was looked up and no label was
 * read — so this frame says nothing about whether the container exists or who
 * owns it, for the same reason `GET /settings/runtime-info` answering
 * `observed: null` says nothing about the probe's subject.
 *
 * `4012` is the next free code after `4010` ({@link LEASE_CLOSE_CODE}) and
 * `4011` (`docker-stats.gateway.ts`'s `STATS_CLOSE.workloadGone`), and it
 * belongs in that band rather than in `400x`: like both of those it is not a
 * judgement of the request, and being 4xxx is what stops the console redialling
 * — a redial would only fail to reach the same machine.
 *
 * **There is deliberately no `UNREACHABLE_CLOSE_REASON` beside the code.**
 * `rethrowIfHostUnreachable` already writes the two sentences a caller is told —
 * a Server and the platform host are two different things to be told about
 * (§2.5) — and they reach the wire here as the thrown exception's own message.
 * A third copy of that prose in this file is how the socket comes to say
 * something the HTTP routes have stopped saying, and it buys nothing: the
 * console renders a 4xxx close reason verbatim (`socket-stream-store.ts`), so
 * the sentence an operator reads on a refused socket is already the sentence
 * the Docker tab shows them for the same Server.
 */
export const UNREACHABLE_CLOSE_CODE = 4012;

/**
 * Whether a thrown refusal means *the machine was never reached*, as opposed to
 * *no*.
 *
 * The status **and** the code, not the code alone, and not the exception class:
 * `ServiceUnavailableException` is raised for things that are not this, while
 * `HOST_UNREACHABLE` means one thing on a 503 and nothing at all on any other
 * status — the same test `ApiError.isUnreachableHost` makes in the console, and
 * a getter that accepted any status would be one wire change away from
 * describing a different refusal. Not a message match, for the reason
 * `HOST_UNREACHABLE_CODE`'s own docblock gives.
 *
 * **Either arm, and the union is the whole of what that split cost this
 * file.** It split the platform host onto a code of its own, because one code
 * with two messages made the console say *"check that its SSH key still works"*
 * about a machine with no Server row. A socket wants the difference in neither
 * the code nor the reason — {@link UNREACHABLE_CLOSE_CODE}'s docblock is why
 * there is no `UNREACHABLE_CLOSE_REASON`, and the exception's own message
 * already carries whichever of the two sentences applies — so what this guard
 * asks is the arm-free question, through `isUnreachableCode` rather than a
 * second comparison written out here. Asking for `HOST_UNREACHABLE` alone was
 * how the platform arm went straight back to `4003 Not found or not permitted`
 * on the container sockets the moment the second code existed: a container on
 * the platform host takes exactly this path, and
 * `container-socket-unreachable.spec.ts`'s *"names the platform host when the
 * target is on it"* is what caught it.
 */
export function isHostUnreachable(error: unknown): error is HttpException {
  if (!(error instanceof HttpException) || error.getStatus() !== 503) {
    return false;
  }
  const body: unknown = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    isUnreachableCode((body as { code?: unknown }).code)
  );
}

/**
 * Close because the machine was never reached, or do nothing and let the
 * caller's own denial stand. Answers whether it acted.
 *
 * A guard rather than a second `deny…` function, so a gateway's catch reads the
 * way `rethrowIfHostUnreachable`'s callers read — the transport arm first, then
 * whatever swallow was already there. One function that chose between the two
 * would have to be handed the denial's `detail` as well, and that detail is the
 * one thing that must never reach the wire.
 *
 * **Two journal lines for one failure is the pattern here rather than an
 * oversight.** `rethrowIfHostUnreachable` has already written the host's own
 * words one layer down — an SSH error, which §2.5 keeps off the wire — and this
 * line adds the only fact that layer cannot know: which caller was on which
 * socket. It is the same split {@link denyConnection} has with the gate's own
 * `Refused container:` line, which `container-sockets.e2e-spec.ts` reads in
 * exactly those two halves. The verb is its own so the counts stay apart:
 * `Refused socket:` remains the number of callers who were denied
 * something, and none of these was.
 */
export function closeIfHostUnreachable(
  ws: WsClient,
  logger: Logger,
  caller: DenialCaller,
  subject: string,
  error: unknown,
): boolean {
  if (!isHostUnreachable(error)) return false;
  logger.warn(`Unreachable socket: ${subject} for ${callerOf(caller)}`);
  // The exception's own message, which is one of `rethrowIfHostUnreachable`'s
  // two sentences and so well inside the 123 bytes a close frame carries.
  ws.close(UNREACHABLE_CLOSE_CODE, error.message);
  return true;
}

/**
 * The most a close frame's reason can carry.
 *
 * RFC 6455 §5.5 caps a control frame's payload at 125 bytes and the close code
 * spends the first two of them, so the reason is 123 **bytes** — not
 * characters. `ws` does not truncate an over-long one: `Sender.close` throws
 * `RangeError: The message must not be greater than 123 bytes`, synchronously,
 * inside whatever `handleConnection` was doing. So a gateway that hands a long
 * sentence to `ws.close` says *less* than one that says nothing — the throw
 * escapes the handler and the caller gets the bare, codeless close an
 * unauthenticated caller gets.
 *
 * `closeIfHostUnreachable` states this figure in a comment and gets away with
 * asserting its sentence is "well inside" it; {@link reapedLogCloseReason} does
 * not, which is why the number is a constant now rather than prose.
 */
export const CLOSE_REASON_BYTE_LIMIT = 123;

/** The one character an elided reason ends on. Three bytes of the budget. */
const ELLIPSIS = '…';

/**
 * One sentence, made into something `ws.close` will accept.
 *
 * **A helper rather than a rule to remember, for {@link sendIfOpen}'s reason.**
 * Nothing in the compiler notices a reason that is 124 bytes long, a real `ws`
 * turns it into a throw rather than a bad frame, and the sentence a gateway
 * closes with is usually somebody else's — an exception's message, a notice a
 * route already answers with — so its length is not a fact the call site knows.
 * Every gateway sentence that is not a literal in this file should come through
 * here.
 *
 * **Bytes, not characters**, because the cap is on the frame's payload: 123
 * `é`s are 246 bytes and would throw, and `String.length` cannot see it.
 *
 * **Elided at a word boundary, and only when it has to be.** A sentence that
 * fits is returned byte-identical, so this changes nothing for the reasons
 * already on the wire — it is not a formatter. Where it does cut, it cuts at
 * the last space that fits and drops the punctuation left dangling, because a
 * reason ending `for 90 days and this,…` reads as a bug. A single word longer
 * than the budget has no boundary to find and is cut where the budget ends,
 * which is the honest thing to do with a value that was never a sentence.
 *
 * Trimmed first: a notice written for `text/plain` ends in a newline
 * ({@link reapedLogNotice}), and a close reason is a sentence rather than a
 * line.
 */
export function closeFrameReason(sentence: string): string {
  const trimmed = sentence.trim();
  if (Buffer.byteLength(trimmed, 'utf8') <= CLOSE_REASON_BYTE_LIMIT) {
    return trimmed;
  }
  const budget = CLOSE_REASON_BYTE_LIMIT - Buffer.byteLength(ELLIPSIS, 'utf8');
  let end = trimmed.length;
  while (end > 0 && Buffer.byteLength(trimmed.slice(0, end), 'utf8') > budget) {
    end -= 1;
  }
  const boundary = trimmed.lastIndexOf(' ', end);
  const kept =
    boundary > 0 ? trimmed.slice(0, boundary) : trimmed.slice(0, end);
  return `${kept.replace(/[\s,;:.]+$/, '')}${ELLIPSIS}`;
}

/**
 * How the log socket says a Deployment's log was reaped rather than never
 * written (ADR-0020).
 *
 * **The disagreement this ends.** ADR-0020 keeps a deployment log for
 * `DEPLOYMENT_LOG_RETENTION_DAYS` and made `GET /deployments/:id/logs` answer
 * {@link reapedLogNotice} past the window, because `readLogs` ends its command
 * `|| echo ""` and so cannot tell a reaped log from a build that has not
 * written anything yet. `/listen-deployment` follows the *same* `logPath` per
 * ADR-0007 and answered neither: `tail -n +1 -f` on a file that is not there
 * emits one stderr line and then follows nothing for ever, so the socket
 * delivered no explanation and no end. Two readers of one artifact disagreeing
 * about whether its absence is explicable is the defect; ADR-0020's last bullet
 * recorded it as filed rather than fixed.
 *
 * **A close, and deliberately not a frame — this is the framing decision.** A
 * socket's contract here is a stream of the build's own bytes, and the console
 * appends every string frame it receives into the log well
 * (`socket-stream-store.ts`'s `append`). So a notice sent as a frame is
 * rendered *as though the build had printed it*, and no envelope can rescue it:
 * `terminal-protocol.ts` already refuses a server→browser envelope on exactly
 * the ground that applies here too — a program is free to print any byte at
 * all, the reserved one included, so a frame the console must treat specially
 * is a frame a build can forge. A 4xxx close instead lands on the console's
 * *refusal* surface rather than in the well, and stops the redial that would
 * otherwise re-ask a question whose answer cannot change.
 *
 * **`4013`, in the band that is not a judgement of the request.** After `4010`
 * ({@link LEASE_CLOSE_CODE}), `4011` (`docker-stats.gateway.ts`'s
 * `STATS_CLOSE.workloadGone`) and `4012` ({@link UNREACHABLE_CLOSE_CODE}).
 * `workloadGone` is the near sibling — a socket with nothing to stream because
 * its subject is gone — and this is deliberately not it: that constant carries
 * a container sentence and belongs to a gateway whose subject is a container.
 * Not `400x`, which are the caller's own bug, and emphatically not
 * {@link DENIED_CLOSE_CODE}: this caller *is* entitled to the Deployment, the
 * row resolved, and the enumeration-oracle argument does not bind on an answer
 * that names no id and is the same for every Deployment past the window.
 *
 * **The sentence is `reapedLogNotice`'s, elided rather than rewritten.** The
 * notice is **149 bytes** and a close frame's reason carries
 * {@link CLOSE_REASON_BYTE_LIMIT}, so verbatim reuse is not available and that
 * is a measurement rather than a preference — `reaped-log-close.spec.ts` pins
 * both halves so a shorter notice one day stops being elided on its own. What
 * was rejected is a second sentence written beside this code, which is exactly
 * what {@link UNREACHABLE_CLOSE_CODE}'s docblock argues against and for the
 * same reason: the operator reading a refused socket should be reading the
 * sentence the HTTP route already shows them, and a second copy of a window
 * rule is the failure ADR-0020 exists to avoid. The elision keeps the clause
 * that names the window, which is the half of the sentence not discoverable
 * from any route.
 */
export const REAPED_LOG_CLOSE_CODE = 4013;

/** @see REAPED_LOG_CLOSE_CODE */
export const reapedLogCloseReason = (): string =>
  closeFrameReason(reapedLogNotice());

/**
 * The permission context a socket's caller acts in, or a denial when the
 * session carries no active organization — every entitlement check is
 * organization scoped, so there is nothing to authorize against, and the answer
 * is a refusal rather than an unscoped read.
 *
 * Returns null *having already closed the socket*, so a gateway's whole
 * handling is `const ctx = await ...; if (!ctx) return;`. Four gateways open
 * this way and the check is the thing that must not be forgotten in a fifth.
 */
export function permissionCtxOrDeny(
  ws: WsClient,
  logger: Logger,
  auth: WsAuthContext,
): PermissionCtx | null {
  const organizationId = auth.session.activeOrganizationId;
  if (!organizationId) {
    denyConnection(ws, logger, auth, 'no active organization on the session');
    return null;
  }
  return {
    user: { id: auth.user.id },
    session: { activeOrganizationId: organizationId },
  };
}

/**
 * Run an authorization and report whether it passed, turning every way it can
 * refuse into the one close frame above.
 *
 * The gateways differ only in what they authorize — a deployment, a container,
 * an appName — so the throw-to-close-frame hop is here rather than copied into
 * each of them. `subject` names what was refused for the journal; it never
 * reaches the wire.
 *
 * **Every way it can *refuse*, which is not every way it can throw.**
 * A target on a machine that was never reached is not a refusal, and the
 * transport arm is taken out of the swallow here rather than only in the two
 * gateways that catch `authorizeContainer` themselves. That branch reaches
 * nothing today — the one caller is `/listen-docker-stats-monitoring`, which is
 * local-host only and resolves through the daemon client rather than the
 * remote-execution layer, so it raises no `ExecError` — and it is here anyway
 * because this function's contract is *"turn every way this can refuse into one
 * close frame"*, and leaving that contract false is how the third container
 * socket regains the defect the day it grows a `serverId`. The docblock over
 * {@link armAuthorizationLease} makes the same call for the same reason: what
 * stops a seventh gateway forgetting cannot be a convention.
 */
export async function authorizedOrDeny(
  ws: WsClient,
  logger: Logger,
  caller: DenialCaller,
  subject: string,
  authorize: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await authorize();
    return true;
  } catch (error) {
    if (closeIfHostUnreachable(ws, logger, caller, subject, error)) {
      return false;
    }
    denyConnection(
      ws,
      logger,
      caller,
      `${subject}: ${(error as Error).message}`,
    );
    return false;
  }
}

/**
 * Write to a socket if there is still a socket to write to (§2.10).
 *
 * The rule was already the rule and was already written down; what was missing
 * was one place to keep it. Sixteen of the twenty-six sends in
 * `src/realtime/gateways/` did not check, in every shape the omission takes: a
 * one-line `channel.onData((data) => ws.send(data))` passthrough, an error frame
 * written just before a close, a 5,000-chunk buffer replayed into whoever
 * attached. Nothing in the compiler notices any of them, and a `readyState`
 * check written twenty-six times is a check a twenty-seventh send does not get.
 *
 * It became urgent rather than tidy with the keep-alive: `terminate()`
 * can now end a socket on any tick, from a timer no gateway is looking at, so
 * every one of those sends acquired a way to fire against a dead peer that it
 * did not have before. A real `ws` does not throw for this — it hands the error
 * to a callback, or emits `'error'` on the socket when there is none — so an
 * unguarded send is silent in production and invisible in a test, which is
 * exactly why the guard has to be structural instead of remembered.
 *
 * Returns whether the frame went out, for the callers that then decide whether
 * to close. **No gateway calls `ws.send` directly any more, and that is an
 * invariant a test asserts** by reading the gateways directory: a text rule is
 * enforceable where "did you remember the check" is not.
 */
export function sendIfOpen(ws: WsClient, data: string): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  ws.send(data);
  return true;
}

/**
 * How a lease ends (ADR-0012).
 *
 * Deliberately not `DENIED_CLOSE_CODE`. That frame is byte-identical across
 * every connect-time refusal so a caller cannot tell "no such deployment" from
 * "not yours" and walk another organization's id space; the argument does not
 * bind here, because this caller already connected, already passed and already
 * received frames, so the id is one they were legitimately handed and there is
 * nothing left to enumerate — the carve-out ADR-0010 made for `local`. Reusing
 * 4003 would also lie about the tense, showing "Not found or not permitted" to
 * someone who watched a stream work for an hour, which reads as a bug rather
 * than a change in their access.
 *
 * The code sits outside both existing bands: not `400x`, which are connect-time,
 * and not `server-terminal`'s `44xx` HTTP-offset band, because no HTTP status
 * means this — 401 and 403 both describe a request being judged, and this is a
 * grant withdrawn from something already running. Being in the 4xxx range is
 * what makes the console stop retrying, which is right: a redial would only be
 * refused at connect.
 */
export const LEASE_CLOSE_CODE = 4010;
export const LEASE_CLOSE_REASON = 'No longer authorized';

/**
 * How often a lease is renewed, and how long one lasts.
 *
 * **Neither number is operator configuration.** An environment variable here
 * would be a knob whose only interesting setting is "longer", and an operator
 * who set it to an hour would have silently reverted ADR-0012 on a live
 * install. They are constants, exported so tests can import them, and the
 * interval reaches the gateways through {@link LEASE_RENEWAL_INTERVAL} — a DI
 * token that defaults to this value and is overridden only by a test module.
 *
 * 30 seconds because the keep-alive ping is 45: {@link armKeepAlive} arms that
 * ping expressly to defeat proxy idle timeouts, which is the mechanism that
 * makes this exposure indefinite rather than theoretical. Renewing below it
 * means the check that ends a stale socket always runs at least once between
 * the pings that keep it alive, so the two are ordered rather than racing. Cost
 * is not the constraint: at 50 concurrent sockets this is under one indexed
 * read per second, against a stats gateway already spawning a `docker stats`
 * subprocess every 1300ms per socket.
 *
 * The *duration* is the promise, not the interval — no socket sends a frame
 * more than one lease past the last authorization that actually succeeded — and
 * it is four consecutive failed renewals: long enough to ride out a pool blip
 * or a failover, short enough that a real outage does not leave sockets running
 * unverified into a second coffee break. Derived rather than written twice so
 * the test module's shorter interval scales the duration with it instead of
 * leaving a spec waiting two real minutes for an expiry.
 */
export const LEASE_RENEWAL_INTERVAL_MS = 30_000;
const RENEWAL_FAILURES_TOLERATED = 4;
export const leaseDurationMs = (renewalIntervalMs: number): number =>
  renewalIntervalMs * RENEWAL_FAILURES_TOLERATED;

/** The renewal interval, injected so the test module can shorten it. */
export const LEASE_RENEWAL_INTERVAL = Symbol('LEASE_RENEWAL_INTERVAL');

/**
 * Whoever a lease is held for: the journal's caller, plus the handle it re-reads
 * the credential by.
 *
 * Structural for the same reason {@link DenialCaller} is — a `WsAuthContext`
 * satisfies it, and a spec can hand over three fields instead of a whole
 * better-auth session.
 */
export type LeaseCaller = DenialCaller & {
  credential: CredentialHandle;
};

/**
 * The one thing a lease needs of `WsAuthGuard`: whether the credential is still
 * alive. Taken structurally so the lifecycle can be specified without a
 * database, and so this file does not import the guard — which imports the
 * auth stack, and would be a cycle.
 *
 * It used to say "so `socket-access.ts` keeps importing no values", which has
 * not been true since `HttpException` came in; later fixes added
 * `isUnreachableCode` beside it. The structural typing is still worth having
 * for the two reasons above, which are the ones that survived.
 */
export interface SocketCredentials {
  assertStillAuthenticated(caller: LeaseCaller): Promise<void>;
}

/** What arming a lease needs. */
export interface AuthorizationLease {
  ws: WsClient;
  logger: Logger;
  /** Who holds it, and the handle its credential is re-read by. */
  caller: LeaseCaller;
  /** What was authorized, for the journal. Never reaches the wire. */
  subject: string;
  renewalIntervalMs: number;
  credentials: SocketCredentials;
  /**
   * The same authorization the connection handler ran. Re-run whole rather than
   * consulted against a list of revocation vectors: a session revoked, a Member
   * removed, a role changed, an `accessedServices` edit, a custom role's grants
   * edited, a lapsed license, a Service deleted or moved are all inputs to this
   * one computation, and re-running it covers them by construction. An
   * enumerated list would only ever be correct about the vectors that existed
   * the day it was written — two of the ten arrived after the gateways did.
   */
  authorize: () => Promise<unknown>;
}

/**
 * Give an authorized socket a lease over its own authorization (ADR-0012).
 *
 * Every gateway used to authorize once, in its connection handler, and never
 * again — so a Member whose entitlement was withdrawn, or who was removed from
 * the Organization outright, kept receiving frames on every stream they had
 * already opened, indefinitely, and an attacker who anticipated losing access
 * could open sockets across many services first and keep them.
 *
 * A socket is a standing subscription rather than a long-lived request: a frame
 * may only be sent to a caller entitled at the moment it is sent, not at the
 * moment the socket opened. So the authorization is re-run on a clock, and the
 * socket closes when the lease ends.
 *
 * **A refused renewal ends the lease; a failed one does not.** An
 * `HttpException` is the system answering "no" and closes the socket at once;
 * anything else is the system failing to *answer*, and is logged while the lease
 * keeps running until it expires — the split ADR-0005 already draws. Failing
 * closed on infrastructure errors is the tempting reading and it is wrong on its
 * own terms: it cannot tell the attacker's socket from the operator's, so it
 * drops every terminal in the instance mid-command on a two-second Postgres
 * hiccup, and it does not even hold the line, because the attacker redials into
 * a `handleConnection` that fails closed against the same broken database. The
 * lease duration is what stops that becoming an unbounded hole during a real
 * outage.
 *
 * Each gateway arms its own, once, after its own connect-time check has passed;
 * folding this into {@link authorizedOrDeny} would have bought three gateways a
 * lease with a zero-line diff and overwritten close-code decisions that have
 * their own ADR for the other three. A type cannot express "call this
 * function", so what stops a seventh gateway forgetting is a test that
 * enumerates `src/realtime/gateways/`.
 *
 * Note this deliberately does *not* inherit `authorizedOrDeny`'s
 * catch-everything behaviour: the two treat the same thrown error differently,
 * on purpose.
 */
export function armAuthorizationLease(lease: AuthorizationLease): void {
  const { ws, logger, caller, subject, credentials, authorize } = lease;
  const durationMs = leaseDurationMs(lease.renewalIntervalMs);
  let lastSuccess = Date.now();
  let renewing = false;

  const timer = setInterval(() => void renew(), lease.renewalIntervalMs);
  // Unref'd like every other interval in the module: a lease must not be the
  // reason the process refuses to exit.
  timer.unref?.();
  ws.on('close', () => clearInterval(timer));

  /** End the lease, saying one thing on the wire and the cause to the journal. */
  function end(detail: string): void {
    clearInterval(timer);
    logger.warn(`Lease ended: ${subject}: ${detail} for ${callerOf(caller)}`);
    if (ws.readyState === ws.OPEN) {
      ws.close(LEASE_CLOSE_CODE, LEASE_CLOSE_REASON);
    }
  }

  async function renew(): Promise<void> {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(timer);
      return;
    }
    // Expiry first: before the attempt, so a lease whose renewals have been
    // failing ends on the tick it runs out rather than the one after — and
    // before the single-flight guard below, because a renewal that never
    // *settles* is the case that guard would otherwise hold the lease open
    // through. A query hung on an exhausted pool with no statement timeout
    // would leave `renewing` true for as long as it hangs and send every later
    // tick home, so the socket would stream unauthorized for the length of the
    // hang — the stream-after-revoke defect again, with a hang as the trigger
    // instead of time.
    if (Date.now() - lastSuccess >= durationMs) {
      end(`no renewal has succeeded for ${durationMs}ms`);
      return;
    }
    // One renewal at a time. A database slow enough to span a tick would
    // otherwise queue a second renewal behind the first, multiplying the cost
    // of an outage by how long it lasts.
    if (renewing) return;
    renewing = true;
    try {
      // The credential first, by id: its absence is revocation. Asking about
      // entitlement for a caller whose session is gone would be asking about
      // somebody who is no longer there.
      await credentials.assertStillAuthenticated(caller);
      await authorize();
      lastSuccess = Date.now();
    } catch (error) {
      if (error instanceof HttpException) {
        end(journalDetailOf(error));
        return;
      }
      logger.warn(
        `Lease renewal failed: ${subject}: ${(error as Error).message} for ${callerOf(
          caller,
        )} — the lease stands until it expires`,
      );
    } finally {
      renewing = false;
    }
  }
}

/**
 * How often a socket is pinged, and therefore how long a vanished peer survives.
 *
 * 45 seconds is inherited rather than chosen: `container-logs` and
 * `server-setup` each hand-rolled this exact interval to defeat proxy idle
 * timeouts, and ADR-0012 picked the 30-second lease renewal *against* it so a
 * renewal always runs at least once between two pings. Generalising the ping to
 * all six gateways only strengthens that ordering, so the number stays. Death is
 * declared on one missed pong, which is deliberately generous: the failure mode
 * to fear is a live-but-slow peer being killed mid-build, and one interval of
 * grace costs a vanished peer at most 90 seconds of sampling.
 *
 * Not operator configuration, for the same reason the lease's numbers are not.
 */
export const KEEP_ALIVE_INTERVAL_MS = 45_000;

/** What arming a keep-alive needs. */
export interface KeepAlive {
  ws: WsClient;
  logger: Logger;
  /** Who the socket was open for, for the journal. Never reaches the wire. */
  caller: DenialCaller;
  /**
   * What the socket was following, for the journal — the same string the
   * gateway hands its lease. Never reaches the wire.
   */
  subject: string;
  /**
   * Defaults to {@link KEEP_ALIVE_INTERVAL_MS}. Overridden only by a spec that
   * owns the clock — there is no DI token here because no gateway wants a
   * different number, and the lease's token exists to be shortened in tests
   * rather than to be configured.
   */
  intervalMs?: number;
}

/**
 * Ping the peer, and drop the socket when it stops answering.
 *
 * Nothing in this module could tell a live peer from a vanished one. A peer that
 * goes away without a close frame reaching the server — a `1006`, a proxy that
 * drops the browser leg while holding the upstream one, a sleeping laptop —
 * leaves the socket `OPEN` for `ws` indefinitely, and every timer hung off it
 * keeps firing: a stats socket kept spawning a `docker stats` subprocess every
 * 1300ms for nine minutes after its tab was closed with zero TCP connections to
 * the port, and what finally reaped it was a lease renewal being refused rather
 * than any teardown. The two pings that already existed were write-only —
 * nothing checked whether an answer came back — so they made the problem worse
 * rather than better, holding sockets open past the idle timeout that would
 * otherwise have ended them.
 *
 * This is here beside {@link armAuthorizationLease} rather than in the gateway
 * that paid for it because "is the peer still there" is not a stats question,
 * and because the ping and the decision that the peer is gone have to be the
 * same mechanism — two of them, armed in different files, is how one ends up
 * keeping alive a socket the other has given up on.
 *
 * `terminate()` rather than `close()`: the peer is presumed unable to answer a
 * close handshake, which is the whole reason it is being dropped. It emits
 * `'close'`, and `'close'` is already the single teardown point every gateway
 * hangs off — the stats sampler, the lease timer, the pty and SSH channel
 * closes — so one hook ends everything and adds no second teardown path to keep
 * in sync.
 *
 * The reap writes one journal line and the other two exits write none.
 * A `readyState` that is no longer `OPEN` and the `'close'` listener are a
 * socket that ended some other way — a tab closed, a lease ended, a gateway
 * closing it — each of which already has its own line or is deliberately
 * unremarkable, and a line on either would fill `grep -c 'Reaped socket:'` with
 * routine tab closes. That count is the whole point: it is how an operator sees
 * a proxy dropping browser legs, which is the failure
 * {@link KEEP_ALIVE_INTERVAL_MS} describes, and it is only a count because the
 * verb is its own — `Refused socket:` stays the number of connect-time denials.
 */
export function armKeepAlive({
  ws,
  logger,
  caller,
  subject,
  intervalMs = KEEP_ALIVE_INTERVAL_MS,
}: KeepAlive): void {
  // Answered, until a tick goes by without one. Set from the pong listener
  // rather than read off the socket because `ws` exposes no such flag.
  let answered = true;
  ws.on('pong', () => {
    answered = true;
  });

  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(timer);
      return;
    }
    if (!answered) {
      // Cleared before terminating, not after: `terminate()` emits `'close'`
      // synchronously on a real socket, and a listener that has already run
      // cannot clear a timer this tick is still inside.
      clearInterval(timer);
      // Before the terminate, for the same reason `end()` logs before it
      // closes: an operator cannot otherwise tell a peer that vanished and was
      // reaped from a client that closed cleanly, and the *count* of these is
      // what says a proxy is dropping browser legs. `Reaped` rather than
      // `Refused` because nobody was denied anything — the verb is what makes
      // the two countable apart.
      //
      // `no pong within ${intervalMs}ms` and not the 2× bound: the elapsed
      // silence is between one and two intervals — a ping goes out on one tick
      // and the next tick gives up — so `intervalMs` is the window that
      // actually passed unanswered, and a line claiming the worst case would be
      // wrong about most reaps.
      logger.warn(
        `Reaped socket: ${subject}: no pong within ${intervalMs}ms for ${callerOf(
          caller,
        )}`,
      );
      ws.terminate();
      return;
    }
    answered = false;
    ws.ping();
  }, intervalMs);
  // Unref'd like every other interval in the module: a keep-alive must not be
  // the reason the process refuses to exit.
  timer.unref?.();
  ws.on('close', () => clearInterval(timer));
}
