import { eq } from 'drizzle-orm';
import { account, user as userTable } from '../../auth/auth.schema';
import { isAgentUser } from '../../auth/user-kind';
import type { DrizzleDB } from '../../db/drizzle.module';
import { member } from '../../organizations/organizations.schema';

/**
 * The reason the SCIM plugin writes when it maps `active: false` onto the admin
 * plugin's ban (`resolveSCIMActiveDeactivation`). A ban carrying any other
 * reason was put there by someone else, and is not SCIM's to lift.
 */
export const SCIM_DEACTIVATION_REASON = 'Deactivated via SCIM';

/** The part of the matched user row the decision reads and the revival writes. */
interface MatchedUser {
  id: string;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | null;
}

/**
 * What a SCIM `DELETE` means here, and why a create against what it leaves
 * behind revives it.
 * Recorded as ADR-0022.
 *
 * **`DELETE /scim/v2/Users/:id` tombstones the user.** For an
 * organization-scoped token — which is every token `ScimService` issues — the
 * plugin removes the membership and the provider's account link and keeps the
 * `user` row, the way removing a member anywhere else in Cloudgate keeps it: the
 * row is what the audit trail's `user_id` and every other history column point
 * at. `GET` then answers 404, because the plugin finds a SCIM user through that
 * account link.
 *
 * **What it used to leave was a tombstone nothing could reach.** `POST` checks
 * for an existing `user` by email *before* it looks for a link, and refuses
 * `409 uniqueness` unless `linkExistingUsers` allows linking — which by default
 * it never does. So the same address was refused for ever while `GET` said the
 * person did not exist, and if they had been deactivated first the row still
 * carried the ban, which nothing in the console can lift. RFC 7644 §3.6 is
 * explicit that this is wrong: a deleted resource "SHALL NOT" be considered in
 * conflict calculation, and a create with its `userName` must not 409.
 *
 * **So a create links a tombstone, and only a tombstone**: a user with no
 * account of any kind and no membership anywhere. That is exactly what a SCIM
 * delete leaves, and it is safe to hand to a provider for the reason the
 * plugin's default refuses to link at all — linking by email alone gives a
 * token control of an account it never provisioned. A tombstone has no
 * credential, no SSO link and no organization, so there is nothing of anyone's
 * for the token to take over; it gets back an empty row with its old id, which
 * is what "the same person, rehired" should get. A user with a password, an SSO
 * link, another provider's link, or a seat in any organization still answers
 * 409, as before.
 *
 * **A revived tombstone is unbanned when its ban is SCIM's own.** The plugin
 * applies `active` only when a create says `false`, so a person deactivated and
 * then deleted would otherwise come back banned from a create that said `true` —
 * and the plugin would answer `active: false` to it. The ban is cleared on the
 * row the plugin is holding as well as in the table, because that object is the
 * one it goes on to build the response from. A create that says `active: false`
 * is re-banned by the plugin straight afterwards, as it would be for a new
 * user. A ban with any other reason is not SCIM's, so that user is refused as
 * before rather than silently reinstated.
 *
 * **An Agent is never revived**. An Agent is a user with no
 * account by construction, so one removed from its Organization — through the
 * Members route, say, rather than deleted — is exactly tombstone-shaped, and a
 * create for its address would hand the provider an Agent's row as a person.
 * Its address is in the reserved `.invalid` domain, so no real directory can
 * present it; this refusal is the half that does not depend on that. It is
 * read from the table rather than from `user`, because the plugin's row is
 * better-auth's shape and is not promised to carry Cloudgate's columns.
 *
 * Handed to `scim({ linkExistingUsers: { shouldLinkUser } })` in
 * `auth.config.ts`. The plugin only asks after the provider's token has
 * authenticated and the `(accountId, providerId)` link has been found absent.
 */
export function reviveScimTombstone(db: DrizzleDB) {
  return async ({ user }: { user: MatchedUser }): Promise<boolean> => {
    const [declared] = await db
      .select({ kind: userTable.kind })
      .from(userTable)
      .where(eq(userTable.id, user.id))
      .limit(1);
    if (!declared || isAgentUser(declared)) return false;
    const [anyAccount] = await db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.userId, user.id))
      .limit(1);
    if (anyAccount) return false;
    const [anyMembership] = await db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.userId, user.id))
      .limit(1);
    if (anyMembership) return false;

    if (!user.banned) return true;
    if (user.banReason !== SCIM_DEACTIVATION_REASON) return false;
    const lifted = { banned: false, banReason: null, banExpires: null };
    await db.update(userTable).set(lifted).where(eq(userTable.id, user.id));
    Object.assign(user, lifted);
    return true;
  };
}
