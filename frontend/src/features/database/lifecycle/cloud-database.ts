import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { memorystoreSettingsOf } from "@/lib/api/endpoints/memorystore-redis";

/**
 * A database in a Cloud account's lifecycle: a Server database's Deploy, Start,
 * Stop, Rebuild and Delete, minus what its cloud cannot do. The sentences
 * are the backend's refusals (`cloud-database-refusals.ts`) and warnings
 * (`rds-stop.ts`, `cloud-sql-stop.ts`), so the disabled button and the API
 * say the same thing.
 */

/** Start and Stop of a redis on ElastiCache, which has no stopped state. */
export const ELASTICACHE_CANNOT_STOP =
  "ElastiCache can't be stopped. Delete it to stop paying.";

/** Start and Stop of a redis on Memorystore, which has none either. */
export const MEMORYSTORE_CANNOT_STOP =
  "Memorystore can't be stopped. Delete it to stop paying.";

/** Rebuild of a database in a Cloud account: its data goes by a Delete only. */
export const CLOUD_REBUILD_REFUSED =
  "Delete the Service and Apply again for a fresh one.";

/**
 * Start, Stop and Rebuild of an Existing database: its
 * lifecycle is its own, in AWS (`existing-postgres.ts`).
 */
export const EXISTING_NOT_MANAGED =
  "Cloudgate uses this database but doesn't manage it.";

/**
 * What a Cloud SQL Stop warns, before and after it is pressed: Google never
 * starts it again by itself, so there is no date to name.
 */
export const CLOUD_SQL_STOP_WARNING =
  "Storage, backups and its private address still cost money. It stays stopped until you start it.";

/** How long AWS leaves an RDS instance stopped before starting it again. */
const RDS_STOP_DAYS = 7;

/** Where a database runs, as its lifecycle cares: a cloud's service, or a Server. */
export type CloudDatabase =
  | "rds"
  | "cloud-sql"
  | "elasticache"
  | "memorystore"
  | null;

export function cloudDatabaseOf(
  database: Database,
  kind: DatabaseKind,
): CloudDatabase {
  if (!database.cloudAccountId) return null;
  if (kind === "postgres" || kind === "mysql") {
    // The API answers `cloudSqlStop` beside a postgres or a mysql
    // on Cloud SQL only.
    return database.cloudSqlStop !== undefined ? "cloud-sql" : "rds";
  }
  if (kind === "redis") {
    // And `memorystore` beside a redis on Google Cloud.
    return memorystoreSettingsOf({ ...database, kind })
      ? "memorystore"
      : "elasticache";
  }
  return null;
}

/**
 * What Stop warns before it is pressed: the date AWS will start the
 * instance again if it is stopped `now`, in the backend's words.
 */
export function rdsStopWarning(now: Date): string {
  const restarts = new Date(now.getTime() + RDS_STOP_DAYS * 24 * 3600 * 1000);
  return `AWS starts it again on ${restarts.toISOString().slice(0, 10)}, and storage and backups still bill`;
}
