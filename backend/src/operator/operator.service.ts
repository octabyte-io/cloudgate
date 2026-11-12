import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { addDays } from 'date-fns';
import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { user } from '../auth/auth.schema';
import { assertNotPaidByAnother } from '../cloud/billing/attached-refusals';
import { allowanceOf } from '../cloud/billing/billing-allowance';
import { subscription } from '../cloud/billing/billing.schema';
import { BoughtServerClockSteps } from '../cloud/billing/bought-server-clock-steps';
import { isTrialStatus, trialUsedOf } from '../cloud/billing/free-trial';
import { DELETION_AFTER_DAYS } from '../cloud/billing/lapse-clock';
import { LapseNotifications } from '../cloud/billing/lapse-notifications.service';
import {
  NO_USAGE,
  payingOrganizationIdSql,
  poolOf,
  shareOf,
} from '../cloud/billing/paying-organization';
import type { Pool } from '../cloud/billing/paying-organization';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import type { NamedOrganization } from '../organizations/organization-name';
import { member, organization } from '../organizations/organizations.schema';
import { PermissionService } from '../rbac/permission.service';
import type { SetEnterprise } from './dto/set-enterprise.dto';
import {
  attachedStateOf,
  operatorPlanOf,
  operatorStateOf,
} from './operator-state';
import type {
  OperatorPlan,
  OperatorState,
  OperatorStateFacts,
} from './operator-state';

/** What the caller is told when they are not an Operator. */
export const OPERATOR_REFUSAL =
  'Only an owner or admin of the Instance organization can use the Operator page';

/** Who is asking: the authority is the person's, whichever Organization is active. */
export interface OperatorCtx {
  user: { id: string };
  /** The caller's address, for the audit rows a write leaves. */
  ip?: string;
}

/** Suspending the Instance organization would freeze the box's own management. */
export const INSTANCE_ORGANIZATION_SUSPENSION_REFUSAL =
  'The Instance organization cannot be suspended';

/**
 * The role an Operator's row records in the target Organization's log, where
 * the Operator holds no role. What marks the row as Octabyte's is
 * {@link OCTABYTE_MARK} in its metadata, which no customer write can put there:
 * `AuditInterceptor` never copies a request body into a row.
 */
export const OPERATOR_AUDIT_ROLE = 'operator';

/** The metadata that marks an audit row as written by Octabyte (ADR-0050). */
export const OCTABYTE_MARK = { actedBy: 'Octabyte' } as const;

/** The code of the refusal to switch Enterprise on over a live subscription. */
export const STRIPE_SUBSCRIPTION_ACTIVE = 'STRIPE_SUBSCRIPTION_ACTIVE';

/**
 * The Stripe statuses of a subscription that has ended and will never bill
 * again. Any other — `past_due`, `unpaid` and `paused` included — can still
 * charge the card, so Enterprise on top of it could bill the customer twice.
 */
const ENDED_STRIPE_STATUSES = ['canceled', 'incomplete_expired'];

/** The Enterprise marker and its counts, after an Operator's switch. */
export interface EnterpriseView {
  enterprise: boolean;
  servers: number;
  cloudEnvironments: number;
}

/** A suspension as the Operator page shows it; null when there is none. */
export interface SuspensionView {
  reason: string;
  suspendedAt: Date;
}

/** One counted kind: what the Organization holds against what it may hold. */
export interface CountView {
  used: number;
  allowed: number;
}

/**
 * One Organization as the Operator page lists it — its account facts and
 * nothing from inside a Project (ADR-0050): no Service, env value, log,
 * Server address or shell.
 */
export interface OperatorOrganizationView {
  id: string;
  name: string;
  createdAt: Date;
  /** The owner's sign-in address. */
  ownerEmail: string;
  /** People only: an Agent's member row is not counted. */
  memberCount: number;
  /**
   * Starter, Business or Enterprise as it holds one now, or null for None:
   * never Stripe's status verbatim.
   */
  plan: OperatorPlan | null;
  /** Where it stands, in plain words on the page, with its date. */
  state: OperatorState;
  /**
   * Whether it has had its one free trial, or can no longer have one — it
   * has held a subscription, been Enterprise or been attached
   * (`organizationTrialUsed`).
   */
  trialUsed: boolean;
  servers: CountView;
  cloudEnvironments: CountView;
  enterprise: boolean;
  /** The Operator's suspension, or null. */
  suspension: SuspensionView | null;
  /**
   * The Paying Organization of an **Attached Organization** (ADR-0059), which
   * the Plan reads "Paid by"; null for one that pays for itself. An Attached
   * row's Plan and State are its payer's, its State its own only when it is
   * suspended or lapsed, and its counts its own share of the payer's pool.
   */
  paidBy: NamedOrganization | null;
  /**
   * The Organizations this one pays for, oldest first; empty for none, and
   * for an Attached Organization. Non-empty, the counts are the whole pool's,
   * and the Enterprise switch and the suspension name or count them.
   */
  attached: NamedOrganization[];
}

/** The row facts the Plan and State read, or null with no `subscription` row. */
function factsOf(
  row: Omit<OperatorStateFacts, 'enterprise'> & {
    billed: string | null;
    enterprise: boolean | null;
  },
): OperatorStateFacts | null {
  if (!row.billed) return null;
  return {
    plan: row.plan,
    status: row.status,
    stripeSubscriptionId: row.stripeSubscriptionId,
    enterprise: row.enterprise ?? false,
    trialEndsAt: row.trialEndsAt,
    cancelAt: row.cancelAt,
    stripeScheduleId: row.stripeScheduleId,
    downgradeAt: row.downgradeAt,
    lapsedAt: row.lapsedAt,
    suspendedAt: row.suspendedAt,
  };
}

/**
 * The Operator page's reads (ADR-0050). Hosted only: on a Self-hosted
 * instance every route here answers 404, as if it did not exist. An Operator
 * is ADR-0013's instance authority — an owner or admin of the Instance
 * organization, a person and never an Agent — asked through
 * `PermissionService.holdsInstanceAuthority`, so there is no new role.
 *
 * Viewing is not audited: the audit trail records writes only.
 */
@Injectable()
export class OperatorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly instanceMode: InstanceMode,
    private readonly auditLogs: AuditLogService,
    private readonly notifications: LapseNotifications,
    private readonly boughtServerSteps: BoughtServerClockSteps,
  ) {}

  /**
   * Whether the caller is an Operator: what the console asks before it shows
   * the page. Any signed-in person on the Hosted instance may ask.
   */
  async access(ctx: OperatorCtx): Promise<{ operator: boolean }> {
    this.assertHosted();
    return { operator: await this.permissions.holdsInstanceAuthority(ctx) };
  }

  /** Every Organization on the instance, oldest first. */
  async listOrganizations(
    ctx: OperatorCtx,
  ): Promise<OperatorOrganizationView[]> {
    await this.assertOperator(ctx);

    const people = this.db
      .select({
        organizationId: member.organizationId,
        count: count().as('people_count'),
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.kind, 'human'))
      .groupBy(member.organizationId)
      .as('people');

    const rows = await this.db
      .select({
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt,
        ownerEmail: user.email,
        memberCount: people.count,
        payingId: payingOrganizationIdSql,
        paidBy: organization.paidByOrganizationId,
        billed: subscription.organizationId,
        plan: subscription.plan,
        status: subscription.status,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        trialEndsAt: subscription.trialEndsAt,
        cancelAt: subscription.cancelAt,
        stripeScheduleId: subscription.stripeScheduleId,
        downgradeAt: subscription.downgradeAt,
        lapsedAt: subscription.lapsedAt,
        firstSubscribedAt: subscription.firstSubscribedAt,
        firstEnterpriseAt: subscription.firstEnterpriseAt,
        firstAttachedAt: subscription.firstAttachedAt,
        enterprise: subscription.enterprise,
        suspendedAt: subscription.suspendedAt,
        suspendedReason: subscription.suspendedReason,
      })
      .from(organization)
      .innerJoin(user, eq(user.id, organization.ownerId))
      .leftJoin(people, eq(people.organizationId, organization.id))
      .leftJoin(subscription, eq(subscription.organizationId, organization.id))
      .orderBy(asc(organization.createdAt), asc(organization.id));

    // One pool per Paying Organization, read once however many Organizations
    // are on it: the counts the page shows are the counts check's own.
    const pools = new Map<string, Pool>(
      await Promise.all(
        [...new Set(rows.map((row) => row.payingId))].map(
          async (payingId) =>
            [payingId, await poolOf(this.db, payingId)] as const,
        ),
      ),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const named = (id: string): NamedOrganization => ({
      id,
      name: byId.get(id)?.name ?? '',
    });

    return rows.map((row) => {
      const pool = pools.get(row.payingId);
      const allowance = pool?.allowance ?? allowanceOf(null);
      const payer = row.paidBy ? byId.get(row.paidBy) : undefined;
      // An Attached row counts its own share against the whole pool's
      // allowance; a Paying row, or one paying for itself, the whole pool.
      const usage = !pool
        ? NO_USAGE
        : row.paidBy
          ? shareOf(pool, row.id)
          : pool.usage;
      return {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        ownerEmail: row.ownerEmail,
        memberCount: row.memberCount ?? 0,
        plan: operatorPlanOf(factsOf(payer ?? row)),
        state: row.paidBy
          ? attachedStateOf(factsOf(row), payer ? factsOf(payer) : null)
          : operatorStateOf(factsOf(row)),
        trialUsed: row.paidBy !== null || trialUsedOf(row),
        servers: { used: usage.servers, allowed: allowance.servers },
        cloudEnvironments: {
          used: usage.cloudEnvironments,
          allowed: allowance.cloudEnvironments,
        },
        enterprise: row.enterprise ?? false,
        suspension: row.suspendedAt
          ? {
              reason: row.suspendedReason ?? '',
              suspendedAt: row.suspendedAt,
            }
          : null,
        paidBy: row.paidBy ? named(row.paidBy) : null,
        attached: row.paidBy
          ? []
          : (pool?.shares ?? [])
              .filter((share) => share.organizationId !== row.id)
              .map((share) => named(share.organizationId)),
      };
    });
  }

  /**
   * Suspends the Organization (ADR-0050, ADR-0052): records the reason the
   * customer sees, the Operator and the time, which freezes it with
   * "Suspended. Contact Octabyte". Only {@link lift} clears it — a payment
   * never does — and while it lasts the 30-day deletion clock stands still.
   * An Enterprise Organization can be suspended too. The owners are emailed.
   * Its own **Bought Servers** are deleted 7 days later unless it is lifted
   * first (ADR-0071, #1398): `suspendedAt` is that clock's cause, so
   * lifting it stops the clock with nothing else to clear.
   */
  async suspend(
    ctx: OperatorCtx,
    organizationId: string,
    reason: string,
  ): Promise<SuspensionView> {
    await this.assertOperator(ctx);
    const target = await this.targetOf(organizationId);
    if (organizationId === (await this.permissions.instanceOrganizationId())) {
      throw new ConflictException(INSTANCE_ORGANIZATION_SUSPENSION_REFUSAL);
    }

    const suspendedAt = new Date();
    const [written] = await this.db
      .insert(subscription)
      .values({
        organizationId,
        suspendedAt,
        suspendedReason: reason,
        suspendedBy: ctx.user.id,
      })
      .onConflictDoUpdate({
        target: subscription.organizationId,
        set: { suspendedAt, suspendedReason: reason, suspendedBy: ctx.user.id },
        // A second suspend would overwrite who suspended it and when.
        setWhere: sql`${subscription.suspendedAt} is null`,
      })
      .returning({ id: subscription.id });
    if (!written) {
      throw new ConflictException(`${target.name} is already suspended`);
    }

    await this.recordWrite(ctx, target, {
      type: 'suspendOrganization',
      reason,
    });
    await this.notifications.sendSuspension(organizationId, {
      kind: 'suspended',
      reason,
    });
    // Its own Bought Servers are deleted in 7 days unless this is lifted
    // (ADR-0071); its owner is told the date. Never its Attached ones'.
    await this.boughtServerSteps.suspended(organizationId, suspendedAt);
    return { reason, suspendedAt };
  }

  /**
   * Lifts the suspension, clearing only that cause: a lapsed Organization
   * stays frozen with "Pay to continue". Lifting a still-lapsed one also
   * clears its deletion warning, so the daily job warns again and deletion
   * comes at least 7 days after that warning (story 94, `lapse-clock.ts`).
   */
  async lift(ctx: OperatorCtx, organizationId: string): Promise<void> {
    await this.assertOperator(ctx);
    const target = await this.targetOf(organizationId);

    const [lifted] = await this.db
      .update(subscription)
      .set({
        suspendedAt: null,
        suspendedReason: null,
        suspendedBy: null,
        deletionWarnedAt: sql`case when ${subscription.lapsedAt} is null then ${subscription.deletionWarnedAt} else null end`,
      })
      .where(
        sql`${subscription.organizationId} = ${organizationId} and ${subscription.suspendedAt} is not null`,
      )
      .returning({ lapsedAt: subscription.lapsedAt });
    if (!lifted) {
      throw new ConflictException(`${target.name} is not suspended`);
    }

    await this.recordWrite(ctx, target, { type: 'liftSuspension' });
    await this.notifications.sendSuspension(organizationId, {
      kind: 'lifted',
      stillLapsed: lifted.lapsedAt !== null,
    });
  }

  /**
   * Switches the Enterprise marker (ADR-0048, ADR-0050): on with the
   * agreement's Server and Cloud Environment counts, which become the
   * allowance; off, which ends the agreement (its counts are cleared, so a
   * later switch-on names them afresh).
   *
   * Switching off is a **lapse** (ADR-0052): the Organization is frozen
   * from that moment, its 30-day deletion clock starts, and its owners and
   * admins get "your plan has ended", worded for an Enterprise agreement.
   * Paying for a plan lifts it as it lifts any lapse. The write is
   * conditional on the marker being on, so switching off again records and
   * sends nothing twice. The webhook's own lapse cannot be reused here: it
   * claims only a row that holds a Stripe plan, which an Enterprise row does
   * not.
   *
   * The first switch-on also stamps `firstEnterpriseAt`, which nothing clears:
   * an Organization that was ever Enterprise gets no free trial.
   *
   * Switching on is refused for an Attached Organization with
   * `PAID_BY_ANOTHER_ORGANIZATION` (ADR-0059): its counts are its Paying
   * Organization's, so Enterprise goes on that one instead.
   *
   * Switching on is refused while a Stripe subscription is live, so nobody is
   * billed twice — checked in the same statement that writes, so a checkout
   * finishing at the same moment cannot slip between. An ended one is fine,
   * and its lapse goes with it: Enterprise never lapses through Stripe, so the
   * Organization is no longer frozen for it and its deletion clock stops.
   *
   * Counts below current use are taken as given: nothing stored is the
   * allowance, so they only refuse the next addition and stop nothing. On a
   * Paying Organization they are the whole pool's (ADR-0059), and current use
   * is every Organization on it, as the list shows.
   */
  async setEnterprise(
    ctx: OperatorCtx,
    organizationId: string,
    change: SetEnterprise,
  ): Promise<EnterpriseView> {
    await this.assertOperator(ctx);
    const target = await this.targetOf(organizationId);
    // An Attached Organization's counts are its Paying Organization's
    // (ADR-0059): Enterprise goes on the payer, or on this one once its
    // owner pays for it themselves.
    if (change.enterprise) {
      await assertNotPaidByAnother(this.db, organizationId, 'enterprise');
    }

    const view: EnterpriseView = change.enterprise
      ? {
          enterprise: true,
          servers: change.servers ?? 0,
          cloudEnvironments: change.cloudEnvironments ?? 0,
        }
      : { enterprise: false, servers: 0, cloudEnvironments: 0 };
    const marker = {
      enterprise: view.enterprise,
      enterpriseServers: view.servers,
      enterpriseCloudEnvironments: view.cloudEnvironments,
    };

    if (view.enterprise) {
      const now = new Date();
      const cleared = {
        ...marker,
        lapsedAt: null,
        paymentFailedAt: null,
        lapseWarnedAt: null,
        deletionWarnedAt: null,
      };
      const [written] = await this.db
        .insert(subscription)
        .values({ organizationId, ...cleared, firstEnterpriseAt: now })
        .onConflictDoUpdate({
          target: subscription.organizationId,
          set: {
            ...cleared,
            // The first moment is kept: a later switch-on never moves it.
            firstEnterpriseAt: sql`coalesce(${subscription.firstEnterpriseAt}, excluded.first_enterprise_at)`,
          },
          setWhere: or(
            eq(subscription.enterprise, true),
            isNull(subscription.status),
            inArray(subscription.status, ENDED_STRIPE_STATUSES),
          ),
        })
        .returning({ id: subscription.id });
      if (!written) {
        throw new ConflictException({
          code: STRIPE_SUBSCRIPTION_ACTIVE,
          message: await this.liveSubscriptionRefusal(target),
        });
      }
    } else {
      const lapsedAt = new Date();
      const [lapsed] = await this.db
        .update(subscription)
        .set({
          ...marker,
          lapsedAt,
          paymentFailedAt: null,
          lapseWarnedAt: null,
          deletionWarnedAt: null,
        })
        .where(
          and(
            eq(subscription.organizationId, organizationId),
            eq(subscription.enterprise, true),
          ),
        )
        .returning({ id: subscription.id });
      if (lapsed) {
        await this.notifications.send(organizationId, {
          kind: 'plan-ended',
          cause: 'enterprise',
          deletesOn: addDays(lapsedAt, DELETION_AFTER_DAYS),
        });
        // Enterprise counts as Business, so the custom roles stop with it:
        // the owners and admins are told who holds one.
        await this.notifications.sendCustomRolesStopped(
          organizationId,
          'enterprise',
        );
        // A lapse deletes its Bought Servers, and its Attached
        // Organizations', at once (ADR-0071).
        await this.boughtServerSteps.lapsed(organizationId, lapsedAt);
      }
    }

    await this.recordWrite(ctx, target, { type: 'setEnterprise', ...view });
    return view;
  }

  /**
   * Why Enterprise cannot be switched on, in plain words: a free trial is
   * named as one, since it charges the card when it ends.
   */
  private async liveSubscriptionRefusal(target: {
    id: string;
    name: string;
  }): Promise<string> {
    const [row] = await this.db
      .select({ status: subscription.status })
      .from(subscription)
      .where(eq(subscription.organizationId, target.id))
      .limit(1);
    return isTrialStatus(row?.status)
      ? `${target.name} is on a free trial, which charges its card when the trial ends. The trial must end before the Organization can be Enterprise, so it is not billed twice`
      : `${target.name} has an active Stripe subscription, which must end before the Organization can be Enterprise so it is not billed twice`;
  }

  /** The Organization an Operator write acts on, or 404. */
  async targetOf(
    organizationId: string,
  ): Promise<{ id: string; name: string }> {
    const [target] = await this.db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (!target) throw new NotFoundException('Organization not found');
    return target;
  }

  /**
   * An Operator write's two audit rows (ADR-0050): one in the target
   * Organization's own log, naming the Operator and marked as Octabyte —
   * which `AuditInterceptor` cannot write, since it records against the
   * caller's active Organization and only for its members — and a copy in the
   * Instance organization's, where the Operator is a member.
   *
   * A write on the instance itself, such as the Server markup (#1399),
   * targets the Instance organization, whose log is both logs: it gets one
   * row, not the same row twice.
   *
   * Every Operator write goes through here, the Bought Servers view's too
   * (`OperatorBoughtServers`).
   */
  async recordWrite(
    ctx: OperatorCtx,
    target: { id: string; name: string },
    detail: Record<string, unknown>,
  ): Promise<void> {
    const [operator] = await this.db
      .select({
        email: user.email,
        name: sql<
          string | null
        >`nullif(trim(${user.firstName} || ' ' || ${user.lastName}), '')`,
      })
      .from(user)
      .where(eq(user.id, ctx.user.id))
      .limit(1);
    const event = {
      action: 'update',
      resourceType: 'organization',
      resourceId: target.id,
      resourceName: target.name,
      metadata: { ...OCTABYTE_MARK, ...detail },
    } as const;

    const instanceOrganizationId =
      await this.permissions.instanceOrganizationId();
    if (target.id !== instanceOrganizationId) {
      await this.auditLogs.record({
        organizationId: target.id,
        userId: ctx.user.id,
        userEmail: operator?.email ?? '',
        userRole: OPERATOR_AUDIT_ROLE,
        userName: operator?.name ?? null,
        ip: ctx.ip,
        ...event,
      });
    }
    await this.auditLogs.audit(
      {
        userId: ctx.user.id,
        organizationId: instanceOrganizationId,
        ip: ctx.ip,
      },
      event,
    );
  }

  /**
   * Hosted first, so a Self-hosted instance answers 404 to everybody, then
   * instance authority. The Operator writes call this too.
   */
  async assertOperator(ctx: OperatorCtx): Promise<void> {
    this.assertHosted();
    if (!(await this.permissions.holdsInstanceAuthority(ctx))) {
      throw new ForbiddenException(OPERATOR_REFUSAL);
    }
  }

  private assertHosted(): void {
    if (!this.instanceMode.isHosted) throw new NotFoundException();
  }
}
