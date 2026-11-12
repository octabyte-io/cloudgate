import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { customAlphabet } from 'nanoid';
import { organization } from '../organizations/organizations.schema';
import { server } from '../servers/server.schema';
import { sshKey } from '../ssh-keys/ssh-key.schema';

/**
 * **Bought Servers** at rest (ADR-0071, spec #1387's Storage): one
 * `bought_server` row per Bought Server, and one `bought_server_line` row
 * per Stripe line it is charged on.
 *
 * The row exists from the moment Buy is pressed, before any machine and any
 * `server` row: the Servers list and the Server count read it from then on
 * (`paying-organization.ts`). The `server` row is written only when the
 * provider's create has answered with the machine's id and address, in one
 * write, so `server.ip_address` stays required. That row takes this row's id
 * as its own `server_id`, so the Server keeps one id from Buy onward, in the
 * console's links and in the labels on the provider's resources.
 *
 * The stage decides what happens next (`stages.ts`, pure); every column the
 * stages read is here, so a restart resumes from what is stored.
 */

/** The stages of a Bought Server (spec #1387, from #1383). */
export const BOUGHT_SERVER_STAGES = [
  'waiting_for_payment',
  'creating',
  'setting_up',
  'ready',
  'changing',
  'deleting',
  'deleted',
  'failed',
] as const;

export const boughtServerStage = pgEnum(
  'bought_server_stage',
  BOUGHT_SERVER_STAGES,
);

/** What one Stripe line charges for. */
export const BOUGHT_SERVER_LINE_KINDS = [
  'server',
  'backups',
  'storage',
] as const;

export const boughtServerLineKind = pgEnum(
  'bought_server_line_kind',
  BOUGHT_SERVER_LINE_KINDS,
);

/**
 * A Bought Server's id, which its `server` row takes too: lowercase letters
 * and digits only, because it is written into the provider's labels (which
 * must start and end with one) and into a hostname for reverse DNS. 16 of 36
 * characters is about 82 bits, as unguessable as the 21-character nanoid.
 */
export const boughtServerId = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyz',
  16,
);

/**
 * One line as a change leaves it: its kind with the price it is sold at
 * from then on, or `stripePriceId: null` where the change removes it.
 */
export interface BoughtServerChangeLine {
  kind: BoughtServerLineKind;
  stripePriceId: string | null;
  monthlyCents: number | null;
}

/**
 * The change in progress, as `changeTarget` holds it (#1394–#1396): what the
 * machine becomes (only the fields that change), whether it was charged at
 * once or is credited, and the lines it leaves. Lines of other kinds stay
 * as they are.
 */
export interface BoughtServerChangeTarget {
  serverType?: string;
  backups?: boolean;
  storageGb?: number;
  /** Costs more, so paid before the provider is asked; otherwise credited once it is done. */
  charged: boolean;
  lines: BoughtServerChangeLine[];
  /**
   * When the change was claimed, ISO: the hourly job reads a costlier change
   * with no payment stored only well after it, never racing the press.
   */
  startedAt?: string;
}

export const boughtServer = pgTable('bought_server', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => boughtServerId()),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  /**
   * The `server` row, once one is written: null while it waits for payment
   * and while it is being created, and again once Delete removed it (the
   * Deleted record outlives its Server). Always this row's own id when set.
   */
  serverId: text('server_id')
    .unique()
    .references(() => server.serverId, { onDelete: 'set null' }),
  /** The Server's name, as the customer gave it at Buy. */
  name: text('name').notNull(),
  stage: boughtServerStage('stage').notNull().default('waiting_for_payment'),
  /** The provider's size code, `cpx22`. Never shown to a customer. */
  serverType: text('server_type').notNull(),
  /** The provider's Location code, `fsn1`. */
  location: text('location').notNull(),
  backups: boolean('backups').notNull().default(false),
  /** Extra storage in GB, null for none. */
  storageGb: integer('storage_gb'),
  /**
   * The machine's own disk in GB: the size bought with's. A size change never
   * grows it (`upgrade_disk=false`), so a size whose disk is smaller cannot
   * be moved to. Null on a row bought before it was stored: its disk is then
   * read off its size.
   */
  diskGb: integer('disk_gb'),
  /**
   * The key made for this Server, whose public half is the only credential
   * the provider is given (ADR-0071). Made when the machine is created, not
   * at Buy, so a payment that never comes leaves no key behind.
   */
  sshKeyId: text('ssh_key_id').references(() => sshKey.sshKeyId, {
    onDelete: 'set null',
  }),
  /**
   * The provider's ids. The machine's is stored before anything else once
   * the create answers, so a restart never makes a second one; the Volume
   * and the Primary IPs are stored with it, since Delete must delete them
   * too or the provider keeps billing them.
   */
  providerServerId: bigint('provider_server_id', { mode: 'number' }),
  providerVolumeId: bigint('provider_volume_id', { mode: 'number' }),
  providerPrimaryIpv4Id: bigint('provider_primary_ipv4_id', {
    mode: 'number',
  }),
  providerPrimaryIpv6Id: bigint('provider_primary_ipv6_id', {
    mode: 'number',
  }),
  /** How many times the create was asked for: after the second refusal, a refund. */
  createTries: integer('create_tries').notNull().default(0),
  /**
   * How many times the extra storage's Volume was asked for: after the
   * second refusal, a refund, as for the machine.
   */
  storageTries: integer('storage_tries').notNull().default(0),
  /**
   * How many times the backend started the first Setup run by itself: once
   * the machine answers, and once more if a restart cut it off (the
   * amendment to ADR-0058). Claimed before the run starts, so a restart
   * reads a run that was going as started.
   */
  setupStarts: integer('setup_starts').notNull().default(0),
  /**
   * The purchase's payment: the Stripe invoice the Buy made, and when it
   * was seen paid. The provider is asked for nothing until it is.
   */
  purchaseInvoiceId: text('purchase_invoice_id'),
  purchasePaidAt: timestamp('purchase_paid_at', { precision: 3 }),
  /**
   * The Stripe Checkout a purchase by an Organization with no plan goes
   * through first (#1392): it starts the Starter plan, or its Free trial,
   * and the Server is charged once it completes. Kept so *Finish paying*
   * can send the customer back to it and *Cancel* can expire it.
   */
  purchaseCheckoutSessionId: text('purchase_checkout_session_id'),
  /**
   * The paid change in progress (backups, storage or size): its target, how
   * many times the provider was asked, and the invoice that paid for it.
   * Null while none is.
   */
  changeTarget: jsonb('change_target').$type<BoughtServerChangeTarget>(),
  changeTries: integer('change_tries').notNull().default(0),
  changeInvoiceId: text('change_invoice_id'),
  /**
   * Who ticked the terms box at Buy, and when: the proof of acceptance
   * (ADR-0071). The user's id, deliberately not a foreign key: a key would
   * either block deleting the account or wipe the proof with it, and the
   * proof must outlive the account.
   */
  termsAcceptedBy: text('terms_accepted_by').notNull(),
  termsAcceptedAt: timestamp('terms_accepted_at', { precision: 3 }).notNull(),
  /** An Operator's power-off for abuse, and the reason the customer is shown (#1401). */
  poweredOffAt: timestamp('powered_off_at', { precision: 3 }),
  poweredOffReason: text('powered_off_reason'),
  /**
   * When Delete moved it to Deleting, and when the provider's last resource
   * of it was gone (Deleted). The Deleted row keeps these and the provider's
   * ids above: the record of what was bought and when it went.
   */
  deletingAt: timestamp('deleting_at', { precision: 3 }),
  /**
   * Whether its lines leave the subscription with a credit for the unused
   * part of the month: a Delete the customer pressed does; the clock's
   * automatic deletion (a failed payment, a suspension, a lapse) does not.
   */
  deletionCredited: boolean('deletion_credited').notNull().default(true),
  deletedAt: timestamp('deleted_at', { precision: 3 }),
  createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
});

/**
 * One Stripe line of a Bought Server: the Server itself, its backups or its
 * extra storage. Each is sold at its own price, kept until a reprice gives
 * it a next price from a date (#1400).
 */
export const boughtServerLine = pgTable(
  'bought_server_line',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => boughtServerId()),
    boughtServerId: text('bought_server_id')
      .notNull()
      .references(() => boughtServer.id, { onDelete: 'cascade' }),
    kind: boughtServerLineKind('kind').notNull(),
    /** The price made for this line under its kind's fixed Stripe Product. */
    stripePriceId: text('stripe_price_id').notNull(),
    /**
     * The subscription item carrying the line, once the subscription holds
     * it. Empty while it waits for payment, and while it sits on a separate
     * Free-trial invoice (the amendment to ADR-0054).
     */
    stripeSubscriptionItemId: text('stripe_subscription_item_id'),
    /** US cents a month. */
    monthlyCents: integer('monthly_cents').notNull(),
    soldAt: timestamp('sold_at', { precision: 3 }).notNull().defaultNow(),
    /** A reprice's next price, and the day it starts (#1400). */
    nextMonthlyCents: integer('next_monthly_cents'),
    nextPriceFrom: timestamp('next_price_from', { precision: 3 }),
  },
  (table) => [unique().on(table.boughtServerId, table.kind)],
);

export const boughtServerRelations = relations(
  boughtServer,
  ({ one, many }) => ({
    organization: one(organization, {
      fields: [boughtServer.organizationId],
      references: [organization.id],
    }),
    server: one(server, {
      fields: [boughtServer.serverId],
      references: [server.serverId],
    }),
    lines: many(boughtServerLine),
  }),
);

export const boughtServerLineRelations = relations(
  boughtServerLine,
  ({ one }) => ({
    boughtServer: one(boughtServer, {
      fields: [boughtServerLine.boughtServerId],
      references: [boughtServer.id],
    }),
  }),
);

export type BoughtServer = typeof boughtServer.$inferSelect;
export type BoughtServerLine = typeof boughtServerLine.$inferSelect;
export type BoughtServerStage = (typeof BOUGHT_SERVER_STAGES)[number];
export type BoughtServerLineKind = (typeof BOUGHT_SERVER_LINE_KINDS)[number];
