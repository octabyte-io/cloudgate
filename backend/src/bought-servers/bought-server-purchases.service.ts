import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { and, asc, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import { allowanceOf, minimumAddOns } from '../cloud/billing/billing-allowance';
import { BillingConfig } from '../cloud/billing/billing.config';
import { BillingService } from '../cloud/billing/billing.service';
import { subscriptionIdOf } from '../cloud/billing/billing.plans';
import { subscription } from '../cloud/billing/billing.schema';
import { TRIAL_DAYS } from '../cloud/billing/free-trial';
import {
  payingOrganizationIdSql,
  payingOrganizationOf,
} from '../cloud/billing/paying-organization';
import { isFreshProrationDate } from '../cloud/billing/plan-upgrade';
import { customerIdOf, paymentMethodOf } from '../cloud/billing/plan-trial';
import { PurchasePayments } from '../cloud/billing/purchase-payments';
import type { PurchasePaymentListener } from '../cloud/billing/purchase-payments';
import { STRIPE_API } from '../cloud/billing/stripe-api';
import type { StripeApi } from '../cloud/billing/stripe-api';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { organization } from '../organizations/organizations.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { BoughtServerNotifications } from './bought-server-notifications.service';
import { BoughtServerStages } from './bought-server-stages.service';
import { boughtServer, boughtServerLine } from './bought-server.schema';
import type {
  BoughtServer,
  BoughtServerLine,
  BoughtServerStage,
} from './bought-server.schema';
import { BoughtServersConfig } from './bought-servers.config';
import { BoughtServersService } from './bought-servers.service';
import type { CatalogueSize } from './catalogue';
import {
  BOUGHT_SERVER_CURRENCY,
  BOUGHT_SERVER_PRODUCTS,
  daysAfter,
  itemsByPrice,
  joinParams,
  linePriceParams,
  oneMoreAddOn,
  purchaseUpdateParams,
  renewsAtOf,
  threeDSecureOf,
  threeDSecureParams,
  todayPreviewParams,
  trialChargeCents,
  trialInvoiceItemParams,
  trialInvoiceParams,
} from './purchase-lines';
import type { AddOnChange, LineToSell } from './purchase-lines';
import { idOf, invoiceCharging, purchasePaymentOf } from './purchase-payment';
import { buyPlanStateOf } from './buy-plan-state';
import type { BuyPlanState } from './buy-plan-state';
import { assertNoDeletionDate } from './deletion-date';
import {
  PAYMENT_ABANDONED_AFTER_MS,
  PAYMENT_RESUME_AFTER_MS,
  onPurchase,
} from './stages';
import { storageMonthlyUsd } from './storage';

/** What *Buy* sends: the size, the Location, the terms ticked, and the Today box's moment. */
export interface BuyInput {
  serverType: string;
  location: string;
  name?: string;
  /** Backups, as their own line, on from the moment the machine is made. */
  backups?: boolean;
  /** Extra storage in GB, as its own line: attached once the machine is made, mounted by setup. */
  storageGb?: number;
  termsAccepted: true;
  /** The proration time the Today box was worked out at, so today's charge is the one shown. */
  prorationDate: number;
  /** With no plan, the console path its Checkout returns to (`returnToSchema`). */
  returnTo?: string;
}

/**
 * Which of the four plan states the Today box speaks for (#1392):
 * - `plan`: on a paid plan; the Server joins its subscription, charged today
 *   to the renewal date.
 * - `trial`: in the Free trial; the Server is charged on its own invoice,
 *   from today to the trial's end, and joins the subscription then.
 * - `start-trial`: no plan, and the Free trial is available: Checkout starts
 *   Starter's trial, and the Server is charged with it.
 * - `start-plan`: no plan, and the Free trial is used: Starter and the
 *   Server are both paid today.
 */
export type TodayState = 'plan' | 'trial' | 'start-trial' | 'start-plan';

/** The Today box: what Buy charges now, and the dates it covers. */
export interface TodayView {
  state: TodayState;
  /** US cents charged today, everything together. */
  today: number;
  /** US cents a month for the Server's own lines, after today. */
  monthly: number;
  currency: string;
  /** The dates today's charge covers, Unix seconds: from now to the plan's renewal or the trial's end. */
  from: number;
  to: number | null;
  /** Sent back with Buy. */
  prorationDate: number;
  /** The plan Checkout starts, with no plan: Starter, its monthly price, and what it costs today (0 in the trial). */
  plan: { name: string; monthlyCents: number; todayCents: number } | null;
  /**
   * The Add-on bought with the Server because the Server count is full:
   * how many, and each one's monthly price. Null while there is room.
   */
  addOn: { quantity: number; monthlyCents: number } | null;
}

/** A Bought Server with no `server` row yet, as the Servers list shows it. */
export interface PurchaseView {
  id: string;
  name: string;
  stage: BoughtServerStage;
  /** US cents a month, every line together. */
  monthlyCents: number;
  createdAt: string;
}

/** What Buy, Finish paying and Cancel answer. */
export interface PurchaseResult {
  id: string;
  stage: BoughtServerStage;
  /** Where to finish paying (3D Secure, or the Checkout that starts the plan), while it waits for that. */
  payUrl: string | null;
}

/**
 * The stages a Bought Server is shown in while it has no `server` row:
 * before one is written, and after Delete removed it until the provider
 * has deleted everything (Deleting, then gone from the list).
 */
const IN_PROGRESS: BoughtServerStage[] = [
  'waiting_for_payment',
  'creating',
  'deleting',
];

/** A Server whose lines have been paid for, and may join the subscription. */
const PAID_STAGES: BoughtServerStage[] = [
  'creating',
  'setting_up',
  'ready',
  'changing',
];

export const NOT_OFFERED = 'Buying a Server is not offered on this instance';

/** The refusals Buy answers, said to a customer, so none names the provider. */
export const PAYMENT_REFUSED_CODE = 'BOUGHT_SERVER_PAYMENT_REFUSED';
export const PAYMENT_DROPPED_CODE = 'BOUGHT_SERVER_PAYMENT_DROPPED';
export const PREPAID_CARD_CODE = 'BOUGHT_SERVER_PREPAID_CARD';
export const PREPAID_CARD_REFUSED =
  "A prepaid card can't be used to buy a Server, so nothing was charged and no Server was bought. Change the card under Settings > Billing, then buy again.";

function paymentRefused(reason: string): HttpException {
  return new HttpException(
    {
      code: PAYMENT_REFUSED_CODE,
      message: `The payment was refused, so nothing was charged and no Server was bought. ${reason.replace(/\.?$/, '.')}`,
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

function paymentDropped(): ConflictException {
  return new ConflictException({
    code: PAYMENT_DROPPED_CODE,
    message:
      'The payment was not completed, so nothing was charged and the purchase was removed',
  });
}

function prepaidCard(): HttpException {
  return new HttpException(
    { code: PREPAID_CARD_CODE, message: PREPAID_CARD_REFUSED },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

/** A card Stripe refused outright, as the SDK throws it. */
function isCardError(error: unknown): error is { message?: string } {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { type?: unknown }).type === 'StripeCardError'
  );
}

/** Stripe's answer to a second create of a fixed Product id. */
function alreadyExists(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'resource_already_exists'
  );
}

/** A plan state Buy can charge on: a subscription that exists. */
type ChargeablePlan = Exclude<BuyPlanState, { kind: 'none' }>;

/**
 * **Buying a Server** (ADR-0071): Buy, *Finish paying* and *Cancel*, and the
 * payment's outcome from the webhook, whatever the Organization's plan state
 * (#1392).
 *
 * Buy writes the row in **Waiting for payment** with who ticked the terms
 * and when, then charges for it as the plan state says:
 *
 * - **On a plan**, the Server's line is added to the Hosted plan's
 *   subscription (the Paying Organization's, for an Attached Organization),
 *   charged at once with `always_invoice` and `pending_if_incomplete`.
 * - **In the Free trial**, a Stripe trial covers the whole subscription, so
 *   the Server is charged on its own invoice from today to the trial's end,
 *   and its lines join the subscription when the trial is over (the
 *   amendment to ADR-0054).
 * - **With no plan**, Buy answers Stripe Checkout, which starts Starter, in
 *   its Free trial when the Organization and the person are eligible
 *   (ADR-0054's email and card checks, as they are). With no trial the
 *   Server's lines are charged in that Checkout, with Starter, and a
 *   prepaid card, which Checkout cannot refuse first, has the Server's
 *   share given back. In the trial, once Checkout completes, the Server is
 *   charged on the plan as it then stands: a card that has had a trial
 *   already ends the trial at once, so the Server is then charged on the
 *   subscription.
 *
 * A full Server count adds one Add-on to the same change. The payment for
 * the Organization's first Server asks for 3D Secure, and a prepaid card is
 * refused before anything is charged, read off the card's funding type.
 *
 * Only a payment seen succeeding, by Buy itself, *Finish paying* or the
 * webhook, moves it to **Creating** and lets the provider be asked for
 * anything (`BoughtServerStages`). A refused or dropped payment, or Cancel,
 * removes the row with nothing charged.
 *
 * Who may buy: whoever may add a Server (`server: ['create']`, the
 * controller), and never an Agent, which has no route here and no tool.
 * With no plan, Checkout is billing's, so only an owner or admin starts it.
 * A frozen Organization is refused by the frozen guard, as any write is.
 */
@Injectable()
export class BoughtServerPurchases
  implements OnModuleInit, PurchasePaymentListener
{
  private readonly logger = new Logger(BoughtServerPurchases.name);
  private products?: Promise<void>;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly config: BoughtServersConfig,
    private readonly catalogue: BoughtServersService,
    private readonly billing: BillingService,
    private readonly billingConfig: BillingConfig,
    private readonly stages: BoughtServerStages,
    private readonly purchasePayments: PurchasePayments,
    private readonly notifications: BoughtServerNotifications,
  ) {}

  onModuleInit(): void {
    this.purchasePayments.listen(this);
  }

  /**
   * The Today box for one size in one Location, in each plan state: on a
   * plan, Stripe's own preview of the charge Buy makes; in the Free trial,
   * the Server to the trial's end; with no plan, Starter (free in its trial)
   * and the Server.
   */
  async today(
    ctx: PermissionCtx,
    choice: {
      serverType: string;
      location: string;
      backups?: boolean;
      storageGb?: number;
    },
    now: Date = new Date(),
  ): Promise<TodayView> {
    this.assertOffered();
    const organizationId = ctx.session.activeOrganizationId;
    const { lines } = await this.priced(choice);
    const monthly = lines.reduce((sum, line) => sum + line.monthlyCents, 0);
    const plan = await this.planStateOf(organizationId);
    const prorationDate = Math.floor(now.getTime() / 1000);
    const base = { monthly, prorationDate, from: prorationDate };

    if (plan.kind === 'none') {
      const addOns = await this.addOnsForCheckout(organizationId);
      const [starter, addOn] = await Promise.all([
        this.monthlyOf(this.billingConfig.prices.starterPriceId),
        addOns > 0
          ? this.monthlyOf(this.billingConfig.prices.addOnPriceId)
          : Promise.resolve(0),
      ]);
      const addOnView =
        addOns > 0 ? { quantity: addOns, monthlyCents: addOn } : null;
      if (await this.billing.checkoutGivesTrial(ctx)) {
        // Everything the trial holds is free until it ends; the Server is not.
        const to = daysAfter(prorationDate, TRIAL_DAYS);
        return {
          ...base,
          state: 'start-trial',
          today: lines.reduce(
            (sum, line) =>
              sum + trialChargeCents(line.monthlyCents, prorationDate, to),
            0,
          ),
          currency: BOUGHT_SERVER_CURRENCY,
          to,
          plan: { name: 'Starter', monthlyCents: starter, todayCents: 0 },
          addOn: addOnView,
        };
      }
      return {
        ...base,
        state: 'start-plan',
        today: starter + monthly + addOns * addOn,
        currency: BOUGHT_SERVER_CURRENCY,
        to: null,
        plan: { name: 'Starter', monthlyCents: starter, todayCents: starter },
        addOn: addOnView,
      };
    }

    const full = await this.countIsFull(organizationId);
    const addOnView = full
      ? {
          quantity: 1,
          monthlyCents: await this.monthlyOf(
            this.billingConfig.prices.addOnPriceId,
          ),
        }
      : null;

    if (plan.kind === 'trial') {
      const to = plan.current.trial_end ?? prorationDate;
      return {
        ...base,
        state: 'trial',
        // The Add-on, like the plan, costs nothing until the trial ends.
        today: lines.reduce(
          (sum, line) =>
            sum + trialChargeCents(line.monthlyCents, prorationDate, to),
          0,
        ),
        currency: BOUGHT_SERVER_CURRENCY,
        to,
        plan: null,
        addOn: addOnView,
      };
    }

    await this.ensureProducts();
    const preview = await this.stripe.previewInvoice(
      todayPreviewParams(
        plan.current,
        lines,
        prorationDate,
        full ? this.oneMoreAddOn(plan.current) : null,
      ),
    );
    return {
      ...base,
      state: 'plan',
      today: preview.amount_due,
      currency: preview.currency,
      to: renewsAtOf(plan.current),
      plan: null,
      addOn: addOnView,
    };
  }

  /**
   * Buy. The row is written first, so the Server counts and shows from this
   * moment; the payment then either goes through (Creating, and the machine
   * is asked for), waits for 3D Secure or for Checkout (*Finish paying*), or
   * is refused, and the row goes with nothing charged.
   */
  async buy(
    ctx: PermissionCtx,
    input: BuyInput,
    now: Date = new Date(),
  ): Promise<PurchaseResult> {
    this.assertOffered();
    const organizationId = ctx.session.activeOrganizationId;
    // Nothing more is bought while a deletion date is set (#1397).
    await assertNoDeletionDate(this.db, organizationId);
    const plan = await this.planStateOf(organizationId);
    if (!isFreshProrationDate(input.prorationDate, now.getTime() / 1000)) {
      throw new ConflictException({
        code: 'BUY_PREVIEW_STALE',
        message:
          'The amount shown is out of date. Look at the new amount, then buy again',
      });
    }
    const { size, city, lines } = await this.priced(input);
    const first = await this.isFirstServer(organizationId);

    const [row] = await this.db
      .insert(boughtServer)
      .values({
        organizationId,
        name: input.name?.trim() || `${city} ${size.vcpus} vCPU`,
        serverType: input.serverType,
        location: input.location,
        backups: input.backups ?? false,
        storageGb: input.storageGb ?? null,
        diskGb: size.diskGb,
        termsAcceptedBy: ctx.user.id,
        termsAcceptedAt: now,
      })
      .returning();

    try {
      await this.ensureProducts();
      for (const line of lines) {
        const price = await this.stripe.createPrice(
          linePriceParams(row.id, line),
        );
        await this.db.insert(boughtServerLine).values({
          boughtServerId: row.id,
          kind: line.kind,
          stripePriceId: price.id,
          monthlyCents: line.monthlyCents,
          soldAt: now,
        });
      }

      if (plan.kind === 'none') {
        // Checkout starts the plan. With no Free trial the Server's lines
        // are charged in it, with Starter; in the trial they would be free
        // with it, so the Server is charged once Checkout completes. The row
        // already counts, so Checkout's Add-ons make room for it.
        const priceIds = await this.db
          .select({ price: boughtServerLine.stripePriceId })
          .from(boughtServerLine)
          .where(eq(boughtServerLine.boughtServerId, row.id));
        const session = await this.billing.createCheckoutSession(
          ctx,
          { plan: 'starter', addOns: 0, returnTo: input.returnTo },
          {
            boughtServerId: row.id,
            threeDSecure: first,
            linePriceIds: priceIds.map((line) => line.price),
          },
        );
        await this.db
          .update(boughtServer)
          .set({ purchaseCheckoutSessionId: session.sessionId })
          .where(eq(boughtServer.id, row.id));
        return this.result(row.id, session.url);
      }

      return await this.charge(row, plan, {
        threeDSecure: first,
        prorationDate: input.prorationDate,
      });
    } catch (error) {
      return this.afterFailedCharge(row.id, error);
    }
  }

  /**
   * A charge that threw: what Stripe made of it decides, not the error. An
   * invoice it made (found by the purchase's prices when its id was never
   * stored: an answer lost after the charge) is settled as any other, so a
   * paid one moves on; with none, nothing was charged, and whatever was made
   * for it at Stripe is voided or expired with the row.
   */
  private async afterFailedCharge(
    id: string,
    error: unknown,
  ): Promise<PurchaseResult> {
    const left = await this.findRow(id);
    if (left && left.stage !== 'waiting_for_payment') {
      return this.result(id, null);
    }
    if (left) {
      const found = await this.withFoundInvoice(left).catch((lookup) => {
        this.logger.warn(
          `Bought Server purchase ${id}: looking for its invoice failed: ${String(lookup)}`,
        );
        return left;
      });
      if (found.purchaseInvoiceId) return this.settle(found);
      await this.drop(found);
    }
    if (isCardError(error)) {
      throw paymentRefused(error.message ?? 'The card was refused');
    }
    throw error;
  }

  /**
   * *Finish paying*: where the payment stands now. Paid moves it on, a
   * refused or dropped one removes it and says why, and one still waiting
   * answers where to finish it: the invoice's 3D Secure page, or the
   * Checkout that starts the plan.
   */
  async finishPaying(ctx: PermissionCtx, id: string): Promise<PurchaseResult> {
    this.assertOffered();
    const row = await this.ownRow(ctx, id);
    if (row.stage !== 'waiting_for_payment') return this.result(id, null);
    if (!row.purchaseInvoiceId && row.purchaseCheckoutSessionId) {
      const session = await this.stripe.retrieveCheckoutSession(
        row.purchaseCheckoutSessionId,
      );
      if (session.status === 'open') return this.result(id, session.url);
      if (session.status !== 'complete') {
        await this.drop(row);
        throw paymentDropped();
      }
      try {
        return await this.chargeAfterCheckout(row, session);
      } catch (error) {
        return this.afterFailedCharge(row.id, error);
      }
    }
    return this.settle(await this.withFoundInvoice(row));
  }

  /**
   * *Cancel*, while it waits for payment: the open invoice is voided, or the
   * open Checkout expired, and the row goes, with nothing charged for the
   * Server. A payment that went through meanwhile is kept, and Cancel is
   * refused.
   */
  async cancel(ctx: PermissionCtx, id: string): Promise<{ id: string }> {
    this.assertOffered();
    const row = await this.withFoundInvoice(await this.ownRow(ctx, id));
    if (row.stage === 'waiting_for_payment' && row.purchaseInvoiceId) {
      const invoice = await this.stripe.retrieveInvoice(row.purchaseInvoiceId);
      if (purchasePaymentOf(invoice).kind === 'paid') {
        await this.paidBy(row, invoice);
      }
    }
    const now = await this.findRow(id);
    const outcome = onPurchase(now?.stage ?? row.stage, 'cancelled');
    if (outcome.kind === 'refuse') {
      throw new ConflictException({
        code: 'PURCHASE_ALREADY_PAID',
        message: outcome.message,
      });
    }
    await this.drop(row);
    return { id };
  }

  /** The Organization's Bought Servers with no `server` row, being bought or deleted, oldest first. */
  async purchases(ctx: PermissionCtx): Promise<PurchaseView[]> {
    if (this.config.offer === 'absent') throw new NotFoundException();
    const rows = await this.db
      .select({
        id: boughtServer.id,
        name: boughtServer.name,
        stage: boughtServer.stage,
        createdAt: boughtServer.createdAt,
        monthlyCents: boughtServerLine.monthlyCents,
      })
      .from(boughtServer)
      .leftJoin(
        boughtServerLine,
        eq(boughtServerLine.boughtServerId, boughtServer.id),
      )
      .where(
        and(
          eq(boughtServer.organizationId, ctx.session.activeOrganizationId),
          isNull(boughtServer.serverId),
          inArray(boughtServer.stage, IN_PROGRESS),
        ),
      )
      .orderBy(asc(boughtServer.createdAt));
    const views = new Map<string, PurchaseView>();
    for (const row of rows) {
      const view = views.get(row.id) ?? {
        id: row.id,
        name: row.name,
        stage: row.stage,
        monthlyCents: 0,
        createdAt: row.createdAt.toISOString(),
      };
      view.monthlyCents += row.monthlyCents ?? 0;
      views.set(row.id, view);
    }
    return [...views.values()];
  }

  /**
   * The hourly job: a purchase still waiting for payment well after Buy is
   * read again from Stripe, so a restart or a lost webhook never leaves one
   * charged and stuck. Its invoice (found by its prices when a restart cut
   * Buy off before the id was stored) decides: paid moves it on, refused or
   * void removes it, and one still waiting for 3D Secure is given a day. A
   * purchase waiting on Checkout is removed once that Checkout has expired
   * unpaid, and charged once it has completed. One with neither was never
   * charged, and goes.
   */
  async resume(id: string, now: Date = new Date()): Promise<void> {
    const stored = await this.findRow(id);
    if (!stored || stored.stage !== 'waiting_for_payment') return;
    const age = now.getTime() - stored.createdAt.getTime();
    if (age < PAYMENT_RESUME_AFTER_MS) return;
    const row = await this.withFoundInvoice(stored);

    if (row.purchaseInvoiceId) {
      const invoice = await this.stripe.retrieveInvoice(row.purchaseInvoiceId);
      const payment = purchasePaymentOf(invoice);
      if (payment.kind === 'paid') return this.paidBy(row, invoice);
      if (payment.kind === 'waiting' && age < PAYMENT_ABANDONED_AFTER_MS) {
        return;
      }
      await this.drop(row);
      this.logger.log(
        `Bought Server purchase ${row.id} dropped by the hourly job: its payment is ${payment.kind}`,
      );
      return;
    }

    if (row.purchaseCheckoutSessionId) {
      const session = await this.stripe.retrieveCheckoutSession(
        row.purchaseCheckoutSessionId,
      );
      if (session.status === 'open') return;
      if (session.status === 'complete') {
        await this.chargeAfterCheckout(row, session).catch((error) =>
          this.afterFailedCharge(row.id, error).catch(() => undefined),
        );
        return;
      }
    }
    await this.drop(row);
    this.logger.log(
      `Bought Server purchase ${row.id} dropped by the hourly job: it was never charged`,
    );
  }

  // ---------------------------------------------------------------------------
  // The webhook (PurchasePaymentListener)
  // ---------------------------------------------------------------------------

  /** A paid invoice that is a purchase's moves it on; any other is not ours. */
  async invoicePaid(invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.id) return;
    const rows = await this.db
      .select()
      .from(boughtServer)
      .where(eq(boughtServer.purchaseInvoiceId, invoice.id));
    for (const row of rows) await this.paidBy(row, invoice);
  }

  /**
   * The update a purchase was made with expired unpaid: each purchase still
   * waiting on this subscription is read once more, and moved on if it was
   * paid after all, or dropped.
   */
  async pendingUpdateExpired(subscription: Stripe.Subscription): Promise<void> {
    const waiting = await this.db
      .select()
      .from(boughtServer)
      .where(eq(boughtServer.stage, 'waiting_for_payment'));
    for (const row of waiting) {
      if (!row.purchaseInvoiceId) continue;
      const invoice = await this.stripe.retrieveInvoice(row.purchaseInvoiceId);
      if (subscriptionIdOf(invoice) !== subscription.id) continue;
      if (purchasePaymentOf(invoice).kind === 'paid') {
        await this.paidBy(row, invoice);
      } else {
        await this.drop(row);
        this.logger.log(
          `Bought Server purchase ${row.id} dropped: its payment never came`,
        );
      }
    }
  }

  /**
   * The Checkout a purchase with no plan went through has completed, and
   * billing has stored the plan and run the card check: the Server is
   * charged now, on the plan as it stands. A refusal here has no one to
   * answer, so it is logged, and the row is left for *Finish paying* to
   * say why (a prepaid card) or is removed (a refused payment).
   */
  async checkoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const id = session.metadata?.boughtServerId;
    if (!id) return;
    const row = await this.findRow(id);
    if (!row || row.stage !== 'waiting_for_payment' || row.purchaseInvoiceId) {
      return;
    }
    try {
      await this.chargeAfterCheckout(row, session);
    } catch (error) {
      this.logger.warn(
        `Bought Server purchase ${row.id} was not charged after its Checkout: ${String(error)}`,
      );
    }
  }

  /**
   * The subscription changed. Once its Free trial is over, the lines bought
   * during it (paid on their own invoice, so with no subscription item yet)
   * join it, charged at once for the month that has just started, and each
   * line stores its item. A line already on the subscription is only
   * stored, so a webhook delivered twice adds nothing twice.
   */
  async subscriptionUpdated(current: Stripe.Subscription): Promise<void> {
    if (current.status !== 'active' && current.status !== 'past_due') return;
    const [paying] = await this.db
      .select({ organizationId: subscription.organizationId })
      .from(subscription)
      .where(eq(subscription.stripeSubscriptionId, current.id))
      .limit(1);
    if (!paying) return;

    const waiting = await this.db
      .select({
        id: boughtServerLine.id,
        price: boughtServerLine.stripePriceId,
      })
      .from(boughtServerLine)
      .innerJoin(
        boughtServer,
        eq(boughtServer.id, boughtServerLine.boughtServerId),
      )
      .innerJoin(organization, eq(organization.id, boughtServer.organizationId))
      .where(
        and(
          eq(payingOrganizationIdSql, paying.organizationId),
          isNull(boughtServerLine.stripeSubscriptionItemId),
          isNotNull(boughtServer.purchasePaidAt),
          inArray(boughtServer.stage, PAID_STAGES),
        ),
      );
    if (waiting.length === 0) return;

    // Read again rather than trusting the event: an event can be older than
    // a purchase's own update, and a price added twice is refused.
    const fresh = await this.stripe.retrieveSubscription(current.id);
    if (fresh.status !== 'active' && fresh.status !== 'past_due') return;
    const priceIds = waiting.map((line) => line.price);
    const carried = itemsByPrice(fresh, priceIds);
    const missing = priceIds.filter((price) => !carried.has(price));
    const joined =
      missing.length > 0
        ? await this.stripe.updateSubscription(fresh.id, joinParams(missing))
        : fresh;
    await this.storeItems(waiting, itemsByPrice(joined, priceIds));
  }

  // ---------------------------------------------------------------------------

  /**
   * Charges a purchase on a plan that exists: the subscription's card is
   * checked first (never a prepaid one), then the Server is charged on the
   * subscription, or on its own invoice during the Free trial.
   */
  private async charge(
    row: BoughtServer,
    plan: ChargeablePlan,
    options: { threeDSecure: boolean; prorationDate: number },
  ): Promise<PurchaseResult> {
    await this.refusePrepaid(plan.current);
    const lines = await this.linesOf(row.id);
    if (plan.kind === 'trial') {
      return this.chargeOnOwnInvoice(row, plan.current, lines, options);
    }
    return this.chargeOnSubscription(row, plan.current, lines, options);
  }

  /**
   * On a plan: the lines, and one Add-on when the count is full, added to
   * the subscription and charged at once. For the first Server the
   * subscription asks for 3D Secure on that one payment, and its own
   * setting is put back after.
   */
  private async chargeOnSubscription(
    row: BoughtServer,
    current: Stripe.Subscription,
    lines: BoughtServerLine[],
    options: { threeDSecure: boolean; prorationDate: number },
  ): Promise<PurchaseResult> {
    // The row already counts: over the count means it was full before it.
    const addOn = (await this.countIsOver(row.organizationId))
      ? this.oneMoreAddOn(current)
      : null;
    const previous = threeDSecureOf(current);
    let updated: Stripe.Subscription;
    try {
      if (options.threeDSecure) {
        await this.stripe.updateSubscription(
          current.id,
          threeDSecureParams('any'),
        );
      }
      updated = await this.stripe.updateSubscription(
        current.id,
        purchaseUpdateParams(
          lines.map((line) => line.stripePriceId),
          options.prorationDate,
          addOn,
        ),
      );
    } finally {
      if (options.threeDSecure)
        await this.restoreThreeDSecure(current.id, previous);
    }

    const invoiceId = idOf(updated.latest_invoice);
    await this.db
      .update(boughtServer)
      .set({ purchaseInvoiceId: invoiceId })
      .where(eq(boughtServer.id, row.id));

    if (!updated.pending_update) {
      await this.markPaid(row.id, updated);
      return this.result(row.id, null);
    }
    // Not paid yet: waiting for 3D Secure, or refused.
    return this.settle({ ...row, purchaseInvoiceId: invoiceId });
  }

  /**
   * In the Free trial: the lines charged on their own invoice, from today
   * to the trial's end, to the subscription's card. They join the
   * subscription when the trial is over (`subscriptionUpdated`); an Add-on
   * the full count needs is added once the payment succeeds (`markPaid`).
   */
  private async chargeOnOwnInvoice(
    row: BoughtServer,
    current: Stripe.Subscription,
    lines: BoughtServerLine[],
    options: { threeDSecure: boolean },
  ): Promise<PurchaseResult> {
    const customer = customerIdOf(current);
    const from = Math.floor(Date.now() / 1000);
    const to = current.trial_end ?? from;
    const invoice = await this.stripe.createInvoice(
      trialInvoiceParams({
        customer,
        boughtServerId: row.id,
        paymentMethod: idOf(current.default_payment_method),
        threeDSecure: options.threeDSecure,
      }),
    );
    const invoiceId = invoice.id;
    await this.db
      .update(boughtServer)
      .set({ purchaseInvoiceId: invoiceId })
      .where(eq(boughtServer.id, row.id));
    for (const line of lines) {
      await this.stripe.createInvoiceItem(
        trialInvoiceItemParams({
          customer,
          invoice: invoiceId,
          boughtServerId: row.id,
          line: { kind: line.kind, monthlyCents: line.monthlyCents },
          from,
          to,
        }),
      );
    }
    await this.stripe.finalizeInvoice(invoiceId);
    try {
      await this.stripe.payInvoice(invoiceId, {});
    } catch (error) {
      // A refused card, or one waiting for 3D Secure: the invoice says which.
      this.logger.log(
        `Free-trial invoice ${invoiceId} of Bought Server ${row.id} not paid at once: ${String(error)}`,
      );
    }
    return this.settle({ ...row, purchaseInvoiceId: invoiceId });
  }

  /**
   * After the Checkout that started the plan: the Server is charged on the
   * plan as it now stands. 3D Secure was asked for in Checkout itself.
   */
  private async chargeAfterCheckout(
    row: BoughtServer,
    session: Stripe.Checkout.Session,
  ): Promise<PurchaseResult> {
    const subscriptionId = idOf(session.subscription);
    if (!subscriptionId) throw paymentDropped();
    const current = await this.stripe.retrieveSubscription(subscriptionId);
    const plan = buyPlanStateOf({
      enterprise: false,
      hasPlan: true,
      status: current.status,
    });
    if (plan.kind === 'refused') {
      throw new ConflictException({ code: plan.code, message: plan.message });
    }
    if (plan.kind === 'none') throw paymentDropped();
    const charged = await this.chargedInCheckout(row, session, current);
    if (charged) return charged;
    return this.charge(
      row,
      plan.kind === 'trial'
        ? { kind: 'trial', current }
        : { kind: 'plan', current },
      {
        threeDSecure: false,
        prorationDate: Math.floor(Date.now() / 1000),
      },
    );
  }

  /**
   * A Checkout that started the plan with no Free trial charged the Server's
   * lines with it: the subscription carries them, and Checkout's invoice is
   * the purchase's. Its payment is then settled as any other. A prepaid card
   * cannot be refused before Checkout takes it, so it is refused here: the
   * Server's share of the invoice is given back and its lines taken off,
   * and the purchase removed. Null when the lines are not on the
   * subscription: the Server is still to be charged.
   */
  private async chargedInCheckout(
    row: BoughtServer,
    session: Stripe.Checkout.Session,
    current: Stripe.Subscription,
  ): Promise<PurchaseResult | null> {
    const lines = await this.linesOf(row.id);
    const prices = lines.map((line) => line.stripePriceId);
    if (lines.length === 0 || itemsByPrice(current, prices).size === 0) {
      return null;
    }
    const invoiceId =
      idOf(session.invoice) ?? idOf(current.latest_invoice) ?? null;
    await this.db
      .update(boughtServer)
      .set({ purchaseInvoiceId: invoiceId })
      .where(eq(boughtServer.id, row.id));
    const charged = { ...row, purchaseInvoiceId: invoiceId };
    try {
      await this.refusePrepaid(current);
    } catch (error) {
      const invoice = invoiceId
        ? await this.stripe.retrieveInvoice(invoiceId)
        : null;
      const givenBack = invoice
        ? await this.stages.giveBackPurchase(charged, invoice)
        : null;
      await this.remove(row.id);
      await this.notifications.sendRefunded({
        organizationId: row.organizationId,
        serverName: row.name,
        amountCents: givenBack?.cents ?? null,
        refundedTo: givenBack?.to ?? 'card',
        currency: invoice?.currency ?? null,
        reason: 'prepaid-card',
      });
      this.logger.warn(
        `Bought Server purchase ${row.id}: a prepaid card paid its Checkout; the Server's share was given back`,
      );
      throw error;
    }
    return this.settle(charged);
  }

  /**
   * Refuses a prepaid card before anything is charged (ADR-0071), read off
   * the card's funding type: the subscription's card, or the customer's.
   * With no card on file there is nothing to read; Stripe refuses the
   * payment itself.
   */
  private async refusePrepaid(current: Stripe.Subscription): Promise<void> {
    let method = paymentMethodOf(current, null);
    if (!method) {
      const customer = await this.stripe.retrieveCustomer(
        customerIdOf(current),
      );
      method = customer ? paymentMethodOf(current, customer) : null;
    }
    if (!method) return;
    const card =
      typeof method === 'string'
        ? await this.stripe.retrievePaymentMethod(method)
        : method;
    if (card?.card?.funding === 'prepaid') throw prepaidCard();
  }

  /** Puts the subscription's own 3D Secure setting back; a failure is logged, not thrown. */
  private async restoreThreeDSecure(
    subscriptionId: string,
    previous: ReturnType<typeof threeDSecureOf>,
  ): Promise<void> {
    try {
      await this.stripe.updateSubscription(
        subscriptionId,
        threeDSecureParams(previous),
      );
    } catch (error) {
      this.logger.warn(
        `Could not put back the 3D Secure setting of subscription ${subscriptionId}: ${String(error)}`,
      );
    }
  }

  /** Reads the purchase's invoice and acts on it: paid, waiting, refused or dropped. */
  private async settle(row: BoughtServer): Promise<PurchaseResult> {
    if (!row.purchaseInvoiceId) return this.result(row.id, null);
    const invoice = await this.stripe.retrieveInvoice(row.purchaseInvoiceId);
    const payment = purchasePaymentOf(invoice);
    switch (payment.kind) {
      case 'paid':
        await this.paidBy(row, invoice);
        return this.result(row.id, null);
      case 'waiting':
        return this.result(row.id, payment.payUrl);
      case 'refused':
        await this.drop(row);
        throw paymentRefused(payment.message);
      case 'dropped':
        await this.drop(row);
        throw paymentDropped();
    }
  }

  /**
   * The purchase's invoice was paid: moved on, with the subscription as it
   * is now, or with none for an invoice of its own (the Free trial's).
   */
  private async paidBy(
    row: BoughtServer,
    invoice: Stripe.Invoice,
  ): Promise<void> {
    const subscriptionId = subscriptionIdOf(invoice);
    await this.markPaid(
      row.id,
      subscriptionId
        ? await this.stripe.retrieveSubscription(subscriptionId)
        : null,
    );
  }

  /**
   * The payment succeeded: claimed once with a conditional write (Buy, the
   * webhook and *Finish paying* may all see it), the lines' subscription
   * items stored, and the stages carried on: the machine is asked for now,
   * and never before. Paid on its own invoice in the Free trial, its lines
   * carry no item yet, and an Add-on the full count needs is added now.
   */
  private async markPaid(
    id: string,
    current: Stripe.Subscription | null,
  ): Promise<void> {
    const row = await this.findRow(id);
    if (!row || onPurchase(row.stage, 'paid').kind !== 'advance') return;
    const [claimed] = await this.db
      .update(boughtServer)
      .set({ stage: 'creating', purchasePaidAt: new Date() })
      .where(
        and(
          eq(boughtServer.id, id),
          eq(boughtServer.stage, 'waiting_for_payment'),
        ),
      )
      .returning({ id: boughtServer.id });
    if (!claimed) return;

    if (current) {
      const lines = await this.linesOf(id);
      await this.storeItems(
        lines.map((line) => ({ id: line.id, price: line.stripePriceId })),
        itemsByPrice(
          current,
          lines.map((line) => line.stripePriceId),
        ),
      );
    } else {
      await this.addOnIfOver(row.organizationId);
    }
    await this.stages.advance(id);
  }

  /**
   * One more Add-on on the plan's subscription when the count is over, as a
   * purchase paid during the Free trial leaves it: free until the trial
   * ends, like every Add-on in it.
   */
  private async addOnIfOver(organizationId: string): Promise<void> {
    if (!(await this.countIsOver(organizationId))) return;
    const plan = await this.planStateOf(organizationId).catch(() => null);
    if (!plan || plan.kind === 'none') return;
    try {
      await this.stripe.updateSubscription(plan.current.id, {
        items: [this.oneMoreAddOn(plan.current)],
        proration_behavior: 'create_prorations',
      });
    } catch (error) {
      this.logger.warn(
        `Could not add the Add-on for a Bought Server of ${organizationId}: ${String(error)}`,
      );
    }
  }

  private async storeItems(
    lines: Array<{ id: string; price: string }>,
    items: Map<string, string>,
  ): Promise<void> {
    for (const line of lines) {
      const item = items.get(line.price);
      if (!item) continue;
      await this.db
        .update(boughtServerLine)
        .set({ stripeSubscriptionItemId: item })
        .where(eq(boughtServerLine.id, line.id));
    }
  }

  /**
   * Removes a purchase that was never paid, voiding its open invoice, or
   * expiring its open Checkout, first so nothing is ever charged for it.
   * Stripe's refusal to void an invoice that is already void or was never
   * finalized, or to expire a Checkout that is not open, changes nothing.
   */
  private async drop(row: BoughtServer): Promise<void> {
    if (row.purchaseInvoiceId) {
      try {
        await this.stripe.voidInvoice(row.purchaseInvoiceId);
      } catch (error) {
        this.logger.warn(
          `Could not void invoice ${row.purchaseInvoiceId} of Bought Server purchase ${row.id}: ${String(error)}`,
        );
      }
    } else if (row.purchaseCheckoutSessionId) {
      try {
        await this.stripe.expireCheckoutSession(row.purchaseCheckoutSessionId);
      } catch (error) {
        this.logger.warn(
          `Could not expire Checkout ${row.purchaseCheckoutSessionId} of Bought Server purchase ${row.id}: ${String(error)}`,
        );
      }
    }
    await this.remove(row.id);
  }

  private async remove(id: string): Promise<void> {
    await this.db
      .delete(boughtServer)
      .where(
        and(
          eq(boughtServer.id, id),
          eq(boughtServer.stage, 'waiting_for_payment'),
        ),
      );
  }

  /**
   * The size and Location chosen, priced from the catalogue the page shows,
   * with a backups line when they are chosen: refused when the size is not
   * sold there, or not right now, and a storage line when it is chosen.
   */
  private async priced(choice: {
    serverType: string;
    location: string;
    backups?: boolean;
    storageGb?: number;
  }): Promise<{ size: CatalogueSize; city: string; lines: LineToSell[] }> {
    const catalogue = await this.catalogue.catalogue();
    const location = catalogue.locations.find((l) => l.id === choice.location);
    const size = catalogue.sizes.find((s) => s.id === choice.serverType);
    const offer = size?.offers.find((o) => o.locationId === choice.location);
    if (!location || !size || !offer) {
      throw new BadRequestException({
        code: 'SIZE_NOT_SOLD',
        message: 'That size is not sold in that location',
      });
    }
    if (!offer.available) {
      throw new ConflictException({
        code: 'SIZE_UNAVAILABLE',
        message: `That size can't be bought in ${location.city} right now. Pick another size or location`,
      });
    }
    return {
      size,
      city: location.city,
      lines: [
        { kind: 'server', monthlyCents: offer.monthly * 100 },
        ...(choice.backups
          ? [
              {
                kind: 'backups' as const,
                monthlyCents: offer.backupsMonthly * 100,
              },
            ]
          : []),
        ...(choice.storageGb
          ? [
              {
                kind: 'storage' as const,
                monthlyCents:
                  storageMonthlyUsd(catalogue.storage, choice.storageGb) * 100,
              },
            ]
          : []),
      ],
    };
  }

  /**
   * The plan the Server is charged on: the Hosted plan of the Paying
   * Organization (ADR-0059), read live from Stripe, or none. Refused for
   * Enterprise, billed by agreement, and while a payment is overdue.
   */
  private async planStateOf(organizationId: string): Promise<BuyPlanState> {
    const { subscription: row } = await payingOrganizationOf(
      this.db,
      organizationId,
    );
    const hasPlan = !!allowanceOf(row).plan && !!row?.stripeSubscriptionId;
    const current =
      hasPlan && !row?.enterprise
        ? await this.stripe.retrieveSubscription(row.stripeSubscriptionId!)
        : null;
    const state = buyPlanStateOf({
      enterprise: !!row?.enterprise,
      hasPlan,
      status: current?.status ?? null,
    });
    if (state.kind === 'refused') {
      throw new ConflictException({ code: state.code, message: state.message });
    }
    if (state.kind === 'none') return state;
    return state.kind === 'trial'
      ? { kind: 'trial', current: current! }
      : { kind: 'plan', current: current! };
  }

  /** Whether the pool's Server count is full, before this purchase. */
  private async countIsFull(organizationId: string): Promise<boolean> {
    const { allowance, usage } =
      await this.billing.allowanceFor(organizationId);
    return usage.servers >= allowance.servers;
  }

  /** Whether the pool holds more Servers than its count, a purchase already counted. */
  private async countIsOver(organizationId: string): Promise<boolean> {
    const { allowance, usage } =
      await this.billing.allowanceFor(organizationId);
    return usage.servers > allowance.servers;
  }

  /** The Add-ons a Checkout with this purchase takes: enough for what is held, and this Server. */
  private async addOnsForCheckout(organizationId: string): Promise<number> {
    const { usage } = await this.billing.allowanceFor(organizationId);
    return minimumAddOns({ ...usage, servers: usage.servers + 1 });
  }

  private oneMoreAddOn(current: Stripe.Subscription): AddOnChange {
    const addOnPriceId = this.billingConfig.prices.addOnPriceId;
    if (!addOnPriceId) {
      throw new ConflictException({
        code: 'CHECKOUT_NOT_CONFIGURED',
        message:
          'The Add-on is not set up on this Cloudgate, so the Server count cannot be raised',
      });
    }
    return oneMoreAddOn(current, addOnPriceId);
  }

  /** A price's monthly amount in US cents; 0 when it is unset or Stripe has none. */
  private async monthlyOf(priceId: string | undefined): Promise<number> {
    if (!priceId) return 0;
    const price = await this.stripe.retrievePrice(priceId);
    return price?.unit_amount ?? 0;
  }

  /** Whether the Organization has never bought a Server: its first asks for 3D Secure. */
  private async isFirstServer(organizationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ count: count() })
      .from(boughtServer)
      .where(eq(boughtServer.organizationId, organizationId));
    return (row?.count ?? 0) === 0;
  }

  /**
   * The row with its purchase invoice, found among the paying customer's
   * invoices when its id was never stored (`invoiceCharging`) and stored now,
   * so everything after reads it as usual. As it was when it names one, or
   * when none is there.
   */
  private async withFoundInvoice(row: BoughtServer): Promise<BoughtServer> {
    if (row.purchaseInvoiceId || row.stage !== 'waiting_for_payment') {
      return row;
    }
    const { subscription: paying } = await payingOrganizationOf(
      this.db,
      row.organizationId,
    );
    if (!paying?.stripeCustomerId) return row;
    const lines = await this.linesOf(row.id);
    const invoices =
      (await this.stripe.listInvoices(paying.stripeCustomerId)) ?? [];
    const found = invoiceCharging(
      invoices,
      row.id,
      lines.map((line) => line.stripePriceId),
    );
    if (!found?.id) return row;
    await this.db
      .update(boughtServer)
      .set({ purchaseInvoiceId: found.id })
      .where(
        and(
          eq(boughtServer.id, row.id),
          isNull(boughtServer.purchaseInvoiceId),
        ),
      );
    return { ...row, purchaseInvoiceId: found.id };
  }

  private linesOf(id: string): Promise<BoughtServerLine[]> {
    return this.db
      .select()
      .from(boughtServerLine)
      .where(eq(boughtServerLine.boughtServerId, id));
  }

  /** The three fixed Products, made once per Stripe account and once per process. */
  private ensureProducts(): Promise<void> {
    this.products ??= (async () => {
      for (const product of Object.values(BOUGHT_SERVER_PRODUCTS)) {
        try {
          await this.stripe.createProduct({
            id: product.id,
            name: product.name,
          });
        } catch (error) {
          if (!alreadyExists(error)) throw error;
        }
      }
    })();
    this.products.catch(() => {
      this.products = undefined;
    });
    return this.products;
  }

  private assertOffered(): void {
    const offer = this.config.offer;
    if (offer === 'absent') throw new NotFoundException();
    if (offer === 'not-offered') throw new NotFoundException(NOT_OFFERED);
  }

  private async ownRow(ctx: PermissionCtx, id: string): Promise<BoughtServer> {
    const [row] = await this.db
      .select()
      .from(boughtServer)
      .where(
        and(
          eq(boughtServer.id, id),
          eq(boughtServer.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Server not found');
    return row;
  }

  private async findRow(id: string): Promise<BoughtServer | null> {
    const [row] = await this.db
      .select()
      .from(boughtServer)
      .where(eq(boughtServer.id, id))
      .limit(1);
    return row ?? null;
  }

  private async result(
    id: string,
    payUrl: string | null,
  ): Promise<PurchaseResult> {
    const row = await this.findRow(id);
    // Paid, then gone: never made, so refunded and removed (#1391).
    return { id, stage: row?.stage ?? 'failed', payUrl };
  }
}
