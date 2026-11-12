import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { user } from '../../auth/auth.schema';
import { nanoidPk } from '../../db/columns';
import { organization } from '../../organizations/organizations.schema';

// The org-scoped billing table the phase file specifies — one row per
// organization, so a subscription belongs to the tenant rather than to
// whichever user happens to own it, and the Stripe columns live here rather
// than on the owner's user row. Same shape phase 49 gave licences.
//
// A consequence worth naming: one Stripe customer pays for one organization,
// and its Add-ons are that organization's alone, never shared across every
// organization its owner owns — which is why the sync helpers take an
// organizationId and not an owner.

/**
 * The plan a subscription's price ids resolve to (ADR-0054): Starter or
 * Business, `PlanName` in billing.plans.ts. Nullable for a row that exists with
 * no plan — invoice mail asked for before a first checkout, or a subscription
 * that has ended.
 */
export const billingPlanEnum = pgEnum('billing_plan', ['starter', 'business']);

export type BillingPlan = (typeof billingPlanEnum.enumValues)[number];

export const subscription = pgTable(
  'subscription',
  {
    id: nanoidPk('id'),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    /**
     * The Stripe subscription schedule of a downgrade that waits for the end of
     * the paid month (Business → Starter): set by the downgrade, cleared
     * when "Keep Business" releases it, when the move to Starter happens, and
     * by the `subscription_schedule.*` webhooks. While it is set, an Add-on
     * change is written to the schedule's phases rather than the subscription.
     */
    stripeScheduleId: text('stripe_schedule_id'),
    /**
     * When that downgrade takes effect: the end of the paid month, the end of
     * the schedule's first phase. Set and cleared with `stripeScheduleId`.
     */
    downgradeAt: timestamp('downgrade_at', { precision: 3 }),
    /** Resolved from the subscription's price IDs by the webhook. */
    plan: billingPlanEnum('plan'),
    /**
     * Stripe's own subscription status verbatim (`active`, `past_due`,
     * `canceled`, …). Deliberately text rather than an enum: Stripe adds
     * statuses, and nothing here branches on more than `=== 'active'`.
     */
    status: text('status'),
    /**
     * The subscription's Add-on quantity, read off its items by the webhook.
     * The allowance is `3 + addOns` Servers and Cloud Environments while the
     * plan is granted (see billing-allowance.ts); nothing stores the allowance
     * itself, so a lowered count can only refuse new additions.
     */
    addOns: integer('add_ons').notNull().default(0),
    sendInvoiceNotifications: boolean('send_invoice_notifications')
      .notNull()
      .default(false),
    /**
     * The Enterprise marker (CONTEXT.md, ADR-0048): an Organization
     * billed by agreement outside Stripe. Set only by an Operator; no
     * customer route sets it. In hosted mode it is what the paid-feature gates
     * (SSO, SCIM, custom roles, forward auth) ask instead of a license key, and
     * its allowance is the two hand-set counts below rather than the plan's.
     * Every webhook branch skips such an organization, so a
     * stray Stripe event cannot rewrite its billing state.
     */
    enterprise: boolean('enterprise').notNull().default(false),
    /** Servers an Enterprise Organization may hold, set by an Operator. */
    enterpriseServers: integer('enterprise_servers').notNull().default(0),
    /** Cloud Environments an Enterprise Organization may hold, likewise. */
    enterpriseCloudEnvironments: integer('enterprise_cloud_environments')
      .notNull()
      .default(0),
    /**
     * When an Operator first switched the Enterprise marker on. Set
     * once, kept at that first moment, and never cleared — not when Enterprise
     * is switched off, nor by any payment — so it still answers "has this
     * Organization ever been Enterprise" after the marker has gone: no free
     * trial follows an Enterprise agreement (ADR-0054). Read through
     * `hasBeenEnterprise` (enterprise.ts) and `trialUsedOf` (free-trial.ts).
     */
    firstEnterpriseAt: timestamp('first_enterprise_at', { precision: 3 }),
    /**
     * When this Organization's first Stripe subscription began — trialing,
     * active, or anything past that, but not a first payment still
     * `incomplete`. Set once by the webhook, kept at that first moment
     * and never cleared — not by a cancel, a lapse or a deleted customer — so
     * it still answers "has this Organization ever held a subscription, a
     * free trial included" after the subscription has gone: one free trial
     * per Organization ever (ADR-0054). Read through `organizationTrialUsed`
     * (free-trial.ts), with `firstEnterpriseAt`.
     */
    firstSubscribedAt: timestamp('first_subscribed_at', { precision: 3 }),
    /**
     * When this Organization was first made an **Attached Organization**.
     * Set once, when it is made, and never cleared — not when its owner pays
     * for it, nor when its Paying Organization stops paying for it — so a
     * detached Organization still has no free trial: having been attached
     * counts as having held a plan (ADR-0059). Read through `trialUsedOf`
     * (free-trial.ts), beside the two marks above.
     */
    firstAttachedAt: timestamp('first_attached_at', { precision: 3 }),
    /**
     * Stripe's `trial_end` for the subscription the row holds, verbatim: when
     * its free trial ends, or ended. Null for a subscription that
     * never had one. It means "in a trial now" only beside
     * `status === 'trialing'`; read through `trialEndsAtOf` (free-trial.ts).
     */
    trialEndsAt: timestamp('trial_ends_at', { precision: 3 }),
    /**
     * The free trial's three "sent" marks, each claimed with one
     * conditional write so an email goes out once, and never cleared — there
     * is one trial per Organization ever. `trialStartedSentAt`: the "your
     * trial has started" email went out. `trialReminderSentAt`: the daily
     * job's "your trial ends in 7 days" went out; a plan or Add-on change
     * after it sends no second one. `trialChargedAt`: the first real charge
     * after the trial was paid, whose "invoice paid" email (when asked for)
     * carries "your free trial has ended".
     */
    trialStartedSentAt: timestamp('trial_started_sent_at', { precision: 3 }),
    trialReminderSentAt: timestamp('trial_reminder_sent_at', { precision: 3 }),
    trialChargedAt: timestamp('trial_charged_at', { precision: 3 }),
    /**
     * When the subscription the row holds is set to end — a cancel at the end
     * of the paid month or of the trial, made at Stripe — as the webhook last
     * read it (`cancelAtOf`, billing.plans.ts); null while it renews. What the
     * Operator page reads as "Ends on <date>".
     */
    cancelAt: timestamp('cancel_at', { precision: 3 }),
    /**
     * The **lapsed** cause of a Frozen Organization (ADR-0052): when its
     * subscription ended — `customer.subscription.deleted` or a deleted Stripe
     * customer — or an Operator switched Enterprise off. Set once and
     * kept at the first moment; cleared only by a new active subscription (or
     * Enterprise switched on). `past_due` never sets it. Read through
     * `frozen.ts`.
     */
    lapsedAt: timestamp('lapsed_at', { precision: 3 }),
    /**
     * The **suspended** cause (ADR-0050, ADR-0052): set and lifted only by an
     * Operator, never by a payment. `suspendedReason` is shown to the
     * customer; `suspendedBy` is the Operator who set it.
     */
    suspendedAt: timestamp('suspended_at', { precision: 3 }),
    suspendedReason: text('suspended_reason'),
    suspendedBy: text('suspended_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    /**
     * The deletion clock's three marks (ADR-0052), read through
     * `lapse-clock.ts`. `paymentFailedAt` is the first failed payment Stripe is
     * still retrying (the payment-failed email went out then, and the 3-day
     * warning is due 11 days on, 3 before Stripe gives up); `lapseWarnedAt`
     * and `deletionWarnedAt` say the 3-day and 7-day warnings went out. Paying
     * again clears all three; lifting a suspension clears `deletionWarnedAt`,
     * so a lapsed Organization always gets 7 days after a fresh warning.
     */
    paymentFailedAt: timestamp('payment_failed_at', { precision: 3 }),
    lapseWarnedAt: timestamp('lapse_warned_at', { precision: 3 }),
    deletionWarnedAt: timestamp('deletion_warned_at', { precision: 3 }),
    /**
     * The **Bought Server** clock's marks (ADR-0071), read through
     * `bought-server-clock.ts`; the deletion date itself is never stored.
     * `boughtServersPaymentFailedAt` and `boughtServersFailedInvoiceId`: an
     * invoice with Bought Server lines failed then, and paying that invoice
     * clears both. Set on the Paying Organization's row, which an Attached
     * Organization's clock reads. `boughtServersDayBeforeSentAt` and
     * `boughtServersDeletedSentAt`, on each Organization's own row: the
     * day-before reminder went out, and its Bought Servers were deleted;
     * each counts only for the deletion date it was made for.
     * `boughtServersLapseWarnedAt`, on each Organization's own row: the
     * "deleted on <date>" warning 7 days before a known cancel went out; it
     * counts only for that cancel's date (#1398). A suspension reuses
     * `suspendedAt`, and a lapse `lapsedAt`.
     */
    boughtServersPaymentFailedAt: timestamp(
      'bought_servers_payment_failed_at',
      { precision: 3 },
    ),
    boughtServersFailedInvoiceId: text('bought_servers_failed_invoice_id'),
    boughtServersDayBeforeSentAt: timestamp(
      'bought_servers_day_before_sent_at',
      { precision: 3 },
    ),
    boughtServersDeletedSentAt: timestamp('bought_servers_deleted_sent_at', {
      precision: 3,
    }),
    boughtServersLapseWarnedAt: timestamp('bought_servers_lapse_warned_at', {
      precision: 3,
    }),
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { precision: 3 }).$onUpdate(
      () => new Date(),
    ),
  },
  (table) => [
    unique('subscription_organizationId_unique').on(table.organizationId),
  ],
);

/** What a `trial_history` row records: a person's email, or a card. */
export const trialHistoryKindEnum = pgEnum('trial_history_kind', [
  'email',
  'card',
]);

export type TrialHistoryKind = (typeof trialHistoryKindEnum.enumValues)[number];

/**
 * The Instance's free-trial history (ADR-0054): every person (by email)
 * and every card (by Stripe card fingerprint) that has had a free trial
 * on this instance. One trial per person ever, and one per card ever, so it is
 * owned by no Organization and by no user — no foreign key — and outlives
 * both: deleting the account and the Organization does not make the email
 * eligible again.
 *
 * - `email`: `value` is `trialEmailKey` (free-trial.ts), an HMAC-SHA256 of the
 *   lower-cased address under a key derived from `APP_ENCRYPTION_SECRET`.
 *   Never the address itself: nothing here can be read back as an email.
 * - `card`: `value` is Stripe's card fingerprint as Stripe gives it, and
 *   `stripeSubscriptionId` the subscription whose trial it had.
 *
 * Rows are only ever added; nothing — an Operator included — clears them.
 */
export const trialHistory = pgTable(
  'trial_history',
  {
    id: nanoidPk('id'),
    kind: trialHistoryKindEnum('kind').notNull(),
    value: text('value').notNull(),
    /**
     * For a card: the Stripe subscription whose trial recorded it, so the
     * webhook can tell a second delivery of that same Checkout (its own trial,
     * kept) from a later trial on the card (ended at once). Null for an
     * email. A Stripe id, not a foreign key: the row outlives the subscription.
     */
    stripeSubscriptionId: text('stripe_subscription_id'),
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    unique('trial_history_kind_value_unique').on(table.kind, table.value),
  ],
);

export type TrialHistory = typeof trialHistory.$inferSelect;

export const subscriptionRelations = relations(subscription, ({ one }) => ({
  organization: one(organization, {
    fields: [subscription.organizationId],
    references: [organization.id],
  }),
}));

export type Subscription = typeof subscription.$inferSelect;
