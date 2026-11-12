/**
 * The paths outside the console, and the one rule for getting back in.
 *
 * Imported by `src/proxy.ts`, which runs before every request — so this module
 * deliberately imports **nothing**. Pull `@tanstack/react-query` or the auth
 * client in here and the proxy pays for it on every navigation.
 *
 * It is also why `SIGN_IN_PATH` lives here rather than in
 * `src/lib/api/query-client.ts`, which declared it first (F02) because the 401
 * handler needed it before this screen existed. That file now imports it from
 * here: one constant, two callers, no chance of them drifting.
 */

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";
export const TWO_FACTOR_PATH = "/2fa";
export const FORGOT_PASSWORD_PATH = "/forgot-password";
export const RESET_PASSWORD_PATH = "/reset-password";
export const SELECT_ORGANIZATION_PATH = "/select-organization";
export const CONSOLE_HOME = "/";
/**
 * The get-started wizard a "Deploy <app>" button on the templates website
 * lands on (ADR-0073). Named here because the sign-in and sign-up screens
 * word themselves for someone on their way to it.
 */
export const GET_STARTED_PATH = "/get-started";

/** The query parameter carrying where they were headed before the gate. */
export const NEXT_PARAM = "next";

/**
 * Everything that lives outside the console shell. A signed-in visitor is
 * bounced away from these, and a signed-out one is allowed through.
 *
 * `/accept-invitation` is **not** here, and that is the point: it is the one
 * screen both a signed-in and a signed-out visitor have business on. Bouncing a
 * signed-in user off their own invitation link would send them to the console
 * and lose the invitation.
 */
export const AUTH_PATHS = [
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  TWO_FACTOR_PATH,
  FORGOT_PASSWORD_PATH,
  RESET_PASSWORD_PATH,
] as const;

export function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * Where to send someone after they sign in — and the one place that decision is
 * allowed to trust a URL from the address bar.
 *
 * `?next=` is attacker-controllable: it survives being emailed, and whoever
 * clicks the link is about to type a password on the page it lands on. So this
 * accepts **only a path on this origin** and falls back to the console home for
 * anything else. Specifically rejected:
 *
 * - `https://evil.example` — an absolute URL, the plain open redirect.
 * - `//evil.example` — protocol-relative, which a browser reads as a *host*.
 * - `/\evil.example` and `/\/evil.example` — backslashes, which browsers
 *   normalise to `/` before resolving the authority, so `/\evil.example` is
 *   another spelling of `//evil.example`.
 * - `javascript:` and `data:` — no scheme survives the leading-`/` test, but
 *   they are what the test is *for*.
 *
 * A fragment or a query string is kept: they are part of where someone was.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return CONSOLE_HOME;
  if (!value.startsWith("/")) return CONSOLE_HOME;
  // Reject anything the browser would read as a host rather than a path. The
  // second character is the whole test: `//` and `/\` both introduce an
  // authority, and every other one-character prefix cannot.
  if (value[1] === "/" || value[1] === "\\") return CONSOLE_HOME;
  // An auth path as the destination would bounce them straight back out again
  // (a signed-in visitor is not allowed on one), so it is a loop, not a
  // destination.
  if (isAuthPath(value.split("?")[0].split("#")[0])) return CONSOLE_HOME;
  return value;
}

/**
 * Whether a (safe) `next` is the get-started wizard, so the screen on the way
 * can say what the account is for. Only the path is compared: its query is
 * the template, which changes nothing here.
 */
export function isGetStartedPath(next: string): boolean {
  const path = next.split("?")[0].split("#")[0];
  return path === GET_STARTED_PATH || path.startsWith(`${GET_STARTED_PATH}/`);
}

/**
 * Where a Hosted sign-up's confirmation link lands once followed: the
 * `next` the sign-up carried, since following the link signs the person in
 * (`autoSignInAfterVerification` in the backend's `auth.config.ts`), or the
 * sign-in screen without one. A path, so better-auth's origin check on
 * `/verify-email` passes and the redirect stays on this origin; and always
 * through `safeNextPath`, so what the email carries was judged once already.
 */
export function confirmedCallbackPath(next: string): string {
  const safe = safeNextPath(next);
  return safe === CONSOLE_HOME ? SIGN_IN_PATH : safe;
}

/**
 * Carry the intended destination to the next screen in the flow.
 *
 * Signing in can take three hops — sign-in, the 2FA challenge, choosing an
 * Organization — and every one of them has to pass `next` along or the last one
 * lands at home and quietly loses the deep link someone followed. Dropping the
 * parameter when it is only the console home keeps the URL honest.
 */
export function withNext(path: string, intended: string): string {
  if (safeNextPath(intended) === CONSOLE_HOME) return path;
  return `${path}?${NEXT_PARAM}=${encodeURIComponent(intended)}`;
}

/**
 * An invitation link's own page. Named because three exits have to agree on it:
 * the signed-out "Sign in to accept", and both of the signed-in page's Sign outs,
 * which send the person to sign in as somebody else and must bring them back
 * here rather than to the console home.
 */
export function acceptInvitationPath(invitationId: string): string {
  return `/accept-invitation/${invitationId}`;
}

/** The sign-in URL that comes back to `intended` once they are through. */
export function signInWithNext(intended: string): string {
  return withNext(SIGN_IN_PATH, intended);
}
