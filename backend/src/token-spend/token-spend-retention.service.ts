import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { lt } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { aiUsage } from '../gateway/ai-usage.schema';
import { SchedulingService } from '../scheduling/scheduling.service';
import {
  rawRetentionCutoff,
  rollUpRawDays,
  TOKEN_SPEND_CLOCK,
  utcDay,
} from './token-spend';
import type { TokenSpendClock } from './token-spend';

/**
 * When the job runs: just after midnight UTC, so yesterday is rolled up
 * early in today, on a minute no other nightly job takes.
 */
export const TOKEN_SPEND_ROLLUP_CRON = '15 0 * * *';

const ROLLUP_JOB_NAME = 'token-spend-rollup';

/**
 * The nightly **Token spend** job: roll every finished day's raw
 * `ai_usage` rows up into `ai_usage_daily`, then prune the raw rows past
 * `USAGE_RAW_RETENTION_DAYS`. `DeploymentLogRetentionService`'s shape: one
 * instance-wide cron through `SchedulingService`, housekeeping with no caller
 * and no `PermissionCtx`.
 *
 * **One transaction**, so a prune never removes a raw row whose day was not
 * rolled up first. Rollups are never pruned; they go only with their AI
 * model, by the cascade.
 */
@Injectable()
export class TokenSpendRetentionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TokenSpendRetentionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly scheduling: SchedulingService,
    @Inject(TOKEN_SPEND_CLOCK) private readonly clock: TokenSpendClock,
  ) {}

  /** Arms the job at boot; a boot that cannot arm housekeeping still starts. */
  onApplicationBootstrap(): void {
    try {
      this.scheduling.register(
        ROLLUP_JOB_NAME,
        TOKEN_SPEND_ROLLUP_CRON,
        'UTC',
        async () => {
          await this.run();
        },
      );
    } catch (error) {
      this.logger.error('Token spend rollup could not be armed', error);
    }
  }

  /**
   * One pass at `now`: every day before today rolled up, then every raw row
   * that started before the retention cutoff deleted. A throw reaches
   * `SchedulingService`, which journals it; the next night retries the lot.
   */
  async run(
    now: Date = this.clock(),
  ): Promise<{ rolledUp: number; pruned: number }> {
    const done = await this.db.transaction(async (tx) => {
      const rolledUp = await rollUpRawDays(tx, utcDay(now));
      const pruned = await tx
        .delete(aiUsage)
        .where(lt(aiUsage.startedAt, rawRetentionCutoff(now)))
        .returning({ aiUsageId: aiUsage.aiUsageId });
      return { rolledUp, pruned: pruned.length };
    });
    if (done.pruned > 0) {
      this.logger.log(
        `Pruned ${done.pruned} usage row(s) past retention after writing ${done.rolledUp} daily rollup(s)`,
      );
    }
    return done;
  }
}
