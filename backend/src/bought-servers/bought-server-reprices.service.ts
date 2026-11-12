import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { DailyJobSteps } from '../cloud/billing/daily-job-steps';
import { payingOrganizationOf } from '../cloud/billing/paying-organization';
import { STRIPE_API } from '../cloud/billing/stripe-api';
import type { StripeApi } from '../cloud/billing/stripe-api';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { NamedOrganization } from '../organizations/organization-name';
import { organization } from '../organizations/organizations.schema';
import { boughtServer, boughtServerLine } from './bought-server.schema';
import type {
  BoughtServerLine,
  BoughtServerStage,
} from './bought-server.schema';
import { BoughtServerNotifications } from './bought-server-notifications.service';
import type { RepricedServer } from './bought-server-notifications.service';
import { BoughtServerSettings } from './bought-server-settings.service';
import { BoughtServersService } from './bought-servers.service';
import { linePriceParams } from './purchase-lines';
import { dueLines, repriceOf, repriceUpdateParams } from './reprice';
import type { RepricedLine } from './reprice';

/**
 * The stages whose lines are sold and may be repriced. Not Changing: the
 * change in progress rewrites its lines, so a reprice waits for it; the
 * daily job tries again the next day. Not Deleting or Deleted: deleting
 * before a rise starts must never charge the new price.
 */
const REPRICEABLE_STAGES: readonly BoughtServerStage[] = [
  'creating',
  'setting_up',
  'ready',
];

/** The Operator's refusal when the list moved between the preview and the confirm. */
export const PRICES_CHANGED = 'PRICES_CHANGED';

/**
 * One Bought Server in a reprice preview, and as it was applied: the same
 * shape, from the same function, so the preview is what is applied.
 */
export interface RepricePreview {
  id: string;
  name: string;
  organization: NamedOrganization;
  stage: BoughtServerStage;
  /**
   * `rise` (from `startsAt`, 30 days on) and `fall` (at once) can be
   * applied; `unchanged` already sells at the list price; `unpriceable` is
   * no longer on the list; `not-repriceable` is in a stage that is not.
   */
  status: 'rise' | 'fall' | 'unchanged' | 'unpriceable' | 'not-repriceable';
  /** Every line's current price together, in US cents a month. */
  oldMonthlyCents: number;
  /** Every line at the list price now, or null when it cannot be priced. */
  newMonthlyCents: number | null;
  startsAt: Date | null;
  lines: RepricedLine[];
}

/** One Bought Server to apply, with the new price its preview showed. */
export interface RepriceConfirm {
  id: string;
  newMonthlyCents: number;
}

/**
 * An Operator's **reprice** of Bought Servers already sold (ADR-0071,
 * #1400), and the daily step that starts a rise on its date. The Operator
 * page reaches it through `OperatorBoughtServers`, which checks the caller
 * and audits; this only prices and applies.
 *
 * A rise writes the next price and its start date on each line that moves,
 * and nothing changes at Stripe until the daily job's tick on that date
 * swaps the item's price. A fall swaps it at once. Each line gets a new
 * Stripe Price under its kind's fixed Product, as at a purchase.
 */
@Injectable()
export class BoughtServerReprices implements OnModuleInit {
  private readonly logger = new Logger(BoughtServerReprices.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly catalogue: BoughtServersService,
    private readonly settings: BoughtServerSettings,
    private readonly notifications: BoughtServerNotifications,
    private readonly steps: DailyJobSteps,
  ) {}

  onModuleInit(): void {
    this.steps.add({
      name: 'Bought Server reprices',
      run: (now) => this.applyDue(now).then(() => undefined),
    });
  }

  /**
   * Each chosen Bought Server's old price and its price at the current USD
   * list and the current Server markup; 404 when one is not found.
   */
  async preview(
    ids: string[],
    now: Date = new Date(),
  ): Promise<RepricePreview[]> {
    const rows = await this.db
      .select({
        id: boughtServer.id,
        name: boughtServer.name,
        organizationId: organization.id,
        organizationName: organization.name,
        stage: boughtServer.stage,
        serverType: boughtServer.serverType,
        location: boughtServer.location,
        storageGb: boughtServer.storageGb,
      })
      .from(boughtServer)
      .innerJoin(organization, eq(organization.id, boughtServer.organizationId))
      .where(inArray(boughtServer.id, ids));
    if (rows.length !== new Set(ids).size) {
      throw new NotFoundException('Bought Server not found');
    }
    const lines = await this.db
      .select({
        boughtServerId: boughtServerLine.boughtServerId,
        kind: boughtServerLine.kind,
        monthlyCents: boughtServerLine.monthlyCents,
      })
      .from(boughtServerLine)
      .where(inArray(boughtServerLine.boughtServerId, ids))
      .orderBy(asc(boughtServerLine.kind));
    const [list, { markupPercent }] = await Promise.all([
      this.catalogue.freshPriceList(),
      this.settings.get(),
    ]);

    return ids.map((id): RepricePreview => {
      const row = rows.find((candidate) => candidate.id === id)!;
      const held = lines.filter((line) => line.boughtServerId === id);
      const base = {
        id: row.id,
        name: row.name,
        organization: { id: row.organizationId, name: row.organizationName },
        stage: row.stage,
        oldMonthlyCents: held.reduce((sum, line) => sum + line.monthlyCents, 0),
      };
      if (!REPRICEABLE_STAGES.includes(row.stage) || held.length === 0) {
        return {
          ...base,
          status: 'not-repriceable',
          newMonthlyCents: null,
          startsAt: null,
          lines: [],
        };
      }
      const reprice = repriceOf({
        machine: row,
        lines: held,
        list,
        markupPercent,
        now,
      });
      switch (reprice.kind) {
        case 'unpriceable':
          return {
            ...base,
            status: 'unpriceable',
            newMonthlyCents: null,
            startsAt: null,
            lines: [],
          };
        case 'unchanged':
          return {
            ...base,
            status: 'unchanged',
            newMonthlyCents: reprice.monthlyCents,
            startsAt: null,
            lines: [],
          };
        default:
          return {
            ...base,
            status: reprice.kind,
            newMonthlyCents: reprice.newMonthlyCents,
            startsAt: reprice.startsAt,
            lines: reprice.lines,
          };
      }
    });
  }

  /**
   * Applies the reprice the Operator previewed: priced again now, and
   * refused, changing nothing, unless every Bought Server still comes to the
   * price its preview showed and can be repriced. Then each rise's next
   * prices are written, each fall is swapped at Stripe, and each
   * Organization's owners get one email for all of its Servers.
   */
  async apply(
    confirms: RepriceConfirm[],
    now: Date = new Date(),
  ): Promise<RepricePreview[]> {
    const previews = await this.preview(
      confirms.map((confirm) => confirm.id),
      now,
    );
    for (const preview of previews) {
      if (preview.status !== 'rise' && preview.status !== 'fall') {
        throw new ConflictException({
          code: 'NOT_REPRICEABLE',
          message: `${preview.name} has no new price to apply`,
        });
      }
      const confirm = confirms.find((entry) => entry.id === preview.id)!;
      if (confirm.newMonthlyCents !== preview.newMonthlyCents) {
        throw new ConflictException({
          code: PRICES_CHANGED,
          message: `The price of ${preview.name} changed since the preview: preview again`,
        });
      }
    }

    for (const preview of previews) {
      if (preview.status === 'rise') {
        await this.writeNextPrices(preview);
      } else {
        await this.swapNow(preview);
      }
    }

    const byOrganization = new Map<string, RepricedServer[]>();
    for (const preview of previews) {
      const servers = byOrganization.get(preview.organization.id) ?? [];
      servers.push({
        serverName: preview.name,
        oldMonthlyCents: preview.oldMonthlyCents,
        newMonthlyCents: preview.newMonthlyCents!,
        startsAt: preview.startsAt!,
        rise: preview.status === 'rise',
      });
      byOrganization.set(preview.organization.id, servers);
    }
    for (const [organizationId, servers] of byOrganization) {
      await this.notifications.sendPriceChange(organizationId, servers);
    }
    return previews;
  }

  /**
   * The daily step: every line whose next price has started, on a Bought
   * Server still sold, swapped at Stripe. A Bought Server deleted before the
   * date is not, so it is never charged the new price; one Changing waits
   * for the next day. Answers the Bought Servers swapped.
   */
  async applyDue(now: Date): Promise<string[]> {
    const rows = await this.db
      .select({
        line: boughtServerLine,
        organizationId: boughtServer.organizationId,
      })
      .from(boughtServerLine)
      .innerJoin(
        boughtServer,
        eq(boughtServer.id, boughtServerLine.boughtServerId),
      )
      .where(
        and(
          isNotNull(boughtServerLine.nextMonthlyCents),
          lte(boughtServerLine.nextPriceFrom, now),
          inArray(boughtServer.stage, [...REPRICEABLE_STAGES]),
        ),
      );
    const byServer = new Map<
      string,
      { organizationId: string; lines: BoughtServerLine[] }
    >();
    for (const { line, organizationId } of rows) {
      const entry = byServer.get(line.boughtServerId) ?? {
        organizationId,
        lines: [],
      };
      entry.lines.push(line);
      byServer.set(line.boughtServerId, entry);
    }

    const swapped: string[] = [];
    for (const [id, { organizationId, lines }] of byServer) {
      try {
        const due = dueLines(lines, now);
        await this.swap(
          { id, organizationId },
          due.map((line) => ({ line, cents: line.nextMonthlyCents! })),
          'rise',
        );
        swapped.push(id);
      } catch (error) {
        this.logger.error(
          `Could not start the new price of Bought Server ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (swapped.length > 0) {
      this.logger.log(
        `Started the new price of ${swapped.length} Bought Server(s)`,
      );
    }
    return swapped;
  }

  /**
   * A rise: each moving line's next price and its start date, and any
   * earlier next price on a line that no longer moves cleared. Nothing at
   * Stripe until the date.
   */
  private async writeNextPrices(preview: RepricePreview): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(boughtServerLine)
        .set({ nextMonthlyCents: null, nextPriceFrom: null })
        .where(eq(boughtServerLine.boughtServerId, preview.id));
      for (const line of preview.lines) {
        await tx
          .update(boughtServerLine)
          .set({
            nextMonthlyCents: line.newMonthlyCents,
            nextPriceFrom: preview.startsAt,
          })
          .where(
            and(
              eq(boughtServerLine.boughtServerId, preview.id),
              eq(boughtServerLine.kind, line.kind),
            ),
          );
      }
    });
  }

  /** A fall: every moving line swapped now, and any pending rise dropped. */
  private async swapNow(preview: RepricePreview): Promise<void> {
    const lines = await this.db
      .select()
      .from(boughtServerLine)
      .where(eq(boughtServerLine.boughtServerId, preview.id));
    await this.swap(
      { id: preview.id, organizationId: preview.organization.id },
      preview.lines.flatMap((repriced) => {
        const line = lines.find((held) => held.kind === repriced.kind);
        return line ? [{ line, cents: repriced.newMonthlyCents }] : [];
      }),
      'fall',
    );
    await this.db
      .update(boughtServerLine)
      .set({ nextMonthlyCents: null, nextPriceFrom: null })
      .where(eq(boughtServerLine.boughtServerId, preview.id));
  }

  /**
   * Lines moved to new prices: a new Stripe Price for each, the
   * subscription items carrying them moved to it, then the rows. A line not
   * on the subscription (on a Free-trial invoice) joins it later at the
   * price stored here. Run again after failing halfway, it makes the same
   * prices again, which changes nothing the customer pays.
   */
  private async swap(
    row: { id: string; organizationId: string },
    lines: Array<{ line: BoughtServerLine; cents: number }>,
    kind: 'rise' | 'fall',
  ): Promise<void> {
    if (lines.length === 0) return;
    const priced: Array<{
      line: BoughtServerLine;
      cents: number;
      priceId: string;
    }> = [];
    for (const { line, cents } of lines) {
      const price = await this.stripe.createPrice(
        linePriceParams(row.id, { kind: line.kind, monthlyCents: cents }),
      );
      priced.push({ line, cents, priceId: price.id });
    }

    const onSubscription = priced.filter(
      ({ line }) => line.stripeSubscriptionItemId !== null,
    );
    if (onSubscription.length > 0) {
      const { subscription: payer } = await payingOrganizationOf(
        this.db,
        row.organizationId,
      );
      const subscriptionId = payer?.stripeSubscriptionId ?? null;
      if (subscriptionId) {
        const current = await this.stripe.retrieveSubscription(subscriptionId);
        const carried = new Set(
          current.status === 'canceled'
            ? []
            : current.items.data.map((item) => item.id),
        );
        const items = onSubscription
          .filter(({ line }) => carried.has(line.stripeSubscriptionItemId!))
          .map(({ line, priceId }) => ({
            id: line.stripeSubscriptionItemId!,
            price: priceId,
          }));
        if (items.length > 0) {
          await this.stripe.updateSubscription(
            subscriptionId,
            repriceUpdateParams(items, kind),
          );
        }
      }
    }

    await this.db.transaction(async (tx) => {
      for (const { line, cents, priceId } of priced) {
        await tx
          .update(boughtServerLine)
          .set({
            stripePriceId: priceId,
            monthlyCents: cents,
            nextMonthlyCents: null,
            nextPriceFrom: null,
          })
          .where(eq(boughtServerLine.id, line.id));
      }
    });
  }
}
