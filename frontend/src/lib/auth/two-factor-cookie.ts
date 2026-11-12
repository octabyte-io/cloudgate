import { cookies } from "next/headers";

/**
 * Is there a 2FA challenge in progress?
 *
 * When a sign-in needs a second factor, better-auth sets a short-lived
 * `two_factor` cookie **instead of** a session and answers
 * `{ twoFactorRedirect: true }`. That cookie is the challenge: `verifyTotp` reads
 * it to know whose code this is, and without it there is nothing on `/2fa` to
 * verify against.
 *
 * Asking here — on the server, before the screen renders — is what lets a stray
 * visit to `/2fa` say "there is no sign-in waiting" instead of showing a code box
 * that is guaranteed to be refused. The cookie is `httpOnly`, so this is the only
 * side that can look.
 *
 * Both spellings are checked because the prefix is a *backend* setting: better-auth
 * adds `__Secure-` when `advanced.useSecureCookies` is on, and our backend has it
 * off today (`auth.config.ts`) but a production deployment behind TLS may not.
 * `getSessionCookie` hedges the same way for the same reason.
 */
export async function hasTwoFactorChallenge(): Promise<boolean> {
  const jar = await cookies();
  return (
    jar.has("better-auth.two_factor") ||
    jar.has("__Secure-better-auth.two_factor")
  );
}
