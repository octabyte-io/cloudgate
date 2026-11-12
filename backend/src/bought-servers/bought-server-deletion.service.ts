import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { payingOrganizationOf } from '../cloud/billing/paying-organization';
import { STRIPE_API } from '../cloud/billing/stripe-api';
import type { StripeApi } from '../cloud/billing/stripe-api';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { DrizzleTx } from '../environments/config-name';
import { boughtServer, boughtServerLine } from './bought-server.schema';
import type { BoughtServer } from './bought-server.schema';
import {
  HETZNER_MACHINES,
  HETZNER_NOT_FOUND,
} from './hetzner/hetzner-cloud.port';
import type {
  HetznerAction,
  HetznerAnswer,
  HetznerCloudPort,
} from './hetzner/hetzner-cloud.port';
import { subscriptionIdOf } from '../cloud/billing/billing.plans';
import { removalUpdateParams, unusedTrialCents } from './purchase-lines';
import { idOf } from './purchase-payment';
import { onDelete } from './stages';

/** How Delete reached a Bought Server, as `beginDeleting` answers it. */
export interface DeleteBegun {
  id: string;
  /** True when this Delete moved it to Deleting, so its steps are to be taken now. */
  started: boolean;
}

/**
 * Delete, on the Bought Server behind a Server, inside the caller's
 * transaction: moved to **Deleting** with the moment, or left as it is when
 * it is Deleting or Deleted already. Refused at a stage Delete cannot start
 * from. `null` for a Server that is not a Bought Server.
 *
 * The row is locked for the write, so two Deletes, or a Delete and the
 * create's last write, never both decide. Nothing outside the database is
 * touched here: the steps run once the transaction holds
 * (`BoughtServerStages.advance`).
 */
export async function beginDeleting(
  tx: DrizzleTx,
  serverId: string,
  now: Date,
  /** False for the clock's automatic deletion: its lines leave uncredited. */
  credited = true,
): Promise<DeleteBegun | null> {
  const [row] = await tx
    .select({ id: boughtServer.id, stage: boughtServer.stage })
    .from(boughtServer)
    .where(eq(boughtServer.serverId, serverId))
    .limit(1)
    .for('update');
  if (!row) return null;
  const outcome = onDelete(row.stage);
  switch (outcome.kind) {
    case 'refuse':
      throw new ConflictException({
        code: 'BOUGHT_SERVER_NOT_DELETABLE',
        message: outcome.message,
      });
    case 'forget':
      return { id: row.id, started: false };
    case 'start':
      await tx
        .update(boughtServer)
        .set({ stage: 'deleting', deletingAt: now, deletionCredited: credited })
        .where(eq(boughtServer.id, row.id));
      return { id: row.id, started: true };
  }
}

/** How many times a provider action is read before the step is left for later. */
const ACTION_READS = 30;
const ACTION_READ_INTERVAL_MS = 2_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The two steps of **Deleting** (spec #1387, ADR-0071), each safe to take
 * again from what is stored, so a restart or the hourly resume finishes a
 * deletion it cut off:
 *
 * 1. `removeLines`: the lines leave the subscription with a proration
 *    credit on the next invoice, or with none for the clock's automatic
 *    deletion (`deletionCredited`). Only the items Stripe still carries are
 *    removed, and each line's item id is cleared once it is gone.
 * 2. `deleteMachine`: the machine with its backups, then its Volume and its
 *    Primary IPs, which the provider detaches from a deleted machine and
 *    keeps billing. Gone already (`not_found`) counts as done, since the
 *    provider ids are kept on the Deleted record and cannot mark progress.
 *    Then **Deleted**, with the moment.
 *
 * A refusal leaves the row Deleting and is logged; nothing here throws past
 * `BoughtServerStages.advance`.
 */
@Injectable()
export class BoughtServerDeletion {
  private readonly logger = new Logger(BoughtServerDeletion.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(HETZNER_MACHINES) private readonly machines: HetznerCloudPort,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
  ) {}

  /** How many of the row's lines the subscription still carries. */
  async linesOnSubscription(id: string): Promise<number> {
    const lines = await this.db
      .select({ id: boughtServerLine.id })
      .from(boughtServerLine)
      .where(
        and(
          eq(boughtServerLine.boughtServerId, id),
          isNotNull(boughtServerLine.stripeSubscriptionItemId),
        ),
      );
    return lines.length;
  }

  /** Step 1: the lines off the subscription, credited on the next invoice unless the clock deleted it. */
  async removeLines(row: BoughtServer): Promise<boolean> {
    return this.removeLinesFrom(
      row.id,
      row.organizationId,
      row.deletionCredited,
    );
  }

  /**
   * Step 1 against the subscription of `chargedVia`'s Paying Organization:
   * the row's own Organization for Delete, or the former payer after "Stop
   * paying for it" (#1398), whose subscription still carries the lines
   * once the link no longer leads there.
   */
  async removeLinesFrom(
    id: string,
    chargedVia: string,
    credited = true,
  ): Promise<boolean> {
    const lines = await this.db
      .select()
      .from(boughtServerLine)
      .where(
        and(
          eq(boughtServerLine.boughtServerId, id),
          isNotNull(boughtServerLine.stripeSubscriptionItemId),
        ),
      );
    if (lines.length === 0) return true;

    const { subscription: payer } = await payingOrganizationOf(
      this.db,
      chargedVia,
    );
    const subscriptionId = payer?.stripeSubscriptionId ?? null;
    // A subscription already ended carries nothing left to credit.
    let carried = new Set<string>();
    if (subscriptionId) {
      const current = await this.stripe.retrieveSubscription(subscriptionId);
      if (current.status !== 'canceled') {
        carried = new Set(current.items.data.map((item) => item.id));
      }
    }
    const items = lines
      .map((line) => line.stripeSubscriptionItemId!)
      .filter((item) => carried.has(item));
    if (subscriptionId && items.length > 0) {
      await this.stripe.updateSubscription(
        subscriptionId,
        removalUpdateParams(items, credited),
      );
    }
    await this.db
      .update(boughtServerLine)
      .set({ stripeSubscriptionItemId: null })
      .where(
        inArray(
          boughtServerLine.id,
          lines.map((line) => line.id),
        ),
      );
    return true;
  }

  /** Step 2: everything the provider bills for it, then Deleted. */
  async deleteMachine(row: BoughtServer): Promise<boolean> {
    await this.creditTrialShare(row);
    if (!(await this.deleteProviderResources(row))) return false;
    await this.db
      .update(boughtServer)
      .set({ stage: 'deleted', deletedAt: new Date() })
      .where(
        and(eq(boughtServer.id, row.id), eq(boughtServer.stage, 'deleting')),
      );
    this.logger.log(`Bought Server ${row.id} deleted`);
    return false;
  }

  /**
   * A Server bought during the Free trial was paid on its own invoice, to
   * the trial's end, and its lines are on no subscription to prorate: Delete
   * credits the unused part of that invoice to the customer's balance (a
   * credit, never cash, ADR-0071), as a proration would. Not for the clock's
   * automatic deletion, which credits nothing. One credit per Server,
   * however often the step is resumed (a fixed idempotency key).
   */
  private async creditTrialShare(row: BoughtServer): Promise<void> {
    if (!row.deletionCredited || !row.purchaseInvoiceId) return;
    const invoice = await this.stripe.retrieveInvoice(row.purchaseInvoiceId);
    // Charged on the subscription: the lines' removal prorated it.
    if (subscriptionIdOf(invoice) || invoice.status !== 'paid') return;
    const customer = idOf(invoice.customer);
    const cents = unusedTrialCents(invoice, Math.floor(Date.now() / 1000));
    if (!customer || cents <= 0) return;
    await this.stripe.createBalanceTransaction(
      customer,
      {
        amount: -cents,
        currency: invoice.currency ?? 'usd',
        description: `Unused part of the deleted Server ${row.name}, bought during the Free trial`,
        metadata: { boughtServerId: row.id },
      },
      `bought-server-trial-credit-${row.id}`,
    );
  }

  /**
   * Everything the provider bills for the row: the machine with its backups,
   * then its Volume and its Primary IPs. True once all are gone (or never
   * were); false when a refusal leaves some for a later resume. Also taken by
   * a purchase that failed at its Volume, whose machine was already made.
   */
  async deleteProviderResources(row: BoughtServer): Promise<boolean> {
    // A Server Delete reaches has its machine's id stored (Delete is
    // refused while Creating); one that failed at its create never had one.
    const machineIds =
      row.providerServerId !== null ? [row.providerServerId] : [];
    const primaryIpIds = [
      row.providerPrimaryIpv4Id,
      row.providerPrimaryIpv6Id,
    ].filter((id): id is number => id !== null);

    for (const machineId of machineIds) {
      const deleted = await this.machines.deleteServer(machineId);
      if (!this.done(row, `deleting machine ${machineId}`, deleted)) {
        return false;
      }
      // Its Volume and Primary IPs are detached only once the delete has run.
      if (deleted.ok && !(await this.settled(row, deleted.value))) return false;
    }
    if (row.providerVolumeId !== null) {
      const volume = await this.machines.deleteVolume(row.providerVolumeId);
      if (!this.done(row, `deleting Volume ${row.providerVolumeId}`, volume)) {
        return false;
      }
    }
    for (const ip of primaryIpIds) {
      const released = await this.machines.deletePrimaryIp(ip);
      if (!this.done(row, `deleting Primary IP ${ip}`, released)) return false;
    }
    return true;
  }

  /** Whether the provider's answer lets the step go on: done, or gone already. */
  private done(
    row: BoughtServer,
    what: string,
    answer: HetznerAnswer<unknown>,
  ): boolean {
    if (answer.ok || answer.code === HETZNER_NOT_FOUND) return true;
    this.logger.warn(
      `Bought Server ${row.id}: ${what} was refused and resumes later: ${answer.code}: ${answer.message}`,
    );
    return false;
  }

  /** Waits a short while for an action the provider started to finish. */
  private async settled(
    row: BoughtServer,
    action: HetznerAction,
  ): Promise<boolean> {
    let current = action;
    for (let read = 0; current.status === 'running'; read++) {
      if (read >= ACTION_READS) {
        this.logger.warn(
          `Bought Server ${row.id}: action ${action.id} is still running and resumes later`,
        );
        return false;
      }
      await sleep(ACTION_READ_INTERVAL_MS);
      const next = await this.machines.getAction(action.id);
      if (!next.ok) return this.done(row, `reading action ${action.id}`, next);
      current = next.value;
    }
    if (current.status === 'error') {
      this.logger.warn(
        `Bought Server ${row.id}: action ${action.id} failed and resumes later: ${current.error?.code}: ${current.error?.message}`,
      );
      return false;
    }
    return true;
  }
}
