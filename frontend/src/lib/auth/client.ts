import { apiKeyClient } from "@better-auth/api-key/client";
import { ssoClient } from "@better-auth/sso/client";
import {
  adminClient,
  deviceAuthorizationClient,
  inferAdditionalFields,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { AUTH_PATH, BACKEND_INTERNAL_ORIGIN } from "@/lib/config";

import { carryRetryAfter } from "./auth-error";

/**
 * The auth client — session, sign-in/out, organization switching, 2FA and API
 * keys, all of it better-auth's.
 *
 * Nothing in this app calls `/api/auth/*` by hand. If a flow feels missing,
 * it is on this client under a name we have not looked for yet.
 *
 * The plugin list mirrors the server's — `createAuth`'s own `plugins` array in
 * `auth/auth.config.ts`. A client plugin that is not on the server silently 404s,
 * and one missing here means its endpoints are simply not reachable from the
 * app.
 */
export const authClient = createAuthClient({
  ...authOrigin(),
  // A 429's wait is a header, and better-fetch keeps only the body.
  fetchOptions: { onResponse: carryRetryAfter },
  plugins: [
    organizationClient({ teams: { enabled: true } }),
    twoFactorClient(),
    apiKeyClient(),
    ssoClient(),
    adminClient(),
    deviceAuthorizationClient(),
    /**
     * The `user` columns the server adds beyond better-auth's own
     * (`auth.config.ts`: `additionalFields`). Declared by hand rather than
     * inferred from `typeof auth`, because that type lives in the backend package
     * and this app does not import it.
     *
     * Only the ones a *client* call sends or reads need to be here. `lastName` is
     * the one that does: F06's sign-up form submits it, and without this the
     * client's `signUp.email` type rejects the field — silently dropping a column
     * the profile screen then shows as empty. `role`, `banned` and the rest are
     * `input: false` on the server and arrive on `GET /users/me` instead, which is
     * typed in `src/lib/api/endpoints/users.ts`.
     */
    inferAdditionalFields({
      user: { lastName: { type: "string", required: false } },
    }),
  ],
});

/**
 * In the browser: our own origin, so the session cookie is first-party (see
 * `src/lib/config.ts`). On the server: Nest directly — nothing fetches auth
 * during render, but better-auth resolves this when the module is evaluated,
 * and a relative URL there throws rather than waiting to be used.
 *
 * The server branch takes `BACKEND_INTERNAL_ORIGIN` because it is server-side
 * by construction, which is the same reason `next.config.ts`'s rewrites do
 * — two server-side readers of "where is Nest" that can disagree will.
 */
function authOrigin(): { baseURL: string; basePath: string } {
  if (typeof window === "undefined") {
    return { baseURL: BACKEND_INTERNAL_ORIGIN, basePath: "/api/auth" };
  }
  return { baseURL: window.location.origin, basePath: AUTH_PATH };
}

export const {
  useSession,
  signIn,
  signUp,
  signOut,
  organization,
  twoFactor,
  apiKey,
  sso,
  admin,
  getSession,
  requestPasswordReset,
  resetPassword,
  /** The "check your inbox" screen's resend, on the Hosted instance. */
  sendVerificationEmail,
  updateUser,
  changePassword,
  /** The full active Organization — name, logo, members. Costs a request. */
  useActiveOrganization,
  /**
   * The caller's *own* role in the active Organization, and nothing else —
   * `GET /organization/get-active-member-role`. Costs a request, and it is the
   * cheapest one that answers this: `useActiveOrganization` fetches the whole
   * Organization with its members and invitations to get at the same field.
   *
   * Its guard is membership rather than a statement, which is what makes it
   * usable by `use-permission.ts`: a base member holds `member: []` and must
   * still be able to read what their own role is, or every gated control would
   * be gated on a read the ungated role cannot make.
   *
   * The name is why this line exists at all. `checkRolePermission` is the export
   * that looks like the answer to "what may this caller do" and is not (see
   * `use-permission.ts` for both dead ends); this is the one fact off this
   * client that the real answer is built from.
   */
  useActiveMemberRole,
  useListOrganizations,
} = authClient;

/** Where a code a `cloudgate login` printed stands. */
export type DeviceCodeStatus = "pending" | "approved" | "denied";

/**
 * The person's half of `cloudgate login`: the device-authorization
 * plugin's `/device` (looking a code up, which binds it to this session),
 * `/device/approve` and `/device/deny`, through this client's own fetch. The
 * client plugin carries no types for them, so they are typed here once.
 */
export const device = {
  lookUp: (userCode: string) =>
    authClient.$fetch<{ user_code: string; status: DeviceCodeStatus }>(
      "/device",
      { method: "GET", query: { user_code: userCode } },
    ),
  approve: (userCode: string) =>
    authClient.$fetch<{ success: boolean }>("/device/approve", {
      method: "POST",
      body: { userCode },
    }),
  deny: (userCode: string) =>
    authClient.$fetch<{ success: boolean }>("/device/deny", {
      method: "POST",
      body: { userCode },
    }),
};

/**
 * The tenant boundary, as an id.
 *
 * This is what every query key is scoped by (`src/lib/api/keys.ts`), so it has
 * to be free: it comes off the session that is already loaded, not from
 * `useActiveOrganization`, which fetches the whole Organization.
 *
 * `null` while the session is still loading *and* when the caller genuinely has
 * no active Organization — `pending` is how you tell those apart.
 *
 * It is **not** why a directly-opened console screen can sit on its skeleton for
 * ever. Measured on
 * that path: every consumer of this hook holds the real id with `pending` false
 * about a second into the load, while the screen stays empty. What is frozen is
 * the page's Suspense boundary — `(console)/loading.tsx` puts one under the
 * shell, so a page that is not ready at the first flush streams in behind it —
 * and react-dom 19.2 reveals such a boundary from an animation frame: `$RC`
 * parks it as a `$~` comment, and both `$RV` (the reveal) and the hydration
 * retry after it are `requestAnimationFrame` callbacks. A tab that paints no
 * frames — minimised, occluded, or driven by a headless harness — never gets
 * one, so the server's markup stays in the DOM unhydrated, nothing in the page
 * subtree ever mounts, and no query observer is ever created. One forced frame
 * reveals and hydrates it. So a screen that will not populate is a question
 * about that boundary, not about this hook.
 *
 * The cast is deliberate. `activeOrganizationId` is a real column the
 * organization plugin adds to `session`, but the plugin only widens the client's
 * session type when `dynamicAccessControl` is enabled, which the server does not
 * enable (`auth.config.ts`).
 */
export function useActiveOrganizationId(): {
  organizationId: string | null;
  pending: boolean;
} {
  const { data, isPending } = useSession();
  const session = data?.session as
    | { activeOrganizationId?: string | null }
    | undefined;

  return {
    organizationId: session?.activeOrganizationId ?? null,
    pending: isPending,
  };
}

/**
 * better-auth's membership-list store as it stands right now, outside React
 * — what `useListOrganizations` would render, for the two readers that
 * are not components: `lib/auth/membership.ts` records which list a check was
 * made against, and asks whether a read is already in flight before starting
 * another. `undefined` only if the organization plugin were missing.
 *
 * The cast is the store's: `$store.atoms` is typed as a bag of atoms keyed by
 * name, and this is the one of them the organization plugin registers as
 * `listOrganizations`. Here rather than at the reader because this file is the
 * one surface onto the auth client (§3.7).
 */
export function organizationListNow():
  | { data: unknown; isRefetching: boolean }
  | undefined {
  const atom = authClient.$store.atoms.listOrganizations as
    | { get: () => { data: unknown; isRefetching: boolean } }
    | undefined;
  return atom?.get();
}

/**
 * Read `/organization/list` again. better-auth raises this signal itself only
 * for its own create, update and delete routes, so every other change to a
 * membership has to be told — see `use-invalidate.ts`'s `membership()` and
 * `lib/auth/membership.ts`.
 */
export function refetchOrganizationList(): void {
  authClient.$store.notify("$listOrg");
}

export type Session = typeof authClient.$Infer.Session;
