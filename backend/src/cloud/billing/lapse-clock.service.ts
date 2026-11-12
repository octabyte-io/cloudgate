import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  AuditLogService,
  PLATFORM_ACTOR,
} from '../../enterprise/audit-logs/audit-log.service';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { organization } from '../../organizations/organizations.schema';
import { includesInstanceOrganization } from '../../rbac/instance-organization-pin';
import { SchedulingService } from '../../scheduling/scheduling.service';
import { subscription } from './billing.schema';
import { BillingConfig } from './billing.config';
import { BoughtServerClockSteps } from './bought-server-clock-steps';
import { DailyJobSteps } from './daily-job-steps';
import { trialQuoteOf } from './free-trial';
import {
  deletionDueAt,
  dueStep,
  lapseDueAt,
  trialReminderDue,
} from './lapse-clock';
import type { ClockMarks, TrialReminderMarks } from './lapse-clock';
import { LapseNotifications } from './lapse-notifications.service';
import { customerIdOf, paymentMethodOf, trialWillCharge } from './plan-trial';
import { STRIPE_API } from './stripe-api';
import type { StripeApi } from './stripe-api';

/** The job id the tick runs under, so a test can run it as its timer would. */
export const LAPSE_CLOCK_JOB_ID = 'lapse-clock';

/**
 * Daily, at 05:17 host time — clear of the unconfirmed-accounts sweep at
 * 04:41.
 */
export const LAPSE_CLOCK_CRON = '17 5 * * *';

/** What one tick did, by Organization id. */
export interface LapseClockTick {
  lapseWarned: string[];
  deletionWarned: string[];
  deleted: string[];
  /** Sent "your trial ends in 7 days". */
  trialReminded: string[];
  /** Sent "your Servers will be deleted in a day" (ADR-0071). */
  boughtServersReminded: string[];
  /** Had their Bought Servers deleted. */
  boughtServersDeleted: string[];
  /** Sent "your Servers will be deleted on <date>", 7 days before a cancel. */
  boughtServersCancelWarned: string[];
}

/**
 * The daily job of a Frozen Organization's lapse (ADR-0052): it sends
 * the 3-days-before-the-lapse and 7-days-before-deletion emails and deletes
 * lapsed, unsuspended Organizations on day 30. It also sends the free trial's
 * "your trial ends in 7 days", runs the Bought Server steps
 * (`BoughtServerClockSteps`, ADR-0071), and then runs the steps other
 * features add (`DailyJobSteps`). Which step is owed is
 * `lapse-clock.ts`'s; this reads the marks, claims each step with one
 * conditional write (so a second tick, or a webhook in between, cannot send
 * it twice or delete a paid-again or suspended Organization), and acts.
 *
 * **Deletion is an ordinary Organization delete**: the `organization` row
 * goes and every table under it cascades — secrets, keys, cloud credentials,
 * configs, logs. Nothing is sent to its Servers or clouds; what runs there is
 * the customer's. The platform's audit entry is written first, as the
 * ordinary delete's is, and detaches with the rest.
 *
 * **A Paying Organization goes with its Attached Organizations** (ADR-0059):
 * they are frozen by its lapse through the link, so they are deleted
 * with it, in the same transaction and first — the "paid by" link refuses the
 * other order. A suspended Attached Organization goes too: only the Paying
 * Organization's own marks decide the step. Their emails reach the Attached
 * Organizations' owners and admins through `LapseNotifications.send`.
 *
 * **Hosted only.** Self-hosted, the job is not registered and {@link tick}
 * does nothing. Enterprise never lapses through Stripe, so never reaches it.
 */
@Injectable()
export class LapseClockService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LapseClockService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly scheduling: SchedulingService,
    private readonly instanceMode: InstanceMode,
    private readonly notifications: LapseNotifications,
    private readonly auditLogs: AuditLogService,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly config: BillingConfig,
    private readonly steps: DailyJobSteps,
    private readonly boughtServerSteps: BoughtServerClockSteps,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.instanceMode.isHosted) return;
    this.scheduling.register(LAPSE_CLOCK_JOB_ID, LAPSE_CLOCK_CRON, null, () =>
      this.tick().then(() => undefined),
    );
  }

  /** Takes every step owed as of `now`. */
  async tick(now: Date = new Date()): Promise<LapseClockTick> {
    const done: LapseClockTick = {
      lapseWarned: [],
      deletionWarned: [],
      deleted: [],
      trialReminded: [],
      boughtServersReminded: [],
      boughtServersDeleted: [],
      boughtServersCancelWarned: [],
    };
    if (!this.instanceMode.isHosted) return done;

    // The Bought Servers' own clock first (ADR-0071): days, not weeks.
    try {
      const bought = await this.boughtServerSteps.run(now);
      done.boughtServersReminded = bought.reminded;
      done.boughtServersDeleted = bought.deleted;
      done.boughtServersCancelWarned = bought.cancelWarned;
    } catch (error) {
      this.logger.error(
        `The Bought Server clock failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const rows = await this.db
      .select({
        organizationId: subscription.organizationId,
        status: subscription.status,
        paymentFailedAt: subscription.paymentFailedAt,
        lapseWarnedAt: subscription.lapseWarnedAt,
        lapsedAt: subscription.lapsedAt,
        deletionWarnedAt: subscription.deletionWarnedAt,
        suspendedAt: subscription.suspendedAt,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        trialEndsAt: subscription.trialEndsAt,
        trialReminderSentAt: subscription.trialReminderSentAt,
      })
      .from(subscription)
      .where(
        and(
          eq(subscription.enterprise, false),
          or(
            isNotNull(subscription.lapsedAt),
            isNotNull(subscription.paymentFailedAt),
            and(
              eq(subscription.status, 'trialing'),
              isNotNull(subscription.trialEndsAt),
              isNull(subscription.trialReminderSentAt),
            ),
          ),
        ),
      );

    for (const row of rows) {
      try {
        const step = dueStep(row, now);
        if (step === 'warn-lapse' && (await this.warnLapse(row, now))) {
          done.lapseWarned.push(row.organizationId);
        } else if (
          step === 'warn-deletion' &&
          (await this.warnDeletion(row, now))
        ) {
          done.deletionWarned.push(row.organizationId);
        } else if (step === 'delete' && (await this.delete(row, now))) {
          done.deleted.push(row.organizationId);
        }
        if (trialReminderDue(row, now) && (await this.remindTrial(row, now))) {
          done.trialReminded.push(row.organizationId);
        }
      } catch (error) {
        this.logger.error(
          `Lapse clock failed for Organization ${row.organizationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Other features' daily steps: a Bought Server's reprice (#1400).
    await this.steps.run(now);

    if (done.deleted.length > 0) {
      this.logger.log(
        `Deleted ${done.deleted.length} Organization(s) 30 days after they lapsed`,
      );
    }
    return done;
  }

  private async warnLapse(
    row: ClockMarks & { organizationId: string },
    now: Date,
  ): Promise<boolean> {
    const [claimed] = await this.db
      .update(subscription)
      .set({ lapseWarnedAt: now })
      .where(
        and(
          eq(subscription.organizationId, row.organizationId),
          isNull(subscription.lapseWarnedAt),
          isNull(subscription.lapsedAt),
          isNotNull(subscription.paymentFailedAt),
        ),
      )
      .returning({ id: subscription.id });
    if (!claimed) return false;
    const lapsesOn = lapseDueAt(row);
    if (lapsesOn) {
      await this.notifications.send(row.organizationId, {
        kind: 'lapse-warning',
        lapsesOn,
      });
    }
    return true;
  }

  /**
   * "Your trial ends in 7 days" (ADR-0052 amended), due by the stored
   * trial end date, naming the plan and Add-ons held now and their amount, as
   * Stripe has them. Stripe is asked first, so a trial that has already ended
   * there is not reminded, and the mark is claimed only then, with one
   * conditional write; it is never cleared, so a plan or Add-on change after
   * it sends no second one.
   *
   * Only a trial that will charge is reminded (`trialWillCharge`): a
   * cancelled one, or one with no card on file, ends with nothing charged,
   * which its own "your free trial has ended" says on the day. The mark is
   * left unclaimed, so "Keep <plan>" or a card added before the end still
   * gets the reminder on the next tick.
   */
  private async remindTrial(
    row: TrialReminderMarks & { organizationId: string },
    now: Date,
  ): Promise<boolean> {
    if (!row.stripeSubscriptionId) return false;
    const current = await this.stripe.retrieveSubscription(
      row.stripeSubscriptionId,
    );
    const quote = trialQuoteOf(this.config.prices, current);
    if (!quote) return false;
    const customer = current.default_payment_method
      ? null
      : await this.stripe.retrieveCustomer(customerIdOf(current));
    if (!trialWillCharge(current, paymentMethodOf(current, customer))) {
      return false;
    }

    const [claimed] = await this.db
      .update(subscription)
      .set({ trialReminderSentAt: now })
      .where(
        and(
          eq(subscription.organizationId, row.organizationId),
          isNull(subscription.trialReminderSentAt),
          eq(subscription.status, 'trialing'),
        ),
      )
      .returning({ id: subscription.id });
    if (!claimed) return false;
    await this.notifications.sendTrial(row.organizationId, {
      kind: 'trial-ending',
      ...quote,
    });
    return true;
  }

  private async warnDeletion(
    row: ClockMarks & { organizationId: string },
    now: Date,
  ): Promise<boolean> {
    const [claimed] = await this.db
      .update(subscription)
      .set({ deletionWarnedAt: now })
      .where(
        and(
          eq(subscription.organizationId, row.organizationId),
          isNull(subscription.deletionWarnedAt),
          isNotNull(subscription.lapsedAt),
          isNull(subscription.suspendedAt),
        ),
      )
      .returning({ id: subscription.id });
    if (!claimed) return false;
    const deletesOn = deletionDueAt({ ...row, deletionWarnedAt: now });
    if (deletesOn) {
      await this.notifications.send(row.organizationId, {
        kind: 'deletion-warning',
        deletesOn,
      });
    }
    return true;
  }

  /**
   * Deletes the Organization when, read again under a row lock, it still owes
   * deletion — still lapsed, not suspended, the warning still standing — and
   * then tells the owner and admins, read before their memberships went.
   *
   * Its Attached Organizations are deleted in the same transaction, before
   * it. Each one's platform `delete` link row goes into both logs first, then
   * the Paying Organization's own row, so every row is written while its
   * Organization still exists.
   */
  private async delete(
    row: ClockMarks & { organizationId: string },
    now: Date,
  ): Promise<boolean> {
    const audiences = await this.notifications.lapseAudiencesOf(
      row.organizationId,
    );

    const deleted = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          status: subscription.status,
          paymentFailedAt: subscription.paymentFailedAt,
          lapseWarnedAt: subscription.lapseWarnedAt,
          lapsedAt: subscription.lapsedAt,
          deletionWarnedAt: subscription.deletionWarnedAt,
          suspendedAt: subscription.suspendedAt,
          enterprise: subscription.enterprise,
        })
        .from(subscription)
        .where(eq(subscription.organizationId, row.organizationId))
        .for('update');
      if (!current || current.enterprise) return false;
      if (dueStep(current, now) !== 'delete') return false;

      const attached = await tx
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.paidByOrganizationId, row.organizationId))
        .orderBy(asc(organization.createdAt), asc(organization.id))
        // Not `for update`: the audit rows below are written outside this
        // transaction, and their foreign key takes a key-share lock on these
        // same rows, which `for update` would make wait on us forever. This
        // still holds back a link change (detach, paying for itself) until
        // the deletion has committed.
        .for('no key update');
      const attachedIds = attached.map((one) => one.id);
      if (
        await includesInstanceOrganization(tx, [
          row.organizationId,
          ...attachedIds,
        ])
      ) {
        // Never reachable for an Instance organization with no plan, and
        // refused if it ever is: deleting it leaves nobody holding instance
        // authority (ADR-0077). The `restrict` key on the pin backs this up.
        this.logger.error(
          `Refusing to delete lapsed Organization ${row.organizationId}: it is, ` +
            'or pays for, the Instance organization (ADR-0077).',
        );
        return false;
      }

      for (const attachedOrganizationId of attachedIds) {
        await this.auditLogs.recordLinkEvent(PLATFORM_ACTOR, {
          event: 'deleted',
          attachedOrganizationId,
          payingOrganizationId: row.organizationId,
        });
      }
      await this.auditLogs.recordAsPlatform(row.organizationId, {
        action: 'delete',
        resourceType: 'organization',
        resourceId: row.organizationId,
        resourceName: audiences.paying.organizationName,
        // Why the platform deleted it: 30 days after this lapse.
        metadata: { lapsedAt: current.lapsedAt?.toISOString() },
      });
      if (attachedIds.length > 0) {
        await tx
          .delete(organization)
          .where(inArray(organization.id, attachedIds));
      }
      await tx
        .delete(organization)
        .where(eq(organization.id, row.organizationId));
      return true;
    });
    if (!deleted) return false;

    await this.notifications.send(
      row.organizationId,
      { kind: 'deleted' },
      audiences,
    );
    return true;
  }
}
