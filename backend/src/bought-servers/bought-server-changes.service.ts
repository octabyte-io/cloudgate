import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import { payingOrganizationOf } from '../cloud/billing/paying-organization';
import { STRIPE_API } from '../cloud/billing/stripe-api';
import type { StripeApi } from '../cloud/billing/stripe-api';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { PermissionCtx } from '../rbac/permission.service';
import { BoughtServerStages } from './bought-server-stages.service';
import { boughtServer, boughtServerLine } from './bought-server.schema';
import type {
  BoughtServer,
  BoughtServerChangeLine,
  BoughtServerChangeTarget,
  BoughtServerLineKind,
  BoughtServerStage,
} from './bought-server.schema';
import { BoughtServersConfig } from './bought-servers.config';
import { BoughtServersService } from './bought-servers.service';
import type {
  BoughtServerCatalogue,
  CatalogueSize,
  SizeFamily,
} from './catalogue';
import { assertNoDeletionDate } from './deletion-date';
import { changeUpdateParams, linePriceParams } from './purchase-lines';
import { idOf, invoiceCharging, purchasePaymentOf } from './purchase-payment';
import { PAYMENT_RESUME_AFTER_MS, changeCostsMore } from './stages';
import { storageGrowRefusal, storageMonthlyUsd } from './storage';

/** A Bought Server as its Server's page shows it: its stage, what it holds, and its prices. */
export interface BoughtServerView {
  id: string;
  name: string;
  stage: BoughtServerStage;
  backups: boolean;
  storageGb: number | null;
  /** Each line it is charged on, US cents a month. */
  lines: Array<{ kind: BoughtServerLineKind; monthlyCents: number }>;
  /** Every line together, US cents a month. */
  monthlyCents: number;
  /**
   * What backups would cost a month if turned on now, in US cents, from the
   * catalogue as it is; null while they are on, or when its size is no
   * longer sold there.
   */
  backupsOfferCents: number | null;
  /** The change running now, while the stage is Changing. */
  change: { backups?: boolean; storageGb?: number; serverType?: string } | null;
}

/** One size the Server can move to, in its own Location, as its Settings show it. */
export interface SizeChoice {
  /** What a change names; the console describes the size by what it is instead. */
  id: string;
  family: SizeFamily;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  /** US cents a month, the Server line alone. */
  monthlyCents: number;
  /** What its backups cost a month, in US cents. */
  backupsMonthlyCents: number;
  /** Whether it can be bought there now. */
  available: boolean;
  /**
   * Its disk is smaller than the Server's own: a size change never shrinks
   * the disk, so the provider cannot move it there.
   */
  smallerDisk: boolean;
  /** The size it is now. */
  current: boolean;
}

/** What a change asks for: the machine's new state, and the lines it leaves. */
export interface ChangeRequest {
  /** Only the fields that change. */
  machine: Pick<
    BoughtServerChangeTarget,
    'backups' | 'storageGb' | 'serverType'
  >;
  /** Each line the change adds, moves to a new price (`monthlyCents`) or ends (`null`). */
  lines: Array<{ kind: BoughtServerLineKind; monthlyCents: number | null }>;
}

export const CHANGE_PAYMENT_REFUSED_CODE =
  'BOUGHT_SERVER_CHANGE_PAYMENT_REFUSED';
export const CHANGE_REFUSED_CODE = 'BOUGHT_SERVER_CHANGE_REFUSED';
export const NOT_CHANGEABLE_CODE = 'BOUGHT_SERVER_NOT_CHANGEABLE';
export const STORAGE_ONLY_GROWS_CODE = 'STORAGE_ONLY_GROWS';
export const NO_STORAGE_CODE = 'NO_EXTRA_STORAGE';

/** Said when a paid change was refused twice: refunded, and kept as it was. */
export const CHANGE_REFUNDED =
  'The change could not be made, so its payment was refunded in full and the Server is as it was';
/** Said when a change that costs less was refused twice: nothing was charged. */
export const CHANGE_NOT_MADE =
  'The change could not be made, so the Server is as it was. Try again later';

function changePaymentRefused(reason: string | null): HttpException {
  return new HttpException(
    {
      code: CHANGE_PAYMENT_REFUSED_CODE,
      message: `The payment was refused, so nothing was charged and nothing changed.${reason ? ` ${reason.replace(/\.?$/, '.')}` : ''}`,
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

/**
 * The sizes a Bought Server may move to: the catalogue's, on its own kind of
 * processor. A size no longer in the catalogue cannot tell, so nothing is
 * left out for it.
 */
/**
 * The Server's own disk in GB: the one it was bought with, which a size
 * change never grows. A row bought before it was stored reads it off its
 * size now, or null when that is no longer sold.
 */
function diskOf(
  catalogue: BoughtServerCatalogue,
  row: BoughtServer,
): number | null {
  return (
    row.diskGb ??
    catalogue.sizes.find((size) => size.id === row.serverType)?.diskGb ??
    null
  );
}

export const SIZE_DISK_TOO_SMALL_CODE = 'SIZE_DISK_TOO_SMALL';

function movableSizes(
  catalogue: BoughtServerCatalogue,
  row: BoughtServer,
): CatalogueSize[] {
  const own = catalogue.sizes.find((size) => size.id === row.serverType);
  if (!own) return catalogue.sizes;
  const arm = own.family === 'arm';
  return catalogue.sizes.filter((size) => (size.family === 'arm') === arm);
}

/** A card Stripe refused outright, as the SDK throws it. */
function isCardError(error: unknown): error is { message?: string } {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { type?: unknown }).type === 'StripeCardError'
  );
}

/**
 * **Changing a Bought Server** (ADR-0071, spec #1387's Changing): a Ready
 * Bought Server's backups on or off, its extra storage grown (#1395), and
 * its size beside them (#1396), all through {@link change}.
 *
 * A change that costs more is charged at once, for the rest of the plan's
 * month, before the provider is asked for anything; a change that costs
 * less is made first and credited on the next invoice. Either way the
 * Server shows **Changing** until it is done, and the steps run from the
 * stored row (`BoughtServerChangeSteps`): asked once more after a refusal,
 * then a paid change is refunded in full, the Server kept as it was, and
 * the owners emailed.
 *
 * Anything costlier is refused while the Organization is frozen or its
 * Bought Servers have a deletion date ("Pay the open invoice first"); a
 * change that costs less stays allowed, as Delete does (the route is
 * `@AllowedWhenFrozen('remove')`).
 */
@Injectable()
export class BoughtServerChanges {
  private readonly logger = new Logger(BoughtServerChanges.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly config: BoughtServersConfig,
    private readonly catalogue: BoughtServersService,
    private readonly frozen: FrozenOrganizations,
    private readonly stages: BoughtServerStages,
  ) {}

  /** The Bought Server behind a Server, as its page shows it. */
  async view(ctx: PermissionCtx, id: string): Promise<BoughtServerView> {
    this.assertPresent();
    const row = await this.ownRow(ctx, id);
    const lines = await this.db
      .select({
        kind: boughtServerLine.kind,
        monthlyCents: boughtServerLine.monthlyCents,
      })
      .from(boughtServerLine)
      .where(eq(boughtServerLine.boughtServerId, id));
    const target = row.changeTarget;
    return {
      id: row.id,
      name: row.name,
      stage: row.stage,
      backups: row.backups,
      storageGb: row.storageGb,
      lines,
      monthlyCents: lines.reduce((sum, line) => sum + line.monthlyCents, 0),
      backupsOfferCents: row.backups ? null : await this.backupsCents(row),
      change: target
        ? {
            ...(target.backups !== undefined
              ? { backups: target.backups }
              : {}),
            ...(target.storageGb !== undefined
              ? { storageGb: target.storageGb }
              : {}),
            ...(target.serverType !== undefined
              ? { serverType: target.serverType }
              : {}),
          }
        : null,
    };
  }

  /**
   * Backups on (charged at once for the rest of the plan's month, at the
   * catalogue's price now) or off (every backup deleted at once, and a
   * credit on the next invoice).
   */
  async setBackups(
    ctx: PermissionCtx,
    id: string,
    enabled: boolean,
  ): Promise<BoughtServerView> {
    this.assertPresent();
    const row = await this.ownRow(ctx, id);
    if (row.backups === enabled && row.stage === 'ready') {
      return this.view(ctx, id);
    }
    let monthlyCents: number | null = null;
    if (enabled) {
      monthlyCents = await this.backupsCents(row);
      if (monthlyCents === null) {
        throw new ConflictException({
          code: 'SIZE_NOT_SOLD',
          message:
            "Backups can't be turned on: this size is no longer sold here",
        });
      }
    }
    await this.change(ctx, row, {
      machine: { backups: enabled },
      lines: [{ kind: 'backups', monthlyCents }],
    });
    return this.view(ctx, id);
  }

  /**
   * Extra storage grown to `sizeGb`: charged at once for the rest of the
   * plan's month at the catalogue's price now, then the Volume and the
   * filesystem on the machine are grown. A size no bigger than it is now is
   * refused: storage never shrinks.
   */
  async growStorage(
    ctx: PermissionCtx,
    id: string,
    sizeGb: number,
  ): Promise<BoughtServerView> {
    this.assertPresent();
    const row = await this.ownRow(ctx, id);
    if (row.storageGb === sizeGb && row.stage === 'ready') {
      return this.view(ctx, id);
    }
    const { storage } = await this.catalogue.catalogue();
    const refusal = storageGrowRefusal(row.storageGb, sizeGb, storage);
    if (refusal) {
      throw new ConflictException({
        code:
          row.storageGb === null ? NO_STORAGE_CODE : STORAGE_ONLY_GROWS_CODE,
        message: refusal,
      });
    }
    await this.change(ctx, row, {
      machine: { storageGb: sizeGb },
      lines: [
        {
          kind: 'storage',
          monthlyCents: storageMonthlyUsd(storage, sizeGb) * 100,
        },
      ],
    });
    return this.view(ctx, id);
  }

  /**
   * Every size the Server can move to: those sold in its Location, on the
   * same kind of processor (the provider moves a machine between Arm and
   * x86 never). Its own size is among them while it is still sold there.
   */
  async sizes(ctx: PermissionCtx, id: string): Promise<SizeChoice[]> {
    this.assertPresent();
    const row = await this.ownRow(ctx, id);
    const catalogue = await this.catalogue.catalogue();
    const disk = diskOf(catalogue, row);
    return movableSizes(catalogue, row).flatMap((size) => {
      const offer = size.offers.find((o) => o.locationId === row.location);
      return offer
        ? [
            {
              id: size.id,
              family: size.family,
              vcpus: size.vcpus,
              memoryGb: size.memoryGb,
              diskGb: size.diskGb,
              monthlyCents: offer.monthly * 100,
              backupsMonthlyCents: offer.backupsMonthly * 100,
              available: offer.available,
              smallerDisk: disk !== null && size.diskGb < disk,
              current: size.id === row.serverType,
            },
          ]
        : [];
    });
  }

  /**
   * A new size, up or down (#1396). The machine is powered off while it
   * changes, and its disk is never grown, so it can always move back down.
   * Up is charged at once for the rest of the plan's month; down is
   * credited on the next invoice. Backups follow the size: their price is
   * the new size's.
   */
  async setSize(
    ctx: PermissionCtx,
    id: string,
    serverType: string,
  ): Promise<BoughtServerView> {
    this.assertPresent();
    const row = await this.ownRow(ctx, id);
    if (row.serverType === serverType && row.stage === 'ready') {
      return this.view(ctx, id);
    }
    const catalogue = await this.catalogue.catalogue();
    const size = movableSizes(catalogue, row).find(
      (one) => one.id === serverType,
    );
    const offer = size?.offers.find(
      (entry) => entry.locationId === row.location,
    );
    if (!offer) {
      throw new ConflictException({
        code: 'SIZE_NOT_SOLD',
        message: "This Server can't move to that size: it isn't sold here",
      });
    }
    const disk = diskOf(catalogue, row);
    if (disk !== null && size!.diskGb < disk) {
      throw new ConflictException({
        code: SIZE_DISK_TOO_SMALL_CODE,
        message: `This Server can't move to that size: its disk is ${size!.diskGb} GB, smaller than the Server's ${disk} GB`,
      });
    }
    if (!offer.available) {
      const city = catalogue.locations.find(
        (location) => location.id === row.location,
      )?.city;
      throw new ConflictException({
        code: 'SIZE_UNAVAILABLE',
        message: `That size is unavailable in ${city ?? 'this location'} right now. Try again later`,
      });
    }
    await this.change(ctx, row, {
      machine: { serverType },
      lines: [
        { kind: 'server', monthlyCents: offer.monthly * 100 },
        ...(row.backups
          ? [
              {
                kind: 'backups' as const,
                monthlyCents: offer.backupsMonthly * 100,
              },
            ]
          : []),
      ],
    });
    return this.view(ctx, id);
  }

  /**
   * **The shared rule for any change.** Refused unless the Server is Ready.
   * A change that costs more is refused while the Organization is frozen or
   * its plan is not paid up, then charged before the provider is asked; one
   * that costs less is credited once the provider made it. A change the
   * provider refused twice answers 409, after the refund.
   */
  async change(
    ctx: PermissionCtx,
    row: BoughtServer,
    request: ChangeRequest,
  ): Promise<void> {
    this.assertChangeable(row);
    const held = await this.db
      .select()
      .from(boughtServerLine)
      .where(eq(boughtServerLine.boughtServerId, row.id));
    const charged = changeCostsMore(held, request.lines);
    const subscriptionId = await this.subscriptionToCharge(
      row.organizationId,
      charged,
    );

    const lines: BoughtServerChangeLine[] = [];
    for (const line of request.lines) {
      if (line.monthlyCents === null) {
        lines.push({
          kind: line.kind,
          stripePriceId: null,
          monthlyCents: null,
        });
        continue;
      }
      const price = await this.stripe.createPrice(
        linePriceParams(row.id, {
          kind: line.kind,
          monthlyCents: line.monthlyCents,
        }),
      );
      lines.push({
        kind: line.kind,
        stripePriceId: price.id,
        monthlyCents: line.monthlyCents,
      });
    }
    const target: BoughtServerChangeTarget = {
      ...request.machine,
      charged,
      lines,
      startedAt: new Date().toISOString(),
    };

    // Claimed once: a second press, or a change already running, is refused.
    const [claimed] = await this.db
      .update(boughtServer)
      .set({
        stage: 'changing',
        changeTarget: target,
        changeTries: 0,
        changeInvoiceId: null,
      })
      .where(and(eq(boughtServer.id, row.id), eq(boughtServer.stage, 'ready')))
      .returning({ id: boughtServer.id });
    if (!claimed) throw this.notChangeable('changing');

    if (charged) {
      await this.charge(row, subscriptionId!, held, lines);
    }

    await this.stages.advance(row.id);

    const after = await this.findRow(row.id);
    if (after?.stage === 'ready' && !this.holds(after, target)) {
      throw new ConflictException({
        code: CHANGE_REFUSED_CODE,
        message: charged ? CHANGE_REFUNDED : CHANGE_NOT_MADE,
      });
    }
  }

  /**
   * The charge, paid at once or not at all: a payment that does not go
   * through (refused, or waiting on the bank) is voided, and the Server is
   * Ready again as it was, with nothing charged. Only a paid invoice is
   * stored, and only then may the provider be asked.
   */
  private async charge(
    row: BoughtServer,
    subscriptionId: string,
    held: Array<{
      kind: BoughtServerLineKind;
      stripePriceId: string;
      stripeSubscriptionItemId: string | null;
    }>,
    lines: BoughtServerChangeLine[],
  ): Promise<void> {
    let updated: Stripe.Subscription;
    try {
      updated = await this.stripe.updateSubscription(
        subscriptionId,
        changeUpdateParams(held, lines, true),
      );
    } catch (error) {
      // An answer lost after the charge: what Stripe made of it decides.
      if (!isCardError(error) && (await this.settleLostCharge(row.id))) {
        return;
      }
      await this.release(row.id);
      if (isCardError(error)) {
        throw changePaymentRefused(error.message ?? null);
      }
      throw error;
    }
    const invoiceId = idOf(updated.latest_invoice);
    if (updated.pending_update) {
      let reason: string | null = null;
      if (invoiceId) {
        const invoice = await this.stripe.retrieveInvoice(invoiceId);
        const payment = purchasePaymentOf(invoice);
        if (payment.kind === 'refused') reason = payment.message;
        try {
          await this.stripe.voidInvoice(invoiceId);
        } catch (error) {
          this.logger.warn(
            `Could not void invoice ${invoiceId} of Bought Server ${row.id}'s change: ${String(error)}`,
          );
        }
      }
      await this.release(row.id);
      throw changePaymentRefused(
        reason ??
          'Your bank asked to confirm the payment. Try again, or use another card',
      );
    }
    await this.db
      .update(boughtServer)
      .set({ changeInvoiceId: invoiceId })
      .where(
        and(eq(boughtServer.id, row.id), eq(boughtServer.stage, 'changing')),
      );
  }

  /**
   * The hourly job: a costlier change still Changing with no payment stored,
   * well after it started, was cut off between the charge and the write (a
   * restart). Stripe decides: a paid charge is stored and the change carries
   * on; otherwise it is back to Ready with nothing changed.
   */
  async resumeCharge(id: string, now: Date = new Date()): Promise<void> {
    const row = await this.findRow(id);
    const target = row?.changeTarget;
    if (!row || row.stage !== 'changing' || !target?.charged) return;
    if (row.changeInvoiceId) return;
    const startedAt = target.startedAt ? Date.parse(target.startedAt) : 0;
    if (now.getTime() - startedAt < PAYMENT_RESUME_AFTER_MS) return;
    if (await this.settleLostCharge(id)) {
      await this.stages.advance(id);
      return;
    }
    await this.release(id);
    this.logger.log(
      `Bought Server ${id}: its change was cut off before it was paid, and is Ready again as it was`,
    );
  }

  /**
   * A charge whose answer never came: its invoice found among the paying
   * customer's by the change's new prices. Paid, it is stored and true is
   * answered, so the change goes on; still open, it is voided, so it can
   * never be paid later for a change that was dropped.
   */
  private async settleLostCharge(id: string): Promise<boolean> {
    const row = await this.findRow(id);
    if (!row?.changeTarget) return false;
    const { subscription: paying } = await payingOrganizationOf(
      this.db,
      row.organizationId,
    );
    if (!paying?.stripeCustomerId) return false;
    const prices = row.changeTarget.lines.flatMap((line) =>
      line.stripePriceId ? [line.stripePriceId] : [],
    );
    let found: Stripe.Invoice | null;
    try {
      found = invoiceCharging(
        (await this.stripe.listInvoices(paying.stripeCustomerId)) ?? [],
        '',
        prices,
      );
    } catch (error) {
      this.logger.warn(
        `Bought Server ${id}: looking for its change's invoice failed: ${String(error)}`,
      );
      return false;
    }
    if (!found?.id) return false;
    const invoice = await this.stripe.retrieveInvoice(found.id);
    if (purchasePaymentOf(invoice).kind === 'paid') {
      await this.db
        .update(boughtServer)
        .set({ changeInvoiceId: found.id })
        .where(
          and(eq(boughtServer.id, id), eq(boughtServer.stage, 'changing')),
        );
      return true;
    }
    if (invoice.status === 'open') {
      try {
        await this.stripe.voidInvoice(found.id);
      } catch (error) {
        this.logger.warn(
          `Could not void invoice ${found.id} of Bought Server ${id}'s change: ${String(error)}`,
        );
      }
    }
    return false;
  }

  /** Back to Ready with nothing changed: the change was never paid. */
  private async release(id: string): Promise<void> {
    await this.db
      .update(boughtServer)
      .set({
        stage: 'ready',
        changeTarget: null,
        changeTries: 0,
        changeInvoiceId: null,
      })
      .where(and(eq(boughtServer.id, id), eq(boughtServer.stage, 'changing')));
  }

  /** Whether the row holds what the change asked for. */
  private holds(row: BoughtServer, target: BoughtServerChangeTarget): boolean {
    return (
      (target.backups === undefined || row.backups === target.backups) &&
      (target.storageGb === undefined || row.storageGb === target.storageGb) &&
      (target.serverType === undefined || row.serverType === target.serverType)
    );
  }

  /**
   * The subscription a costlier change is charged on, refused while the
   * Organization is frozen, while its Bought Servers have a deletion date
   * (#1397), or while the plan is not paid up. A change that costs less is
   * never refused here: it only lowers what is owed.
   */
  private async subscriptionToCharge(
    organizationId: string,
    charged: boolean,
  ): Promise<string | null> {
    if (!charged) return null;
    await this.frozen.assertNotFrozen(organizationId);
    await assertNoDeletionDate(this.db, organizationId);
    const { subscription: row } = await payingOrganizationOf(
      this.db,
      organizationId,
    );
    if (!row?.stripeSubscriptionId) {
      throw new ConflictException({
        code: 'PLAN_REQUIRED',
        message: 'Choose a plan under Settings > Billing to change this Server',
      });
    }
    const current = await this.stripe.retrieveSubscription(
      row.stripeSubscriptionId,
    );
    if (current.status !== 'active') {
      throw new ConflictException({
        code: 'PAY_OPEN_INVOICE_FIRST',
        message: 'Pay the open invoice first',
      });
    }
    return row.stripeSubscriptionId;
  }

  /** What backups cost a month now for this size there, in cents; null when it is not sold there any more. */
  private async backupsCents(row: BoughtServer): Promise<number | null> {
    try {
      const catalogue = await this.catalogue.catalogue();
      const offer = catalogue.sizes
        .find((size) => size.id === row.serverType)
        ?.offers.find((entry) => entry.locationId === row.location);
      return offer ? offer.backupsMonthly * 100 : null;
    } catch (error) {
      this.logger.warn(
        `Could not price backups for Bought Server ${row.id}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private assertChangeable(row: BoughtServer): void {
    if (row.stage !== 'ready' || row.serverId === null) {
      throw this.notChangeable(row.stage);
    }
    if (row.poweredOffAt) {
      throw new ConflictException({
        code: NOT_CHANGEABLE_CODE,
        message:
          "This Server was powered off by Cloudgate, so it can't be changed",
      });
    }
  }

  private notChangeable(stage: BoughtServerStage): ConflictException {
    return new ConflictException({
      code: NOT_CHANGEABLE_CODE,
      message:
        stage === 'changing'
          ? 'A change is already running on this Server. Wait for it to finish'
          : "This Server can't be changed until it is Ready",
    });
  }

  /** A bare 404 where the feature is absent; a Bought Server can be read where buying is off. */
  private assertPresent(): void {
    if (this.config.offer === 'absent') throw new NotFoundException();
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
}
