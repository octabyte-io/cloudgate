import type { Auth } from '../auth/auth.config';

/** One row as better-auth's `listSessions` answers with it. */
type BetterAuthSession = Awaited<
  ReturnType<Auth['api']['listSessions']>
>[number];

/**
 * One session as `GET /users/me/sessions` publishes it — an allowlist, and
 * **never the session token** (ADR-0009).
 *
 * The token *is* the credential for its session, so a listing that carried it
 * handed the caller a working bearer key for every other machine the account
 * was signed in on. It was there only because better-auth keys revocation by
 * token; ADR-0009 records why revocation is keyed by session id here instead.
 *
 * **Stated as an allowlist rather than an `Omit<BetterAuthSession, 'token'>`,
 * and mapped field by field below.** A subtraction is only ever correct about
 * the fields that exist when it is written: better-auth renaming `token`, or
 * any plugin adding a column to the `session` table, would put a field nobody
 * chose back on the wire and no type error would say so. `impersonatedBy`,
 * `activeOrganizationId`, `activeTeamId` and `updatedAt` are dropped for the
 * weaker reason that no client reads them — they are not credentials, they are
 * simply not this screen's business.
 */
export interface SessionSummary {
  id: string;
  /** The account the session belongs to; always the caller's own. */
  userId: string;
  /** Rendered raw by the console — parsing user agents is confident guesswork. */
  userAgent: string | null;
  /** `null` when the install records no address for the session. */
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Projects one better-auth session row onto the published shape.
 *
 * The nullish coalescing is not defensive noise: it keeps every key present in
 * the JSON whatever the row holds. `undefined` disappears in serialization, and
 * a listing whose keys come and go with the data is one a client has to
 * feature-detect and a test cannot pin as an exact key set.
 */
export const toSessionSummary = (row: BetterAuthSession): SessionSummary => ({
  id: row.id,
  userId: row.userId,
  userAgent: row.userAgent ?? null,
  ipAddress: row.ipAddress ?? null,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});
