import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { user } from '../../auth/auth.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  AuditLogService,
  PLATFORM_ACTOR,
} from '../../enterprise/audit-logs/audit-log.service';
import { organization } from '../../organizations/organizations.schema';
import { BillingNotificationsService } from './billing-notifications.service';
import { isPaidStatus } from './billing-allowance';
import { BillingConfig } from './billing.config';
import { isEnterprise } from './enterprise';
import {
  cardTrialClaimedBy,
  claimCardTrial,
  defaultPaymentMethodIdOf,
  endedDuringTrial,
  isTrialStatus,
  recordInTrialHistory,
  trialEmailKeyOf,
  trialFactsOf,
  trialQuoteOf,
} from './free-trial';
import { cancelAtOf, purchasedItems, subscriptionIdOf } from './billing.plans';
import type { PlanName } from './billing.plans';
import { subscription } from './billing.schema';
import { DELETION_AFTER_DAYS, isRetrying, lapseNoticeOf } from './lapse-clock';
import { LapseNotifications } from './lapse-notifications.service';
import { endLinkPaidForItself } from './paying-for-itself';
import { STRIPE_API } from './stripe-api';
import type { StripeApi } from './stripe-api';
import { PaymentDisputes } from './payment-disputes.service';
import { BoughtServerClockSteps } from './bought-server-clock-steps';
import { PurchasePayments } from './purchase-payments';
import { scheduleFollowingSubscription } from './plan-downgrade';
import type { HandledEvent, HandledEventType } from './stripe-webhook-events';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A lapse just recorded: its moment, whether a payment had failed, the
 * plan that lapsed, and the status the row held then (`trialing` for a trial
 * that ended uncharged).
 */
interface RecordedLapse {
  lapsedAt: Date;
  paymentFailedAt: Date | null;
  plan: PlanName | null;
  status: string | null;
}

/**
 * The organization an event resolves to, and whether Stripe governs it.
 * `newCustomer` is set when it was found by the Organization the subscription
 * names rather than by a stored customer — the event arrived before the
 * customer was stored — and is the customer id to store with it.
 */
interface WebhookTarget {
  organizationId: string;
  enterprise: boolean;
  newCustomer?: string;
}

/** One handler per handled event type, each given its event's object. */
type EventHandlers = {
  [T in HandledEventType]: (
    object: Extract<HandledEvent, { type: T }>['data']['object'],
  ) => Promise<void>;
};

/**
 * The half of the Stripe webhook that decides what an event means. The
 * controller owns signature verification and the accepted-type list;
 * everything below assumes a verified, accepted event.
 *
 * Running through every branch: the subscription row is the organization's,
 * not its owner's, so one Stripe customer pays for one organization and events
 * resolve to exactly one organization — by the id checkout put in the session
 * metadata, or by the stored customer id for the subscription/customer events,
 * falling back to the id checkout also put in the subscription's metadata
 * while the customer is not stored yet. Stripe delivers a first checkout's
 * events in no fixed order, so each of them settles alone.
 *
 * No branch touches a Server (ADR-0048, ADR-0052): the webhook records what
 * Stripe says — plan, status, Add-ons, and the lapse when the subscription or
 * customer is deleted — and the allowance check and `FrozenOrganizations`
 * read it. A lowered count refuses new additions; a lapse freezes the
 * Organization; neither stops anything already running.
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly config: BillingConfig,
    private readonly notifications: BillingNotificationsService,
    private readonly lapseNotifications: LapseNotifications,
    private readonly auditLogs: AuditLogService,
    private readonly purchasePayments: PurchasePayments,
    private readonly disputes: PaymentDisputes,
    private readonly boughtServerSteps: BoughtServerClockSteps,
  ) {}

  /**
   * Runs the event's handler. Every handled type has one: the map is typed
   * over HANDLED_EVENT_TYPES, the list the controller accepts and the Stripe
   * endpoint is subscribed to.
   */
  async handle(event: HandledEvent): Promise<void> {
    const handlers: EventHandlers = {
      'checkout.session.completed': (session) =>
        this.onCheckoutCompleted(session),
      'customer.subscription.created': (sub) => this.onSubscriptionCreated(sub),
      'customer.subscription.updated': (sub) => this.onSubscriptionUpdated(sub),
      'customer.subscription.deleted': (sub) => this.onSubscriptionDeleted(sub),
      'customer.deleted': (customer) => this.onCustomerDeleted(customer),
      'invoice.payment_succeeded': async (invoice) => {
        // A Bought Server's purchase first: its payment is what lets its
        // machine be made, whatever the subscription's own state.
        await this.purchasePayments.invoicePaid(invoice);
        await this.onInvoicePaid(invoice);
      },
      'invoice.payment_failed': async (invoice) => {
        await this.onInvoiceFailed(invoice);
        // Bought Servers start their own clock, even while only past_due.
        await this.purchasePayments.invoiceFailed(invoice);
      },
      'customer.subscription.pending_update_expired': (sub) =>
        this.purchasePayments.pendingUpdateExpired(sub),
      'subscription_schedule.released': (schedule) =>
        this.onScheduleEnded(schedule),
      'subscription_schedule.completed': (schedule) =>
        this.onScheduleEnded(schedule),
      'subscription_schedule.canceled': (schedule) =>
        this.onScheduleEnded(schedule),
      'subscription_schedule.aborted': (schedule) =>
        this.onScheduleEnded(schedule),
      'charge.dispute.created': (dispute) =>
        this.disputes.disputeCreated(dispute),
    };
    // The type and its object are correlated, which TypeScript cannot follow
    // through a union; each handler's own parameter is typed by the map.
    await handlers[event.type](event.data.object as never);
  }

  /**
   * `customer.subscription.updated`: the plan, status and Add-on quantity are
   * re-read off the event's own items — the state that changed — and stored.
   * A status that no longer grants the plan leaves the allowance at 0/0, which
   * refuses new additions; nothing already held changes.
   */
  private async onSubscriptionUpdated(
    stripeSubscription: Stripe.Subscription,
  ): Promise<void> {
    const target = await this.organizationForSubscription(
      'customer.subscription.updated',
      stripeSubscription,
    );
    if (!target || target.enterprise) return;
    await this.syncFromSubscription(target.organizationId, stripeSubscription, {
      stripeCustomerId: target.newCustomer,
    });
    await this.settleDowngrade(target.organizationId, stripeSubscription);
    await this.followWaitingDowngrade(
      target.organizationId,
      stripeSubscription,
    );
    // Bought Server lines charged on their own during the Free trial join
    // the subscription once the trial is over (ADR-0071).
    await this.purchasePayments.subscriptionUpdated(stripeSubscription);
  }

  /**
   * A waiting downgrade that has happened: the subscription its
   * schedule manages now carries Starter, so the move is done. The schedule is
   * released — the subscription runs on as a plain Starter one, and an Add-on
   * change goes to it directly again — and forgotten. A release Stripe
   * refuses is logged: the schedule then releases itself at the end of the
   * Starter phase, and its `subscription_schedule.released` changes nothing.
   */
  private async settleDowngrade(
    organizationId: string,
    stripeSubscription: Stripe.Subscription,
  ): Promise<void> {
    const [row] = await this.db
      .select({ stripeScheduleId: subscription.stripeScheduleId })
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId))
      .limit(1);
    const scheduleId = row?.stripeScheduleId;
    if (!scheduleId) return;
    const items = (stripeSubscription.items?.data ?? []).map((item) => ({
      priceId: item.price.id,
      quantity: item.quantity,
    }));
    if (purchasedItems(this.config.prices, items).plan !== 'starter') return;

    await this.db
      .update(subscription)
      .set({ stripeScheduleId: null, downgradeAt: null })
      .where(
        and(
          eq(subscription.organizationId, organizationId),
          eq(subscription.stripeScheduleId, scheduleId),
        ),
      );
    try {
      await this.stripe.releaseSubscriptionSchedule(scheduleId);
    } catch (error) {
      this.logger.warn(
        `Could not release subscription schedule ${scheduleId} after its move to Starter: ${String(error)}`,
      );
    }
  }

  /**
   * A downgrade still waiting while the subscription's items changed: a
   * Bought Server line added, removed or repriced is a plain subscription
   * update, so the schedule's phases still to run are rewritten to carry the
   * lines the subscription now holds, or the move to Starter would drop or
   * bring back a line at the renewal. Nothing to write is nothing asked.
   */
  private async followWaitingDowngrade(
    organizationId: string,
    stripeSubscription: Stripe.Subscription,
  ): Promise<void> {
    const [row] = await this.db
      .select({ stripeScheduleId: subscription.stripeScheduleId })
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId))
      .limit(1);
    const scheduleId = row?.stripeScheduleId;
    const { starterPriceId, businessPriceId, addOnPriceId } =
      this.config.prices;
    if (!scheduleId || !starterPriceId || !businessPriceId || !addOnPriceId) {
      return;
    }
    const schedule = await this.stripe.retrieveSubscriptionSchedule(scheduleId);
    const update = scheduleFollowingSubscription(
      schedule,
      (stripeSubscription.items?.data ?? []).map((item) => ({
        priceId: item.price.id,
        quantity: item.quantity,
      })),
      { starterPriceId, businessPriceId, addOnPriceId },
      Math.floor(Date.now() / 1000),
    );
    if (update)
      await this.stripe.updateSubscriptionSchedule(scheduleId, update);
  }

  /**
   * `subscription_schedule.released`, `.completed`, `.canceled` and
   * `.aborted`: the schedule no longer manages the subscription, so no
   * downgrade waits on it. The Organization that stored it forgets it; one
   * that stores no such schedule (Keep Business already forgot it, or it was
   * never a downgrade's) changes nothing. The plan itself is the subscription
   * events' to record.
   */
  private async onScheduleEnded(
    schedule: Stripe.SubscriptionSchedule,
  ): Promise<void> {
    await this.db
      .update(subscription)
      .set({ stripeScheduleId: null, downgradeAt: null })
      .where(
        and(
          eq(subscription.stripeScheduleId, schedule.id),
          eq(subscription.enterprise, false),
        ),
      );
  }

  /**
   * `checkout.session.completed`: the customer and subscription
   * Stripe just created are stored, with the plan and Add-on quantity read off
   * the subscription's items.
   *
   * The subscription is fetched rather than read off the session because the
   * session carries only its id.
   *
   * A Checkout that started a free trial then runs the card check
   * (`endTrialOfRepeatCard`). Only here: the card is known once Checkout
   * completes, and this event comes once per Checkout, whatever order the
   * subscription events arrive in. A trial the check keeps then gets "your
   * trial has started"; one it ends for a repeat card does not, since it is
   * charged today.
   */
  private async onCheckoutCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const organizationId = session.metadata?.organizationId;
    if (!organizationId || !(await this.organizationExists(organizationId))) {
      // The organization the session was started for is missing or gone.
      throw new BadRequestException('Webhook Error: Organization not found');
    }
    if (await this.isBilledOutsideStripe(organizationId)) return;

    const stripeSubscription = await this.stripe.retrieveSubscription(
      session.subscription as string,
    );

    await this.syncFromSubscription(organizationId, stripeSubscription, {
      stripeCustomerId: session.customer as string,
    });
    if (await this.endTrialOfRepeatCard(stripeSubscription)) {
      await this.notifyTrialStarted(organizationId, stripeSubscription, {
        cardChecked: true,
      });
    }
    // A Bought Server bought with no plan is charged now, after the card
    // check, on the plan as it then stands (ADR-0071).
    await this.purchasePayments.checkoutCompleted(session);
  }

  /**
   * One free trial per card (ADR-0054): a trialing subscription's card
   * is looked up by its Stripe fingerprint in the trial history. Its first
   * trial records it; a card another trial already had ends this trial now
   * (`trial_end: 'now'`) — Stripe charges today and the subscription carries
   * on, plan and Add-ons as chosen, never cancelled. The
   * `customer.subscription.updated` that follows stores the new status.
   *
   * The same Checkout delivered again finds its own subscription on the card
   * and changes nothing. A subscription with no card behind it (none set, or
   * a payment method that is not a card) has nothing to check and keeps its
   * trial, which Stripe cancels at its end without a payment method.
   *
   * True when the subscription keeps its trial (or has none to end), false
   * when this ended it.
   */
  private async endTrialOfRepeatCard(
    stripeSubscription: Stripe.Subscription,
  ): Promise<boolean> {
    if (!isTrialStatus(stripeSubscription.status)) return true;
    const paymentMethodId = defaultPaymentMethodIdOf(stripeSubscription);
    if (!paymentMethodId) {
      this.logger.warn(
        `Trialing subscription ${stripeSubscription.id} has no default payment method; its card cannot be checked for an earlier trial`,
      );
      return true;
    }
    const paymentMethod =
      await this.stripe.retrievePaymentMethod(paymentMethodId);
    const fingerprint = paymentMethod.card?.fingerprint;
    if (!fingerprint) {
      this.logger.warn(
        `Payment method ${paymentMethodId} of trialing subscription ${stripeSubscription.id} has no card fingerprint; it cannot be checked for an earlier trial`,
      );
      return true;
    }
    if (await claimCardTrial(this.db, fingerprint, stripeSubscription.id)) {
      return true;
    }
    this.logger.log(
      `Ending the trial of subscription ${stripeSubscription.id} now: its card has had a free trial before`,
    );
    await this.stripe.updateSubscription(stripeSubscription.id, {
      trial_end: 'now',
    });
    return false;
  }

  /**
   * `invoice.payment_succeeded`: a paid invoice re-syncs the plan, status and
   * Add-ons, and mails the invoice when the organization asked for them.
   *
   * The subscription is fetched because the invoice carries only a reference,
   * and an invoice for a subscription that is no longer active is ignored — the
   * `updated` or `deleted` event that ended it is the authority.
   */
  private async onInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const stripeSubscription = await this.subscriptionForInvoice(invoice);
    if (!stripeSubscription) return;

    if (stripeSubscription.status !== 'active') {
      this.logger.log(
        `Skipping invoice.payment_succeeded for subscription ${stripeSubscription.id} with status ${stripeSubscription.status}`,
      );
      return;
    }

    const target = await this.organizationForSubscription(
      'invoice.payment_succeeded',
      stripeSubscription,
    );
    if (!target || target.enterprise) return;
    const { organizationId } = target;

    await this.syncFromSubscription(organizationId, stripeSubscription, {
      stripeCustomerId: target.newCustomer,
    });
    await this.notifyInvoicePaid(organizationId, stripeSubscription, invoice);
  }

  /**
   * The paid-invoice email's two free-trial rules: a 0 USD invoice —
   * the one that opens a trial, or one a credit covered — sends nothing, and
   * the first real charge of a subscription that had a trial says the trial
   * has ended. That first charge is claimed with one conditional write
   * whether or not invoice emails were asked for, so a later invoice never
   * says it.
   */
  private async notifyInvoicePaid(
    organizationId: string,
    stripeSubscription: Stripe.Subscription,
    invoice: Stripe.Invoice,
  ): Promise<void> {
    if (invoice.amount_paid === 0) return;
    let trialEnded = false;
    if (stripeSubscription.trial_end != null) {
      const [claimed] = await this.db
        .update(subscription)
        .set({ trialChargedAt: new Date() })
        .where(
          and(
            eq(subscription.organizationId, organizationId),
            isNull(subscription.trialChargedAt),
          ),
        )
        .returning({ id: subscription.id });
      trialEnded = !!claimed;
    }
    await this.notifyInvoice(organizationId, invoice, { trialEnded });
  }

  /**
   * `invoice.payment_failed`: nothing happens while the subscription
   * is still active — a failed attempt on a live subscription is not a loss of
   * service. Once it is not active the status is stored; no Server is touched.
   *
   * The first failure of a subscription Stripe is now retrying (`past_due`,
   * `unpaid`) records `paymentFailedAt` — the start of the 3-day warning's
   * clock (lapse-clock.ts) — and sends the payment-failed email to the owner
   * and every admin, always (ADR-0052). Stripe's later retries fail
   * again without a second email; paying clears the mark.
   */
  private async onInvoiceFailed(invoice: Stripe.Invoice): Promise<void> {
    const stripeSubscription = await this.subscriptionForInvoice(invoice);
    if (!stripeSubscription || stripeSubscription.status === 'active') return;

    const target = await this.organizationForSubscription(
      'invoice.payment_failed',
      stripeSubscription,
    );
    if (!target || target.enterprise) return;
    const { organizationId } = target;

    if (target.newCustomer) {
      // The first checkout's own payment failed before its customer was
      // stored: the subscription is recorded whole, with the status it holds.
      await this.syncFromSubscription(organizationId, stripeSubscription, {
        stripeCustomerId: target.newCustomer,
      });
    } else {
      await this.db
        .update(subscription)
        .set({ status: stripeSubscription.status })
        .where(eq(subscription.organizationId, organizationId));
    }

    if (!isRetrying(stripeSubscription.status)) return;
    const [firstFailure] = await this.db
      .update(subscription)
      .set({ paymentFailedAt: new Date() })
      .where(
        and(
          eq(subscription.organizationId, organizationId),
          isNull(subscription.paymentFailedAt),
          isNull(subscription.lapsedAt),
        ),
      )
      .returning({ id: subscription.id });
    if (firstFailure) {
      await this.lapseNotifications.sendPaymentFailed(organizationId, invoice);
    }
  }

  /**
   * The subscription an invoice belongs to, or null when it names none — a
   * one-off invoice is not a subscription event, and is never sent to Stripe
   * as a `retrieve(undefined)` request.
   */
  private async subscriptionForInvoice(
    invoice: Stripe.Invoice,
  ): Promise<Stripe.Subscription | null> {
    const subscriptionId = subscriptionIdOf(invoice);
    if (!subscriptionId) return null;
    return this.stripe.retrieveSubscription(subscriptionId);
  }

  /**
   * Sends the paid-invoice mail when the organization opted in. The flag is on
   * the subscription row, and the recipient is the organization's owner. (A
   * failed payment's email is not opt-in: `onInvoiceFailed`.)
   */
  private async notifyInvoice(
    organizationId: string,
    invoice: Stripe.Invoice,
    options: { trialEnded?: boolean } = {},
  ): Promise<void> {
    const [row] = await this.db
      .select({
        sendInvoiceNotifications: subscription.sendInvoiceNotifications,
        email: user.email,
        // The emails greet the owner by first name.
        firstName: user.firstName,
      })
      .from(subscription)
      .innerJoin(organization, eq(organization.id, subscription.organizationId))
      .innerJoin(user, eq(user.id, organization.ownerId))
      .where(eq(subscription.organizationId, organizationId))
      .limit(1);

    if (!row?.sendInvoiceNotifications) return;

    await this.notifications.sendInvoicePaid(
      invoice,
      { email: row.email, name: row.firstName },
      options,
    );
  }

  /**
   * `customer.subscription.created`: the first event of a checkout, and the
   * one most often delivered before the others. Its subscription is recorded
   * whole — customer, id, plan, status, Add-ons — so it settles whether or
   * not `checkout.session.completed` has stored the customer yet (the
   * subscription names its Organization, `organizationForSubscription`).
   *
   * It carries the subscription as it was at creation, usually `incomplete`,
   * so once the row already holds this subscription — a later event got there
   * first — it changes nothing: an older picture never overwrites a newer one,
   * and every delivery order of the first checkout ends the same.
   */
  private async onSubscriptionCreated(
    stripeSubscription: Stripe.Subscription,
  ): Promise<void> {
    const target = await this.organizationForSubscription(
      'customer.subscription.created',
      stripeSubscription,
    );
    if (!target || target.enterprise) return;
    const { organizationId } = target;

    const [row] = await this.db
      .select({ stripeSubscriptionId: subscription.stripeSubscriptionId })
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId))
      .limit(1);
    if (row?.stripeSubscriptionId === stripeSubscription.id) return;

    await this.syncFromSubscription(organizationId, stripeSubscription, {
      stripeCustomerId: target.newCustomer,
    });
  }

  /**
   * `customer.deleted`: the customer no longer exists at Stripe, so the
   * organization keeps no reference to it, holds no plan, and has **lapsed**
   * (ADR-0052) — unless it already had, whose first moment is kept. Its
   * Servers are left as they are. A deleted customer carries no reason, so
   * the lapse email says "lapsed" when a payment had failed and "your plan
   * has ended" otherwise.
   */
  private async onCustomerDeleted(customer: Stripe.Customer): Promise<void> {
    const target = await this.organizationForCustomer(customer.id);
    if (!target) {
      this.ignoreUnknown('customer.deleted', customer.id);
      return;
    }
    if (target.enterprise) return;
    const { organizationId } = target;

    const lapse = await this.recordLapse(organizationId);
    await this.db
      .update(subscription)
      .set({
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        plan: null,
        addOns: 0,
      })
      .where(eq(subscription.organizationId, organizationId));
    await this.notifyLapse(organizationId, lapse, null);
    if (lapse) await this.boughtServerSteps.lapsed(organizationId);
  }

  /**
   * `customer.subscription.deleted`: the subscription is forgotten, the
   * organization holds no plan, and it has **lapsed** (ADR-0052): Stripe
   * stopped retrying a failed payment, or a cancel reached the end of the paid
   * month. That is the one moment; there is no second grace period here, and
   * no Server is touched — the Frozen Organization's refusals read the lapse —
   * except **Bought Servers**, its own and its Attached Organizations', which
   * are deleted at once (ADR-0071, #1398).
   * The Stripe customer is deliberately kept, so re-subscribing reuses it
   * instead of creating a second customer for the same organization.
   *
   * A deleted subscription that is not the one the organization holds (an
   * old one, after it has subscribed again) changes nothing.
   *
   * A lapse recorded here sends the lapse email to the owner and every admin:
   * "lapsed" when Stripe gave up on a payment, "your plan has ended" after a
   * cancel (`cancellation_details.reason`), each naming the day it will be
   * deleted. A lapse already recorded sends nothing again.
   */
  private async onSubscriptionDeleted(
    stripeSubscription: Stripe.Subscription,
  ): Promise<void> {
    const target = await this.organizationForSubscription(
      'customer.subscription.deleted',
      stripeSubscription,
    );
    if (!target || target.enterprise) return;
    const { organizationId } = target;
    const [row] = await this.db
      .select({ stripeSubscriptionId: subscription.stripeSubscriptionId })
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId))
      .limit(1);
    if (
      row?.stripeSubscriptionId &&
      row.stripeSubscriptionId !== stripeSubscription.id
    ) {
      return;
    }

    // A first subscription whose payment never went through expires as
    // `incomplete_expired`: it never granted the plan, so nothing lapsed.
    const lapse =
      stripeSubscription.status === 'incomplete_expired'
        ? null
        : await this.recordLapse(organizationId);
    await this.db
      .update(subscription)
      .set({
        stripeSubscriptionId: null,
        status: stripeSubscription.status,
        plan: null,
        addOns: 0,
      })
      .where(eq(subscription.organizationId, organizationId));
    await this.notifyLapse(
      organizationId,
      lapse,
      stripeSubscription.cancellation_details?.reason ?? null,
      stripeSubscription,
    );
    // Bought Servers do not wait out the 30 days: they go now (ADR-0071).
    if (lapse) await this.boughtServerSteps.lapsed(organizationId);
  }

  /**
   * Records the lapse when this is it: the row still holds the plan and has
   * not lapsed before — a first checkout whose payment never went through
   * ended a subscription that never granted anything, and an earlier lapse's
   * first moment is kept. One conditional write, so two deletion events (the
   * subscription's and the customer's) cannot both claim it. Null when
   * nothing new lapsed.
   */
  private async recordLapse(
    organizationId: string,
  ): Promise<RecordedLapse | null> {
    const lapsedAt = new Date();
    const [claimed] = await this.db
      .update(subscription)
      .set({ lapsedAt })
      .where(
        and(
          eq(subscription.organizationId, organizationId),
          isNull(subscription.lapsedAt),
          isNotNull(subscription.plan),
        ),
      )
      .returning({
        paymentFailedAt: subscription.paymentFailedAt,
        plan: subscription.plan,
        status: subscription.status,
      });
    if (!claimed) return null;
    return { lapsedAt, ...claimed };
  }

  /**
   * The lapse email, for a lapse {@link recordLapse} just recorded, and, when
   * the plan that lapsed was Business, the custom-role email.
   *
   * A free trial that ended without a charge — cancelled, or Stripe's
   * `missing_payment_method` cancel — sends "your plan has ended" worded for
   * the trial, never "lapsed": the row still said `trialing`, or the
   * ended subscription's dates say so (`endedDuringTrial`).
   */
  private async notifyLapse(
    organizationId: string,
    lapse: RecordedLapse | null,
    reason: string | null,
    stripeSubscription?: Stripe.Subscription,
  ): Promise<void> {
    if (!lapse) return;
    const deletesOn = new Date(
      lapse.lapsedAt.getTime() + DELETION_AFTER_DAYS * DAY_MS,
    );
    const inTrial = endedDuringTrial(lapse.status, stripeSubscription);
    const kind = lapseNoticeOf(reason, lapse.paymentFailedAt, inTrial);
    await this.lapseNotifications.send(
      organizationId,
      kind === 'plan-ended' && inTrial
        ? { kind, deletesOn, cause: 'trial' }
        : { kind, deletesOn },
    );
    if (lapse.plan === 'business') {
      await this.lapseNotifications.sendCustomRolesStopped(
        organizationId,
        'ended',
      );
    }
  }

  /**
   * Writes a Stripe subscription's plan, status and Add-on quantity onto the
   * organization's row, creating it when this is the organization's first
   * subscription.
   *
   * A subscription that is active (or trialing) clears a recorded lapse —
   * the Organization has paid again — and leaves a suspension as it is.
   *
   * The free trial's facts ride along: Stripe's trial end, the first
   * moment a subscription began (`firstSubscribedAt`, never cleared: one
   * trial per Organization ever), and the trial-history record of the person
   * who started a trial (`recordTrialStart`).
   *
   * Plan and Add-ons are resolved once here, against this instance's own two
   * prices, rather than re-derived from Stripe on every read. Whether the
   * status still grants the plan is decided when the allowance is read
   * (billing-allowance.ts), so it is stored verbatim.
   *
   * A plan that changes from Business to anything else — a downgrade to
   * Starter taking effect — sends the custom-role email.
   */
  private async syncFromSubscription(
    organizationId: string,
    stripeSubscription: Stripe.Subscription,
    extra: { stripeCustomerId?: string } = {},
  ): Promise<void> {
    const items = (stripeSubscription.items?.data ?? []).map((item) => ({
      priceId: item.price.id,
      quantity: item.quantity,
    }));
    const { plan, addOns } = purchasedItems(this.config.prices, items);
    const planBefore = await this.storedPlan(organizationId);

    const values = {
      stripeSubscriptionId: stripeSubscription.id,
      plan,
      status: stripeSubscription.status,
      addOns,
      ...(extra.stripeCustomerId
        ? { stripeCustomerId: extra.stripeCustomerId }
        : {}),
      trialEndsAt: trialFactsOf(stripeSubscription).trialEndsAt,
      cancelAt: cancelAtOf(stripeSubscription),
      // Paying again clears the lapse and the deletion clock's marks, and
      // only those: a suspension is an Operator's to lift (ADR-0052).
      ...(isPaidStatus(stripeSubscription.status)
        ? {
            lapsedAt: null,
            paymentFailedAt: null,
            lapseWarnedAt: null,
            deletionWarnedAt: null,
          }
        : {}),
    };

    const begun = trialFactsOf(stripeSubscription).begun;
    await this.db
      .insert(subscription)
      .values({
        organizationId,
        ...values,
        ...(begun ? { firstSubscribedAt: new Date() } : {}),
      })
      .onConflictDoUpdate({
        target: subscription.organizationId,
        set: { ...values, ...(begun ? firstSubscribedNow() : {}) },
      });
    await this.endLinkOnceActive(organizationId, stripeSubscription);
    await this.recordTrialStart(stripeSubscription);
    await this.notifyTrialStarted(organizationId, stripeSubscription);
    if (planBefore === 'business' && plan !== 'business') {
      await this.lapseNotifications.sendCustomRolesStopped(
        organizationId,
        plan === 'starter' ? 'starter' : 'ended',
      );
    }
  }

  /**
   * "Pay for it yourself": once the subscription an Attached
   * Organization's owner bought is `active` on its own row, the link ends —
   * it leaves its payer's pool and uses its own plan. Both logs record it
   * after the write, as the owner Checkout named, with no IP address, or as
   * the platform when that id is missing or the person is gone
   * (`recordLinkEvent`).
   */
  private async endLinkOnceActive(
    organizationId: string,
    stripeSubscription: Stripe.Subscription,
  ): Promise<void> {
    const ended = await endLinkPaidForItself(
      this.db,
      organizationId,
      stripeSubscription,
    );
    if (!ended) return;
    await this.auditLogs.recordLinkEvent(
      ended.ownerId
        ? { userId: ended.ownerId, actedFromOrganizationId: organizationId }
        : PLATFORM_ACTOR,
      {
        event: 'paidForItself',
        attachedOrganizationId: organizationId,
        payingOrganizationId: ended.payingOrganizationId,
      },
    );
  }

  /**
   * Once a subscription's free trial has started, the person who started it
   * goes into the Instance's trial history (ADR-0054), by the email
   * key Checkout put on the subscription's metadata, so they get no second
   * trial — even after their account and the Organization are deleted. Done
   * here rather than at Checkout, so an abandoned Checkout uses up nothing;
   * recorded once however many events carry it.
   */
  private async recordTrialStart(
    stripeSubscription: Stripe.Subscription,
  ): Promise<void> {
    const emailKey = trialEmailKeyOf(stripeSubscription);
    if (!emailKey) return;
    await recordInTrialHistory(this.db, 'email', emailKey);
  }

  /**
   * "Your trial has started", to the owner and every admin, on the
   * first sync that finds the subscription `trialing` — whichever of the
   * first checkout's events gets there first. Claimed with one conditional
   * write on a mark nothing clears, so it goes out once: there is one trial
   * per Organization ever.
   *
   * A subscription charged to a payment method waits for Checkout's card
   * check: a repeat card's trial ends at once and is charged today,
   * so it must never hear its trial started. The check passes `cardChecked`
   * for a trial it kept; before it, or for any other event, the send goes
   * only once the card's trial is this subscription's in the trial history.
   * A subscription with no payment method has no card to check.
   */
  private async notifyTrialStarted(
    organizationId: string,
    stripeSubscription: Stripe.Subscription,
    { cardChecked = false }: { cardChecked?: boolean } = {},
  ): Promise<void> {
    const quote = trialQuoteOf(this.config.prices, stripeSubscription);
    if (!quote) return;
    if (
      !cardChecked &&
      defaultPaymentMethodIdOf(stripeSubscription) &&
      !(await cardTrialClaimedBy(this.db, stripeSubscription.id))
    ) {
      return;
    }

    const [claimed] = await this.db
      .update(subscription)
      .set({ trialStartedSentAt: new Date() })
      .where(
        and(
          eq(subscription.organizationId, organizationId),
          isNull(subscription.trialStartedSentAt),
        ),
      )
      .returning({ id: subscription.id });
    if (!claimed) return;
    await this.lapseNotifications.sendTrial(organizationId, {
      kind: 'trial-started',
      ...quote,
    });
  }

  /**
   * The organization a Stripe customer pays for, or null when no
   * organization holds it. The customer id is on the organization's own row,
   * so it resolves to at most one.
   */
  private async organizationForCustomer(
    stripeCustomerId: string,
  ): Promise<WebhookTarget | null> {
    const [row] = await this.db
      .select({
        organizationId: subscription.organizationId,
        enterprise: subscription.enterprise,
      })
      .from(subscription)
      .where(eq(subscription.stripeCustomerId, stripeCustomerId))
      .limit(1);
    return row ?? null;
  }

  /**
   * The organization a subscription event is for: the one holding its
   * customer, or else the one its metadata names — checkout puts the
   * Organization's id there (`subscription_data.metadata`), so a subscription
   * or invoice event delivered before `checkout.session.completed` stored the
   * customer still resolves, and the customer is stored with it.
   *
   * Null when neither resolves — a customer Cloudgate's checkout did not
   * create, or whose Organization is gone. That is acknowledged and logged,
   * not refused: a 4xx would have Stripe retry it for days and count it
   * toward disabling the endpoint, and no retry can make it resolve. A first
   * checkout started before subscriptions carried the metadata still settles,
   * by `checkout.session.completed`, which reads the subscription as Stripe
   * holds it then.
   */
  private async organizationForSubscription(
    type: HandledEventType,
    stripeSubscription: Stripe.Subscription,
  ): Promise<WebhookTarget | null> {
    const customerId = stripeSubscription.customer as string;
    const byCustomer = await this.organizationForCustomer(customerId);
    if (byCustomer) return byCustomer;

    const organizationId = stripeSubscription.metadata?.organizationId;
    if (organizationId && (await this.organizationExists(organizationId))) {
      return {
        organizationId,
        enterprise: await this.isBilledOutsideStripe(organizationId),
        newCustomer: customerId,
      };
    }
    this.ignoreUnknown(type, customerId);
    return null;
  }

  private ignoreUnknown(type: HandledEventType, customerId: string): void {
    this.logger.warn(
      `Ignoring ${type} for Stripe customer ${customerId}: no Organization holds it or is named on its subscription`,
    );
  }

  /**
   * Whether this organization is billed outside Stripe (Enterprise), in which
   * case every branch leaves it alone.
   */
  private isBilledOutsideStripe(organizationId: string): Promise<boolean> {
    return isEnterprise(this.db, organizationId);
  }

  /** The plan the organization's row holds, before a write changes it. */
  private async storedPlan(organizationId: string): Promise<PlanName | null> {
    const [row] = await this.db
      .select({ plan: subscription.plan })
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId))
      .limit(1);
    return row?.plan ?? null;
  }

  private async organizationExists(organizationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    return !!row;
  }
}

/**
 * `firstSubscribedAt` for a subscription that has begun (trialing, active or
 * past it), on a row that already exists: now, unless an earlier one set it
 * already — the first moment is kept, so the Organization never gets a free
 * trial again.
 */
function firstSubscribedNow() {
  return {
    firstSubscribedAt: sql`coalesce(${subscription.firstSubscribedAt}, now())`,
  };
}
