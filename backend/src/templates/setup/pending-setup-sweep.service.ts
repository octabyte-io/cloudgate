import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq, lte } from 'drizzle-orm';

import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { environment, expiredSetup, pendingSetup } from '../../db/schema';
import { SchedulingService } from '../../scheduling/scheduling.service';
import { EXPIRED_SETUP_NOTE_DAYS } from './expired-setup.schema';
import {
  DAY_MS,
  dropSetups,
  PENDING_SETUP_DAYS,
} from './pending-setups.service';

/** The job id the sweep runs under, so a test can find it as its timer would. */
export const PENDING_SETUP_SWEEP_JOB_ID = 'pending-setup-sweep';

/** Daily, at 03:52 host time: no other housekeeping job runs then. */
export const PENDING_SETUP_SWEEP_CRON = '52 3 * * *';

/**
 * **The 30-day sweep** (ADR-0065 "When it is dropped"): a Pending setup no
 * Apply has used up within {@link PENDING_SETUP_DAYS} days of its
 * `created_at` is dropped, so the secrets it made do not sit around for ever,
 * and leaves an `expired_setup` note on its Environment, which the
 * Environment's Pending setups list shows (`expired-setup.schema.ts` says why
 * there). A Setup record the drop leaves recording nothing goes with it, as
 * on a cancel. Notes older than {@link EXPIRED_SETUP_NOTE_DAYS} days go too.
 *
 * Each setup is dropped in its own transaction with its note, so one that
 * fails never takes another's drop back, and a setup an Apply finished using
 * up in between is simply no longer there to drop.
 */
@Injectable()
export class PendingSetupSweep implements OnApplicationBootstrap {
  private readonly logger = new Logger(PendingSetupSweep.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly scheduling: SchedulingService,
  ) {}

  onApplicationBootstrap(): void {
    this.scheduling.register(
      PENDING_SETUP_SWEEP_JOB_ID,
      PENDING_SETUP_SWEEP_CRON,
      null,
      async () => {
        await this.sweep();
      },
    );
  }

  /**
   * Drops every Pending setup made {@link PENDING_SETUP_DAYS} days or more
   * before `now`, each with its note, then the notes that are themselves
   * that old. Answers the ids it dropped.
   */
  async sweep(now: Date = new Date()): Promise<string[]> {
    const cutoff = new Date(
      now.getTime() - PENDING_SETUP_DAYS * DAY_MS,
    ).toISOString();
    const due = await this.db
      .select({
        pendingSetupId: pendingSetup.pendingSetupId,
        environmentId: pendingSetup.environmentId,
        projectId: environment.projectId,
      })
      .from(pendingSetup)
      .innerJoin(
        environment,
        eq(pendingSetup.environmentId, environment.environmentId),
      )
      .where(lte(pendingSetup.createdAt, cutoff));

    const dropped: string[] = [];
    for (const one of due) {
      const gone = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(pendingSetup)
          .where(
            and(
              eq(pendingSetup.pendingSetupId, one.pendingSetupId),
              lte(pendingSetup.createdAt, cutoff),
            ),
          )
          .for('update');
        if (!row) return false;
        await tx.insert(expiredSetup).values({
          environmentId: row.environmentId,
          templateId: row.templateId,
          templateName: row.templateName,
          setupName: row.setupName,
          configNames: row.parts.map((part) => part.configName),
          setUpAt: row.createdAt,
          createdAt: now.toISOString(),
        });
        await dropSetups(tx, one, [row.pendingSetupId]);
        return true;
      });
      if (gone) dropped.push(one.pendingSetupId);
    }
    if (dropped.length > 0) {
      this.logger.log(
        `Dropped ${dropped.length} Pending setup(s) left unused for ${PENDING_SETUP_DAYS} days`,
      );
    }

    const noteCutoff = new Date(
      now.getTime() - EXPIRED_SETUP_NOTE_DAYS * DAY_MS,
    ).toISOString();
    await this.db
      .delete(expiredSetup)
      .where(lte(expiredSetup.createdAt, noteCutoff));
    return dropped;
  }
}
