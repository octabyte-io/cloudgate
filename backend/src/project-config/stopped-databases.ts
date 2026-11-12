import { and, eq, isNotNull } from 'drizzle-orm';

import { cloudAccount } from '../cloud-accounts/cloud-account.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { stoppedInItsCloud } from '../databases/common/cloud-database-stop';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { blockedByStop } from '../databases/postgres/rds-stop';
import type { PlanStep } from './planner/plan.types';

/**
 * **A plan never starts a database** (the AWS databases spec "Lifecycle"; the Google
 * Cloud buckets spec "Stop and Start"): a change to a postgres or a mysql
 * on RDS, or a postgres or a mysql on Cloud SQL, that Cloudgate stopped is blocked,
 * "pg-1 is stopped. Start it first.", while the rest of the plan applies.
 * The plan store marks the step when it stores the plan, and the Apply
 * checks again when it runs, both by its cloud's stop rule
 * (`cloud-database-stop.ts`), so an RDS instance AWS has started again by
 * itself blocks nothing.
 */

/** The ids of the Environment's cloud postgres and mysql that are stopped as of `now`. */
export async function stoppedInCloud(
  db: DrizzleDB,
  environmentId: string,
  now: Date,
): Promise<Set<string>> {
  const rows = await db
    .select({
      id: postgres.postgresId,
      cloudAccountId: postgres.cloudAccountId,
      applicationStatus: postgres.applicationStatus,
      restartsAt: postgres.restartsAt,
      cloud: cloudAccount.cloud,
    })
    .from(postgres)
    .leftJoin(
      cloudAccount,
      eq(cloudAccount.cloudAccountId, postgres.cloudAccountId),
    )
    .where(
      and(
        eq(postgres.environmentId, environmentId),
        isNotNull(postgres.cloudAccountId),
        eq(postgres.applicationStatus, 'stopped'),
      ),
    );
  const mysqls = await db
    .select({
      id: mysql.mysqlId,
      cloudAccountId: mysql.cloudAccountId,
      applicationStatus: mysql.applicationStatus,
      restartsAt: mysql.restartsAt,
      cloud: cloudAccount.cloud,
    })
    .from(mysql)
    .leftJoin(
      cloudAccount,
      eq(cloudAccount.cloudAccountId, mysql.cloudAccountId),
    )
    .where(
      and(
        eq(mysql.environmentId, environmentId),
        isNotNull(mysql.cloudAccountId),
        eq(mysql.applicationStatus, 'stopped'),
      ),
    );
  return new Set(
    [...rows, ...mysqls]
      .filter((row) => stoppedInItsCloud(row, row.cloud, now))
      .map((row) => row.id),
  );
}

/** Why a step will not run: a change to one of `stopped`, else `null`. */
export function blockedReason(
  step: PlanStep,
  stopped: ReadonlySet<string>,
): string | null {
  if (
    step.action !== 'change' ||
    (step.serviceType !== 'postgres' && step.serviceType !== 'mysql')
  ) {
    return null;
  }
  return stopped.has(step.serviceId) ? blockedByStop(step.configName) : null;
}

/** The steps, each change to one of `stopped` marked blocked. */
export function withStoppedBlocked(
  steps: readonly PlanStep[],
  stopped: ReadonlySet<string>,
): PlanStep[] {
  return steps.map((step) => {
    const blocked = blockedReason(step, stopped);
    return blocked && step.action === 'change' ? { ...step, blocked } : step;
  });
}
