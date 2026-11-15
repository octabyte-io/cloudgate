import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/drizzle.module';
import { subscription } from './billing.schema';

/** What "you stay on Business" needs, read off the row as the clear found it. */
export interface KeptBusiness {
  organizationId: string;
  addOns: number;
  /** The day the move would have happened. */
  movesOn: Date | null;
}

/**
 * Forgets a waiting downgrade's schedule that was released before its move
 * to Starter — a Keep Business — in one conditional clear on the schedule id,
 * and answers what was cleared, or null when another clear got there first.
 *
 * Both of Keep Business's clears call it: `BillingService.keepBusiness`'s,
 * after it released the schedule at Stripe, and the
 * `subscription_schedule.released` webhook's, which may arrive before that
 * one. Whichever finds the schedule sends "you stay on Business", once.
 * `organizationId` narrows it to the one Organization when the caller knows
 * it; the webhook knows only the schedule.
 */
export async function forgetKeptSchedule(
  db: DrizzleDB,
  organizationId: string | null,
  scheduleId: string,
): Promise<KeptBusiness | null> {
  return db.transaction(async (tx) => {
    const where = and(
      eq(subscription.stripeScheduleId, scheduleId),
      eq(subscription.enterprise, false),
      ...(organizationId
        ? [eq(subscription.organizationId, organizationId)]
        : []),
    );
    const [row] = await tx
      .select({
        organizationId: subscription.organizationId,
        addOns: subscription.addOns,
        movesOn: subscription.downgradeAt,
      })
      .from(subscription)
      .where(where)
      .for('update');
    if (!row) return null;
    await tx
      .update(subscription)
      .set({ stripeScheduleId: null, downgradeAt: null })
      .where(
        and(
          eq(subscription.organizationId, row.organizationId),
          eq(subscription.stripeScheduleId, scheduleId),
        ),
      );
    return row;
  });
}
