import { api } from "../client";

/**
 * `bought-servers/bought-servers.controller.ts` — *Buy a Server* (ADR-0071).
 * **Hosted only**: on a Self-hosted instance both routes answer 404, and on
 * the Hosted instance without the provider's tokens the catalogue does too.
 *
 * Neither request carries anything about the customer: where they are is
 * worked out in the browser and stays there (`features/server/buy/where-you-are.ts`).
 */

/** How a size is grouped on the page. */
export type SizeFamily = "shared" | "arm" | "amd" | "dedicated";

export type CatalogueLocation = {
  id: string;
  /** `Falkenstein`, or `Ashburn, VA`. */
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  latitude: number;
  longitude: number;
};

/** One size in one Location. Whole US dollars a month. */
export type CatalogueOffer = {
  locationId: string;
  /** Whether it can be bought there right now; only a hint. */
  available: boolean;
  monthly: number;
  backupsMonthly: number;
};

export type CatalogueSize = {
  /** The provider's code for the size. A purchase names it; the page never shows it. */
  id: string;
  family: SizeFamily;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  /** Only the Locations it is sold in. */
  offers: CatalogueOffer[];
};

export type BoughtServerCatalogue = {
  locations: CatalogueLocation[];
  sizes: CatalogueSize[];
  storage: {
    minGb: number;
    maxGb: number;
    /** One GB a month, not rounded: a size's price is this times its GB, rounded up once. */
    perGbMonthly: number;
  };
};

/** A Bought Server's stage (spec #1387). */
export type BoughtServerStage =
  | "waiting_for_payment"
  | "creating"
  | "setting_up"
  | "ready"
  | "changing"
  | "deleting"
  | "deleted"
  | "failed";

/** A size in a Location, by the catalogue's ids, and whether backups and extra storage come with it. */
export type BuyChoice = {
  serverType: string;
  location: string;
  backups?: boolean;
  /** Extra storage in GB; absent for none. */
  storageGb?: number;
};

/**
 * The Organization's plan state, as the Today box speaks for it (#1392):
 * - `plan`: on a paid plan; the Server joins it, charged today to the renewal.
 * - `trial`: in the Free trial; the Server is charged on its own invoice to
 *   the trial's end, then joins the plan.
 * - `start-trial`: no plan, Free trial available: Checkout starts Starter's
 *   trial, and the Server is charged with it.
 * - `start-plan`: no plan, Free trial used: Starter and the Server are both
 *   paid today.
 */
export type TodayState = "plan" | "trial" | "start-trial" | "start-plan";

/** `GET /bought-servers/today`: what Buy charges now. Amounts in US cents. */
export type TodayView = {
  state: TodayState;
  /** Everything charged today together. */
  today: number;
  /** Every month after, for the Server's own lines. */
  monthly: number;
  currency: string;
  /** The dates today's charge covers, Unix seconds: now to the plan's renewal or the trial's end. */
  from: number;
  to: number | null;
  /** Sent back with Buy, so the charge is the amount shown. */
  prorationDate: number;
  /** With no plan: the plan Checkout starts, and what it costs today (0 in its Free trial). */
  plan: { name: string; monthlyCents: number; todayCents: number } | null;
  /** The Add-on bought with the Server because the Server count is full; null while there is room. */
  addOn: { quantity: number; monthlyCents: number } | null;
};

export type BuyInput = BuyChoice & {
  name?: string;
  termsAccepted: true;
  prorationDate: number;
} & ReturnToInput;

/**
 * A path on this console (starting `/`, never `//`) that a Checkout or a 3D
 * Secure page sends the browser back to, with `checkout=success` or
 * `checkout=cancelled` added to its query. Left out, a paid Checkout returns
 * to the Servers screen as before.
 */
export type ReturnToInput = { returnTo?: string };

/** What Buy, Finish paying and Cancel answer. */
export type PurchaseResult = {
  id: string;
  stage: BoughtServerStage;
  /**
   * Where to finish paying while it waits: the invoice's 3D Secure page, or,
   * with no plan, the Checkout that starts it.
   */
  payUrl: string | null;
};

/** What a Bought Server is charged for, line by line. */
export type BoughtServerLineKind = "server" | "backups" | "storage";

/** `GET /bought-servers/:id`: the Bought Server behind a Server. Amounts in US cents a month. */
export type BoughtServerView = {
  id: string;
  name: string;
  stage: BoughtServerStage;
  backups: boolean;
  storageGb: number | null;
  lines: { kind: BoughtServerLineKind; monthlyCents: number }[];
  monthlyCents: number;
  /** What backups would cost if turned on now; null while on, or when the size is no longer sold there. */
  backupsOfferCents: number | null;
  /** The change running now, while the stage is Changing. */
  change: { backups?: boolean; storageGb?: number; serverType?: string } | null;
};

/**
 * `GET /bought-servers/:id/sizes`: a size the Server can move to in its own
 * Location. Its `id` names the size in a change; nothing renders it.
 */
export type SizeChoice = {
  id: string;
  family: SizeFamily;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  /** The Server line alone, US cents a month. */
  monthlyCents: number;
  backupsMonthlyCents: number;
  available: boolean;
  /**
   * Its disk is smaller than the Server's own, which a size change never
   * shrinks: it cannot be moved to.
   */
  smallerDisk: boolean;
  /** The size it is now. */
  current: boolean;
};

/** `GET /bought-servers/purchases`: a Bought Server not made yet. */
export type ServerPurchase = {
  id: string;
  name: string;
  stage: BoughtServerStage;
  /** US cents a month. */
  monthlyCents: number;
  createdAt: string;
};

export const boughtServersApi = {
  /** Whether *Buy a Server* is offered on this instance. */
  offer: () => api.get<{ offered: boolean }>("/bought-servers/offer"),
  /** Every Location and size with its tidy price. Takes nothing: the position is never sent. */
  catalogue: () => api.get<BoughtServerCatalogue>("/bought-servers/catalogue"),
  /** The Today box: Stripe's own preview of the charge Buy would make now. */
  today: ({ serverType, location, backups, storageGb }: BuyChoice) =>
    api.get<TodayView>(
      `/bought-servers/today?${new URLSearchParams({
        serverType,
        location,
        ...(backups ? { backups: "true" } : {}),
        ...(storageGb ? { storageGb: String(storageGb) } : {}),
      }).toString()}`,
    ),
  /** Buy: charged at once; the machine is made only once the payment succeeds. */
  buy: (input: BuyInput) => api.post<PurchaseResult>("/bought-servers", input),
  /** The Organization's Bought Servers not made yet: waiting for payment, or being created. */
  purchases: () => api.get<ServerPurchase[]>("/bought-servers/purchases"),
  /** Where the payment stands, and where to finish it. */
  finishPaying: (id: string, input: ReturnToInput = {}) =>
    api.post<PurchaseResult>(
      `/bought-servers/${encodeURIComponent(id)}/finish-paying`,
      input,
    ),
  /** The Bought Server behind a Server; 404 for a Server that was not bought. */
  server: (id: string) =>
    api.get<BoughtServerView>(`/bought-servers/${encodeURIComponent(id)}`),
  /**
   * Backups on (charged at once for the rest of the plan's month) or off
   * (every backup deleted at once, credited on the next invoice).
   */
  setBackups: (id: string, enabled: boolean) =>
    api.put<BoughtServerView>(
      `/bought-servers/${encodeURIComponent(id)}/backups`,
      { enabled },
    ),
  /**
   * Extra storage grown to `sizeGb`: charged at once for the rest of the
   * plan's month, then grown, filesystem included. It never shrinks.
   */
  growStorage: (id: string, sizeGb: number) =>
    api.put<BoughtServerView>(
      `/bought-servers/${encodeURIComponent(id)}/storage`,
      { sizeGb },
    ),
  /** The sizes the Server can move to in its Location, with their prices. */
  sizes: (id: string) =>
    api.get<SizeChoice[]>(`/bought-servers/${encodeURIComponent(id)}/sizes`),
  /**
   * A new size: up is charged at once for the rest of the plan's month, down
   * credited on the next invoice. The machine is powered off while it changes.
   */
  setSize: (id: string, serverType: string) =>
    api.put<BoughtServerView>(
      `/bought-servers/${encodeURIComponent(id)}/size`,
      { serverType },
    ),
  /** Cancel a purchase still waiting for payment: nothing is charged. */
  cancel: (id: string) =>
    api.post<{ id: string }>(
      `/bought-servers/${encodeURIComponent(id)}/cancel`,
    ),
};
