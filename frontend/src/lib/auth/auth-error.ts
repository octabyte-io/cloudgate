import { ApiError, retryAfterSeconds } from "@/lib/api/api-error";

/**
 * better-auth refuses differently from Nest, and this is the seam.
 *
 * Two mismatches to close, both of which would otherwise reach a person:
 *
 * 1. **It does not throw.** Every client call resolves to `{ data, error }`.
 *    Ignore the `error` half and a failed sign-in looks exactly like a
 *    successful one, which is how "nothing happened when I pressed the button"
 *    ships. `unwrap()` turns it back into a throw, so F03's `useApiForm` routes
 *    it and F02's `toast.error` reads it — no screen writes its own handling.
 *
 * 2. **Its statuses mean something else.** A wrong password is a **401**, and
 *    F02 reads 401 as "your session has ended, sign in again" — which is not
 *    only wrong here, it is advice to do the thing they are already doing. A
 *    wrong TOTP code is a 401 too, and "you are not the recipient of this
 *    invitation" is a **403**, which F02 reads as a role problem. So the status
 *    alone cannot be trusted on these screens: the `code` is what carries the
 *    meaning, and `AUTH_SENTENCES` below is where it becomes words.
 */

/** The error half of a better-auth client result. */
export type AuthFailure = {
  message?: string;
  code?: string;
  status: number;
  statusText?: string;
  /**
   * Not better-auth's: the client's `onResponse` hook copies a 429's
   * `X-Retry-After` header into the body under this name (`client.ts`),
   * because better-fetch hands back the body and drops the headers.
   */
  retryAfter?: number;
};

/**
 * The auth client's `onResponse` hook: carry a throttle's wait into the body.
 *
 * better-auth's limiter answers a 429 with the wait in an `X-Retry-After`
 * header and a body that says only "Too many requests", and better-fetch builds
 * the `{ error }` half from the body alone — so without this the one number the
 * person needs never reaches `errorMessage()`, which said "wait a few seconds"
 * instead and had them retrying inside the window. Returning a
 * `Response` from the hook is better-fetch's own way of replacing the one it
 * goes on to parse; every other response passes through untouched.
 */
export async function carryRetryAfter({
  response,
}: {
  response: Response;
}): Promise<Response | undefined> {
  if (response.status !== 429) return undefined;
  const retryAfter = retryAfterSeconds(response.headers);
  if (retryAfter === undefined) return undefined;

  let body: unknown;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    body = undefined;
  }
  return new Response(
    JSON.stringify({
      ...(body && typeof body === "object" ? body : {}),
      retryAfter,
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

/** What every better-auth client method resolves to. */
export type AuthResult<T> =
  | { data: T; error: null }
  | { data: null; error: AuthFailure };

/**
 * A refusal from better-auth, as an `ApiError` the rest of the app already
 * understands — carrying the `code`, which is the only part that says what
 * actually happened.
 */
export class AuthError extends ApiError {
  constructor(failure: AuthFailure) {
    super(
      failure.status,
      failure.message ?? failure.statusText ?? "Authentication failed",
      // `code` is `ApiError`'s since H-26, not this class's. It was declared
      // here while better-auth was the only surface that published one; the
      // ban now arrives with the same code from a Cloudgate route as well
      // (`backend/src/auth/ban.ts`), and one field means `errorMessage()` asks
      // one question instead of first asking which surface refused.
      {
        code: failure.code ?? "",
        retryAfter:
          typeof failure.retryAfter === "number"
            ? failure.retryAfter
            : undefined,
      },
    );
    this.name = "AuthError";
  }
}

/**
 * Take the `data` or throw the refusal.
 *
 * Every auth call on these screens goes through this, which is what lets a
 * submit handler read as a sequence of steps instead of a chain of `if (error)`
 * blocks — and means a step that fails can never be mistaken for one that
 * worked.
 */
export async function unwrap<T>(call: Promise<AuthResult<T>>): Promise<T> {
  const { data, error } = await call;
  if (error) throw new AuthError(error);
  // A null `data` with a null `error` is not a shape better-auth produces; if it
  // ever does, failing here beats handing `null` to a screen that will read a
  // property off it.
  if (data === null) {
    throw new ApiError(
      500,
      "The auth endpoint answered with neither a result nor an error",
    );
  }
  return data;
}

/**
 * The ban's one sentence, named because a **second** reader needs it and must
 * not paraphrase it (H-49).
 *
 * `AUTH_SENTENCES.BANNED_USER` below is this constant, so the map still owns the
 * words. What the export adds is a way for `lib/auth/console-gate.ts` to say
 * them: the console shell's dead-session exit is not rendering a refusal — no
 * request of its own was refused, it read a session and decided to leave — so it
 * never reaches `errorMessage()`, and it had written its own longer version of
 * this fact. The two are seconds apart to the same person, who reads this on the
 * way out of the console and then reads it again the first time they try to sign
 * back in. That is H-29's complaint exactly, one layer up.
 *
 * **Only this one, and not a named constant per entry.** Everything else in the
 * map is reached through `authSentence()` by a code that arrived on the wire,
 * which is the seam this file is for. A second reader that has a *fact* rather
 * than an error is the unusual case, and it is worth one export rather than
 * opening the map to be picked over by hand.
 */
export const BANNED_SENTENCE =
  "This account has been banned. Ask an owner to lift the ban.";

/**
 * The code a session is refused with once its user has no `member` row in the
 * session's active Organization — better-auth's name, which
 * `backend/src/rbac/permission.service.ts` publishes too.
 *
 * Named because two readers act on it rather than only saying it: the map below
 * words it, and `query-client.ts` takes it as the cue to read the membership
 * list again, which is what lets the shell's gate notice (`membership.ts`).
 */
export const NOT_A_MEMBER_CODE = "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION";

/**
 * The code a route refuses a caller with for lacking **instance authority**
 * (ADR-0013) — `PermissionService.checkInstanceAuthority`'s, spelled the same
 * in `backend/src/rbac/permission.service.ts`.
 */
export const INSTANCE_AUTHORITY_REQUIRED_CODE = "INSTANCE_AUTHORITY_REQUIRED";

/**
 * What that refusal says, named so its tests read the same literal the map
 * below does.
 *
 * Not the role sentence: no role in the caller's Organization grants instance
 * authority, and the caller may already be that Organization's owner, so
 * "ask an owner or an admin" sent them nowhere. Who holds it — the
 * Instance organization's owners and admins — is named in CONTEXT.md's words,
 * as the Hosted platform pages name it (`platform-host-gate.tsx`), and with no
 * move to make, because none of this reader's own is the fix. It said "the
 * team that runs this Cloudgate", and CONTEXT.md avoids "Team". "Do" rather than "change"
 * because reads take the authority too and `readGate` says this over one.
 */
export const INSTANCE_AUTHORITY_SENTENCE =
  "Only an owner or admin of the Instance organization can do this.";

/**
 * The codes we have something better to say about than the status alone.
 *
 * Everything absent from this map falls through to `errorMessage()`, whose
 * status-based sentences are right for the rest (a 429 is a 429, a 500 is a
 * 500). Only the ones where better-auth's status would mislead, or where we can
 * name the actual fix, are listed.
 *
 * **Keyed on the code, not on the surface** (H-26). `errorMessage()` consults
 * this for any `ApiError` carrying a code, which since H-26 includes a refusal
 * from a Cloudgate route rather than only one from better-auth's client. That
 * is a widening of this file's stated seam and it is the right one: `BANNED_USER`
 * is a single fact that both surfaces publish, and the alternative was a second
 * copy of its sentence in `error-message.ts` that could disagree with this one.
 *
 * **And it is now most of this map, not one entry** (H-36). H-26 could say
 * "nothing in Nest publishes any of the other codes below, so there is no
 * collision to arbitrate", and that was true only because `callAuthApi` was
 * dropping them: every refusal better-auth raises names itself, and the
 * Cloudgate routes that wrap `auth.api.*` — twelve in `organizations.service.ts`
 * and eight in `users.service.ts` — were flattening the name to a bare status.
 * So the same refusal read as two different things depending on which door it
 * came through, which is what made this map's own seam a lie. There is still no
 * collision to arbitrate, and now for the stronger reason: a code below means
 * one fact whichever surface published it, because both surfaces are quoting
 * better-auth or Cloudgate's own `ban.ts` and never inventing a spelling.
 *
 * The messages follow F02's rules: say what went wrong, then what to do. Active
 * voice, sentence case, no apology.
 */
const AUTH_SENTENCES: Record<string, string> = {
  // ── Signing in ───────────────────────────────────────────────────────────
  // 401. Deliberately does not say *which* of the two is wrong: that is the one
  // place on these screens where being specific would enumerate accounts for
  // whoever is guessing.
  INVALID_EMAIL_OR_PASSWORD:
    "That email and password do not match an account. Check both, and try again.",
  // A wrong *current* password on a signed-in account-security action — 2FA on
  // or off, or changing the sign-in email. The person is signed in, so
  // nothing about the email is in doubt.
  INVALID_PASSWORD:
    "That is not your current password. Check it, and try again.",
  USER_NOT_FOUND:
    "That email and password do not match an account. Check both, and try again.",
  // Signing in with a password against an account that only has an identity
  // provider behind it.
  CREDENTIAL_ACCOUNT_NOT_FOUND:
    "That account has no password — it signs in through your identity provider. Use Sign in with SSO instead.",
  EMAIL_NOT_VERIFIED:
    "This account's email address is not verified yet. Open the link in the verification email, then sign in.",
  // 403, and the one this map exists for. `errorMessage()`'s sentence for a 403
  // is "Your role in this Organization does not allow this" — which is what the
  // console said to a *banned* operator for as long as
  // bans went uncoded, and would be said again here the moment
  // `console-gate.ts` sends them to this screen. Their role is not the problem
  // and no owner can fix it by changing one.
  //
  // One code, three endpoints: better-auth's admin plugin raises it when it
  // refuses a banned account a *new* session, `backend/src/auth/ban.ts` raises
  // it on the sessions they already hold, and since H-26 every Cloudgate route
  // publishes it too.
  //
  // Reworded by H-26 to drop "so it cannot sign in", because that third
  // endpoint gave the sentence a second reader: a toast over the console when a
  // route refuses a session that was live when the ban landed. "Cannot sign in"
  // is true on the sign-in form and is nonsense to somebody who is already
  // signed in. The fact and the move are what both readers share.
  //
  // The literal is `BANNED_SENTENCE` above since H-49, because it has a fourth
  // reader that never sees an error at all: `console-gate.ts`, which reads the
  // fact off the session and leaves. It had its own wording for it.
  BANNED_USER: BANNED_SENTENCE,
  // The self-hosted host-configuration trap, and the fix is a setting rather
  // than anything the person at the keyboard did. BETTER_AUTH_URL is
  // not the lever: it is also the base of every link better-auth generates, so
  // moving it to reach a second origin breaks the email and callback URLs.
  //
  // **Two levers, and the one that needs no restart comes first**. The
  // backend merges TRUSTED_ORIGINS with the owners' Trusted origins list on
  // every request (`auth.config.ts`, `trustedOriginsNow`), so an origin added
  // on that card is trusted at once. This sentence used to name only the env key
  // and a restart — on the screen an operator reaches straight after saving a
  // console domain. The card is behind an enterprise licence, and this is a
  // pre-auth screen that cannot know whether this instance has one, so both are
  // named and the restart is stated as the no-licence route rather than as the
  // fix. "The address the console already works on" is load-bearing: the card
  // cannot be reached from the address that was refused. The format clause
  // stays because it is the part that goes wrong — better-auth compares the
  // `Origin` header verbatim, so a path, a trailing slash or a `:443` is an
  // entry that matches nothing.
  INVALID_ORIGIN:
    "The backend does not trust this address, so it refused the request. An owner can trust it from the address the console already works on, under Settings → Single sign-on → Trusted origins, which takes effect at once and needs an enterprise licence. Without a licence, add this address's origin to TRUSTED_ORIGINS in the backend's environment — scheme and host only, no path or trailing slash — and restart the backend.",

  // ── A session that is not new enough ─────────────────────────────────────
  // 403, and the second one the status gets wrong: better-auth's
  // `freshSessionMiddleware` refuses a session older than `freshAge` on the
  // routes it guards, and "your role does not allow this" is said to somebody
  // whose role is fine and whose fix is thirty seconds of signing out and in.
  //
  // Added by H-36, and it is the sentence that had to exist *before* the string
  // match could go. `sessions-card.tsx` matched this refusal's English — the
  // last such match in the app, by its own comment — because `callAuthApi`
  // flattened better-auth's code away and a 403 with an English sentence was
  // all that arrived. Deleting the match without adding this would have traded a
  // string match for a downgrade: the card's own state keys on the code now, and
  // everything that does not render that state falls to `errorMessage()`, which
  // had only the role sentence to offer.
  //
  // **Not reachable on this build**, which is the reason it is worth writing
  // down rather than a reason to leave it out: `auth.config.ts` sets
  // `freshAge: 0`, and better-auth skips the whole check at 0. One
  // config value is what stands between this and the state
  // `GET /users/me/sessions` used to be in almost all of the time.
  SESSION_NOT_FRESH:
    "This needs a more recent sign-in than the one you are on. Sign out, then sign in again.",

  // ── Signing up ───────────────────────────────────────────────────────────
  // The five Cloudgate rules `assertSignUpAllowed` enforces. They are
  // the backend's own, not better-auth's, and they arrive as a 400 whose status
  // says nothing — the code is the whole of what distinguishes "this instance is
  // not taking sign-ups" from "your invitation ran out".
  //
  // Not an error to correct, a fact about the instance. `/sign-up` now asks
  // before it renders (`GET /auth/sign-up-open`), so this sentence is the
  // narrow race — somebody claimed the instance while the form was open.
  SIGN_UP_CLOSED:
    "This instance is already set up, so it is closed to new sign-ups. Ask an owner to invite you, then use the link in the invitation.",
  // The Hosted instance before its Instance organization exists. Same
  // narrow race as above; the screen normally says it before the form.
  SIGN_UP_NOT_OPEN_YET: "Sign-up is not open yet. Come back once it opens.",
  // The Hosted sign-up form's Turnstile check, from better-auth's
  // captcha plugin: no token, or one Cloudflare did not accept.
  MISSING_RESPONSE: "Complete the check above the button, then try again.",
  VERIFICATION_FAILED:
    "The check above the button did not pass. Try it again, then create the account.",
  // One confirmation email per address every few minutes.
  CONFIRMATION_EMAIL_LIMITED:
    "A confirmation email went to this address a moment ago. Wait a few minutes, then ask for another.",
  // The four invitation-token refusals. Each one's own wording is specific and
  // correct; these add the missing half — what to do next.
  INVITATION_INVALID:
    "That invitation link is not valid. Check you copied the whole link, or ask for a new one.",
  INVITATION_EXPIRED:
    "That invitation has expired. Ask whoever invited you to send a new one.",
  INVITATION_ALREADY_USED:
    "That invitation has already been used. If the account exists, sign in instead.",
  INVITATION_EMAIL_MISMATCH:
    "That invitation was sent to a different email address. Sign up with the address it was sent to.",
  USER_ALREADY_EXISTS:
    "An account already uses that email address. Sign in instead, or use another address.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "An account already uses that email address. Sign in instead, or use another address.",
  PASSWORD_TOO_SHORT: "That password is too short. Use at least 8 characters.",
  PASSWORD_TOO_LONG: "That password is too long. Use 128 characters or fewer.",

  // ── The 2FA challenge ────────────────────────────────────────────────────
  INVALID_CODE:
    "That code is not right. Check your authenticator app for the current one — each code lasts 30 seconds.",
  INVALID_BACKUP_CODE:
    "That backup code is not right. Each one works once, so check you have not already used it.",
  // The challenge is spent: better-auth has expired the two-factor cookie, so
  // there is nothing left on this screen to retry.
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE:
    "Too many wrong codes, so this sign-in attempt is closed. Sign in again to start a new one.",
  ACCOUNT_TEMPORARILY_LOCKED:
    "Too many wrong codes, so this account is locked for 15 minutes. Wait, then sign in again.",
  // Either the challenge timed out or someone opened /2fa without signing in.
  INVALID_TWO_FACTOR_COOKIE:
    "This sign-in attempt has expired. Sign in again to get a new code prompt.",
  TOTP_NOT_ENABLED:
    "This account has no authenticator app set up. Use a backup code, or ask an owner to turn two-factor authentication off for it.",
  TWO_FACTOR_NOT_ENABLED:
    "This account does not use two-factor authentication. Sign in with your email and password.",
  BACKUP_CODES_NOT_ENABLED:
    "This account has no backup codes. Use the code from your authenticator app.",

  // ── Resetting a password ─────────────────────────────────────────────────
  // Both spellings of a link that cannot be used: consumed, or past its hour.
  // They are one state on purpose — the backend cannot tell them apart, and the
  // fix is the same either way.
  INVALID_TOKEN:
    "This reset link has already been used, or it has expired. Request a new one.",
  TOKEN_EXPIRED: "This reset link has expired. Request a new one.",
  // The backend has no email sender wired into better-auth.
  RESET_PASSWORD_DISABLED:
    "This instance cannot send password reset emails yet, so this link does nothing. Ask an owner to set your password for you.",

  // ── Invitations ──────────────────────────────────────────────────────────
  INVITATION_NOT_FOUND:
    "This invitation is not open any more — it has been used, withdrawn, or has expired. Ask whoever invited you to send a new one.",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION:
    "This invitation was sent to a different email address. Sign out, then sign in as the person it was sent to.",
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED:
    "This organization is full, so the invitation cannot be accepted. Ask an owner to remove a member or raise the limit.",
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION:
    "You are already a member of this organization. Open the console to work in it.",
  ORGANIZATION_NOT_FOUND:
    "The organization this invitation belongs to is gone. Ask whoever invited you to send a new one.",

  // ── Membership ───────────────────────────────────────────────────────────
  // A session still pointed at an Organization its user was removed from.
  // better-auth's member routes refuse it with this code, and so does
  // every Cloudgate route (`PermissionService.findMember`) — it used to be an
  // uncoded 403 there, and the role sentence told the person to ask for a role
  // change in an Organization they were no longer in. The shell replaces itself
  // with a screen saying the same thing once the membership list confirms it
  // (`shell/not-a-member.tsx`); this is what a card says in the meantime.
  [NOT_A_MEMBER_CODE]:
    "You are no longer a member of this Organization. Switch to one you belong to, or sign out.",

  // ── Instance authority ───────────────────────────────────────────────────
  // A 403 whose cause is not the role: the platform host is administered by
  // the instance organization's owners and admins (ADR-0013), on every route
  // `PermissionService.checkInstanceAuthority` guards.
  [INSTANCE_AUTHORITY_REQUIRED_CODE]: INSTANCE_AUTHORITY_SENTENCE,
};

/**
 * The sentence for a coded refusal, or `undefined` if its status already says
 * everything — in which case `errorMessage()` handles it.
 *
 * One lookup, on the code, for every refusal the console can see. At first the
 * backend's own five sign-up rules had to be recognised by matching their
 * English here, because `assertSignUpAllowed` raised them with a message and no
 * code — so a reworded sentence in `auth.config.ts` would have silently dropped
 * this app back to the generic "the request was refused". They carry codes now
 * and are in the map above with everything else.
 *
 * Takes an `ApiError` rather than an `AuthError` since H-26, which is the whole
 * of what let the ban be recognised on a Cloudgate route. An error with no code
 * answers `undefined` at the first lookup, so the widening costs the callers
 * nothing.
 */
export function authSentence(error: ApiError): string | undefined {
  return AUTH_SENTENCES[error.code];
}
