import { api } from "@/lib/api/client";

/**
 * The one thing about this instance the sign-up screen has to know before it
 * renders anything.
 *
 * `GET /auth/sign-up-open` is `@Public()`, like its neighbour
 * `/sso/show-sign-in` — it is read on the way in, before there is a session.
 *
 * **It answers about *uninvited* sign-up only.** Once an owner exists, `open` is
 * false forever, but an invited sign-up still works: the token in the
 * `x-cloudgate-token` header is what authorises it, and only its holder can ask.
 * So a screen that has an invitation must not consult this at all (see
 * `use-sign-up-open.ts`).
 *
 * Not on better-auth's own client, and not under `/api/auth`: this is a Cloudgate
 * rule (`assertSignUpAllowed`) rather than
 * anything better-auth knows about, so it is a plain REST read like the rest of
 * this directory.
 */
/**
 * What an uninvited sign-up meets (backend `sign-up-state.ts`):
 *
 * - `unclaimed` — Self-hosted, no owner yet: the first account owns the instance.
 * - `closed` — Self-hosted, owned: accounts are made by invitation.
 * - `not-open-yet` — the Hosted instance before its Instance organization exists
 *   (made by a command on the platform host): every sign-up is refused.
 * - `open` — the Hosted instance once it does: anyone may sign up.
 */
export type SignUpState = "unclaimed" | "closed" | "not-open-yet" | "open";

/**
 * `open` is whether an uninvited sign-up is accepted; `state` says which.
 * `turnstileSiteKey` comes from the Hosted instance only: the form
 * renders Cloudflare's Turnstile widget with it, and the sign-up carries the
 * widget's token.
 */
export function signUpOpen(signal?: AbortSignal) {
  return api.get<{
    open: boolean;
    state: SignUpState;
    turnstileSiteKey?: string;
  }>("/auth/sign-up-open", {
    signal,
  });
}

/**
 * `GET /auth/invitations/:id` — whether an invitation link is still good, for a
 * visitor who is not signed in. `@Public()` like `sign-up-open`. Only an
 * open invitation names its Organization and the address it was sent to; any
 * other id answers `open: false` with a code and nothing else.
 */
export type InvitationPreview =
  | { open: true; organizationName: string; email: string }
  | { open: false; code: "INVITATION_EXPIRED" | "INVITATION_NOT_OPEN" };

export function invitationPreview(invitationId: string, signal?: AbortSignal) {
  return api.get<InvitationPreview>(
    `/auth/invitations/${encodeURIComponent(invitationId)}`,
    { signal },
  );
}

/**
 * `GET /auth/password-reset-open` — whether this instance can send a reset
 * link at all: it needs an email sender. `@Public()`, read by
 * `/forgot-password` before it offers a form that would only be refused.
 */
export function passwordResetOpen(signal?: AbortSignal) {
  return api.get<{ open: boolean }>("/auth/password-reset-open", { signal });
}
