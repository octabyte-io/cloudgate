import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ExecError } from '../remote/exec-error';

/**
 * The name a caller branches on for "**this Server** was never reached"
 * (X11-4, narrowed to the Server arm).
 *
 * `ErrorResponseBody.code` exists for exactly this — *"a machine-readable name
 * for which refusal this is, when the status alone does not say"* — and the
 * status alone does not say here: `errorMessage()` in the console has one
 * sentence for 502/503/504, *"The backend is not answering"*, which is a
 * confident claim about the wrong machine. The same misattribution H-26 fixed
 * for the ban, one status family over.
 *
 * Not a message match. `auth-error.ts` records a ticket as having been filed to
 * delete exactly that, and the two sentences below are §2.5 strings written for
 * whoever reads the journal, so they are allowed to change.
 */
export const HOST_UNREACHABLE_CODE = 'HOST_UNREACHABLE';

/**
 * The same fact about the **platform host** — the daemon this instance runs on
 * itself, which is what an absent `serverId` addresses (ADR-0008).
 *
 * ## Why a second code rather than one code and two messages
 *
 * X11-4 published one code for both arms and told them apart only in the
 * `message` below, so the console — which branches on the code, and is
 * forbidden from branching on the prose — rendered the *Server* sentence for a
 * platform-host failure: *"Cloudgate could not reach that Server … check that
 * its SSH key still works"*, naming a machine that is not involved and a
 * credential that is not used. `LiveCard` reaches it by construction, calling
 * `dockerApi.containers(null)`. That is H-26's defect and X11-4's own defect
 * one turn further in: **a refusal the backend went to the trouble of naming
 * must not be given the words of a different refusal**, and two subjects with
 * two sentences are two refusals.
 *
 * ## Rejected: `serverId` on the error body
 *
 * It carries more information than a name does, and it does not reach the wire:
 * `AllExceptionsFilter.describe` copies `message`, `code` and `details` off the
 * object form of an `HttpException` response and nothing else, so an extra
 * field is dropped silently — the console would branch on a value that is never
 * sent. Making it reach the wire means widening `ErrorResponseBody`, whose own
 * docblock rejects growing a field per refusal (*"`details` set the precedent
 * for a field that appears only where a specific answer needs it"*), and
 * putting a resource id on every error body to answer one question a name
 * answers. Nothing else on this contract echoes an id, and the console needs
 * the *subject*, not the identifier: no screen renders the id back.
 *
 * ## Rejected: sniffing `?serverId=` out of `ApiError.path`
 *
 * `path` is `request.url`, which the filter attaches for the console's own use.
 * Re-deriving from a URL string a fact the backend already knows is the shape
 * this module forbids one paragraph up — and it is wrong on the routes that
 * take `serverId` in a body or a multipart field rather than a query string.
 *
 * The code strings differ by more than a prefix on purpose: a reader grepping
 * `HOST_UNREACHABLE` finds both, which is what {@link isUnreachableCode} is
 * for, and no substring test can mistake one arm for the other.
 */
export const PLATFORM_HOST_UNREACHABLE_CODE = 'PLATFORM_HOST_UNREACHABLE';

/**
 * Whether a published `code` is either arm of *never reached*.
 *
 * One predicate rather than two comparisons at each site, because the sites
 * that want *either* and the sites that want *one* are both real and are easy
 * to confuse: `socket-access.ts`'s `isHostUnreachable` wants either — a socket
 * closes the same way whichever machine was not reached, since its
 * wire reason is the exception's own message — while `errorMessage()` in the
 * console wants each arm apart, because the whole point of the second code is
 * two sentences. Widening the socket guard by hand was the way the platform arm
 * silently went back to `4003 Not found or not permitted`.
 */
export function isUnreachableCode(code: unknown): boolean {
  return (
    code === HOST_UNREACHABLE_CODE || code === PLATFORM_HOST_UNREACHABLE_CODE
  );
}

/**
 * Whether an exec failure means the command **never ran**, as opposed to having
 * run and exited nonzero.
 *
 * `ExecError.exitCode` is the whole test, and it is a real signal rather than a
 * convenient one: `RemoteExecService` sets it from the SSH channel's own
 * `close` code and from `child_process`'s, so it is present exactly when a
 * process reported a status. It is absent for every failure that happened
 * *before* a process existed — `SSH connection error: …` and
 * `Authentication failed: …` off the `ssh2` client's `'error'` event, a missing
 * `ServerKeyProvider`, a `conn.exec` refusal, and locally the `'error'` event
 * `execFile` raises when the program cannot be spawned at all.
 *
 * **A rejection that is not an `ExecError` reads as "not a transport failure",
 * and the direction is deliberate.** It did not come from the exec layer, so it
 * says nothing about the transport, and inferring *not reached* from it would be
 * the same guess this fix exists to remove — `runtime-info.service.ts` makes the
 * same call for `drift`, which is false whenever either side is unknown rather
 * than assumed. The consequence of guessing wrong here is a route claiming a
 * host is unreachable when it answered, which is the mirror of X11-4 and no
 * better.
 *
 * This is also why a docker that ran and failed is safe: it exits nonzero and
 * carries the code — so `getContainersByOwnerLabel` keeps answering `[]` for
 * it, which is true (`test/docker-ops/docker-ops.e2e-spec.ts` pins that
 * behaviour).
 */
export function isTransportFailure(error: unknown): error is ExecError {
  return error instanceof ExecError && typeof error.exitCode !== 'number';
}

/**
 * The `ssh2` error levels that mean the connection never carried a request:
 * refused, timed out, DNS, or the key not accepted.
 */
const SSH_CLIENT_FAILURE_LEVELS = new Set([
  'client-socket',
  'client-timeout',
  'client-dns',
  'client-authentication',
]);

/** Socket error codes that mean the daemon was never reached. */
const SOCKET_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENOENT',
]);

/**
 * The same question as {@link isTransportFailure}, asked of a **dockerode**
 * rejection rather than an exec one.
 *
 * `ClusterService`'s join commands talk to the daemon through dockerode, not
 * `RemoteExecService`, so an SSH handshake timeout arrives as `ssh2`'s own
 * error — `Timed out while waiting for handshake`, `level: 'client-timeout'` —
 * passed through `docker-modem` untouched. It is not an `ExecError`, so
 * {@link isTransportFailure} reads it as "ran", and `GET /cluster/add-worker`
 * answered 500 for a Server that was simply not reached.
 *
 * **A daemon that answered carries `statusCode`**: `docker-modem` builds that
 * error from the HTTP response, and it is the one shape here that means the
 * request arrived. So it is excluded first, and the rest is recognised only by
 * `ssh2`'s `level` or a socket `code` — never by message. Anything else keeps
 * reading as "not a transport failure", the direction `isTransportFailure`
 * argues for.
 */
export function isDockerClientTransportFailure(error: unknown): error is Error {
  if (!(error instanceof Error) || error instanceof ExecError) return false;
  const shape = error as Error & {
    statusCode?: unknown;
    level?: unknown;
    code?: unknown;
  };
  if (typeof shape.statusCode === 'number') return false;
  return (
    (typeof shape.level === 'string' &&
      SSH_CLIENT_FAILURE_LEVELS.has(shape.level)) ||
    (typeof shape.code === 'string' && SOCKET_FAILURE_CODES.has(shape.code))
  );
}

/**
 * Turn a transport failure into a refusal that says *not reached*, and let
 * everything else fall through to whatever swallow the caller already had.
 *
 * ## Why this exists at all
 *
 * Every reader in this module ends in a catch that answers `[]` or `undefined`,
 * so **a Server that cannot be reached was indistinguishable from a Server with
 * nothing running on it** — `GET /docker/containers?serverId=…` answered
 * `200 []` in 28 ms against a host at `127.0.0.1:1`, and the console's Docker
 * tab said *"Docker answered and there are no containers on this host"* to an
 * operator whose containers were merely unreachable. The failure was recorded
 * at `level:50` and then discarded.
 *
 * The shape is the runtime card's, one card to the left: `GET /settings/runtime-info`
 * answers `observed: null` plus a `reason` per probe rather than a confident
 * reading, *"because a Server whose every shell probe timed out still answered a
 * confident `postgres.observed` — a positive signal pointing at the wrong
 * machine, which is worse than a missing one"* (`runtime-info.service.ts`). This
 * is the same rule; only the channel differs, because these routes answer bare
 * arrays that other callers parse and a `Probe`-shaped envelope would break
 * every one of them.
 *
 * **The shape is old and has been read past.** This run's own fix loop edited
 * `docker-ops.service.ts` three times (H-74, H-75, H-80) without either agent
 * seeing it — which is why the argument is written here rather than left as an
 * obvious catch to notice.
 *
 * ## Why a 503 rather than a field on the payload
 *
 * Four routes here answer `T[]`, one answers `T[] | undefined`, and the console
 * reads five of them through `lib/api/endpoints/docker.ts` while the monitoring
 * feature reads a sixth. An envelope would change every one; a union body
 * (`T[] | { reason }`) would break the `?? null` and `.map` the existing callers
 * are written as, silently. The status is the one channel that adds a state
 * without touching the success shape.
 *
 * `503` and not `502`: nothing upstream answered badly — a bad gateway's claim —
 * the dependency simply could not be reached, and it may be reachable on the
 * next attempt. And not a 4xx: the request was well-formed and authorized, and
 * nothing the caller can change makes it succeed.
 *
 * ## What goes on the wire, and what stays in the journal
 *
 * The wire gets the fact and the code; the journal gets the host's own words.
 * That is ADR-0008's split — the wire says one thing, the journal attributes it
 * — and it is what the console already does with `runtime-info`'s `reason`,
 * which `IngressRow` keeps off screen. §2.5 also governs the message: an
 * `HttpException`'s message is never an internal detail, which an SSH error is.
 */
export function rethrowIfHostUnreachable(
  logger: Logger,
  serverId: string | null | undefined,
  error: unknown,
): void {
  if (!isTransportFailure(error) && !isDockerClientTransportFailure(error)) {
    return;
  }

  logger.warn(
    `${serverId ? `Server ${serverId}` : 'The platform host'} was not reached: ${error.message}`,
  );
  throw new ServiceUnavailableException({
    // Names the entity, per §2.5 — a Server and the platform host are two
    // different things to be told about, and ADR-0008 makes an absent
    // `serverId` the second one.
    message: serverId
      ? 'This Server could not be reached'
      : 'The platform host could not be reached',
    // **And two codes.** One code with two messages made the
    // difference readable only by matching the prose, which this module
    // forbids, so the console branched on the code alone and said the Server
    // sentence about the platform host. The subject is the branch; the
    // sentences stay §2.5 strings that may be reworded.
    code: serverId ? HOST_UNREACHABLE_CODE : PLATFORM_HOST_UNREACHABLE_CODE,
  });
}
