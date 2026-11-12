import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type Stripe from 'stripe';
import { subscription } from '../cloud/billing/billing.schema';
import { subscriptionIdOf } from '../cloud/billing/billing.plans';
import {
  cancelWarningDue,
  cancelWarningFrom,
  deletionStepOf,
  reminderDueAt,
} from '../cloud/billing/bought-server-clock';
import { BoughtServerClockSteps } from '../cloud/billing/bought-server-clock-steps';
import type {
  BoughtServerClockEvents,
  BoughtServerClockOutcome,
} from '../cloud/billing/bought-server-clock-steps';
import { isRetrying } from '../cloud/billing/lapse-clock';
import { payingOrganizationIdSql } from '../cloud/billing/paying-organization';
import { PurchasePayments } from '../cloud/billing/purchase-payments';
import { STRIPE_API } from '../cloud/billing/stripe-api';
import type { StripeApi } from '../cloud/billing/stripe-api';
import type { InvoiceOutcomeListener } from '../cloud/billing/purchase-payments';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { organization } from '../organizations/organizations.schema';
import {
  BoughtServerDeletion,
  beginDeleting,
} from './bought-server-deletion.service';
import { BoughtServerNotifications } from './bought-server-notifications.service';
import { BoughtServerStages } from './bought-server-stages.service';
import { boughtServer, boughtServerLine } from './bought-server.schema';
import type { BoughtServerStage } from './bought-server.schema';
import { boughtServerClocksOf } from './deletion-date';
import type { DeletionClock } from './deletion-date';
import { invoicePriceIds } from './purchase-payment';

/**
 * The stages a Bought Server's machine exists and is the customer's in:
 * what a deletion date is about, and what the deletion deletes. Creating is
 * one too, but Delete waits for its machine to answer.
 */
const LIVE_STAGES: readonly BoughtServerStage[] = [
  'creating',
  'setting_up',
  'ready',
  'changing',
];

/**
 * **Bought Servers deleted 7 days after a failed payment** (ADR-0071,
 * #1397): the webhook half and the daily half of the clock
 * `bought-server-clock.ts` decides.
 *
 * - An invoice with Bought Server lines fails (a renewal, or the invoice
 *   that adds lines bought in the Free trial to the subscription once it
 *   ends), and Stripe is retrying it: the Paying Organization's row is
 *   marked with the moment and the invoice, once, and the owner of each
 *   Organization on it with Bought Servers is emailed the date, 7 days on.
 *   An Attached Organization's clock is read from that same row.
 * - Paying that invoice ends it.
 * - The daily lapse job (`BoughtServerClockSteps`) sends the reminder a
 *   day before, and on the date deletes them through Delete's own steps.
 *   Each `server` row stays, so the record is kept, marked Deleted, with
 *   its Services still listed; deleting it afterwards is plain cleanup.
 *
 * #1398 adds the other causes, which `bought-server-clock.ts` reads from
 * marks already kept: an Operator's suspension (7 days, the
 * Organization's own; its owner is told the date at once, and lifting it
 * stops the clock), and a lapse, which deletes at the moment it is recorded
 * (`BoughtServerClockSteps.lapsed`, wherever it is recorded) and is taken
 * by the tick too, should that have failed. A cancel's date is known, so
 * the tick warns 7 days before it.
 *
 * A failed purchase or change is not one: their payment is made with
 * `pending_if_incomplete`, which leaves the subscription `active`, and is
 * dealt with by the purchase or the change itself.
 */
@Injectable()
export class BoughtServerClock
  implements OnModuleInit, InvoiceOutcomeListener, BoughtServerClockEvents
{
  private readonly logger = new Logger(BoughtServerClock.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly purchasePayments: PurchasePayments,
    private readonly steps: BoughtServerClockSteps,
    private readonly stages: BoughtServerStages,
    private readonly notifications: BoughtServerNotifications,
    private readonly deletion: BoughtServerDeletion,
  ) {}

  onModuleInit(): void {
    this.purchasePayments.listenToInvoices(this);
    this.steps.register((now) => this.tick(now));
    this.steps.listen(this);
  }

  // ---------------------------------------------------------------------------
  // The webhook
  // ---------------------------------------------------------------------------

  /**
   * A failed invoice starts the clock when it carries a line of a Bought
   * Server on the subscription it belongs to, and Stripe is now retrying
   * that subscription's payment. Later retries of it, or
   * another failed invoice meanwhile, leave the first moment as it is.
   */
  async invoiceFailed(
    invoice: Stripe.Invoice,
    now: Date = new Date(),
  ): Promise<void> {
    const subscriptionId = subscriptionIdOf(invoice);
    if (!invoice.id || !subscriptionId) return;
    const [paying] = await this.db
      .select({
        organizationId: subscription.organizationId,
        enterprise: subscription.enterprise,
      })
      .from(subscription)
      .where(eq(subscription.stripeSubscriptionId, subscriptionId))
      .limit(1);
    if (!paying || paying.enterprise) return;
    // Stripe's own status now: retried, unlike a purchase's or a change's
    // payment, which leaves the subscription active.
    const current = await this.stripe.retrieveSubscription(subscriptionId);
    if (!isRetrying(current.status)) return;

    const prices = invoicePriceIds(invoice);
    if (prices.length === 0) return;
    const charged = await this.db
      .select({ id: boughtServerLine.id })
      .from(boughtServerLine)
      .innerJoin(
        boughtServer,
        eq(boughtServer.id, boughtServerLine.boughtServerId),
      )
      .innerJoin(organization, eq(organization.id, boughtServer.organizationId))
      .where(
        and(
          eq(payingOrganizationIdSql, paying.organizationId),
          inArray(boughtServer.stage, [...LIVE_STAGES]),
          inArray(boughtServerLine.stripePriceId, prices),
        ),
      )
      .limit(1);
    if (charged.length === 0) return;

    const [started] = await this.db
      .update(subscription)
      .set({
        boughtServersPaymentFailedAt: now,
        boughtServersFailedInvoiceId: invoice.id,
      })
      .where(
        and(
          eq(subscription.organizationId, paying.organizationId),
          isNull(subscription.boughtServersPaymentFailedAt),
        ),
      )
      .returning({ id: subscription.id });
    if (!started) return;

    const held = await this.liveByOrganization(paying.organizationId);
    const clocks = await boughtServerClocksOf(this.db, [...held.keys()]);
    for (const [organizationId, servers] of held) {
      const deletesOn = clocks.get(organizationId)?.deletesOn;
      if (!deletesOn) continue;
      await this.notifications.sendDeletion(
        organizationId,
        servers.map((one) => one.name),
        { kind: 'payment-failed', deletesOn },
      );
    }
  }

  /** Paying the invoice that started the clock ends it. */
  async invoicePaid(invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.id) return;
    const cleared = await this.db
      .update(subscription)
      .set({
        boughtServersPaymentFailedAt: null,
        boughtServersFailedInvoiceId: null,
      })
      .where(eq(subscription.boughtServersFailedInvoiceId, invoice.id))
      .returning({ organizationId: subscription.organizationId });
    for (const { organizationId } of cleared) {
      this.logger.log(
        `Organization ${organizationId} paid invoice ${invoice.id}: its Bought Servers are no longer due for deletion`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // The daily steps
  // ---------------------------------------------------------------------------

  /**
   * Each Organization holding Bought Servers, with the step its clock owes
   * as of `now`: the reminder, or the deletion. One that fails is logged
   * and left for the next tick.
   */
  async tick(now: Date): Promise<BoughtServerClockOutcome> {
    return this.takeSteps(await this.liveByOrganization(), now);
  }

  // ---------------------------------------------------------------------------
  // A lapse or a suspension, at the moment it is recorded (#1398)
  // ---------------------------------------------------------------------------

  /**
   * A lapse deletes at once (ADR-0071): the Bought Servers of the
   * Organization that lapsed and of each Organization it pays for, whose
   * lapse is read through the link. The daily tick would take the same
   * step; this only takes it now. `chargedToOrganizationId`, after "Stop
   * paying for it", is the former payer whose subscription still carries
   * their lines: they are taken off it first, since the link no longer
   * leads there.
   */
  async lapsed(
    organizationId: string,
    now: Date,
    chargedToOrganizationId?: string,
  ): Promise<void> {
    const held = await this.liveByOrganization(organizationId);
    await this.takeSteps(held, now, chargedToOrganizationId);
  }

  /**
   * A suspension tells the suspended Organization's owner the date (story
   * 64). Its own Bought Servers alone: a Paying Organization's suspension
   * never reaches an Attached Organization (ADR-0059). The reminder and the
   * deletion are the daily tick's.
   */
  async suspended(organizationId: string, now: Date): Promise<void> {
    const held = await this.liveByOrganization(organizationId);
    const servers = held.get(organizationId);
    if (!servers) return;
    const clock = (await boughtServerClocksOf(this.db, [organizationId])).get(
      organizationId,
    );
    if (!clock?.deletesOn || clock.dueTo === 'lapse') return;
    if (deletionStepOf(clock, now) !== null) {
      // Already due sooner by another cause: the tick's own emails say so.
      return;
    }
    await this.notifications.sendDeletion(
      organizationId,
      servers.map((one) => one.name),
      { kind: 'suspended', deletesOn: clock.deletesOn },
    );
  }

  /** The step each of these Organizations' clocks owes as of `now`, taken. */
  private async takeSteps(
    held: Map<string, LiveServer[]>,
    now: Date,
    chargedToOrganizationId?: string,
  ): Promise<BoughtServerClockOutcome> {
    const done: BoughtServerClockOutcome = {
      reminded: [],
      deleted: [],
      cancelWarned: [],
    };
    const clocks = await boughtServerClocksOf(this.db, [...held.keys()]);
    for (const [organizationId, servers] of held) {
      const clock = clocks.get(organizationId);
      if (!clock) continue;
      try {
        const step = deletionStepOf(clock, now);
        if (step === 'remind') {
          if (await this.remind(clock, servers, now)) {
            done.reminded.push(organizationId);
          }
        } else if (step === 'delete') {
          const deleted = await this.delete(
            clock,
            servers,
            now,
            chargedToOrganizationId,
          );
          if (deleted) done.deleted.push(organizationId);
        } else if (
          cancelWarningDue(clock, now) &&
          (await this.warnOfCancel(clock, servers, now))
        ) {
          done.cancelWarned.push(organizationId);
        }
      } catch (error) {
        this.logger.error(
          `The Bought Server clock failed for Organization ${organizationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return done;
  }

  /** The day-before reminder, claimed on the Organization's own row for this date. */
  private async remind(
    clock: DeletionClock,
    servers: LiveServer[],
    now: Date,
  ): Promise<boolean> {
    const deletesOn = clock.deletesOn!;
    const remindFrom = reminderDueAt(deletesOn);
    const [claimed] = await this.db
      .insert(subscription)
      .values({
        organizationId: clock.organizationId,
        boughtServersDayBeforeSentAt: now,
      })
      .onConflictDoUpdate({
        target: subscription.organizationId,
        set: { boughtServersDayBeforeSentAt: now },
        setWhere: or(
          isNull(subscription.boughtServersDayBeforeSentAt),
          lt(subscription.boughtServersDayBeforeSentAt, remindFrom),
        ),
      })
      .returning({ id: subscription.id });
    if (!claimed) return false;
    await this.notifications.sendDeletion(
      clock.organizationId,
      servers.map((one) => one.name),
      {
        kind: 'day-before',
        deletesOn,
        dueTo: clock.dueTo === 'suspension' ? 'suspension' : 'payment-failed',
      },
    );
    return true;
  }

  /**
   * The warning 7 days before a known cancel (story 65), claimed on the
   * Organization's own row for this cancel's date. The cancel itself is a
   * lapse when it comes, which deletes them then.
   */
  private async warnOfCancel(
    clock: DeletionClock,
    servers: LiveServer[],
    now: Date,
  ): Promise<boolean> {
    const cancelAt = clock.cancelAt!;
    const warnFrom = cancelWarningFrom(cancelAt);
    const [claimed] = await this.db
      .insert(subscription)
      .values({
        organizationId: clock.organizationId,
        boughtServersLapseWarnedAt: now,
      })
      .onConflictDoUpdate({
        target: subscription.organizationId,
        set: { boughtServersLapseWarnedAt: now },
        setWhere: or(
          isNull(subscription.boughtServersLapseWarnedAt),
          lt(subscription.boughtServersLapseWarnedAt, warnFrom),
        ),
      })
      .returning({ id: subscription.id });
    if (!claimed) return false;
    await this.notifications.sendDeletion(
      clock.organizationId,
      servers.map((one) => one.name),
      { kind: 'cancel', deletesOn: cancelAt },
    );
    return true;
  }

  /**
   * Deletes the Organization's Bought Servers through Delete's own steps,
   * keeping each `server` row as the Deleted record, then tells the owner.
   * Unlike a Delete the customer presses, the lines leave with no credit:
   * the month was not paid for, or the Organization was suspended or lapsed.
   * One still being created is waited for: Delete is refused while its
   * machine has not answered, so the whole step waits for the next tick.
   */
  private async delete(
    clock: DeletionClock,
    servers: LiveServer[],
    now: Date,
    chargedToOrganizationId?: string,
  ): Promise<boolean> {
    if (servers.some((one) => one.stage === 'creating')) {
      this.logger.log(
        `Organization ${clock.organizationId} has a Bought Server still being created; its deletion waits for the next tick`,
      );
      return false;
    }

    const started: LiveServer[] = [];
    for (const one of servers) {
      const serverId = one.serverId;
      if (!serverId) continue;
      if (chargedToOrganizationId) {
        await this.deletion.removeLinesFrom(
          one.id,
          chargedToOrganizationId,
          false,
        );
      }
      const begun = await this.db.transaction((tx) =>
        beginDeleting(tx, serverId, now, false),
      );
      if (begun?.started) {
        started.push(one);
        await this.stages.advance(begun.id);
      }
    }

    const deletesOn = clock.deletesOn!;
    const dueTo = clock.dueTo!;
    const [claimed] = await this.db
      .insert(subscription)
      .values({
        organizationId: clock.organizationId,
        boughtServersDeletedSentAt: now,
      })
      .onConflictDoUpdate({
        target: subscription.organizationId,
        set: { boughtServersDeletedSentAt: now },
        setWhere: or(
          isNull(subscription.boughtServersDeletedSentAt),
          lt(subscription.boughtServersDeletedSentAt, deletesOn),
        ),
      })
      .returning({ id: subscription.id });
    if (!claimed) return false;
    this.logger.log(
      `Deleted ${started.length} Bought Server(s) of Organization ${clock.organizationId}, due for deletion on ${deletesOn.toISOString()}`,
    );
    if (started.length > 0) {
      await this.notifications.sendDeletion(
        clock.organizationId,
        started.map((one) => one.name),
        { kind: 'deleted', deletedOn: now, dueTo },
      );
    }
    return true;
  }

  /**
   * The live Bought Servers by Organization, oldest first: every one, or
   * only those on one Paying Organization's pool.
   */
  private async liveByOrganization(
    payingOrganizationId?: string,
  ): Promise<Map<string, LiveServer[]>> {
    const rows = await this.db
      .select({
        id: boughtServer.id,
        organizationId: boughtServer.organizationId,
        serverId: boughtServer.serverId,
        name: boughtServer.name,
        stage: boughtServer.stage,
      })
      .from(boughtServer)
      .innerJoin(organization, eq(organization.id, boughtServer.organizationId))
      .where(
        and(
          inArray(boughtServer.stage, [...LIVE_STAGES]),
          payingOrganizationId === undefined
            ? undefined
            : eq(payingOrganizationIdSql, payingOrganizationId),
        ),
      )
      .orderBy(asc(boughtServer.createdAt), asc(boughtServer.id));
    const held = new Map<string, LiveServer[]>();
    for (const row of rows) {
      const list = held.get(row.organizationId) ?? [];
      list.push(row);
      held.set(row.organizationId, list);
    }
    return held;
  }
}

interface LiveServer {
  id: string;
  organizationId: string;
  serverId: string | null;
  name: string;
  stage: BoughtServerStage;
}
