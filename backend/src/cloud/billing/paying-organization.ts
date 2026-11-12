import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { DrizzleDB } from '../../db/drizzle.module';
import { cloudEnvironmentsOf } from '../../environments/cloud-environments';
import type { NamedOrganization } from '../../organizations/organization-name';
import { organization } from '../../organizations/organizations.schema';
import { boughtServer } from '../../bought-servers/bought-server.schema';
import { server } from '../../servers/server.schema';
import { allowanceOf } from './billing-allowance';
import type { Allowance, Usage } from './billing-allowance';
import { subscription } from './billing.schema';
import type { Subscription } from './billing.schema';

/**
 * **Finding the Paying Organization**, and **the pool** it pays for
 * (CONTEXT.md, ADR-0059).
 *
 * An Organization's Paying Organization is the one it is attached to, or
 * itself when it is not attached. That one Organization's plan, Add-ons or
 * Enterprise counts are what every Organization on it may hold, together: its
 * own usage plus every Attached Organization's is one pool. Everything that
 * asks "what does this Organization's plan grant" asks here — the counts check
 * (`BillingService.allowanceFor`), the paid features (`holdsBusiness`), and
 * the Billing views and the Operator's counts after them — so the counts and
 * the paid features can never disagree about who pays.
 *
 * Plain functions over the tables, like `enterprise.ts` and `free-trial.ts`:
 * `LicenseService` asks for the paid features, and it cannot inject
 * BillingService without closing a cycle.
 *
 * Rejected: copying the payer's plan onto each Attached Organization's own
 * `subscription` row. Every payment, lapse and Operator switch would then have
 * to fan out its write, and one missed copy is an Organization granted a plan
 * nobody pays for. The link is read, never copied.
 */

/** Who pays for an Organization, and what that payer holds. */
export interface PayingOrganization {
  /** The Organization asked about. */
  organizationId: string;
  /** Its Paying Organization: the one it is attached to, or itself. */
  payingOrganizationId: string;
  /** Whether it is an Attached Organization, paid for by another. */
  attached: boolean;
  /**
   * The Paying Organization's `subscription` row, null with none: what grants
   * the counts and the paid features. An Attached Organization's own row is
   * never this — while it is attached nothing reads its own plan.
   */
  subscription: Subscription | null;
}

/**
 * The Paying Organization of an `organization` row, as SQL, for a query over
 * many Organizations at once: its `paid_by_organization_id`, or its own id.
 */
export const payingOrganizationIdSql: SQL<string> = sql<string>`coalesce(${organization.paidByOrganizationId}, ${organization.id})`;

/**
 * The `organization` table a second time, as the Paying Organization: join it
 * on `eq(payer.id, organization.paidByOrganizationId)` to read an Attached
 * Organization's payer in the query that reads the Organization itself.
 */
export const payer = alias(organization, 'payer');

/**
 * The one "find the Paying Organization" step: the Organization it is
 * attached to, or itself, with that payer's `subscription` row — one query.
 * An Organization that does not exist pays for itself and holds nothing.
 */
export async function payingOrganizationOf(
  db: DrizzleDB,
  organizationId: string,
): Promise<PayingOrganization> {
  const [row] = await db
    .select({ paidBy: organization.paidByOrganizationId, subscription })
    .from(organization)
    .leftJoin(
      subscription,
      eq(subscription.organizationId, payingOrganizationIdSql),
    )
    .where(eq(organization.id, organizationId))
    .limit(1);
  const payingOrganizationId = row?.paidBy ?? organizationId;
  return {
    organizationId,
    payingOrganizationId,
    attached: payingOrganizationId !== organizationId,
    subscription: row?.subscription ?? null,
  };
}

/** One Organization's part of a pool's usage. */
export interface PoolShare extends Usage {
  organizationId: string;
}

/** A Paying Organization's pool: what it allows, and who uses how much. */
export interface Pool {
  /** The Organization asked about, and who pays for it. */
  paying: PayingOrganization;
  /** What the Paying Organization's plan, Add-ons or Enterprise counts allow. */
  allowance: Allowance;
  /** What the whole pool holds: every share added up. */
  usage: Usage;
  /**
   * Each Organization on the pool and what it holds, the Paying Organization
   * first and then its Attached Organizations oldest first. Its own share
   * against the others' is what the Billing page shows, and the Operator page
   * reads its pool counts off the same rows.
   */
  shares: PoolShare[];
}

/**
 * The pool an Organization is on: its Paying Organization's allowance, and
 * the usage of the Paying Organization and every Organization attached to it.
 * An Organization with nothing attached is a pool of one, which is exactly
 * what it was before Attached Organizations existed.
 */
export async function poolOf(
  db: DrizzleDB,
  organizationId: string,
): Promise<Pool> {
  const paying = await payingOrganizationOf(db, organizationId);
  const shares = await poolSharesOf(db, paying.payingOrganizationId);
  return {
    paying,
    allowance: allowanceOf(paying.subscription),
    usage: totalOf(shares),
    shares,
  };
}

/**
 * What each of these Organizations holds: its Server rows, grouped in one
 * query, with each Bought Server not yet made (waiting for payment or being
 * created, so it has no Server row yet: ADR-0071 counts it from Buy), and
 * its Cloud Environments as `cloudEnvironmentsOf` counts them.
 * One share per id asked for, in the order asked, zero for one holding
 * nothing.
 */
export async function usageByOrganization(
  db: DrizzleDB,
  organizationIds: readonly string[],
): Promise<PoolShare[]> {
  if (organizationIds.length === 0) return [];
  const ids = [...new Set(organizationIds)];
  const [servers, unmade, clouds] = await Promise.all([
    db
      .select({ organizationId: server.organizationId, count: count() })
      .from(server)
      .where(inArray(server.organizationId, ids))
      .groupBy(server.organizationId),
    db
      .select({ organizationId: boughtServer.organizationId, count: count() })
      .from(boughtServer)
      .where(
        and(
          inArray(boughtServer.organizationId, ids),
          isNull(boughtServer.serverId),
          inArray(boughtServer.stage, ['waiting_for_payment', 'creating']),
        ),
      )
      .groupBy(boughtServer.organizationId),
    cloudEnvironmentsOf(db, ids),
  ]);
  const countOf = (
    rows: Array<{ organizationId: string; count: number }>,
    organizationId: string,
  ) => rows.find((row) => row.organizationId === organizationId)?.count ?? 0;
  return ids.map((organizationId) => ({
    organizationId,
    servers: countOf(servers, organizationId) + countOf(unmade, organizationId),
    cloudEnvironments: clouds.filter(
      (one) => one.organizationId === organizationId,
    ).length,
  }));
}

/** Nothing held: the usage of an Organization with no Server and no Cloud Environment. */
export const NO_USAGE: Readonly<Usage> = Object.freeze({
  servers: 0,
  cloudEnvironments: 0,
});

/** Every share added up. */
export function totalOf(shares: readonly Usage[]): Usage {
  return shares.reduce<Usage>(
    (total, share) => ({
      servers: total.servers + share.servers,
      cloudEnvironments: total.cloudEnvironments + share.cloudEnvironments,
    }),
    { ...NO_USAGE },
  );
}

/**
 * One Organization's own share of its pool: what it holds itself, or
 * nothing when it is not on this pool.
 */
export function shareOf(
  pool: Pick<Pool, 'shares'>,
  organizationId: string,
): Usage {
  const share = pool.shares.find(
    (one) => one.organizationId === organizationId,
  );
  return {
    servers: share?.servers ?? NO_USAGE.servers,
    cloudEnvironments: share?.cloudEnvironments ?? NO_USAGE.cloudEnvironments,
  };
}

/**
 * The shares of the pool a Paying Organization pays for: itself first, then
 * the Organizations attached to it, oldest first.
 */
async function poolSharesOf(
  db: DrizzleDB,
  payingOrganizationId: string,
): Promise<PoolShare[]> {
  const members = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(payingOrganizationIdSql, payingOrganizationId))
    .orderBy(
      desc(eq(organization.id, payingOrganizationId)),
      asc(organization.createdAt),
      asc(organization.id),
    );
  // A payer that no longer exists is still asked about by its own id, so the
  // pool is never empty and its usage reads as zero rather than failing.
  const ids = members.length
    ? members.map((row) => row.id)
    : [payingOrganizationId];
  return usageByOrganization(db, ids);
}

/**
 * **"Owns an Organization that pays for itself"** (ADR-0059): the
 * Organizations this person owns that are not attached and are not the
 * Instance organization, oldest first — one query, over the index on
 * `organization.owner_id`. Non-empty means they already own one.
 *
 * Whether it holds a plan does not matter: an Organization with no plan
 * counts, and so does a detached, lapsed one, since its owner can still pay
 * for it. Attached Organizations never count, so being someone's client does
 * not use up a person's own slot.
 *
 * `instanceOrganizationId` is `PermissionService.instanceOrganizationId()`'s
 * answer, passed in rather than re-derived here: that definition is a
 * decision (ADR-0013), and a second copy of it would be a second decision.
 * The create refusal and Checkout are its callers.
 */
export async function organizationsPayingForThemselvesOwnedBy(
  db: DrizzleDB,
  userId: string,
  instanceOrganizationId: string | null,
): Promise<NamedOrganization[]> {
  return db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(
      and(
        eq(organization.ownerId, userId),
        isNull(organization.paidByOrganizationId),
        instanceOrganizationId
          ? ne(organization.id, instanceOrganizationId)
          : undefined,
      ),
    )
    .orderBy(asc(organization.createdAt), asc(organization.id));
}

/**
 * The Organizations attached to this one, oldest first: none for an
 * Organization that pays only for itself, or that is attached itself. What
 * `ORGANIZATIONS_ATTACHED` names (`attached-refusals.ts`), and the list the
 * "Before <Paying> can move to Starter" checklist starts from.
 */
export async function organizationsAttachedTo(
  db: DrizzleDB,
  payingOrganizationId: string,
): Promise<NamedOrganization[]> {
  return db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(eq(organization.paidByOrganizationId, payingOrganizationId))
    .orderBy(asc(organization.createdAt), asc(organization.id));
}
