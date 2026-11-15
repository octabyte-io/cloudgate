import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import { LIVE_STAGES } from '../../bought-servers/bought-server-clock.service';
import { boughtServer } from '../../bought-servers/bought-server.schema';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  renderPlanCarriesOnEmail,
  renderPlanEndsEmail,
} from '../../mail/templates/plan-cancel';
import { cancelAtOf, PLAN_LABELS } from './billing.plans';
import type { PlanName } from './billing.plans';
import { subscription } from './billing.schema';
import { formatDate } from './lapse-notifications.service';
import type { LapseNotifications } from './lapse-notifications.service';

/**
 * A plan cancelled, or its cancel taken back (spec #69, #72), read off the
 * webhook sync's `cancelAt`: nothing → a date is a cancel, a date → nothing
 * is taken back. That one place covers the billing page at Stripe and the
 * trial's *Cancel trial* and *Keep <plan>*, which only ask Stripe. A date
 * moved to another date is neither.
 */
export type CancelChange =
  { kind: 'cancelled'; endsOn: Date } | { kind: 'taken-back' };

/** A subscription that has ended, or never began, has no cancel to change. */
const ENDED_STATUSES = new Set([
  'canceled',
  'incomplete',
  'incomplete_expired',
]);

/**
 * Claims the change of the cancel date with one conditional write on the
 * row, before the sync writes the rest, so a webhook retry or a second event
 * carrying the same state finds nothing to claim and sends nothing. Only the
 * subscription the row holds counts: a new one after a cancelled one ended
 * takes nothing back. Null when the cancel did not change.
 */
export async function claimCancelChange(
  db: DrizzleDB,
  organizationId: string,
  stripeSubscription: Stripe.Subscription,
): Promise<CancelChange | null> {
  if (ENDED_STATUSES.has(stripeSubscription.status)) return null;
  const cancelAt = cancelAtOf(stripeSubscription);
  const [claimed] = await db
    .update(subscription)
    .set({ cancelAt })
    .where(
      and(
        eq(subscription.organizationId, organizationId),
        eq(subscription.stripeSubscriptionId, stripeSubscription.id),
        cancelAt
          ? isNull(subscription.cancelAt)
          : isNotNull(subscription.cancelAt),
      ),
    )
    .returning({ id: subscription.id });
  if (!claimed) return null;
  return cancelAt
    ? { kind: 'cancelled', endsOn: cancelAt }
    : { kind: 'taken-back' };
}

/**
 * "Your plan ends on <date>", naming the Organization's live Bought Servers,
 * which are deleted that day with their data and backups, or "Your plan will
 * carry on": to every owner and admin, for a change
 * {@link claimCancelChange} just claimed. The 7-day Bought Server warning
 * before the day is its own email and stays.
 */
export async function notifyCancelChange(
  db: DrizzleDB,
  notifications: LapseNotifications,
  billingUrl: string,
  organizationId: string,
  plan: PlanName | null,
  change: CancelChange | null,
): Promise<void> {
  if (!change) return;
  const planLabel = plan ? PLAN_LABELS[plan] : null;
  if (change.kind === 'taken-back') {
    await notifications.sendToOwnersAndAdmins(
      organizationId,
      'plan carries on',
      (recipient, organizationName) =>
        renderPlanCarriesOnEmail({
          userName: recipient.name,
          organizationName,
          planLabel,
          billingUrl,
        }),
    );
    return;
  }

  const servers = await db
    .select({ name: boughtServer.name })
    .from(boughtServer)
    .where(
      and(
        eq(boughtServer.organizationId, organizationId),
        inArray(boughtServer.stage, [...LIVE_STAGES]),
      ),
    )
    .orderBy(asc(boughtServer.createdAt), asc(boughtServer.id));
  const endsOn = formatDate(change.endsOn);
  await notifications.sendToOwnersAndAdmins(
    organizationId,
    'plan ends',
    (recipient, organizationName) =>
      renderPlanEndsEmail({
        userName: recipient.name,
        organizationName,
        planLabel,
        endsOn,
        serverNames: servers.map((one) => one.name),
        billingUrl,
      }),
  );
}
