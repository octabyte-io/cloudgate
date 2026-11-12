import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { withCheckoutOutcome } from 'api-schemas';
import type Stripe from 'stripe';
import { user } from '../../auth/auth.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { organizationNameOf } from '../../organizations/organization-name';
import { organization } from '../../organizations/organizations.schema';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { cloudEnvironmentsOf } from '../../environments/cloud-environments';
import {
  allowanceOf,
  isPaidStatus,
  minimumAddOns,
  refusalFor,
} from './billing-allowance';
import type {
  Allowance,
  AllowanceSource,
  AllowanceRefusalCode,
  CountedKind,
  Usage,
} from './billing-allowance';
import { BillingConfig } from './billing.config';
import {
  checkoutLineItems,
  HOSTED_PLAN_INCLUDES,
  missingPriceSettings,
  PLAN_LABELS,
} from './billing.plans';
import type { CompleteCatalogue, PlanName } from './billing.plans';
import { subscription } from './billing.schema';
import type { Subscription } from './billing.schema';
import {
  emailHadTrial,
  isTrialStatus,
  organizationTrialUsed,
  trialCheckoutParams,
  trialEmailKey,
  trialEndsAtOf,
} from './free-trial';
import {
  daysLeftOf,
  isFreshProrationDate,
  itemCarrying,
  upgradeItems,
  upgradePreviewParams,
  upgradePreviewView,
} from './plan-upgrade';
import type { UpgradePreviewView } from './plan-upgrade';
import {
  downgradeDateOf,
  downgradeScheduleUpdate,
  scheduledAddOnsUpdate,
  scheduledMoveOf,
} from './plan-downgrade';
import type { ScheduledMove } from './plan-downgrade';
import {
  customerIdOf,
  firstChargePreviewParams,
  isCancelled,
  paymentMethodOf,
  storedTrialView,
  trialSwitchUpdate,
  trialView,
} from './plan-trial';
import type { TrialView } from './plan-trial';
import { LapseNotifications } from './lapse-notifications.service';
import {
  assertNothingAttached,
  assertNotPaidByAnother,
} from './attached-refusals';
import {
  payingOrganizationOf,
  poolOf,
  shareOf,
  totalOf,
  usageByOrganization,
} from './paying-organization';
import type { Pool } from './paying-organization';
import { attachedOrganizationsOf, roomLeftOf } from './attaching';
import type { AttachedOrganizationsView } from './attaching';
import {
  assertDetachedMayBePaidFor,
  assertOwnerMayPayForIt,
  attachedOwnershipOf,
  paidForItselfMetadata,
  payForItYourselfOf,
} from './paying-for-itself';
import type { PayForItYourselfView } from './paying-for-itself';
import { downgradeImpactOf } from './downgrade-impact';
import type { DowngradeImpactView } from './downgrade-impact';
import { STRIPE_API } from './stripe-api';
import type { StripeApi } from './stripe-api';
import { OCTABYTE_CONTACT } from './contact';

/**
 * The metadata marker of the customer-portal configuration Cloudgate made,
 * and its version: a change to its features is a new version, so an older
 * configuration is left for Stripe's dashboard rather than edited.
 */
const PORTAL_CONFIGURATION_KEY = 'cloudgate_portal';
const PORTAL_CONFIGURATION_VERSION = '1';

/** The organization's billing state, as the dashboard reads it. */
export interface BillingStateView {
  /** The plan the subscription's prices resolve to, as the webhook stored it. */
  plan: PlanName | null;
  /** Stripe's own status verbatim. */
  status: string | null;
  /** The Add-on quantity the subscription bills. */
  addOns: number;
  /** What the Organization may hold now: 0/0 unless the plan is granted. */
  allowance: Allowance;
  /** What it holds. */
  usage: Usage;
  /** The fewest Add-ons that cover `usage`; checkout never buys fewer. */
  minimumAddOns: number;
  sendInvoiceNotifications: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /**
   * Whether a Checkout started now, by the person reading this, would start
   * a 30-day free trial (ADR-0054): the Organization has never held a
   * subscription or been Enterprise, and this person has never had a trial.
   * The picker says "Start 30-day free trial" when true and "Subscribe" when
   * not. False while a plan is held, and off the Hosted instance.
   */
  trialAvailable: boolean;
  /**
   * When the free trial ends, ISO 8601, while the subscription is in one
   * (`status === 'trialing'`); null otherwise.
   */
  trialEndsAt: string | null;
  /**
   * The plan a waiting downgrade moves to, Starter, or null when
   * none waits; `scheduledAt` is when it takes effect, the end of the paid
   * month.
   */
  scheduledPlan: PlanName | null;
  scheduledAt: Date | null;
  /**
   * Where the free trial stands while in one — its end, whether it
   * was cancelled, the first charge and the card it goes to, read live from
   * Stripe — and null outside a trial.
   */
  trial: TrialView | null;
  /**
   * The Paying Organization of an **Attached Organization** (ADR-0059), null
   * for one that pays for itself: its name, what its plan allows the whole
   * pool, and the room left on that plan for one more. `usage` is then this
   * Organization's own, and nothing here says what the other Organizations on
   * the plan hold: they are other customers.
   */
  paidBy: PaidByView | null;
  /**
   * The shared meters of a **Paying Organization** with any Organization
   * attached (ADR-0059): the whole pool's use, which the allowance is
   * measured against, and how many Organizations that is, itself included.
   * `usage` stays this Organization's own share, so own against the others'
   * is `usage` against `pool.usage`. Null with nothing attached, where the
   * pool is the Organization alone, and for an Attached Organization, which
   * is told nothing about the other Organizations on the plan.
   */
  pool: PoolUsageView | null;
}

/** {@link BillingStateView.pool}. */
export interface PoolUsageView {
  usage: Usage;
  organizations: number;
}

/** {@link BillingStateView.paidBy}. */
export interface PaidByView {
  name: string;
  allowance: Allowance;
  roomLeft: Usage;
  /**
   * "Pay for it yourself", for the Attached Organization's own owner:
   * whether it is offered, and why not. Null for anyone else.
   */
  payForItYourself: PayForItYourselfView | null;
}

/**
 * `GET /billing/attached-plan`, which **any member** may read (stories 23–25,
 * 29): an Attached Organization's Billing page as its people see it — who
 * pays, the room left on that plan, and this Organization's own use. Both
 * fields are null for an Organization that pays for itself, whose Billing
 * page stays an owner's or admin's (`getSubscription`).
 *
 * Narrower than {@link PaidByView} on purpose: no `allowance`, because the
 * plan's size beside the room left and this Organization's own use would let
 * a member work out what the other Organizations on the plan hold, and those
 * are other customers. Nothing about Stripe, invoices or other Organizations.
 */
export interface AttachedPlanView {
  paidBy: Omit<PaidByView, 'allowance'> | null;
  usage: Usage | null;
}

/** What a downgrade did: scheduled for the month's end, or, in a trial, done. */
export type DowngradeResult = ScheduledMove | { plan: 'starter' };

/**
 * `GET /billing/plan`, which any member may read: the plan held now, and when
 * a waiting downgrade moves it to Starter, so every paid-feature page
 * can say so while it waits.
 */
export interface CurrentPlanView {
  plan: AllowanceSource | null;
  scheduledAt: Date | null;
}

/** One of the three prices, as Stripe has it. */
export interface PriceView {
  id: string;
  /** The price's product name at Stripe, when it has one. */
  name: string | null;
  /** Minor units (cents). `null` for a tiered price. */
  unitAmount: number | null;
  currency: string;
  interval: string | null;
}

/**
 * What `getCatalogue` answers with: both plans, the Add-on they share, and the
 * base count, which is the same for both.
 */
export interface CatalogueView {
  /** Servers and Cloud Environments either plan includes before any Add-on. */
  includes: number;
  plans: Record<PlanName, PriceView>;
  addOn: PriceView;
}

/** Whether one more Server fits, and if not, why. */
export interface ServerRoomView {
  canCreateMoreServers: boolean;
  code: AllowanceRefusalCode | null;
  message: string | null;
}

/** One invoice as `getInvoices` projects it. */
export interface InvoiceView {
  id: string | null;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  dueDate: number | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

/** `setAddOns`' input. */
export interface AddOnsInput {
  addOns: number;
}

/**
 * `createCheckoutSession`'s input: the plan chosen and its Add-ons, and
 * optionally the console path Checkout returns to (`returnToSchema`; the
 * get-started wizard's, ADR-0073).
 */
export interface CheckoutInput extends AddOnsInput {
  plan: PlanName;
  returnTo?: string;
}

/**
 * What a **Bought Server** bought with no plan adds to the Checkout that
 * starts the plan (ADR-0071): the purchase's id in the session's metadata,
 * 3D Secure asked for when it is the Organization's first, and Servers as
 * the page Stripe sends the customer back to.
 */
export interface CheckoutPurchase {
  boughtServerId: string;
  threeDSecure: boolean;
  /**
   * The Server's own line prices, charged in the same Checkout as the plan
   * when it starts with no Free trial. A trial would cover them too (Stripe
   * trials cover the whole subscription), so with one they are left out and
   * the Server is charged on its own invoice once Checkout completes.
   */
  linePriceIds?: readonly string[];
}

/** `upgrade`'s input: the proration time the confirm's preview was made at. */
export interface UpgradeInput {
  prorationDate: number;
}

/** What `upgradeTarget` finds: the subscription to switch and its plan item. */
interface UpgradeTarget {
  subscriptionId: string;
  current: Stripe.Subscription;
  planItem: Stripe.SubscriptionItem;
  businessPriceId: string;
  /** In its free trial: the switch is a free swap, not a charge. */
  trialing: boolean;
}

/**
 * Hosted billing over Stripe — the two plans and their Add-ons, checkout, the
 * customer portal, invoices, and the allowance check every counted addition
 * goes through — kept on the org-scoped `subscription` table (see
 * billing.schema.ts for why).
 *
 * Gating, the standing rule since phase 48: owner/admin is the caller's role in
 * the organization, read off their member row — not `user.role`, the admin
 * plugin's *global* user role, which on this instance is always 'user', so an
 * owner/admin check against it would reject everyone.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly permissions: PermissionService,
    private readonly config: BillingConfig,
    private readonly instanceMode: InstanceMode,
    private readonly notifications: LapseNotifications,
  ) {}

  /**
   * The organization's billing state as the dashboard needs it, read off the
   * stored row (the webhook syncs plan, status and Add-ons onto it) and the
   * organization's own counts.
   */
  async getSubscription(ctx: PermissionCtx): Promise<BillingStateView> {
    await this.assertAdmin(ctx, 'read billing');
    const organizationId = ctx.session.activeOrganizationId;
    const [row, pool] = await Promise.all([
      this.findRow(organizationId),
      this.poolFor(organizationId),
    ]);
    const usage = shareOf(pool, organizationId);
    const allowance = allowanceOf(row);
    const shared = this.sharedMetersOf(pool);
    return {
      plan: row?.plan ?? null,
      status: row?.status ?? null,
      addOns: row?.addOns ?? 0,
      allowance,
      usage,
      // Checkout floors the Add-ons at the pool's use, so the catalogue does.
      minimumAddOns: minimumAddOns(shared?.usage ?? usage),
      sendInvoiceNotifications: row?.sendInvoiceNotifications ?? false,
      stripeCustomerId: row?.stripeCustomerId ?? null,
      stripeSubscriptionId: row?.stripeSubscriptionId ?? null,
      trialAvailable:
        this.instanceMode.isHosted &&
        allowance.plan === null &&
        (await this.trialEmailKeyFor(ctx)) !== null,
      trialEndsAt: trialEndsAtOf(row)?.toISOString() ?? null,
      scheduledPlan: scheduledMoveOf(row)?.scheduledPlan ?? null,
      scheduledAt: scheduledMoveOf(row)?.scheduledAt ?? null,
      trial: await this.trialOf(row),
      paidBy: await this.paidByOf(pool, ctx.user.id),
      pool: shared,
    };
  }

  /**
   * {@link BillingStateView.pool}: the pool's use and its Organizations, for
   * a Paying Organization with any attached; null otherwise.
   */
  private sharedMetersOf(pool: Pool): PoolUsageView | null {
    if (pool.paying.attached || pool.shares.length < 2) return null;
    return { usage: pool.usage, organizations: pool.shares.length };
  }

  /**
   * An Attached Organization's Billing page as any of its members reads it
   * (see {@link AttachedPlanView}): who pays, the room left on that plan,
   * and its own use; both null for an Organization that pays for itself.
   * Any member of the active Organization; the membership is asked first.
   */
  async attachedPlan(ctx: PermissionCtx): Promise<AttachedPlanView> {
    await this.permissions.findMember(ctx);
    const organizationId = ctx.session.activeOrganizationId;
    const pool = await this.poolFor(organizationId);
    const paidBy = await this.paidByOf(pool, ctx.user.id);
    if (!paidBy) return { paidBy: null, usage: null };
    return {
      paidBy: {
        name: paidBy.name,
        roomLeft: paidBy.roomLeft,
        payForItYourself: paidBy.payForItYourself,
      },
      usage: shareOf(pool, organizationId),
    };
  }

  /**
   * {@link BillingStateView.paidBy}: the Paying Organization's name and what
   * its plan leaves the pool, for an Attached Organization; null otherwise.
   */
  private async paidByOf(
    pool: Pool,
    readerId: string,
  ): Promise<PaidByView | null> {
    if (!pool.paying.attached) return null;
    return {
      name: await organizationNameOf(this.db, pool.paying.payingOrganizationId),
      allowance: pool.allowance,
      roomLeft: roomLeftOf(pool.allowance, pool.usage),
      payForItYourself: await payForItYourselfOf(
        this.db,
        pool.paying.organizationId,
        readerId,
        await this.permissions.instanceOrganizationId(),
      ),
    };
  }

  /**
   * The "Organizations on this plan" card (ADR-0059): whether "Add an
   * Organization to this plan" is offered and why not, how much of the pool
   * is free, and each Organization this one pays for. Owner or admin, like
   * the rest of the Billing page; Hosted only.
   */
  async attachedOrganizations(
    ctx: PermissionCtx,
  ): Promise<AttachedOrganizationsView> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'read billing');
    return attachedOrganizationsOf(
      this.db,
      ctx.session.activeOrganizationId,
      ctx.user.id,
    );
  }

  /**
   * Where the Organization's free trial stands, null outside one.
   * Read live from Stripe, which holds the cancel, the first charge and the
   * card; a Stripe failure answers the stored end date alone rather than
   * failing the page, and never claims the card is missing.
   */
  private async trialOf(row: Subscription | null): Promise<TrialView | null> {
    const endsAt = trialEndsAtOf(row);
    if (!endsAt || !row?.stripeSubscriptionId) return null;
    try {
      const current = await this.stripe.retrieveSubscription(
        row.stripeSubscriptionId,
      );
      return await this.liveTrialView(endsAt, current);
    } catch {
      return storedTrialView(endsAt);
    }
  }

  /**
   * A trial's view from its subscription as Stripe has it, asking Stripe for
   * the customer's card when the subscription names none, and for the first
   * charge unless the trial was cancelled.
   */
  private async liveTrialView(
    endsAt: Date,
    current: Stripe.Subscription,
  ): Promise<TrialView> {
    const [customer, upcoming] = await Promise.all([
      current.default_payment_method
        ? null
        : this.stripe.retrieveCustomer(customerIdOf(current)),
      isCancelled(current)
        ? null
        : this.stripe
            .previewInvoice(firstChargePreviewParams(current))
            .catch(() => null),
    ]);
    return trialView(
      endsAt,
      current,
      paymentMethodOf(current, customer),
      upcoming ?? null,
    );
  }

  /**
   * What the organization may hold, and what it holds, as a pool: its Paying
   * Organization's plan, Add-ons or Enterprise counts, against the usage of
   * the Paying Organization and every Organization attached to it (ADR-0059).
   * For an Organization with nothing attached, its own allowance and usage.
   */
  async allowanceFor(
    organizationId: string,
  ): Promise<{ allowance: Allowance; usage: Usage }> {
    const { allowance, usage } = await this.poolFor(organizationId);
    return { allowance, usage };
  }

  /**
   * The pool the organization is on, with each Organization's share
   * (`paying-organization.ts`): what the Billing meters and the Operator's
   * counts read.
   */
  poolFor(organizationId: string): Promise<Pool> {
    return poolOf(this.db, organizationId);
  }

  /**
   * What these Organizations hold together: their Server rows, and their
   * Cloud Environments as `cloudEnvironmentsOf` counts them.
   */
  async usageOf(organizationIds: readonly string[]): Promise<Usage> {
    return totalOf(await usageByOrganization(this.db, organizationIds));
  }

  /**
   * The one allowance check (ADR-0048): refuses one more `kind` with 403
   * `PLAN_REQUIRED` ("Choose a plan…") when the organization has no plan, or
   * `ALLOWANCE_FULL` pointing at the Add-on when its count is full. A no-op on
   * a Self-hosted instance, where nothing is metered.
   *
   * Called by the code that adds one, so the rule holds however it is added.
   * It refuses only the addition; nothing already held is touched.
   */
  async assertRoomFor(
    organizationId: string,
    kind: CountedKind,
  ): Promise<void> {
    if (!this.instanceMode.isHosted) return;
    const { allowance, usage } = await this.allowanceFor(organizationId);
    const refusal = refusalFor(kind, allowance, usage);
    if (refusal) throw new ForbiddenException(refusal);
  }

  /**
   * Refusal point one for Cloud Environments: giving an Environment a
   * cloud Deploy target — a new one (`environmentId` null), or a retarget.
   * Goes through {@link assertRoomFor} only when the Environment does not
   * count yet; one that already counts (another Cloud account or region, or
   * a cloud Service still in it) is never refused. Hosted only.
   */
  async assertRoomForCloudTarget(
    organizationId: string,
    environmentId: string | null,
  ): Promise<void> {
    if (!this.instanceMode.isHosted) return;
    if (environmentId !== null) {
      const counted = await cloudEnvironmentsOf(this.db, [organizationId]);
      if (counted.some((one) => one.environmentId === environmentId)) return;
    }
    await this.assertRoomFor(organizationId, 'cloudEnvironments');
  }

  /**
   * Refusal point two: a Project config Apply that would put a cloud
   * Service into an Environment that holds none yet. Its cloud Deploy target
   * already counts it, so this is about Environments from before the count
   * (or beyond a count lowered by hand): the Apply is refused while the
   * Environments that already hold cloud Services fill the count, so no more
   * of them become real than the allowance pays for. Inside the count, and
   * for an Environment that already holds one, it never refuses. Hosted only.
   *
   * The Environments counted are the whole pool's, every Organization on the
   * same Paying Organization (ADR-0059).
   */
  async assertRoomForCloudServices(
    organizationId: string,
    environmentId: string,
  ): Promise<void> {
    if (!this.instanceMode.isHosted) return;
    const { allowance, usage, shares } = await this.poolFor(organizationId);
    const counted = await cloudEnvironmentsOf(
      this.db,
      shares.map((share) => share.organizationId),
    );
    const holding = counted.filter((one) => one.holdsCloudService);
    if (holding.some((one) => one.environmentId === environmentId)) return;
    const refusal = refusalFor('cloudEnvironments', allowance, {
      ...usage,
      cloudEnvironments: holding.length,
    });
    if (refusal) throw new ForbiddenException(refusal);
  }

  /**
   * Whether one more Server fits, with the refusal's code and sentence when
   * not, so the console can say "choose a plan" before the form is filled in.
   * Always room on a Self-hosted instance.
   */
  async serverRoom(ctx: PermissionCtx): Promise<ServerRoomView> {
    if (!this.instanceMode.isHosted) {
      return { canCreateMoreServers: true, code: null, message: null };
    }
    const { allowance, usage } = await this.allowanceFor(
      ctx.session.activeOrganizationId,
    );
    const refusal = refusalFor('servers', allowance, usage);
    return {
      canCreateMoreServers: refusal === null,
      code: refusal?.code ?? null,
      message: refusal?.message ?? null,
    };
  }

  /**
   * The plan the organization holds now, for plan-gated reads. Null on a
   * Self-hosted instance, and whenever the subscription no longer grants it.
   * Its Paying Organization's, as the paid features are (ADR-0059).
   */
  async getCurrentPlan(organizationId: string): Promise<CurrentPlanView> {
    if (!this.instanceMode.isHosted) return { plan: null, scheduledAt: null };
    const row = (await payingOrganizationOf(this.db, organizationId))
      .subscription;
    return {
      plan: allowanceOf(row).plan,
      scheduledAt: scheduledMoveOf(row)?.scheduledAt ?? null,
    };
  }

  /**
   * Both plans and the Add-on as Stripe prices them. Refuses off the Hosted
   * instance (no Stripe key there) and when any of the three prices is unset.
   */
  async getCatalogue(ctx: PermissionCtx): Promise<CatalogueView> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'read billing');
    const prices = this.completeCatalogue();
    const [starter, business, addOn] = await Promise.all([
      this.stripe.retrievePrice(prices.starterPriceId),
      this.stripe.retrievePrice(prices.businessPriceId),
      this.stripe.retrievePrice(prices.addOnPriceId),
    ]);
    return {
      includes: HOSTED_PLAN_INCLUDES,
      plans: { starter: priceView(starter), business: priceView(business) },
      addOn: priceView(addOn),
    };
  }

  /**
   * A Stripe customer-portal session for the organization's customer, under
   * Cloudgate's portal configuration (cancel at the end of the paid month). A
   * Stripe failure answers with an empty URL rather than raising, which the
   * dashboard reads as "portal unavailable".
   */
  async createCustomerPortalSession(
    ctx: PermissionCtx,
  ): Promise<{ url: string }> {
    await this.assertAdmin(ctx, 'manage billing');
    const row = await this.findRow(ctx.session.activeOrganizationId);

    if (!row?.stripeCustomerId) {
      throw new BadRequestException('Stripe Customer ID not found');
    }

    try {
      const session = await this.stripe.createBillingPortalSession({
        customer: row.stripeCustomerId,
        return_url: this.billingPageUrl(),
        configuration: await this.portalConfigurationId(),
      });
      return { url: session.url };
    } catch {
      this.portalConfiguration = undefined;
      return { url: '' };
    }
  }

  /** Memoised per process; forgotten when a portal session fails. */
  private portalConfiguration?: Promise<string>;

  /**
   * The customer portal's configuration, which Cloudgate owns rather than
   * leaving to the Stripe dashboard: **a cancel takes effect at the end of the
   * paid month** (ADR-0052), so `customer.subscription.deleted` — the lapse —
   * arrives only then. Add-ons are changed in the console (`setAddOns`, which
   * keeps the floor), so the portal offers no plan or quantity change. Found
   * by its metadata marker among the account's active configurations, and
   * made once when there is none.
   */
  private portalConfigurationId(): Promise<string> {
    this.portalConfiguration ??= (async () => {
      const existing = await this.stripe.listBillingPortalConfigurations();
      const ours = existing.find(
        (configuration) =>
          configuration.metadata?.[PORTAL_CONFIGURATION_KEY] ===
          PORTAL_CONFIGURATION_VERSION,
      );
      if (ours) return ours.id;
      const created = await this.stripe.createBillingPortalConfiguration({
        metadata: { [PORTAL_CONFIGURATION_KEY]: PORTAL_CONFIGURATION_VERSION },
        features: {
          customer_update: {
            enabled: true,
            allowed_updates: ['email', 'address', 'tax_id', 'name'],
          },
          invoice_history: { enabled: true },
          payment_method_update: { enabled: true },
          subscription_cancel: {
            enabled: true,
            mode: 'at_period_end',
            proration_behavior: 'none',
          },
          subscription_update: { enabled: false },
        },
      });
      return created.id;
    })();
    return this.portalConfiguration;
  }

  /**
   * Sets the Add-on quantity on the organization's subscription, never below
   * what it already uses beyond the plan's base 3. Only the Add-on item
   * changes; Stripe prorates. Answers with the quantity set.
   *
   * Active or in its free trial (ADR-0054): during a trial every item
   * costs nothing until it ends, so Stripe's proration of the change is 0 and
   * the first bill is for what is held on day 30.
   */
  async setAddOns(
    ctx: PermissionCtx,
    input: AddOnsInput,
  ): Promise<{ addOns: number }> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'manage billing');
    const organizationId = ctx.session.activeOrganizationId;
    await assertNotPaidByAnother(this.db, organizationId, 'billing');
    const prices = this.completeCatalogue();
    const row = await this.findRow(organizationId);
    const { subscriptionId, current } = await this.paidSubscriptionOf(row);

    // The pool's usage: the Add-ons raise it for every Organization on it.
    const addOns = Math.max(
      input.addOns,
      minimumAddOns((await this.allowanceFor(organizationId)).usage),
    );
    const item = current.items.data.find(
      (candidate) => candidate.price.id === prices.addOnPriceId,
    );
    const items: Stripe.SubscriptionUpdateParams.Item[] = item
      ? [
          addOns > 0
            ? { id: item.id, quantity: addOns }
            : { id: item.id, deleted: true },
        ]
      : addOns > 0
        ? [{ price: prices.addOnPriceId, quantity: addOns }]
        : [];

    if (items.length > 0 && (item?.quantity ?? 0) !== addOns) {
      // While a downgrade waits, the count goes to this month and to
      // the Starter phase alike, through the schedule, so it carries across.
      if (row?.stripeScheduleId) {
        await this.setScheduledAddOns(row.stripeScheduleId, prices, addOns);
      } else {
        await this.stripe.updateSubscription(subscriptionId, {
          items,
          proration_behavior: 'create_prorations',
        });
      }
    }

    return { addOns };
  }

  // ---------------------------------------------------------------------------
  // Starter → Business, at once and charged today (ADR-0054). See
  // plan-upgrade.ts. The downgrade, at the end of the month, is its own path.
  // ---------------------------------------------------------------------------

  /**
   * What upgrading to Business charges today, prorated over the days left of
   * the paid month, and what every month costs after — both from Stripe's
   * invoice preview of exactly the change `upgrade` makes, at `now`.
   */
  async previewUpgrade(
    ctx: PermissionCtx,
    now: Date = new Date(),
  ): Promise<UpgradePreviewView> {
    const target = await this.upgradeTarget(ctx);
    const prorationDate = Math.floor(now.getTime() / 1000);
    const params = upgradePreviewParams(
      target.current,
      target.planItem,
      target.businessPriceId,
      prorationDate,
    );
    if (target.trialing) {
      // Nothing is charged until the trial ends; then the Business month.
      const next = await this.stripe.previewInvoice(params.next);
      return trialUpgradePreview(target.current, next, prorationDate);
    }
    const [today, next] = await Promise.all([
      this.stripe.previewInvoice(params.today),
      this.stripe.previewInvoice(params.next),
    ]);
    return upgradePreviewView(today, next, target.planItem, prorationDate);
  }

  /**
   * Swaps the Starter price on the plan item for Business, prorated as of the
   * preview's `prorationDate` and invoiced now, so the amount charged is the
   * amount the confirm showed. `pending_if_incomplete`: Stripe applies the
   * swap only once that invoice is paid, so a refused card leaves the
   * Organization on Starter rather than on an unpaid Business.
   *
   * Once paid, the plan is written onto the row straight away, so the
   * paid-feature check passes before `customer.subscription.updated` reaches
   * the webhook, which then stores the same.
   */
  async upgrade(
    ctx: PermissionCtx,
    input: UpgradeInput,
    now: Date = new Date(),
  ): Promise<{ plan: PlanName }> {
    const target = await this.upgradeTarget(ctx);
    if (target.trialing) {
      // During a trial: at once and free, the trial keeping its end.
      const updated = await this.stripe.updateSubscription(
        target.subscriptionId,
        trialSwitchUpdate(target.planItem, target.businessPriceId),
      );
      await this.storePlan(ctx.session.activeOrganizationId, {
        plan: 'business',
        status: updated.status,
      });
      return { plan: 'business' };
    }
    if (!isFreshProrationDate(input.prorationDate, now.getTime() / 1000)) {
      throw new ConflictException({
        message:
          'The amount shown is out of date. Look at the new amount, then upgrade again',
        code: 'UPGRADE_PREVIEW_STALE',
      });
    }

    let updated: Stripe.Subscription;
    try {
      updated = await this.stripe.updateSubscription(target.subscriptionId, {
        items: upgradeItems(target.planItem, target.businessPriceId),
        proration_behavior: 'always_invoice',
        proration_date: input.prorationDate,
        payment_behavior: 'pending_if_incomplete',
      });
    } catch (error) {
      if (isCardError(error)) throw upgradePaymentFailed();
      throw error;
    }
    if (updated.pending_update) throw upgradePaymentFailed();

    await this.storePlan(ctx.session.activeOrganizationId, {
      plan: 'business',
      status: updated.status,
    });
    return { plan: 'business' };
  }

  /** Writes a switched plan onto the row, ahead of the webhook's sync. */
  private async storePlan(
    organizationId: string,
    values: { plan: PlanName; status: string },
  ): Promise<void> {
    await this.db
      .update(subscription)
      .set(values)
      .where(eq(subscription.organizationId, organizationId));
  }

  /**
   * The subscription an upgrade switches, refused unless the Organization is
   * on an active or trialing Starter subscription at Stripe: none (400),
   * Enterprise or Business already (409), or neither active nor in its trial
   * (400). Owner/admin, Hosted only.
   */
  private async upgradeTarget(ctx: PermissionCtx): Promise<UpgradeTarget> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'manage billing');
    await assertNotPaidByAnother(
      this.db,
      ctx.session.activeOrganizationId,
      'billing',
    );
    const prices = this.completeCatalogue();
    const row = await this.findRow(ctx.session.activeOrganizationId);

    if (row?.enterprise) {
      throw new ConflictException({
        message:
          'This Organization is Enterprise, billed by agreement, and already has everything Business adds',
        code: 'PLAN_ALREADY_HELD',
      });
    }
    // A trial switches plans without a charge; outside one, only an
    // active subscription is charged for the rest of its month.
    const { subscriptionId, current } = await this.paidSubscriptionOf(
      row,
      (held) => {
        if (itemCarrying(held, prices.businessPriceId)) {
          throw new ConflictException({
            message: 'This Organization already has the Business plan',
            code: 'PLAN_ALREADY_HELD',
          });
        }
      },
    );
    const planItem = itemCarrying(current, prices.starterPriceId);
    if (!planItem) {
      throw new ConflictException({
        message: `This subscription carries no Starter plan to upgrade. Contact us at ${OCTABYTE_CONTACT} to change it`,
        code: 'UPGRADE_NOT_AVAILABLE',
      });
    }
    return {
      subscriptionId,
      current,
      planItem,
      businessPriceId: prices.businessPriceId,
      trialing: isTrialStatus(current.status),
    };
  }

  // ---------------------------------------------------------------------------
  // Business → Starter at the end of the paid month, and "Keep Business"
  // (ADR-0054). See plan-downgrade.ts.
  // ---------------------------------------------------------------------------

  /**
   * Schedules the move to Starter for the end of the paid month: a
   * subscription schedule made from the subscription, its phases rewritten to
   * this month as it is and then Starter with the same Add-ons. Nothing is
   * charged, and the Organization keeps Business — and the paid features — to
   * the end of the month. The schedule id and the date are stored, so the
   * Billing page shows the wait and an Add-on change goes to both phases.
   *
   * During a free trial there is no paid month to keep: the move is a direct
   * swap at once, free, the trial keeping its end, and never a schedule
   * — see `downgradeDuringTrial`.
   *
   * Either move is refused with 409 `ORGANIZATIONS_ATTACHED`, naming each
   * one, while any Organization is attached (ADR-0059): Starter never pays
   * for others.
   */
  async downgrade(ctx: PermissionCtx): Promise<DowngradeResult> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'manage billing');
    const prices = this.completeCatalogue();
    const organizationId = ctx.session.activeOrganizationId;
    await assertNotPaidByAnother(this.db, organizationId, 'billing');
    const row = await this.findRow(organizationId);

    if (row?.enterprise) {
      throw new ConflictException({
        message: `This Organization is Enterprise, billed by agreement. Contact us at ${OCTABYTE_CONTACT} to change its plan`,
        code: 'DOWNGRADE_NOT_AVAILABLE',
      });
    }
    if (row?.stripeSubscriptionId && row.stripeScheduleId) {
      throw new ConflictException({
        message:
          'This Organization already moves to Starter at the end of the month. Choose Keep Business to stay',
        code: 'DOWNGRADE_ALREADY_WAITING',
      });
    }
    // Starter never pays for others (ADR-0059): both the trial switch and the
    // scheduled move wait until nothing is attached. Before Stripe is asked
    // anything, so a refused move changes nothing there.
    await assertNothingAttached(this.db, organizationId, 'starter');

    // During a free trial the move is an immediate swap, with no paid month
    // to keep; outside one, only an active subscription waits for its
    // month's end.
    const { subscriptionId, current } = await this.paidSubscriptionOf(
      row,
      (held) => {
        if (!itemCarrying(held, prices.businessPriceId)) {
          throw new ConflictException({
            message: 'This Organization is not on the Business plan',
            code: 'DOWNGRADE_NOT_AVAILABLE',
          });
        }
      },
    );
    if (current.schedule) {
      throw new ConflictException({
        message: `This subscription already has a change scheduled at Stripe. Contact us at ${OCTABYTE_CONTACT} to change it`,
        code: 'DOWNGRADE_NOT_AVAILABLE',
      });
    }
    if (isTrialStatus(current.status)) {
      return this.downgradeDuringTrial(organizationId, current, prices);
    }

    const addOnItem = itemCarrying(current, prices.addOnPriceId);
    const created = await this.stripe.createSubscriptionSchedule({
      from_subscription: subscriptionId,
    });
    await this.stripe.updateSubscriptionSchedule(
      created.id,
      downgradeScheduleUpdate(created, prices, addOnItem?.quantity ?? 0),
    );

    const scheduledAt = downgradeDateOf(created);
    await this.db
      .update(subscription)
      .set({ stripeScheduleId: created.id, downgradeAt: scheduledAt })
      .where(eq(subscription.organizationId, organizationId));
    return { scheduledPlan: 'starter', scheduledAt };
  }

  /**
   * Business → Starter during a free trial: the plan item's price
   * swapped at once, nothing prorated or charged, the trial keeping its end.
   * Starter is written onto the row straight away, so the paid features stop
   * now; the custom-role email goes from here, since the webhook's
   * sync then finds Starter already stored. The conditional write sends it
   * once, whichever of the two stores Starter first.
   */
  private async downgradeDuringTrial(
    organizationId: string,
    current: Stripe.Subscription,
    prices: CompleteCatalogue,
  ): Promise<{ plan: 'starter' }> {
    const planItem = itemCarrying(current, prices.businessPriceId);
    if (!planItem) {
      throw new ConflictException({
        message: 'This Organization is not on the Business plan',
        code: 'DOWNGRADE_NOT_AVAILABLE',
      });
    }
    const updated = await this.stripe.updateSubscription(
      current.id,
      trialSwitchUpdate(planItem, prices.starterPriceId),
    );
    const stored = await this.db
      .update(subscription)
      .set({ plan: 'starter', status: updated.status })
      .where(
        and(
          eq(subscription.organizationId, organizationId),
          eq(subscription.plan, 'business'),
        ),
      )
      .returning({ organizationId: subscription.organizationId });
    if (stored.length > 0) {
      await this.notifications.sendCustomRolesStopped(
        organizationId,
        'starter',
      );
    }
    return { plan: 'starter' };
  }

  // ---------------------------------------------------------------------------
  // "Cancel trial" and "Keep <plan>" (ADR-0054). See plan-trial.ts.
  // ---------------------------------------------------------------------------

  /**
   * "Cancel trial": the subscription is set to end with its trial, so nothing
   * is ever charged and the plan ends on the trial's last day. Until then the
   * plan is held as before, and "Keep <plan>" takes the cancel back. Refused
   * outside a trial (409 `NOT_IN_TRIAL`); a paid plan is cancelled at Stripe.
   */
  cancelTrial(ctx: PermissionCtx): Promise<TrialView> {
    return this.setTrialCancelled(ctx, true);
  }

  /** "Keep <plan>": takes a cancelled trial's cancel back. */
  keepTrial(ctx: PermissionCtx): Promise<TrialView> {
    return this.setTrialCancelled(ctx, false);
  }

  private async setTrialCancelled(
    ctx: PermissionCtx,
    cancelled: boolean,
  ): Promise<TrialView> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'manage billing');
    await assertNotPaidByAnother(
      this.db,
      ctx.session.activeOrganizationId,
      'billing',
    );
    const row = await this.findRow(ctx.session.activeOrganizationId);
    const endsAt = trialEndsAtOf(row);
    if (row?.enterprise || !row?.stripeSubscriptionId || !endsAt) {
      throw notInTrial();
    }
    const current = await this.stripe.retrieveSubscription(
      row.stripeSubscriptionId,
    );
    if (!isTrialStatus(current.status)) throw notInTrial();

    const updated = await this.stripe.updateSubscription(current.id, {
      cancel_at_period_end: cancelled,
    });
    return this.liveTrialView(endsAt, updated).catch(() => ({
      ...storedTrialView(endsAt),
      cancelled,
    }));
  }

  /**
   * What moving to Starter stops, against what this Organization uses: the
   * facts the downgrade confirm lists, and the day it would move.
   * Owner or admin, as the move.
   */
  async getDowngradeImpact(
    ctx: PermissionCtx,
  ): Promise<DowngradeImpactView & { downgradeAt: Date | null }> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'read billing');
    const organizationId = ctx.session.activeOrganizationId;
    const row = await this.findRow(organizationId);
    const [impact, downgradeAt] = await Promise.all([
      downgradeImpactOf(this.db, organizationId),
      this.paidMonthEndOf(row),
    ]);
    return { ...impact, downgradeAt };
  }

  /**
   * When the month paid for ends, which is when a downgrade asked for now
   * would move: the plan item's period end, at Stripe. Null with no
   * subscription.
   */
  private async paidMonthEndOf(row: Subscription | null): Promise<Date | null> {
    if (!row?.stripeSubscriptionId) return null;
    const current = await this.stripe.retrieveSubscription(
      row.stripeSubscriptionId,
    );
    const [first] = current.items.data;
    return first ? new Date(first.current_period_end * 1000) : null;
  }

  /**
   * "Keep Business": releases the waiting downgrade's schedule, which leaves
   * the subscription on Business as it is, with nothing charged, and forgets
   * the schedule. Refused when no downgrade waits.
   */
  async keepBusiness(ctx: PermissionCtx): Promise<{ plan: PlanName }> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'manage billing');
    const organizationId = ctx.session.activeOrganizationId;
    await assertNotPaidByAnother(this.db, organizationId, 'billing');
    const row = await this.findRow(organizationId);

    if (!row?.stripeScheduleId) {
      throw new ConflictException({
        message: 'No move to Starter is waiting',
        code: 'NO_DOWNGRADE_WAITING',
      });
    }
    await this.stripe.releaseSubscriptionSchedule(row.stripeScheduleId);
    await this.db
      .update(subscription)
      .set({ stripeScheduleId: null, downgradeAt: null })
      .where(eq(subscription.organizationId, organizationId));
    return { plan: 'business' };
  }

  /**
   * An Add-on count, written to every phase of the waiting downgrade's
   * schedule still to run, rather than to the subscription.
   */
  private async setScheduledAddOns(
    scheduleId: string,
    prices: CompleteCatalogue,
    addOns: number,
  ): Promise<void> {
    const schedule = await this.stripe.retrieveSubscriptionSchedule(scheduleId);
    await this.stripe.updateSubscriptionSchedule(
      scheduleId,
      scheduledAddOnsUpdate(
        schedule,
        prices.addOnPriceId,
        addOns,
        Math.floor(Date.now() / 1000),
      ),
    );
  }

  /**
   * The customer's invoices, projected to the fields the dashboard shows. A
   * Stripe failure answers with an empty list.
   */
  async getInvoices(ctx: PermissionCtx): Promise<InvoiceView[]> {
    await this.assertAdmin(ctx, 'read billing');
    const row = await this.findRow(ctx.session.activeOrganizationId);

    if (!row?.stripeCustomerId) return [];

    try {
      const invoices = await this.stripe.listInvoices(row.stripeCustomerId);
      return invoices.map((invoice) => ({
        id: invoice.id ?? null,
        number: invoice.number ?? null,
        status: invoice.status ?? null,
        amountDue: invoice.amount_due,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        created: invoice.created,
        dueDate: invoice.due_date ?? null,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        invoicePdf: invoice.invoice_pdf ?? null,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Turns the organization's invoice mail on or off; hosted only. Upserts,
   * because an owner can ask for invoice mail before their first subscription
   * exists.
   */
  async updateInvoiceNotifications(
    ctx: PermissionCtx,
    input: { enabled: boolean },
  ): Promise<{ ok: true }> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'manage billing');
    const organizationId = ctx.session.activeOrganizationId;

    await this.db
      .insert(subscription)
      .values({
        organizationId,
        sendInvoiceNotifications: input.enabled,
      })
      .onConflictDoUpdate({
        target: subscription.organizationId,
        set: { sendInvoiceNotifications: input.enabled },
      });

    return { ok: true };
  }

  /**
   * A Stripe Checkout session for the chosen plan, Starter or Business, and an
   * Add-on quantity, the quantity raised to cover what the organization already
   * uses beyond the base 3. Bills against the organization's stored customer
   * when it has one.
   *
   * Refuses off the Hosted instance, when any of the three prices is unset (503
   * `CHECKOUT_NOT_CONFIGURED`), and when the organization already holds a
   * plan or Enterprise (409 `PLAN_ALREADY_HELD`): a second checkout would be a
   * second subscription. An Attached Organization is refused with 409
   * `PAID_BY_ANOTHER_ORGANIZATION`, as are its plan changes and Add-ons
   * (ADR-0059): what it holds is its Paying Organization's plan. Its own
   * owner is the exception ("Pay for it yourself", `paying-for-itself.ts`):
   * no Free trial, 403 `ORGANIZATION_LIMIT` when they already own another
   * Organization that pays for itself, and the link ends only once the
   * webhook sees the new subscription active.
   *
   * The session's metadata carries `organizationId`, because the webhook has to
   * find the organization the subscription pays for and that is not derivable
   * from a user; and the stale-customer repair below drops a deleted customer
   * from the organization's subscription row.
   *
   * A card is always collected. When the Organization and the person starting
   * it are both eligible (`trialEmailKeyFor`), the subscription starts with
   * Stripe's 30-day free trial; when not, the same Checkout bills today, and
   * nothing says why (ADR-0054). The person's email key rides on the
   * subscription's metadata, and the webhook records it in the trial history
   * once the trial has started.
   */
  async createCheckoutSession(
    ctx: PermissionCtx,
    input: CheckoutInput,
    purchase?: CheckoutPurchase,
  ): Promise<{ sessionId: string; url: string; addOns: number }> {
    this.assertCloud();
    await this.assertAdmin(ctx, 'manage billing');
    const organizationId = ctx.session.activeOrganizationId;
    // An Attached Organization's plan is its Paying Organization's. The one
    // exception is its own owner paying for it, with no Free trial ("Pay for
    // it yourself"): refused over the one-per-person rule, and
    // measured against its own row and its own share, not the pool. Once
    // detached it is refused over the same rule (story 37): the link is gone,
    // and `firstAttachedAt` is what still says it was attached.
    const attached = await attachedOwnershipOf(this.db, organizationId);
    const ownerPaying = attached?.ownerId === ctx.user.id;
    const instanceOrganizationId =
      await this.permissions.instanceOrganizationId();
    if (ownerPaying) {
      await assertOwnerMayPayForIt(
        this.db,
        organizationId,
        ctx.user.id,
        instanceOrganizationId,
      );
    } else {
      await assertNotPaidByAnother(this.db, organizationId, 'billing');
      await assertDetachedMayBePaidFor(
        this.db,
        organizationId,
        ctx.user.id,
        instanceOrganizationId,
      );
    }
    const prices = this.completeCatalogue();

    const { allowance, usage } = ownerPaying
      ? await this.ownAllowanceOf(organizationId)
      : await this.allowanceFor(organizationId);
    if (allowance.plan) {
      throw new ConflictException({
        message:
          allowance.plan === 'enterprise'
            ? `This Organization is Enterprise, billed by agreement rather than through checkout. Contact us at ${OCTABYTE_CONTACT} to change its counts.`
            : `This Organization already has the ${PLAN_LABELS[allowance.plan]} plan. Change its Add-ons instead of checking out again`,
        code: 'PLAN_ALREADY_HELD',
      });
    }
    const addOns = Math.max(input.addOns, minimumAddOns(usage));

    const customerId = await this.resolveLiveCustomerId(organizationId);
    const ownerEmail = await this.ownerEmail(organizationId);
    const trial = trialCheckoutParams(
      ownerPaying ? null : await this.trialEmailKeyFor(ctx),
    );

    const session = await this.stripe.createCheckoutSession({
      mode: 'subscription',
      line_items: [
        ...checkoutLineItems(prices, input.plan, addOns),
        ...(purchase?.linePriceIds && !trial.subscription_data.trial_period_days
          ? purchase.linePriceIds.map((price) => ({ price, quantity: 1 }))
          : []),
      ],
      ...(customerId
        ? {
            customer: customerId,
            customer_update: { name: 'auto', address: 'auto' },
          }
        : { customer_email: ownerEmail }),
      metadata: {
        organizationId,
        ...(purchase ? { boughtServerId: purchase.boughtServerId } : {}),
      },
      ...(purchase?.threeDSecure
        ? {
            payment_method_options: {
              card: { request_three_d_secure: 'any' as const },
            },
          }
        : {}),
      // Copied onto the subscription, so its own events — which may reach the
      // webhook before this session's `checkout.session.completed` stores the
      // customer — name the Organization too.
      subscription_data: {
        ...trial.subscription_data,
        metadata: {
          ...trial.subscription_data.metadata,
          organizationId,
          // The webhook ends the link once this subscription is active, and
          // writes both audit rows as this owner.
          ...(ownerPaying ? paidForItselfMetadata(ctx.user.id) : {}),
        },
      },
      payment_method_collection: trial.payment_method_collection,
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      ...this.checkoutReturnUrls(input.returnTo, purchase !== undefined),
    });

    // Stripe's own address, never one rebuilt from the id: the hosted page
    // needs the `#…` fragment Stripe appends, and refuses a bare
    // `/c/pay/<id>` with "This link is incomplete".
    if (!session.url) {
      throw new Error(
        `Stripe answered checkout session ${session.id} with no url`,
      );
    }
    return { sessionId: session.id, url: session.url, addOns };
  }

  /**
   * An Attached Organization's own allowance and own usage, for its owner's
   * Checkout: its own row (no plan while attached, unless an earlier
   * Checkout's subscription already started) and its own share of the pool.
   */
  private async ownAllowanceOf(
    organizationId: string,
  ): Promise<{ allowance: Allowance; usage: Usage }> {
    const [row, pool] = await Promise.all([
      this.findRow(organizationId),
      this.poolFor(organizationId),
    ]);
    return {
      allowance: allowanceOf(row),
      usage: shareOf(pool, organizationId),
    };
  }

  /**
   * The email key of the person in `ctx` when a Checkout they start now gets
   * the free trial — the Organization has never held a subscription or been
   * Enterprise, and their email is not in the trial history — and null when
   * it does not. Keyed on the caller's own address, not the owner's: one
   * trial per person, whoever starts it.
   */
  private async trialEmailKeyFor(ctx: PermissionCtx): Promise<string | null> {
    const organizationId = ctx.session.activeOrganizationId;
    if (await organizationTrialUsed(this.db, organizationId)) return null;
    const [person] = await this.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, ctx.user.id))
      .limit(1);
    if (!person?.email) return null;
    const key = trialEmailKey(this.config.trialHistorySecret, person.email);
    return (await emailHadTrial(this.db, key)) ? null : key;
  }

  /**
   * Whether a Checkout this person starts now for the active Organization
   * starts the Free trial, as {@link createCheckoutSession} decides it: never
   * for an Attached Organization's owner paying for it, otherwise when the
   * Organization and the person are both eligible.
   */
  async checkoutGivesTrial(ctx: PermissionCtx): Promise<boolean> {
    const attached = await attachedOwnershipOf(
      this.db,
      ctx.session.activeOrganizationId,
    );
    if (attached?.ownerId === ctx.user.id) return false;
    return (await this.trialEmailKeyFor(ctx)) !== null;
  }

  /**
   * Where a Checkout sends the browser back to. Without a `returnTo` it is
   * as it always was: Servers for a Bought Server's Checkout, the Billing
   * page otherwise, with `checkout=success` on a paid plan Checkout only.
   * With one (already checked by `returnToSchema` to be a path on this
   * origin) both legs go there, marked `checkout=success` or
   * `checkout=cancelled`, so the page that sent the person can carry on.
   * `SITE_URL` is always the origin: the caller names a path, never a host.
   */
  checkoutReturnUrls(
    returnTo: string | undefined,
    purchase: boolean,
  ): { success_url: string; cancel_url: string } {
    if (returnTo !== undefined) {
      const site = this.config.siteUrl;
      return {
        success_url: `${site}${withCheckoutOutcome(returnTo, 'success')}`,
        cancel_url: `${site}${withCheckoutOutcome(returnTo, 'cancelled')}`,
      };
    }
    return {
      success_url: purchase
        ? this.serversPageUrl()
        : `${this.billingPageUrl()}?checkout=success`,
      cancel_url: purchase ? this.serversPageUrl() : this.billingPageUrl(),
    };
  }

  /** The console's Servers page, where a Bought Server's Checkout returns. */
  private serversPageUrl(): string {
    return `${this.config.siteUrl}/servers`;
  }

  /** The console's Billing page, where Stripe sends a customer back. */
  private billingPageUrl(): string {
    return `${this.config.siteUrl}/settings/billing`;
  }

  /**
   * All three prices, or a 503 naming each unset setting: an unset price is the
   * instance's configuration, said as such rather than as a Stripe error, and
   * never replaced by another price.
   */
  private completeCatalogue(): CompleteCatalogue {
    const prices = this.config.prices;
    const missing = missingPriceSettings(prices);
    if (missing.length > 0) {
      throw new ServiceUnavailableException({
        message: `Checkout is not set up on this Cloudgate: ${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} not set. The person running it needs to set ${missing.length === 1 ? 'it' : 'them'}`,
        code: 'CHECKOUT_NOT_CONFIGURED',
      });
    }
    return prices as CompleteCatalogue;
  }

  /**
   * The organization's stored Stripe customer, unless Stripe says it was
   * deleted — in which case the stale id is cleared and checkout collects a new
   * customer.
   */
  private async resolveLiveCustomerId(
    organizationId: string,
  ): Promise<string | null> {
    const row = await this.findRow(organizationId);
    const customerId = row?.stripeCustomerId;
    if (!customerId) return null;

    const customer = await this.stripe.retrieveCustomer(customerId);
    if (!customer.deleted) return customerId;

    await this.db
      .update(subscription)
      .set({ stripeCustomerId: null })
      .where(eq(subscription.organizationId, organizationId));
    return null;
  }

  /**
   * The organization owner's email — who Stripe bills — taken from the owner
   * recorded on the organization row.
   */
  private async ownerEmail(organizationId: string): Promise<string> {
    const [row] = await this.db
      .select({ email: user.email })
      .from(organization)
      .innerJoin(user, eq(user.id, organization.ownerId))
      .where(eq(organization.id, organizationId))
      .limit(1);
    return row?.email ?? '';
  }

  /**
   * The Organization's Stripe subscription, as Stripe has it now, for a
   * change to its Add-ons or plan: refused with a 400 when there is none, or
   * when it is neither paid nor in its free trial (`isPaidStatus`). `check`
   * runs between the two, for a refusal that comes before the status one
   * (the plan already held, or not held).
   */
  private async paidSubscriptionOf(
    row: Subscription | null,
    check?: (current: Stripe.Subscription) => void,
  ): Promise<{ subscriptionId: string; current: Stripe.Subscription }> {
    if (!row?.stripeSubscriptionId) {
      throw new BadRequestException('No active subscription found');
    }
    const current = await this.stripe.retrieveSubscription(
      row.stripeSubscriptionId,
    );
    check?.(current);
    if (!isPaidStatus(current.status)) {
      throw new BadRequestException('Subscription is not active');
    }
    return { subscriptionId: row.stripeSubscriptionId, current };
  }

  private async findRow(organizationId: string): Promise<Subscription | null> {
    const [row] = await this.db
      .select()
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Refuses with a 400 unless this is the Hosted instance, where Stripe is
   * configured; everything that reaches Stripe to sell something carries it.
   */
  private assertCloud(): void {
    if (!this.instanceMode.isHosted) {
      throw new BadRequestException(
        'This feature is only available in Cloudgate Cloud',
      );
    }
  }

  /**
   * Owner/admin only, against the organization role. `action` completes the
   * message, e.g. 'manage billing'.
   */
  private async assertAdmin(ctx: PermissionCtx, action: string): Promise<void> {
    const memberRecord = await this.permissions.findMember(ctx);
    if (memberRecord.role !== 'owner' && memberRecord.role !== 'admin') {
      throw new ForbiddenException(`You are not authorized to ${action}`);
    }
  }
}

/** "A", "A and B", "A, B and C". */
function listOf(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A card Stripe refused outright, as the SDK throws it. */
function isCardError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { type?: unknown }).type === 'StripeCardError'
  );
}

/** 402 for an upgrade whose charge did not go through; Starter stays. */
function upgradePaymentFailed(): HttpException {
  return new HttpException(
    {
      message:
        'The payment did not go through, so the Organization stays on Starter. Update the card in the customer portal, then upgrade again',
      code: 'UPGRADE_PAYMENT_FAILED',
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

/** 409 for a trial route outside a free trial. */
function notInTrial(): ConflictException {
  return new ConflictException({
    message: 'This Organization is not in a free trial',
    code: 'NOT_IN_TRIAL',
  });
}

/**
 * The upgrade confirm's figures during a trial: nothing today, and the first
 * Business month — with the same Add-ons — on the day the trial ends.
 */
function trialUpgradePreview(
  current: Stripe.Subscription,
  next: Stripe.Invoice,
  prorationDate: number,
): UpgradePreviewView {
  const trialEnd = current.trial_end ?? prorationDate;
  return {
    today: 0,
    monthlyAfter: next.total,
    currency: next.currency,
    daysLeft: daysLeftOf(trialEnd, prorationDate),
    renewsAt: trialEnd,
    prorationDate,
  };
}

/** A Stripe price as the console shows it. */
function priceView(price: Stripe.Price): PriceView {
  const product = price.product;
  return {
    id: price.id,
    name:
      product && typeof product === 'object' && 'name' in product
        ? (product.name ?? null)
        : null,
    unitAmount: price.unit_amount ?? null,
    currency: price.currency,
    interval: price.recurring?.interval ?? null,
  };
}
