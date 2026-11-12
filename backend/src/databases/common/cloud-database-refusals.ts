import { ConflictException } from '@nestjs/common';

/**
 * What a database in a Cloud account refuses of a Server database's
 * lifecycle (spec "Lifecycle"), in the sentences the console
 * shows beside its disabled buttons. Each is a 409 with a `code`, so the MCP
 * tools answer an Agent the same sentence.
 */

/** Start or Stop of a redis on ElastiCache, which has no stopped state. */
export const ELASTICACHE_CANNOT_STOP =
  "ElastiCache can't be stopped. Delete it to stop paying.";
export const ELASTICACHE_CANNOT_STOP_CODE = 'ELASTICACHE_CANNOT_STOP';

/**
 * Start or Stop of a redis on Memorystore for Valkey, which has no stopped
 * state either (spec "Stop and Start").
 */
export const MEMORYSTORE_CANNOT_STOP =
  "Memorystore can't be stopped. Delete it to stop paying.";
export const MEMORYSTORE_CANNOT_STOP_CODE = 'MEMORYSTORE_CANNOT_STOP';

/** Rebuild of a database in a Cloud account: its data goes only by a Delete. */
export const CLOUD_REBUILD_REFUSED =
  'Delete the Service and Apply again for a fresh one.';
export const CLOUD_REBUILD_REFUSED_CODE = 'CLOUD_REBUILD_REFUSED';

/** A bare status write to a postgres on RDS: AWS holds its status. */
export const RDS_STATUS_IS_AWS =
  'Its status is the RDS instance’s: use Start or Stop, which reach it in AWS.';
export const RDS_STATUS_IS_AWS_CODE = 'RDS_STATUS_IS_AWS';

export function cloudDatabaseRefusal(
  message: string,
  code: string,
): ConflictException {
  return new ConflictException({ message, code });
}

/**
 * An Existing database (ADR-0033) is looked up in its
 * Environment's Cloud account, so an Environment deploying elsewhere has
 * none to use: its create, its switch and its form's reach refuse with this.
 */
export const EXISTING_DATABASE_NEEDS_CLOUD =
  "An existing database is looked up in its Environment's Cloud account, and this Environment's Deploy target is not a Cloud account; choose one as its Deploy target first";
export const EXISTING_DATABASE_NEEDS_CLOUD_CODE =
  'EXISTING_DATABASE_NEEDS_CLOUD';

export function existingNeedsCloud(): ConflictException {
  return cloudDatabaseRefusal(
    EXISTING_DATABASE_NEEDS_CLOUD,
    EXISTING_DATABASE_NEEDS_CLOUD_CODE,
  );
}
