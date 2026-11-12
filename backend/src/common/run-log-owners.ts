import { inArray, or } from 'drizzle-orm';
import { backup } from '../backups/backup.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { schedule } from '../scheduling/schedules/schedule.schema';
import { volumeBackup } from '../volume-backups/volume-backup.schema';

/**
 * The run records a Service delete is about to cascade away, as the owners of
 * deployment-log directories.
 *
 * **What this is for.** An Application schedule, a database or compose backup
 * and a volume backup each write their run logs to `{logs}/{appName}` under
 * their *own* `appName` — `schedule-…`, `backup-…`, `volume-backup-…` — and
 * each row is `onDelete: 'cascade'` from the Service it belongs to. So deleting
 * the Service destroys the rows (and their run Deployments) while their log
 * directories stay, which is the U08 finding: the backup logs of databases that
 * had been deleted. Deleting the row itself reclaims its directory
 * (`SchedulesService.remove`, `BackupsService.remove`,
 * `VolumeBackupsService.remove`); this is the same removal for the rows a
 * cascade takes instead.
 *
 * **Which machine: the parent Service's `serverId`, for all three**, because
 * that is what each run hands `BackupRunRecorderService.start`: a schedule's
 * `resolveTarget` for an application or compose schedule, a backup's
 * `findParentService` (the engine's or the stack's `serverId`), and a volume
 * backup's `findParentService`. The caller supplies it, so this asks the
 * database for the run rows only.
 *
 * **Server schedules are not here**: a `scheduleType: 'server'` row hangs off a
 * Server, not a Service, and no Service delete cascades it.
 *
 * Read **before** the Service row is deleted, since afterwards there is nothing
 * left to read. One query per table, however many Services — a Project delete
 * passes all of its children at once.
 */
export interface RunLogOwner {
  /** The Service whose delete cascades this run row. */
  serviceId: string;
  appName: string;
  /** The parent Service's run Server, where the runs wrote their logs. */
  serverId: string | null;
}

export async function runLogOwnersOf(
  db: DrizzleDB,
  services: readonly { serviceId: string; serverId: string | null }[],
): Promise<RunLogOwner[]> {
  if (services.length === 0) return [];
  const serverOf = new Map(
    services.map(({ serviceId, serverId }) => [serviceId, serverId]),
  );
  const ids = [...serverOf.keys()];

  const schedules = await db
    .select({
      appName: schedule.appName,
      applicationId: schedule.applicationId,
      composeId: schedule.composeId,
    })
    .from(schedule)
    .where(
      or(
        inArray(schedule.applicationId, ids),
        inArray(schedule.composeId, ids),
      ),
    );
  const backups = await db
    .select({
      appName: backup.appName,
      composeId: backup.composeId,
      postgresId: backup.postgresId,
      mariadbId: backup.mariadbId,
      mysqlId: backup.mysqlId,
      mongoId: backup.mongoId,
      libsqlId: backup.libsqlId,
    })
    .from(backup)
    .where(
      or(
        inArray(backup.composeId, ids),
        inArray(backup.postgresId, ids),
        inArray(backup.mariadbId, ids),
        inArray(backup.mysqlId, ids),
        inArray(backup.mongoId, ids),
        inArray(backup.libsqlId, ids),
      ),
    );
  const volumeBackups = await db
    .select({
      appName: volumeBackup.appName,
      applicationId: volumeBackup.applicationId,
      composeId: volumeBackup.composeId,
      postgresId: volumeBackup.postgresId,
      mariadbId: volumeBackup.mariadbId,
      mysqlId: volumeBackup.mysqlId,
      mongoId: volumeBackup.mongoId,
      redisId: volumeBackup.redisId,
      libsqlId: volumeBackup.libsqlId,
      bucketId: volumeBackup.bucketId,
    })
    .from(volumeBackup)
    .where(
      or(
        inArray(volumeBackup.applicationId, ids),
        inArray(volumeBackup.composeId, ids),
        inArray(volumeBackup.postgresId, ids),
        inArray(volumeBackup.mariadbId, ids),
        inArray(volumeBackup.mysqlId, ids),
        inArray(volumeBackup.mongoId, ids),
        inArray(volumeBackup.redisId, ids),
        inArray(volumeBackup.libsqlId, ids),
        inArray(volumeBackup.bucketId, ids),
      ),
    );

  // Exactly one parent column is set on each row, so the first id that names
  // one of the Services being deleted is its parent.
  const owners: RunLogOwner[] = [];
  for (const { appName, ...parents } of [
    ...schedules,
    ...backups,
    ...volumeBackups,
  ]) {
    const serviceId = Object.values(parents).find(
      (id): id is string => id !== null && serverOf.has(id),
    );
    if (serviceId === undefined) continue;
    owners.push({
      serviceId,
      appName,
      serverId: serverOf.get(serviceId) ?? null,
    });
  }
  return owners;
}
