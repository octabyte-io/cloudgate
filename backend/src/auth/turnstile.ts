import { captcha } from 'better-auth/plugins';

/**
 * Cloudflare Turnstile on the Hosted instance's public sign-up form:
 * better-auth's captcha plugin, run on `/sign-up/email` only.
 *
 * The console's widget hands the browser a token, which the form sends as
 * {@link CAPTCHA_RESPONSE_HEADER}; the plugin posts it with the secret key to
 * Cloudflare's siteverify and refuses the sign-up before better-auth looks at
 * it — 400 MISSING_RESPONSE with no token, 403 VERIFICATION_FAILED with a bad
 * one, 500 when Cloudflare cannot be reached (it fails closed).
 */

/** Where the plugin reads the widget's token. */
export const CAPTCHA_RESPONSE_HEADER = 'x-captcha-response';

/** Cloudflare's verification endpoint, which the plugin calls by default. */
export const CLOUDFLARE_SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * The provider token for the siteverify URL: the port to Cloudflare, so e2e
 * answers it with a fake verifier on localhost (`test/utils/fake-turnstile.ts`)
 * and the plugin itself runs unchanged.
 */
export const TURNSTILE_SITEVERIFY_URL = 'TURNSTILE_SITEVERIFY_URL';

export interface HostedTurnstileOptions {
  /** Asked on every request, so the check follows `InstanceMode`. */
  isHosted: () => boolean;
  /** TURNSTILE_SECRET_KEY; the hosted boot refuses to start without it. */
  secretKey: string;
  siteVerifyURL: string;
  /**
   * A request the check lets through without a token: an invited sign-up,
   * which its invitation token authorises instead. A made-up one is refused by
   * `assertSignUpAllowed` before any account exists or any email is sent.
   */
  exempt: (request: Request) => boolean;
}

/**
 * The plugin, hosted only: a Self-hosted instance asks nothing of its sign-up
 * form (its accounts are its owner's and the people they invite), so there the
 * request goes on as if the plugin were not installed.
 */
export function hostedTurnstile(options: HostedTurnstileOptions) {
  const plugin = captcha({
    provider: 'cloudflare-turnstile',
    secretKey: options.secretKey,
    endpoints: ['/sign-up/email'],
    siteVerifyURLOverride: options.siteVerifyURL,
  });
  return {
    ...plugin,
    onRequest: async (
      request: Request,
      ctx: Parameters<typeof plugin.onRequest>[1],
    ): ReturnType<typeof plugin.onRequest> => {
      if (!options.isHosted() || options.exempt(request)) return undefined;
      const refused = await plugin.onRequest(request, ctx);
      return refused && { response: asJson(refused.response) };
    },
  };
}

/**
 * The plugin's refusal is a JSON body sent as `text/plain`, which the
 * console's better-auth client reads as text, so the code and sentence never
 * reach the form. Same body and status, labelled as what it is.
 */
function asJson(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  return new Response(response.body, { status: response.status, headers });
}
