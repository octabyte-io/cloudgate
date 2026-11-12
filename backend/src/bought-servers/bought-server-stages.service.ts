import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import { subscriptionIdOf } from '../cloud/billing/billing.plans';
import { STRIPE_API } from '../cloud/billing/stripe-api';
import type { StripeApi } from '../cloud/billing/stripe-api';
import { LapseNotifications } from '../cloud/billing/lapse-notifications.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { PermissionService } from '../rbac/permission.service';
import { server } from '../servers/server.schema';
import { ServerSetupRuns } from '../servers/server-setup-runs';
import type { SetupRunOutcome } from '../servers/server-setup-runs';
import { sshKey } from '../ssh-keys/ssh-key.schema';
import { SshKeysService } from '../ssh-keys/ssh-keys.service';
import { BoughtServerNotifications } from './bought-server-notifications.service';
import { BoughtServerChangeSteps } from './bought-server-change-steps.service';
import { BoughtServerDeletion } from './bought-server-deletion.service';
import { BoughtServersConfig } from './bought-servers.config';
import { boughtServer, boughtServerLine } from './bought-server.schema';
import type { BoughtServer } from './bought-server.schema';
import { HETZNER_MACHINES } from './hetzner/hetzner-cloud.port';
import type {
  HetznerAction,
  HetznerCloudPort,
  HetznerServer,
} from './hetzner/hetzner-cloud.port';
import { itemsByPrice } from './purchase-lines';
import { invoicePriceIds } from './purchase-payment';
import { giveBackInFull, serverShareOf } from './give-back';
import type { GivenBack } from './give-back';
import { BillingConfig } from '../cloud/billing/billing.config';
import { MAX_CREATE_TRIES, nextStep } from './stages';

/** The image every Bought Server starts from; the ordinary Server setup does the rest. */
export const BOUGHT_SERVER_IMAGE = 'ubuntu-24.04';

/** The labels on every provider resource of a Bought Server (ADR-0071). */
export const ORGANIZATION_LABEL = 'cloudgate-organization';
export const SERVER_LABEL = 'cloudgate-server';

/** The provider's labels naming the Organization and the Server. */
export function labelsOf(
  row: Pick<BoughtServer, 'id' | 'organizationId'>,
): Record<string, string> {
  return { [ORGANIZATION_LABEL]: row.organizationId, [SERVER_LABEL]: row.id };
}

/**
 * The machine's name in the provider's account: unique there, and a
 * hostname, which the id is made to be (`boughtServerId`).
 */
export function machineNameOf(id: string): string {
  return `cloudgate-${id}`;
}

/**
 * The reverse-DNS name of a Bought Server's address: `<id>.<domain>`. The id
 * is the short one the Server has everywhere (16 characters), so the name is
 * stable and says nothing about the customer or the provider.
 */
export function reverseDnsNameOf(id: string, domain: string): string {
  return `${id}.${domain.replace(/^\.+|\.+$/g, '')}`;
}

/** The idempotency key of a purchase's refund: one refund per Bought Server, however often it is asked. */
export function refundKeyOf(id: string): string {
  return `bought-server-refund-${id}`;
}
/** What a first Setup run cut off by a restart each time it was started is stored as. */
export const SETUP_CUT_OFF_MESSAGE =
  'The first setup run was cut off before it ended. Run setup to try again.';

/** How long a provider action is waited on before the step leaves it to a later resume. */
const ACTION_POLLS = 30;
const ACTION_POLL_MS = 2_000;

/** How many steps one {@link BoughtServerStages.advance} takes at most: a guard, not a limit reached. */
const MAX_STEPS = 8;

/**
 * Carries a Bought Server through its stages from what is stored: each
 * step is decided by `nextStep` (`stages.ts`, pure) over the row read
 * fresh, so the same call resumes it after a restart, and a step claims its
 * work with a conditional write so two callers never both make a machine.
 *
 * Never reaches the provider before the purchase's payment is stored: the
 * stages decide that, and only `markPaid` in `BoughtServerPurchases` stores it.
 *
 * **Starts the first Setup run itself** once the `server` row is written:
 * Buy was the confirmed press for it (the amendment to ADR-0058). It is the
 * only Setup run that starts without a press, and it starts at most
 * `MAX_SETUP_STARTS` times (`stages.ts`): once, and once more when a backend restart
 * cut it off, which the boot resumes ({@link resumeSetups}). Its end moves
 * the stage to Ready, whether it finished or failed: a failed run leaves the
 * Server with the ordinary Setup card, Setup failed and *Run setup*, emails
 * the Operators, and is not refunded.
 */
@Injectable()
export class BoughtServerStages implements OnApplicationBootstrap {
  private readonly logger = new Logger(BoughtServerStages.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(HETZNER_MACHINES) private readonly machines: HetznerCloudPort,
    private readonly config: BoughtServersConfig,
    private readonly sshKeys: SshKeysService,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly notifications: BoughtServerNotifications,
    private readonly changes: BoughtServerChangeSteps,
    // Forward: ServerSetupRuns provisions through ServersService, which reaches
    // back here; whichever file loads first sees the other's class undefined.
    @Inject(forwardRef(() => ServerSetupRuns))
    private readonly setupRuns: ServerSetupRuns,
    private readonly operatorNotifications: LapseNotifications,
    private readonly permissions: PermissionService,
    private readonly deletion: BoughtServerDeletion,
    private readonly billingConfig: BillingConfig,
  ) {}

  /**
   * A restart ends every Setup run in flight (`ServerSetupRuns` is in
   * memory), so a Bought Server still Setting up at boot had its first run
   * cut off: it runs once more, by itself. Not awaited, so a slow database
   * never holds the boot; the hourly resume of stuck stages (#1391) reaches
   * anything this misses.
   */
  onApplicationBootstrap(): void {
    void this.resumeSetups();
  }

  /** Carries on every Bought Server Setting up whose run is not going here. */
  async resumeSetups(): Promise<void> {
    try {
      const rows = await this.db
        .select({ id: boughtServer.id })
        .from(boughtServer)
        .where(eq(boughtServer.stage, 'setting_up'));
      for (const row of rows) await this.advance(row.id);
    } catch (error) {
      this.logger.error(
        `Could not resume the Bought Servers Setting up: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Takes every step the row is ready for, until it waits on something
   * outside (a payment, the first Setup run) or has nothing left. Never
   * throws: a step that cannot finish is logged, and the stored row says
   * where to resume.
   */
  async advance(id: string): Promise<void> {
    try {
      for (let i = 0; i < MAX_STEPS; i++) {
        const row = await this.find(id);
        if (!row || !(await this.step(row))) return;
      }
    } catch (error) {
      this.logger.error(
        `Bought Server ${id} stopped mid-stage and resumes from what is stored: ${(error as Error).message}`,
      );
    }
  }

  /** One step; false once there is nothing more to do now. */
  private async step(row: BoughtServer): Promise<boolean> {
    const step = nextStep({
      ...row,
      linesOnSubscription: await this.deletion.linesOnSubscription(row.id),
    });
    switch (step.kind) {
      case 'create-machine':
        return this.createMachine(row, step.findFirst);
      case 'give-up':
        return this.giveUp(row);
      case 'refund':
        return this.refund(row);
      case 'record-server':
        return this.recordServer(row);
      case 'apply-change':
        return this.changes.apply(row);
      case 'give-up-change':
        return this.changes.giveUp(row);
      case 'abandon-change':
        return this.changes.abandonForDelete(row);
      case 'remove-lines':
        return this.deletion.removeLines(row);
      case 'delete-machine':
        return this.deletion.deleteMachine(row);
      case 'start-setup':
        return this.startSetup(row);
      case 'setup-cut-off':
        return this.setupCutOff(row);
      case 'wait-for-payment':
      case 'none':
        return false;
    }
  }

  /**
   * The machine, made once: a try is claimed before the provider is asked,
   * and a later try first looks for a machine already carrying this Server's
   * labels, so a create a restart cut off is found rather than repeated.
   * Its ids are stored the moment it answers, before anything else.
   */
  private async createMachine(
    row: BoughtServer,
    findFirst: boolean,
  ): Promise<boolean> {
    if (findFirst) {
      const found = await this.machines.listServers(labelsOf(row));
      if (!found.ok) {
        this.logger.warn(
          `Bought Server ${row.id}: looking for its machine was refused: ${found.code}: ${found.message}`,
        );
        return false;
      }
      if (found.value.length > 0) {
        return this.storeMachine(row, found.value[0]);
      }
    }

    const [claimed] = await this.db
      .update(boughtServer)
      .set({ createTries: row.createTries + 1 })
      .where(
        and(
          eq(boughtServer.id, row.id),
          eq(boughtServer.stage, 'creating'),
          eq(boughtServer.createTries, row.createTries),
          isNull(boughtServer.providerServerId),
        ),
      )
      .returning({ id: boughtServer.id });
    // Someone else took this try.
    if (!claimed) return false;

    const publicKey = await this.publicKeyFor(row);
    const created = await this.machines.createServer({
      name: machineNameOf(row.id),
      serverType: row.serverType,
      location: row.location,
      image: BOUGHT_SERVER_IMAGE,
      sshPublicKey: publicKey,
      labels: labelsOf(row),
    });
    if (!created.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: create ${row.createTries + 1} was refused: ${created.code}: ${created.message}`,
      );
      return true;
    }
    return this.storeMachine(row, created.value.server);
  }

  /** The machine's ids, stored first and once. */
  private async storeMachine(
    row: BoughtServer,
    machine: HetznerServer,
  ): Promise<boolean> {
    await this.db
      .update(boughtServer)
      .set({
        providerServerId: machine.id,
        providerPrimaryIpv4Id: machine.primaryIpv4Id,
        providerPrimaryIpv6Id: machine.primaryIpv6Id,
      })
      .where(
        and(eq(boughtServer.id, row.id), isNull(boughtServer.providerServerId)),
      );
    return true;
  }

  /**
   * The key made for this Server, whose public half the provider is given
   * and nothing else (ADR-0071): made once, on the first try, and stored on
   * the row so a later try gives the same key.
   */
  private async publicKeyFor(row: BoughtServer): Promise<string> {
    if (row.sshKeyId) {
      const [stored] = await this.db
        .select({ publicKey: sshKey.publicKey })
        .from(sshKey)
        .where(eq(sshKey.sshKeyId, row.sshKeyId))
        .limit(1);
      if (stored) return stored.publicKey;
    }
    const made = await this.sshKeys.create(
      {
        user: { id: row.termsAcceptedBy },
        session: { activeOrganizationId: row.organizationId },
      },
      { name: `${row.name} (bought)`, type: 'ed25519' },
    );
    await this.db
      .update(boughtServer)
      .set({ sshKeyId: made.sshKeyId })
      .where(eq(boughtServer.id, row.id));
    return made.publicKey;
  }

  /**
   * Refused every try: the stage is Failed, and the refund follows. One last
   * look by labels first: the last try may have made a machine that a
   * restart cut off before its id was stored, and that machine is the
   * Server, not a reason to refund.
   */
  private async giveUp(row: BoughtServer): Promise<boolean> {
    const found = await this.machines.listServers(labelsOf(row));
    if (!found.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: looking for its machine before the refund was refused: ${found.code}: ${found.message}`,
      );
      return false;
    }
    if (found.value.length > 0) return this.storeMachine(row, found.value[0]);

    const [failed] = await this.db
      .update(boughtServer)
      .set({ stage: 'failed' })
      .where(
        and(
          eq(boughtServer.id, row.id),
          eq(boughtServer.stage, 'creating'),
          isNull(boughtServer.providerServerId),
        ),
      )
      .returning({ id: boughtServer.id });
    if (!failed) return false;
    this.logger.error(
      `Bought Server ${row.id}: the provider refused every create; its payment ${row.purchaseInvoiceId} is refunded`,
    );
    return true;
  }

  /**
   * Failed: the payment refunded in full, the lines taken off the
   * subscription with no proration (the refund already gives back the whole
   * charge), and the row and its lines removed, after which the owner is
   * emailed. Each step can be taken again, so a restart part-way through
   * finishes it: the refund carries a fixed idempotency key and a second
   * full refund is taken as done, and only lines the subscription still
   * carries are removed. Whoever removes the row sends the email, once.
   */
  private async refund(row: BoughtServer): Promise<boolean> {
    let invoice: Stripe.Invoice | null = null;
    let givenBack: GivenBack | null = null;
    if (row.purchaseInvoiceId) {
      invoice = await this.stripe.retrieveInvoice(row.purchaseInvoiceId);
      givenBack = await this.giveBackPurchase(row, invoice);
    }

    // A purchase that failed at its Volume has a machine already: it goes
    // too, with everything billed with it, before the row that names it.
    if (!(await this.deletion.deleteProviderResources(row))) return false;

    const [removed] = await this.db
      .delete(boughtServer)
      .where(and(eq(boughtServer.id, row.id), eq(boughtServer.stage, 'failed')))
      .returning({ id: boughtServer.id });
    if (!removed) return false;
    await this.notifications.sendRefunded({
      organizationId: row.organizationId,
      serverName: row.name,
      amountCents: givenBack?.cents ?? null,
      refundedTo: givenBack?.to ?? 'card',
      currency: invoice?.currency ?? null,
    });
    return false;
  }

  /**
   * A paid purchase given back: the Server's share of its invoice (all of
   * it, unless the invoice also started the plan, which stays) refunded or
   * credited back, and its lines taken off the subscription with no
   * proration, the Add-on it took with them. Safe to ask again.
   */
  async giveBackPurchase(
    row: BoughtServer,
    invoice: Stripe.Invoice,
  ): Promise<GivenBack | null> {
    const lines = await this.db
      .select({ stripePriceId: boughtServerLine.stripePriceId })
      .from(boughtServerLine)
      .where(eq(boughtServerLine.boughtServerId, row.id));
    const prices = this.billingConfig.prices;
    const share = serverShareOf(invoice, {
      lines: lines.map((line) => line.stripePriceId),
      addOn: prices.addOnPriceId ?? null,
      plans: [prices.starterPriceId, prices.businessPriceId].filter(
        (price): price is string => !!price,
      ),
    });
    const givenBack = await giveBackInFull(
      this.stripe,
      invoice,
      refundKeyOf(row.id),
      { boughtServerId: row.id },
      share,
    );
    if (givenBack === null) {
      this.logger.warn(
        `Bought Server ${row.id}: invoice ${invoice.id} names no payment to give back`,
      );
    }
    const subscriptionId = subscriptionIdOf(invoice);
    if (subscriptionId) await this.removeLines(row.id, subscriptionId, invoice);
    return givenBack;
  }

  /**
   * The Bought Server's lines the subscription still carries, taken off it,
   * and the Add-on its purchase added with them (the purchase invoice charges
   * the Add-on price too) taken back down by one. Once the lines are gone a
   * second ask changes nothing, so the Add-on is lowered only with them.
   */
  private async removeLines(
    id: string,
    subscriptionId: string,
    invoice: Stripe.Invoice,
  ): Promise<void> {
    const lines = await this.db
      .select({ stripePriceId: boughtServerLine.stripePriceId })
      .from(boughtServerLine)
      .where(eq(boughtServerLine.boughtServerId, id));
    if (lines.length === 0) return;
    const current = await this.stripe.retrieveSubscription(subscriptionId);
    const carried = itemsByPrice(
      current,
      lines.map((line) => line.stripePriceId),
    );
    if (carried.size === 0) return;
    const addOnPriceId = this.billingConfig.prices.addOnPriceId;
    const addOn =
      addOnPriceId && invoicePriceIds(invoice).includes(addOnPriceId)
        ? current.items.data.find((item) => item.price.id === addOnPriceId)
        : undefined;
    await this.stripe.updateSubscription(subscriptionId, {
      items: [
        ...[...carried.values()].map((item) => ({ id: item, deleted: true })),
        ...(addOn
          ? [
              (addOn.quantity ?? 1) > 1
                ? { id: addOn.id, quantity: (addOn.quantity ?? 1) - 1 }
                : { id: addOn.id, deleted: true },
            ]
          : []),
      ],
      proration_behavior: 'none',
    });
  }

  /**
   * The machine answers: its address is named (reverse DNS, when the domain
   * is set) and the `server` row is written with it, in one write with the
   * stage moving on, so `server.ip_address` is never empty.
   */
  private async recordServer(row: BoughtServer): Promise<boolean> {
    const machine = await this.machines.getServer(row.providerServerId!);
    if (!machine.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: reading its machine was refused: ${machine.code}: ${machine.message}`,
      );
      return false;
    }
    const address = machine.value.ipv4;
    if (!address) return false;

    // Backups bought with it are on before the Server is: the create cannot
    // ask for them, so they are asked for here, once the machine is made.
    if (row.backups && !machine.value.backups) {
      const backups = await this.machines.enableBackup(machine.value.id);
      if (!backups.ok) {
        this.logger.warn(
          `Bought Server ${row.id}: turning on its backups was refused: ${backups.code}: ${backups.message}`,
        );
        return false;
      }
    }

    // Extra storage bought with it is attached before the Server is written;
    // the Setup run mounts it (`ServersService.setup`).
    if (row.storageGb !== null) {
      const storage = await this.attachStorage(row, machine.value);
      if (storage !== 'attached') return storage === 'again';
    }

    const domain = this.config.reverseDnsDomain;
    if (domain) {
      const named = await this.machines.setReverseDns(
        machine.value.id,
        address,
        reverseDnsNameOf(row.id, domain),
      );
      // The provider's default name is allowed (the Operator page warns),
      // so a refusal here does not hold the Server back.
      if (!named.ok) {
        this.logger.warn(
          `Bought Server ${row.id}: reverse DNS was refused: ${named.code}: ${named.message}`,
        );
      }
    }

    await this.db.transaction(async (tx) => {
      const [moved] = await tx
        .update(boughtServer)
        .set({ stage: 'setting_up' })
        .where(
          and(
            eq(boughtServer.id, row.id),
            eq(boughtServer.stage, 'creating'),
            isNull(boughtServer.serverId),
          ),
        )
        .returning({ id: boughtServer.id });
      if (!moved) return;
      await tx.insert(server).values({
        serverId: row.id,
        name: row.name,
        ipAddress: address,
        port: 22,
        username: 'root',
        sshKeyId: row.sshKeyId,
        organizationId: row.organizationId,
      });
      // The link last: it names the row just written.
      await tx
        .update(boughtServer)
        .set({ serverId: row.id })
        .where(eq(boughtServer.id, row.id));
    });
    return true;
  }

  /**
   * The first Setup run, which Buy pressed for: each start is claimed on
   * the row before the run begins, so a restart reads it as started and two
   * callers never both start one. A run already going on this backend is
   * left alone. Its end moves the stage on; nothing here waits for it.
   */
  private async startSetup(row: BoughtServer): Promise<boolean> {
    if (!row.serverId || this.setupRuns.inFlight(row.serverId)) return false;
    const [claimed] = await this.db
      .update(boughtServer)
      .set({ setupStarts: row.setupStarts + 1 })
      .where(
        and(
          eq(boughtServer.id, row.id),
          eq(boughtServer.stage, 'setting_up'),
          eq(boughtServer.setupStarts, row.setupStarts),
        ),
      )
      .returning({ id: boughtServer.id });
    if (!claimed) return false;

    // Whose run it is: the customer who pressed Buy, in their Organization,
    // as `POST /servers/:id/setup` would read the Server for them.
    const { ended } = this.setupRuns.start(row.serverId, {
      user: { id: row.termsAcceptedBy },
      session: { activeOrganizationId: row.organizationId },
    });
    void ended.then((outcome) => this.setupEnded(row, outcome));
    return false;
  }

  /**
   * The first run ended: Ready either way. A failure is already stored on
   * the Server by the run (`setupOk`, `setupMessage`), which is what the
   * Setup card shows; the Operators are told.
   */
  private async setupEnded(
    row: BoughtServer,
    outcome: SetupRunOutcome,
  ): Promise<void> {
    try {
      const moved = await this.markReady(row.id);
      if (moved && !outcome.ok) {
        await this.tellOperators(row, outcome.message ?? 'Setup failed');
      }
    } catch (error) {
      this.logger.error(
        `Bought Server ${row.id}: could not record how its first setup ended: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Started twice and cut off by a restart both times: given up as a failed
   * run, stored on the Server as one would be, and only *Run setup* starts
   * another.
   */
  private async setupCutOff(row: BoughtServer): Promise<boolean> {
    if (!(await this.markReady(row.id))) return false;
    if (row.serverId) {
      await this.db
        .update(server)
        .set({
          setupRanAt: new Date().toISOString(),
          setupOk: false,
          setupMessage: SETUP_CUT_OFF_MESSAGE,
        })
        .where(eq(server.serverId, row.serverId));
    }
    this.logger.error(
      `Bought Server ${row.id}: its first setup was cut off ${row.setupStarts} times; it is left Ready with Setup failed`,
    );
    await this.tellOperators(row, SETUP_CUT_OFF_MESSAGE);
    return false;
  }

  /** Setting up to Ready, once; false when it had already moved. */
  private async markReady(id: string): Promise<boolean> {
    const [moved] = await this.db
      .update(boughtServer)
      .set({ stage: 'ready' })
      .where(and(eq(boughtServer.id, id), eq(boughtServer.stage, 'setting_up')))
      .returning({ id: boughtServer.id });
    return moved !== undefined;
  }

  private async tellOperators(row: BoughtServer, failure: string) {
    await this.operatorNotifications.sendBoughtServerSetupFailed(
      await this.permissions.instanceOrganizationId(),
      {
        organizationId: row.organizationId,
        serverName: row.name,
        serverId: row.id,
        failure,
      },
    );
  }

  /**
   * The extra storage's Volume, made once and attached to the machine. A
   * later try first looks for a Volume carrying this Server's labels, so a
   * create a restart cut off is found rather than repeated; its id is stored
   * the moment it is known, since Delete must delete it too. Each create is
   * claimed before the provider is asked, as the machine's is: refused
   * {@link MAX_CREATE_TRIES} times, the purchase is Failed and refunded
   * (ADR-0071), and the machine already made goes with it.
   *
   * `again` when a try was refused and the next may be taken at once.
   */
  private async attachStorage(
    row: BoughtServer,
    machine: HetznerServer,
  ): Promise<'attached' | 'again' | 'stop'> {
    let volumeId = row.providerVolumeId;
    if (volumeId === null) {
      const found = await this.machines.listVolumes(labelsOf(row));
      if (!found.ok) {
        this.logger.warn(
          `Bought Server ${row.id}: looking for its Volume was refused: ${found.code}: ${found.message}`,
        );
        return 'stop';
      }
      let volume = found.value[0];
      if (!volume) {
        if (row.storageTries >= MAX_CREATE_TRIES) {
          return (await this.failStorage(row)) ? 'again' : 'stop';
        }
        const [claimed] = await this.db
          .update(boughtServer)
          .set({ storageTries: row.storageTries + 1 })
          .where(
            and(
              eq(boughtServer.id, row.id),
              eq(boughtServer.stage, 'creating'),
              eq(boughtServer.storageTries, row.storageTries),
              isNull(boughtServer.providerVolumeId),
            ),
          )
          .returning({ id: boughtServer.id });
        // Someone else took this try.
        if (!claimed) return 'stop';
        const made = await this.machines.createVolume({
          name: machineNameOf(row.id),
          sizeGb: row.storageGb!,
          location: row.location,
          labels: labelsOf(row),
        });
        if (!made.ok) {
          this.logger.warn(
            `Bought Server ${row.id}: Volume create ${row.storageTries + 1} was refused: ${made.code}: ${made.message}`,
          );
          return 'again';
        }
        volume = made.value.volume;
        if (made.value.action && !(await this.finished(made.value.action))) {
          return 'stop';
        }
      }
      await this.db
        .update(boughtServer)
        .set({ providerVolumeId: volume.id })
        .where(
          and(
            eq(boughtServer.id, row.id),
            isNull(boughtServer.providerVolumeId),
          ),
        );
      volumeId = volume.id;
    }
    if (machine.volumeIds.includes(volumeId)) return 'attached';
    const attached = await this.machines.attachVolume(volumeId, machine.id);
    if (!attached.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: attaching its Volume was refused: ${attached.code}: ${attached.message}`,
      );
      return 'stop';
    }
    return (await this.finished(attached.value)) ? 'attached' : 'stop';
  }

  /** The Volume refused every try: Failed, and the refund follows. */
  private async failStorage(row: BoughtServer): Promise<boolean> {
    const [failed] = await this.db
      .update(boughtServer)
      .set({ stage: 'failed' })
      .where(
        and(
          eq(boughtServer.id, row.id),
          eq(boughtServer.stage, 'creating'),
          isNull(boughtServer.serverId),
          isNull(boughtServer.providerVolumeId),
        ),
      )
      .returning({ id: boughtServer.id });
    if (!failed) return false;
    this.logger.error(
      `Bought Server ${row.id}: the provider refused every Volume create; its payment ${row.purchaseInvoiceId} is refunded and its machine deleted`,
    );
    return true;
  }

  /** Whether a provider action ended well, waited on for a short while. */
  private async finished(action: HetznerAction): Promise<boolean> {
    let current = action;
    for (let i = 0; current.status === 'running' && i < ACTION_POLLS; i++) {
      await new Promise((resolve) => setTimeout(resolve, ACTION_POLL_MS));
      const read = await this.machines.getAction(current.id);
      if (!read.ok) return false;
      current = read.value;
    }
    return current.status === 'success';
  }

  private async find(id: string): Promise<BoughtServer | null> {
    const [row] = await this.db
      .select()
      .from(boughtServer)
      .where(eq(boughtServer.id, id))
      .limit(1);
    return row ?? null;
  }
}
