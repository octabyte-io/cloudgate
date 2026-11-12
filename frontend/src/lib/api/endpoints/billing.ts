import { api } from "../client";

/**
 * `cloud/billing/billing.controller.ts` — the Organization's subscription, its
 * plan (Starter or Business) and Add-ons, and the invoices it has been sent.
 *
 * **This whole surface only means something on the Hosted instance.** "This
 * instance does not sell subscriptions" and "this Organization has not
 * subscribed" are the same all-null answer on every read here, so which one it
 * is comes from the instance mode on `GET /settings/about` (`useInstanceMode`),
 * which replaced the `isCloud` this read carried. The Billing
 * page asks for nothing else when self-hosted. `products`,
 * `invoice-notifications`, `checkout` and `add-ons` refuse there with a
 * **400** "This feature is only available in Cloudgate Cloud" (`assertCloud`).
 *
 * ## Two plans and their Add-on (ADR-0048, ADR-0054)
 *
 * The catalogue is two monthly plans, Starter and Business, each 3 Servers and
 * 3 Cloud Environments, Business adding SSO, SCIM, custom roles and forward
 * auth; and the monthly Add-on (one more of each) both take. The allowance is
 * `3 + addOns` while the plan is granted and 0/0 without it, and a full count
 * refuses only the next addition: nothing already held is ever switched off.
 *
 * ## Money is in cents
 *
 * `PriceView.unitAmount` and the invoice amounts are Stripe's own **minor
 * units**, and `created` / `dueDate` are **Unix seconds**.
 *
 * ## Which of these a member may call
 *
 * `plan`, `can-create-server`, `standing` and `attached-plan` are open to any
 * member. Everything else runs `assertAdmin` — owner or admin — and answers
 * "You are not authorized to read billing". So a member sees whether they may
 * add a Server, and, in an Attached Organization, who pays and the room left,
 * and nothing about what it costs.
 */

/** `billingPlanEnum` — the plan a subscription's prices resolve to. */
export type BillingPlan = "starter" | "business";

/** Both plans, in the order the picker shows them. */
export const BILLING_PLANS: readonly BillingPlan[] = ["starter", "business"];

/** A plan's name as the console says it. */
export const PLAN_LABELS: Record<BillingPlan, string> = {
  starter: "Starter",
  business: "Business",
};

/** What grants an allowance: Starter or Business, or Enterprise's hand-set counts. */
export type AllowanceSource = BillingPlan | "enterprise";

/** What an Organization may hold: 0/0 unless the plan is granted. */
export interface Allowance {
  plan: AllowanceSource | null;
  servers: number;
  cloudEnvironments: number;
}

/**
 * What an Organization holds, per counted kind. A Cloud Environment is an
 * Environment whose Deploy target is a Cloud account or that still holds a
 * Service in one, counted once however many accounts or regions it uses.
 */
export interface Usage {
  servers: number;
  cloudEnvironments: number;
}

/** `GET /billing/subscription` — the stored row plus the allowance it buys. */
export interface BillingState {
  /** The plan the subscription's prices resolve to, as the webhook stored it. */
  plan: BillingPlan | null;
  /** Stripe's own status verbatim: `active`, `past_due`, `canceled`, … */
  status: string | null;
  /** The Add-on quantity the subscription bills. */
  addOns: number;
  allowance: Allowance;
  usage: Usage;
  /** The fewest Add-ons that cover `usage`; the picker never goes below it. */
  minimumAddOns: number;
  sendInvoiceNotifications: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /**
   * Whether a Checkout the reader starts now begins the 30-day free trial
   * (ADR-0054): the Organization never held a subscription or was
   * Enterprise, and the reader never had a trial. False while a plan is held.
   */
  trialAvailable: boolean;
  /** When the free trial ends, ISO 8601, while in one; null otherwise. */
  trialEndsAt: string | null;
  /**
   * The plan a waiting downgrade moves to — Starter — or null when
   * none waits; `scheduledAt` is when, the end of the paid month, as ISO.
   */
  scheduledPlan: BillingPlan | null;
  scheduledAt: string | null;
  /**
   * Where the free trial stands while in one, read live from Stripe;
   * null outside a trial.
   */
  trial: TrialState | null;
  /**
   * The Paying Organization of an **Attached Organization** (ADR-0059);
   * null for one that pays for itself. `usage` is then this Organization's
   * own, and nothing says what the other Organizations on the plan hold.
   */
  paidBy: PaidBy | null;
  /**
   * The shared meters of a **Paying Organization** with any Organization
   * attached (ADR-0059): the whole pool's use, which `allowance` is measured
   * against, and how many Organizations that is, this one included. `usage`
   * stays this Organization's own share. Null with nothing attached, and for
   * an Attached Organization.
   */
  pool: PoolUsage | null;
}

/** `BillingState.pool`: every Organization on the plan, added up. */
export interface PoolUsage {
  usage: Usage;
  organizations: number;
}

/** `BillingState.paidBy`: who pays, and what its plan leaves the pool. */
export interface PaidBy {
  /** The Paying Organization's name. */
  name: string;
  /** What its plan allows every Organization on it, together. */
  allowance: Allowance;
  /** The room left on that plan for one more, shared with the others. */
  roomLeft: Usage;
  /**
   * "Pay for it yourself", for this Organization's own owner: whether
   * Checkout would take it (no Free trial) and, when not, the backend's
   * reason. `null` for anyone else, who is not offered it.
   */
  payForItYourself: PayForItYourself | null;
}

/**
 * `GET /billing/attached-plan`, which **any member** may read: an Attached
 * Organization's Billing page — who pays, the room left on that plan, and
 * this Organization's own use. Both null for an Organization that pays for
 * itself, whose Billing page stays an owner's or admin's. No `allowance`: the
 * plan's size beside the room left and the own use would say what the other
 * Organizations on the plan hold.
 */
export interface AttachedPlan {
  paidBy: AttachedPaidBy | null;
  usage: Usage | null;
}

/** `AttachedPlan.paidBy`: `PaidBy` without the plan's size. */
export type AttachedPaidBy = Omit<PaidBy, "allowance">;

/** `PaidBy.payForItYourself`. */
export interface PayForItYourself {
  allowed: boolean;
  /** Why not, in the refusal's words; `null` when allowed. */
  reason: string | null;
  /** `ORGANIZATION_LIMIT` when refused. */
  code: string | null;
}

/** One Organization a Paying Organization pays for, on its Billing page. */
export interface AttachedOrganization {
  id: string;
  name: string;
  /** Its owner; null for one whose owner is gone. */
  owner: { name: string; email: string } | null;
  /**
   * Whether the reader owns it: the move-to-Starter checklist offers Delete
   * for theirs alone.
   */
  ownedByYou: boolean;
  servers: number;
  cloudEnvironments: number;
  /**
   * Its Bought Servers whose machines exist: what "Stop paying for it"
   * deletes at once, unless it starts paying for itself first (ADR-0071).
   */
  boughtServers: number;
  /** When it was made, ISO 8601. */
  createdAt: string;
}

/**
 * `GET /billing/attached-organizations` — the "Organizations on this plan"
 * card. Owner or admin; Hosted only.
 */
export interface AttachedOrganizations {
  /** The open Organization's name, the one that pays. */
  name: string;
  /** Whether "Add an Organization to this plan" would be accepted now. */
  allowed: boolean;
  /** Why not, in the refusal's own words; null when it can. */
  reason: string | null;
  /** `ORGANIZATION_LIMIT` when refused. */
  code: string | null;
  /** What the shared pool has room for: what the Add dialog says is free. */
  free: Usage;
  /** Oldest first. */
  organizations: AttachedOrganization[];
}

/** What "Stop paying for it" answers. */
export interface StoppedPaying {
  organizationId: string;
  /** When it lapsed: now. ISO 8601. */
  lapsedAt: string;
  /** When it is deleted unless its owner pays: 30 days on. ISO 8601. */
  deletesOn: string;
}

/** The card (or other payment method) a trial's first charge goes to. */
export interface PaymentMethodSummary {
  /** `visa`, `mastercard`, …, or the method's type when it is not a card. */
  brand: string;
  /** A card's last four digits; null for another kind of method. */
  last4: string | null;
}

/** `BillingState.trial` — a free trial, as the Billing page shows it. */
export interface TrialState {
  /** When the trial ends, ISO 8601. */
  endsAt: string;
  /** "Cancel trial" was chosen: no plan after `endsAt`, nothing charged. */
  cancelled: boolean;
  /**
   * The first charge, on the day the trial ends, for what is held then.
   * Null when cancelled, or when Stripe could not be asked. Minor units.
   */
  firstCharge: { amount: number; currency: string; at: string } | null;
  /** The payment method on file, when Stripe says there is one. */
  paymentMethod: PaymentMethodSummary | null;
  /** Stripe answered and has no payment method: "Add a card at Stripe". */
  paymentMethodMissing: boolean;
}

/** `POST /billing/downgrade` — the move it scheduled. */
export interface ScheduledMove {
  scheduledPlan: BillingPlan;
  scheduledAt: string;
}

/**
 * `GET /billing/plan`, which any member may read: the plan held now, and when
 * a waiting downgrade moves it to Starter, ISO, or null.
 */
export interface CurrentPlan {
  plan: AllowanceSource | null;
  scheduledAt: string | null;
}

/** One person on a custom role, which allows nothing on Starter. */
export interface CustomRoleHolder {
  /** Their name, or their email when none was recorded. */
  name: string;
  role: string;
}

/**
 * `GET /billing/downgrade-impact`: what moving to Starter stops,
 * against what this Organization uses. A paid feature never set up is zero
 * or empty, and the downgrade confirm leaves it out. Owner or admin.
 */
export interface DowngradeImpact {
  /** SSO providers: SSO sign-in stops for every one. */
  ssoProviders: number;
  /** Members with an SSO account and no password, who use "Forgot password". */
  ssoOnlyPeople: number;
  /** SCIM connections: their adds are refused, removals still work. */
  scimProviders: number;
  customRoleHolders: CustomRoleHolder[];
  /** Applications behind forward auth: still protected, no longer editable. */
  protectedApps: number;
  /** When a move asked for now would happen, ISO: the paid month's end. */
  downgradeAt: string | null;
}

/** One of the three prices, as Stripe has it. Amount in minor units. */
export interface PriceView {
  id: string;
  name: string | null;
  /** `null` for a tiered price. */
  unitAmount: number | null;
  currency: string;
  interval: string | null;
}

/** `GET /billing/products` — both plans, the Add-on, and what a plan includes. */
export interface Catalogue {
  /** Servers and Cloud Environments either plan includes before any Add-on. */
  includes: number;
  plans: Record<BillingPlan, PriceView>;
  addOn: PriceView;
}

/** `GET /billing/can-create-server`. */
export interface ServerRoom {
  canCreateMoreServers: boolean;
  /** `PLAN_REQUIRED` or `ALLOWANCE_FULL` when refused. */
  code: "PLAN_REQUIRED" | "ALLOWANCE_FULL" | null;
  /** The refusal's sentence, as Server create would answer it. */
  message: string | null;
}

/** `GET /billing/invoices`. Amounts are minor units, times are Unix seconds. */
export interface Invoice {
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

export interface AddOnsInput {
  /** Raised by the backend to `minimumAddOns` when lower. */
  addOns: number;
}

/** `POST /billing/checkout`: the plan chosen and its Add-ons. */
export interface CheckoutInput extends AddOnsInput {
  plan: BillingPlan;
  /**
   * A path on this console (starting `/`, never `//`) Checkout returns to,
   * with `checkout=success` or `checkout=cancelled` added to its query.
   * Left out, Checkout returns to the Billing page as before.
   */
  returnTo?: string;
}

/**
 * `GET /billing/upgrade-preview` — what Starter → Business charges (ADR-0054),
 * from Stripe's invoice preview of the swap. Amounts in minor units,
 * times in Unix seconds.
 */
export interface UpgradePreview {
  /** Charged today, prorated over `daysLeft`. */
  today: number;
  /** Every month after, on Business with the same Add-ons. */
  monthlyAfter: number;
  currency: string;
  /** Whole days left of the paid month, today counted. */
  daysLeft: number;
  /** When the month ends and the first full Business month is charged. */
  renewsAt: number;
  /** Sent back with `POST /billing/upgrade`, so the charge is this preview's. */
  prorationDate: number;
}

/** `POST /billing/upgrade` refuses a preview this old with a 409 carrying it. */
export const UPGRADE_PREVIEW_STALE_CODE = "UPGRADE_PREVIEW_STALE";

/** A Frozen Organization's recorded cause (ADR-0052). */
export type FrozenCause = "lapsed" | "suspended";

/**
 * `GET /billing/standing` — any member. What the banner reads: shown while
 * `frozen` or `paymentFailed` (from the first failed payment until the
 * Organization is paid again), naming each cause. Self-hosted it is always
 * the empty answer.
 */
export interface Standing {
  frozen: boolean;
  /** Suspension first: paying cannot lift it. */
  causes: FrozenCause[];
  /** Stripe is retrying a failed payment (`past_due`); nothing is frozen. */
  paymentFailed: boolean;
  /** ISO time the subscription ended, when lapsed. */
  lapsedAt: string | null;
  /** The Operator's reason, shown to the customer, when suspended. */
  suspendedReason: string | null;
  /**
   * An Attached Organization's Paying Organization, null for one that pays
   * for itself: its name, and whether its payment is failing while Stripe
   * retries — the one line on the Attached Organization's Billing page. Its
   * own `paymentFailed` stays false: only the payer's people can fix it.
   */
  payingOrganization: { name: string; paymentFailed: boolean } | null;
}

/** The `code` of a write refused because the Organization is frozen. */
export const ORGANIZATION_FROZEN_CODE = "ORGANIZATION_FROZEN";

export const billingApi = {
  subscription: () => api.get<BillingState>("/billing/subscription"),

  standing: () => api.get<Standing>("/billing/standing"),

  plan: () => api.get<CurrentPlan>("/billing/plan"),

  /**
   * The Organizations this one pays for, and whether "Add an Organization to
   * this plan" is offered. The add itself is `organizationsApi.create` with
   * `paidBy: "active-organization"`.
   */
  attachedOrganizations: () =>
    api.get<AttachedOrganizations>("/billing/attached-organizations"),

  /**
   * An Attached Organization's Billing page as any of its members sees it;
   * both fields null for one that pays for itself. Any member.
   */
  attachedPlan: () => api.get<AttachedPlan>("/billing/attached-plan"),

  /**
   * "Stop paying for it" (ADR-0059): detaches an Organization the active one
   * pays for. It lapses at once on its own: frozen, out of the pool, deleted
   * on `deletesOn` unless its owner pays. Owner or admin of the payer.
   */
  stopPaying: (organizationId: string) =>
    api.post<StoppedPaying>(
      `/billing/attached-organizations/${encodeURIComponent(organizationId)}/stop-paying`,
    ),

  products: () => api.get<Catalogue>("/billing/products"),

  invoices: () => api.get<Invoice[]>("/billing/invoices"),

  /**
   * `GET /billing/can-create-server`. Any member may ask. **Always room when
   * self-hosted**, where Servers are not metered — which is why this cannot
   * double as the mode check.
   */
  canCreateServer: () => api.get<ServerRoom>("/billing/can-create-server"),

  /**
   * `POST /billing/checkout` answers the session id and **Stripe's own `url`**
   * for it. The browser goes to that url exactly as given: Stripe's hosted page
   * needs the `#…` fragment it appends, and refuses an address rebuilt from the
   * id alone ("This link is incomplete").
   */
  checkout: (input: CheckoutInput) =>
    api.post<{ sessionId: string; url: string; addOns: number }>(
      "/billing/checkout",
      input,
    ),

  /**
   * `POST /billing/portal`. A Stripe failure answers `{ url: "" }` rather than
   * raising — a bare `catch { return { url: "" } }` — so an empty
   * string is a refusal the caller has to handle and not an address to visit.
   */
  portal: () => api.post<{ url: string }>("/billing/portal"),

  /** `POST /billing/add-ons` — answers the quantity actually set. */
  setAddOns: (input: AddOnsInput) =>
    api.post<{ addOns: number }>("/billing/add-ons", input),

  /**
   * `GET /billing/upgrade-preview`. Owner or admin, on an active Starter
   * subscription; 409 `PLAN_ALREADY_HELD` once on Business.
   */
  upgradePreview: () => api.get<UpgradePreview>("/billing/upgrade-preview"),

  /**
   * `POST /billing/upgrade` — Starter → Business at once, charging the amount
   * the preview at `prorationDate` showed. 409 `UPGRADE_PREVIEW_STALE` when
   * that preview is over an hour old; 402 `UPGRADE_PAYMENT_FAILED` when the
   * card is refused, and the Organization stays on Starter.
   */
  upgrade: (prorationDate: number) =>
    api.post<{ plan: BillingPlan }>("/billing/upgrade", { prorationDate }),

  /**
   * `POST /billing/downgrade` — Business → Starter at the end of the paid
   * month, nothing charged. 409 `DOWNGRADE_ALREADY_WAITING` when one
   * already waits, `DOWNGRADE_NOT_AVAILABLE` off Business.
   */
  downgrade: () => api.post<ScheduledMove>("/billing/downgrade"),

  /** `GET /billing/downgrade-impact` — what the move to Starter stops. */
  downgradeImpact: () => api.get<DowngradeImpact>("/billing/downgrade-impact"),

  /**
   * `DELETE /billing/downgrade` — "Keep Business": takes the waiting move
   * back, nothing charged. 409 `NO_DOWNGRADE_WAITING` when none waits.
   */
  keepBusiness: () => api.delete<{ plan: BillingPlan }>("/billing/downgrade"),

  /**
   * A plan switch during a free trial: `POST /billing/upgrade` or
   * `POST /billing/downgrade`, which in a trial both take effect at once and
   * charge nothing, the trial keeping its end. The upgrade's proration time
   * is not used in a trial, so now is sent.
   */
  switchDuringTrial: (plan: BillingPlan) =>
    plan === "business"
      ? api.post<{ plan: BillingPlan }>("/billing/upgrade", {
          prorationDate: Math.floor(Date.now() / 1000),
        })
      : api.post<{ plan: BillingPlan }>("/billing/downgrade"),

  /**
   * `POST /billing/cancel-trial` — "Cancel trial": no plan after the trial,
   * nothing charged. 409 `NOT_IN_TRIAL` outside a trial.
   */
  cancelTrial: () => api.post<TrialState>("/billing/cancel-trial"),

  /** `DELETE /billing/cancel-trial` — "Keep <plan>": the cancel taken back. */
  keepTrial: () => api.delete<TrialState>("/billing/cancel-trial"),

  /**
   * `PATCH /billing/invoice-notifications`. Self-hosted it is a 400 saying
   * "This feature is only available in Cloudgate Cloud".
   */
  setInvoiceNotifications: (enabled: boolean) =>
    api.patch<{ ok: true }>("/billing/invoice-notifications", { enabled }),
};

/**
 * A Stripe amount as money.
 *
 * `minor` says whether the number is in cents; guessing from the magnitude is
 * how a $15 plan becomes $1,500. The currency is Stripe's lowercase ISO code.
 */
export function formatMoney(
  amount: number,
  currency: string,
  { minor = true }: { minor?: boolean } = {},
): string {
  const value = minor ? amount / 100 : amount;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(value);
  } catch {
    // An unknown currency code throws rather than degrading, and a price is
    // still worth showing without its symbol.
    return `${value.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * A moment as a sentence says its day: "28 November". ISO, as the billing
 * reads carry it, or a `Date` (a Unix-seconds field is `new Date(s * 1000)`).
 */
export function formatDay(at: string | Date): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}
