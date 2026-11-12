import type { PlanName } from '../../src/cloud/billing/billing.plans';
import { subscription } from '../../src/cloud/billing/billing.schema';
import type { TestAppContext } from './test-app';

type SubscriptionRow = typeof subscription.$inferInsert;

/**
 * Arrangement only: the Organization holds `plan`, Starter or Business,
 * under Stripe status `status` (active unless named), as the subscription
 * webhook would have left its row — without driving Stripe. `extra` sets any
 * other column of the row (Add-ons, the Stripe ids, the lapse marks).
 *
 * The Enterprise marker is the Operator's, so it is `givenEnterprise`'s in the
 * spec that needs it, not this helper's; pass `{ enterprise: true }` to have
 * both.
 */
export async function givenPlan(
  ctx: TestAppContext,
  organizationId: string,
  plan: PlanName,
  status = 'active',
  extra: Partial<Omit<SubscriptionRow, 'organizationId'>> = {},
): Promise<void> {
  const values = {
    stripeCustomerId: `cus_${organizationId}`,
    stripeSubscriptionId: `sub_${organizationId}`,
    ...extra,
    plan,
    status,
  };
  await ctx.db
    .insert(subscription)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: subscription.organizationId, set: values });
}
