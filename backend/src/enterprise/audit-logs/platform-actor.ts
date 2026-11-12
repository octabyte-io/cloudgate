/**
 * **The platform as an audit actor**: the shape of a row written with no
 * caller (ADR-0026's platform-actor pin).
 *
 * The first such row is the expiry sweep's: when a Requested preview's copy is
 * really gone, the platform writes the one `delete previewDeployment` that
 * says so. There is no member to name. The requester may be an Agent that has
 * since been deleted, and even when it is not, it did not do this. So the row
 * names the platform: **no user id, no email, role {@link PLATFORM_ACTOR_ROLE}
 * and name {@link PLATFORM_ACTOR_NAME}**, written through
 * `AuditLogService.recordAsPlatform`, which never looks a member up. Whoever
 * the act was on behalf of goes in `metadata` (the sweep's `requesterId` and
 * `requesterName`), never in the actor columns.
 *
 * **The next writer with no caller reuses this** (a cron, a boot hook, a
 * reconciler) rather than inventing a second spelling of "nobody did it".
 *
 * **No email, rather than a fixed one.** `audit_log.user_email` is nullable
 * for this row alone. A fixed address would be an identity the trail's
 * "Email contains" filter could match and a reader could take for a person's,
 * which is the synthetic-address trap already closed for Agents.
 *
 * `system` must never be a role a Member holds, or a person's row and the
 * platform's could not be told apart by the role, which is how the console
 * reads them. Three places hold that: the `member_role_is_not_the_platform`
 * check on `member` (every row, better-auth's own included),
 * `member-role.ts`' `assertRoleFitsKind` (every role Cloudgate writes or
 * invites to, refused with a sentence), and the custom-role name schema (no
 * role can be named it).
 *
 * **A platform row is told by its whole shape, not by the role alone.** Those
 * three hold from `0080` on, and not before it: an install could already have
 * a custom role named `system` with Members on it, and their audit rows carry
 * that role with a user id and an address. `0080` renames such a role
 * (`system-renamed`, its holders and pending invitations with it) so that its
 * check can apply at all, but it does not rewrite the trail, which records the
 * role as it was at the time. So `GET /audit-logs?actor=platform` and the
 * console's `auditActor` both ask for **no user id, no email and role
 * `system`** together. The email is part of the test because the user id is
 * not enough on its own: `audit_log.user_id` is `ON DELETE SET NULL`, so a
 * deleted person's row loses its id and keeps its address.
 */

/** The role a platform-written audit row records. Held by no Member. */
export const PLATFORM_ACTOR_ROLE = 'system';

/** The name a platform-written audit row records. */
export const PLATFORM_ACTOR_NAME = 'Cloudgate';
