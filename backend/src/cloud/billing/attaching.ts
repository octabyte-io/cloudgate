import { and, asc, count, eq, inArray } from 'drizzle-orm';

import { user } from '../../auth/auth.schema';
import { boughtServer } from '../../bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../../bought-servers/bought-server.schema';
import type { DrizzleDB } from '../../db/drizzle.module';
import { organization } from '../../organizations/organizations.schema';
import {
  onBusinessUpsell,
  refusalViewOf,
} from '../../organizations/organization-limit';
import type { RefusalView } from '../../organizations/organization-limit';
import {
  organizationNameOf,
  UNKNOWN_ORGANIZATION_NAME,
} from '../../organizations/organization-name';
import { allowanceOf } from './billing-allowance';
import type { Allowance, AllowanceSource, Usage } from './billing-allowance';
import { subscription } from './billing.schema';
import { scheduledMoveOf } from './plan-downgrade';
import { payer, poolOf, shareOf } from './paying-organization';

/**
 * **"Add an Organization to this plan"** (ADR-0059): whether the open
 * Organization may pay for a new one, and what its Billing page lists of the
 * ones it already pays for.
 *
 * Plain functions over the tables, like `paying-organization.ts` and
 * `attached-refusals.ts`, so `OrganizationsService.create` — which writes the
 * link in the transaction that makes the Organization — and the Billing page's
 * read ask the one question in the one order, and the button and the route can
 * never disagree.
 *
 * The caller's role is not asked here. It is asked **first**, by each caller,
 * before anything about the plan is said to someone who may not see it.
 */

/** What decides whether an Organization may pay for another. */
export interface AttachStanding {
  /** The open Organization's name. */
  name: string;
  /** The name of the Organization that pays for it, when it is attached. */
  paidBy: string | null;
  /** What its plan grants now: Starter, Business, Enterprise, or nothing. */
  plan: AllowanceSource | null;
  /** A move to Starter waits for the end of the paid month. */
  movingToStarter: boolean;
}

/**
 * Why `standing`'s Organization cannot pay for a new one, or null when it can:
 * on Business or Enterprise, Free trial included, and not attached itself.
 *
 * A Business Organization whose move to Starter is waiting is refused too.
 * The move to Starter is refused while anything is attached, but a move set
 * *before* the first attach would otherwise go through at the month's end and
 * leave Starter paying for others. Refusing here, rather than cancelling the
 * move, keeps a billing decision its owner made from being undone by a side
 * effect; "Keep Business" is one click.
 */
export function attachRefusalOf(standing: AttachStanding): string | null {
  const { name } = standing;
  if (standing.paidBy !== null) {
    return `${name} is paid for by ${standing.paidBy}, and an Organization that is paid for cannot pay for others`;
  }
  const upsell = onBusinessUpsell(name);
  if (standing.plan === null) return `${name} has no plan. ${upsell}`;
  if (standing.plan === 'starter') {
    return `${name} is on Starter, which pays for one Organization. ${upsell}`;
  }
  if (standing.movingToStarter) {
    return `${name} moves to Starter at the end of its paid month. Keep Business to add an Organization to its plan`;
  }
  return null;
}

/** What `allowance` leaves of `usage` for one more, per counted kind. */
export function roomLeftOf(allowance: Allowance, usage: Usage): Usage {
  return {
    servers: Math.max(0, allowance.servers - usage.servers),
    cloudEnvironments: Math.max(
      0,
      allowance.cloudEnvironments - usage.cloudEnvironments,
    ),
  };
}

/**
 * {@link attachRefusalOf} for an Organization as the tables hold it, in one
 * query that reads the "paid by" link once: its name, its payer's name when
 * it is attached, and its own `subscription` row, which is its plan when it
 * pays for itself. Null when it may pay for a new one.
 */
export async function whyCannotAttachTo(
  db: DrizzleDB,
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      name: organization.name,
      paidById: organization.paidByOrganizationId,
      paidBy: payer.name,
      subscription,
    })
    .from(organization)
    .leftJoin(payer, eq(payer.id, organization.paidByOrganizationId))
    .leftJoin(subscription, eq(subscription.organizationId, organization.id))
    .where(eq(organization.id, organizationId))
    .limit(1);
  // An attached Organization is refused for being attached, whatever its own
  // row holds: while attached nothing reads its own plan.
  const attached = !!row?.paidById;
  const own = attached ? null : (row?.subscription ?? null);
  return attachRefusalOf({
    name: row?.name ?? UNKNOWN_ORGANIZATION_NAME,
    paidBy: attached ? (row?.paidBy ?? UNKNOWN_ORGANIZATION_NAME) : null,
    plan: allowanceOf(own).plan,
    movingToStarter: scheduledMoveOf(own) !== null,
  });
}

/** One row of the "Organizations on this plan" card. */
export interface AttachedOrganizationRow {
  id: string;
  name: string;
  /** Its owner, as the Paying Organization's people may see them. */
  owner: { name: string; email: string } | null;
  /**
   * Whether the person reading owns it: the move-to-Starter checklist offers
   * **Delete** for theirs alone, as `DELETE /organizations/:id` would refuse
   * anyone else.
   */
  ownedByYou: boolean;
  servers: number;
  cloudEnvironments: number;
  /**
   * Its **Bought Servers** whose machines exist: what "Stop paying for it"
   * deletes at once unless it pays for itself first (ADR-0071, story 71).
   */
  boughtServers: number;
  /** When it was made, ISO 8601. */
  createdAt: string;
}

/** The stages a Bought Server's machine exists in: what a lapse deletes. */
const LIVE_BOUGHT_SERVER_STAGES: readonly BoughtServerStage[] = [
  'creating',
  'setting_up',
  'ready',
  'changing',
];

/**
 * `GET /billing/attached-organizations`: whether "Add an Organization to this
 * plan" is offered and why not (`allowed`, `reason`, and `ORGANIZATION_LIMIT`
 * as `code` when refused — whether `POST /organizations` with `paidBy` would
 * accept the reader now), how much of the pool is free for the new one, and
 * each Organization this one pays for, oldest first.
 */
export interface AttachedOrganizationsView extends RefusalView {
  /**
   * The open Organization's name: the "Before <name> can move to Starter"
   * checklist's.
   */
  name: string;
  /** What the pool has room for: what the Add dialog says is free. */
  free: Usage;
  organizations: AttachedOrganizationRow[];
}

/**
 * {@link AttachedOrganizationsView} for `organizationId`, as `readerId` reads
 * it. Its rows are the pool's own shares, so the card and the counts check
 * read one usage; an Organization attached to nothing lists none.
 */
export async function attachedOrganizationsOf(
  db: DrizzleDB,
  organizationId: string,
  readerId: string,
): Promise<AttachedOrganizationsView> {
  const [reason, pool, name, attached, bought] = await Promise.all([
    whyCannotAttachTo(db, organizationId),
    poolOf(db, organizationId),
    organizationNameOf(db, organizationId),
    db
      .select({
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt,
        ownerId: organization.ownerId,
        ownerFirstName: user.firstName,
        ownerLastName: user.lastName,
        ownerEmail: user.email,
      })
      .from(organization)
      .leftJoin(user, eq(user.id, organization.ownerId))
      .where(eq(organization.paidByOrganizationId, organizationId))
      .orderBy(asc(organization.createdAt), asc(organization.id)),
    db
      .select({ organizationId: boughtServer.organizationId, held: count() })
      .from(boughtServer)
      .innerJoin(organization, eq(organization.id, boughtServer.organizationId))
      .where(
        and(
          eq(organization.paidByOrganizationId, organizationId),
          inArray(boughtServer.stage, [...LIVE_BOUGHT_SERVER_STAGES]),
        ),
      )
      .groupBy(boughtServer.organizationId),
  ]);
  const boughtBy = new Map(bought.map((row) => [row.organizationId, row.held]));
  return {
    name,
    ...refusalViewOf(reason),
    free: roomLeftOf(pool.allowance, pool.usage),
    organizations: attached.map((row) => ({
      id: row.id,
      name: row.name,
      owner:
        row.ownerEmail === null
          ? null
          : {
              name: [row.ownerFirstName, row.ownerLastName]
                .filter((part) => !!part)
                .join(' '),
              email: row.ownerEmail,
            },
      ownedByYou: row.ownerId === readerId,
      ...shareOf(pool, row.id),
      boughtServers: boughtBy.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
