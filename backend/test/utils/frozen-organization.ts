import { eq } from 'drizzle-orm';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import type { TestAppContext } from './test-app';

/**
 * Arrangement only: the Organization frozen as a lapse leaves it on
 * the Hosted instance (ADR-0052) — the instance read as hosted for the rest
 * of the test, and a Starter plan whose subscription Stripe deleted. Restore
 * the instance mode with `jest.restoreAllMocks()`.
 *
 * For a spec written against a Self-hosted instance, whose own arrangement
 * already proves the work runs when nothing is frozen. A hosted spec
 * (`useHostedMode`) gets the same lapse from the billing webhook instead.
 */
export async function freezeOrganization(
  ctx: TestAppContext,
  organizationId: string,
): Promise<void> {
  jest
    .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
    .mockReturnValue(true);
  const lapsedAt = new Date();
  await ctx.db
    .insert(subscription)
    .values({ organizationId, plan: 'starter', status: 'canceled', lapsedAt })
    .onConflictDoUpdate({
      target: subscription.organizationId,
      set: { plan: 'starter', status: 'canceled', lapsedAt },
    });
}

/** Arrangement only: paid again, as a new active subscription leaves it. */
export async function thawOrganization(
  ctx: TestAppContext,
  organizationId: string,
): Promise<void> {
  await ctx.db
    .update(subscription)
    .set({ status: 'active', lapsedAt: null })
    .where(eq(subscription.organizationId, organizationId));
}
