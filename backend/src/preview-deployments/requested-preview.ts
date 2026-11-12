import type { SourceType } from '../git-providers/git-provider.schema';
import { isBranchedSource } from '../git-providers/source-branch';
import type { PreviewTrigger } from './preview-deployment.schema';

/**
 * The words and rules of a Requested preview that need no database
 * (ADR-0026). The order they are applied in is
 * `PreviewDeploymentsService.admitRequestedCreate`'s, which is the refusal chain.
 */

/** A request that names no TTL gets this many minutes. A constant, not a setting. */
export const REQUESTED_PREVIEW_DEFAULT_TTL_MINUTES = 60;

/**
 * The `code` each Requested-preview refusal carries in its response body,
 * beside its sentence, the opt-in field `all-exceptions.filter.ts`
 * publishes. HTTP still answers the sentence; the MCP tools need the code,
 * because a tool's error table matches an exception by its class and `code`,
 * never by its message (ADR-0024) — and the switch, the cap and an expired
 * preview are all `409`s, as the source-type, TTL and address refusals are
 * all `400`s.
 */
export const REQUESTED_PREVIEW_REFUSAL_CODE = {
  notAllowed: 'REQUESTED_PREVIEWS_NOT_ALLOWED',
  expired: 'PREVIEW_EXPIRED',
  atLimit: 'REQUESTED_PREVIEW_LIMIT',
  noBranch: 'SOURCE_HAS_NO_BRANCH',
  overMaxTtl: 'TTL_OVER_MAXIMUM',
  /** No preview wildcard and no IP recorded for the machine. */
  noAddress: 'NO_PREVIEW_ADDRESS',
} as const;

export type RequestedPreviewRefusalCode =
  (typeof REQUESTED_PREVIEW_REFUSAL_CODE)[keyof typeof REQUESTED_PREVIEW_REFUSAL_CODE];

/** A refusal's sentence and the code a tool's error table matches it by. */
export interface RequestedPreviewRefusal {
  code: RequestedPreviewRefusalCode;
  message: string;
}

/**
 * What a caller who holds the grant is told when the operator has not allowed
 * requested previews: a state of the resource, so `409`, and the same
 * text over HTTP and MCP. An ungranted caller never reaches it.
 */
export const REQUESTED_PREVIEWS_NOT_ALLOWED =
  'Requested previews are not allowed on this Application';

/**
 * What a caller is told on extend or redeploy of a Requested preview that has
 * expired: marked by its clock or a delete, and waiting only for its
 * running copy to go. It will not come back, so the sentence says what to do
 * instead.
 */
export const PREVIEW_EXPIRED_REFUSAL =
  'This preview has expired and is being torn down; ask for a new one';

/**
 * What a requested preview's Deployment row says it is for, beside
 * `pullRequestDescription` in the service. The requester is not in the copy:
 * who asked is read from the preview's create audit row.
 */
export const requestedPreviewDescription = (branch: string): string =>
  `Requested preview of ${branch}`;

/**
 * Whether a preview's builds are announced to the Organization's notification
 * channels — **a rule about the trigger, not a bug**.
 *
 * A pull-request preview's deploy and build-error events fire exactly as they
 * always have. A requested preview's do not: it is asked for by a caller who
 * reads its outcome from the answer and the log, usually an Agent in a loop,
 * and announcing every one of its builds to the operator's channels would turn
 * them into that loop's transcript. So the absence of a notification for a
 * requested build is this function, not an omission to fix.
 */
export const announcesBuilds = (trigger: PreviewTrigger): boolean =>
  trigger === 'pullRequest';

/** When a preview asked for `ttlMinutes` at `now` expires: absolute, never additive. */
export const expiryAfter = (now: Date, ttlMinutes: number): string =>
  new Date(now.getTime() + ttlMinutes * 60_000).toISOString();

/**
 * The input-validation step of the refusal chain, or `null` when the request
 * passes it: the parent must build from a branch, and the TTL must be within
 * the instance maximum — **refused, not clamped**, and the refusal names
 * the maximum so the caller can ask again with a number that works.
 *
 * The request's *shape* (a non-empty branch, a positive whole TTL) is the
 * global pipe's, and so is checked before the grant; this is the step that
 * needs the Application and the instance, which is why it runs after the
 * switch.
 */
export function requestedPreviewInputRefusal(input: {
  sourceType: SourceType;
  ttlMinutes: number;
  maxTtlMinutes: number;
}): RequestedPreviewRefusal | null {
  if (!isBranchedSource(input.sourceType)) {
    return {
      code: REQUESTED_PREVIEW_REFUSAL_CODE.noBranch,
      message: `A requested preview builds a branch, and this Application's source type "${input.sourceType}" has none`,
    };
  }
  if (input.ttlMinutes > input.maxTtlMinutes) {
    return {
      code: REQUESTED_PREVIEW_REFUSAL_CODE.overMaxTtl,
      message: `ttlMinutes is ${input.ttlMinutes}, over this instance's maximum of ${input.maxTtlMinutes} minutes`,
    };
  }
  return null;
}

/**
 * The cap step of the refusal chain, or `null` while the Application holds
 * fewer Requested previews than its `requestedPreviewLimit`.
 * **The last step of create's chain**, because it is the only one that changes
 * with time: a caller who waits it out must never then learn the request was
 * invalid. Extend and redeploy never reach it, since only create takes a slot.
 *
 * `siblings` are the Application's `trigger = 'requested'` rows alone, and
 * every one counts, an expired one whose teardown is still pending included:
 * the cap is for the copy occupying the Server, not for the clock. **The
 * expiry it names is the soonest unexpired sibling's**, one neither marked
 * nor past its expiry, because that is the instant a caller can wait for: an
 * expired row frees its slot when its copy is gone, and naming it hid the
 * live siblings' expiries behind a row just deleted or stuck on a dead
 * Server. Only when every sibling is expired does it say the soonest of them
 * already expired and is being torn down.
 *
 * Said so the caller can act: the limit, that deleting one expires it now
 * and its slot frees once its teardown finishes (a delete is an expiry,
 * and the row holds its slot until its copy is gone), when the soonest
 * expires on its own, and who sets the limit. **No finality sentence**:
 * unlike an access decision, waiting may genuinely change this answer. An
 * expiry already past is said as one, since a teardown-pending row frees its
 * slot when its copy is gone, not at an instant the caller could wait for.
 */
export function requestedPreviewLimitRefusal(input: {
  limit: number;
  siblings: ReadonlyArray<{
    expiresAt: string | null;
    expiredAt: string | null;
  }>;
  now: Date;
}): string | null {
  const held = input.siblings.length;
  if (held < input.limit) return null;
  const noun = input.limit === 1 ? 'requested preview' : 'requested previews';
  /** Marked by the sweep or a `DELETE`, or past its expiry and not yet swept. */
  const isExpired = (expiresAt: string, expiredAt: string | null) =>
    expiredAt !== null || Date.parse(expiresAt) <= input.now.getTime();
  const byExpiry = (expired: boolean) =>
    input.siblings
      .flatMap(({ expiresAt, expiredAt }) =>
        expiresAt !== null && isExpired(expiresAt, expiredAt) === expired
          ? [expiresAt]
          : [],
      )
      .sort((a, b) => Date.parse(a) - Date.parse(b));
  const [soonestLive] = byExpiry(false);
  const [soonestExpired] = byExpiry(true);
  const soonest =
    soonestLive !== undefined
      ? `; the soonest expires at ${soonestLive}`
      : soonestExpired !== undefined
        ? `; the soonest already expired at ${soonestExpired} and is being torn down`
        : '';
  return `This Application holds at most ${input.limit} ${noun} at once, and already holds ${held}. Deleting one expires it now, and its slot frees once its teardown finishes${soonest}. This Application's operator sets the limit`;
}
