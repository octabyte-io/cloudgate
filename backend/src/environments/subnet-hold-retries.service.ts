import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';

import { describeError } from '../common/describe-error';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment, environmentNetwork } from '../db/schema';
import type { EnvironmentNetwork } from '../db/schema';
import { environmentNetworkName } from '../deployments/service-scope';
import { SchedulingService } from '../scheduling/scheduling.service';
import { ENVIRONMENT_CLOUD_DELETES } from './environment-cloud-deletes.port';
import type { EnvironmentCloudDeletesPort } from './environment-cloud-deletes.port';
import { EnvironmentsService } from './environments.service';

/** The sweep's job: once a minute, from start-up (S13). */
export const SUBNET_HOLD_RETRY_JOB = 'google-subnet-hold-retry';
const EVERY_MINUTE = '* * * * *';

/**
 * **Cloudgate's own tries at Google's subnet hold** (the spec's "The
 * subnet hold" and "How the retries survive a restart"; S13).
 * Google keeps a subnet its services used 1–2 hours after they are
 * gone, so a Google network's removal usually first ends
 * `delete-incomplete`, its row holding when Cloudgate tries again and how
 * many of its own tries are left.
 *
 * Like the Domain certificate poller, the schedule lives on the rows and a
 * sweep armed at start-up reads it once a minute, so a restart loses
 * nothing: for each network whose time has passed it takes one try (the
 * row's time cleared, one try fewer, in one write, so two sweeps never
 * both take it) and queues a new run — a Retry of the Environment's Delete
 * when one is under way or incomplete, so a clean finish removes the
 * Environment too, or else the network's removal, as a plan's removal of
 * an unused network asked it. A run a restart cut off is never run again:
 * the next try is a new run. Once no try is left the network waits
 * for Retry or Forget.
 */
@Injectable()
export class SubnetHoldRetries implements OnApplicationBootstrap {
  private readonly logger = new Logger(SubnetHoldRetries.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly scheduling: SchedulingService,
    private readonly environments: EnvironmentsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The Delete's work lives in the Project config module, which imports this one's. */
  private get cloudDeletes(): EnvironmentCloudDeletesPort {
    return this.moduleRef.get<EnvironmentCloudDeletesPort>(
      ENVIRONMENT_CLOUD_DELETES,
      { strict: false },
    );
  }

  onApplicationBootstrap(): void {
    try {
      this.scheduling.register(SUBNET_HOLD_RETRY_JOB, EVERY_MINUTE, null, () =>
        this.sweep(),
      );
    } catch (error) {
      this.logger.error('The subnet-hold sweep could not be armed', error);
    }
  }

  /** One sweep: a new run for each held network whose next try is due at `now`. */
  async sweep(now: Date = new Date()): Promise<void> {
    const due = await this.db
      .select()
      .from(environmentNetwork)
      .where(
        and(
          eq(environmentNetwork.status, 'delete-incomplete'),
          isNotNull(environmentNetwork.holdNextTryAt),
          lte(environmentNetwork.holdNextTryAt, now.toISOString()),
        ),
      )
      .orderBy(asc(environmentNetwork.holdNextTryAt));
    for (const network of due) {
      try {
        await this.tryAgain(network);
      } catch (error) {
        this.logger.error(
          `Cloudgate's own try at removing the ${environmentNetworkName(network.region)} of Environment ${network.environmentId} did not start: ${describeError(error)}`,
        );
      }
    }
  }

  private async tryAgain(network: EnvironmentNetwork): Promise<void> {
    const [taken] = await this.db
      .update(environmentNetwork)
      .set({
        holdNextTryAt: null,
        holdTriesLeft: sql`greatest(coalesce(${environmentNetwork.holdTriesLeft}, 1) - 1, 0)`,
      })
      .where(
        and(
          eq(
            environmentNetwork.environmentNetworkId,
            network.environmentNetworkId,
          ),
          eq(environmentNetwork.holdNextTryAt, network.holdNextTryAt ?? ''),
        ),
      )
      .returning();
    if (!taken) return;
    const [owner] = await this.db
      .select({ cloudDelete: environment.cloudDelete })
      .from(environment)
      .where(eq(environment.environmentId, network.environmentId));
    if (owner?.cloudDelete?.requestedBy) {
      await this.environments.retryCloudDeleteByCloudgate(
        network.environmentId,
      );
      return;
    }
    await this.cloudDeletes.retryHeldNetwork(taken);
  }
}
