import { and, eq, inArray, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  grantsPaidFeatures,
  PLAN_GRANTING_STATUSES,
} from './billing-allowance';
import { subscription } from './billing.schema';
import { payingOrganizationOf } from './paying-organization';

/**
 * The Enterprise marker, read (CONTEXT.md, ADR-0048): an Organization on
 * the Hosted instance billed by agreement outside Stripe, set only by an
 * Operator; `allowanceOf` gives it the hand-set counts stored beside it.
 *
 * In hosted mode the paid-feature gates (`LicenseService.hasValidLicense`) ask,
 * in place of a license key, whether the Organization is on Business or
 * Enterprise (ADR-0054): `holdsBusiness`, where Enterprise always counts as
 * Business. `isEnterprise` stays for what only the marker decides.
 *
 * Plain functions over the `subscription` row rather than a BillingService
 * method: `LicenseService` asks them, and `PermissionService` (which
 * BillingService injects) injects `LicenseService`, so going through
 * BillingService would close a cycle.
 */

/** Whether this Organization carries the Enterprise marker. */
export async function isEnterprise(
  db: DrizzleDB,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ enterprise: subscription.enterprise })
    .from(subscription)
    .where(eq(subscription.organizationId, organizationId))
    .limit(1);
  return !!row?.enterprise;
}

/**
 * Whether this Organization has ever carried the Enterprise marker, whether or
 * not it still does: `firstEnterpriseAt`, which switching Enterprise
 * on sets once and nothing clears. An Organization that was ever Enterprise
 * gets no free trial (ADR-0054).
 */
export async function hasBeenEnterprise(
  db: DrizzleDB,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ firstEnterpriseAt: subscription.firstEnterpriseAt })
    .from(subscription)
    .where(eq(subscription.organizationId, organizationId))
    .limit(1);
  return !!row?.firstEnterpriseAt;
}

/**
 * Whether this Organization is on Business or Enterprise: the Hosted answer to
 * the paid-feature check (ADR-0054). Starter does not pass it, nor a Business
 * subscription whose status no longer grants the plan.
 *
 * Read off its **Paying Organization** (`paying-organization.ts`), the same
 * step the counts check takes: an Attached Organization of a Business or
 * Enterprise payer gets the paid features, and its own row is never read
 * (ADR-0059).
 */
export async function holdsBusiness(
  db: DrizzleDB,
  organizationId: string,
): Promise<boolean> {
  const paying = await payingOrganizationOf(db, organizationId);
  return grantsPaidFeatures(paying.subscription);
}

/**
 * `holdsBusiness` as a condition on `subscription` rows, for the queries that
 * ask it of many Organizations at once: Enterprise, or Business under a status
 * that grants the plan.
 */
export function businessHeld(): SQL {
  return or(
    eq(subscription.enterprise, true),
    and(
      eq(subscription.plan, 'business'),
      inArray(subscription.status, [...PLAN_GRANTING_STATUSES]),
    ),
  )!;
}

/** Whether any Organization on this instance is on Business or Enterprise. */
export async function anyBusiness(db: DrizzleDB): Promise<boolean> {
  const [row] = await db
    .select({ id: subscription.id })
    .from(subscription)
    .where(businessHeld())
    .limit(1);
  return !!row;
}
