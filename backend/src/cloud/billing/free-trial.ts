import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { DrizzleDB } from '../../db/drizzle.module';
import { purchasedItems } from './billing.plans';
import type { PlanName, StripePriceCatalogue } from './billing.plans';
import { subscription, trialHistory } from './billing.schema';
import type { Subscription, TrialHistoryKind } from './billing.schema';

/**
 * The free trial (ADR-0054): the first 30 days of a Hosted plan,
 * through Stripe's own subscription trial in Checkout.
 *
 * Who gets one is decided before Checkout, by two checks that must both pass:
 *
 * - **the Organization** has never held a subscription (a trial included),
 *   been Enterprise or been attached — `organizationTrialUsed`, over three
 *   sticky columns on `subscription` that nothing clears;
 * - **the person starting it** has never had one by their email —
 *   `emailHadTrial`, over the Instance's `trial_history`, which outlives the
 *   account and the Organization.
 *
 * The third check, the card, can only run after Checkout: the webhook
 * reads the card's Stripe fingerprint off the new trialing subscription and,
 * when another trial has had that card, ends this one at once —
 * `claimCardTrial`.
 *
 * Plain functions over the tables, like `enterprise.ts`, so the Operator page
 * and the trial emails can ask the same questions.
 */

/** How long a free trial lasts. */
export const TRIAL_DAYS = 30;

/**
 * The `subscription_data` metadata key under which Checkout carries the
 * starting person's `trialEmailKey`, so the webhook can record it once the
 * trial has started — never at session creation, so an abandoned Checkout
 * uses up nothing. It is a keyed hash, not an address.
 */
export const TRIAL_EMAIL_METADATA_KEY = 'trialEmailKey';

/** The label the email key is derived from `APP_ENCRYPTION_SECRET` under. */
const TRIAL_EMAIL_KEY_LABEL = 'cloudgate:trial-history-email:v1';

/**
 * What `trial_history` stores for an email: HMAC-SHA256 of the trimmed,
 * lower-cased address, under a key derived from the Instance's secret the way
 * the column-encryption key is. Keyed, so the history cannot be checked
 * against a list of addresses by anyone without the secret; deterministic, so
 * the same person is found again whatever case they type.
 */
export function trialEmailKey(secret: string, email: string): string {
  if (!secret) {
    throw new Error(
      'APP_ENCRYPTION_SECRET is not set; the free-trial history cannot be keyed without it',
    );
  }
  const key = createHmac('sha256', secret)
    .update(TRIAL_EMAIL_KEY_LABEL)
    .digest();
  return createHmac('sha256', key)
    .update(email.trim().toLowerCase())
    .digest('hex');
}

/**
 * Whether this Organization has had its one free trial, or can no longer have
 * one: it has held a Stripe subscription (a trial is one), been Enterprise or
 * been an Attached Organization, now or ever. Lapsing and coming back does not make it eligible again. What
 * the Operator page reads as "Trial used".
 */
export async function organizationTrialUsed(
  db: DrizzleDB,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      firstSubscribedAt: subscription.firstSubscribedAt,
      firstEnterpriseAt: subscription.firstEnterpriseAt,
      firstAttachedAt: subscription.firstAttachedAt,
    })
    .from(subscription)
    .where(eq(subscription.organizationId, organizationId))
    .limit(1);
  return trialUsedOf(row ?? null);
}

/**
 * {@link organizationTrialUsed} over the three sticky columns of a
 * `subscription` row already read (null with no row): pure, so a list read
 * that has joined the row (the Operator page) asks the same question without
 * a query per Organization.
 *
 * `firstAttachedAt` is the third: having been an Attached Organization counts
 * as having held a plan, so one never gets a trial, even once detached
 * (ADR-0059).
 */
export function trialUsedOf(
  row: Pick<
    Subscription,
    'firstSubscribedAt' | 'firstEnterpriseAt' | 'firstAttachedAt'
  > | null,
): boolean {
  return (
    !!row?.firstSubscribedAt ||
    !!row?.firstEnterpriseAt ||
    !!row?.firstAttachedAt
  );
}

/** Whether `value` of `kind` is in the trial history. */
export async function inTrialHistory(
  db: DrizzleDB,
  kind: TrialHistoryKind,
  value: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: trialHistory.id })
    .from(trialHistory)
    .where(and(eq(trialHistory.kind, kind), eq(trialHistory.value, value)))
    .limit(1);
  return !!row;
}

/** Whether the person with this email key has had a free trial. */
export function emailHadTrial(
  db: DrizzleDB,
  emailKey: string,
): Promise<boolean> {
  return inTrialHistory(db, 'email', emailKey);
}

/**
 * Adds `value` of `kind` to the trial history; already there, it changes
 * nothing, so a webhook delivered twice records once.
 */
export async function recordInTrialHistory(
  db: DrizzleDB,
  kind: TrialHistoryKind,
  value: string,
): Promise<void> {
  await db.insert(trialHistory).values({ kind, value }).onConflictDoNothing();
}

/**
 * Claims the card's one free trial for this Stripe subscription: true when
 * the trial is this subscription's — the card's first, now recorded, or this
 * same subscription's already (a webhook delivered again) — and false when
 * another subscription's trial had the card first, so this trial is to end
 * now.
 *
 * One conditional insert decides it, so two Checkouts on the same card at
 * once cannot both keep their trial.
 */
export async function claimCardTrial(
  db: DrizzleDB,
  fingerprint: string,
  stripeSubscriptionId: string,
): Promise<boolean> {
  const [claimed] = await db
    .insert(trialHistory)
    .values({ kind: 'card', value: fingerprint, stripeSubscriptionId })
    .onConflictDoNothing()
    .returning({ id: trialHistory.id });
  if (claimed) return true;
  const [row] = await db
    .select({ stripeSubscriptionId: trialHistory.stripeSubscriptionId })
    .from(trialHistory)
    .where(
      and(eq(trialHistory.kind, 'card'), eq(trialHistory.value, fingerprint)),
    )
    .limit(1);
  return row?.stripeSubscriptionId === stripeSubscriptionId;
}

/**
 * Whether this Stripe subscription has claimed a card's free trial
 * (`claimCardTrial`): its card was checked at Checkout and the trial is its
 * own, so "your trial has started" may go out.
 */
export async function cardTrialClaimedBy(
  db: DrizzleDB,
  stripeSubscriptionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: trialHistory.id })
    .from(trialHistory)
    .where(
      and(
        eq(trialHistory.kind, 'card'),
        eq(trialHistory.stripeSubscriptionId, stripeSubscriptionId),
      ),
    )
    .limit(1);
  return !!row;
}

/** The id of the payment method a subscription is charged to, if any. */
export function defaultPaymentMethodIdOf(
  stripeSubscription: Stripe.Subscription,
): string | null {
  const method = stripeSubscription.default_payment_method;
  if (!method) return null;
  return typeof method === 'string' ? method : method.id;
}

/**
 * The free trial's part of a Checkout session's parameters: always collect a
 * card, and, when the trial is given, Stripe's 30-day trial, which cancels at
 * its end if the card has been removed (a lapse, ADR-0052), and the person's
 * email key for the webhook to record. Merged into `subscription_data` by
 * `createCheckoutSession`.
 */
export function trialCheckoutParams(emailKey: string | null): {
  payment_method_collection: 'always';
  subscription_data: Pick<
    Stripe.Checkout.SessionCreateParams.SubscriptionData,
    'trial_period_days' | 'trial_settings' | 'metadata'
  >;
} {
  return {
    payment_method_collection: 'always',
    subscription_data: emailKey
      ? {
          trial_period_days: TRIAL_DAYS,
          trial_settings: {
            end_behavior: { missing_payment_method: 'cancel' },
          },
          metadata: { [TRIAL_EMAIL_METADATA_KEY]: emailKey },
        }
      : {},
  };
}

/**
 * The trial facts a Stripe subscription carries, as the webhook stores them:
 * when its trial ends (or ended), and whether it has begun at all — a first
 * payment still `incomplete` (or never completed) has not, so it uses up no
 * trial. Pure, for `syncFromSubscription`.
 */
export function trialFactsOf(stripeSubscription: Stripe.Subscription): {
  trialEndsAt: Date | null;
  begun: boolean;
} {
  const trialEnd = stripeSubscription.trial_end;
  return {
    trialEndsAt:
      typeof trialEnd === 'number' ? new Date(trialEnd * 1000) : null,
    begun: !NOT_BEGUN_STATUSES.has(stripeSubscription.status),
  };
}

/** The email key a trialing subscription's Checkout carried, if any. */
export function trialEmailKeyOf(
  stripeSubscription: Stripe.Subscription,
): string | null {
  if (stripeSubscription.trial_end == null) return null;
  return stripeSubscription.metadata?.[TRIAL_EMAIL_METADATA_KEY] || null;
}

/** Whether a Stripe status is a free trial's: `trialing`. */
export function isTrialStatus(status: string | null | undefined): boolean {
  return status === 'trialing';
}

/**
 * When the Organization's free trial ends, while it is in one — it holds a
 * subscription that is `trialing` with a trial end — and null otherwise. The
 * one reader of "in a trial now" for the Billing page and the trial
 * emails.
 */
export function trialEndsAtOf(
  row: Pick<
    Subscription,
    'status' | 'trialEndsAt' | 'stripeSubscriptionId'
  > | null,
): Date | null {
  if (!row?.stripeSubscriptionId || !isTrialStatus(row.status)) return null;
  return row.trialEndsAt ?? null;
}

const NOT_BEGUN_STATUSES = new Set<string>([
  'incomplete',
  'incomplete_expired',
]);

/**
 * Whether a subscription that just ended ended inside its free trial, so
 * nothing was ever charged: the row still said `trialing` when it
 * ended, or Stripe's own dates say it ended no later than the trial did — a
 * cancel taking effect on day 30, Stripe's `missing_payment_method` cancel,
 * or an immediate cancel mid-trial. A subscription paid for after its trial
 * ended later than the trial did, so it is not one. Pure, for the lapse
 * email's wording.
 */
export function endedDuringTrial(
  storedStatus: string | null | undefined,
  stripeSubscription?: Pick<Stripe.Subscription, 'trial_end' | 'ended_at'>,
): boolean {
  if (isTrialStatus(storedStatus)) return true;
  const trialEnd = stripeSubscription?.trial_end;
  const endedAt = stripeSubscription?.ended_at;
  return (
    typeof trialEnd === 'number' &&
    typeof endedAt === 'number' &&
    endedAt <= trialEnd
  );
}

/**
 * What a trial email quotes about a `trialing` subscription: when the
 * trial ends, the plan and Add-ons it holds now against this instance's
 * prices, and what they cost per month. Null when it is not in a trial or
 * carries no plan this instance sells.
 */
export function trialQuoteOf(
  prices: StripePriceCatalogue,
  stripeSubscription: Stripe.Subscription,
): {
  endsOn: Date;
  plan: PlanName;
  addOns: number;
  monthly: MonthlyAmount | null;
} | null {
  if (!isTrialStatus(stripeSubscription.status)) return null;
  const { trialEndsAt } = trialFactsOf(stripeSubscription);
  const { plan, addOns } = purchasedItems(
    prices,
    (stripeSubscription.items?.data ?? []).map((item) => ({
      priceId: item.price.id,
      quantity: item.quantity,
    })),
  );
  if (!trialEndsAt || !plan) return null;
  return {
    endsOn: trialEndsAt,
    plan,
    addOns,
    monthly: monthlyAmountOf(stripeSubscription),
  };
}

/** A monthly amount, in the currency's smallest unit. */
export interface MonthlyAmount {
  amount: number;
  currency: string;
}

/**
 * What a subscription's items cost per month, as Stripe prices them: each
 * item's unit amount times its quantity, the plan and the Add-ons together —
 * what the trial emails quote for "what is held now". Null when an
 * item carries no unit amount or the items disagree on currency, so an email
 * never quotes a wrong total.
 */
export function monthlyAmountOf(
  stripeSubscription: Pick<Stripe.Subscription, 'items'>,
): MonthlyAmount | null {
  const items = stripeSubscription.items?.data ?? [];
  const currency = items[0]?.price?.currency;
  if (!currency) return null;
  let amount = 0;
  for (const item of items) {
    const unit = item.price?.unit_amount;
    if (typeof unit !== 'number' || item.price.currency !== currency) {
      return null;
    }
    amount += unit * (item.quantity ?? 1);
  }
  return { amount, currency };
}
