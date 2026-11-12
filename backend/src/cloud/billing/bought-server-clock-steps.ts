import { Injectable, Logger } from '@nestjs/common';

/** What the Bought Server steps of one daily tick did, by Organization id. */
export interface BoughtServerClockOutcome {
  /** Sent "your Servers will be deleted in a day". */
  reminded: string[];
  /** Had their Bought Servers deleted, and were told. */
  deleted: string[];
  /** Sent "your Servers will be deleted on <date>", 7 days before a cancel. */
  cancelWarned: string[];
}

/** The Bought Server steps one daily tick takes as of `now`. */
export type BoughtServerClockRun = (
  now: Date,
) => Promise<BoughtServerClockOutcome>;

/** What else the Bought Server clock hears of at the moment it happens (#1398). */
export interface BoughtServerClockEvents {
  /**
   * A lapse was just recorded on `organizationId`'s row: its Bought Servers,
   * and those of each Organization it pays for, are deleted now.
   * `chargedToOrganizationId` names the Paying Organization whose
   * subscription still carries their lines when that is no longer the one
   * the link points to ("Stop paying for it").
   */
  lapsed(
    organizationId: string,
    now: Date,
    chargedToOrganizationId?: string,
  ): Promise<void>;
  /** An Operator just suspended `organizationId`: its owner is told the date. */
  suspended(organizationId: string, now: Date): Promise<void>;
}

/**
 * Where billing reaches the **Bought Server** clock (ADR-0071): the daily
 * lapse job (`LapseClockService`) runs its steps (#1397: the reminder a day
 * before the deletion date, and the deletion; #1398: the warning 7 days
 * before a cancel), and a lapse or a suspension, wherever it is recorded,
 * tells it at once (#1398). A registry rather than an import, as
 * `PurchasePayments` is, because deleting a Bought Server is the Bought
 * Servers module's, and that module already depends on billing. The steps
 * register themselves at start; with none registered, a tick takes none
 * and an event does nothing.
 *
 * An event never fails its caller: the lapse or the suspension is already
 * recorded, and the daily tick deletes what an event missed.
 */
@Injectable()
export class BoughtServerClockSteps {
  private readonly logger = new Logger(BoughtServerClockSteps.name);
  private readonly runs: BoughtServerClockRun[] = [];
  private readonly listeners: BoughtServerClockEvents[] = [];

  register(run: BoughtServerClockRun): void {
    this.runs.push(run);
  }

  listen(listener: BoughtServerClockEvents): void {
    this.listeners.push(listener);
  }

  async run(now: Date): Promise<BoughtServerClockOutcome> {
    const outcome: BoughtServerClockOutcome = {
      reminded: [],
      deleted: [],
      cancelWarned: [],
    };
    for (const run of this.runs) {
      const done = await run(now);
      outcome.reminded.push(...done.reminded);
      outcome.deleted.push(...done.deleted);
      outcome.cancelWarned.push(...done.cancelWarned);
    }
    return outcome;
  }

  /** See {@link BoughtServerClockEvents.lapsed}. */
  async lapsed(
    organizationId: string,
    now: Date = new Date(),
    chargedToOrganizationId?: string,
  ): Promise<void> {
    await this.tell(`the lapse of ${organizationId}`, (listener) =>
      listener.lapsed(organizationId, now, chargedToOrganizationId),
    );
  }

  /** See {@link BoughtServerClockEvents.suspended}. */
  async suspended(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.tell(`the suspension of ${organizationId}`, (listener) =>
      listener.suspended(organizationId, now),
    );
  }

  private async tell(
    what: string,
    call: (listener: BoughtServerClockEvents) => Promise<void>,
  ): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await call(listener);
      } catch (error) {
        this.logger.error(
          `The Bought Server clock failed on ${what}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
