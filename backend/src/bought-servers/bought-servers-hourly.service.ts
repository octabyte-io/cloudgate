import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, asc, inArray, isNull } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { BoughtServerChanges } from './bought-server-changes.service';
import { BoughtServerPurchases } from './bought-server-purchases.service';
import { BoughtServerStages } from './bought-server-stages.service';
import { boughtServer } from './bought-server.schema';
import { OrphanMachines } from './orphan-machines.service';
import type { OrphanCheck } from './orphan-machines.service';
import { MID_STAGE } from './stages';

export const BOUGHT_SERVERS_HOURLY_JOB_ID = 'bought-servers-hourly';
/** Hourly, at a minute no other hourly job takes (:07, :23 and :37 are). */
export const BOUGHT_SERVERS_HOURLY_CRON = '51 * * * *';

/** What one hourly tick did. */
export interface BoughtServersHourlyTick {
  /** The Bought Servers found mid-stage and carried on, by id. */
  resumed: string[];
  /**
   * The charges read again from Stripe, by Bought Server id: purchases still
   * waiting for payment, and costlier changes with no payment stored.
   */
  charges: string[];
  /**
   * The orphan check's machines nothing owns (#1402), or null when it did
   * not run or the provider could not be read. It never deletes any.
   */
  orphans: OrphanCheck | null;
}

/**
 * The hourly **Bought Server** job (ADR-0071), Hosted instance only: it
 * resumes every Bought Server a restart left mid-stage, from what is
 * stored. First the charges: a purchase still waiting for payment, or a
 * costlier change with no payment stored, is read again from Stripe once it
 * is old enough not to race the press (a restart between the charge and the
 * write, a lost webhook, an abandoned Checkout). The stages decide each step from the row alone, and a machine
 * already made is found by its stored id or its labels, so a resume never
 * makes a second one.
 *
 * Then the orphan check (#1402): the provider's machines with Cloudgate's
 * labels and no live Bought Server behind them, each emailed to the
 * Operators once and listed on the Operator page. It never deletes one.
 */
@Injectable()
export class BoughtServersHourly implements OnApplicationBootstrap {
  private readonly logger = new Logger(BoughtServersHourly.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly instanceMode: InstanceMode,
    private readonly scheduling: SchedulingService,
    private readonly stages: BoughtServerStages,
    private readonly purchases: BoughtServerPurchases,
    private readonly changes: BoughtServerChanges,
    private readonly orphans: OrphanMachines,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.instanceMode.isHosted) return;
    this.scheduling.register(
      BOUGHT_SERVERS_HOURLY_JOB_ID,
      BOUGHT_SERVERS_HOURLY_CRON,
      null,
      () => this.tick().then(() => undefined),
    );
  }

  /**
   * Carries on every Bought Server in a stage a restart can leave work in,
   * oldest first. `advance` never throws: one that cannot finish now stays
   * as stored for the next tick. The orphan check runs after, so a machine
   * a resume just made or deleted is seen as it now stands.
   */
  async tick(now: Date = new Date()): Promise<BoughtServersHourlyTick> {
    const done: BoughtServersHourlyTick = {
      resumed: [],
      charges: [],
      orphans: null,
    };
    if (!this.instanceMode.isHosted) return done;
    await this.resumeCharges(now, done);
    const rows = await this.db
      .select({ id: boughtServer.id })
      .from(boughtServer)
      .where(inArray(boughtServer.stage, [...MID_STAGE]))
      .orderBy(asc(boughtServer.createdAt));
    for (const { id } of rows) {
      await this.stages.advance(id);
      done.resumed.push(id);
    }
    try {
      done.orphans = await this.orphans.check(now);
    } catch (error) {
      this.logger.error(
        `The orphan check failed and runs again next hour: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return done;
  }

  /** Each unsettled charge read again from Stripe; one that fails waits for the next tick. */
  private async resumeCharges(
    now: Date,
    done: BoughtServersHourlyTick,
  ): Promise<void> {
    const waiting = await this.db
      .select({ id: boughtServer.id, stage: boughtServer.stage })
      .from(boughtServer)
      .where(
        and(
          inArray(boughtServer.stage, ['waiting_for_payment', 'changing']),
          isNull(boughtServer.changeInvoiceId),
        ),
      )
      .orderBy(asc(boughtServer.createdAt));
    for (const { id, stage } of waiting) {
      try {
        if (stage === 'waiting_for_payment') {
          await this.purchases.resume(id, now);
        } else {
          await this.changes.resumeCharge(id, now);
        }
        done.charges.push(id);
      } catch (error) {
        this.logger.warn(
          `Bought Server ${id}: reading its charge again failed, and runs again next hour: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
