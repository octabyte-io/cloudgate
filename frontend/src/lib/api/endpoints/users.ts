import { api } from "../client";

/**
 * `users.controller.ts`. The account surface that is *not* better-auth's: the
 * profile row, sessions, API keys and the 2FA flows Nest wraps so it can
 * forward better-auth's rotated Set-Cookie.
 *
 * Anything better-auth already does on the client — signing in, switching
 * organization — goes through `src/lib/auth/client.ts` instead.
 */

/** The `user` row, as `GET /users/me` returns it (`auth/auth.schema.ts`). */
export interface UserProfile {
  id: string;
  /** better-auth's `name`, mapped onto this column in `auth.config.ts`. */
  firstName: string;
  lastName: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
  updatedAt: string;
  twoFactorEnabled: boolean | null;
  /** The admin plugin's instance role, not the organization role. */
  role: string;
  banned: boolean | null;
  banReason: string | null;
  banExpires: string | null;
  trustedOrigins: string[] | null;
}

export interface UpdateProfileInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  /** Required by the backend whenever `email` changes the stored address. */
  currentPassword?: string;
  image?: string | null;
}

/**
 * One row of `GET /users/me/sessions`.
 *
 * **No `token`, and that is the whole
 * point.** This used to be
 * better-auth's `session` row passed through verbatim, token included — so
 * opening the account screen pulled a live bearer credential for every other
 * machine the account was signed in on into the browser. It was there because
 * better-auth keys revocation by token and the client had to hand one back;
 * ADR-0009 records why revocation is keyed by session `id` here instead.
 *
 * `updatedAt` and `activeOrganizationId` went with it. Nothing rendered them,
 * and the backend publishes a closed set of fields now rather than a row shape
 * a schema change upstream could widen — so declaring them here would be
 * declaring fields that no longer arrive.
 */
export interface UserSession {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * What `GET /users/me/api-keys` actually answers with.
 *
 * **Not an array**, which is what this module declared until F16 drove the
 * screen and `DataTable` crashed on `sorted.map is not a function`.
 * `@better-auth/api-key`'s `listApiKeys` returns `{ apiKeys, total }` — a paged
 * envelope — and `usersService.listApiKeys` passes it straight through. This is
 * the cost of an untyped API in its purest form. The instance now publishes an
 * OpenAPI document at `/docs`, checked in at `backend/openapi.json`, but it
 * does not settle this one: the document is generated from the zod DTOs, and a
 * controller that returns a plugin's result verbatim has no DTO to generate
 * from — `GET /users/me/api-keys` is in there with a bare 200 and no response
 * schema. So the type below is still hand-written, and still the only
 * description of the shape.
 *
 * `listApiKeys` below unwraps it, so nothing downstream has to know.
 */
export interface ApiKeyPage {
  apiKeys: ApiKey[];
  total: number;
}

/** An API key as better-auth returns it. `key` is only ever on the create. */
export interface ApiKey {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  userId: string;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRequest: string | null;
  requestCount: number;
  metadata: Record<string, unknown> | null;
}

/** The one response that carries the secret — it is never readable again. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

export interface CreateApiKeyInput {
  name: string;
  prefix?: string;
  /** Seconds until it expires. Omit for a key that does not expire. */
  expiresIn?: number;
}

/** What `POST /users/me/2fa/enable` hands back to render the QR code. */
export interface TwoFactorEnrollment {
  totpURI: string;
  backupCodes: string[];
}

/**
 * What `PATCH /users/me` answers: the profile as stored, and — on the Hosted
 * instance, after a change of email — the new address still waiting for its
 * confirmation link to be followed. `email` is the old one until then.
 */
export type SavedProfile = UserProfile & { pendingEmail?: string };

export const usersApi = {
  me: () => api.get<UserProfile>("/users/me"),

  updateMe: (input: UpdateProfileInput) =>
    api.patch<SavedProfile>("/users/me", input),

  /**
   * Every session this account holds — and no credential among them.
   *
   * **It used to stop working a day after you signed in.** better-auth's
   * `listSessions` rides `freshSessionMiddleware`, and with no
   * `session.freshAge` configured the default 24 hours applied, so a session
   * older than that got a **403 "Session is not fresh"**
   * — which is the
   * state a working session spends nearly all its life in. `auth.config.ts`
   * sets `freshAge: 0` now, skipping the check outright. `sessions-card.tsx`
   * still renders that refusal as its own state, and says why it keeps a guard
   * for something one config value away from returning.
   */
  listSessions: () => api.get<UserSession[]>("/users/me/sessions"),

  /**
   * Ends one session, named by its **id** — never by its token, which the
   * listing no longer carries and this app therefore never holds.
   *
   * A session id the caller does not own and one that does not exist both come
   * back **404 "Session not found"**, byte for byte, so the route cannot be used
   * to ask whether an id exists (ADR-0009, following ADR-0007 and ADR-0008).
   * Nothing here has to distinguish them, because nothing can.
   */
  revokeSession: (sessionId: string) =>
    api.post<{ status: boolean }>("/users/me/sessions/revoke", { sessionId }),

  /** Unwrapped here, so no screen has to know about the envelope. */
  listApiKeys: () =>
    api
      .get<ApiKeyPage>("/users/me/api-keys")
      .then((page) => page.apiKeys ?? []),

  createApiKey: (input: CreateApiKeyInput) =>
    api.post<CreatedApiKey>("/users/me/api-keys", input),

  deleteApiKey: (id: string) =>
    api.delete<{ success: boolean }>(`/users/me/api-keys/${id}`),

  enableTwoFactor: (password: string) =>
    api.post<TwoFactorEnrollment>("/users/me/2fa/enable", { password }),

  /** Verifying rotates the session; Nest forwards the new cookie. */
  verifyTwoFactor: (code: string) =>
    api.post<unknown>("/users/me/2fa/verify", { code }),

  disableTwoFactor: (password: string) =>
    api.post<unknown>("/users/me/2fa/disable", { password }),
};
