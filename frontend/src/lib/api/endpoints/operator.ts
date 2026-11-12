import { api } from "../client";

import type { BillingPlan } from "./billing";
import type { BoughtServerStage } from "./bought-servers";

/**
 * `operator/operator.controller.ts` — the Operator page's API (ADR-0050).
 * **Hosted only**: on a Self-hosted instance every route
 * answers 404.
 *
 * An Operator is an owner or admin of the Instance organization, a person and
 * never an Agent. `access` may be asked by anyone signed in and answers whether
 * they are one; `organizations` refuses everybody else with a 403.
 *
 * The list is account facts only — nothing from inside a Project.
 */

/** One counted kind: what the Organization holds against what it may hold. */
export type OperatorCount = { used: number; allowed: number };

export type OperatorOrganization = {
  id: string;
  name: string;
  createdAt: string;
  ownerEmail: string;
  /** People only; an Agent is not counted. */
  memberCount: number;
  /** The plan it holds now — Enterprise included — or null for None. */
  plan: OperatorPlan | null;
  /** Where it stands, from Cloudgate's own records, never a Stripe status. */
  state: OperatorState;
  /** Whether it has had its one free trial, or can no longer have one. */
  trialUsed: boolean;
  servers: OperatorCount;
  cloudEnvironments: OperatorCount;
  enterprise: boolean;
  /** The Operator's suspension and the reason the customer sees, or null. */
  suspension: OperatorSuspension | null;
  /**
   * The Paying Organization of an **Attached Organization** (ADR-0059), or
   * null for one that pays for itself. Attached, its Plan and State are its
   * payer's (its State its own only when suspended or lapsed), and its counts
   * are its own share against the payer's whole pool.
   */
  paidBy: OperatorNamedOrganization | null;
  /**
   * The Organizations it pays for, oldest first; empty for none. Non-empty,
   * its counts are the whole pool's.
   */
  attached: OperatorNamedOrganization[];
};

/** Another Organization a row names. */
export type OperatorNamedOrganization = { id: string; name: string };

export type OperatorSuspension = { reason: string; suspendedAt: string };

/** `operator-state.ts` `OperatorPlan`: Starter, Business or Enterprise. */
export type OperatorPlan = BillingPlan | "enterprise";

/**
 * `operator-state.ts` `OperatorState`: one fact about where the
 * Organization stands, with the date it needs.
 */
export type OperatorState =
  | { kind: "trial"; endsAt: string }
  | { kind: "ends"; endsAt: string }
  | { kind: "moves-to-starter"; on: string }
  | { kind: "paid" }
  | { kind: "payment-failing" }
  | { kind: "lapsed" }
  | { kind: "suspended" }
  | { kind: "none" };

/**
 * An Operator's Enterprise switch: on with the agreement's counts, or
 * off, which needs none.
 */
export type OperatorEnterpriseChange =
  | { enterprise: true; servers: number; cloudEnvironments: number }
  | { enterprise: false };

/** The marker and its counts as they now stand; 0/0 when off. */
export type OperatorEnterprise = {
  enterprise: boolean;
  servers: number;
  cloudEnvironments: number;
};

/** A Bought Server's real margin at the day's rate (`margin.ts`). */
export type OperatorMargin = {
  /** The provider's EUR cost in US cents, at the day's rate. */
  costCents: number;
  /** The price less that cost, in US cents; negative is a loss. */
  marginCents: number;
  /** Percent of the price, to one decimal. */
  marginPercent: number;
};

/**
 * One **Bought Server** on the Operator page: account facts only
 * (ADR-0050). The provider's size and Location codes are an Operator's to
 * see, never a customer's.
 */
export type OperatorBoughtServer = {
  id: string;
  name: string;
  organization: OperatorNamedOrganization;
  serverType: string;
  location: string;
  stage: BoughtServerStage;
  /** Every line's current price together, US cents a month. */
  monthlyCents: number;
  providerServerId: number | null;
  /** Null with no rate, no EUR price, or nothing billed any more. */
  margin: OperatorMargin | null;
  belowFloor: boolean;
  /** An Operator's power-off for abuse and its reason (#1401), or null. */
  poweredOff: { at: string; reason: string } | null;
  createdAt: string;
};

/** The day's ECB euro reference rate, the one every margin on the page uses. */
export type OperatorDayRate = { usdPerEur: number; on: string };

/** `GET /operator/bought-servers`. */
export type OperatorBoughtServers = {
  exchangeRate: OperatorDayRate | null;
  /** Whether the provider's EUR price list could be read. */
  costsRead: boolean;
  marginFloorPercent: number;
  /** Newest first. */
  servers: OperatorBoughtServer[];
};

/** The Server markup, the margin floor, and the reverse-DNS domain. */
export type BoughtServerSettings = {
  markupPercent: number;
  marginFloorPercent: number;
  /** Null while unset: the machines keep the provider's default name. */
  reverseDnsDomain: string | null;
};

/** A change to either setting, whole percent. */
export type BoughtServerSettingsChange = {
  markupPercent?: number;
  marginFloorPercent?: number;
};

/**
 * One machine nothing owns (#1402): in the provider's account with
 * Cloudgate's labels, and no live Bought Server behind it, as the hourly
 * check last found it.
 */
export type OperatorOrphanMachine = {
  /** The machine's id at the provider. */
  providerServerId: number;
  name: string;
  /** The provider's Location code, `hel1`. */
  location: string;
  /** Which Organization and Server it was made for. */
  labels: Record<string, string>;
  /** When the provider made it: its age. */
  createdAt: string;
  /** When the hourly check first found it, and emailed the Operators. */
  foundAt: string;
  seenAt: string;
};

/**
 * One Bought Server in a reprice preview, and as it was applied (#1400):
 * `rise` starts on `startsAt`, 30 days on; `fall` applies at once;
 * `unchanged` already sells at the list price; `unpriceable` is off the
 * list; `not-repriceable` is in a stage that cannot be repriced.
 */
export type RepricePreview = {
  id: string;
  name: string;
  organization: OperatorNamedOrganization;
  stage: BoughtServerStage;
  status: "rise" | "fall" | "unchanged" | "unpriceable" | "not-repriceable";
  /** Every line's current price together, US cents a month. */
  oldMonthlyCents: number;
  newMonthlyCents: number | null;
  startsAt: string | null;
  lines: Array<{
    kind: "server" | "backups" | "storage";
    oldMonthlyCents: number;
    newMonthlyCents: number;
  }>;
};

/** One Bought Server to reprice, at the new price its preview showed. */
export type RepriceConfirm = { id: string; newMonthlyCents: number };

export const operatorApi = {
  access: () => api.get<{ operator: boolean }>("/operator/access"),

  organizations: () =>
    api.get<OperatorOrganization[]>("/operator/organizations"),

  /**
   * Suspends the Organization: it is frozen with "Suspended. Contact
   * Octabyte" and `reason`, and its owners are emailed. 409 when it already
   * is, or for the Instance organization.
   */
  suspend: (organizationId: string, reason: string) =>
    api.post<OperatorSuspension>(
      `/operator/organizations/${organizationId}/suspension`,
      { reason },
    ),

  /** Lifts the suspension; a lapse, if any, still freezes it. 409 when none. */
  lift: (organizationId: string) =>
    api.delete<unknown>(`/operator/organizations/${organizationId}/suspension`),

  /**
   * Switches Enterprise on with its Server and Cloud Environment counts, which
   * become the allowance, or off, back to needing a Hosted plan.
   * 409 `STRIPE_SUBSCRIPTION_ACTIVE` switching on over a live Stripe
   * subscription, a free trial included.
   */
  setEnterprise: (organizationId: string, change: OperatorEnterpriseChange) =>
    api.put<OperatorEnterprise>(
      `/operator/organizations/${organizationId}/enterprise`,
      change,
    ),

  /** Every Bought Server with its real margin; Operators only. */
  boughtServers: () =>
    api.get<OperatorBoughtServers>("/operator/bought-servers"),

  boughtServerSettings: () =>
    api.get<BoughtServerSettings>("/operator/bought-servers/settings"),

  /**
   * Sets the Server markup and/or the margin floor. A markup prices new
   * purchases and new lines only. Audited in the Instance organization.
   */
  setBoughtServerSettings: (change: BoughtServerSettingsChange) =>
    api.put<BoughtServerSettings>("/operator/bought-servers/settings", change),

  /** The machines nothing owns, as the hourly check last found them. */
  orphanMachines: () =>
    api.get<OperatorOrphanMachine[]>("/operator/bought-servers/orphans"),

  /**
   * Deletes a machine nothing owns, with its Volume and Primary IPs.
   * Audited in the Instance organization.
   */
  deleteOrphanMachine: (providerServerId: number) =>
    api.delete<void>(`/operator/bought-servers/orphans/${providerServerId}`),

  /**
   * Each chosen Bought Server's old price and its price at the current list
   * and Server markup. Changes nothing.
   */
  previewReprice: (ids: string[]) =>
    api.post<RepricePreview[]>("/operator/bought-servers/reprice/preview", {
      ids,
    }),

  /**
   * Applies the previewed reprice: a rise from 30 days on, a fall at once;
   * each Organization's owners are emailed. 409 `PRICES_CHANGED` when a
   * price is no longer the one previewed, changing nothing.
   */
  reprice: (servers: RepriceConfirm[]) =>
    api.post<RepricePreview[]>("/operator/bought-servers/reprice", {
      servers,
    }),
};
