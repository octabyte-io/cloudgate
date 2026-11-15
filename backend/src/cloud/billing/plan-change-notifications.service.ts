import { Inject, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { renderAddOnsChangedEmail } from '../../mail/templates/add-ons-changed';
import { renderPlanChangedEmail } from '../../mail/templates/plan-changed';
import type { PlanChangedFacts } from '../../mail/templates/plan-changed';
import type { PlanFacts } from '../../mail/templates/plan-facts';
import { formatAmount } from './billing-notifications.service';
import { BillingConfig } from './billing.config';
import { PLAN_LABELS } from './billing.plans';
import type { PlanName } from './billing.plans';
import type { MonthlyAmount } from './free-trial';
import { formatDate, LapseNotifications } from './lapse-notifications.service';
import { STRIPE_API } from './stripe-api';
import type { StripeApi } from './stripe-api';

/**
 * A plan change, with its dates and amounts still raw. `from` is the day the
 * plan's monthly amount is charged from, for the facts block.
 */
export type PlanChange =
  | { kind: 'upgraded'; chargedToday: MonthlyAmount | null; from: Date }
  | { kind: 'move-scheduled'; movesOn: Date }
  | { kind: 'moved'; from: Date }
  | { kind: 'kept-business'; from: Date }
  | { kind: 'trial-switch'; to: PlanName; trialEndsOn: Date };

/**
 * An Add-on count Stripe accepted, from `was`: prorated, free during the
 * Free trial, or prorated while a move to Starter waits for `movesOn`. `from`
 * is the next day the plan is charged on, for the facts block.
 */
export type AddOnsChange = { was: number; from: Date } & (
  { kind: 'prorated' | 'trial' } | { kind: 'move-waiting'; movesOn: Date }
);

/**
 * "Your plan changed" (spec #69, #73), to every owner and admin, always. The
 * caller sends it once, beside the conditional write that recorded the
 * change; this words it and sends it, and never throws for an amount it
 * could not read: the email then points at the Billing page.
 *
 * "Your Add-ons changed" (#74) goes the same way, from {@link sendAddOnsChanged}.
 *
 * {@link planFactsOf} is the plan-and-Add-ons facts block, the plan, its
 * Add-ons and what they cost per month at this instance's catalogue prices,
 * which "Your Add-ons changed" reuses.
 */
@Injectable()
export class PlanChangeNotifications {
  private readonly logger = new Logger(PlanChangeNotifications.name);

  constructor(
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly config: BillingConfig,
    private readonly notifications: LapseNotifications,
  ) {}

  /**
   * Sends "Your plan changed" for `change`, the plan then being `plan` with
   * `addOns`. Never throws: its caller's write already committed, and Stripe
   * already made the change, so a failure here is logged, never answered as
   * a failed change (CODING_STANDARDS §2.3).
   */
  async sendPlanChanged(
    organizationId: string,
    change: PlanChange,
    plan: PlanName,
    addOns: number,
  ): Promise<void> {
    try {
      await this.sendPlanChangedOrThrow(organizationId, change, plan, addOns);
    } catch (error) {
      this.logger.error(
        `Could not send the plan-changed email: ${String(error)}`,
      );
    }
  }

  private async sendPlanChangedOrThrow(
    organizationId: string,
    change: PlanChange,
    plan: PlanName,
    addOns: number,
  ): Promise<void> {
    const facts = await this.planFactsOf(plan, addOns, fromOf(change));
    const billingUrl = `${this.config.siteUrl}/settings/billing`;
    await this.notifications.sendToOwnersAndAdmins(
      organizationId,
      'plan-changed',
      (recipient, organizationName) =>
        renderPlanChangedEmail({
          userName: recipient.name,
          organizationName,
          change: formatted(change),
          plan: facts,
          billingUrl,
        }),
    );
  }

  /**
   * Sends "Your Add-ons changed" for `change`, the plan then being `plan`
   * with `addOns` (Starter while a move to it waits).
   */
  async sendAddOnsChanged(
    organizationId: string,
    change: AddOnsChange,
    plan: PlanName,
    addOns: number,
  ): Promise<void> {
    const facts = await this.planFactsOf(plan, addOns, change.from);
    const billingUrl = `${this.config.siteUrl}/settings/billing`;
    await this.notifications.sendToOwnersAndAdmins(
      organizationId,
      'add-ons-changed',
      (recipient, organizationName) =>
        renderAddOnsChangedEmail({
          userName: recipient.name,
          organizationName,
          was: change.was,
          change:
            change.kind === 'move-waiting'
              ? { kind: 'move-waiting', movesOn: formatDate(change.movesOn) }
              : { kind: change.kind },
          plan: facts,
          billingUrl,
        }),
    );
  }

  /**
   * The facts block for `plan` with `addOns` Add-ons, charged from `from`:
   * the monthly amount is the plan's price and the Add-on's times the count,
   * as Stripe prices them, so a Bought Server's lines never count. Null
   * amount when a price cannot be read or the two disagree on currency.
   */
  async planFactsOf(
    plan: PlanName,
    addOns: number,
    from: Date,
  ): Promise<PlanFacts> {
    const monthly = await this.monthlyOf(plan, addOns);
    return {
      planLabel: PLAN_LABELS[plan],
      addOns,
      monthly: monthly ? formatAmount(monthly.amount, monthly.currency) : null,
      from: formatDate(from),
    };
  }

  /**
   * What an upgrade charged today: the amount paid on the subscription's
   * latest invoice, which `always_invoice` made for the prorations. Null when
   * it cannot be read.
   */
  async chargedTodayOf(
    stripeSubscription: Pick<Stripe.Subscription, 'latest_invoice'>,
  ): Promise<MonthlyAmount | null> {
    const latest = stripeSubscription.latest_invoice;
    if (!latest) return null;
    try {
      const invoice =
        typeof latest === 'string'
          ? await this.stripe.retrieveInvoice(latest)
          : latest;
      return typeof invoice.amount_paid === 'number' && invoice.currency
        ? { amount: invoice.amount_paid, currency: invoice.currency }
        : null;
    } catch (error) {
      this.logger.warn(
        `Could not read the upgrade's invoice for the plan-changed email: ${String(error)}`,
      );
      return null;
    }
  }

  private async monthlyOf(
    plan: PlanName,
    addOns: number,
  ): Promise<MonthlyAmount | null> {
    const prices = this.config.prices;
    const planPriceId =
      plan === 'business' ? prices.businessPriceId : prices.starterPriceId;
    if (!planPriceId || (addOns > 0 && !prices.addOnPriceId)) return null;
    try {
      const [planPrice, addOnPrice] = await Promise.all([
        this.stripe.retrievePrice(planPriceId),
        addOns > 0 && prices.addOnPriceId
          ? this.stripe.retrievePrice(prices.addOnPriceId)
          : Promise.resolve(null),
      ]);
      const currency = planPrice.currency;
      if (typeof planPrice.unit_amount !== 'number') return null;
      if (!addOnPrice) return { amount: planPrice.unit_amount, currency };
      if (
        typeof addOnPrice.unit_amount !== 'number' ||
        addOnPrice.currency !== currency
      ) {
        return null;
      }
      return {
        amount: planPrice.unit_amount + addOnPrice.unit_amount * addOns,
        currency,
      };
    } catch (error) {
      this.logger.warn(
        `Could not read the plan's prices for the plan-changed email: ${String(error)}`,
      );
      return null;
    }
  }
}

/** The day the plan's monthly amount runs from, for each change. */
function fromOf(change: PlanChange): Date {
  switch (change.kind) {
    case 'move-scheduled':
      return change.movesOn;
    case 'trial-switch':
      return change.trialEndsOn;
    default:
      return change.from;
  }
}

function formatted(change: PlanChange): PlanChangedFacts {
  switch (change.kind) {
    case 'upgraded':
      return {
        kind: 'upgraded',
        chargedToday: change.chargedToday
          ? formatAmount(
              change.chargedToday.amount,
              change.chargedToday.currency,
            )
          : null,
      };
    case 'move-scheduled':
      return { kind: 'move-scheduled', movesOn: formatDate(change.movesOn) };
    case 'trial-switch':
      return {
        kind: 'trial-switch',
        to: change.to,
        trialEndsOn: formatDate(change.trialEndsOn),
      };
    case 'moved':
    case 'kept-business':
      return { kind: change.kind };
  }
}
