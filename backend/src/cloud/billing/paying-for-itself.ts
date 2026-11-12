import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';

import type { DrizzleDB } from '../../db/drizzle.module';
import { organization } from '../../organizations/organizations.schema';
import {
  alreadyOwnsOneReason,
  organizationLimit,
  refusalViewOf,
} from '../../organizations/organization-limit';
import type { RefusalView } from '../../organizations/organization-limit';
import { subscription } from './billing.schema';
import { organizationsPayingForThemselvesOwnedBy } from './paying-organization';

/**
 * **"Pay for it yourself"** (ADR-0059): an Attached Organization's own
 * owner takes it over through Checkout, with no Free trial. The one exception
 * to `PAID_BY_ANOTHER_ORGANIZATION`.
 *
 * - **Who:** the Attached Organization's owner, and nobody else; an admin is
 *   still refused with `PAID_BY_ANOTHER_ORGANIZATION`.
 * - **The one-per-person rule:** refused with 403 `ORGANIZATION_LIMIT` when
 *   that owner already owns another Organization that pays for itself.
 * - **When the link ends:** not at Checkout. Checkout marks the subscription
 *   (`link: 'paidForItself'` and the owner's id, next to `organizationId`),
 *   and the webhook clears the link once that subscription is `active` on
 *   the Organization's own row. Until then it stays in its payer's pool, and
 *   an abandoned or failed Checkout changes nothing.
 *
 * Plain functions over the tables, like `attached-refusals.ts`: Checkout and
 * the webhook each ask here, and neither injects the other.
 */

/** The subscription metadata `link` value Checkout sets: what the webhook ends. */
export const PAID_FOR_ITSELF = 'paidForItself';

/** The subscription metadata key carrying the owner who paid. */
export const PAID_FOR_ITSELF_OWNER_KEY = 'ownerId';

/** An Attached Organization, as "Pay for it yourself" needs it. */
export interface AttachedOwnership {
  ownerId: string;
  payingOrganizationId: string;
}

/** Who owns this Organization and who pays for it; null unless attached. */
export async function attachedOwnershipOf(
  db: DrizzleDB,
  organizationId: string,
): Promise<AttachedOwnership | null> {
  const [row] = await db
    .select({
      ownerId: organization.ownerId,
      payingOrganizationId: organization.paidByOrganizationId,
    })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  if (!row?.payingOrganizationId || !row.ownerId) return null;
  return {
    ownerId: row.ownerId,
    payingOrganizationId: row.payingOrganizationId,
  };
}

/**
 * Why this owner may not pay for this Organization themselves, or null when
 * they may: they already own another Organization that pays for itself (this
 * one never counts against itself).
 */
export async function whyOwnerCannotPayForIt(
  db: DrizzleDB,
  organizationId: string,
  ownerId: string,
  instanceOrganizationId: string | null,
): Promise<string | null> {
  const owned = await organizationsPayingForThemselvesOwnedBy(
    db,
    ownerId,
    instanceOrganizationId,
  );
  const other = owned.find((one) => one.id !== organizationId);
  if (!other) return null;
  return alreadyOwnsOneReason(other.name);
}

/** {@link whyOwnerCannotPayForIt}, refused with 403 `ORGANIZATION_LIMIT`. */
export async function assertOwnerMayPayForIt(
  db: DrizzleDB,
  organizationId: string,
  ownerId: string,
  instanceOrganizationId: string | null,
): Promise<void> {
  const reason = await whyOwnerCannotPayForIt(
    db,
    organizationId,
    ownerId,
    instanceOrganizationId,
  );
  if (reason) throw organizationLimit(reason);
}

/**
 * A detached Organization's owner, or null for any other: one that was once
 * attached (`firstAttachedAt`, never cleared) and pays for itself now — after
 * "Stop paying for it", or after its owner's own subscription ended the
 * link.
 */
async function onceAttachedOwnerOf(
  db: DrizzleDB,
  organizationId: string,
): Promise<{ ownerId: string; name: string } | null> {
  const [row] = await db
    .select({
      ownerId: organization.ownerId,
      name: organization.name,
      paidBy: organization.paidByOrganizationId,
      firstAttachedAt: subscription.firstAttachedAt,
    })
    .from(organization)
    .leftJoin(subscription, eq(subscription.organizationId, organization.id))
    .where(eq(organization.id, organizationId))
    .limit(1);
  if (!row?.ownerId || row.paidBy !== null || !row.firstAttachedAt) {
    return null;
  }
  return { ownerId: row.ownerId, name: row.name };
}

/**
 * Checkout on a **detached** Organization (story 37): its owner may pay
 * for it only while they own no other Organization that pays for itself —
 * the same rule, and the same sentence, as "Pay for it yourself", refused
 * with 403 `ORGANIZATION_LIMIT`. Once detached it counts as one its owner
 * pays for themselves, so the rule is asked of its owner whoever starts the
 * Checkout; an admin who is not the owner is told so without the other
 * Organization's name, which is the owner's to know.
 *
 * Nothing for an Organization never attached: the create refusal already
 * kept its owner to one.
 */
export async function assertDetachedMayBePaidFor(
  db: DrizzleDB,
  organizationId: string,
  readerId: string,
  instanceOrganizationId: string | null,
): Promise<void> {
  const detached = await onceAttachedOwnerOf(db, organizationId);
  if (!detached) return;
  const reason = await whyOwnerCannotPayForIt(
    db,
    organizationId,
    detached.ownerId,
    instanceOrganizationId,
  );
  if (reason === null) return;
  throw organizationLimit(
    detached.ownerId === readerId
      ? reason
      : `${detached.name}'s owner already owns another Organization that pays for itself, and a person can own one`,
  );
}

/**
 * "Pay for it yourself" on an Attached Organization's Billing page, for its
 * owner: whether it is offered and why not, in the refusal's words. Null for
 * anyone else, who is not offered it at all.
 */
export type PayForItYourselfView = RefusalView;

export async function payForItYourselfOf(
  db: DrizzleDB,
  organizationId: string,
  readerId: string,
  instanceOrganizationId: string | null,
): Promise<PayForItYourselfView | null> {
  const attached = await attachedOwnershipOf(db, organizationId);
  if (!attached || attached.ownerId !== readerId) return null;
  const reason = await whyOwnerCannotPayForIt(
    db,
    organizationId,
    readerId,
    instanceOrganizationId,
  );
  return refusalViewOf(reason);
}

/** The subscription metadata Checkout adds for the owner paying. */
export function paidForItselfMetadata(ownerId: string): Record<string, string> {
  return { link: PAID_FOR_ITSELF, [PAID_FOR_ITSELF_OWNER_KEY]: ownerId };
}

/** A link this subscription just ended: who paid for it, and who took it over. */
export interface EndedLink {
  payingOrganizationId: string;
  /** The owner Checkout named; null when the metadata carries none. */
  ownerId: string | null;
}

/**
 * Ends the link once the owner's own subscription has started: a
 * subscription Checkout marked `paidForItself`, now `active`, on an
 * Organization still attached. One conditional write on the payer it was
 * attached to, so two events that both carry the active subscription end it
 * once. Null when nothing ended.
 */
export async function endLinkPaidForItself(
  db: DrizzleDB,
  organizationId: string,
  stripeSubscription: Stripe.Subscription,
): Promise<EndedLink | null> {
  const metadata = stripeSubscription.metadata ?? {};
  if (metadata.link !== PAID_FOR_ITSELF) return null;
  if (stripeSubscription.status !== 'active') return null;
  const attached = await attachedOwnershipOf(db, organizationId);
  if (!attached) return null;
  const [ended] = await db
    .update(organization)
    .set({ paidByOrganizationId: null })
    .where(
      and(
        eq(organization.id, organizationId),
        eq(organization.paidByOrganizationId, attached.payingOrganizationId),
      ),
    )
    .returning({ id: organization.id });
  if (!ended) return null;
  return {
    payingOrganizationId: attached.payingOrganizationId,
    ownerId: metadata[PAID_FOR_ITSELF_OWNER_KEY] || null,
  };
}
