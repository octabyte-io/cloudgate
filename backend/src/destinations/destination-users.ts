import { eq } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  backup,
  backupServiceFk,
  environment,
  project,
  volumeBackup,
  volumeBackupServiceFk,
} from '../db/schema';
import { SERVICE_TABLES } from '../common/service-parent';
import { nameCategory } from '../servers/servers.service';

/** What a read needs — the root handle or the transaction `remove` holds. */
type Reader = Pick<DrizzleDB, 'select'>;

/**
 * Every `backup` and `volume_backup` row whose `destinationId` is this one,
 * each paired with the Service it backs up, one query per parent column.
 *
 * Joined to its Service → Environment → Project for two reasons: the Service's
 * name is *where the row lives*, which is what an operator needs to go and find
 * it ("names the schedules and where they live"); and the Project's
 * `organizationId` is what decides whether this caller may be told about it.
 * An inner join cannot lose a row: each table's check constraint
 * (`backupParentMatchesType`, `volumeBackupParentMatchesServiceType`) makes
 * exactly one parent column non-null, and each parent column is a cascading
 * FK, so every referencing row has exactly one parent to join to.
 */
async function destinationUsers(
  db: Reader,
  organizationId: string,
  destinationId: string,
): Promise<{ schedules: string[]; volumes: string[] }> {
  const read = <K extends keyof typeof SERVICE_TABLES>(
    kind: K,
    fk: AnyPgColumn,
    table: typeof backup | typeof volumeBackup,
    fields: Record<string, AnyPgColumn>,
    destinationColumn: AnyPgColumn,
  ) => {
    const service = SERVICE_TABLES[kind];
    return db
      .select({
        ...fields,
        serviceName: service.name,
        organizationId: project.organizationId,
      })
      .from(table)
      .innerJoin(service.table, eq(fk, service.id))
      .innerJoin(
        environment,
        eq(service.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(destinationColumn, destinationId))
      .then((rows) =>
        (rows as Record<string, string>[]).map((row) => ({ kind, row })),
      );
  };

  const [schedules, volumes] = await Promise.all([
    Promise.all(
      Object.entries(backupServiceFk).map(([kind, fk]) =>
        read(
          kind as keyof typeof backupServiceFk,
          fk,
          backup,
          {
            id: backup.backupId,
            database: backup.database,
            schedule: backup.schedule,
            createdAt: backup.createdAt,
          },
          backup.destinationId,
        ),
      ),
    ),
    Promise.all(
      Object.entries(volumeBackupServiceFk).map(([kind, fk]) =>
        read(
          kind as keyof typeof volumeBackupServiceFk,
          fk,
          volumeBackup,
          {
            id: volumeBackup.volumeBackupId,
            name: volumeBackup.name,
            createdAt: volumeBackup.createdAt,
          },
          volumeBackup.destinationId,
        ),
      ),
    ),
  ]);

  const byAge = (
    a: { row: Record<string, string> },
    b: { row: Record<string, string> },
  ) => a.row.createdAt.localeCompare(b.row.createdAt);

  return {
    // The console's own name for a schedule (`backup-schedule-spec.tsx`'s
    // `rowName`, "<database> on <cron>"), because it is the string an operator
    // will be looking for on the Service's Backups tab; the id beside it
    // because a schedule has no name of its own and two can read alike.
    schedules: schedules
      .flat()
      .sort(byAge)
      .map(({ kind, row }) =>
        row.organizationId === organizationId
          ? `schedule "${row.database} on ${row.schedule}" [${row.id}] on ${kind} "${row.serviceName}"`
          : 'a schedule in another Organization',
      ),
    volumes: volumes
      .flat()
      .sort(byAge)
      .map(({ kind, row }) =>
        row.organizationId === organizationId
          ? `volume backup "${row.name}" [${row.id}] on ${kind} "${row.serviceName}"`
          : 'a volume backup in another Organization',
      ),
  };
}

/**
 * The refusal `DestinationsService.remove` throws while anything still writes
 * to this destination, or `null` when nothing does.
 *
 * **Rows of another Organization are counted, never described.** No route
 * writes one — `BackupsService` and `VolumeBackupsService` both resolve
 * `destinationId` org-scoped before they store it — but the FK itself
 * only requires the destination to exist, so a row that predates that check
 * could. It still holds the delete, because the cascade would still take it;
 * what it may not do is tell this caller another Organization's Service names,
 * schedule ids or cadence. So it is one more in the count and a placeholder in
 * the list.
 */
export async function destinationInUseMessage(
  db: Reader,
  organizationId: string,
  current: { destinationId: string; name: string },
): Promise<string | null> {
  const { schedules, volumes } = await destinationUsers(
    db,
    organizationId,
    current.destinationId,
  );
  const clauses = [
    nameCategory(schedules, 'backup schedule', 'backup schedules'),
    nameCategory(volumes, 'volume backup', 'volume backups'),
  ].filter((clause): clause is string => clause !== null);
  if (clauses.length === 0) return null;

  return (
    `Destination "${current.name}" is still used by ${clauses.join(' and ')}. ` +
    // The consequence is the part the dialog used to get wrong: not only the
    // rows go — `deployment.backup_id` and `deployment.volume_backup_id` both
    // cascade, so their run history goes with them.
    'Removing the destination would delete each of them and every run ' +
    'recorded against them. Point them at another destination or delete ' +
    'them first'
  );
}
