import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { formatAmount } from '../cloud/billing/billing-notifications.service';
import { BillingConfig } from '../cloud/billing/billing.config';
import { LapseNotifications } from '../cloud/billing/lapse-notifications.service';
import { payingOrganizationOf } from '../cloud/billing/paying-organization';
import { STRIPE_API } from '../cloud/billing/stripe-api';
import type { StripeApi } from '../cloud/billing/stripe-api';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { MailService } from '../mail/mail.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { renderBoughtServerChangeRefundedEmail } from '../mail/templates';
import type { RefundedTo } from '../mail/templates';
import { boughtServer, boughtServerLine } from './bought-server.schema';
import type {
  BoughtServer,
  BoughtServerChangeTarget,
} from './bought-server.schema';
import { HETZNER_MACHINES } from './hetzner/hetzner-cloud.port';
import type {
  HetznerAction,
  HetznerAnswer,
  HetznerCloudPort,
  HetznerServer,
  HetznerVolume,
} from './hetzner/hetzner-cloud.port';
import {
  changeUpdateParams,
  itemsByPrice,
  restoreUpdateParams,
} from './purchase-lines';
import type { HeldLine } from './purchase-lines';
import { giveBackInFull } from './give-back';
import { storageCommand } from './storage';

/** How long a provider action is waited on before the step leaves it to a later resume. */
const ACTION_POLLS = 30;
const ACTION_POLL_MS = 2_000;

/** The idempotency key of a change's refund: one refund per change invoice, however often it is asked. */
export function changeRefundKeyOf(invoiceId: string): string {
  return `bought-server-change-refund-${invoiceId}`;
}

/** What a change asked for, as the refund email says it: "turn on backups for web-1". */
export function attemptedOf(
  target: BoughtServerChangeTarget,
  serverName: string,
): string {
  if (target.backups !== undefined) {
    return `turn ${target.backups ? 'on' : 'off'} backups for ${serverName}`;
  }
  if (target.storageGb !== undefined) {
    return `grow the extra storage of ${serverName} to ${target.storageGb} GB`;
  }
  return `change the size of ${serverName}`;
}

/**
 * **The shared rule for any change to a Bought Server** (spec #1387): the
 * Changing stage's steps, which `BoughtServerStages` runs from the stored
 * row, so a restart resumes them.
 *
 * - *Apply*: the machine is read first; when it already shows the change
 *   (the provider answered before a restart), the change is finished.
 *   Otherwise a try is claimed with a conditional write and the provider
 *   asked. A refusal leaves the next step to decide: once more, or give up.
 * - *Finish*: a change that costs less is credited on the next invoice now,
 *   after the provider made it; then the lines and the row are written, and
 *   the Server is Ready.
 * - *Give up*, after the second refusal: a paid change is refunded in full,
 *   its lines taken back off the subscription, the Server kept as it was,
 *   and the owners emailed. A change that costs less charged nothing, so
 *   nothing is given back.
 *
 * Each kind of change (backups, storage, size) adds what it asks the
 * provider for in {@link askProvider} and how the machine shows it in
 * {@link shows}. A storage change grows the Volume, then the filesystem on
 * the machine as it finishes; a size change powers the machine off while it
 * changes, and never leaves it off.
 */
@Injectable()
export class BoughtServerChangeSteps {
  private readonly logger = new Logger(BoughtServerChangeSteps.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(HETZNER_MACHINES) private readonly machines: HetznerCloudPort,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly notifications: LapseNotifications,
    private readonly mail: MailService,
    private readonly billingConfig: BillingConfig,
    private readonly remoteExec: RemoteExecService,
  ) {}

  /** One try at the change, or its finish when the machine already shows it. */
  async apply(row: BoughtServer): Promise<boolean> {
    const target = row.changeTarget!;
    const machine = await this.machine(row);
    if (!machine) return false;
    const volume = await this.volumeFor(row, target);
    if (volume === 'unread') return false;
    if (this.shows(machine, target, volume)) return this.finish(row);

    const [claimed] = await this.db
      .update(boughtServer)
      .set({ changeTries: row.changeTries + 1 })
      .where(
        and(
          eq(boughtServer.id, row.id),
          eq(boughtServer.stage, 'changing'),
          eq(boughtServer.changeTries, row.changeTries),
        ),
      )
      .returning({ id: boughtServer.id });
    // Someone else took this try.
    if (!claimed) return false;

    const answer = await this.settled(
      await this.askProvider(machine.id, target, volume),
    );
    if (answer === 'running') return false;
    if (!answer.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: change ${row.changeTries + 1} was refused: ${answer.code}: ${answer.message}`,
      );
    }
    // Refused: the next step decides, once more or give up. Made: the next
    // step reads the machine showing it, and finishes.
    return true;
  }

  /**
   * Refused every try. Unless the machine shows the change after all, a paid
   * change is refunded in full and its lines put back; the Server is Ready as
   * it was, and the owners are told.
   */
  async giveUp(row: BoughtServer): Promise<boolean> {
    const target = row.changeTarget!;
    const machine = await this.machine(row);
    if (!machine) return false;
    const volume = await this.volumeFor(row, target);
    if (volume === 'unread') return false;
    if (this.shows(machine, target, volume)) return this.finish(row);
    if (target.serverType !== undefined) {
      // A size change powers the machine off: it is never left off. Made
      // after all (only powering on was refused), it is finished.
      const on = await this.powerBackOn(row, machine);
      if (machine.serverType === target.serverType) {
        return on ? this.finish(row) : false;
      }
    }

    let refunded: { amount: string; to: RefundedTo } | null = null;
    if (target.charged) {
      refunded = await this.refund(row);
      await this.restoreLines(row, target);
    }

    const [kept] = await this.db
      .update(boughtServer)
      .set({
        stage: 'ready',
        changeTarget: null,
        changeTries: 0,
        changeInvoiceId: null,
      })
      .where(
        and(eq(boughtServer.id, row.id), eq(boughtServer.stage, 'changing')),
      )
      .returning({ id: boughtServer.id });
    this.logger.warn(
      `Bought Server ${row.id}: the provider refused every try to ${attemptedOf(target, row.name)}; kept as it was${target.charged ? ', payment refunded' : ''}`,
    );
    if (kept && target.charged) {
      await this.sendRefunded(row, target, refunded);
    }
    return false;
  }

  /**
   * Delete reached a Server while it was Changing: a paid change is given
   * back in full and its lines put back, as {@link giveUp} does, so the
   * lines leave at what was paid for them before it and nothing is paid
   * twice. No email: the customer deleted the Server. The change is then
   * dropped from the row, and the deletion goes on.
   */
  async abandonForDelete(row: BoughtServer): Promise<boolean> {
    const target = row.changeTarget!;
    if (target.charged && row.changeInvoiceId) {
      await this.refund(row);
      await this.restoreLines(row, target);
    }
    await this.db
      .update(boughtServer)
      .set({ changeTarget: null, changeTries: 0, changeInvoiceId: null })
      .where(
        and(eq(boughtServer.id, row.id), eq(boughtServer.stage, 'deleting')),
      );
    if (target.charged && row.changeInvoiceId) {
      this.logger.log(
        `Bought Server ${row.id}: deleted while changing; the change's payment was given back`,
      );
    }
    return true;
  }

  /**
   * The change is made on the machine: a cheaper one is credited now, and
   * the lines and the row are written in one go, back to Ready.
   */
  private async finish(row: BoughtServer): Promise<boolean> {
    const target = row.changeTarget!;
    if (target.storageGb !== undefined) {
      await this.growFilesystem(row, target.storageGb);
    }
    const held = await this.heldLines(row.id);
    const subscriptionId = await this.subscriptionIdOf(row.organizationId);
    if (!subscriptionId) {
      this.logger.error(
        `Bought Server ${row.id}: no subscription to write its changed lines on`,
      );
      return false;
    }
    let current = await this.stripe.retrieveSubscription(subscriptionId);
    if (!target.charged) {
      // Only what the subscription does not show yet, so a finish a restart
      // cut off never credits twice.
      const pending = target.lines.filter((line) =>
        line.stripePriceId === null
          ? current.items.data.some(
              (item) =>
                item.id ===
                held.find((h) => h.kind === line.kind)
                  ?.stripeSubscriptionItemId,
            )
          : !current.items.data.some(
              (item) => item.price.id === line.stripePriceId,
            ),
      );
      if (pending.length > 0) {
        current = await this.stripe.updateSubscription(
          subscriptionId,
          changeUpdateParams(held, pending, false),
        );
      }
    }
    const items = itemsByPrice(
      current,
      target.lines.flatMap((line) =>
        line.stripePriceId ? [line.stripePriceId] : [],
      ),
    );

    const now = new Date();
    await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(boughtServer)
        .set({
          ...(target.backups !== undefined ? { backups: target.backups } : {}),
          ...(target.storageGb !== undefined
            ? { storageGb: target.storageGb }
            : {}),
          ...(target.serverType !== undefined
            ? { serverType: target.serverType }
            : {}),
          stage: 'ready',
          changeTarget: null,
          changeTries: 0,
          changeInvoiceId: null,
        })
        .where(
          and(eq(boughtServer.id, row.id), eq(boughtServer.stage, 'changing')),
        )
        .returning({ id: boughtServer.id });
      if (!done) return;
      for (const line of target.lines) {
        if (line.stripePriceId === null) {
          await tx
            .delete(boughtServerLine)
            .where(
              and(
                eq(boughtServerLine.boughtServerId, row.id),
                eq(boughtServerLine.kind, line.kind),
              ),
            );
          continue;
        }
        const values = {
          stripePriceId: line.stripePriceId,
          stripeSubscriptionItemId: items.get(line.stripePriceId) ?? null,
          monthlyCents: line.monthlyCents ?? 0,
          soldAt: now,
          nextMonthlyCents: null,
          nextPriceFrom: null,
        };
        await tx
          .insert(boughtServerLine)
          .values({ boughtServerId: row.id, kind: line.kind, ...values })
          .onConflictDoUpdate({
            target: [boughtServerLine.boughtServerId, boughtServerLine.kind],
            set: values,
          });
      }
    });
    return false;
  }

  /** The change's payment, given back in full; the amount, formatted, for the email. */
  private async refund(
    row: BoughtServer,
  ): Promise<{ amount: string; to: RefundedTo } | null> {
    if (!row.changeInvoiceId) return null;
    const invoice = await this.stripe.retrieveInvoice(row.changeInvoiceId);
    // The card's part refunded, and the credit balance's credited back.
    const givenBack = await giveBackInFull(
      this.stripe,
      invoice,
      changeRefundKeyOf(row.changeInvoiceId),
      { boughtServerId: row.id, invoiceId: row.changeInvoiceId },
    );
    if (givenBack === null) {
      this.logger.error(
        `Bought Server ${row.id}: invoice ${row.changeInvoiceId} names no payment to give back; refund it by hand`,
      );
      return null;
    }
    return {
      amount: formatAmount(givenBack.cents, invoice.currency ?? 'usd'),
      to: givenBack.to,
    };
  }

  /** The subscription as it was before the change: its lines added taken off, its lines moved put back. */
  private async restoreLines(
    row: BoughtServer,
    target: BoughtServerChangeTarget,
  ): Promise<void> {
    const subscriptionId = await this.subscriptionIdOf(row.organizationId);
    if (!subscriptionId) return;
    const current = await this.stripe.retrieveSubscription(subscriptionId);
    const params = restoreUpdateParams(
      await this.heldLines(row.id),
      target.lines,
      current,
    );
    if ((params.items ?? []).length === 0) return;
    await this.stripe.updateSubscription(subscriptionId, params);
  }

  private async sendRefunded(
    row: BoughtServer,
    target: BoughtServerChangeTarget,
    refunded: { amount: string; to: RefundedTo } | null,
  ): Promise<void> {
    const { recipients } = await this.notifications.audienceOf(
      row.organizationId,
      ['owner'],
    );
    const serverUrl = `${this.billingConfig.siteUrl}/servers/${row.id}/settings`;
    for (const recipient of recipients) {
      try {
        await this.mail.send(
          recipient.email,
          await renderBoughtServerChangeRefundedEmail({
            userName: recipient.name,
            serverName: row.name,
            attempted: attemptedOf(target, row.name),
            amount: refunded?.amount ?? null,
            refundedTo: refunded?.to ?? 'card',
            serverUrl,
          }),
        );
      } catch (error) {
        this.logger.error(
          `Failed to send the change-refunded email to ${recipient.email}: ${(error as Error).message}`,
        );
      }
    }
  }

  /** What the provider is asked to make the change. */
  private askProvider(
    machineId: number,
    target: BoughtServerChangeTarget,
    volume: HetznerVolume | null,
  ): Promise<HetznerAnswer<HetznerAction>> {
    if (target.backups !== undefined) {
      return target.backups
        ? this.machines.enableBackup(machineId)
        : this.machines.disableBackup(machineId);
    }
    if (target.storageGb !== undefined && volume) {
      return this.machines.resizeVolume(volume.id, target.storageGb);
    }
    if (target.serverType !== undefined) {
      return this.changeSize(machineId, target.serverType);
    }
    return Promise.resolve({
      ok: false,
      code: 'unsupported_change',
      message: 'This change is not made yet',
    });
  }

  /** Whether the machine already shows the change. */
  private shows(
    machine: HetznerServer,
    target: BoughtServerChangeTarget,
    volume: HetznerVolume | null,
  ): boolean {
    if (target.backups !== undefined && machine.backups !== target.backups) {
      return false;
    }
    // A new size shows once the machine runs on it again.
    if (
      target.serverType !== undefined &&
      (machine.serverType !== target.serverType || machine.status !== 'running')
    ) {
      return false;
    }
    return (
      target.storageGb === undefined ||
      (volume !== null && volume.sizeGb >= target.storageGb)
    );
  }

  /**
   * The Volume a storage change grows, read fresh; null for any other
   * change, and `unread` when the provider would not say, so the step waits.
   */
  private async volumeFor(
    row: BoughtServer,
    target: BoughtServerChangeTarget,
  ): Promise<HetznerVolume | null | 'unread'> {
    if (target.storageGb === undefined) return null;
    if (row.providerVolumeId === null) return 'unread';
    const volume = await this.machines.getVolume(row.providerVolumeId);
    if (!volume.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: reading its Volume was refused: ${volume.code}: ${volume.message}`,
      );
      return 'unread';
    }
    return volume.value;
  }

  /**
   * The filesystem grown to fill the grown Volume, over the ordinary remote
   * exec path. The Volume is grown and paid for, so a machine that cannot be
   * reached does not hold the change back: the next Setup run grows it too.
   */
  private async growFilesystem(
    row: BoughtServer,
    sizeGb: number,
  ): Promise<void> {
    if (row.serverId === null || row.providerVolumeId === null) return;
    try {
      await this.remoteExec.execAsyncRemote(
        row.serverId,
        storageCommand(row.providerVolumeId, sizeGb),
      );
    } catch (error) {
      this.logger.warn(
        `Bought Server ${row.id}: growing its filesystem to ${sizeGb} GB failed, the next Setup run grows it: ${(error as Error).message}`,
      );
    }
  }

  /**
   * A new size (#1396): the machine powered off, its type changed with the
   * disk not grown (`upgrade_disk=false`, so it can always move back down),
   * and powered on again. A refused type change powers it back on at its old
   * size, and answers the refusal. Each step is skipped when the machine
   * already shows it, so a try a restart cut off picks up where it was.
   * An action still running past the wait is answered as it is, and left to
   * a later resume.
   */
  private async changeSize(
    machineId: number,
    serverType: string,
  ): Promise<HetznerAnswer<HetznerAction>> {
    const read = await this.machines.getServer(machineId);
    if (!read.ok) return read;
    if (read.value.serverType !== serverType) {
      if (read.value.status !== 'off') {
        const off = await this.machines.powerOff(machineId);
        const stopped = await this.settled(off);
        if (stopped === 'running') return off;
        if (!stopped.ok) return stopped;
      }
      const change = await this.machines.changeServerType(
        machineId,
        serverType,
      );
      const changed = await this.settled(change);
      if (changed === 'running') return change;
      if (!changed.ok) {
        const on = await this.settled(await this.machines.powerOn(machineId));
        if (on !== 'running' && !on.ok) {
          this.logger.warn(
            `Machine ${machineId}: powering it back on after a refused size change was refused: ${on.code}: ${on.message}`,
          );
        }
        return changed;
      }
    }
    return this.machines.powerOn(machineId);
  }

  /** A machine a size change left off, powered on again; whether it runs (or is starting). */
  private async powerBackOn(
    row: BoughtServer,
    machine: HetznerServer,
  ): Promise<boolean> {
    if (machine.status === 'running') return true;
    const on = await this.settled(await this.machines.powerOn(machine.id));
    if (on !== 'running' && !on.ok) {
      this.logger.error(
        `Bought Server ${row.id}: powering its machine back on was refused: ${on.code}: ${on.message}; power it on by hand`,
      );
      return false;
    }
    return true;
  }

  /**
   * The action waited on until it ends: its error is the provider's
   * refusal. One still running past the wait is left to a later resume,
   * which reads the machine.
   */
  private async settled(
    answer: HetznerAnswer<HetznerAction>,
  ): Promise<HetznerAnswer<HetznerAction> | 'running'> {
    let current = answer;
    for (
      let i = 0;
      current.ok && current.value.status === 'running' && i < ACTION_POLLS;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, ACTION_POLL_MS));
      current = await this.machines.getAction(current.value.id);
    }
    if (!current.ok) return current;
    if (current.value.status === 'running') return 'running';
    if (current.value.status === 'error') {
      return {
        ok: false,
        code: current.value.error?.code ?? 'action_failed',
        message: current.value.error?.message ?? 'The action failed',
      };
    }
    return current;
  }

  private async machine(row: BoughtServer): Promise<HetznerServer | null> {
    if (row.providerServerId === null) return null;
    const machine = await this.machines.getServer(row.providerServerId);
    if (!machine.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: reading its machine was refused: ${machine.code}: ${machine.message}`,
      );
      return null;
    }
    return machine.value;
  }

  private heldLines(id: string): Promise<HeldLine[]> {
    return this.db
      .select({
        kind: boughtServerLine.kind,
        stripePriceId: boughtServerLine.stripePriceId,
        stripeSubscriptionItemId: boughtServerLine.stripeSubscriptionItemId,
      })
      .from(boughtServerLine)
      .where(eq(boughtServerLine.boughtServerId, id));
  }

  private async subscriptionIdOf(
    organizationId: string,
  ): Promise<string | null> {
    const { subscription } = await payingOrganizationOf(
      this.db,
      organizationId,
    );
    return subscription?.stripeSubscriptionId ?? null;
  }
}
