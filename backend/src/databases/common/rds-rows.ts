import { eq } from 'drizzle-orm';

import type { RdsEngineName } from '../../cloud-accounts/aws/definitions/rds-engines';
import type { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { InfrastructureState } from '../../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import type { DrizzleDB } from '../../db/drizzle.module';
import { mysql } from '../mysql/mysql.schema';
import type { Mysql } from '../mysql/mysql.schema';
import { existingDatabase } from '../postgres/existing-database.schema';
import { postgres } from '../postgres/postgres.schema';
import type { Postgres } from '../postgres/postgres.schema';

/**
 * A database row that can be an RDS instance, or a Cloud SQL
 * one: a postgres's or a mysql's. Both tables hold the same
 * RDS and Cloud SQL columns under the same names, so everything RDS and
 * Cloud SQL do — their Cloud runs, Stop and Start, Backups, Delete — reads
 * and writes them through here, by kind, rather than per table.
 */
export type RdsRow = Postgres | Mysql;

/** The RDS and Cloud SQL columns a run or an action writes back to its row. */
export type RdsRowSet = Partial<
  Pick<
    Postgres,
    | 'applicationStatus'
    | 'instanceClass'
    | 'storageGb'
    | 'maxStorageGb'
    | 'multiAz'
    | 'backupRetentionDays'
    | 'rdsApplied'
    | 'nativeAws'
    | 'nativeGcp'
    | 'rdsEndpoint'
    | 'cloudSqlEndpoint'
    | 'cloudSqlApplied'
    | 'restartsAt'
    | 'cloudDelete'
  >
>;

/**
 * A postgres or a mysql named by its own id column, as a row it owns names
 * it: its Infrastructure state, its `existing_database` row, a Cloud run's
 * Service. An {@link RdsRow} is one.
 */
export type RdsOwner = { postgresId: string } | { mysqlId: string };

/** The Service id of an RDS row or owner, whichever table it is in. */
export function rdsIdOf(row: RdsOwner): string {
  return 'postgresId' in row ? row.postgresId : row.mysqlId;
}

/** The kind of an RDS row or owner, whichever table it is in. */
export function rdsKindOf(row: RdsOwner): RdsEngineName {
  return 'postgresId' in row ? 'postgres' : 'mysql';
}

/** A postgres's or a mysql's id under its own column name. */
export function rdsOwnerOf(kind: RdsEngineName, id: string): RdsOwner {
  return kind === 'postgres' ? { postgresId: id } : { mysqlId: id };
}

/** The `existing_database` column naming a postgres or a mysql. */
export function rdsExistingColumn(kind: RdsEngineName) {
  return kind === 'postgres'
    ? existingDatabase.postgresId
    : existingDatabase.mysqlId;
}

/** The Infrastructure state a postgres or a mysql owns, if it has one. */
export function findRdsState(
  states: Pick<InfrastructureStatesService, 'findForPostgres' | 'findForMysql'>,
  kind: RdsEngineName,
  id: string,
): Promise<InfrastructureState | null> {
  return kind === 'postgres'
    ? states.findForPostgres(id)
    : states.findForMysql(id);
}

/** The row of a postgres or a mysql, or `null` when it is gone. */
export async function findRdsRow(
  db: Pick<DrizzleDB, 'select'>,
  kind: RdsEngineName,
  id: string,
): Promise<RdsRow | null> {
  if (kind === 'postgres') {
    const [row] = await db
      .select()
      .from(postgres)
      .where(eq(postgres.postgresId, id));
    return row ?? null;
  }
  const [row] = await db.select().from(mysql).where(eq(mysql.mysqlId, id));
  return row ?? null;
}

/** Writes RDS columns to a postgres's or a mysql's row; answers it, or `undefined` when gone. */
export async function updateRdsRow(
  db: Pick<DrizzleDB, 'update'>,
  kind: RdsEngineName,
  id: string,
  set: RdsRowSet,
): Promise<RdsRow | undefined> {
  if (kind === 'postgres') {
    const [row] = await db
      .update(postgres)
      .set(set)
      .where(eq(postgres.postgresId, id))
      .returning();
    return row;
  }
  const [row] = await db
    .update(mysql)
    .set(set)
    .where(eq(mysql.mysqlId, id))
    .returning();
  return row;
}

/** Drops a postgres's or a mysql's row. */
export async function deleteRdsRow(
  db: Pick<DrizzleDB, 'delete'>,
  kind: RdsEngineName,
  id: string,
): Promise<void> {
  if (kind === 'postgres') {
    await db.delete(postgres).where(eq(postgres.postgresId, id));
  } else {
    await db.delete(mysql).where(eq(mysql.mysqlId, id));
  }
}
