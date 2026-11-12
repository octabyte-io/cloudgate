import type Stripe from 'stripe';
import type { BoughtServerLineKind } from './bought-server.schema';
import type {
  HetznerPricing,
  HetznerServerType,
} from './hetzner/hetzner-cloud.port';
import { backupsPrice, serverPrice, storagePrice } from './pricing';

/**
 * An Operator's **reprice** of Bought Servers already sold (ADR-0071,
 * #1400), pure: what each line would sell at today, the current USD list
 * plus the current Server markup through the same `pricing.ts` a purchase
 * uses, and whether that is a rise, which starts {@link REPRICE_NOTICE_DAYS}
 * later after an email, or a fall, which applies at once.
 *
 * The preview and the confirmed reprice are both this function over the same
 * inputs, so what an Operator is shown is what is applied.
 */

/** A rise is passed on with this many days' notice (ADR-0071). */
export const REPRICE_NOTICE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The USD account's price list, as much of it as a price needs. */
export interface UsdPriceList {
  serverTypes: Array<Pick<HetznerServerType, 'name' | 'prices'>>;
  pricing: HetznerPricing;
}

/** What a line is priced from: the machine as it now is. */
export interface RepricedMachine {
  serverType: string;
  location: string;
  storageGb: number | null;
}

/**
 * A line's monthly price today in US cents: its list price plus the markup,
 * rounded up as a purchase rounds it. Null when the list does not price it
 * (a size no longer sold there, storage on a machine with none) or is not
 * in USD, since a EUR figure sold as dollars would be a wrong price.
 */
export function listedCents(
  machine: RepricedMachine,
  kind: BoughtServerLineKind,
  list: UsdPriceList,
  markupPercent: number,
): number | null {
  if (list.pricing.currency !== 'USD') return null;
  const size = list.serverTypes
    .find((type) => type.name === machine.serverType)
    ?.prices.find((price) => price.location === machine.location);
  if (kind === 'storage') {
    return machine.storageGb
      ? storagePrice({
          sizeGb: machine.storageGb,
          perGbMonthly: Number(list.pricing.volumePerGbMonthNet),
          markupPercent,
        }) * 100
      : null;
  }
  if (!size) return null;
  const listMonthly = Number(size.monthlyNet);
  if (kind === 'backups') {
    return (
      backupsPrice({
        listMonthly,
        backupPercent: Number(list.pricing.serverBackupPercentage),
        markupPercent,
      }) * 100
    );
  }
  const ipv4 = list.pricing.primaryIps.find(
    (ip) => ip.type === 'ipv4' && ip.location === machine.location,
  );
  if (!ipv4) return null;
  return (
    serverPrice({
      listMonthly,
      ipv4Monthly: Number(ipv4.monthlyNet),
      markupPercent,
    }) * 100
  );
}

/** One line a reprice moves. */
export interface RepricedLine {
  kind: BoughtServerLineKind;
  oldMonthlyCents: number;
  newMonthlyCents: number;
}

/**
 * What a reprice does to one Bought Server. Rise or fall is decided on the
 * lines together, the price the owner is told, so a Server whose size got
 * cheaper while its backups did not is a fall applied at once, and one that
 * costs more in all gets the full notice for every line that moves.
 */
export type Reprice =
  | { kind: 'unpriceable' }
  | { kind: 'unchanged'; monthlyCents: number }
  | {
      kind: 'rise' | 'fall';
      oldMonthlyCents: number;
      newMonthlyCents: number;
      startsAt: Date;
      /** Only the lines whose price moves. */
      lines: RepricedLine[];
    };

export function repriceOf(input: {
  machine: RepricedMachine;
  lines: ReadonlyArray<{ kind: BoughtServerLineKind; monthlyCents: number }>;
  list: UsdPriceList;
  markupPercent: number;
  now: Date;
}): Reprice {
  const priced: RepricedLine[] = [];
  for (const line of input.lines) {
    const cents = listedCents(
      input.machine,
      line.kind,
      input.list,
      input.markupPercent,
    );
    if (cents === null) return { kind: 'unpriceable' };
    priced.push({
      kind: line.kind,
      oldMonthlyCents: line.monthlyCents,
      newMonthlyCents: cents,
    });
  }

  const oldMonthlyCents = sum(priced.map((line) => line.oldMonthlyCents));
  const moved = priced.filter(
    (line) => line.newMonthlyCents !== line.oldMonthlyCents,
  );
  if (moved.length === 0) {
    return { kind: 'unchanged', monthlyCents: oldMonthlyCents };
  }
  const newMonthlyCents = sum(priced.map((line) => line.newMonthlyCents));
  const rise = newMonthlyCents > oldMonthlyCents;
  return {
    kind: rise ? 'rise' : 'fall',
    oldMonthlyCents,
    newMonthlyCents,
    startsAt: rise
      ? new Date(input.now.getTime() + REPRICE_NOTICE_DAYS * DAY_MS)
      : input.now,
    lines: moved,
  };
}

/** The lines whose next price has started by `now`: the daily job swaps these. */
export function dueLines<
  T extends { nextMonthlyCents: number | null; nextPriceFrom: Date | null },
>(lines: readonly T[], now: Date): T[] {
  return lines.filter(
    (line) =>
      line.nextMonthlyCents !== null &&
      line.nextPriceFrom !== null &&
      line.nextPriceFrom.getTime() <= now.getTime(),
  );
}

/**
 * The subscription items moved to their new prices. A fall is applied at
 * once, so the rest of the month is prorated as a credit on the next
 * invoice, as any reduction is. A rise swapped on its start date is not
 * prorated: the month already paid stays at the old price, and the next
 * renewal charges the new one, so nothing is charged that the notice did not
 * announce.
 */
export function repriceUpdateParams(
  items: ReadonlyArray<{ id: string; price: string }>,
  kind: 'rise' | 'fall',
): Stripe.SubscriptionUpdateParams {
  return {
    items: items.map((item) => ({
      id: item.id,
      price: item.price,
      quantity: 1,
    })),
    proration_behavior: kind === 'fall' ? 'create_prorations' : 'none',
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
