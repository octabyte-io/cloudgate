import { APIError } from 'better-auth/api';

/** The two routes whose `callbackURL` a Hosted confirmation link lands on. */
const CONFIRMATION_PATHS = ['/sign-up/email', '/send-verification-email'];

/** What {@link refuseForeignConfirmationCallback} reads of better-auth's hook context. */
export interface ConfirmationCallbackCtx {
  readonly path: string;
  readonly body?: unknown;
  readonly context: {
    isTrustedOrigin(
      url: string,
      settings?: { allowRelativePaths: boolean },
    ): boolean;
  };
}

/**
 * Refuses a sign-up, or a resend of its confirmation email, whose
 * `callbackURL` is neither a path on this site nor a trusted origin.
 *
 * **Why Cloudgate checks what better-auth already checks.** On a Hosted
 * instance following the confirmation link signs the person in and lands
 * them on that `callbackURL` (`autoSignInAfterVerification`, ADR-0073), so
 * a foreign one would hand a fresh session's landing to another site.
 * better-auth's own origin check is the same rule, but it is **switched off
 * whenever `NODE_ENV` is `test`** (`skipOriginCheck` defaults to true there),
 * so nothing in the e2e lane could prove the refusal, and a config change
 * that turned it off would go unnoticed. This one runs in every mode, on
 * better-auth's own matcher, so the two can never disagree.
 *
 * Rejected: a separate path-only rule like `api-schemas`' `returnToSchema`.
 * The CLI and self-hosters' trusted origins send absolute URLs, which that
 * would refuse.
 */
export function refuseForeignConfirmationCallback(
  ctx: ConfirmationCallbackCtx,
): void {
  if (!CONFIRMATION_PATHS.includes(ctx.path)) return;
  const callbackURL = (ctx.body as { callbackURL?: unknown } | undefined)
    ?.callbackURL;
  if (callbackURL === undefined || callbackURL === null || callbackURL === '')
    return;
  if (
    typeof callbackURL !== 'string' ||
    !ctx.context.isTrustedOrigin(callbackURL, { allowRelativePaths: true })
  ) {
    throw new APIError('FORBIDDEN', {
      code: 'INVALID_CALLBACK_URL',
      message: 'Invalid callbackURL',
    });
  }
}
