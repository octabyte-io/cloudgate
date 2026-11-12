import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { invitation, organization } from '../db/schema';

/**
 * What a signed-out visitor to an invitation link may learn about it.
 *
 * `/accept-invitation/:id` and `/sign-up?invitation=:id` used to say "You have
 * been invited" for any id at all and let a made-up one fill in the whole
 * sign-up form before `assertSignUpAllowed` refused it. better-auth's own
 * `getInvitation` needs a session and the recipient's address, so nothing
 * could be asked before the form.
 *
 * **An open invitation names its Organization and its address; nothing else
 * names anything.** The id is the credential — it is what an invited sign-up
 * carries in `x-cloudgate-token` — so whoever holds a live one may see what it
 * was sent for, which is what the email holding it already said. A closed or
 * unknown id answers only that it is not open (or, for a pending one past its
 * date, that it expired), so a guessed or stale id learns no Organization and
 * no address.
 */
export type InvitationPreview =
  | { open: true; organizationName: string; email: string }
  | { open: false; code: 'INVITATION_EXPIRED' | 'INVITATION_NOT_OPEN' };

/** The decision, apart from the read, so it can be checked without a database. */
export function previewOf(
  row:
    | {
        status: string;
        expiresAt: Date;
        email: string;
        organizationName: string;
      }
    | undefined,
  now: Date = new Date(),
): InvitationPreview {
  if (!row || row.status !== 'pending') {
    return { open: false, code: 'INVITATION_NOT_OPEN' };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { open: false, code: 'INVITATION_EXPIRED' };
  }
  return {
    open: true,
    organizationName: row.organizationName,
    email: row.email,
  };
}

export async function readInvitationPreview(
  db: DrizzleDB,
  invitationId: string,
): Promise<InvitationPreview> {
  const [row] = await db
    .select({
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      email: invitation.email,
      organizationName: organization.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(eq(invitation.id, invitationId))
    .limit(1);
  return previewOf(row);
}
