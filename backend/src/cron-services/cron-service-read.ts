import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { ApplicationConfigKind } from '../applications/application.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { deployment } from '../db/schema';
import { formatTimeout } from './cron-fields';
import type { CronTask } from './cron-run.types';
import { nextFireTimes } from '../scheduling/fire-times';

/**
 * A Build deployment that succeeded: of the Service itself — a
 * preview's build is not its image — and not a run, which is no build. What
 * a Cron service's "waiting for first build" (ADR-0034) is the absence of,
 * stated once for its read, its Run now and its timetable.
 */
export function isSuccessfulBuild(): SQL {
  return and(
    isNull(deployment.previewDeploymentId),
    isNull(deployment.cronRun),
    eq(deployment.status, 'done'),
  )!;
}

/** A Cron service's last successful build, and the image it pinned. */
export interface LastBuild {
  readonly deploymentId: string;
  /** `null` for a build from before builds pinned one. */
  readonly cronImage: string | null;
  /**
   * In an AWS Cloud account, the task definition revision its
   * deploy registered, which a run is a task of; `null` on a Server.
   */
  readonly cronTask: CronTask | null;
}

/**
 * The last Build deployment of an Application that succeeded, by when it
 * finished; `undefined` while none has.
 */
export async function lastSuccessfulBuild(
  db: Pick<DrizzleDB, 'select'>,
  applicationId: string,
): Promise<LastBuild | undefined> {
  const [found] = await db
    .select({
      deploymentId: deployment.deploymentId,
      cronImage: deployment.cronImage,
      cloudRun: deployment.cloudRun,
    })
    .from(deployment)
    .where(
      and(eq(deployment.applicationId, applicationId), isSuccessfulBuild()),
    )
    .orderBy(
      sql`${deployment.finishedAt} desc nulls last`,
      desc(deployment.createdAt),
    )
    .limit(1);
  if (!found) return undefined;
  return {
    deploymentId: found.deploymentId,
    cronImage: found.cronImage,
    cronTask: found.cloudRun?.cronTask ?? null,
  };
}

/** How many fire times a Cron service's read lists. */
export const NEXT_FIRE_TIMES = 5;

/**
 * A Cron service as its Service page reads it: its timetable, when
 * it fires next, and whether it is still waiting for its first build — a
 * Cron service fires nothing until one succeeds, since a run starts from
 * the image of the last build that did (ADR-0034).
 */
export interface CronServiceRead {
  readonly schedule: string;
  readonly timezone: string;
  /** As the config writes it: `1h`, `30m`. */
  readonly timeout: string;
  readonly timeoutSeconds: number;
  /** ISO instants, strictly after the read. */
  readonly nextFireTimes: readonly string[];
  readonly waitingForFirstBuild: boolean;
}

/** The columns of an Application row this reads. */
export interface CronServiceRow {
  readonly applicationId: string;
  readonly configKind: ApplicationConfigKind;
  readonly cronSchedule: string | null;
  readonly cronTimezone: string | null;
  readonly cronTimeoutSeconds: number | null;
}

/** A Cron service's read; `null` for any other Application. */
export async function readCronService(
  db: Pick<DrizzleDB, 'select'>,
  row: CronServiceRow,
  now: Date,
): Promise<CronServiceRead | null> {
  if (
    row.configKind !== 'cron' ||
    row.cronSchedule === null ||
    row.cronTimezone === null ||
    row.cronTimeoutSeconds === null
  ) {
    return null;
  }
  const built = await lastSuccessfulBuild(db, row.applicationId);
  return {
    schedule: row.cronSchedule,
    timezone: row.cronTimezone,
    timeout: formatTimeout(row.cronTimeoutSeconds),
    timeoutSeconds: row.cronTimeoutSeconds,
    nextFireTimes: nextFireTimes(
      row.cronSchedule,
      row.cronTimezone,
      now,
      NEXT_FIRE_TIMES,
    ).map((time) => time.toISOString()),
    waitingForFirstBuild: built === undefined,
  };
}
